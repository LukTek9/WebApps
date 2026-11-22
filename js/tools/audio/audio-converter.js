/**
 * audio-converter.js — Outil « Convertisseur Audio » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier audio (glisser-déposer / sélecteur) → métadonnées via AudioContext.decodeAudioData
 *     (durée, fréquence, canaux, taille). Si le décodage natif échoue → conversion FFmpeg uniquement.
 *  2. Cible WAV : chemin natif rapide (AudioBuffer → PCM 16 bits, rééchantillonnage OfflineAudioContext).
 *  3. Cibles MP3 / OGG / M4A / FLAC : FFmpeg.wasm chargé à la demande (cœur mono-thread, Worker en blob: URL).
 *  4. Aperçu <audio> + lien de téléchargement ; objectURL révoqué à chaque nouvelle conversion / reset / unmount.
 *  5. AudioContext fermé, Worker FFmpeg terminé, requêtes annulées au reset / unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'];

/** Formats cibles : ext, mime, codec FFmpeg (null = natif), bitrate applicable. */
const FORMATS = {
  wav:  { ext: 'wav',  mime: 'audio/wav',  codec: null,         lossy: false },
  mp3:  { ext: 'mp3',  mime: 'audio/mpeg', codec: 'libmp3lame', lossy: true },
  ogg:  { ext: 'ogg',  mime: 'audio/ogg',  codec: 'libvorbis',  lossy: true },
  m4a:  { ext: 'm4a',  mime: 'audio/mp4',  codec: 'aac',        lossy: true },
  flac: { ext: 'flac', mime: 'audio/flac', codec: 'flac',       lossy: false },
};

