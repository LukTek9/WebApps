/**
 * video-to-audio.js — Outil « Extracteur Audio » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier vidéo (glisser-déposer / sélecteur) → aperçu <video controls> + métadonnées
 *     (durée, résolution, taille). Si la lecture native échoue (AVI, MKV…) → extraction FFmpeg quand même.
 *  2. Options : format audio (MP3 / WAV / M4A-AAC / OGG), débit (320k…96k, désactivé en WAV),
 *     fréquence d'échantillonnage (Originale / 48000 Hz / 44100 Hz).
 *  3. Extraction : FFmpeg.wasm chargé à la demande (cœur mono-thread, Worker en blob: URL,
 *     repli cœur ESM pour Firefox), `-vn`, progression temps réel, bouton Annuler (terminate du Worker).
 *     Vidéo sans piste audio → message d'erreur explicite.
 *  4. Lecteur <audio controls> du résultat + téléchargement <nom>_audio.<ext> ;
 *     objectURL / Worker libérés à chaque nouvelle extraction, reset et unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576; // limite prudente : le fichier est copié dans la mémoire wasm
const LOAD_TIMEOUT_MS = 90000;   // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie

/** Formats audio cibles : codecs FFmpeg testés dans l'ordre (repli auto) ; `lossy` = débit applicable. */
const FORMATS = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg', codecs: ['libmp3lame'], lossy: true, stereo: true },
  wav: { ext: 'wav', mime: 'audio/wav', codecs: ['pcm_s16le'], lossy: false },
  m4a: { ext: 'm4a', mime: 'audio/mp4', codecs: ['aac'], lossy: true },
  ogg: { ext: 'ogg', mime: 'audio/ogg', codecs: ['libvorbis', 'libopus'], lossy: true },
};

