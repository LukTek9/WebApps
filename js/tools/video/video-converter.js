/**
 * video-converter.js — Outil « Convertisseur Vidéo local » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier vidéo (glisser-déposer / sélecteur) → aperçu <video controls> + métadonnées
 *     (durée, résolution, taille). Si la lecture native échoue (AVI, MKV…) → conversion FFmpeg quand même.
 *  2. Options : format cible (MP4 / WEBM / MOV / AVI), résolution (Original / 1080p / 720p / 480p),
 *     qualité (Haute / Équilibrée / Compacte), option « couper le son ».
 *  3. Conversion : FFmpeg.wasm chargé à la demande (cœur mono-thread, Worker en blob: URL),
 *     progression temps réel, bouton Annuler (terminate du Worker).
 *  4. Aperçu vidéo du résultat + téléchargement <nom>_converti.<ext> ;
 *     objectURL / Worker libérés à chaque nouvelle conversion, reset et unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576; // limite prudente : le fichier est copié dans la mémoire wasm

/** Formats cibles : codecs FFmpeg + paramètres de qualité (index 0 = Haute, 1 = Équilibrée, 2 = Compacte). */
const FORMATS = {
  mp4: {
    ext: 'mp4', mime: 'video/mp4',
    vArgs: (qi) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', ['18', '23', '28'][qi], '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    aCodecs: ['aac', 'libmp3lame'],
  },
  webm: {
    ext: 'webm', mime: 'video/webm',
    vArgs: (qi) => ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-crf', ['10', '20', '30'][qi], '-b:v', ['8M', '3M', '1M'][qi]],
    aCodecs: ['libvorbis', 'libopus'],
  },
  mov: {
    ext: 'mov', mime: 'video/quicktime',
    vArgs: (qi) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', ['18', '23', '28'][qi], '-pix_fmt', 'yuv420p'],
    aCodecs: ['aac', 'libmp3lame'],
  },
  avi: {
    ext: 'avi', mime: 'video/x-msvideo',
    vArgs: (qi) => ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-q:v', ['2', '5', '10'][qi]],
    aCodecs: ['libmp3lame', 'aac'],
  },
};
const QUALITY_INDEX = { high: 0, balanced: 1, compact: 2 };
const AUDIO_BITRATES = ['192k', '128k', '96k'];
const LOAD_TIMEOUT_MS = 90000; // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie

