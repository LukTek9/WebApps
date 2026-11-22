/**
 * video-to-gif.js — Outil « Vidéo vers GIF » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Vidéo (glisser-déposer / sélecteur) → aperçu <video controls> + métadonnées (durée, résolution, taille).
 *  2. Options : plage début/fin (optionnelle), largeur, FPS, palette 256 couleurs (palettegen/paletteuse), boucle.
 *  3. Conversion : FFmpeg.wasm lazy (Worker blob:, repli cœur ESM Firefox), progression, Annuler (terminate).
 *  4. Aperçu <img> du GIF + badge taille + téléchargement <nom>.gif ; URL/Worker libérés (reset, unmount).
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576;
const LOAD_TIMEOUT_MS = 90000;
const WARN_CLIP_SEC = 15;

/* FFmpeg.wasm : mêmes versions / schéma que video-converter. */
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
const q = (id) => s?.root.querySelector('#vid2gif-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

function errMsg(e) {
  if (e == null) return 'erreur inconnue';
  if (typeof e === 'string') return e || 'erreur inconnue';
  if (e.message) return String(e.message);
  if (e.filename) return `erreur Worker (${String(e.filename).split('/').pop()}:${e.lineno || 0})`;
  if (e.type) return `événement « ${e.type} » (Worker bloqué ou script non chargé)`;
  try { const j = JSON.stringify(e); if (j && j !== '{}') return j; } catch { /* circulaire */ }
  return String(e) || 'erreur inconnue';
}

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

const isVideoFile = (f) => f.type.startsWith('video/') || ACCEPT_EXT.includes(extOf(f.name));

/* ==========================================================================
   UI : statut / progression / occupation
   ========================================================================== */
function setStatus(msg, kind) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', kind === 'error');
  el.classList.toggle('status-success', kind === 'ok');
  el.classList.toggle('status-muted', !kind);
}

function setProgress(p) {
  const bar = q('bar'); if (!bar) return;
  bar.classList.toggle('is-on', p !== false);
  bar.classList.toggle('is-indeterminate', p === null);
  bar.firstElementChild.style.width = typeof p === 'number' ? Math.round(clamp(p, 0, 1) * 100) + '%' : '';
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.root.querySelectorAll('.vid2gif-panel select, .vid2gif-panel input, .vid2gif-clip input, .vid2gif-clip button').forEach((el) => { el.disabled = busy; });
  q('convert').disabled = busy || !s.file;
  q('reset').disabled = busy;
  q('cancel').hidden = !busy;
  if (!busy) updateClipUi();
}

/* ==========================================================================
   Plage de découpe
   ========================================================================== */
/** Retourne { start, end, dur } en secondes (end = 0 → jusqu'à la fin). */
function getClip() {
  const total = s.meta?.duration || 0;
  const start = clamp(parseFloat(q('start').value) || 0, 0, total || Infinity);
  let end = parseFloat(q('end').value) || 0;
  if (!end || (total && end > total)) end = total;
  if (end && end <= start) end = 0;
  return { start, end, dur: end ? end - start : (total ? total - start : 0) };
}

function updateClipUi() {
  if (!s) return;
  const hasMeta = !!s.meta;
  ['start', 'end', 'set-start', 'set-end'].forEach((id) => { q(id).disabled = s.busy || !hasMeta; });
  const { dur } = getClip();
  q('clip-dur').textContent = hasMeta ? `Durée sélectionnée : ${fmtDuration(dur)}` : 'Plage indisponible (lecture native impossible) : vidéo entière.';
  q('clip-warn').hidden = !(dur > WARN_CLIP_SEC);
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
  q('out').removeAttribute('src');
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download'); link.textContent = '';
  q('badge').textContent = '';
}

function showResult(blob, name) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  q('out').src = s.objectUrl;
  q('badge').textContent = fmtMB(blob.size);
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name}`;
  q('result').hidden = false;
  setProgress(1);
  setStatus(`GIF généré : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  clearResult();
  resetVideoEl(q('src'));
  releaseSrc();
  s.file = null; s.meta = null;
  q('start').value = ''; q('end').value = '';
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
  if (!s || s.loading !== token) return;

  s.file = file; s.meta = meta;
  q('drop').hidden = true;
  q('editor').hidden = false;
  q('src').hidden = !meta;
  showMeta(file, meta);
  q('convert').disabled = false;
  updateClipUi();
  setProgress(false);
  if (meta) setStatus('Fichier chargé. Réglez la plage et les options puis générez le GIF.');
  else setStatus('Aperçu et métadonnées indisponibles (lecture native impossible) : la conversion utilisera FFmpeg.');
}

