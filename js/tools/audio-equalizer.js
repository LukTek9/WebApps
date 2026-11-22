/**
 * audio-equalizer.js — Outil « Égaliseur & Amplificateur » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier audio (glisser-déposer / sélecteur) → AudioContext.decodeAudioData → AudioBuffer.
 *  2. Aperçu temps réel : AudioBufferSourceNode → préampli (GainNode) → 10 × BiquadFilterNode
 *     → limiteur optionnel (DynamicsCompressorNode) → sortie. Bypass = graphe neutre.
 *  3. Export : même graphe rendu sur toute la piste via OfflineAudioContext
 *     → WAV PCM 16 bits natif, ou MP3 via FFmpeg.wasm chargé à la demande (Worker en blob: URL).
 *  4. Aperçu <audio> + lien <nom>_eq.<ext> ; objectURL révoqué à chaque nouvel export / reset / unmount.
 *  5. AudioContext fermé, Worker FFmpeg terminé, rAF annulé, requêtes annulées au reset / unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'];

/** Bandes de l'égaliseur : fréquence centrale (Hz) + libellé. */
const BANDS = [
  { f: 32, l: '32' }, { f: 64, l: '64' }, { f: 125, l: '125' }, { f: 250, l: '250' }, { f: 500, l: '500' },
  { f: 1000, l: '1k' }, { f: 2000, l: '2k' }, { f: 4000, l: '4k' }, { f: 8000, l: '8k' }, { f: 16000, l: '16k' },
];
const GAIN_MIN = -12, GAIN_MAX = 12;
const PRE_MIN = -12, PRE_MAX = 12; // dB (+12 dB ≈ 400 %)

