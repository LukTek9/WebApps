/**
 * video-cropper.js — Outil « Recadreur Vidéo » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier vidéo (glisser-déposer / sélecteur) → aperçu <video controls> + cadre de recadrage
 *     interactif (déplacement / redimensionnement par poignées) + métadonnées (durée, résolution, taille).
 *  2. Options : ratio (Libre, 16:9, 9:16, 1:1, 4:5, 4:3), bouton « Centrer », champs numériques X / Y / L / H
 *     (pixels natifs, synchronisés avec le cadre), échelle de sortie (Recadrage d'origine, 1080p, 720p, 480p
 *     appliquée au petit côté, jamais d'agrandissement), conteneur de sortie (MP4 / WEBM).
 *  3. Export : FFmpeg.wasm chargé à la demande (cœur mono-thread, Worker en blob: URL, repli cœur ESM Firefox),
 *     filtres crop + scale toujours en dimensions PAIRES, progression temps réel, bouton Annuler (terminate Worker).
 *  4. Aperçu du résultat + téléchargement <nom>_recadre.<ext> ;
 *     objectURL / Worker libérés à chaque nouvel export, reset et unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576; // limite prudente : le fichier est copié dans la mémoire wasm
const MIN_SIZE = 16;             // taille minimale du cadre (px natifs)

/** Ratios prédéfinis : null = libre. */
const RATIOS = { free: null, '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3 };

/** Conteneurs de sortie (qualité « équilibrée » fixe). */
const FORMATS = {
  mp4: {
    ext: 'mp4', mime: 'video/mp4',
    vArgs: () => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    aCodecs: ['aac', 'libmp3lame'],
  },
  webm: {
    ext: 'webm', mime: 'video/webm',
    vArgs: () => ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-crf', '20', '-b:v', '3M'],
    aCodecs: ['libvorbis', 'libopus'],
  },
};
const AUDIO_BITRATE = '128k';
const LOAD_TIMEOUT_MS = 90000; // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie

/* FFmpeg.wasm : mêmes versions / schéma de chargement que video-converter. */
const FFMPEG_VERSION = '0.12.10';
const FFMPEG_CORE_VERSION = '0.12.6';
const FFMPEG_CDN = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;
const FFMPEG_CORE_CDN = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;
const FFMPEG_WORKER_FILE = '814.ffmpeg.js';

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (id) => s?.root.querySelector('#vidcrop-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const even = (v) => Math.floor(v / 2) * 2;
const evenRound = (v) => Math.round(v / 2) * 2;
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

/** Message lisible pour tout rejet : Error, string, ErrorEvent / Event de Worker (sans .message), objet. */
function errMsg(e) {
  if (e == null) return 'erreur inconnue';
  if (typeof e === 'string') return e || 'erreur inconnue';
  if (e.message) return String(e.message);
  if (e.filename) return `erreur Worker (${String(e.filename).split('/').pop()}:${e.lineno || 0})`;
  if (e.type) return `événement « ${e.type} » (Worker bloqué ou script non chargé)`;
  try { const j = JSON.stringify(e); if (j && j !== '{}') return j; } catch { /* circulaire */ }
  return String(e) || 'erreur inconnue';
}

/** Course promesse / annulation / délai ; au délai ou à l'abandon, le Worker est terminé par l'appelant. */
function raceLoad(promise, signal, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => done(reject, new Error(`délai dépassé (${Math.round(ms / 1000)} s) au chargement de FFmpeg`)), ms);
    const onAbort = () => done(reject, abortErr());
    const done = (fn, v) => { clearTimeout(t); signal.removeEventListener('abort', onAbort); fn(v); };
    if (signal.aborted) return done(reject, abortErr());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => done(resolve, v), (e) => done(reject, e instanceof Error ? e : new Error(errMsg(e))));
  });
}

function fmtDuration(t) {
  const sec = Math.max(0, Number(t) || 0);
  const m = Math.floor(sec / 60);
  return `${m}:${(sec % 60).toFixed(2).padStart(5, '0')}`;
}

function isVideoFile(f) {
  return f.type.startsWith('video/') || ACCEPT_EXT.includes(extOf(f.name));
}

/* ==========================================================================
   UI : statut / progression / occupation
   ========================================================================== */