/* ==========================================================================
   Conversion FFmpeg.wasm (lazy)
   ========================================================================== */
function wasmSupported() {
  try {
    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') return false;
    return new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)) instanceof WebAssembly.Module;
  } catch { return false; }
}

let ffmpegLibPromise = null;
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

/** Cœur FFmpeg enveloppé en ESM (Worker module Firefox : pas d'importScripts). */
async function cdnEsmCoreUrl(signal, bag) {
  const res = await fetch(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} (ffmpeg-core.js)`);
  const src = await res.text();
  const u = URL.createObjectURL(new Blob([src, '\nexport default createFFmpegCore;\n'], { type: 'text/javascript' }));
  bag.push(u);
  return u;
}

/** Arguments FFmpeg GIF : -ss/-t en entrée, fps + scale (réduction seule) + palette optionnelle. */
function ffmpegArgs(inName, outName, o) {
  const a = [];
  if (o.start > 0) a.push('-ss', o.start.toFixed(3));
  if (o.dur > 0) a.push('-t', o.dur.toFixed(3));
  a.push('-i', inName, '-an');
  const f = [`fps=${o.fps}`];
  if (o.width && (!s.meta || s.meta.width > o.width)) f.push(`scale=${o.width}:-2:flags=lanczos`);
  if (o.hq) f.push('split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5');
  a.push('-vf', f.join(','), '-loop', o.loop ? '0' : '-1', '-f', 'gif', outName);
  return a;
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–1 conversion. */
async function convertFfmpeg(o, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const inName = 'in.' + (extOf(s.file.name).replace(/[^a-z0-9]/g, '') || 'bin');
  const outName = 'out.gif';
  let ffmpeg = null, onAbort = null;
  const logs = [];
  const pushLog = (m) => { logs.push(String(m)); if (logs.length > 25) logs.shift(); };
  const tail = () => (logs.length ? ' — ' + logs.slice(-6).join(' | ') : '');
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(0.02 + p * 0.18); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

    onAbort = () => { try { ffmpeg?.terminate(); } catch { /* déjà fermé */ } };
    signal.addEventListener('abort', onAbort, { once: true });

    // Tentative 1 : cœur UMD ; tentative 2 : cœur ESM (Firefox)
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
      setStatus(`Création du GIF (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus('Création du GIF (FFmpeg)…'); setProgress(0.2);
    logs.length = 0;
    const code = await ffmpeg.exec(ffmpegArgs(inName, outName, o));
    if (signal.aborted) throw abortErr();
    if (code !== 0) throw new Error(`FFmpeg code ${code}${tail()}`);
    return new Blob([await ffmpeg.readFile(outName)], { type: 'image/gif' });
  } catch (e) {
    if (signal.aborted) throw abortErr();
    throw e instanceof Error ? e : new Error(errMsg(e));
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (ffmpeg) {
      if (!signal.aborted) for (const f of [inName, outName]) { try { await ffmpeg.deleteFile(f); } catch { /* absent */ } }
      try { ffmpeg.terminate(); } catch { /* déjà fermé */ }
    }
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function convert() {
  if (!s?.file || s.busy) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const clip = st.meta ? getClip() : { start: 0, dur: 0 };
  const opts = {
    start: clip.start,
    dur: clip.dur,
    width: Number(q('width').value) || 0, // 0 = original
    fps: Number(q('fps').value) || 10,
    hq: q('hq').checked,
    loop: q('loop').value === 'infinite',
  };
  setBusy(true); setProgress(0);

  try {
    const blob = await convertFfmpeg(opts, signal);
    if (s !== st) return;
    showResult(blob, `${sanitize(st.file.name.replace(/\.[^.]+$/, ''))}.gif`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Conversion annulée.');
    else setStatus(`Création du GIF impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vid2gif" id="vid2gif-root">
  <div class="vid2gif-drop" id="vid2gif-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier vidéo">
    <i data-lucide="image-play" class="icon-xl"></i>
    <strong>Glissez une vidéo ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="vid2gif-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" hidden>
  </div>

  <div class="vid2gif-editor" id="vid2gif-editor" hidden>
    <div class="vid2gif-head">
      <div class="vid2gif-file"><b class="vid2gif-name" id="vid2gif-name"></b><small class="vid2gif-meta" id="vid2gif-meta"></small></div>
      <button class="btn-remove-file" id="vid2gif-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <video class="vid2gif-video" id="vid2gif-src" controls preload="metadata" playsinline></video>

    <div class="vid2gif-info">
      <div class="vid2gif-stat"><small>Durée</small><b id="vid2gif-st-dur">—</b></div>
      <div class="vid2gif-stat"><small>Résolution</small><b id="vid2gif-st-res">—</b></div>
      <div class="vid2gif-stat"><small>Taille</small><b id="vid2gif-st-size">—</b></div>
    </div>

    <div class="vid2gif-clip">
      <label class="vid2gif-field">Début (s)
        <input type="number" id="vid2gif-start" min="0" step="0.1" placeholder="0">
      </label>
      <button class="btn-secondary" id="vid2gif-set-start" type="button">Début = position actuelle</button>
      <label class="vid2gif-field">Fin (s)
        <input type="number" id="vid2gif-end" min="0" step="0.1" placeholder="fin">
      </label>
      <button class="btn-secondary" id="vid2gif-set-end" type="button">Fin = position actuelle</button>
      <p class="vid2gif-clip-dur" id="vid2gif-clip-dur"></p>
      <p class="vid2gif-clip-warn status-muted" id="vid2gif-clip-warn" hidden>Clip long (&gt; ${WARN_CLIP_SEC} s) : le GIF sera lourd et lent à générer. Réduisez la largeur ou les FPS.</p>
    </div>

    <div class="vid2gif-panel">
      <label class="vid2gif-field">Largeur
        <select id="vid2gif-width">
          <option value="0">Originale</option>
          <option value="640">640 px</option>
          <option value="480" selected>480 px</option>
          <option value="320">320 px</option>
          <option value="240">240 px</option>
        </select>
      </label>
      <label class="vid2gif-field">Images / seconde
        <select id="vid2gif-fps">
          <option value="5">5 fps</option>
          <option value="10" selected>10 fps</option>
          <option value="15">15 fps</option>
          <option value="24">24 fps</option>
        </select>
      </label>
      <label class="vid2gif-field">Boucle
        <select id="vid2gif-loop">
          <option value="infinite" selected>Infinie</option>
          <option value="once">Une fois</option>
        </select>
      </label>
      <label class="vid2gif-check"><input type="checkbox" id="vid2gif-hq" checked> Haute qualité (palette 256 couleurs optimisée)</label>
    </div>
  </div>

  <div>
    <div class="vid2gif-bar" id="vid2gif-bar"><i></i></div>
    <p class="vid2gif-status status-muted" id="vid2gif-status">Déposez une vidéo pour commencer.</p>
  </div>

  <div class="vid2gif-actions">
    <button class="btn-primary" id="vid2gif-convert" type="button"><i data-lucide="image-play"></i> Générer le GIF</button>
    <button class="btn-secondary" id="vid2gif-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vid2gif-result" id="vid2gif-result" hidden>
    <span class="vid2gif-badge" id="vid2gif-badge"></span>
    <img class="vid2gif-img" id="vid2gif-out" alt="Aperçu du GIF généré">
    <a class="btn-primary vid2gif-link" id="vid2gif-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount();
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, file: null, meta: null,
    srcUrl: null, objectUrl: null, abort: null, busy: false, loading: 0,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root');
  const drop = q('drop'), file = q('file');

  drop.addEventListener('click', () => file.click(), opt);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } }, opt);
  file.addEventListener('change', () => { const f = file.files?.[0]; if (f) loadFile(f); }, opt);
  root.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); }, opt);
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) drop.classList.remove('is-over'); }, opt);
  root.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f);
  }, opt);

  // Options : tout changement invalide le GIF précédent
  ['width', 'fps', 'loop', 'hq', 'start', 'end'].forEach((id) => q(id).addEventListener('change', () => { clearResult(); updateClipUi(); }, opt));
  ['start', 'end'].forEach((id) => q(id).addEventListener('input', updateClipUi, opt));

  // Plage : position de lecture actuelle
  q('set-start').addEventListener('click', () => {
    q('start').value = q('src').currentTime.toFixed(2);
    clearResult(); updateClipUi();
  }, opt);
  q('set-end').addEventListener('click', () => {
    q('end').value = q('src').currentTime.toFixed(2);
    clearResult(); updateClipUi();
  }, opt);

  q('convert').addEventListener('click', convert, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez une vidéo pour commencer.');
  }, opt);

  q('convert').disabled = true;
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;
  s.abort?.abort();            // stoppe conversion / chargement FFmpeg (terminate Worker)
  clearResult();               // URL.revokeObjectURL du GIF
  resetVideoEl(q('src'));
  releaseSrc();                // URL.revokeObjectURL de l'aperçu source
  s.listeners.abort();
  s.root.innerHTML = '';
  s = null;
}
