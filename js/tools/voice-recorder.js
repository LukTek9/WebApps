/**
 * voice-recorder.js — Outil « Enregistreur Vocal » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Micro : getUserMedia (erreurs explicites), sélecteur de périphérique si plusieurs entrées audio.
 *  2. Enregistrement : MediaRecorder (WebM/OGG natif) ; Enregistrer / Pause / Reprendre / Arrêter + chrono.
 *  3. Visualiseur temps réel : AudioContext → AnalyserNode → Canvas (forme d'onde) + vumètre.
 *  4. Arrêt : décodage → WAV PCM 16 bits (aperçu fiable + export WAV + source MP3).
 *  5. Export : WAV natif, WebM/OGG natif (sans conversion) ou MP3 via FFmpeg.wasm (chargé à la demande, Worker).
 *  6. Nettoyage (reset / unmount) : MediaStreamTrack.stop(), AudioContext.close(), cancelAnimationFrame,
 *     MediaRecorder détaché, URL.revokeObjectURL, FFmpeg terminé, écouteurs retirés.
 */

/* ---------- Constantes ---------- */
const FFT_SIZE = 2048;          // taille de fenêtre de l'AnalyserNode
const TIMESLICE_MS = 1000;      // fragmentation du MediaRecorder
const REVOKE_DELAY_MS = 2000;   // délai avant révocation de l'objectURL après clic de téléchargement
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
const LBL_REC = '● Enregistrer';
const LBL_PAUSE = '⏸ Pause';
const LBL_RESUME = '▶ Reprendre';
const LBL_STOP = '■ Arrêter';

/* FFmpeg.wasm : cœur MONO-thread (pas de SharedArrayBuffer / COOP-COEP requis), chargé uniquement pour l'export MP3.
   Worker et cœur passés en blob: URL (Worker cross-origin direct bloqué). Mêmes versions que audio-trimmer. */
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
const q = (id) => s?.root.querySelector('#vrec-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'enregistrement';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const yieldUi = () => new Promise((r) => setTimeout(r));

/** ms → « m:ss.d ». */
function fmtClock(ms) {
  const t = Math.floor(Math.max(0, ms) / 100);
  const tenths = t % 10;
  const sec = Math.floor(t / 10) % 60;
  const min = Math.floor(t / 600);
  return `${min}:${String(sec).padStart(2, '0')}.${tenths}`;
}

function extFromMime(m) {
  if (/ogg/i.test(m)) return 'ogg';
  if (/webm/i.test(m)) return 'webm';
  if (/mp4|aac/i.test(m)) return 'm4a';
  return 'webm';
}

function pickMime() {
  const MR = window.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((m) => MR.isTypeSupported(m)) || '';
}

/** Erreur getUserMedia → message clair en français. */
function micErrorMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Accès au micro refusé. Autorisez le micro pour ce site (icône à gauche de la barre d\'adresse ou paramètres du navigateur), puis réessayez.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Aucun microphone détecté. Branchez un micro puis réessayez.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Micro inaccessible : il est peut-être utilisé par une autre application. Fermez-la puis réessayez.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Le micro sélectionné n\'est plus disponible. Choisissez un autre périphérique.';
    case 'SecurityError':
      return 'Accès au micro bloqué par le navigateur (contexte non sécurisé ou politique de permissions).';
    case 'AbortError':
      return 'Accès au micro interrompu. Réessayez.';
    default:
      return `Impossible d'accéder au micro${e?.message ? ' : ' + e.message : '.'}`;
  }
}

/* ==========================================================================
   UI : statut / progression / contrôles
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

function readyMessage() {
  return s.supported
    ? 'Prêt. Cliquez sur « Enregistrer » (l\'accès au micro sera demandé).'
    : s.unsupportedMsg;
}

/** Synchronise boutons / sélecteurs / panneau résultat avec l'état courant. */
function updateControls() {
  if (!s) return;
  const st = s.state;
  const live = st === 'recording' || st === 'paused';
  s.root.querySelector('#vrec-root').dataset.state = st;
  q('rec').disabled = st !== 'idle' || !s.supported || s.busy;
  q('pause').disabled = !live;
  q('pause').textContent = st === 'paused' ? LBL_RESUME : LBL_PAUSE;
  q('stop').disabled = !live;
  q('reset').disabled = !(live || st === 'stopped') || s.busy;
  q('device').disabled = st !== 'idle';
  q('enable').disabled = st !== 'idle' || !s.supported;
  q('enable').hidden = s.permitted;
  q('result').hidden = st !== 'stopped';
}