/** Messages FFmpeg indiquant l'absence de flux audio (`-map 0:a:0` sans correspondance). */
const NO_AUDIO_RE = /matches no streams|does not contain any stream|no audio/i;

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
const q = (id) => s?.root.querySelector('#vid2aud-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

/** Erreur « pas de piste audio » (distinguée des échecs techniques). */
class NoAudioError extends Error {
  constructor() { super('Cette vidéo ne contient aucune piste audio.'); this.name = 'NoAudioError'; }
}

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

/** Débit désactivé pour WAV (sans perte) + indication. */
function applyEnabled() {
  if (!s) return;
  const lossy = (FORMATS[q('format').value] || FORMATS.mp3).lossy;
  q('abr').disabled = s.busy || !lossy;
  q('hint').textContent = lossy ? '' : 'WAV : PCM 16 bits sans perte, le débit ne s\'applique pas (fichier volumineux).';
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.root.querySelectorAll('.vid2aud-ctl').forEach((el) => { el.disabled = busy; });
  applyEnabled();
  q('extract').disabled = busy || !s.file;
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

/** Vide un élément <video> / <audio> et libère sa ressource média. */
function resetMediaEl(m) {
  if (!m) return;
  m.pause();
  m.removeAttribute('src');
  m.load();
}

function clearResult() {
  releaseUrl();
  const box = q('result'); if (!box) return;
  box.hidden = true;
  resetMediaEl(q('out'));
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download'); link.textContent = '';
}

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
  q('result').hidden = false;
  setProgress(1);
  setStatus(`Extraction terminée : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
/** Libère tout l'état (extraction, résultat, aperçu source) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  clearResult();
  resetMediaEl(q('src'));
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

  s.file = file; s.meta = meta;
  q('drop').hidden = true;
  q('editor').hidden = false;
  q('src').hidden = !meta; // pas d'aperçu si lecture native impossible
  showMeta(file, meta);
  q('extract').disabled = false;
  setProgress(false);
  if (meta) setStatus('Fichier chargé. Choisissez le format audio puis extrayez.');
  else setStatus('Aperçu et métadonnées indisponibles (lecture native impossible) : l\'extraction utilisera FFmpeg.');
}

/* ==========================================================================
   Extraction FFmpeg.wasm (lazy)
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

/** Arguments FFmpeg : `-vn` + première piste audio (obligatoire → erreur explicite si absente). */
function ffmpegArgs(inName, outName, fmt, codec, abr, sampleRate) {
  const a = ['-i', inName, '-vn', '-map', '0:a:0', '-map_metadata', '0', '-c:a', codec];
  if (fmt.lossy) a.push('-b:a', abr);
  if (sampleRate) a.push('-ar', sampleRate);
  if (fmt.stereo) a.push('-ac', '2'); // MP3 : 2 canaux max
  a.push(outName);
  return a;
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–1 extraction. */
async function extractFfmpeg(fmt, abr, sampleRate, signal) {
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
      setStatus(`Extraction ${fmt.ext.toUpperCase()} (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus(`Extraction ${fmt.ext.toUpperCase()} (FFmpeg)…`); setProgress(0.2);

    // Codecs testés dans l'ordre (repli automatique) ; absence de piste audio → arrêt immédiat
    let code = -1;
    for (const codec of fmt.codecs) {
      logs.length = 0;
      code = await ffmpeg.exec(ffmpegArgs(inName, outName, fmt, codec, abr, sampleRate));
      if (signal.aborted) throw abortErr();
      if (code === 0) break;
      if (NO_AUDIO_RE.test(logs.join('\n'))) throw new NoAudioError();
    }
    if (code !== 0) throw new Error(`FFmpeg code ${code}${tail()}`);
    const data = await ffmpeg.readFile(outName);
    if (!data || data.length < 64) throw new NoAudioError(); // sortie vide : aucun échantillon audio
    return new Blob([data], { type: fmt.mime });
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

async function extract() {
  if (!s?.file || s.busy) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value] || FORMATS.mp3;
  const abr = q('abr').value;
  const sampleRate = q('rate').value; // '' = originale
  setBusy(true); setProgress(0);

  try {
    const blob = await extractFfmpeg(fmt, abr, sampleRate, signal);
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_audio';
    showResult(blob, `${base}.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Extraction annulée.');
    else if (e instanceof NoAudioError) setStatus(`${e.message} Rien à extraire.`, 'error');
    else setStatus(`Extraction ${fmt.ext.toUpperCase()} impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vid2aud" id="vid2aud-root">
  <div class="vid2aud-drop" id="vid2aud-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier vidéo">
    <i data-lucide="audio-lines" class="icon-xl"></i>
    <strong>Glissez une vidéo ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="vid2aud-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" hidden>
  </div>

  <div class="vid2aud-editor" id="vid2aud-editor" hidden>
    <div class="vid2aud-head">
      <div class="vid2aud-file"><b class="vid2aud-name" id="vid2aud-name"></b><small class="vid2aud-meta" id="vid2aud-meta"></small></div>
      <button class="btn-remove-file" id="vid2aud-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <video class="vid2aud-video" id="vid2aud-src" controls preload="metadata" playsinline></video>

    <div class="vid2aud-info">
      <div class="vid2aud-stat"><small>Durée</small><b id="vid2aud-st-dur">—</b></div>
      <div class="vid2aud-stat"><small>Résolution</small><b id="vid2aud-st-res">—</b></div>
      <div class="vid2aud-stat"><small>Taille</small><b id="vid2aud-st-size">—</b></div>
    </div>

    <div class="vid2aud-panel">
      <label class="vid2aud-field">Format audio
        <select id="vid2aud-format" class="vid2aud-ctl">
          <option value="mp3" selected>MP3</option>
          <option value="wav">WAV (sans perte)</option>
          <option value="m4a">M4A (AAC)</option>
          <option value="ogg">OGG (Vorbis)</option>
        </select>
      </label>
      <label class="vid2aud-field">Débit audio
        <select id="vid2aud-abr" class="vid2aud-ctl">
          <option value="320k">320 kb/s</option>
          <option value="256k">256 kb/s</option>
          <option value="192k" selected>192 kb/s</option>
          <option value="128k">128 kb/s</option>
          <option value="96k">96 kb/s</option>
        </select>
      </label>
      <label class="vid2aud-field">Fréquence d'échantillonnage
        <select id="vid2aud-rate" class="vid2aud-ctl">
          <option value="" selected>Originale</option>
          <option value="48000">48000 Hz</option>
          <option value="44100">44100 Hz</option>
        </select>
      </label>
      <p class="vid2aud-hint" id="vid2aud-hint"></p>
    </div>
  </div>

  <div>
    <div class="vid2aud-bar" id="vid2aud-bar"><i></i></div>
    <p class="vid2aud-status status-muted" id="vid2aud-status">Déposez une vidéo pour commencer.</p>
  </div>

  <div class="vid2aud-actions">
    <button class="btn-primary" id="vid2aud-extract" type="button" disabled><i data-lucide="audio-lines"></i> Extraire l'audio</button>
    <button class="btn-secondary" id="vid2aud-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vid2aud-result" id="vid2aud-result" hidden>
    <audio class="vid2aud-audio" id="vid2aud-out" controls preload="metadata"></audio>
    <a class="btn-primary vid2aud-link" id="vid2aud-link"></a>
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

  // Options : tout changement invalide le résultat précédent ; WAV désactive le débit
  q('format').addEventListener('change', () => { applyEnabled(); clearResult(); }, opt);
  ['abr', 'rate'].forEach((id) => q(id).addEventListener('change', clearResult, opt));

  // Extraction / annulation / reset
  q('extract').addEventListener('click', extract, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez une vidéo pour commencer.');
  }, opt);

  applyEnabled();
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide une lecture de métadonnées en cours
  s.abort?.abort();            // stoppe extraction / chargement FFmpeg (terminate Worker)
  clearResult();               // pause <audio> résultat + URL.revokeObjectURL
  resetMediaEl(q('src'));      // pause <video> source
  releaseSrc();                // URL.revokeObjectURL de l'aperçu source
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
