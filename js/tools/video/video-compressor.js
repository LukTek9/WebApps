/**
 * video-compressor.js — Outil « Compresseur de Vidéo » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier vidéo (glisser-déposer / sélecteur) → aperçu <video controls> + métadonnées
 *     (durée, résolution, taille d'origine, débit estimé). Si la lecture native échoue
 *     (AVI, MKV…) → compression FFmpeg quand même.
 *  2. Options : niveau (Légère / Équilibrée / Forte / Personnalisée = curseur CRF + débit audio),
 *     résolution max (Originale / 1080p / 720p / 480p, dimensions paires), conteneur
 *     (MP4 H.264 ou WEBM VP8), option « couper le son ».
 *  3. Compression : FFmpeg.wasm chargé à la demande (cœur mono-thread, Worker en blob: URL,
 *     repli cœur ESM pour Firefox), progression temps réel, bouton Annuler (terminate du Worker).
 *  4. Badge avant / après (Mo économisés exacts + % de réduction), aperçu du résultat,
 *     téléchargement <nom>_compresse.<ext> ; objectURL / Worker libérés à chaque nouvelle
 *     compression, reset et unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576; // limite prudente : le fichier est copié dans la mémoire wasm
const LOAD_TIMEOUT_MS = 90000;   // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie

/** Niveaux prédéfinis : CRF x264 (18 = quasi sans perte … 40 = très compressé) + débit audio. */
const PRESETS = {
  light: { crf: 23, abr: '160k' },
  balanced: { crf: 28, abr: '128k' },
  strong: { crf: 33, abr: '96k' },
};

/** Conteneurs de sortie. Le CRF x264 est converti en CRF VP8 (échelle différente) pour WEBM. */
const FORMATS = {
  mp4: {
    ext: 'mp4', mime: 'video/mp4',
    vArgs: (crf) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    aCodecs: ['aac', 'libmp3lame'],
  },
  webm: {
    ext: 'webm', mime: 'video/webm',
    vArgs: (crf) => ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-pix_fmt', 'yuv420p',
      '-crf', String(clamp(Math.round((crf - 18) * 1.4 + 8), 4, 50)), '-b:v', '8M'],
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
const q = (id) => s?.root.querySelector('#vidcomp-' + id);
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const fmtMB2 = (b) => (b / 1048576).toFixed(2) + ' Mo';
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

/** bits/s → « 4.20 Mb/s » ou « 850 kb/s ». */
function fmtRate(bps) {
  return bps >= 1e6 ? (bps / 1e6).toFixed(2) + ' Mb/s' : Math.round(bps / 1000) + ' kb/s';
}

function isVideoFile(f) {
  return f.type.startsWith('video/') || ACCEPT_EXT.includes(extOf(f.name));
}

/* ==========================================================================
   UI : statut / progression / options / occupation
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

/** Curseur CRF et débit audio éditables uniquement en mode « Personnalisée » (et audio hors mute). */
function applyEnabled() {
  if (!s) return;
  const custom = q('preset').value === 'custom';
  q('crf').disabled = s.busy || !custom;
  q('abr').disabled = s.busy || !custom || q('mute').checked;
}

function updateCrfLabel() {
  const v = Number(q('crf').value);
  const hint = v <= 24 ? 'qualité élevée' : v <= 30 ? 'équilibré' : 'forte compression';
  q('crf-val').textContent = `CRF ${v} — ${hint}`;
}

/** Applique les valeurs du niveau choisi aux contrôles (sauf « Personnalisée » : valeurs conservées). */
function syncPreset() {
  const p = PRESETS[q('preset').value];
  if (p) { q('crf').value = String(p.crf); q('abr').value = p.abr; }
  updateCrfLabel();
  applyEnabled();
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.root.querySelectorAll('.vidcomp-ctl').forEach((el) => { el.disabled = busy; });
  applyEnabled();
  q('compress').disabled = busy || !s.file;
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
  q('sizes').textContent = ''; q('badge').textContent = '';
  q('badge').classList.remove('is-loss');
}

/** Badge avant / après : Mo économisés exacts + % de réduction (rouge si le fichier grossit). */
function showResult(blob, name) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  const out = q('out');
  out.hidden = false;
  out.src = s.objectUrl;
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;

  const before = s.file.size, after = blob.size;
  const diff = before - after;
  const pct = before > 0 ? (Math.abs(diff) / before) * 100 : 0;
  const loss = diff < 0;
  q('sizes').textContent = `Avant : ${fmtMB2(before)} → Après : ${fmtMB2(after)}`;
  const badge = q('badge');
  badge.classList.toggle('is-loss', loss);
  badge.textContent = loss
    ? `+${fmtMB2(-diff)} (+${pct.toFixed(1)} %) — plus lourd`
    : `−${fmtMB2(diff)} économisés (−${pct.toFixed(1)} %)`;

  q('result').hidden = false;
  setProgress(1);
  setStatus(
    loss ? 'Compression terminée, mais le fichier est plus lourd : choisissez un niveau plus fort ou une résolution plus basse.'
      : `Compression terminée : ${fmtMB(after)} (−${pct.toFixed(1)} %).`,
    loss ? undefined : 'ok',
  );
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
/** Libère tout l'état (compression, résultat, aperçu source) et revient à la zone de dépôt. */
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
  // Débit moyen global (vidéo + audio) = taille × 8 / durée
  q('st-rate').textContent = meta && meta.duration > 0 ? fmtRate((file.size * 8) / meta.duration) : '—';
}