function setState(st) {
  if (!s) return;
  s.state = st;
  updateControls();
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.root.querySelectorAll('.vrec-panel select').forEach((el) => { el.disabled = busy; });
  q('export').disabled = busy;
  q('cancel').hidden = !busy;
  updateControls();
}

/* ==========================================================================
   Résultat / objectURL (lien de téléchargement)
   ========================================================================== */
function releaseUrl() {
  if (!s) return;
  clearTimeout(s.revokeTimer);
  if (s.objectUrl) { URL.revokeObjectURL(s.objectUrl); s.objectUrl = null; }
}

function clearResult() {
  releaseUrl();
  const box = q('download'); if (!box) return;
  box.hidden = true;
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download');
  link.onclick = null; link.textContent = '';
}

function showBlobLink(blob, name) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  link.onclick = () => {
    // Révocation après démarrage du téléchargement → mémoire libérée
    s.revokeTimer = setTimeout(() => {
      clearResult();
      setProgress(false);
      setStatus('Téléchargement lancé — mémoire libérée. Relancez l\'export pour régénérer le fichier.');
    }, REVOKE_DELAY_MS);
  };
  q('download').hidden = false;
  setProgress(1);
  setStatus('Prêt : cliquez sur le lien pour enregistrer le fichier.', 'ok');
}

function releasePreview() {
  const a = q('audio');
  if (a) { a.pause(); a.removeAttribute('src'); try { a.load(); } catch { /* ignoré */ } }
  if (s?.previewUrl) { URL.revokeObjectURL(s.previewUrl); s.previewUrl = null; }
}

/* ==========================================================================
   Micro : flux, périphériques
   ========================================================================== */
function releaseStream() {
  if (!s?.stream) return;
  for (const t of s.stream.getTracks()) {
    t.onended = null;
    try { t.stop(); } catch { /* déjà arrêtée */ }
  }
  s.stream = null;
}

/** Ouvre le flux micro (périphérique choisi ou par défaut). Rejette avec l'erreur native de getUserMedia. */
async function acquireStream() {
  if (s.stream?.active) return s.stream;
  const st = s;
  const audio = s.deviceId ? { deviceId: { exact: s.deviceId } } : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  if (s !== st) { stream.getTracks().forEach((t) => t.stop()); throw abortErr(); } // unmount pendant la demande
  s.stream = stream;
  s.permitted = true;
  const track = stream.getAudioTracks()[0];
  if (track) track.onended = () => onTrackEnded(stream);
  return stream;
}

/** Micro débranché / flux coupé pendant l'enregistrement → arrêt propre en conservant l'audio capturé. */
function onTrackEnded(stream) {
  if (!s || s.stream !== stream) return;
  if (s.state === 'recording' || s.state === 'paused') {
    stopRecording();
    setStatus('Micro déconnecté : enregistrement arrêté (audio déjà capturé conservé).', 'error');
  } else {
    releaseStream();
  }
}