/** kind : 'error' | 'ok' | undefined (neutre) — classes partagées .status-*. */
function setStatus(msg, kind) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', kind === 'error');
  el.classList.toggle('status-success', kind === 'ok');
  el.classList.toggle('status-muted', !kind);
}

/** p : 0..1 | null (indéterminé) | false (masquer). */
function setProgress(p) {
  const bar = q('bar'); if (!bar) return;
  bar.classList.toggle('is-on', p !== false);
  bar.classList.toggle('is-indeterminate', p === null);
  bar.firstElementChild.style.width = typeof p === 'number' ? Math.round(clamp(p, 0, 1) * 100) + '%' : '';
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.root.querySelectorAll('.vidcrop-panel select, .vidcrop-panel input, .vidcrop-panel button').forEach((el) => { el.disabled = busy; });
  q('box').classList.toggle('is-locked', busy);
  q('export').disabled = busy || !s.file;
  q('reset').disabled = busy;
  q('cancel').hidden = !busy;
}

/* ==========================================================================
   Résultat / objectURL
   ========================================================================== */
function releaseUrl() {
  if (!s || !s.objectUrl) return;
  URL.revokeObjectURL(s.objectUrl);
  s.objectUrl = null;
}

function releaseSrc() {
  if (!s || !s.srcUrl) return;
  URL.revokeObjectURL(s.srcUrl);
  s.srcUrl = null;
}

/** Vide un élément <video> et libère sa ressource média. */
function resetVideoEl(v) {
  if (!v) return;
  v.pause();
  v.removeAttribute('src');
  v.load();
}

function clearResult() {
  releaseUrl();
  const box = q('result'); if (!box) return;
  box.hidden = true;
  resetVideoEl(q('out'));
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download'); link.textContent = '';
}

