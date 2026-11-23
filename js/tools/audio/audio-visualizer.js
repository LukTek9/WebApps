/**
 * audio-visualizer.js — Outil « Visualiseur de spectre audio » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Entrée : fichier audio (glisser-déposer, lecture/pause/seek via <audio> + MediaElementSource)
 *     OU micro en direct (getUserMedia → MediaStreamSource, jamais renvoyé vers les haut-parleurs).
 *  2. Graphe : source → AnalyserNode → (haut-parleurs en mode fichier) + MediaStreamDestination (audio de la vidéo).
 *  3. Rendu Canvas (requestAnimationFrame) : barres, oscilloscope, circulaire, miroir ; palettes, lissage FFT, sensibilité.
 *  4. Export : capture PNG instantanée ; vidéo WebM (canvas.captureStream + MediaRecorder, piste audio incluse).
 *  5. Nettoyage (reset / changement de source / unmount) : MediaStreamTrack.stop(), AudioContext.close(),
 *     cancelAnimationFrame, MediaRecorder détaché, ResizeObserver déconnecté, URL.revokeObjectURL, plein écran quitté.
 */

/* ---------- Constantes ---------- */
const FFT_SIZE = 2048;
const MAX_FREQ_HZ = 16000;       // plage utile affichée
const REVOKE_DELAY_MS = 2000;    // délai avant révocation de l'objectURL après clic de téléchargement
const VIDEO_BPS = 5_000_000;
const FILE_RE = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|weba|mp4)$/i;
/* Ordre : Chromium / Firefox (WebM) d'abord, puis Safari (MP4 H.264 + AAC) en repli */
const VIDEO_MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
const LBL_PLAY = '▶ Lecture';
const LBL_PAUSE = '⏸ Pause';
const LBL_REC = '● Enregistrer la vidéo';
const LBL_REC_STOP = '■ Arrêter l\'enregistrement';

const STYLES = [
  { id: 'bars', label: 'Barres de fréquences' },
  { id: 'wave', label: 'Oscilloscope (forme d\'onde)' },
  { id: 'radial', label: 'Spectre circulaire' },
  { id: 'mirror', label: 'Barres miroir' },
];
const PALETTES = [
  { id: 'theme', label: 'Thème audio' },
  { id: 'grad', label: 'Dégradé thème → primaire' },
  { id: 'primary', label: 'Couleur primaire' },
  { id: 'success', label: 'Succès' },
  { id: 'text', label: 'Texte' },
  { id: 'rainbow', label: 'Arc-en-ciel' },
];

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (id) => s?.root.querySelector('#audvis-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'visualiseur';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

/** secondes → « m:ss ». */
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const t = Math.floor(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** Erreur getUserMedia → message clair en français. */
function micErrorMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Accès au micro refusé. Autorisez le micro pour ce site (icône à gauche de la barre d\'adresse), puis réessayez.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Aucun microphone détecté. Branchez un micro puis réessayez.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Micro inaccessible : il est peut-être utilisé par une autre application. Fermez-la puis réessayez.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Le micro demandé n\'est pas disponible. Essayez un autre périphérique.';
    case 'SecurityError':
      return 'Accès au micro bloqué par le navigateur (contexte non sécurisé ou politique de permissions).';
    case 'AbortError':
      return 'Accès au micro interrompu. Réessayez.';
    default:
      return `Impossible d'accéder au micro${e?.message ? ' : ' + e.message : '.'}`;
  }
}

/** kind : 'error' | 'ok' | undefined (neutre) — classes partagées .status-*. */
function setStatus(msg, kind) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', kind === 'error');
  el.classList.toggle('status-success', kind === 'ok');
  el.classList.toggle('status-muted', !kind);
}

function readyMessage() {
  if (s.mode === 'mic') return s.micSupported ? 'Cliquez sur « Activer le micro » (l\'accès sera demandé).' : s.micMsg;
  return 'Glissez un fichier audio (MP3, WAV, OGG, M4A, AAC, FLAC, WEBM) ou cliquez pour parcourir.';
}

/* ==========================================================================
   Contrôles / état de l'interface
   ========================================================================== */