/** Lit durée / résolution via <video> (null si le navigateur ne sait pas décoder le conteneur). */
function readMeta(url) {
  return new Promise((resolve) => {
    const v = q('src');
    const done = (m) => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', ko); resolve(m); };
    const ok = () => done(v.videoWidth > 0 && Number.isFinite(v.duration)
      ? { duration: v.duration, width: v.videoWidth, height: v.videoHeight } : null);
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
  q('compress').disabled = false;
  setProgress(false);
  if (meta) setStatus('Fichier chargé. Choisissez les options puis compressez.');
  else setStatus('Aperçu et métadonnées indisponibles (lecture native impossible) : la compression utilisera FFmpeg.');
}

/* ==========================================================================
   Compression FFmpeg.wasm (lazy)
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

/** Arguments FFmpeg ; piste audio optionnelle (`0:a:0?`), dimensions paires (yuv420p), jamais d'agrandissement. */
function ffmpegArgs(inName, outName, fmt, height, crf, abr, mute, aCodec) {
  const a = ['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0'];
  if (height && (!s.meta || s.meta.height > height)) a.push('-vf', `scale=-2:${height}`);
  else a.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  a.push(...fmt.vArgs(crf));
  if (mute || !aCodec) a.push('-an');
  else a.push('-c:a', aCodec, '-b:a', abr, '-ac', '2');
  a.push(outName);
  return a;
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–1 compression. */
async function compressFfmpeg(fmt, height, crf, abr, mute, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const inName = 'in.' + (extOf(s.file.name).replace(/[^a-z0-9]/g, '') || 'bin');
  const outName = 'out.' + fmt.ext;
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
    ffmpeg.on('progress', ({ progress }) => {
      const p = clamp(Number(progress) || 0, 0, 1);
      setProgress(0.2 + 0.8 * p);
      setStatus(`Compression ${fmt.ext.toUpperCase()} (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus(`Compression ${fmt.ext.toUpperCase()} (FFmpeg)…`); setProgress(0.2);
    // Codecs audio testés dans l'ordre (repli automatique) ; sans audio / mute → -an
    let code = -1;
    for (const ac of (mute ? [null] : fmt.aCodecs)) {
      logs.length = 0;
      code = await ffmpeg.exec(ffmpegArgs(inName, outName, fmt, height, crf, abr, mute, ac));
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

async function compress() {
  if (!s?.file || s.busy) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value] || FORMATS.mp4;
  const height = Number(q('res').value) || 0; // 0 = originale
  const crf = Number(q('crf').value);
  const abr = q('abr').value;
  const mute = q('mute').checked;
  setBusy(true); setProgress(0);

  try {
    const blob = await compressFfmpeg(fmt, height, crf, abr, mute, signal);
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_compresse';
    showResult(blob, `${base}.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Compression annulée.');
    else setStatus(`Compression ${fmt.ext.toUpperCase()} impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vidcomp" id="vidcomp-root">
  <div class="vidcomp-drop" id="vidcomp-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier vidéo">
    <i data-lucide="shrink" class="icon-xl"></i>
    <strong>Glissez une vidéo ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="vidcomp-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" hidden>
  </div>

  <div class="vidcomp-editor" id="vidcomp-editor" hidden>
    <div class="vidcomp-head">
      <div class="vidcomp-file"><b class="vidcomp-name" id="vidcomp-name"></b><small class="vidcomp-meta" id="vidcomp-meta"></small></div>
      <button class="btn-remove-file" id="vidcomp-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <video class="vidcomp-video" id="vidcomp-src" controls preload="metadata" playsinline></video>

    <div class="vidcomp-info">
      <div class="vidcomp-stat"><small>Durée</small><b id="vidcomp-st-dur">—</b></div>
      <div class="vidcomp-stat"><small>Résolution</small><b id="vidcomp-st-res">—</b></div>
      <div class="vidcomp-stat"><small>Taille d'origine</small><b id="vidcomp-st-size">—</b></div>
      <div class="vidcomp-stat"><small>Débit estimé</small><b id="vidcomp-st-rate">—</b></div>
    </div>

    <div class="vidcomp-panel">
      <label class="vidcomp-field">Niveau de compression
        <select id="vidcomp-preset" class="vidcomp-ctl">
          <option value="light">Légère (qualité élevée)</option>
          <option value="balanced" selected>Équilibrée</option>
          <option value="strong">Forte (fichier minimal)</option>
          <option value="custom">Personnalisée</option>
        </select>
      </label>
      <label class="vidcomp-field">Résolution maximale
        <select id="vidcomp-res" class="vidcomp-ctl">
          <option value="0" selected>Originale</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
          <option value="480">480p</option>
        </select>
      </label>
      <label class="vidcomp-field">Format de sortie
        <select id="vidcomp-format" class="vidcomp-ctl">
          <option value="mp4" selected>MP4 (H.264 + AAC)</option>
          <option value="webm">WEBM (VP8 + Vorbis)</option>
        </select>
      </label>
      <label class="vidcomp-field">Débit audio
        <select id="vidcomp-abr" class="vidcomp-ctl">
          <option value="64k">64 kb/s</option>
          <option value="96k">96 kb/s</option>
          <option value="128k" selected>128 kb/s</option>
          <option value="160k">160 kb/s</option>
          <option value="192k">192 kb/s</option>
        </select>
      </label>
      <label class="vidcomp-field vidcomp-wide">Qualité vidéo <span class="vidcomp-val" id="vidcomp-crf-val"></span>
        <input type="range" id="vidcomp-crf" class="vidcomp-ctl" min="18" max="40" step="1" value="28">
      </label>
      <label class="vidcomp-check"><input type="checkbox" id="vidcomp-mute" class="vidcomp-ctl"> Couper le son (supprimer la piste audio)</label>
    </div>
  </div>

  <div>
    <div class="vidcomp-bar" id="vidcomp-bar"><i></i></div>
    <p class="vidcomp-status status-muted" id="vidcomp-status">Déposez une vidéo pour commencer.</p>
  </div>

  <div class="vidcomp-actions">
    <button class="btn-primary" id="vidcomp-compress" type="button" disabled><i data-lucide="shrink"></i> Compresser</button>
    <button class="btn-secondary" id="vidcomp-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vidcomp-result" id="vidcomp-result" hidden>
    <div class="vidcomp-compare">
      <span class="vidcomp-badge" id="vidcomp-badge"></span>
      <span class="vidcomp-sizes" id="vidcomp-sizes"></span>
    </div>
    <video class="vidcomp-video" id="vidcomp-out" controls preload="metadata" playsinline></video>
    <a class="btn-primary vidcomp-link" id="vidcomp-link"></a>
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

  // Niveau : applique les valeurs du préréglage ; curseur CRF / débit audio éditables seulement en « Personnalisée »
  q('preset').addEventListener('change', () => { syncPreset(); clearResult(); }, opt);
  q('crf').addEventListener('input', () => { updateCrfLabel(); clearResult(); }, opt);
  q('abr').addEventListener('change', clearResult, opt);
  q('mute').addEventListener('change', () => { applyEnabled(); clearResult(); }, opt);
  ['res', 'format'].forEach((id) => q(id).addEventListener('change', clearResult, opt));

  // Résultat non lisible nativement : on masque l'aperçu, le téléchargement reste disponible
  q('out').addEventListener('error', () => {
    if (!s?.objectUrl) return;
    q('out').hidden = true;
  }, opt);

  // Compression / annulation / reset
  q('compress').addEventListener('click', compress, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez une vidéo pour commencer.');
  }, opt);

  syncPreset();
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide une lecture de métadonnées en cours
  s.abort?.abort();            // stoppe compression / chargement FFmpeg (terminate Worker)
  clearResult();               // pause <video> résultat + URL.revokeObjectURL
  resetVideoEl(q('src'));      // pause <video> source
  releaseSrc();                // URL.revokeObjectURL de l'aperçu source
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