function showResult(blob, name) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  q('out').src = s.objectUrl;
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  q('result').hidden = false;
  setProgress(1);
  setStatus(`Recadrage terminé : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Cadre de recadrage (coordonnées en pixels natifs de la vidéo)
   ========================================================================== */
/** Force des dimensions / décalages PAIRES, dans les limites de l'image ; `snap` : recale H sur le ratio. */
function normalize(r, snap) {
  const { width: W, height: H } = s.meta;
  const ratio = RATIOS[s.ratioKey];
  let w = clamp(even(r.w), 2, even(W));
  let h = clamp(even(r.h), 2, even(H));
  if (snap && ratio) {
    h = Math.max(2, even(w / ratio));
    if (h > even(H)) { h = even(H); w = Math.max(2, even(h * ratio)); }
  }
  const x = clamp(even(r.x), 0, W - w);
  const y = clamp(even(r.y), 0, H - h);
  return { x, y, w, h };
}

/** Dimensions de sortie : échelle = petit côté plafonné (réduction uniquement). */
function outDims(c, target) {
  if (target && Math.min(c.w, c.h) > target) {
    if (c.w <= c.h) return { w: target, h: Math.max(2, evenRound((c.h * target) / c.w)) };
    return { w: Math.max(2, evenRound((c.w * target) / c.h)), h: target };
  }
  return { w: c.w, h: c.h };
}

function updateOut() {
  if (!s?.crop) return;
  const o = outDims(s.crop, Number(q('scale').value) || 0);
  q('st-out').textContent = `${o.w} × ${o.h}`;
}

/** Applique le cadre : positionne la boîte (en %), synchronise les champs numériques, invalide le résultat. */
function setCrop(r, snap) {
  const { width: W, height: H } = s.meta;
  const c = normalize(r, snap);
  s.crop = c;
  const box = q('box');
  box.style.left = (c.x / W) * 100 + '%';
  box.style.top = (c.y / H) * 100 + '%';
  box.style.width = (c.w / W) * 100 + '%';
  box.style.height = (c.h / H) * 100 + '%';
  for (const k of ['x', 'y', 'w', 'h']) q('n-' + k).value = c[k];
  updateOut();
  if (s.objectUrl) clearResult();
}

/** Redimensionne selon la poignée `hd` (n, s, e, w, ne, nw, se, sw) ; ratio verrouillé si défini. */
function resizeRect(r, hd, dx, dy) {
  const { width: W, height: H } = s.meta;
  const ratio = RATIOS[s.ratioKey];
  let l = r.x, t = r.y, rt = r.x + r.w, b = r.y + r.h;
  const hasW = hd.includes('w'), hasE = hd.includes('e'), hasN = hd.includes('n'), hasS = hd.includes('s');
  if (hasW) l = clamp(l + dx, 0, rt - MIN_SIZE);
  if (hasE) rt = clamp(rt + dx, l + MIN_SIZE, W);
  if (hasN) t = clamp(t + dy, 0, b - MIN_SIZE);
  if (hasS) b = clamp(b + dy, t + MIN_SIZE, H);
  if (!ratio) return { x: l, y: t, w: rt - l, h: b - t };

  // Ratio verrouillé : dimension pilote = largeur (coins / côtés horizontaux), sinon hauteur
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let w = rt - l, h = b - t;
  if (hasW || hasE) h = w / ratio; else w = h * ratio;
  // Espace disponible selon l'ancre (côté opposé ou centre)
  const availW = hasW ? r.x + r.w : hasE ? W - r.x : 2 * Math.min(cx, W - cx);
  const availH = hasN ? r.y + r.h : hasS ? H - r.y : 2 * Math.min(cy, H - cy);
  const maxW = Math.min(availW, availH * ratio);
  const minW = Math.max(MIN_SIZE, MIN_SIZE * ratio);
  w = clamp(w, Math.min(minW, maxW), maxW);
  h = w / ratio;
  const x = hasW ? r.x + r.w - w : hasE ? r.x : cx - w / 2;
  const y = hasN ? r.y + r.h - h : hasS ? r.y : cy - h / 2;
  return { x, y, w, h };
}

/** Initialise le cadre par défaut : 80 % centré. */
function initCrop() {
  const { width: W, height: H } = s.meta;
  s.ratioKey = 'free';
  syncRatioButtons();
  const w = even(W * 0.8), h = even(H * 0.8);
  setCrop({ x: (W - w) / 2, y: (H - h) / 2, w, h });
}

function syncRatioButtons() {
  s.root.querySelectorAll('.vidcrop-ratio').forEach((b) => {
    const on = b.dataset.r === s.ratioKey;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/** Choix d'un ratio : le cadre se réduit dans sa zone actuelle, autour de son centre. */
function setRatio(key) {
  if (!s?.meta || s.busy) return;
  s.ratioKey = key;
  syncRatioButtons();
  const ratio = RATIOS[key];
  const c = s.crop;
  if (!ratio) return;
  const w = Math.min(c.w, c.h * ratio);
  const h = w / ratio;
  setCrop({ x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h }, true);
}

/** Centre : ratio défini → plus grand cadre centré à ce ratio ; libre → recentre le cadre actuel. */
function centerCrop() {
  if (!s?.meta || s.busy) return;
  const { width: W, height: H } = s.meta;
  const ratio = RATIOS[s.ratioKey];
  let { w, h } = s.crop;
  if (ratio) {
    w = Math.min(W, H * ratio);
    h = w / ratio;
  }
  setCrop({ x: (W - w) / 2, y: (H - h) / 2, w, h }, !!ratio);
}

/** Saisie numérique : `id` = x | y | w | h ; ratio verrouillé → l'autre dimension suit. */
function applyInput(id) {
  if (!s?.meta || s.busy) return;
  const { width: W, height: H } = s.meta;
  const ratio = RATIOS[s.ratioKey];
  const v = Math.round(Number(q('n-' + id).value));
  let { x, y, w, h } = s.crop;
  if (!Number.isFinite(v)) { setCrop(s.crop); return; }
  if (id === 'x') x = clamp(v, 0, W - w);
  else if (id === 'y') y = clamp(v, 0, H - h);
  else if (id === 'w') {
    w = clamp(v, 2, W);
    if (ratio) { h = w / ratio; if (h > H) { h = H; w = h * ratio; } }
  } else {
    h = clamp(v, 2, H);
    if (ratio) { w = h * ratio; if (w > W) { w = W; h = w / ratio; } }
  }
  setCrop({ x, y, w, h }, !!ratio && (id === 'w' || id === 'h'));
}

/* ---------- Interaction souris / tactile sur le cadre ---------- */
function onPointerDown(e) {
  if (!s?.meta || s.busy || e.button > 0) return;
  const hd = e.target.dataset?.h || 'move';
  const rect = q('stage').getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  s.drag = {
    hd, id: e.pointerId, sx: e.clientX, sy: e.clientY, start: { ...s.crop },
    kx: s.meta.width / rect.width, ky: s.meta.height / rect.height,
  };
  try { q('box').setPointerCapture(e.pointerId); } catch { /* ignoré */ }
  e.preventDefault();
}

function onPointerMove(e) {
  const d = s?.drag;
  if (!d || e.pointerId !== d.id) return;
  const dx = (e.clientX - d.sx) * d.kx, dy = (e.clientY - d.sy) * d.ky;
  if (d.hd === 'move') {
    const { width: W, height: H } = s.meta;
    setCrop({ x: clamp(d.start.x + dx, 0, W - d.start.w), y: clamp(d.start.y + dy, 0, H - d.start.h), w: d.start.w, h: d.start.h });
  } else {
    setCrop(resizeRect(d.start, d.hd, dx, dy), !!RATIOS[s.ratioKey]);
  }
}

function onPointerEnd(e) {
  if (!s?.drag || e.pointerId !== s.drag.id) return;
  try { q('box').releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
  s.drag = null;
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
/** Libère tout l'état (export, résultat, aperçu source) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  s.drag = null;
  clearResult();
  resetVideoEl(q('src'));
  releaseSrc();
  s.file = null; s.meta = null; s.crop = null;
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  setBusy(false);
  setProgress(false);
}

function showMeta(file, meta) {
  q('name').textContent = file.name;
  q('meta').textContent = extOf(file.name).toUpperCase() || (file.type || 'vidéo');
  q('st-dur').textContent = fmtDuration(meta.duration);
  q('st-res').textContent = `${meta.width} × ${meta.height}`;
  q('st-size').textContent = fmtMB(file.size);
}

/** Lit durée / résolution via <video> (null si le navigateur ne sait pas décoder le conteneur). */
function readMeta(url) {
  return new Promise((resolve) => {
    const v = q('src');
    const done = (m) => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', ko); resolve(m); };
    const ok = () => done(v.videoWidth > 0 ? { duration: v.duration, width: v.videoWidth, height: v.videoHeight } : null);
    const ko = () => done(null);
    v.addEventListener('loadedmetadata', ok);
    v.addEventListener('error', ko);
    v.src = url;
  });
}

async function loadFile(file) {
  if (!s || !file || s.busy) return;
  if (!isVideoFile(file)) {
    setStatus('Format non pris en charge : utilisez MP4, WEBM, MOV, AVI ou MKV.', 'error');
    return;
  }
  if (file.size > MAX_BYTES) {
    setStatus(`Fichier trop volumineux (${fmtMB(file.size)}) : limite ${fmtMB(MAX_BYTES)} pour un traitement 100 % navigateur.`, 'error');
    return;
  }
  discard();
  const token = ++s.loading;
  setStatus(`Lecture de « ${file.name} »…`); setProgress(null);

  s.srcUrl = URL.createObjectURL(file);
  const meta = await readMeta(s.srcUrl);
  if (!s || s.loading !== token) return; // reset / nouveau fichier / unmount entre-temps

  if (!meta) {
    // Sans dimensions natives, le cadre ne peut pas être positionné
    resetVideoEl(q('src'));
    releaseSrc();
    setProgress(false);
    setStatus('Lecture native impossible (codec / conteneur non pris en charge) : dimensions illisibles, recadrage indisponible.', 'error');
    return;
  }

  s.file = file; s.meta = meta;
  q('drop').hidden = true;
  q('editor').hidden = false;
  showMeta(file, meta);
  initCrop();
  q('export').disabled = false;
  setProgress(false);
  setStatus('Fichier chargé. Ajustez le cadre puis exportez.');
}

/* ==========================================================================
   Export FFmpeg.wasm (lazy)
   ========================================================================== */
function wasmSupported() {
  try {
    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') return false;
    return new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)) instanceof WebAssembly.Module;
  } catch { return false; }
}

let ffmpegLibPromise = null;
/** Injecte le script UMD de FFmpeg une seule fois. */
function loadFfmpegLib() {
  if (window.FFmpegWASM?.FFmpeg) return Promise.resolve(window.FFmpegWASM.FFmpeg);
  ffmpegLibPromise ??= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = `${FFMPEG_CDN}/ffmpeg.js`;
    sc.async = true;
    sc.onload = () => (window.FFmpegWASM?.FFmpeg ? resolve(window.FFmpegWASM.FFmpeg) : reject(new Error('FFmpeg UMD introuvable')));
    sc.onerror = () => { ffmpegLibPromise = null; sc.remove(); reject(new Error('chargement CDN impossible')); };
    document.head.appendChild(sc);
  });
  return ffmpegLibPromise;
}

/** Ressource CDN → blob: URL (ajoutée à `bag` pour révocation). */
async function cdnBlobUrl(url, mime, signal, bag, onProgress) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url.split('/').pop()})`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress && total) onProgress(Math.min(1, got / total));
  }
  const u = URL.createObjectURL(new Blob(chunks, { type: mime }));
  bag.push(u);
  return u;
}