/* FFmpeg.wasm : mêmes versions / schéma de chargement que audio-converter. */
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
const q = (id) => s?.root.querySelector('#vidconv-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
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
  s.root.querySelectorAll('.vidconv-panel select, .vidconv-panel input').forEach((el) => { el.disabled = busy; });
  q('convert').disabled = busy || !s.file;
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
  setStatus(`Conversion terminée : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
/** Libère tout l'état (conversion, résultat, aperçu source) et revient à la zone de dépôt. */
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
  q('convert').disabled = false;
  setProgress(false);
  if (meta) setStatus('Fichier chargé. Choisissez les options puis convertissez.');
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

/** Arguments FFmpeg selon format / résolution / qualité / mute ; piste audio optionnelle (`0:a:0?`). */
function ffmpegArgs(inName, outName, fmt, height, qi, mute, aCodec) {
  const a = ['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0'];
  // Dimensions paires obligatoires (yuv420p) ; réduction uniquement (jamais d'agrandissement)
  if (height && (!s.meta || s.meta.height > height)) a.push('-vf', `scale=-2:${height}`);
  else a.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  a.push(...fmt.vArgs(qi));
  if (mute || !aCodec) a.push('-an');
  else a.push('-c:a', aCodec, '-b:a', AUDIO_BITRATES[qi], '-ac', '2');
  a.push(outName);
  return a;
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–1 conversion. */
async function convertFfmpeg(fmt, height, qi, mute, signal) {
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

    // Tentative 1 : cœur UMD (schéma audio-converter) ; tentative 2 : cœur enveloppé en ESM (Worker module Firefox)
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
      setStatus(`Conversion ${fmt.ext.toUpperCase()} (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus(`Conversion ${fmt.ext.toUpperCase()} (FFmpeg)…`); setProgress(0.2);
    // Codecs audio testés dans l'ordre (repli automatique) ; sans audio / mute → -an
    let code = -1;
    for (const ac of (mute ? [null] : fmt.aCodecs)) {
      logs.length = 0;
      code = await ffmpeg.exec(ffmpegArgs(inName, outName, fmt, height, qi, mute, ac));
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
  if (!s?.file || s.busy) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value];
  const height = Number(q('res').value) || 0; // 0 = original
  const qi = QUALITY_INDEX[q('quality').value] ?? 1;
  const mute = q('mute').checked;
  setBusy(true); setProgress(0);

  try {
    const blob = await convertFfmpeg(fmt, height, qi, mute, signal);
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_converti';
    showResult(blob, `${base}.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Conversion annulée.');
    else setStatus(`Conversion ${fmt.ext.toUpperCase()} impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vidconv" id="vidconv-root">
  <div class="vidconv-drop" id="vidconv-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier vidéo">
    <i data-lucide="film" class="icon-xl"></i>
    <strong>Glissez une vidéo ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="vidconv-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" hidden>
  </div>

  <div class="vidconv-editor" id="vidconv-editor" hidden>
    <div class="vidconv-head">
      <div class="vidconv-file"><b class="vidconv-name" id="vidconv-name"></b><small class="vidconv-meta" id="vidconv-meta"></small></div>
      <button class="btn-remove-file" id="vidconv-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <video class="vidconv-video" id="vidconv-src" controls preload="metadata" playsinline></video>

    <div class="vidconv-info">
      <div class="vidconv-stat"><small>Durée</small><b id="vidconv-st-dur">—</b></div>
      <div class="vidconv-stat"><small>Résolution</small><b id="vidconv-st-res">—</b></div>
      <div class="vidconv-stat"><small>Taille</small><b id="vidconv-st-size">—</b></div>
    </div>

    <div class="vidconv-panel">
      <label class="vidconv-field">Format cible
        <select id="vidconv-format">
          <option value="mp4" selected>MP4 (H.264 + AAC)</option>
          <option value="webm">WEBM (VP8 + Vorbis)</option>
          <option value="mov">MOV (H.264 + AAC)</option>
          <option value="avi">AVI (MPEG-4 + MP3)</option>
        </select>
      </label>
      <label class="vidconv-field">Résolution
        <select id="vidconv-res">
          <option value="0" selected>Originale</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
          <option value="480">480p</option>
        </select>
      </label>
      <label class="vidconv-field">Qualité
        <select id="vidconv-quality">
          <option value="high">Haute</option>
          <option value="balanced" selected>Équilibrée</option>
          <option value="compact">Compacte</option>
        </select>
      </label>
      <label class="vidconv-check"><input type="checkbox" id="vidconv-mute"> Couper le son (supprimer la piste audio)</label>
    </div>
  </div>

  <div>
    <div class="vidconv-bar" id="vidconv-bar"><i></i></div>
    <p class="vidconv-status status-muted" id="vidconv-status">Déposez une vidéo pour commencer.</p>
  </div>

  <div class="vidconv-actions">
    <button class="btn-primary" id="vidconv-convert" type="button"><i data-lucide="refresh-cw"></i> Convertir</button>
    <button class="btn-secondary" id="vidconv-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vidconv-result" id="vidconv-result" hidden>
    <video class="vidconv-video" id="vidconv-out" controls preload="metadata" playsinline></video>
    <a class="btn-primary vidconv-link" id="vidconv-link"></a>
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

  // Options : tout changement invalide le résultat précédent
  ['format', 'res', 'quality', 'mute'].forEach((id) => q(id).addEventListener('change', clearResult, opt));

  // Conversion / annulation / reset
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
  s.loading++;                 // invalide une lecture de métadonnées en cours
  s.abort?.abort();            // stoppe conversion / chargement FFmpeg (terminate Worker)
  clearResult();               // pause <video> résultat + URL.revokeObjectURL
  resetVideoEl(q('src'));      // pause <video> source
  releaseSrc();                // URL.revokeObjectURL de l'aperçu source
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