/** Préréglages : gain (dB) par bande, dans l'ordre de BANDS. */
const PRESETS = {
  flat:      { label: 'Flat',       gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass:      { label: 'Bass Boost', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  vocal:     { label: 'Vocal',      gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  rock:      { label: 'Rock',       gains: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5] },
  pop:       { label: 'Pop',        gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
  classical: { label: 'Classical',  gains: [0, 0, 0, 0, 0, 0, -2, -2, -2, -4] },
  treble:    { label: 'Treble',     gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
};

/** Formats d'export. */
const FORMATS = {
  wav: { ext: 'wav', mime: 'audio/wav' },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame' },
};

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
const q = (id) => s?.root.querySelector('#audeq-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'audio';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const yieldUi = () => new Promise((r) => setTimeout(r));
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const dbToGain = (db) => Math.pow(10, db / 20);
const fmtDb = (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`;

function fmtTime(t) {
  const sec = Math.max(0, Number(t) || 0);
  const m = Math.floor(sec / 60);
  return `${m}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
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
  s.root.querySelectorAll('.audeq-export select').forEach((el) => { el.disabled = busy; });
  if (!busy) syncOptions();
  q('export').disabled = busy || !s.buffer;
  q('reset').disabled = busy;
  q('cancel').hidden = !busy;
}

/** Débit masqué pour le WAV (sans perte). */
function syncOptions() {
  q('kbps-wrap').hidden = q('format').value !== 'mp3';
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
  setStatus(`Export terminé : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Graphe audio (partagé aperçu temps réel / rendu hors ligne)
   ========================================================================== */
function ensureAC() {
  if (!s.ac || s.ac.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('AudioContext non pris en charge par ce navigateur');
    s.ac = new AC();
    s.graph = null; // graphe lié à l'ancien contexte
  }
  return s.ac;
}

function closeAC() {
  if (!s) return;
  const ac = s.ac;
  s.ac = null; s.graph = null;
  if (ac && ac.state !== 'closed') ac.close().catch(() => { /* déjà fermé */ });
}

/** Construit préampli → 10 filtres → compresseur → sortie dans `ctx`. */
function buildGraph(ctx) {
  const pre = ctx.createGain();
  const filters = BANDS.map((b, i) => {
    const f = ctx.createBiquadFilter();
    f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
    f.frequency.value = b.f;
    if (f.type === 'peaking') f.Q.value = 1.41;
    f.gain.value = 0;
    return f;
  });
  const comp = ctx.createDynamicsCompressor();
  pre.connect(filters[0]);
  filters.forEach((f, i) => { if (i) filters[i - 1].connect(f); });
  filters[filters.length - 1].connect(comp);
  comp.connect(ctx.destination);
  return { pre, filters, comp, input: pre };
}

/** Applique les réglages au graphe. `smooth` : transitions courtes (temps réel, évite les clics). */
function applyParams(graph, ctx, st, smooth) {
  const set = (param, v) => {
    if (smooth) param.setTargetAtTime(v, ctx.currentTime, 0.015);
    else param.value = v;
  };
  const bypass = st.bypass;
  set(graph.pre.gain, bypass ? 1 : dbToGain(st.pre));
  graph.filters.forEach((f, i) => set(f.gain, bypass ? 0 : st.gains[i]));
  const c = graph.comp, on = st.limiter && !bypass;
  set(c.threshold, on ? -1 : 0);
  set(c.knee, 0);
  set(c.ratio, on ? 20 : 1);
  set(c.attack, 0.002);
  set(c.release, 0.1);
}

function liveParams() {
  if (!s?.graph || !s.ac) return;
  applyParams(s.graph, s.ac, s.settings, true);
}

/* ==========================================================================
   Lecture temps réel (AudioBufferSourceNode jetable + décalage manuel)
   ========================================================================== */
function position() {
  if (!s?.buffer) return 0;
  if (!s.playing || !s.ac) return s.offset;
  return clamp(s.offset + (s.ac.currentTime - s.startedAt), 0, s.buffer.duration);
}

function stopSource() {
  const src = s?.src;
  if (!src) return;
  s.src = null;
  src.onended = null;
  try { src.stop(); } catch { /* déjà arrêté */ }
  try { src.disconnect(); } catch { /* déjà déconnecté */ }
}

function cancelRaf() {
  if (s?.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
}

function updateTransport() {
  if (!s?.buffer) return;
  const pos = position();
  q('time').textContent = `${fmtTime(pos)} / ${fmtTime(s.buffer.duration)}`;
  if (!s.seeking) q('seek').value = String(Math.round((pos / s.buffer.duration) * 1000));
}

function tick() {
  if (!s || !s.playing) return;
  updateTransport();
  s.raf = requestAnimationFrame(tick);
}

function setPlayUi(playing) {
  const btn = q('play'); if (!btn) return;
  btn.innerHTML = playing
    ? '<i data-lucide="pause"></i> Pause'
    : '<i data-lucide="play"></i> Lecture';
  icons();
}

async function play(from) {
  if (!s?.buffer) return;
  const ac = ensureAC();
  if (ac.state === 'suspended') { try { await ac.resume(); } catch { /* ignoré */ } }
  if (!s || s.ac !== ac) return; // reset / unmount pendant resume
  stopSource();
  cancelRaf();
  if (!s.graph) s.graph = buildGraph(ac);
  applyParams(s.graph, ac, s.settings, false);

  const dur = s.buffer.duration;
  let off = from ?? s.offset;
  if (off >= dur - 0.01) off = 0;
  const src = ac.createBufferSource();
  src.buffer = s.buffer;
  src.connect(s.graph.input);
  src.onended = () => {
    if (!s || s.src !== src) return; // arrêt manuel / remplacé
    s.src = null; s.playing = false; s.offset = 0;
    cancelRaf(); setPlayUi(false); updateTransport();
  };
  src.start(0, off);
  s.src = src; s.offset = off; s.startedAt = ac.currentTime; s.playing = true;
  setPlayUi(true);
  s.raf = requestAnimationFrame(tick);
}

function pause() {
  if (!s || !s.playing) return;
  s.offset = position();
  s.playing = false;
  stopSource(); cancelRaf();
  setPlayUi(false); updateTransport();
}

function stopPlayback() {
  if (!s) return;
  s.playing = false;
  stopSource(); cancelRaf();
  s.offset = 0;
}

/* ==========================================================================
   UI : réglages (bandes, préampli, presets, bypass)
   ========================================================================== */
function renderGains() {
  BANDS.forEach((_, i) => {
    q('band-' + i).value = String(s.settings.gains[i]);
    q('bval-' + i).textContent = fmtDb(s.settings.gains[i]);
  });
}

function renderPresetChips() {
  const cur = s.settings.gains;
  s.root.querySelectorAll('.audeq-chip').forEach((chip) => {
    const p = PRESETS[chip.dataset.preset];
    chip.classList.toggle('is-active', p.gains.every((g, i) => g === cur[i]));
  });
}

function renderPre() {
  const db = s.settings.pre;
  q('pre').value = String(db);
  q('pre-val').textContent = `${fmtDb(db)} (${Math.round(dbToGain(db) * 100)} %)`;
}

function renderToggles() {
  const { limiter, bypass } = s.settings;
  q('limiter').checked = limiter;
  const b = q('bypass');
  b.setAttribute('aria-pressed', String(bypass));
  b.classList.toggle('is-active', bypass);
  q('panel').classList.toggle('is-bypassed', bypass);
}

function onSettingsChanged() {
  liveParams();
  clearResult(); // l'export précédent ne correspond plus aux réglages
}

function applyPreset(key) {
  s.settings.gains = PRESETS[key].gains.slice();
  renderGains(); renderPresetChips(); onSettingsChanged();
}

/* ==========================================================================
   Export : rendu hors ligne complet → WAV natif / MP3 FFmpeg
   ========================================================================== */
async function renderOffline(signal) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error('OfflineAudioContext non pris en charge');
  const buf = s.buffer;
  const off = new Offline(buf.numberOfChannels, buf.length, buf.sampleRate);
  const graph = buildGraph(off);
  // L'export applique toujours l'égalisation (le bypass ne concerne que l'aperçu).
  applyParams(graph, off, { ...s.settings, bypass: false }, false);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(graph.input);
  src.start(0);
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
  catch { throw new Error('mémoire insuffisante pour cet export'); }
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

/* ---------- FFmpeg.wasm (lazy) : WAV égalisé → MP3 ---------- */
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

/** Progression : 0–0.3 chargement FFmpeg, 0.3–1 encodage. */
async function encodeMp3(wavBlob, kbps, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const inName = 'in.wav', outName = 'out.mp3';
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

    await ffmpeg.writeFile(inName, new Uint8Array(await wavBlob.arrayBuffer()));
    ffmpeg.on('progress', ({ progress }) => setProgress(0.3 + 0.7 * clamp(Number(progress) || 0, 0, 1)));
    setStatus('Encodage MP3 (FFmpeg)…'); setProgress(0.3);
    const code = await ffmpeg.exec(['-i', inName, '-vn', '-c:a', FORMATS.mp3.codec, '-b:a', `${kbps}k`, outName]);
    if (code !== 0) throw new Error(`FFmpeg code ${code}${lastLog ? ' — ' + lastLog : ''}`);
    return new Blob([await ffmpeg.readFile(outName)], { type: FORMATS.mp3.mime });
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

async function exportAudio() {
  if (!s?.buffer || s.busy) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value];
  const kbps = Number(q('kbps').value) || 192;
  setBusy(true);

  try {
    setStatus('Rendu de la piste complète (égaliseur + gain)…'); setProgress(null);
    const rendered = await renderOffline(signal);
    if (s !== st) return;
    setStatus('Encodage WAV PCM 16 bits…'); setProgress(0);
    let blob = await encodeWav(rendered, signal, (p) => setProgress(fmt.ext === 'wav' ? p : p * 0.2));
    if (fmt.ext === 'mp3') {
      try { blob = await encodeMp3(blob, kbps, signal); }
      catch (e) {
        if (isAbort(e)) throw e;
        throw new Error(`Export MP3 impossible (${e.message}). L'export WAV reste disponible.`);
      }
    }
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_eq';
    showResult(blob, `${base}.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Export annulé.');
    else setStatus(e.message || 'Erreur inconnue', 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Chargement / reset
   ========================================================================== */
/** Libère tout l'état (lecture, export, résultat, buffer, AudioContext) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  stopPlayback();
  clearResult();
  closeAC();
  s.file = null; s.buffer = null;
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  setPlayUi(false);
  setBusy(false);
  setProgress(false);
}

function showMeta(file, buf) {
  q('name').textContent = file.name;
  q('meta').textContent = `${extOf(file.name).toUpperCase() || (file.type || 'audio')} · ${fmtMB(file.size)} · ${buf.sampleRate} Hz · ${buf.numberOfChannels > 1 ? (buf.numberOfChannels === 2 ? 'stéréo' : buf.numberOfChannels + ' canaux') : 'mono'}`;
  q('seek').value = '0';
  q('time').textContent = `0:00 / ${fmtTime(buf.duration)}`;
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
  let buf = null, err = null;
  try {
    const ac = ensureAC();
    buf = await ac.decodeAudioData(await file.arrayBuffer());
    if (!(buf.duration > 0)) buf = null;
  } catch (e) { buf = null; err = e; }
  if (!s || s.loading !== token) return; // reset / nouveau fichier / unmount entre-temps

  if (!buf) {
    setProgress(false);
    setStatus(`Décodage impossible${err?.message ? ' (' + err.message + ')' : ''} : ce fichier n'est pas lisible par le navigateur.`, 'error');
    closeAC();
    return;
  }
  s.file = file; s.buffer = buf; s.offset = 0;
  q('drop').hidden = true;
  q('editor').hidden = false;
  showMeta(file, buf);
  syncOptions();
  q('export').disabled = false;
  setProgress(false);
  setStatus('Fichier chargé. Lancez la lecture et ajustez l\'égaliseur en temps réel.');
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const bandsHtml = BANDS.map((b, i) => `
        <div class="audeq-band">
          <output class="audeq-band-val" id="audeq-bval-${i}">0.0 dB</output>
          <input type="range" id="audeq-band-${i}" min="${GAIN_MIN}" max="${GAIN_MAX}" step="0.5" value="0"
                 aria-label="${b.l} Hz" data-band="${i}">
          <span class="audeq-band-label">${b.l}</span>
        </div>`).join('');

const chipsHtml = Object.entries(PRESETS).map(([k, p]) =>
  `<button type="button" class="audeq-chip" data-preset="${k}">${p.label}</button>`).join('');

const TEMPLATE = `
<div class="audeq" id="audeq-root">
  <div class="audeq-drop" id="audeq-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier audio">
    <i data-lucide="sliders-vertical" class="icon-xl"></i>
    <strong>Glissez un fichier audio ici</strong>
    <small>ou cliquez pour parcourir — MP3, WAV, OGG, M4A, AAC, FLAC, WEBM</small>
    <input type="file" id="audeq-file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm" hidden>
  </div>

  <div class="audeq-editor" id="audeq-editor" hidden>
    <div class="audeq-head">
      <div class="audeq-file"><b class="audeq-name" id="audeq-name"></b><small class="audeq-meta" id="audeq-meta"></small></div>
      <button class="btn-remove-file" id="audeq-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <div class="audeq-player">
      <button class="btn-primary" id="audeq-play" type="button"><i data-lucide="play"></i> Lecture</button>
      <input type="range" class="audeq-seek" id="audeq-seek" min="0" max="1000" step="1" value="0" aria-label="Position de lecture">
      <span class="audeq-time" id="audeq-time">0:00 / 0:00</span>
    </div>

    <div class="audeq-panel" id="audeq-panel">
      <div class="audeq-chips" role="group" aria-label="Préréglages">${chipsHtml}</div>
      <div class="audeq-bands" role="group" aria-label="Égaliseur 10 bandes">${bandsHtml}
      </div>
      <div class="audeq-grid">
        <label class="audeq-field">Préampli / Volume
          <span class="audeq-val" id="audeq-pre-val">0.0 dB (100 %)</span>
          <input type="range" id="audeq-pre" min="${PRE_MIN}" max="${PRE_MAX}" step="0.5" value="0">
        </label>
        <label class="audeq-check"><input type="checkbox" id="audeq-limiter" checked> Limiteur anti-saturation</label>
        <button type="button" class="btn-secondary audeq-bypass" id="audeq-bypass" aria-pressed="false"><i data-lucide="power"></i> Bypass (son original)</button>
        <button type="button" class="btn-secondary" id="audeq-zero"><i data-lucide="rotate-ccw"></i> Réinitialiser</button>
      </div>
    </div>

    <div class="audeq-panel audeq-export">
      <label class="audeq-field">Format d'export
        <select id="audeq-format">
          <option value="wav" selected>WAV (PCM 16 bits — natif, rapide)</option>
          <option value="mp3">MP3 (FFmpeg.wasm)</option>
        </select>
      </label>
      <label class="audeq-field" id="audeq-kbps-wrap" hidden>Débit
        <select id="audeq-kbps">
          <option value="128">128 kbit/s</option>
          <option value="192" selected>192 kbit/s</option>
          <option value="256">256 kbit/s</option>
          <option value="320">320 kbit/s</option>
        </select>
      </label>
    </div>
  </div>

  <div>
    <div class="audeq-bar" id="audeq-bar"><i></i></div>
    <p class="audeq-status status-muted" id="audeq-status">Déposez un fichier audio pour commencer.</p>
  </div>

  <div class="audeq-actions">
    <button class="btn-primary" id="audeq-export" type="button" disabled><i data-lucide="download"></i> Exporter</button>
    <button class="btn-secondary" id="audeq-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="audeq-result" id="audeq-result" hidden>
    <audio class="audeq-audio" id="audeq-audio" controls preload="metadata"></audio>
    <a class="btn-primary audeq-link" id="audeq-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, ac: null, graph: null, file: null, buffer: null,
    src: null, playing: false, offset: 0, startedAt: 0, raf: 0, seeking: false,
    objectUrl: null, abort: null, busy: false, loading: 0,
    settings: { gains: PRESETS.flat.gains.slice(), pre: 0, limiter: true, bypass: false },
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

  // Transport
  q('play').addEventListener('click', () => { if (s.playing) pause(); else play(); }, opt);
  const seek = q('seek');
  seek.addEventListener('pointerdown', () => { s.seeking = true; }, opt);
  seek.addEventListener('input', () => {
    if (!s.buffer) return;
    const t = (Number(seek.value) / 1000) * s.buffer.duration;
    q('time').textContent = `${fmtTime(t)} / ${fmtTime(s.buffer.duration)}`;
  }, opt);
  seek.addEventListener('change', () => {
    s.seeking = false;
    if (!s.buffer) return;
    const t = (Number(seek.value) / 1000) * s.buffer.duration;
    if (s.playing) play(t); else { s.offset = t; updateTransport(); }
  }, opt);

  // Bandes (double-clic = remise à 0 dB)
  BANDS.forEach((_, i) => {
    const el = q('band-' + i);
    el.addEventListener('input', () => {
      s.settings.gains[i] = Number(el.value);
      q('bval-' + i).textContent = fmtDb(s.settings.gains[i]);
      renderPresetChips(); onSettingsChanged();
    }, opt);
    el.addEventListener('dblclick', () => {
      s.settings.gains[i] = 0;
      el.value = '0'; q('bval-' + i).textContent = fmtDb(0);
      renderPresetChips(); onSettingsChanged();
    }, opt);
  });

  // Presets
  s.root.querySelectorAll('.audeq-chip').forEach((chip) => {
    chip.addEventListener('click', () => applyPreset(chip.dataset.preset), opt);
  });

  // Préampli / limiteur / bypass / reset des réglages
  q('pre').addEventListener('input', () => { s.settings.pre = Number(q('pre').value); renderPre(); onSettingsChanged(); }, opt);
  q('limiter').addEventListener('change', () => { s.settings.limiter = q('limiter').checked; onSettingsChanged(); }, opt);
  q('bypass').addEventListener('click', () => {
    s.settings.bypass = !s.settings.bypass;
    renderToggles(); liveParams(); // bypass = comparaison d'écoute, n'invalide pas l'export
  }, opt);
  q('zero').addEventListener('click', () => {
    s.settings.gains = PRESETS.flat.gains.slice();
    s.settings.pre = 0; s.settings.limiter = true; s.settings.bypass = false;
    renderGains(); renderPre(); renderToggles(); renderPresetChips(); onSettingsChanged();
  }, opt);

  // Export : changement d'options = résultat périmé
  q('format').addEventListener('change', () => { syncOptions(); clearResult(); }, opt);
  q('kbps').addEventListener('change', clearResult, opt);

  // Export / annulation / reset
  q('export').addEventListener('click', exportAudio, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez un fichier audio pour commencer.');
  }, opt);

  renderGains(); renderPre(); renderToggles(); renderPresetChips();
  syncOptions();
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide un décodage en cours
  s.abort?.abort();            // stoppe export / chargement FFmpeg (terminate Worker)
  stopPlayback();              // arrête la source + rAF
  clearResult();               // pause <audio> + URL.revokeObjectURL
  closeAC();                   // ferme l'AudioContext
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