/** Remplit le sélecteur (visible si ≥ 2 entrées audio, après autorisation). */
async function refreshDevices() {
  const st = s;
  if (!st || !navigator.mediaDevices?.enumerateDevices) return;
  let list;
  try {
    list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
  } catch { return; }
  if (s !== st) return;
  const sel = q('device');
  sel.replaceChildren();
  list.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone ${i + 1}`;
    sel.appendChild(o);
  });
  const current = s.stream?.getAudioTracks()[0]?.getSettings?.().deviceId;
  const want = [s.deviceId, current].find((id) => id && list.some((d) => d.deviceId === id));
  if (want) sel.value = want;
  else if (s.deviceId) s.deviceId = ''; // périphérique disparu → retour au défaut
  q('device-wrap').hidden = !(s.permitted && list.length > 1);
}

/** Bouton « Activer le micro » : demande l'autorisation, liste les périphériques, libère aussitôt le flux. */
async function enableMic() {
  if (!s || s.state !== 'idle') return;
  const st = s;
  setStatus('Demande d\'accès au micro…');
  try {
    await acquireStream();
    await refreshDevices();
    if (s === st) { releaseStream(); updateControls(); setStatus('Micro autorisé. Prêt à enregistrer.', 'ok'); }
  } catch (e) {
    if (s !== st || isAbort(e)) return;
    releaseStream();
    setStatus(micErrorMessage(e), 'error');
  }
}

/* ==========================================================================
   Visualiseur : AudioContext → AnalyserNode → Canvas
   ========================================================================== */
function setupAnalyser(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // enregistrement possible sans visualiseur
    s.ac = new AC();
    s.ac.resume?.();
    s.src = s.ac.createMediaStreamSource(stream);
    s.an = s.ac.createAnalyser();
    s.an.fftSize = FFT_SIZE;
    s.src.connect(s.an); // volontairement NON relié à la sortie → aucun retour sonore
    s.data = new Uint8Array(s.an.fftSize);
  } catch {
    teardownGraph(); // visualiseur indisponible, l'enregistrement continue
  }
}

function teardownGraph() {
  if (!s) return;
  try { s.src?.disconnect(); s.an?.disconnect(); } catch { /* déjà déconnectés */ }
  const ac = s.ac;
  s.src = null; s.an = null; s.ac = null; s.data = null;
  if (ac && ac.state !== 'closed') ac.close().catch(() => { /* déjà fermé */ });
}

function layout() {
  const sc = q('scope'), c = q('canvas');
  if (!sc || !c) return;
  const w = Math.floor(sc.clientWidth), h = Math.floor(sc.clientHeight);
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  s.view = { w, h, dpr };
  const css = getComputedStyle(s.root);
  const col = (n) => css.getPropertyValue(n).trim() || 'currentColor';
  s.col = {
    bg: col('--color-surface-alt'), line: col('--color-border'),
    accent: col('--cat-audio'), muted: col('--color-text-muted'),
  };
}

/** live=false → ligne de base seule ; live=true → forme d'onde du dernier échantillon analysé. */
function draw(live) {
  if (!s?.view || !s.col) return;
  const { w, h, dpr } = s.view;
  const g = q('canvas').getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = s.col.bg; g.fillRect(0, 0, w, h);
  g.fillStyle = s.col.line; g.fillRect(0, h / 2 - 0.5, w, 1);
  if (!live || !s.data) return;
  const d = s.data, n = d.length, mid = h / 2, amp = h / 2 - 4;
  g.strokeStyle = s.state === 'paused' ? s.col.muted : s.col.accent;
  g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const v = (d[Math.floor((x * n) / w)] - 128) / 128;
    const y = mid + v * amp;
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

function elapsedMs() {
  if (!s) return 0;
  return s.accum + (s.state === 'recording' ? performance.now() - s.t0 : 0);
}

/** Une image : analyse, dessin, vumètre, chrono. */
function frame() {
  if (!s) return;
  let live = false;
  if (s.an && s.data) {
    s.an.getByteTimeDomainData(s.data);
    let sum = 0;
    for (let i = 0; i < s.data.length; i++) { const v = (s.data[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / s.data.length);
    const lvl = clamp(Math.sqrt(rms) * 1.6, 0, 1);
    const meter = q('meter');
    meter.firstElementChild.style.width = Math.round(lvl * 100) + '%';
    meter.classList.toggle('is-hot', lvl > 0.92);
    live = true;
  }
  draw(live);
  const t = fmtClock(elapsedMs());
  const out = q('time');
  if (out.textContent !== t) out.textContent = t;
}

function startLoop() {
  stopLoop();
  const f = () => { if (!s) return; s.raf = requestAnimationFrame(f); frame(); };
  s.raf = requestAnimationFrame(f);
}

function stopLoop() {
  if (!s) return;
  cancelAnimationFrame(s.raf);
  s.raf = 0;
}

/* ==========================================================================
   Enregistrement : démarrage / pause / arrêt
   ========================================================================== */
async function startRecording() {
  if (!s || s.state !== 'idle' || !s.supported) return;
  const st = s;
  clearResult();
  setStatus('Demande d\'accès au micro…');
  let stream;
  try {
    stream = await acquireStream();
  } catch (e) {
    if (s !== st || isAbort(e)) return;
    if (e?.name === 'OverconstrainedError') { s.deviceId = ''; refreshDevices(); }
    setStatus(micErrorMessage(e), 'error');
    return;
  }
  if (s !== st) return;
  refreshDevices(); // libellés complets disponibles après autorisation
  setupAnalyser(stream);

  const mime = pickMime();
  let rec;
  try {
    rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    releaseStream(); teardownGraph();
    setStatus(`Enregistrement impossible : ${e?.message || 'format audio non pris en charge'}.`, 'error');
    return;
  }
  st.rec = rec;
  st.chunks = [];
  st.mime = rec.mimeType || mime || 'audio/webm';
  rec.ondataavailable = (e) => { if (s === st && e.data && e.data.size) st.chunks.push(e.data); };
  rec.onerror = (e) => {
    if (s !== st) return;
    setStatus(`Erreur d'enregistrement : ${e?.error?.message || 'inconnue'}.`, 'error');
    stopRecording();
  };
  rec.onstop = () => { finalize(st); };

  try { rec.start(TIMESLICE_MS); }
  catch (e) {
    st.rec = null; releaseStream(); teardownGraph();
    setStatus(`Démarrage impossible : ${e?.message || 'erreur inconnue'}.`, 'error');
    return;
  }
  st.accum = 0; st.t0 = performance.now();
  setProgress(false);
  setState('recording');
  setStatus('Enregistrement en cours…');
  startLoop();
}

