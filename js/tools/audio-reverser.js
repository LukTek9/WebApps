/**
 * audio-reverser.js — Outil « Inverseur Audio (Reverse) » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier audio (glisser-déposer / sélecteur) → AudioContext.decodeAudioData → AudioBuffer
 *     (durée, fréquence, canaux, taille affichés).
 *  2. Inversion canal par canal des échantillons PCM (Float32Array.reverse) → nouvel AudioBuffer.
 *  3. Aperçu : forme d'onde Canvas de la version inversée (couleurs lues sur les tokens CSS) +
 *     lecteur A/B instantané (Original / Inversé) via AudioBufferSourceNode, position synchronisée entre versions.
 *  4. Export : WAV PCM 16 bits natif (chemin rapide) ou MP3 / OGG via FFmpeg.wasm chargé à la demande
 *     (Worker en blob: URL), progression + annulation. Lien <nom>_reverse.<ext>.
 *  5. AudioContext fermé, source / rAF / ResizeObserver arrêtés, Worker FFmpeg terminé, objectURL révoqué
 *     à chaque nouvel export / reset / unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'];

/** Formats d'export : codec FFmpeg (null = natif), débit applicable. */
const FORMATS = {
  wav: { ext: 'wav', mime: 'audio/wav',  codec: null,         lossy: false },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame', lossy: true },
  ogg: { ext: 'ogg', mime: 'audio/ogg',  codec: 'libvorbis',  lossy: true },
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
const q = (id) => s?.root.querySelector('#audrev-' + id);
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

function fmtTime(t) {
  const sec = Math.max(0, Number(t) || 0);
  return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
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
  s.root.querySelectorAll('.audrev-panel select').forEach((el) => { el.disabled = busy; });
  if (!busy) syncOptions();
  q('export').disabled = busy || !s.rev;
  q('reset').disabled = busy;
  q('cancel').hidden = !busy;
}

/** Débit masqué pour le WAV (sans perte). */
function syncOptions() {
  q('kbps-wrap').hidden = !FORMATS[q('format').value].lossy;
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
   Audio : contexte, inversion
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

/** Nouvel AudioBuffer : chaque canal est copié puis retourné (Float32Array.reverse, natif). */
function reverseBuffer(ac, buf) {
  const out = ac.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    d.set(buf.getChannelData(c));
    d.reverse();
  }
  return out;
}

/* ==========================================================================
   Forme d'onde (Canvas) — couleurs lues sur les tokens CSS
   ========================================================================== */
/** Pics min/max par colonne (tous canaux confondus). */
function computePeaks(buf, cols) {
  const peaks = new Float32Array(cols * 2);
  const len = buf.length, per = len / cols;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const step = Math.max(1, Math.floor(per / 256));
  for (let x = 0; x < cols; x++) {
    const a = Math.floor(x * per), b = Math.min(len, Math.floor((x + 1) * per) || a + 1);
    let mn = 0, mx = 0;
    for (const d of chans) {
      for (let i = a; i < b; i += step) {
        const v = d[i];
        if (v < mn) mn = v; else if (v > mx) mx = v;
      }
    }
    peaks[x * 2] = mn; peaks[x * 2 + 1] = mx;
  }
  return peaks;
}

function drawWave() {
  const cv = q('canvas');
  if (!s?.rev || !cv) return;
  const box = q('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(box.clientWidth * dpr)), h = Math.max(1, Math.floor(box.clientHeight * dpr));
  if (!w || !h) return;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const g = cv.getContext('2d');
  const cs = getComputedStyle(cv);
  const bg = cs.getPropertyValue('--color-surface-alt').trim() || 'transparent';
  const fg = cs.getPropertyValue('--cat-audio').trim() || 'currentColor';
  const mid = cs.getPropertyValue('--color-border').trim() || 'currentColor';

  g.clearRect(0, 0, w, h);
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = mid; g.fillRect(0, Math.floor(h / 2), w, Math.max(1, Math.round(dpr)));
  if (!s.peaks || s.peaks.length !== w * 2) s.peaks = computePeaks(s.rev, w);
  g.fillStyle = fg;
  const half = h / 2;
  for (let x = 0; x < w; x++) {
    const mn = s.peaks[x * 2], mx = s.peaks[x * 2 + 1];
    const y1 = half - mx * half, y2 = half - mn * half;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

/* ==========================================================================
   Lecteur A/B (AudioBufferSourceNode jetable + décalage manuel)
   ========================================================================== */
const curBuf = () => (s.mode === 'rev' ? s.rev : s.buffer);

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
  const dur = s.buffer.duration, pos = position();
  q('time').textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`;
  if (!s.seeking) q('seek').value = String(Math.round((pos / dur) * 1000));
  // Tête de lecture sur la forme d'onde inversée : même contenu sonore dans les deux modes
  const frac = s.mode === 'rev' ? pos / dur : 1 - pos / dur;
  q('playhead').style.left = (clamp(frac, 0, 1) * 100).toFixed(2) + '%';
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

  const buf = curBuf(), dur = buf.duration;
  let off = from ?? s.offset;
  if (off >= dur - 0.01) off = 0;
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(ac.destination);
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

/** Position dans la version courante (secondes) → relance si lecture en cours. */
function seekTo(t) {
  if (!s?.buffer) return;
  t = clamp(t, 0, s.buffer.duration);
  if (s.playing) play(t); else { s.offset = t; updateTransport(); }
}

/** A/B : bascule de version à l'instant équivalent (t ↔ durée − t), sans interruption. */
function setMode(mode) {
  if (!s?.buffer || s.mode === mode) return;
  const dur = s.buffer.duration, mapped = clamp(dur - position(), 0, dur);
  const wasPlaying = s.playing;
  s.mode = mode;
  s.root.querySelectorAll('.audrev-ab-btn').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-active', on);
  });
  if (wasPlaying) play(mapped); else { s.offset = mapped; updateTransport(); }
}

/* ==========================================================================
   Export : WAV natif / MP3 · OGG via FFmpeg.wasm (lazy)
   ========================================================================== */
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

/** WAV inversé → MP3 / OGG. Progression : 0–0.3 chargement FFmpeg, 0.3–1 encodage. */
async function encodeFfmpeg(wavBlob, fmt, kbps, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const inName = 'in.wav', outName = 'out.' + fmt.ext;
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
    setStatus(`Encodage ${fmt.ext.toUpperCase()} (FFmpeg)…`); setProgress(0.3);
    const code = await ffmpeg.exec(['-i', inName, '-vn', '-c:a', fmt.codec, '-b:a', `${kbps}k`, outName]);
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

async function exportAudio() {
  if (!s?.rev || s.busy) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value];
  const kbps = Number(q('kbps').value) || 192;
  setBusy(true); setProgress(0);

  try {
    setStatus('Encodage WAV PCM 16 bits…');
    let blob = await encodeWav(st.rev, signal, (p) => setProgress(fmt.codec ? p * 0.2 : p));
    if (fmt.codec) {
      try { blob = await encodeFfmpeg(blob, fmt, kbps, signal); }
      catch (e) {
        if (isAbort(e)) throw e;
        throw new Error(`Export ${fmt.ext.toUpperCase()} impossible (${e.message}). L'export WAV reste disponible.`);
      }
    }
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_reverse';
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
/** Libère tout l'état (lecture, export, résultat, buffers, AudioContext) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  stopPlayback();
  clearResult();
  closeAC();
  s.file = null; s.buffer = null; s.rev = null; s.peaks = null; s.mode = 'rev';
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  setPlayUi(false);
  setBusy(false);
  setProgress(false);
}

function showMeta(file, buf) {
  q('name').textContent = file.name;
  q('meta').textContent = extOf(file.name).toUpperCase() || (file.type || 'audio');
  q('st-dur').textContent = fmtDuration(buf.duration);
  q('st-rate').textContent = `${buf.sampleRate} Hz`;
  q('st-ch').textContent = buf.numberOfChannels > 1 ? `${buf.numberOfChannels} (${buf.numberOfChannels === 2 ? 'stéréo' : 'multi'})` : 'mono';
  q('st-size').textContent = fmtMB(file.size);
  q('seek').value = '0';
  q('time').textContent = `0:00 / ${fmtTime(buf.duration)}`;
  q('playhead').style.left = '0%';
  s.root.querySelectorAll('.audrev-ab-btn').forEach((b) => {
    const on = b.dataset.mode === 'rev';
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-active', on);
  });
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

  setStatus('Inversion des échantillons…');
  await yieldUi();
  if (!s || s.loading !== token) return;
  let rev;
  try { rev = reverseBuffer(ensureAC(), buf); }
  catch (e) {
    setProgress(false);
    setStatus(`Inversion impossible : ${e.message || 'mémoire insuffisante'}.`, 'error');
    return;
  }

  s.file = file; s.buffer = buf; s.rev = rev; s.peaks = null; s.mode = 'rev'; s.offset = 0;
  q('drop').hidden = true;
  q('editor').hidden = false;
  showMeta(file, buf);
  syncOptions();
  q('export').disabled = false;
  setProgress(false);
  drawWave(); // après affichage de l'éditeur (dimensions du canvas connues)
  setStatus('Audio inversé. Comparez les versions (A/B) puis exportez.');
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="audrev" id="audrev-root">
  <div class="audrev-drop" id="audrev-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier audio">
    <i data-lucide="rewind" class="icon-xl"></i>
    <strong>Glissez un fichier audio ici</strong>
    <small>ou cliquez pour parcourir — MP3, WAV, OGG, M4A, AAC, FLAC, WEBM</small>
    <input type="file" id="audrev-file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm" hidden>
  </div>

  <div class="audrev-editor" id="audrev-editor" hidden>
    <div class="audrev-head">
      <div class="audrev-file"><b class="audrev-name" id="audrev-name"></b><small class="audrev-meta" id="audrev-meta"></small></div>
      <button class="btn-remove-file" id="audrev-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <div class="audrev-info">
      <div class="audrev-stat"><small>Durée</small><b id="audrev-st-dur">—</b></div>
      <div class="audrev-stat"><small>Fréquence</small><b id="audrev-st-rate">—</b></div>
      <div class="audrev-stat"><small>Canaux</small><b id="audrev-st-ch">—</b></div>
      <div class="audrev-stat"><small>Taille</small><b id="audrev-st-size">—</b></div>
    </div>

    <div class="audrev-wave" id="audrev-wave" title="Cliquez pour vous déplacer">
      <canvas class="audrev-canvas" id="audrev-canvas" role="img" aria-label="Forme d'onde de l'audio inversé"></canvas>
      <div class="audrev-playhead" id="audrev-playhead"></div>
    </div>

    <div class="audrev-player">
      <div class="audrev-ab" role="group" aria-label="Version à écouter (A/B)">
        <button type="button" class="audrev-ab-btn" data-mode="orig" aria-pressed="false">A · Original</button>
        <button type="button" class="audrev-ab-btn is-active" data-mode="rev" aria-pressed="true">B · Inversé</button>
      </div>
      <button class="btn-primary" id="audrev-play" type="button"><i data-lucide="play"></i> Lecture</button>
      <input type="range" class="audrev-seek" id="audrev-seek" min="0" max="1000" step="1" value="0" aria-label="Position de lecture">
      <span class="audrev-time" id="audrev-time">0:00 / 0:00</span>
    </div>

    <div class="audrev-panel">
      <label class="audrev-field">Format d'export
        <select id="audrev-format">
          <option value="wav" selected>WAV (PCM 16 bits — natif, rapide)</option>
          <option value="mp3">MP3 (FFmpeg.wasm)</option>
          <option value="ogg">OGG Vorbis (FFmpeg.wasm)</option>
        </select>
      </label>
      <label class="audrev-field" id="audrev-kbps-wrap" hidden>Débit
        <select id="audrev-kbps">
          <option value="128">128 kbit/s</option>
          <option value="192" selected>192 kbit/s</option>
          <option value="256">256 kbit/s</option>
          <option value="320">320 kbit/s</option>
        </select>
      </label>
    </div>
  </div>

  <div>
    <div class="audrev-bar" id="audrev-bar"><i></i></div>
    <p class="audrev-status status-muted" id="audrev-status">Déposez un fichier audio pour commencer.</p>
  </div>

  <div class="audrev-actions">
    <button class="btn-primary" id="audrev-export" type="button" disabled><i data-lucide="download"></i> Exporter</button>
    <button class="btn-secondary" id="audrev-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="audrev-result" id="audrev-result" hidden>
    <audio class="audrev-audio" id="audrev-audio" controls preload="metadata"></audio>
    <a class="btn-primary audrev-link" id="audrev-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, ac: null, file: null, buffer: null, rev: null, peaks: null, mode: 'rev',
    src: null, playing: false, offset: 0, startedAt: 0, raf: 0, seeking: false,
    objectUrl: null, abort: null, busy: false, loading: 0, ro: null,
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

  // Transport + A/B
  q('play').addEventListener('click', () => { if (s.playing) pause(); else play(); }, opt);
  s.root.querySelectorAll('.audrev-ab-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode), opt));
  const seek = q('seek');
  seek.addEventListener('pointerdown', () => { s.seeking = true; }, opt);
  seek.addEventListener('input', () => {
    if (!s.buffer) return;
    q('time').textContent = `${fmtTime((Number(seek.value) / 1000) * s.buffer.duration)} / ${fmtTime(s.buffer.duration)}`;
  }, opt);
  seek.addEventListener('change', () => {
    s.seeking = false;
    if (s.buffer) seekTo((Number(seek.value) / 1000) * s.buffer.duration);
  }, opt);
  // Clic sur la forme d'onde (inversée) : fraction → position dans la version courante
  q('wave').addEventListener('click', (e) => {
    if (!s.buffer) return;
    const r = q('wave').getBoundingClientRect();
    const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
    seekTo((s.mode === 'rev' ? frac : 1 - frac) * s.buffer.duration);
  }, opt);

  // Redessin de la forme d'onde au redimensionnement
  if (typeof ResizeObserver === 'function') {
    s.ro = new ResizeObserver(() => { if (s?.rev) drawWave(); });
    s.ro.observe(q('wave'));
  }

  // Options : tout changement invalide le résultat précédent
  q('format').addEventListener('change', () => { syncOptions(); clearResult(); }, opt);
  q('kbps').addEventListener('change', clearResult, opt);

  // Export / annulation / reset
  q('export').addEventListener('click', exportAudio, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez un fichier audio pour commencer.');
  }, opt);

  syncOptions();
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide un décodage en cours
  s.abort?.abort();            // stoppe export / chargement FFmpeg (terminate Worker)
  stopPlayback();              // arrête la source + rAF
  s.ro?.disconnect(); s.ro = null;
  clearResult();               // pause <audio> + URL.revokeObjectURL
  closeAC();                   // ferme l'AudioContext
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