/**
 * Variante ESM du cœur FFmpeg (Firefox) : le Worker module ne peut pas faire importScripts() ;
 * il importe donc le cœur UMD via import() et attend un `export default`.
 */
async function cdnEsmCoreUrl(signal, bag) {
  const res = await fetch(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} (ffmpeg-core.js)`);
  const src = await res.text();
  const u = URL.createObjectURL(new Blob([src, '\nexport default createFFmpegCore;\n'], { type: 'text/javascript' }));
  bag.push(u);
  return u;
}

/** Chaîne de filtres : crop (valeurs paires) → scale optionnel (petit côté plafonné, -2 = pair) → SAR 1. */
function buildFilter(c, target) {
  const f = [`crop=${c.w}:${c.h}:${c.x}:${c.y}`];
  if (target && Math.min(c.w, c.h) > target) f.push(c.w <= c.h ? `scale=${target}:-2` : `scale=-2:${target}`);
  f.push('setsar=1');
  return f.join(',');
}

/** Arguments FFmpeg ; piste audio optionnelle (`0:a:0?`). */
function ffmpegArgs(inName, outName, fmt, vf, aCodec) {
  const a = ['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0', '-vf', vf, ...fmt.vArgs()];
  if (!aCodec) a.push('-an');
  else a.push('-c:a', aCodec, '-b:a', AUDIO_BITRATE, '-ac', '2');
  a.push(outName);
  return a;
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–1 export. */
async function exportFfmpeg(fmt, crop, target, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const file = s.file;
  const inName = 'in.' + (extOf(file.name).replace(/[^a-z0-9]/g, '') || 'bin');
  const outName = 'out.' + fmt.ext;
  const vf = buildFilter(crop, target);
  let ffmpeg = null, onAbort = null;
  const logs = []; // tampon roulant des logs FFmpeg
  const pushLog = (m) => { logs.push(String(m)); if (logs.length > 25) logs.shift(); };
  const tail = () => (logs.length ? ' — ' + logs.slice(-6).join(' | ') : '');
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(0.02 + p * 0.18); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

    onAbort = () => { try { ffmpeg?.terminate(); } catch { /* déjà fermé */ } };
    signal.addEventListener('abort', onAbort, { once: true });

    // Tentative 1 : cœur UMD ; tentative 2 : cœur enveloppé en ESM (Worker module Firefox)
    let loaded = false, loadErr = null;
    for (const esm of [false, true]) {
      if (ffmpeg) { try { ffmpeg.terminate(); } catch { /* déjà fermé */ } ffmpeg = null; }
      try {
        const core = esm ? await cdnEsmCoreUrl(signal, blobUrls) : coreURL;
        ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => pushLog(message));
        await raceLoad(ffmpeg.load({ coreURL: core, wasmURL, classWorkerURL: workerURL }), signal, LOAD_TIMEOUT_MS);
        loaded = true;
        break;
      } catch (e) {
        if (signal.aborted) throw abortErr();
        loadErr = e;
      }
    }
    if (!loaded) throw new Error(`initialisation de FFmpeg impossible : ${errMsg(loadErr)}${tail()}`);

    await ffmpeg.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    if (signal.aborted) throw abortErr();
    ffmpeg.on('progress', ({ progress }) => {
      const p = clamp(Number(progress) || 0, 0, 1);
      setProgress(0.2 + 0.8 * p);
      setStatus(`Recadrage ${fmt.ext.toUpperCase()} (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus(`Recadrage ${fmt.ext.toUpperCase()} (FFmpeg)…`); setProgress(0.2);
    // Codecs audio testés dans l'ordre (repli automatique)
    let code = -1;
    for (const ac of fmt.aCodecs) {
      logs.length = 0;
      code = await ffmpeg.exec(ffmpegArgs(inName, outName, fmt, vf, ac));
      if (signal.aborted) throw abortErr();
      if (code === 0) break;
    }
    if (code !== 0) throw new Error(`FFmpeg code ${code}${tail()}`);
    return new Blob([await ffmpeg.readFile(outName)], { type: fmt.mime });
  } catch (e) {
    if (signal.aborted) throw abortErr();
    throw e instanceof Error ? e : new Error(errMsg(e));
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (ffmpeg) {
      if (!signal.aborted) for (const f of [inName, outName]) { try { await ffmpeg.deleteFile(f); } catch { /* absent */ } }
      try { ffmpeg.terminate(); } catch { /* déjà fermé */ } // ferme Worker + libère la mémoire wasm
    }
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function runExport() {
  if (!s?.file || !s.crop || s.busy) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value] || FORMATS.mp4;
  const target = Number(q('scale').value) || 0; // 0 = recadrage d'origine
  const crop = { ...st.crop };                  // instantané : le cadre est verrouillé pendant l'export
  setBusy(true); setProgress(0);

  try {
    const blob = await exportFfmpeg(fmt, crop, target, signal);
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_recadre';
    showResult(blob, `${base}.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Export annulé.');
    else setStatus(`Recadrage ${fmt.ext.toUpperCase()} impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vidcrop" id="vidcrop-root">
  <div class="vidcrop-drop" id="vidcrop-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier vidéo">
    <i data-lucide="crop" class="icon-xl"></i>
    <strong>Glissez une vidéo ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="vidcrop-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" hidden>
  </div>

  <div class="vidcrop-editor" id="vidcrop-editor" hidden>
    <div class="vidcrop-head">
      <div class="vidcrop-file"><b class="vidcrop-name" id="vidcrop-name"></b><small class="vidcrop-meta" id="vidcrop-meta"></small></div>
      <button class="btn-remove-file" id="vidcrop-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <div class="vidcrop-stage" id="vidcrop-stage">
      <video class="vidcrop-video" id="vidcrop-src" controls preload="metadata" playsinline></video>
      <div class="vidcrop-box" id="vidcrop-box" aria-label="Zone de recadrage">
        <i class="vidcrop-h" data-h="n"></i><i class="vidcrop-h" data-h="s"></i>
        <i class="vidcrop-h" data-h="e"></i><i class="vidcrop-h" data-h="w"></i>
        <i class="vidcrop-h" data-h="nw"></i><i class="vidcrop-h" data-h="ne"></i>
        <i class="vidcrop-h" data-h="sw"></i><i class="vidcrop-h" data-h="se"></i>
      </div>
    </div>

    <div class="vidcrop-info">
      <div class="vidcrop-stat"><small>Durée</small><b id="vidcrop-st-dur">—</b></div>
      <div class="vidcrop-stat"><small>Résolution native</small><b id="vidcrop-st-res">—</b></div>
      <div class="vidcrop-stat"><small>Taille</small><b id="vidcrop-st-size">—</b></div>
      <div class="vidcrop-stat"><small>Sortie estimée</small><b id="vidcrop-st-out">—</b></div>
    </div>

    <div class="vidcrop-panel">
      <div class="vidcrop-ratios" role="group" aria-label="Ratio du cadre">
        <button type="button" class="vidcrop-ratio is-active" data-r="free" aria-pressed="true">Libre</button>
        <button type="button" class="vidcrop-ratio" data-r="16:9" aria-pressed="false">16:9</button>
        <button type="button" class="vidcrop-ratio" data-r="9:16" aria-pressed="false">9:16</button>
        <button type="button" class="vidcrop-ratio" data-r="1:1" aria-pressed="false">1:1</button>
        <button type="button" class="vidcrop-ratio" data-r="4:5" aria-pressed="false">4:5</button>
        <button type="button" class="vidcrop-ratio" data-r="4:3" aria-pressed="false">4:3</button>
        <button type="button" class="btn-secondary vidcrop-center" id="vidcrop-center"><i data-lucide="focus"></i> Centrer</button>
      </div>

      <div class="vidcrop-coords">
        <label class="vidcrop-field">X (px)<input type="number" id="vidcrop-n-x" min="0" step="2" inputmode="numeric"></label>
        <label class="vidcrop-field">Y (px)<input type="number" id="vidcrop-n-y" min="0" step="2" inputmode="numeric"></label>
        <label class="vidcrop-field">Largeur (px)<input type="number" id="vidcrop-n-w" min="2" step="2" inputmode="numeric"></label>
        <label class="vidcrop-field">Hauteur (px)<input type="number" id="vidcrop-n-h" min="2" step="2" inputmode="numeric"></label>
      </div>

      <label class="vidcrop-field">Échelle de sortie (petit côté)
        <select id="vidcrop-scale">
          <option value="0" selected>Recadrage d'origine</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
          <option value="480">480p</option>
        </select>
      </label>
      <label class="vidcrop-field">Conteneur de sortie
        <select id="vidcrop-format">
          <option value="mp4" selected>MP4 (H.264 + AAC)</option>
          <option value="webm">WEBM (VP8 + Vorbis)</option>
        </select>
      </label>
    </div>
  </div>

  <div>
    <div class="vidcrop-bar" id="vidcrop-bar"><i></i></div>
    <p class="vidcrop-status status-muted" id="vidcrop-status">Déposez une vidéo pour commencer.</p>
  </div>

  <div class="vidcrop-actions">
    <button class="btn-primary" id="vidcrop-export" type="button"><i data-lucide="crop"></i> Recadrer</button>
    <button class="btn-secondary" id="vidcrop-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vidcrop-result" id="vidcrop-result" hidden>
    <video class="vidcrop-out" id="vidcrop-out" controls preload="metadata" playsinline></video>
    <a class="btn-primary vidcrop-link" id="vidcrop-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, file: null, meta: null, crop: null, ratioKey: 'free', drag: null,
    srcUrl: null, objectUrl: null, abort: null, busy: false, loading: 0,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root');
  const drop = q('drop'), file = q('file'), box = q('box');

  // Zone de dépôt + sélecteur
  drop.addEventListener('click', () => file.click(), opt);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } }, opt);
  file.addEventListener('change', () => { const f = file.files?.[0]; if (f) loadFile(f); }, opt);
  // Dépôt n'importe où dans l'outil (évite la navigation du navigateur vers le fichier)
  root.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); }, opt);
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) drop.classList.remove('is-over'); }, opt);
  root.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f);
  }, opt);

  // Cadre : déplacement / redimensionnement (pointer events = souris + tactile)
  box.addEventListener('pointerdown', onPointerDown, opt);
  box.addEventListener('pointermove', onPointerMove, opt);
  box.addEventListener('pointerup', onPointerEnd, opt);
  box.addEventListener('pointercancel', onPointerEnd, opt);

  // Ratios / centrage / champs numériques
  root.querySelectorAll('.vidcrop-ratio').forEach((b) => b.addEventListener('click', () => setRatio(b.dataset.r), opt));
  q('center').addEventListener('click', centerCrop, opt);
  ['x', 'y', 'w', 'h'].forEach((k) => q('n-' + k).addEventListener('change', () => applyInput(k), opt));

  // Échelle / conteneur : tout changement invalide le résultat précédent
  q('scale').addEventListener('change', () => { updateOut(); clearResult(); }, opt);
  q('format').addEventListener('change', clearResult, opt);

  // Export / annulation / reset
  q('export').addEventListener('click', runExport, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez une vidéo pour commencer.');
  }, opt);

  q('export').disabled = true;
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide une lecture de métadonnées en cours
  s.abort?.abort();            // stoppe export / chargement FFmpeg (terminate Worker)
  s.drag = null;
  clearResult();               // pause <video> résultat + URL.revokeObjectURL
  resetVideoEl(q('src'));      // pause <video> source
  releaseSrc();                // URL.revokeObjectURL de l'aperçu source
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