function togglePause() {
  if (!s?.rec) return;
  if (s.state === 'recording') {
    try { s.rec.pause(); } catch { return; }
    s.accum += performance.now() - s.t0;
    setState('paused');
    setStatus('En pause.');
  } else if (s.state === 'paused') {
    try { s.rec.resume(); } catch { return; }
    s.t0 = performance.now();
    setState('recording');
    setStatus('Enregistrement en cours…');
  }
}

function stopRecording() {
  if (!s || (s.state !== 'recording' && s.state !== 'paused')) return;
  const st = s;
  if (st.state === 'recording') st.accum += performance.now() - st.t0;
  setState('processing');
  setStatus('Finalisation…');
  try { st.rec.stop(); } catch { finalize(st); } // recorder déjà inactif → finalise directement
}

/** Décode le blob natif → AudioBuffer → WAV PCM 16 bits. */
async function decodeToWav(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('AudioContext non pris en charge');
  const ac = new AC();
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    if (!(buf.duration > 0)) throw new Error('durée nulle');
    return await encodeWav(buf, new AbortController().signal);
  } finally {
    ac.close().catch(() => { /* déjà fermé */ });
  }
}

/** Fin d'enregistrement : libère micro + graphe, assemble le blob, prépare l'aperçu. */
async function finalize(st) {
  if (s !== st) return;
  stopLoop(); teardownGraph(); releaseStream();
  draw(false);
  const meter = q('meter');
  meter.firstElementChild.style.width = '0'; meter.classList.remove('is-hot');
  const chunks = st.chunks; st.chunks = []; st.rec = null;
  if (!chunks.length) {
    setState('idle');
    setStatus('Enregistrement vide : aucun son capturé.', 'error');
    return;
  }
  st.nativeBlob = new Blob(chunks, { type: st.mime });
  q('time').textContent = fmtClock(st.accum);
  setProgress(null);
  setStatus('Traitement de l\'enregistrement…');

  let wav = null;
  try { wav = await decodeToWav(st.nativeBlob); } catch { wav = null; }
  if (s !== st || st.state !== 'processing') return; // unmount / reset entre-temps

  st.wav = wav;
  const ext = extFromMime(st.mime);
  const optNative = q('format').querySelector('option[value="native"]');
  optNative.textContent = `${ext.toUpperCase()} natif (sans conversion)`;
  q('format').querySelector('option[value="wav"]').disabled = !wav;
  q('format').querySelector('option[value="mp3"]').disabled = !wav;
  q('format').value = wav ? 'wav' : 'native';
  q('kbps-wrap').hidden = q('format').value !== 'mp3';

  st.previewUrl = URL.createObjectURL(wav || st.nativeBlob);
  q('audio').src = st.previewUrl;
  q('info').textContent = [fmtClock(st.accum), wav ? `WAV ${fmtMB(wav.size)}` : '', `${ext.toUpperCase()} ${fmtMB(st.nativeBlob.size)}`]
    .filter(Boolean).join(' · ');
  setProgress(false);
  setState('stopped');
  setStatus(wav
    ? 'Enregistrement terminé. Écoutez l\'aperçu puis exportez.'
    : 'Enregistrement terminé (conversion WAV/MP3 indisponible sur ce navigateur : export natif uniquement).', wav ? 'ok' : undefined);
}