function updateControls() {
  if (!s) return;
  const fileMode = s.mode === 'file';
  const has = Boolean(s.an);
  const recording = s.vrec?.state === 'recording';
  q('root').dataset.mode = s.mode;
  q('root').dataset.rec = recording ? 'on' : 'off';
  for (const m of ['file', 'mic']) {
    const t = q('tab-' + m);
    t.classList.toggle('is-active', s.mode === m);
    t.setAttribute('aria-pressed', String(s.mode === m));
  }
  q('pane-file').hidden = !fileMode;
  q('drop').hidden = !fileMode || Boolean(s.audio);
  q('player').hidden = !fileMode || !s.audio;
  q('pane-mic').hidden = fileMode;
  q('mic-start').hidden = Boolean(s.stream);
  q('mic-start').disabled = !s.micSupported || s.micBusy;
  q('mic-stop').hidden = !s.stream;
  q('play').disabled = !s.audio;
  q('snap').disabled = !has;
  q('vrec').disabled = !recording && !(has && s.recSupported);
  q('vrec').textContent = recording ? LBL_REC_STOP : LBL_REC;
  q('vrec').title = s.recSupported ? '' : 'Enregistrement vidéo non pris en charge par ce navigateur';
  q('rectime').hidden = !recording;
  q('fs').hidden = !s.fsSupported;
}

/* ==========================================================================
   Téléchargements / objectURL
   ========================================================================== */
function releaseUrl() {
  if (!s) return;
  clearTimeout(s.revokeTimer);
  if (s.videoUrl) { URL.revokeObjectURL(s.videoUrl); s.videoUrl = null; }
}

function clearResult() {
  releaseUrl();
  const box = q('download'); if (!box) return;
  box.hidden = true;
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download');
  link.onclick = null; link.textContent = '';
}

function showVideoLink(blob, name) {
  releaseUrl();
  s.videoUrl = URL.createObjectURL(blob);
  const link = q('link');
  link.href = s.videoUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  link.onclick = () => {
    // Révocation après démarrage du téléchargement → mémoire libérée
    s.revokeTimer = setTimeout(() => {
      clearResult();
      setStatus('Téléchargement lancé — mémoire libérée. Réenregistrez pour régénérer la vidéo.');
    }, REVOKE_DELAY_MS);
  };
  q('download').hidden = false;
  setStatus('Vidéo prête : cliquez sur le lien pour l\'enregistrer.', 'ok');
}

/** Téléchargement immédiat (PNG) : objectURL révoqué juste après le clic. */
function saveBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  s.urls.add(u);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { URL.revokeObjectURL(u); s?.urls.delete(u); }, REVOKE_DELAY_MS);
}

/* ==========================================================================
   Canvas : mise en page, couleurs, palette
   ========================================================================== */
function readColors() {
  const css = getComputedStyle(s.root);
  const col = (n) => css.getPropertyValue(n).trim() || 'currentColor';
  s.col = {
    bg: col('--color-surface-alt'), line: col('--color-border'),
    accent: col('--cat-audio'), primary: col('--color-primary'),
    success: col('--color-success'), text: col('--color-text'),
  };
}

/** Peinture courante : couleur unie ou dégradé horizontal construit depuis les tokens du thème. */
function buildPaint() {
  if (!s?.view || !s.col || !s.g) return;
  const c = s.col;
  const solid = { theme: c.accent, primary: c.primary, success: c.success, text: c.text }[s.palette];
  if (solid) { s.paint = solid; return; }
  const stops = s.palette === 'grad'
    ? [c.accent, c.primary]
    : Array.from({ length: 7 }, (_, i) => `hsl(${Math.round((i * 300) / 6)} 85% 55%)`);
  try {
    const gr = s.g.createLinearGradient(0, 0, s.view.w, 0);
    stops.forEach((st, i) => gr.addColorStop(i / (stops.length - 1), st));
    s.paint = gr;
  } catch { s.paint = c.accent; }
}

function layout() {
  const sc = q('scope'), c = q('canvas');
  if (!sc || !c) return;
  if (s.vrec?.state === 'recording' && s.view) return; // taille figée pendant la capture vidéo
  const w = Math.floor(sc.clientWidth), h = Math.floor(sc.clientHeight);
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  s.view = { w, h, dpr };
  s.g = c.getContext('2d');
  readColors();
  buildPaint();
  draw();
}