/* FFmpeg.wasm : mêmes versions / schéma de chargement que audio-trimmer. */
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
const q = (id) => s?.root.querySelector('#audconv-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'audio';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const yieldUi = () => new Promise((r) => setTimeout(r));
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

function fmtDuration(t) {
  const sec = Math.max(0, Number(t) || 0);
  const m = Math.floor(sec / 60);
  return `${m}:${(sec % 60).toFixed(2).padStart(5, '0')}`;
}

function isAudioFile(f) {
  return f.type.startsWith('audio/') || f.type === 'video/webm' || ACCEPT_EXT.includes(extOf(f.name));
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
  s.root.querySelectorAll('.audconv-panel select').forEach((el) => { el.disabled = busy; });
  if (!busy) syncOptions();
  q('convert').disabled = busy || !s.file;
  q('reset').disabled = busy;
  q('cancel').hidden = !busy;
}

/** Débit masqué pour les formats sans perte (WAV / FLAC). */
function syncOptions() {
  const fmt = FORMATS[q('format').value];
  q('kbps-wrap').hidden = !fmt.lossy;
}

/* ==========================================================================
   Résultat / objectURL
   ========================================================================== */
function releaseUrl() {
  if (!s || !s.objectUrl) return;
  URL.revokeObjectURL(s.objectUrl);
  s.objectUrl = null;
}

function clearResult() {
  releaseUrl();
  const box = q('result'); if (!box) return;
  box.hidden = true;
  const audio = q('audio');
  audio.pause();
  audio.removeAttribute('src');
  audio.load(); // libère la ressource média
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download'); link.textContent = '';
}

function showResult(blob, name) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  q('audio').src = s.objectUrl;
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  q('result').hidden = false;
  setProgress(1);
  setStatus(`Conversion terminée : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Audio : contexte, chargement, métadonnées
   ========================================================================== */
function ensureAC() {
  if (!s.ac || s.ac.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('AudioContext non pris en charge par ce navigateur');
    s.ac = new AC();
  }
  return s.ac;
}

function closeAC() {
  if (!s) return;
  const ac = s.ac;
  s.ac = null;
  if (ac && ac.state !== 'closed') ac.close().catch(() => { /* déjà fermé */ });
}

/** Libère tout l'état (conversion, résultat, buffer, AudioContext) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  clearResult();
  closeAC();
  s.file = null; s.buffer = null;
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  setBusy(false);
  setProgress(false);
}

function showMeta(file, buf) {
  q('name').textContent = file.name;
  q('meta').textContent = extOf(file.name).toUpperCase() || (file.type || 'audio');
  q('st-dur').textContent = buf ? fmtDuration(buf.duration) : '—';
  q('st-rate').textContent = buf ? `${buf.sampleRate} Hz` : '—';
  q('st-ch').textContent = buf ? (buf.numberOfChannels > 1 ? `${buf.numberOfChannels} (${buf.numberOfChannels === 2 ? 'stéréo' : 'multi'})` : 'mono') : '—';
  q('st-size').textContent = fmtMB(file.size);
}

async function loadFile(file) {
  if (!s || !file || s.busy) return;
  if (!isAudioFile(file)) {
    setStatus('Format non pris en charge : utilisez MP3, WAV, OGG, M4A, AAC, FLAC ou WEBM.', 'error');
    return;
  }
  discard();
  const token = ++s.loading;
  setStatus(`Lecture de « ${file.name} »…`); setProgress(null);
  let buf = null;
  try {
    const ac = ensureAC();
    buf = await ac.decodeAudioData(await file.arrayBuffer());
    if (!(buf.duration > 0)) buf = null;
  } catch { buf = null; /* décodage natif impossible → FFmpeg prendra le relais */ }
  if (!s || s.loading !== token) return; // reset / nouveau fichier / unmount entre-temps

  s.file = file; s.buffer = buf;
  q('drop').hidden = true;
  q('editor').hidden = false;
  showMeta(file, buf);
  syncOptions();
  q('convert').disabled = false;
  setProgress(false);
  if (buf) setStatus('Fichier chargé. Choisissez le format cible puis convertissez.');
  else setStatus('Métadonnées indisponibles (décodage natif impossible) : la conversion utilisera FFmpeg.');
}

/* ==========================================================================
   Conversion native : WAV PCM 16 bits (+ rééchantillonnage OfflineAudioContext)
   ========================================================================== */
async function resample(buf, rate, signal) {
  if (!rate || rate === buf.sampleRate) return buf;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error('OfflineAudioContext non pris en charge');
  const len = Math.max(1, Math.ceil(buf.duration * rate));
  const off = new Offline(buf.numberOfChannels, len, rate);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  if (signal.aborted) throw abortErr();
  return out;
}

async function encodeWav(buf, signal, onProgress) {
  const rate = buf.sampleRate, ch = buf.numberOfChannels, n = buf.length;
  const bytes = n * ch * 2;
  if (bytes > 0xFFFFFFFF - 36) throw new Error('fichier trop long pour le format WAV (> 4 Go)');

  let dv;
  try { dv = new DataView(new ArrayBuffer(44 + bytes)); }
  catch { throw new Error('mémoire insuffisante pour cette conversion'); }
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, bytes, true);

  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = clamp(data[c][i], -1, 1);
      dv.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
    if (i % 262144 === 0) { // rend la main + annulation + progression
      if (signal.aborted) throw abortErr();
      onProgress(i / n);
      await yieldUi();
    }
  }
  return new Blob([dv], { type: FORMATS.wav.mime });
}

async function convertNative(rate, signal) {
  setStatus('Conversion WAV native…'); setProgress(0);
  let buf = s.buffer;
  if (rate && rate !== buf.sampleRate) {
    setStatus(`Rééchantillonnage ${rate} Hz…`); setProgress(null);
    buf = await resample(buf, rate, signal);
    setStatus('Encodage WAV PCM 16 bits…'); setProgress(0);
  }
  return encodeWav(buf, signal, (p) => setProgress(p));
}

/* ==========================================================================
   Conversion FFmpeg.wasm (lazy) : MP3 / OGG / M4A / FLAC (+ WAV si décodage natif KO)
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

/** Arguments FFmpeg selon format / débit / fréquence. */
function ffmpegArgs(inName, outName, fmt, kbps, rate) {
  const a = ['-i', inName, '-vn', '-map_metadata', '0'];
  if (fmt.codec) a.push('-c:a', fmt.codec);
  if (fmt.lossy) a.push('-b:a', `${kbps}k`);
  if (rate) a.push('-ar', String(rate));
  a.push(outName);
  return a;
}

/** Progression : 0–0.3 chargement FFmpeg, 0.3–1 conversion. */
async function convertFfmpeg(fmt, kbps, rate, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const inName = 'in.' + (extOf(s.file.name).replace(/[^a-z0-9]/g, '') || 'bin');
  const outName = 'out.' + fmt.ext;
  let ffmpeg = null, onAbort = null, lastLog = '';
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(0.02 + p * 0.28); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

    ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => { lastLog = message; });
    onAbort = () => { try { ffmpeg.terminate(); } catch { /* déjà fermé */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL: workerURL });
    if (signal.aborted) throw abortErr();

    await ffmpeg.writeFile(inName, new Uint8Array(await s.file.arrayBuffer()));
    ffmpeg.on('progress', ({ progress }) => setProgress(0.3 + 0.7 * clamp(Number(progress) || 0, 0, 1)));
    setStatus(`Conversion ${fmt.ext.toUpperCase()} (FFmpeg)…`); setProgress(0.3);
    const code = await ffmpeg.exec(ffmpegArgs(inName, outName, fmt, kbps, rate));
    if (code !== 0) throw new Error(`FFmpeg code ${code}${lastLog ? ' — ' + lastLog : ''}`);
    return new Blob([await ffmpeg.readFile(outName)], { type: fmt.mime });
  } catch (e) {
    if (signal.aborted) throw abortErr();
    throw e;
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
  const kbps = Number(q('kbps').value) || 192;
  const rate = Number(q('rate').value) || 0; // 0 = original
  setBusy(true); setProgress(0);

  try {
    let blob;
    // Chemin rapide natif : WAV avec buffer décodé ; sinon FFmpeg
    if (fmt.ext === 'wav' && st.buffer) blob = await convertNative(rate, signal);
    else {
      try { blob = await convertFfmpeg(fmt, kbps, rate, signal); }
      catch (e) {
        if (isAbort(e)) throw e;
        const hint = fmt.ext === 'wav' ? '' : ' La conversion WAV reste disponible si le fichier est décodable nativement.';
        throw new Error(`Conversion ${fmt.ext.toUpperCase()} impossible (${e.message}).${hint}`);
      }
    }
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_converti';
    showResult(blob, `${base}.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Conversion annulée.');
    else setStatus(e.message || 'Erreur inconnue', 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="audconv" id="audconv-root">
  <div class="audconv-drop" id="audconv-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier audio">
    <i data-lucide="refresh-cw" class="icon-xl"></i>
    <strong>Glissez un fichier audio ici</strong>
    <small>ou cliquez pour parcourir — MP3, WAV, OGG, M4A, AAC, FLAC, WEBM</small>
    <input type="file" id="audconv-file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm" hidden>
  </div>

  <div class="audconv-editor" id="audconv-editor" hidden>
    <div class="audconv-head">
      <div class="audconv-file"><b class="audconv-name" id="audconv-name"></b><small class="audconv-meta" id="audconv-meta"></small></div>
      <button class="btn-remove-file" id="audconv-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <div class="audconv-info">
      <div class="audconv-stat"><small>Durée</small><b id="audconv-st-dur">—</b></div>
      <div class="audconv-stat"><small>Fréquence</small><b id="audconv-st-rate">—</b></div>
      <div class="audconv-stat"><small>Canaux</small><b id="audconv-st-ch">—</b></div>
      <div class="audconv-stat"><small>Taille</small><b id="audconv-st-size">—</b></div>
    </div>

    <div class="audconv-panel">
      <label class="audconv-field">Format cible
        <select id="audconv-format">
          <option value="mp3" selected>MP3 (FFmpeg.wasm)</option>
          <option value="wav">WAV (PCM 16 bits — natif, rapide)</option>
          <option value="ogg">OGG Vorbis (FFmpeg.wasm)</option>
          <option value="m4a">M4A / AAC (FFmpeg.wasm)</option>
          <option value="flac">FLAC (FFmpeg.wasm)</option>
        </select>
      </label>
      <label class="audconv-field" id="audconv-kbps-wrap">Débit
        <select id="audconv-kbps">
          <option value="128">128 kbit/s</option>
          <option value="192" selected>192 kbit/s</option>
          <option value="256">256 kbit/s</option>
          <option value="320">320 kbit/s</option>
        </select>
      </label>
      <label class="audconv-field">Fréquence d'échantillonnage
        <select id="audconv-rate">
          <option value="0" selected>Originale</option>
          <option value="44100">44100 Hz</option>
          <option value="48000">48000 Hz</option>
        </select>
      </label>
    </div>
  </div>

  <div>
    <div class="audconv-bar" id="audconv-bar"><i></i></div>
    <p class="audconv-status status-muted" id="audconv-status">Déposez un fichier audio pour commencer.</p>
  </div>

  <div class="audconv-actions">
    <button class="btn-primary" id="audconv-convert" type="button"><i data-lucide="refresh-cw"></i> Convertir</button>
    <button class="btn-secondary" id="audconv-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="audconv-result" id="audconv-result" hidden>
    <audio class="audconv-audio" id="audconv-audio" controls preload="metadata"></audio>
    <a class="btn-primary audconv-link" id="audconv-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, ac: null, file: null, buffer: null,
    objectUrl: null, abort: null, busy: false, loading: 0,
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
  q('format').addEventListener('change', () => { syncOptions(); clearResult(); }, opt);
  q('kbps').addEventListener('change', clearResult, opt);
  q('rate').addEventListener('change', clearResult, opt);

  // Conversion / annulation / reset
  q('convert').addEventListener('click', convert, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez un fichier audio pour commencer.');
  }, opt);

  q('convert').disabled = true;
  syncOptions();
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide un décodage en cours
  s.abort?.abort();            // stoppe conversion / chargement FFmpeg (terminate Worker)
  clearResult();               // pause <audio> + URL.revokeObjectURL
  closeAC();                   // ferme l'AudioContext
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