/** Arrêt brutal de tout (reset / unmount) : aucun finalize, tout est libéré. */
function hardStop() {
  if (!s) return;
  s.abort?.abort(); s.abort = null;
  const rec = s.rec; s.rec = null;
  if (rec) {
    rec.ondataavailable = null; rec.onstop = null; rec.onerror = null;
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* déjà arrêté */ }
  }
  s.chunks = [];
  stopLoop(); teardownGraph(); releaseStream();
  clearResult(); releasePreview();
}

function resetAll() {
  if (!s || s.busy) return;
  hardStop();
  s.nativeBlob = null; s.wav = null; s.accum = 0;
  q('time').textContent = fmtClock(0);
  const meter = q('meter');
  meter.firstElementChild.style.width = '0'; meter.classList.remove('is-hot');
  q('info').textContent = '';
  setProgress(false);
  setState('idle');
  draw(false);
  setStatus(readyMessage());
}

/* ==========================================================================
   Export : WAV PCM, natif, MP3 via FFmpeg.wasm (lazy)
   ========================================================================== */
/** AudioBuffer → WAV PCM 16 bits (cède la main régulièrement, annulable). */
async function encodeWav(buf, signal, onProgress) {
  const rate = buf.sampleRate, ch = buf.numberOfChannels, n = buf.length;
  const bytes = n * ch * 2;
  if (bytes > 0xFFFFFFFF - 36) throw new Error('enregistrement trop long pour un fichier WAV (> 4 Go)');
  let dv;
  try { dv = new DataView(new ArrayBuffer(44 + bytes)); }
  catch { throw new Error('mémoire insuffisante pour cet enregistrement'); }
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
    if (i % 262144 === 0) {
      if (signal.aborted) throw abortErr();
      onProgress?.(i / n);
      await yieldUi();
    }
  }
  return new Blob([dv], { type: 'audio/wav' });
}

function wasmSupported() {
  try {
    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') return false;
    return new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)) instanceof WebAssembly.Module;
  } catch { return false; }
}

let ffmpegLibPromise = null;
/** Injecte le script UMD de FFmpeg une seule fois (1re demande d'export MP3). */
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