/* ==========================================================================
   Rendu
   ========================================================================== */
/** n bandes (échelle quadratique, 0..1) depuis le spectre FFT, sensibilité appliquée. */
function bands(n) {
  const fd = s.fd, bins = fd.length;
  const nyq = s.ac.sampleRate / 2;
  const maxBin = Math.max(4, Math.min(bins, Math.floor(bins * Math.min(1, MAX_FREQ_HZ / nyq))));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = 1 + Math.floor(Math.pow(i / n, 2) * (maxBin - 1));
    const b = Math.max(a + 1, 1 + Math.floor(Math.pow((i + 1) / n, 2) * (maxBin - 1)));
    let sum = 0;
    for (let k = a; k < b && k < bins; k++) sum += fd[k];
    out[i] = clamp((sum / (b - a) / 255) * s.sens, 0, 1);
  }
  return out;
}

function bar(g, x, y, w, h, r) {
  if (h <= 0) return;
  if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); g.fill(); }
  else g.fillRect(x, y, w, h);
}

function drawBars(g, w, h) {
  const n = clamp(Math.floor(w / 12), 24, 96), step = w / n, bw = step * 0.72;
  const v = bands(n);
  for (let i = 0; i < n; i++) {
    const bh = Math.max(2, v[i] * (h - 12));
    bar(g, i * step + (step - bw) / 2, h - 4 - bh, bw, bh, bw / 2);
  }
}

function drawMirror(g, w, h) {
  const n = clamp(Math.floor(w / 14), 16, 64), step = w / 2 / n, bw = step * 0.72, mid = h / 2;
  const v = bands(n);
  for (let i = 0; i < n; i++) {
    const half = Math.max(1.5, v[i] * (mid - 6));
    const off = (step - bw) / 2;
    bar(g, w / 2 + i * step + off, mid - half, bw, half * 2, bw / 2);
    bar(g, w / 2 - (i + 1) * step + off, mid - half, bw, half * 2, bw / 2);
  }
}

function drawRadial(g, w, h) {
  const half = 48, v = bands(half);
  const cx = w / 2, cy = h / 2, m = Math.min(w, h);
  const r0 = m * 0.2, rMax = m * 0.46;
  g.strokeStyle = s.col.line; g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, r0 - 5, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = s.paint;
  g.lineWidth = Math.max(2, (Math.PI * 2 * r0 * 0.6) / (half * 2));
  g.lineCap = 'round';
  g.beginPath();
  for (let k = 0; k < half; k++) {
    const len = 2 + v[k] * (rMax - r0 - 2);
    const a = ((k + 0.5) / half) * Math.PI;
    for (const ang of [-Math.PI / 2 + a, -Math.PI / 2 - a]) {
      const cs = Math.cos(ang), sn = Math.sin(ang);
      g.moveTo(cx + cs * r0, cy + sn * r0);
      g.lineTo(cx + cs * (r0 + len), cy + sn * (r0 + len));
    }
  }
  g.stroke();
}

