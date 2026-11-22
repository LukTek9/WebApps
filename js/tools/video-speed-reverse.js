/**
 * video-speed-reverse.js — Outil « Vitesse & Inversion Vidéo » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier vidéo (glisser-déposer / sélecteur) → aperçu <video controls> (playbackRate synchronisé
 *     avec la vitesse choisie tant que l'inversion est désactivée), durées originale / estimée, résolution, taille.
 *  2. Options : vitesse (pastilles 0.25×–4× + curseur fin), inversion, couper le son, format MP4 / WEBM.
 *  3. Traitement : FFmpeg.wasm chargé à la demande (Worker en blob: URL, repli cœur ESM Firefox).
 *     Vidéo : [reverse,] setpts=(1/vitesse)*PTS ; audio : [areverse,] atempo chaînés dans [0.5 ; 2.0].
 *  4. Progression temps réel, Annuler (terminate du Worker), aperçu résultat, téléchargement
 *     <nom>_vitesse.<ext> ou <nom>_inverse.<ext> ; Worker / objectURL libérés à chaque nouveau traitement, reset et unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576; // limite prudente : le fichier est copié dans la mémoire wasm
const LOAD_TIMEOUT_MS = 90000;   // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
const SPEED_MIN = 0.25, SPEED_MAX = 4;
const REVERSE_WARN_MB = 600;     // estimation mémoire des images décodées au-delà de laquelle l'avertissement devient critique
const EST_FPS = 30;              // hypothèse pour l'estimation mémoire de l'inversion

const FORMATS = {
  mp4: {
    ext: 'mp4', mime: 'video/mp4',
    vArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    aCodecs: ['aac', 'libmp3lame'],
  },
  webm: {
    ext: 'webm', mime: 'video/webm',
    vArgs: ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-crf', '20', '-b:v', '3M'],
    aCodecs: ['libvorbis', 'libopus'],
  },
};

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
const q = (id) => s?.root.querySelector('#vidspd-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const fmtSpeed = (v) => `${Number(v.toFixed(2))}×`;

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

/** Chaîne atempo : chaque facteur dans [0.5 ; 2.0] (limite du filtre), produit = vitesse. */
function atempoChain(speed) {
  const out = [];
  let v = speed;
  while (v > 2) { out.push(2); v /= 2; }
  while (v < 0.5) { out.push(0.5); v /= 0.5; }
  if (Math.abs(v - 1) > 1e-4 || !out.length) out.push(v);
  return out.map((f) => `atempo=${f.toFixed(4)}`);
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

function canRun() {
  return !!s?.file && !s.busy && (s.reverse || Math.abs(s.speed - 1) > 1e-4);
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.root.querySelectorAll('.vidspd-panel select, .vidspd-panel input, .vidspd-chip').forEach((el) => { el.disabled = busy; });
  q('reset').disabled = busy;
  q('cancel').hidden = !busy;
  q('convert').disabled = !canRun();
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
  setStatus(`Traitement terminé : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Options : vitesse / inversion / aperçu
   ========================================================================== */
/** Estimation mémoire (Mo) des images décodées retenues par le filtre `reverse`. */
function reverseMemMB() {
  const m = s.meta;
  if (!m || !(m.duration > 0)) return 0;
  return (m.width * m.height * 1.5 * EST_FPS * m.duration) / 1048576;
}

function refreshNotice() {
  const box = q('notice'); if (!box) return;
  box.hidden = !s.reverse;
  if (!s.reverse) return;
  const mem = reverseMemMB();
  const danger = mem > REVERSE_WARN_MB;
  box.classList.toggle('is-danger', danger);
  q('notice-text').textContent =
    'L’inversion décode toutes les images en mémoire avant de les réécrire : à réserver aux vidéos courtes (idéalement < 15 s en 720p). ' +
    (mem > 0 ? `Mémoire estimée ≈ ${Math.round(mem)} Mo${danger ? ' — risque élevé d’échec : découpez d’abord un extrait.' : '.'}` : '');
}

/** Synchronise la vitesse de lecture de l'aperçu (inversion : lecture normale, le sens ne peut pas être inversé nativement). */
function applyPreviewRate() {
  const v = q('src'); if (!v) return;
  const r = s.reverse ? 1 : s.speed;
  try { v.defaultPlaybackRate = r; v.playbackRate = r; } catch { /* ignoré */ }
}

function refreshInfo() {
  const m = s.meta;
  q('st-out').textContent = m && m.duration > 0 ? fmtDuration(m.duration / s.speed) : '—';
  q('convert').disabled = !canRun();
}

function setSpeed(v, fromSlider) {
  s.speed = clamp(Math.round(v * 100) / 100, SPEED_MIN, SPEED_MAX);
  if (!fromSlider) q('speed').value = String(s.speed);
  q('speed-val').textContent = fmtSpeed(s.speed);
  s.root.querySelectorAll('.vidspd-chip').forEach((b) => {
    const on = Math.abs(Number(b.dataset.speed) - s.speed) < 0.001;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  clearResult();
  applyPreviewRate();
  refreshInfo();
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
/** Libère tout l'état (traitement, résultat, aperçu source) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  clearResult();
  resetVideoEl(q('src'));
  releaseSrc();
  s.file = null; s.meta = null;
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  setBusy(false);
  setProgress(false);
}

function showMeta(file, meta) {
  q('name').textContent = file.name;
  q('meta').textContent = extOf(file.name).toUpperCase() || (file.type || 'vidéo');
  q('st-dur').textContent = meta ? fmtDuration(meta.duration) : '—';
  q('st-res').textContent = meta ? `${meta.width} × ${meta.height}` : '—';
  q('st-size').textContent = fmtMB(file.size);
}

/** Lit durée / résolution via <video> (null si le navigateur ne sait pas décoder le conteneur). */
function readMeta(url) {
  return new Promise((resolve) => {
    const v = q('src');
    const done = (m) => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', ko); resolve(m); };
    const ok = () => done(v.videoWidth > 0
      ? { duration: Number.isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight } : null);
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

  s.file = file; s.meta = meta;
  q('drop').hidden = true;
  q('editor').hidden = false;
  q('src').hidden = !meta; // pas d'aperçu si lecture native impossible
  showMeta(file, meta);
  applyPreviewRate();
  refreshInfo(); refreshNotice();
  setProgress(false);
  if (meta) setStatus('Fichier chargé. Choisissez une vitesse ou activez l’inversion.');
  else setStatus('Aperçu et métadonnées indisponibles (lecture native impossible) : le traitement utilisera FFmpeg.');
}

/* ==========================================================================
   Traitement FFmpeg.wasm (lazy)
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

/** Arguments FFmpeg : -vf (reverse + setpts), -af (areverse + atempo) ; piste audio optionnelle (`0:a:0?`). */
function ffmpegArgs(inName, outName, fmt, speed, reverse, mute, aCodec) {
  const vf = ['scale=trunc(iw/2)*2:trunc(ih/2)*2']; // dimensions paires (yuv420p)
  if (reverse) vf.push('reverse');
  if (Math.abs(speed - 1) > 1e-4) vf.push(`setpts=(1/${speed})*PTS`);
  const a = ['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0', '-vf', vf.join(',')];
  a.push(...fmt.vArgs);
  if (mute || !aCodec) {
    a.push('-an');
  } else {
    const af = [];
    if (reverse) af.push('areverse');
    if (Math.abs(speed - 1) > 1e-4) af.push(...atempoChain(speed));
    if (af.length) a.push('-af', af.join(','));
    a.push('-c:a', aCodec, '-b:a', '128k', '-ac', '2');
  }
  a.push(outName);
  return a;
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–1 traitement. */
async function processFfmpeg(fmt, speed, reverse, mute, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const inName = 'in.' + (extOf(s.file.name).replace(/[^a-z0-9]/g, '') || 'bin');
  const outName = 'out.' + fmt.ext;
  const outDur = s.meta?.duration > 0 ? s.meta.duration / speed : 0; // durée de sortie attendue (s)
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

    await ffmpeg.writeFile(inName, new Uint8Array(await s.file.arrayBuffer()));
    if (signal.aborted) throw abortErr();
    const label = reverse ? 'Inversion' : 'Changement de vitesse';
    ffmpeg.on('progress', ({ progress, time }) => {
      // `progress` est relatif à la durée d'entrée : on préfère le temps de sortie / durée de sortie attendue
      const byTime = outDur > 0 && Number.isFinite(time) && time > 0 ? time / 1e6 / outDur : NaN;
      const p = clamp(Number.isFinite(byTime) ? byTime : (Number(progress) || 0), 0, 0.99);
      setProgress(0.2 + 0.8 * p);
      setStatus(`${label} ${fmt.ext.toUpperCase()} (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus(reverse ? 'Inversion (lecture complète des images en mémoire)…' : `${label} (FFmpeg)…`); setProgress(0.2);
    // Codecs audio testés dans l'ordre (repli automatique) ; sans audio / mute → -an
    let code = -1;
    for (const ac of (mute ? [null] : fmt.aCodecs)) {
      logs.length = 0;
      code = await ffmpeg.exec(ffmpegArgs(inName, outName, fmt, speed, reverse, mute, ac));
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

async function convert() {
  if (!canRun()) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value];
  const { speed, reverse } = st;
  const mute = q('mute').checked;
  setBusy(true); setProgress(0);

  try {
    const blob = await processFfmpeg(fmt, speed, reverse, mute, signal);
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + (reverse ? '_inverse' : '_vitesse');
    showResult(blob, `${base}.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Traitement annulé.');
    else {
      const hint = reverse ? ' L’inversion est très gourmande en mémoire : essayez un extrait plus court.' : '';
      setStatus(`Traitement ${fmt.ext.toUpperCase()} impossible (${errMsg(e)}).${hint}`, 'error');
    }
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vidspd" id="vidspd-root">
  <div class="vidspd-drop" id="vidspd-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier vidéo">
    <i data-lucide="gauge" class="icon-xl"></i>
    <strong>Glissez une vidéo ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="vidspd-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" hidden>
  </div>

  <div class="vidspd-editor" id="vidspd-editor" hidden>
    <div class="vidspd-head">
      <div class="vidspd-file"><b class="vidspd-name" id="vidspd-name"></b><small class="vidspd-meta" id="vidspd-meta"></small></div>
      <button class="btn-remove-file" id="vidspd-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <video class="vidspd-video" id="vidspd-src" controls preload="metadata" playsinline></video>

    <div class="vidspd-info">
      <div class="vidspd-stat"><small>Durée originale</small><b id="vidspd-st-dur">—</b></div>
      <div class="vidspd-stat"><small>Durée estimée en sortie</small><b id="vidspd-st-out">—</b></div>
      <div class="vidspd-stat"><small>Résolution</small><b id="vidspd-st-res">—</b></div>
      <div class="vidspd-stat"><small>Taille</small><b id="vidspd-st-size">—</b></div>
    </div>

    <div class="vidspd-panel">
      <div class="vidspd-chips" id="vidspd-chips" role="group" aria-label="Vitesses prédéfinies">
        ${SPEEDS.map((v) => `<button class="vidspd-chip" type="button" data-speed="${v}" aria-pressed="false">${fmtSpeed(v)}</button>`).join('')}
      </div>
      <label class="vidspd-field vidspd-field--wide">Vitesse <span class="vidspd-val" id="vidspd-speed-val">1×</span>
        <input type="range" id="vidspd-speed" min="${SPEED_MIN}" max="${SPEED_MAX}" step="0.05" value="1">
      </label>
      <label class="vidspd-check"><input type="checkbox" id="vidspd-reverse"> Inverser la lecture (rembobinage)</label>
      <label class="vidspd-check"><input type="checkbox" id="vidspd-mute"> Couper le son (supprimer la piste audio)</label>
      <label class="vidspd-field">Format de sortie
        <select id="vidspd-format">
          <option value="mp4" selected>MP4 (H.264 + AAC)</option>
          <option value="webm">WEBM (VP8 + Vorbis)</option>
        </select>
      </label>
      <div class="vidspd-notice is-danger" id="vidspd-notice" hidden>
        <i data-lucide="triangle-alert"></i>
        <p id="vidspd-notice-text"></p>
      </div>
    </div>
  </div>

  <div>
    <div class="vidspd-bar" id="vidspd-bar"><i></i></div>
    <p class="vidspd-status status-muted" id="vidspd-status">Déposez une vidéo pour commencer.</p>
  </div>

  <div class="vidspd-actions">
    <button class="btn-primary" id="vidspd-convert" type="button"><i data-lucide="gauge"></i> Appliquer</button>
    <button class="btn-secondary" id="vidspd-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vidspd-result" id="vidspd-result" hidden>
    <video class="vidspd-video" id="vidspd-out" controls preload="metadata" playsinline></video>
    <a class="btn-primary vidspd-link" id="vidspd-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, file: null, meta: null,
    srcUrl: null, objectUrl: null, abort: null, busy: false, loading: 0,
    speed: 1, reverse: false,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root');
  const drop = q('drop'), file = q('file');

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

  // Vitesse : pastilles + curseur
  q('chips').addEventListener('click', (e) => {
    const b = e.target.closest('.vidspd-chip');
    if (b && !s.busy) setSpeed(Number(b.dataset.speed), false);
  }, opt);
  q('speed').addEventListener('input', (e) => setSpeed(Number(e.target.value), true), opt);

  // Inversion / son / format : tout changement invalide le résultat précédent
  q('reverse').addEventListener('change', (e) => {
    s.reverse = e.target.checked;
    clearResult(); refreshNotice(); applyPreviewRate(); refreshInfo();
  }, opt);
  ['mute', 'format'].forEach((id) => q(id).addEventListener('change', clearResult, opt));

  // Traitement / annulation / reset
  q('convert').addEventListener('click', convert, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez une vidéo pour commencer.');
  }, opt);

  setSpeed(1, false);
  q('convert').disabled = true;
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide une lecture de métadonnées en cours
  s.abort?.abort();            // stoppe traitement / chargement FFmpeg (terminate Worker)
  clearResult();               // pause <video> résultat + URL.revokeObjectURL
  resetVideoEl(q('src'));      // pause <video> source
  releaseSrc();                // URL.revokeObjectURL de l'aperçu source
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