/** WAV → MP3 (libmp3lame) dans un Worker. Progression : 0.02–0.35 chargement, 0.35–1 encodage. */
async function encodeMp3(wav, kbps, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly non pris en charge');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  let ffmpeg = null, onAbort = null, lastLog = '';
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(0.02 + p * 0.33); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

    ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => { lastLog = message; });
    onAbort = () => { try { ffmpeg.terminate(); } catch { /* déjà fermé */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL: workerURL });
    if (signal.aborted) throw abortErr();

    await ffmpeg.writeFile('in.wav', new Uint8Array(await wav.arrayBuffer()));
    ffmpeg.on('progress', ({ progress }) => setProgress(0.35 + 0.65 * clamp(Number(progress) || 0, 0, 1)));
    setStatus(`Encodage MP3 ${kbps} kbit/s (FFmpeg)…`); setProgress(0.35);
    const code = await ffmpeg.exec(['-i', 'in.wav', '-vn', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, 'out.mp3']);
    if (code !== 0) throw new Error(`FFmpeg code ${code}${lastLog ? ' — ' + lastLog : ''}`);
    return new Blob([await ffmpeg.readFile('out.mp3')], { type: 'audio/mpeg' });
  } catch (e) {
    if (signal.aborted) throw abortErr();
    throw e;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (ffmpeg) {
      if (!signal.aborted) for (const f of ['in.wav', 'out.mp3']) { try { await ffmpeg.deleteFile(f); } catch { /* absent */ } }
      try { ffmpeg.terminate(); } catch { /* déjà fermé */ } // ferme Worker + libère la mémoire wasm
    }
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function exportAudio() {
  if (!s || s.state !== 'stopped' || s.busy) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = q('format').value;
  const kbps = Number(q('kbps').value) || 192;
  setBusy(true); setProgress(null);

  try {
    let blob, ext;
    if (fmt === 'native') {
      blob = st.nativeBlob; ext = extFromMime(st.mime);
    } else {
      if (!st.wav) throw new Error('Conversion indisponible : choisissez le format natif.');
      if (fmt === 'wav') { blob = st.wav; ext = 'wav'; }
      else {
        try { blob = await encodeMp3(st.wav, kbps, signal); }
        catch (e) {
          if (isAbort(e)) throw e;
          throw new Error(`Export MP3 impossible (${e.message}). WAV et format natif restent disponibles (sans FFmpeg).`);
        }
        ext = 'mp3';
      }
    }
    if (s !== st) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    showBlobLink(blob, `${sanitize('enregistrement_' + stamp)}.${ext}`);
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
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vrec" id="vrec-root" data-state="idle">
  <div class="vrec-device">
    <label class="vrec-field" id="vrec-device-wrap" hidden>Microphone
      <select id="vrec-device" aria-label="Périphérique d'entrée audio"></select>
    </label>
    <button class="btn-secondary" id="vrec-enable" type="button"><i data-lucide="mic"></i> Activer le micro</button>
  </div>

  <div class="vrec-stage">
    <div class="vrec-scope" id="vrec-scope">
      <canvas class="vrec-canvas" id="vrec-canvas" role="img" aria-label="Forme d'onde du microphone en temps réel"></canvas>
    </div>
    <div class="vrec-meter" id="vrec-meter" aria-hidden="true"><i></i></div>
    <div class="vrec-timer">
      <span class="vrec-dot" id="vrec-dot" aria-hidden="true"></span>
      <output id="vrec-time" aria-live="off">0:00.0</output>
    </div>
  </div>

  <div class="vrec-controls">
    <button class="btn-primary" id="vrec-rec" type="button">${LBL_REC}</button>
    <button class="btn-secondary" id="vrec-pause" type="button" disabled>${LBL_PAUSE}</button>
    <button class="btn-secondary" id="vrec-stop" type="button" disabled>${LBL_STOP}</button>
    <button class="btn-remove-file" id="vrec-reset" type="button" disabled><i data-lucide="x"></i> Réinitialiser</button>
  </div>

  <div>
    <div class="vrec-bar" id="vrec-bar"><i></i></div>
    <p class="vrec-status status-muted" id="vrec-status" role="status"></p>
  </div>

  <div class="vrec-result" id="vrec-result" hidden>
    <audio class="vrec-audio" id="vrec-audio" controls preload="metadata"></audio>
    <small class="vrec-meta" id="vrec-info"></small>
    <div class="vrec-panel">
      <label class="vrec-field">Format d'export
        <select id="vrec-format">
          <option value="wav">WAV (PCM 16 bits — natif, rapide)</option>
          <option value="native">WEBM/OGG natif (sans conversion)</option>
          <option value="mp3">MP3 (FFmpeg.wasm — chargé à la demande)</option>
        </select>
      </label>
      <label class="vrec-field" id="vrec-kbps-wrap" hidden>Débit MP3
        <select id="vrec-kbps">
          <option value="128">128 kbit/s</option>
          <option value="192" selected>192 kbit/s</option>
          <option value="256">256 kbit/s</option>
          <option value="320">320 kbit/s</option>
        </select>
      </label>
    </div>
    <div class="vrec-actions">
      <button class="btn-primary" id="vrec-export" type="button"><i data-lucide="download"></i> Exporter</button>
      <button class="btn-secondary" id="vrec-cancel" type="button" hidden>Annuler</button>
    </div>
    <div class="vrec-download" id="vrec-download" hidden><a class="btn-primary" id="vrec-link"></a></div>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  let unsupportedMsg = '';
  if (!window.isSecureContext) unsupportedMsg = 'Micro indisponible : la page doit être servie en HTTPS (ou localhost).';
  else if (!navigator.mediaDevices?.getUserMedia) unsupportedMsg = 'Micro indisponible : API getUserMedia non prise en charge par ce navigateur.';
  else if (!window.MediaRecorder) unsupportedMsg = 'Enregistrement indisponible : MediaRecorder non pris en charge par ce navigateur.';

  s = {
    root: container, ctx,
    supported: !unsupportedMsg, unsupportedMsg,
    state: 'idle',            // idle | recording | paused | processing | stopped
    busy: false, permitted: false, deviceId: '',
    stream: null, ac: null, src: null, an: null, data: null,
    rec: null, chunks: [], mime: '', accum: 0, t0: 0,
    raf: 0, view: null, col: null, ro: null,
    nativeBlob: null, wav: null, previewUrl: null,
    objectUrl: null, revokeTimer: null, abort: null,
    perm: null, onDeviceChange: null,
    listeners: new AbortController(),
  };
  const st = s;
  const opt = { signal: s.listeners.signal };

  // Contrôles
  q('rec').addEventListener('click', startRecording, opt);
  q('pause').addEventListener('click', togglePause, opt);
  q('stop').addEventListener('click', stopRecording, opt);
  q('reset').addEventListener('click', resetAll, opt);
  q('enable').addEventListener('click', enableMic, opt);
  q('device').addEventListener('change', () => { if (s.state === 'idle') { s.deviceId = q('device').value; releaseStream(); } }, opt);

  // Export
  q('format').addEventListener('change', () => { q('kbps-wrap').hidden = q('format').value !== 'mp3'; clearResult(); }, opt);
  q('kbps').addEventListener('change', clearResult, opt);
  q('export').addEventListener('click', exportAudio, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);

  // Canvas responsive
  if (typeof ResizeObserver === 'function') {
    s.ro = new ResizeObserver(() => { layout(); draw(Boolean(s.an)); });
    s.ro.observe(q('scope'));
  } else {
    window.addEventListener('resize', () => { layout(); draw(Boolean(s.an)); }, opt);
  }

  // Hot-plug des micros
  if (navigator.mediaDevices?.addEventListener) {
    s.onDeviceChange = () => { if (s?.permitted) refreshDevices(); };
    navigator.mediaDevices.addEventListener('devicechange', s.onDeviceChange);
  }

  // Permission déjà accordée / refusée ? (API facultative)
  try {
    navigator.permissions?.query({ name: 'microphone' }).then((p) => {
      if (s !== st) return;
      st.perm = p;
      const apply = () => {
        if (s !== st) return;
        if (p.state === 'granted') { st.permitted = true; refreshDevices(); updateControls(); }
        else if (p.state === 'denied' && st.state === 'idle') setStatus(micErrorMessage({ name: 'NotAllowedError' }), 'error');
      };
      p.onchange = apply;
      apply();
    }).catch(() => { /* API absente pour « microphone » */ });
  } catch { /* ignoré */ }

  layout(); draw(false);
  updateControls();
  setStatus(readyMessage(), s.supported ? undefined : 'error');
  icons();
}

export function unmount() {
  if (!s) return;
  hardStop();                               // MediaRecorder, rAF, AudioContext, tracks, objectURLs, FFmpeg (abort)
  if (s.perm) s.perm.onchange = null;
  if (s.onDeviceChange) navigator.mediaDevices?.removeEventListener?.('devicechange', s.onDeviceChange);
  s.ro?.disconnect();
  s.listeners.abort();                      // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