function drawWave(g, w, h) {
  s.an.getByteTimeDomainData(s.td);
  const n = s.td.length, mid = h / 2, amp = mid - 6;
  g.strokeStyle = s.paint; g.lineWidth = 2.5; g.lineJoin = 'round';
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const v = clamp(((s.td[Math.floor((x * n) / w)] - 128) / 128) * s.sens, -1, 1);
    const y = mid + v * amp;
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

function draw() {
  if (!s?.view || !s.col || !s.g) return;
  const { w, h, dpr } = s.view;
  const g = s.g;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = s.col.bg; g.fillRect(0, 0, w, h);
  g.fillStyle = s.col.line; g.fillRect(0, h / 2 - 0.5, w, 1);
  if (!s.an) return;
  g.fillStyle = s.paint;
  if (s.style === 'wave') { drawWave(g, w, h); return; }
  s.an.getByteFrequencyData(s.fd);
  if (s.style === 'radial') drawRadial(g, w, h);
  else if (s.style === 'mirror') drawMirror(g, w, h);
  else drawBars(g, w, h);
}

function frame() {
  if (!s) return;
  draw();
  const a = s.audio;
  if (a) {
    if (!s.seeking && Number.isFinite(a.duration) && a.duration > 0) q('seek').value = String(Math.round((a.currentTime / a.duration) * 1000));
    const t = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}`;
    const out = q('time');
    if (out.textContent !== t) out.textContent = t;
  }
  if (s.vrec?.state === 'recording') {
    const t = `● ${fmtTime((performance.now() - s.recT0) / 1000)}`;
    const out = q('rectime');
    if (out.textContent !== t) out.textContent = t;
  }
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
   Graphe audio
   ========================================================================== */
/** Crée AudioContext + AnalyserNode + destination d'enregistrement ; `connect(ac, an)` branche la source. */
function buildGraph(connect) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('AudioContext non pris en charge par ce navigateur.');
  const ac = new AC();
  try {
    const an = ac.createAnalyser();
    an.fftSize = FFT_SIZE;
    an.smoothingTimeConstant = s.smoothing / 100;
    const dest = ac.createMediaStreamDestination();
    s.ac = ac; s.an = an; s.dest = dest;
    s.fd = new Uint8Array(an.frequencyBinCount);
    s.td = new Uint8Array(an.fftSize);
    connect(ac, an, dest);
  } catch (e) {
    s.ac = s.an = s.dest = s.src = null; s.fd = s.td = null;
    ac.close().catch(() => { /* déjà fermé */ });
    throw e;
  }
  startLoop();
}

function releaseStream() {
  if (!s?.stream) return;
  for (const t of s.stream.getTracks()) {
    t.onended = null;
    try { t.stop(); } catch { /* déjà arrêtée */ }
  }
  s.stream = null;
}

/** Libère la source courante (fichier ou micro) et tout le graphe audio. La vidéo en cours est finalisée, pas perdue. */
function teardownSource() {
  if (!s) return;
  s.srcAc?.abort(); s.srcAc = null;
  stopVideo();
  stopLoop();
  try { s.src?.disconnect(); s.an?.disconnect(); s.dest?.disconnect(); } catch { /* déjà déconnectés */ }
  const ac = s.ac;
  s.src = null; s.an = null; s.dest = null; s.ac = null; s.fd = null; s.td = null;
  if (ac && ac.state !== 'closed') ac.close().catch(() => { /* déjà fermé */ });
  const a = s.audio;
  s.audio = null;
  if (a) { a.pause(); a.removeAttribute('src'); try { a.load(); } catch { /* ignoré */ } }
  if (s.fileUrl) { URL.revokeObjectURL(s.fileUrl); s.fileUrl = null; }
  s.file = null; s.seeking = false;
  releaseStream();
  const seek = q('seek'); if (seek) seek.value = '0';
  const time = q('time'); if (time) time.textContent = `0:00 / 0:00`;
  const play = q('play'); if (play) play.textContent = LBL_PLAY;
  draw();
}

/* ==========================================================================
   Entrée 1 : fichier audio
   ========================================================================== */
function loadFile(file) {
  if (!s || !file) return;
  if (!(file.type.startsWith('audio/') || FILE_RE.test(file.name))) {
    setStatus('Format non pris en charge. Formats acceptés : MP3, WAV, OGG, M4A, AAC, FLAC, WEBM.', 'error');
    return;
  }
  const st = s;
  teardownSource();
  st.mode = 'file';
  clearResult();

  const audio = new Audio();
  audio.preload = 'auto';
  st.srcAc = new AbortController();
  const opt = { signal: st.srcAc.signal };
  st.audio = audio; st.file = file;
  st.fileUrl = URL.createObjectURL(file);

  try {
    buildGraph((ac, an, dest) => {
      st.src = ac.createMediaElementSource(audio);
      st.src.connect(an);
      an.connect(ac.destination);   // écoute du fichier
      an.connect(dest);             // piste audio de la vidéo
    });
  } catch (e) {
    teardownSource(); updateControls();
    setStatus(`Visualiseur indisponible : ${e.message}`, 'error');
    return;
  }

  audio.addEventListener('loadedmetadata', () => {
    if (s !== st || st.audio !== audio) return;
    q('fmeta').textContent = [fmtMB(file.size), fmtTime(audio.duration)].join(' · ');
  }, opt);
  audio.addEventListener('play', () => { if (s === st) q('play').textContent = LBL_PAUSE; }, opt);
  audio.addEventListener('pause', () => { if (s === st) q('play').textContent = LBL_PLAY; }, opt);
  audio.addEventListener('ended', () => {
    if (s !== st) return;
    q('play').textContent = LBL_PLAY;
    stopVideo(); // fin du morceau → vidéo finalisée
  }, opt);
  audio.addEventListener('error', () => {
    if (s !== st || st.audio !== audio) return;
    teardownSource(); updateControls();
    setStatus('Lecture impossible : fichier corrompu ou format non pris en charge par ce navigateur.', 'error');
  }, opt);

  q('fname').textContent = file.name;
  q('fmeta').textContent = fmtMB(file.size);
  audio.src = st.fileUrl;
  updateControls();
  setStatus('Fichier chargé. Lancez la lecture pour animer le spectre.', 'ok');
  icons();
}

async function togglePlay() {
  const a = s?.audio; if (!a) return;
  try {
    await s.ac?.resume();
    if (a.paused) await a.play(); else a.pause();
  } catch (e) {
    if (s) setStatus(`Lecture impossible : ${e?.message || 'erreur inconnue'}`, 'error');
  }
}

/* ==========================================================================
   Entrée 2 : microphone
   ========================================================================== */
async function startMic() {
  if (!s || !s.micSupported || s.micBusy || s.stream) return;
  const st = s;
  teardownSource();
  st.mode = 'mic'; st.micBusy = true; clearResult();
  updateControls();
  setStatus('Demande d\'accès au micro…');
  let stream;
  try {
    // Traitements désactivés : le spectre reflète le signal réel (musique, instrument…)
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    if (s !== st) return;
    st.micBusy = false; updateControls();
    setStatus(micErrorMessage(e), 'error');
    return;
  }
  if (s !== st || st.mode !== 'mic') { stream.getTracks().forEach((t) => t.stop()); if (s === st) st.micBusy = false; return; }
  st.micBusy = false;
  st.stream = stream;
  const track = stream.getAudioTracks()[0];
  if (track) track.onended = () => onTrackEnded(stream);
  try {
    buildGraph((ac, an, dest) => {
      st.src = ac.createMediaStreamSource(stream);
      st.src.connect(an);           // volontairement NON relié à la sortie → aucun larsen
      an.connect(dest);
    });
    st.ac.resume?.();
  } catch (e) {
    teardownSource(); updateControls();
    setStatus(`Visualiseur indisponible : ${e.message}`, 'error');
    return;
  }
  updateControls();
  setStatus('Micro actif : parlez ou jouez de la musique.', 'ok');
}

function onTrackEnded(stream) {
  if (!s || s.stream !== stream) return;
  teardownSource(); updateControls();
  setStatus('Micro déconnecté.', 'error');
}

function stopMic() {
  if (!s) return;
  teardownSource(); updateControls();
  setStatus(readyMessage());
}

function setMode(mode) {
  if (!s || s.mode === mode) return;
  teardownSource();
  s.mode = mode;
  updateControls();
  setStatus(readyMessage(), mode === 'mic' && !s.micSupported ? 'error' : undefined);
}

/* ==========================================================================
   Export : capture PNG, vidéo WebM
   ========================================================================== */
function snapshot() {
  if (!s?.an) return;
  draw();
  q('canvas').toBlob((blob) => {
    if (!s) return;
    if (!blob) { setStatus('Capture impossible : image vide.', 'error'); return; }
    saveBlob(blob, `${sanitize('spectre_' + stamp())}.png`);
    setStatus('Capture PNG téléchargée.', 'ok');
  }, 'image/png');
}

function releaseCapture() {
  if (!s?.cap) return;
  for (const t of s.cap.getTracks()) { try { t.stop(); } catch { /* déjà arrêtée */ } }
  s.cap = null;
}

function startVideo() {
  if (!s?.an || !s.recSupported || s.vrec) return;
  const st = s;
  clearResult();
  let cap, rec;
  try {
    cap = q('canvas').captureStream(30);
    const tracks = [...cap.getVideoTracks(), ...(st.dest ? st.dest.stream.getAudioTracks() : [])];
    const mime = VIDEO_MIMES.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
    rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: VIDEO_BPS } : { videoBitsPerSecond: VIDEO_BPS });
    st.vmime = rec.mimeType || mime || 'video/webm';
  } catch (e) {
    cap?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignoré */ } });
    setStatus(`Enregistrement vidéo impossible : ${e?.message || 'format non pris en charge'}.`, 'error');
    return;
  }
  st.cap = cap; st.vrec = rec; st.chunks = [];
  rec.ondataavailable = (e) => { if (s === st && st.vrec === rec && e.data && e.data.size) st.chunks.push(e.data); };
  rec.onerror = (e) => {
    if (s !== st || st.vrec !== rec) return;
    setStatus(`Erreur d'enregistrement : ${e?.error?.message || 'inconnue'}.`, 'error');
    stopVideo();
  };
  rec.onstop = () => finalizeVideo(st, rec);
  try { rec.start(1000); }
  catch (e) {
    st.vrec = null; releaseCapture();
    setStatus(`Démarrage impossible : ${e?.message || 'erreur inconnue'}.`, 'error');
    return;
  }
  st.recT0 = performance.now();
  q('rectime').textContent = '● 0:00';
  updateControls();
  setStatus('Enregistrement vidéo en cours…');
}

/** Demande l'arrêt ; le résultat est assemblé dans finalizeVideo (onstop). */
function stopVideo() {
  const rec = s?.vrec;
  if (!rec || rec.state === 'inactive') return;
  try { rec.stop(); } catch { finalizeVideo(s, rec); }
}

function finalizeVideo(st, rec) {
  if (s !== st || st.vrec !== rec) return;
  const chunks = st.chunks; st.chunks = []; st.vrec = null;
  releaseCapture();
  updateControls();
  if (!chunks.length) { setStatus('Enregistrement vide : aucune image capturée.', 'error'); return; }
  showVideoLink(new Blob(chunks, { type: st.vmime }), `${sanitize('spectre_' + stamp())}.${/mp4/i.test(st.vmime) ? 'mp4' : 'webm'}`);
}

/** Abandon brutal (reset / unmount) : aucun résultat produit. */
function discardVideo() {
  if (!s) return;
  const rec = s.vrec; s.vrec = null; s.chunks = [];
  if (rec) {
    rec.ondataavailable = null; rec.onstop = null; rec.onerror = null;
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* déjà arrêté */ }
  }
  releaseCapture();
}

/* ==========================================================================
   Plein écran
   ========================================================================== */
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function toggleFullscreen() {
  if (!s) return;
  try {
    if (fsElement()) {
      const p = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      p?.catch?.(() => { /* ignoré */ });
    } else {
      const sc = q('scope');
      const p = (sc.requestFullscreen || sc.webkitRequestFullscreen).call(sc);
      p?.catch?.((e) => setStatus(`Plein écran refusé : ${e?.message || 'erreur inconnue'}`, 'error'));
    }
  } catch (e) {
    setStatus(`Plein écran indisponible : ${e?.message || 'erreur inconnue'}`, 'error');
  }
}

function onFsChange() {
  if (!s) return;
  const on = fsElement() === q('scope');
  const b = q('fs');
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Quitter le plein écran' : 'Plein écran';
  requestAnimationFrame(layout);
}

/* ==========================================================================
   Réinitialisation / arrêt total
   ========================================================================== */
function hardStop() {
  if (!s) return;
  discardVideo();
  teardownSource();
  clearResult();
}

function resetAll() {
  if (!s) return;
  hardStop();
  s.mode = 'file';
  updateControls();
  setStatus(readyMessage());
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const opts = (arr) => arr.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');

const TEMPLATE = `
<div class="audvis" id="audvis-root" data-mode="file" data-rec="off">
  <div class="audvis-tabs" role="group" aria-label="Source audio">
    <button class="audvis-tab is-active" id="audvis-tab-file" type="button" aria-pressed="true"><i data-lucide="file-audio"></i> Fichier audio</button>
    <button class="audvis-tab" id="audvis-tab-mic" type="button" aria-pressed="false"><i data-lucide="mic"></i> Microphone</button>
  </div>

  <div id="audvis-pane-file">
    <div class="audvis-drop" id="audvis-drop" role="button" tabindex="0" aria-label="Choisir ou déposer un fichier audio">
      <i data-lucide="upload" class="icon-xl"></i>
      <strong>Glissez-déposez un fichier audio ici</strong>
      <small>MP3, WAV, OGG, M4A, AAC, FLAC, WEBM — ou cliquez pour parcourir</small>
      <input id="audvis-input" type="file" accept="audio/*,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.flac,.webm,.weba" hidden>
    </div>
    <div class="audvis-player" id="audvis-player" hidden>
      <div class="audvis-head">
        <div class="audvis-file">
          <span class="audvis-name" id="audvis-fname"></span>
          <small class="audvis-meta" id="audvis-fmeta"></small>
        </div>
        <button class="btn-remove-file" id="audvis-remove" type="button"><i data-lucide="x"></i> Retirer</button>
      </div>
      <div class="audvis-transport">
        <button class="btn-primary" id="audvis-play" type="button" disabled>${LBL_PLAY}</button>
        <input class="audvis-seek" id="audvis-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Position de lecture">
        <output class="audvis-time" id="audvis-time">0:00 / 0:00</output>
      </div>
    </div>
  </div>

  <div class="audvis-micbox" id="audvis-pane-mic" hidden>
    <button class="btn-primary" id="audvis-mic-start" type="button"><i data-lucide="mic"></i> Activer le micro</button>
    <button class="btn-secondary" id="audvis-mic-stop" type="button" hidden><i data-lucide="x"></i> Arrêter le micro</button>
    <p class="audvis-note">Le micro n'est jamais renvoyé vers les haut-parleurs (pas de larsen). Aucun son ne quitte votre navigateur.</p>
  </div>

  <div class="audvis-stage">
    <div class="audvis-scope" id="audvis-scope">
      <canvas class="audvis-canvas" id="audvis-canvas" role="img" aria-label="Spectre audio en temps réel"></canvas>
    </div>
  </div>

  <div class="audvis-panel">
    <label class="audvis-field">Style de visualisation
      <select id="audvis-style">${opts(STYLES)}</select>
    </label>
    <label class="audvis-field">Palette de couleurs
      <select id="audvis-palette">${opts(PALETTES)}</select>
    </label>
    <label class="audvis-field"><span>Lissage FFT <span class="audvis-val" id="audvis-smooth-val">80 %</span></span>
      <input id="audvis-smooth" type="range" min="0" max="95" step="1" value="80">
    </label>
    <label class="audvis-field"><span>Sensibilité <span class="audvis-val" id="audvis-sens-val">100 %</span></span>
      <input id="audvis-sens" type="range" min="50" max="300" step="5" value="100">
    </label>
  </div>

  <div class="audvis-actions">
    <button class="btn-secondary" id="audvis-fs" type="button" aria-pressed="false" title="Plein écran"><i data-lucide="maximize"></i> Plein écran</button>
    <button class="btn-secondary" id="audvis-snap" type="button" disabled><i data-lucide="camera"></i> Capture PNG</button>
    <button class="btn-primary" id="audvis-vrec" type="button" disabled>${LBL_REC}</button>
    <output class="audvis-rectime" id="audvis-rectime" hidden>● 0:00</output>
    <button class="btn-remove-file" id="audvis-reset" type="button"><i data-lucide="x"></i> Réinitialiser</button>
  </div>

  <p class="audvis-status status-muted" id="audvis-status" role="status"></p>
  <div class="audvis-download" id="audvis-download" hidden><a class="btn-primary" id="audvis-link"></a></div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  let micMsg = '';
  if (!window.isSecureContext) micMsg = 'Micro indisponible : la page doit être servie en HTTPS (ou localhost).';
  else if (!navigator.mediaDevices?.getUserMedia) micMsg = 'Micro indisponible : API getUserMedia non prise en charge par ce navigateur.';
  else if (!(window.AudioContext || window.webkitAudioContext)) micMsg = 'Micro indisponible : AudioContext non pris en charge par ce navigateur.';

  s = {
    root: container, ctx,
    mode: 'file', style: 'bars', palette: 'theme', smoothing: 80, sens: 1,
    micSupported: !micMsg, micMsg, micBusy: false,
    recSupported: typeof window.MediaRecorder === 'function' && typeof HTMLCanvasElement.prototype.captureStream === 'function',
    fsSupported: Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled),
    ac: null, an: null, src: null, dest: null, fd: null, td: null,
    audio: null, file: null, fileUrl: null, stream: null, srcAc: null, seeking: false,
    raf: 0, view: null, g: null, col: null, paint: null, ro: null,
    vrec: null, cap: null, chunks: [], vmime: 'video/webm', recT0: 0,
    videoUrl: null, revokeTimer: null, urls: new Set(),
    listeners: new AbortController(),
  };
  const st = s;
  const opt = { signal: s.listeners.signal };

  // Source
  q('tab-file').addEventListener('click', () => setMode('file'), opt);
  q('tab-mic').addEventListener('click', () => setMode('mic'), opt);
  q('mic-start').addEventListener('click', startMic, opt);
  q('mic-stop').addEventListener('click', stopMic, opt);

  // Fichier : parcourir + glisser-déposer
  const drop = q('drop'), input = q('input');
  drop.addEventListener('click', () => input.click(), opt);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } }, opt);
  input.addEventListener('click', (e) => e.stopPropagation(), opt);
  input.addEventListener('change', () => { const f = input.files?.[0]; input.value = ''; loadFile(f); }, opt);
  const root = q('root');
  root.addEventListener('dragover', (e) => {
    if (st.mode !== 'file') return;
    e.preventDefault(); root.classList.add('is-over');
  }, opt);
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('is-over'); }, opt);
  root.addEventListener('drop', (e) => {
    root.classList.remove('is-over');
    if (st.mode !== 'file') return;
    e.preventDefault();
    loadFile(e.dataTransfer?.files?.[0]);
  }, opt);
  q('remove').addEventListener('click', () => { teardownSource(); updateControls(); setStatus(readyMessage()); }, opt);

  // Transport
  q('play').addEventListener('click', togglePlay, opt);
  const seek = q('seek');
  seek.addEventListener('pointerdown', () => { st.seeking = true; }, opt);
  seek.addEventListener('pointerup', () => { st.seeking = false; }, opt);
  seek.addEventListener('input', () => {
    const a = st.audio;
    if (a && Number.isFinite(a.duration)) a.currentTime = (Number(seek.value) / 1000) * a.duration;
  }, opt);

  // Réglages visuels
  q('style').addEventListener('change', () => { st.style = q('style').value; draw(); }, opt);
  q('palette').addEventListener('change', () => { st.palette = q('palette').value; buildPaint(); draw(); }, opt);
  q('smooth').addEventListener('input', () => {
    st.smoothing = Number(q('smooth').value);
    q('smooth-val').textContent = st.smoothing + ' %';
    if (st.an) st.an.smoothingTimeConstant = st.smoothing / 100;
  }, opt);
  q('sens').addEventListener('input', () => {
    q('sens-val').textContent = q('sens').value + ' %';
    st.sens = Number(q('sens').value) / 100;
  }, opt);

  // Actions
  q('fs').addEventListener('click', toggleFullscreen, opt);
  q('snap').addEventListener('click', snapshot, opt);
  q('vrec').addEventListener('click', () => { if (st.vrec) stopVideo(); else startVideo(); }, opt);
  q('reset').addEventListener('click', resetAll, opt);
  document.addEventListener('fullscreenchange', onFsChange, opt);
  document.addEventListener('webkitfullscreenchange', onFsChange, opt);

  // Canvas responsive
  if (typeof ResizeObserver === 'function') {
    s.ro = new ResizeObserver(layout);
    s.ro.observe(q('scope'));
  } else {
    window.addEventListener('resize', layout, opt);
  }

  layout();
  updateControls();
  setStatus(readyMessage());
  icons();
}

export function unmount() {
  if (!s) return;
  hardStop();                               // MediaRecorder, rAF, AudioContext, tracks, objectURLs
  try {
    if (fsElement() && s.root.contains(fsElement())) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => { /* ignoré */ });
    }
  } catch { /* ignoré */ }
  s.urls.forEach((u) => URL.revokeObjectURL(u)); s.urls.clear();
  s.ro?.disconnect();
  s.listeners.abort();                      // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
