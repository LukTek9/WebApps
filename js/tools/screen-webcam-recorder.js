/**
 * screen-webcam-recorder.js — Outil « Enregistreur Écran & Webcam » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Mode : Écran seul (getDisplayMedia), Webcam seule (getUserMedia) ou Écran + Webcam en incrustation (PiP) :
 *     composition temps réel sur un <canvas> hors écran (coin au choix, webcam arrondie ou ronde) → captureStream.
 *  2. Audio : micro (getUserMedia) et/ou audio système / onglet (si fourni par le navigateur), mixés via AudioContext.
 *     Qualité : Native / 1080p / 720p ; compte à rebours 3 s optionnel ; aperçu en direct.
 *  3. MediaRecorder (WEBM natif) : Démarrer / Pause-Reprendre / Arrêter + chrono temps réel.
 *  4. Résultat : lecture <video controls>, téléchargement natif immédiat capture_<horodatage>.webm
 *     ou conversion MP4 via FFmpeg.wasm chargé à la demande (Worker blob:, repli cœur ESM Firefox).
 *  5. Nettoyage (arrêt / reset / unmount) : MediaStreamTrack.stop() sur tous les flux, cancelAnimationFrame,
 *     Worker de cadence terminé, AudioContext fermé, MediaRecorder détaché, URL.revokeObjectURL, FFmpeg terminé.
 */

/* ---------- Constantes ---------- */
const TIMESLICE_MS = 500;           // chunks émis en continu pendant l'enregistrement (pas seulement au stop)
const FLUSH_MS = 250;               // attente après rec.stop() avant d'arrêter les pistes : dernier flush ondataavailable
const DATA_WATCHDOG_MS = 2500;      // aucun chunk reçu après ce délai → repli sur le MediaRecorder par défaut du navigateur
const COUNTDOWN_S = 3;
const STOP_FALLBACK_MS = 1500;    // filet de sécurité : finalize() garanti même si l'événement « stop » ne vient jamais (Firefox)
const FIX_DURATION_TIMEOUT_MS = 1000; // correction de durée WebM : jamais bloquante
const PIP_MIN_INTERVAL_MS = 20;   // évite un double dessin rAF + Worker
const PIP_TICK_MS = 33;           // cadence de repli quand l'onglet est masqué (rAF suspendu)
const LOAD_TIMEOUT_MS = 90000;    // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie
const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
/* Flux sans piste audio : pas de codec opus dans le type MIME (Firefox ne émet aucune donnée sinon) */
const MIME_VIDEO_ONLY = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
const QUALITY = { native: null, '1080': { w: 1920, h: 1080 }, '720': { w: 1280, h: 720 } };
const BITRATE = { native: 8_000_000, '1080': 8_000_000, '720': 4_000_000 };
const LBL_PAUSE = '⏸ Pause';
const LBL_RESUME = '▶ Reprendre';
const LBL_STOP = '■ Arrêter';

/* FFmpeg.wasm : mêmes versions / schéma de chargement que video-converter (chargé uniquement pour l'export MP4). */
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
const q = (id) => s?.root.querySelector('#scrrec-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

/** ms → « m:ss.d ». */
function fmtClock(ms) {
  const t = Math.floor(Math.max(0, ms) / 100);
  return `${Math.floor(t / 600)}:${String(Math.floor(t / 10) % 60).padStart(2, '0')}.${t % 10}`;
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

function pickMime(hasAudio = true) {
  const MR = window.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  return (hasAudio ? MIME_CANDIDATES : MIME_VIDEO_ONLY).find((m) => MR.isTypeSupported(m)) || '';
}

const extFromMime = (m) => (/mp4/i.test(m) ? 'mp4' : 'webm');

/** Erreur getDisplayMedia / getUserMedia → message clair en français selon la source (screen | cam | mic). */
function mediaErrorMessage(e, what) {
  const label = { screen: 'au partage d\'écran', cam: 'à la webcam', mic: 'au micro' }[what] || 'au périphérique';
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      if (what === 'screen') return 'Partage d\'écran refusé ou annulé. Relancez, puis choisissez un écran, une fenêtre ou un onglet à partager.';
      return `Accès ${label} refusé. Autorisez-le pour ce site (icône à gauche de la barre d'adresse ou paramètres du navigateur)${what === 'mic' ? ', ou décochez « Microphone »' : ''}, puis réessayez.`;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      if (what === 'screen') return 'Aucune source de capture disponible.';
      return what === 'cam' ? 'Aucune webcam détectée. Branchez-en une puis réessayez.' : 'Aucun microphone détecté. Branchez-en un ou décochez « Microphone ».';
    case 'NotReadableError':
    case 'TrackStartError':
      return `Accès ${label} impossible : le périphérique est peut-être utilisé par une autre application. Fermez-la puis réessayez.`;
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'La qualité demandée n\'est pas prise en charge par ce périphérique : choisissez « Native ».';
    case 'SecurityError':
      return 'Capture bloquée par le navigateur (contexte non sécurisé ou politique de permissions).';
    case 'AbortError':
      return 'Capture interrompue. Réessayez.';
    case 'TypeError':
      return 'Paramètres de capture invalides pour ce navigateur : choisissez la qualité « Native ».';
    default:
      return `Impossible d'accéder ${label}${e?.message ? ' : ' + e.message : '.'}`;
  }
}

function videoConstraints(quality) {
  const p = QUALITY[quality];
  const c = { frameRate: { ideal: 30, max: 30 } };
  if (p) { c.width = { ideal: p.w }; c.height = { ideal: p.h }; }
  return c;
}

/** Les WebM de MediaRecorder n'ont pas de durée : force le calcul pour permettre la navigation dans la lecture. */
let fixCancel = null;
function fixDuration(v) {
  fixCancel?.();
  let timer = 0, done = false;
  const restore = () => { try { v.currentTime = 0; } catch { /* ignoré */ } };
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    v.removeEventListener('loadedmetadata', onMeta);
    v.removeEventListener('timeupdate', onTime);
    v.removeEventListener('seeked', onTime);
    v.removeEventListener('error', cleanup);
    if (fixCancel === cleanup) fixCancel = null;
  };
  const onTime = () => { cleanup(); restore(); };
  const onMeta = () => {
    v.removeEventListener('loadedmetadata', onMeta);
    if (v.duration !== Infinity) { cleanup(); return; }
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('seeked', onTime);
    try { v.currentTime = 1e101; } catch { cleanup(); }
  };
  v.addEventListener('loadedmetadata', onMeta);
  v.addEventListener('error', cleanup);
  // Firefox peut ne jamais émettre « seeked » sur une position énorme : abandon forcé et retour à 0
  timer = setTimeout(() => { const wasActive = !done; cleanup(); if (wasActive) restore(); }, FIX_DURATION_TIMEOUT_MS);
  fixCancel = cleanup;
}

/** Vide un élément <video> et libère sa ressource média. */
function resetVideoEl(v) {
  if (!v) return;
  v.pause();
  v.srcObject = null;
  v.removeAttribute('src');
  try { v.load(); } catch { /* ignoré */ }
}

function stopStream(m) {
  if (!m) return;
  for (const t of m.getTracks()) { t.onended = null; try { t.stop(); } catch { /* déjà arrêtée */ } }
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
  if (!s.ready) return s.unsupportedMsg;
  return 'Prêt. Choisissez un mode puis cliquez sur « Démarrer » (les autorisations seront demandées).';
}

/** Synchronise boutons / sélecteurs / panneaux avec l'état courant. */
function updateControls() {
  if (!s) return;
  const st = s.state;
  const idle = st === 'idle';
  const live = st === 'recording' || st === 'paused';
  q('root').dataset.state = st;
  s.root.querySelectorAll('.scrrec-mode').forEach((b) => {
    const on = b.dataset.mode === s.mode;
    b.disabled = !idle || !s.avail[b.dataset.mode];
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  q('quality').disabled = !idle;
  q('mic').disabled = !idle;
  q('sys').disabled = !idle || s.mode === 'webcam';
  q('countdown').disabled = !idle;
  q('pip-opts').hidden = s.mode !== 'pip';
  q('pos').disabled = q('shape').disabled = st === 'processing' || st === 'preparing';
  q('start').disabled = !idle || !s.ready;
  q('pause').disabled = !live;
  q('pause').textContent = st === 'paused' ? LBL_RESUME : LBL_PAUSE;
  q('stop').disabled = !live;
  q('reset').disabled = !(st === 'countdown' || live || st === 'done') || s.busy;
  q('result').hidden = st !== 'done';
  q('stage').classList.toggle('has-preview', st === 'countdown' || live);
}

function setState(st) {
  if (!s) return;
  s.state = st;
  updateControls();
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  q('mp4').disabled = busy;
  q('cancel').hidden = !busy;
  updateControls();
}

/* ==========================================================================
   Résultat / objectURL
   ========================================================================== */
function releaseMp4() {
  if (!s) return;
  if (s.mp4Url) { URL.revokeObjectURL(s.mp4Url); s.mp4Url = null; }
  const link = q('mp4-link'); if (!link) return;
  link.hidden = true;
  link.removeAttribute('href'); link.removeAttribute('download'); link.textContent = '';
}

function releaseResult() {
  if (!s) return;
  fixCancel?.();
  releaseMp4();
  resetVideoEl(q('play'));
  if (s.blobUrl) { URL.revokeObjectURL(s.blobUrl); s.blobUrl = null; }
  s.blob = null;
  const link = q('link');
  if (link) { link.removeAttribute('href'); link.removeAttribute('download'); link.textContent = ''; }
}

/* ==========================================================================
   Composition PiP (canvas hors écran)
   ========================================================================== */
/** Chemin rectangle arrondi (arcTo : compatible tous navigateurs). */
function rrPath(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Dessine une image composée : écran plein cadre + webcam dans le coin choisi (position / forme lues en direct). */
function drawFrame() {
  const p = s?.pip; if (!p) return;
  const now = performance.now();
  if (now - p.last < PIP_MIN_INTERVAL_MS) return;
  p.last = now;
  const { g, cv, sv, wv } = p;
  g.fillStyle = p.bg; g.fillRect(0, 0, cv.width, cv.height);
  if (sv.videoWidth > 0 && sv.readyState >= 2) g.drawImage(sv, 0, 0, cv.width, cv.height);
  if (!(wv.videoWidth > 0 && wv.readyState >= 2)) return;

  const W = cv.width, H = cv.height;
  const circle = s.shape === 'circle';
  const ratio = wv.videoWidth / wv.videoHeight;
  const ow = Math.round(clamp(W * 0.22, 160, W / 2));
  const oh = circle ? ow : Math.round(ow / ratio);
  const m = Math.round(W * 0.02);
  const x = s.pos.endsWith('l') ? m : W - ow - m;
  const y = s.pos.startsWith('t') ? m : H - oh - m;

  g.save();
  if (circle) { g.beginPath(); g.arc(x + ow / 2, y + oh / 2, ow / 2, 0, Math.PI * 2); g.closePath(); }
  else rrPath(g, x, y, ow, oh, ow * 0.08);
  g.clip();
  if (circle) {
    const side = Math.min(wv.videoWidth, wv.videoHeight);
    g.drawImage(wv, (wv.videoWidth - side) / 2, (wv.videoHeight - side) / 2, side, side, x, y, ow, oh);
  } else {
    g.drawImage(wv, x, y, ow, oh);
  }
  g.restore();

  g.lineWidth = Math.max(3, Math.round(W * 0.003));
  g.strokeStyle = p.border;
  if (circle) { g.beginPath(); g.arc(x + ow / 2, y + oh / 2, ow / 2, 0, Math.PI * 2); g.closePath(); }
  else rrPath(g, x, y, ow, oh, ow * 0.08);
  g.stroke();
}

/** Vidéo cachée alimentée par un flux ; résout quand les dimensions sont connues. */
function makeVideo(stream) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.autoplay = true;
  v.srcObject = new MediaStream(stream.getVideoTracks());
  q('offscreen').appendChild(v);
  v.play().catch(() => { /* lecture déclenchée par autoplay */ });
  return new Promise((resolve, reject) => {
    if (v.videoWidth > 0) return resolve(v);
    const t = setTimeout(() => reject(new Error('flux vidéo indisponible')), 8000);
    v.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(v); }, { once: true });
  });
}

/** Pilote de dessin : rAF quand l'onglet est visible, Worker (non suspendu) quand il est masqué. */
function startPipDriver() {
  const p = s.pip;
  const loop = () => { if (!s?.pip) return; p.raf = requestAnimationFrame(loop); drawFrame(); };
  p.raf = requestAnimationFrame(loop);
  try {
    p.workerUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${PIP_TICK_MS});`], { type: 'text/javascript' }));
    p.worker = new Worker(p.workerUrl);
    p.worker.onmessage = () => { if (document.hidden) drawFrame(); };
  } catch { /* Worker bloqué (CSP) : rAF seul */ }
}

function stopPip() {
  const p = s?.pip; if (!p) return;
  cancelAnimationFrame(p.raf);
  try { p.worker?.terminate(); } catch { /* déjà fermé */ }
  if (p.workerUrl) URL.revokeObjectURL(p.workerUrl);
  for (const v of [p.sv, p.wv]) { try { v.pause(); v.srcObject = null; v.remove(); } catch { /* ignoré */ } }
  s.pip = null;
}

/** Prépare le canvas de composition ; renvoie la piste vidéo du captureStream. */
async function setupPip(st) {
  const [sv, wv] = await Promise.all([makeVideo(st.display), makeVideo(st.cam)]);
  if (s !== st) throw abortErr();
  // Dimensions : celles de l'écran capturé, plafonnées par le préréglage de qualité
  const cap = QUALITY[st.cfg.quality];
  let k = 1;
  if (cap) k = Math.min(1, cap.w / Math.max(sv.videoWidth, 1), cap.h / Math.max(sv.videoHeight, 1));
  const cv = document.createElement('canvas');
  cv.width = even(sv.videoWidth * k); cv.height = even(sv.videoHeight * k);
  const css = getComputedStyle(st.root);
  const col = (n) => css.getPropertyValue(n).trim() || 'currentColor';
  st.pip = { cv, g: cv.getContext('2d', { alpha: false }), sv, wv, last: 0, raf: 0, worker: null, workerUrl: null,
    bg: col('--color-text'), border: col('--color-surface') };
  drawFrame();
  startPipDriver();
  st.canvasStream = cv.captureStream(30);
  return st.canvasStream.getVideoTracks()[0];
}

/* ==========================================================================
   Audio : micro + audio système (mixés si les deux)
   ========================================================================== */
/** Première piste audio réellement vivante d'un flux (null sinon). */
const liveAudio = (stream) => stream?.getAudioTracks().find((t) => t.readyState === 'live') || null;

function buildAudio(st) {
  const sys = st.cfg.sys ? liveAudio(st.display) : null;
  const mic = liveAudio(st.mic);
  // Aucune piste audio vivante : null → enregistrement vidéo seule, sans AudioContext ni destination vide (bloque MediaRecorder Firefox)
  if (!sys && !mic) return null;
  if (sys && mic) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try {
        st.ac = new AC();
        st.ac.resume?.();
        const dest = st.ac.createMediaStreamDestination();
        st.ac.createMediaStreamSource(new MediaStream([sys])).connect(dest);
        st.ac.createMediaStreamSource(new MediaStream([mic])).connect(dest);
        st.mixTrack = dest.stream.getAudioTracks()[0];
        return st.mixTrack;
      } catch { teardownAudio(st); }
    }
    return mic; // mixage impossible : micro seul
  }
  return sys || mic || null;
}

function teardownAudio(st) {
  const ac = st.ac; st.ac = null;
  if (ac && ac.state !== 'closed') ac.close().catch(() => { /* déjà fermé */ });
}

/* ==========================================================================
   Capture : acquisition / libération
   ========================================================================== */
function cancelCountdown() {
  const c = s?.cd; if (!c) return;
  clearTimeout(c.timer);
  s.cd = null;
  c.resolve(false);
  const ov = q('cd'); if (ov) ov.hidden = true;
}

/** Arrête TOUS les flux et pilotes de la capture (écran, webcam, micro, canvas, mixage, aperçu, rAF, Worker). */
function releaseCapture() {
  if (!s) return;
  stopPip();
  for (const k of ['display', 'cam', 'mic', 'canvasStream']) { stopStream(s[k]); s[k] = null; }
  if (s.mixTrack) { try { s.mixTrack.stop(); } catch { /* déjà arrêtée */ } s.mixTrack = null; }
  teardownAudio(s);
  s.stream = null;
  resetVideoEl(q('preview'));
}

/** Piste coupée (bouton « Arrêter le partage », webcam / micro débranchés) → arrêt propre en conservant l'acquis. */
function onTrackEnded(label) {
  if (!s) return;
  const st = s.state;
  if (st === 'recording' || st === 'paused') {
    s.endNote = `${label} : enregistrement arrêté (contenu déjà capturé conservé).`;
    stopRecording();
  } else if (st === 'countdown') {
    cancelCountdown(); releaseCapture(); setState('idle');
    setStatus(`${label} avant le démarrage : capture annulée.`, 'error');
  } else if (st === 'preparing') {
    s.endNote = label; // traité par startCapture après l'acquisition
  }
}

/** Ouvre les flux demandés, compose la vidéo, lance le compte à rebours puis l'enregistrement. */
async function startCapture() {
  if (!s || s.state !== 'idle' || !s.ready) return;
  const st = s;
  releaseResult(); setProgress(false);
  st.endNote = '';
  st.cfg = { mode: st.mode, quality: q('quality').value, mic: q('mic').checked, sys: st.mode !== 'webcam' && q('sys').checked, countdown: q('countdown').checked };
  const cfg = st.cfg;
  setState('preparing');
  setStatus('Autorisez la capture dans la fenêtre du navigateur…');

  let what = '';
  try {
    if (cfg.mode !== 'webcam') {
      what = 'screen';
      const dispOpts = { video: videoConstraints(cfg.quality), audio: cfg.sys };
      if (cfg.sys) dispOpts.systemAudio = 'include'; // Chrome / Edge : pré-sélectionne le partage d'audio (ignoré ailleurs)
      const d = await navigator.mediaDevices.getDisplayMedia(dispOpts);
      if (s !== st) { stopStream(d); return; }
      st.display = d;
      const vt = d.getVideoTracks()[0];
      if (vt) vt.onended = () => onTrackEnded('Partage d\'écran terminé');
      if (cfg.quality !== 'native') { try { await vt?.applyConstraints(videoConstraints(cfg.quality)); } catch { /* indicatif */ } }
    }
    if (cfg.mode !== 'screen') {
      what = 'cam';
      const c = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(cfg.quality) });
      if (s !== st) { stopStream(c); return; }
      st.cam = c;
      const vt = c.getVideoTracks()[0];
      if (vt) vt.onended = () => onTrackEnded('Webcam déconnectée');
    }
    if (cfg.mic) {
      what = 'mic';
      const m = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (s !== st) { stopStream(m); return; }
      st.mic = m;
      const at = m.getAudioTracks()[0];
      if (at) at.onended = () => onTrackEnded('Micro déconnecté');
    }
  } catch (e) {
    if (s !== st) return;
    releaseCapture(); setState('idle');
    setStatus(mediaErrorMessage(e, what), 'error');
    return;
  }
  if (s !== st) return;
  if (st.endNote) { // une source s'est arrêtée pendant les autorisations
    const msg = st.endNote; st.endNote = '';
    releaseCapture(); setState('idle'); setStatus(`${msg} avant le démarrage : capture annulée.`, 'error');
    return;
  }

  let vTrack = null;
  try {
    if (cfg.mode === 'pip') vTrack = await setupPip(st);
    else vTrack = (cfg.mode === 'screen' ? st.display : st.cam)?.getVideoTracks()[0] || null;
    if (!vTrack) throw new Error('aucune piste vidéo');
  } catch (e) {
    if (s !== st || isAbort(e)) return;
    releaseCapture(); setState('idle');
    setStatus(`Composition vidéo impossible : ${errMsg(e)}.`, 'error');
    return;
  }
  const aTrack = buildAudio(st);
  st.stream = new MediaStream(aTrack ? [vTrack, aTrack] : [vTrack]);
  st.note = cfg.sys && !st.display?.getAudioTracks().length
    ? (/firefox/i.test(navigator.userAgent)
      ? 'Audio système non capturé : Firefox ne prend pas en charge l\'audio système / d\'onglet. Utilisez Chrome ou Edge.'
      : 'Audio système non capturé : dans la fenêtre du navigateur, choisissez « Onglet » (ou « Écran entier ») puis cochez « Partager l\'audio ». Impossible avec « Fenêtre ».')
    : '';

  // Aperçu en direct (muet : aucun retour sonore)
  const pv = q('preview');
  pv.srcObject = new MediaStream([vTrack]);
  pv.play().catch(() => { /* autoplay */ });

  if (cfg.countdown) {
    setState('countdown');
    const ok = await runCountdown(st);
    if (s !== st || !ok) return;
  }
  beginRecorder(st);
}

/** 3, 2, 1 sur l'aperçu ; renvoie false si annulé (reset, source coupée, unmount). */
async function runCountdown(st) {
  const ov = q('cd');
  ov.hidden = false;
  for (let n = COUNTDOWN_S; n >= 1; n--) {
    ov.textContent = String(n);
    setStatus(`Démarrage dans ${n}…`);
    const ok = await new Promise((resolve) => {
      st.cd = { resolve, timer: setTimeout(() => { st.cd = null; resolve(true); }, 1000) };
    });
    if (!ok || s !== st || st.state !== 'countdown') return false;
  }
  ov.hidden = true;
  return true;
}

/* ==========================================================================
   Enregistrement : démarrage / pause / arrêt / chrono
   ========================================================================== */
function elapsedMs() {
  if (!s) return 0;
  return s.accum + (s.state === 'recording' ? performance.now() - s.t0 : 0);
}

function startClock() {
  stopClock();
  const f = () => {
    if (!s) return;
    s.clockRaf = requestAnimationFrame(f);
    const t = fmtClock(elapsedMs());
    const out = q('time');
    if (out.textContent !== t) out.textContent = t;
  };
  s.clockRaf = requestAnimationFrame(f);
}

function stopClock() {
  if (!s) return;
  cancelAnimationFrame(s.clockRaf);
  s.clockRaf = 0;
}

/** Coupe proprement un recorder (handlers retirés : aucun finalize déclenché). */
function detachRecorder(rec) {
  rec.ondataavailable = null; rec.onstop = null; rec.onerror = null;
  try { if (rec.state !== 'inactive') rec.stop(); } catch { /* déjà arrêté */ }
}

/** Crée + démarre un MediaRecorder. useDefault=true : type MIME / débit laissés au navigateur. Lance en cas d'échec. */
function openRecorder(st, useDefault) {
  let rec, mime = '';
  if (useDefault) {
    rec = new MediaRecorder(st.stream);
  } else {
    mime = pickMime(st.stream.getAudioTracks().length > 0);
    const opts = { videoBitsPerSecond: BITRATE[st.cfg.quality] };
    if (mime) opts.mimeType = mime;
    rec = new MediaRecorder(st.stream, opts);
  }
  st.rec = rec;
  st.mime = rec.mimeType || mime || 'video/webm';
  rec.ondataavailable = (e) => { if (s === st && !st.sealed && e.data && e.data.size) st.chunks.push(e.data); };
  rec.onerror = (e) => {
    if (s !== st) return;
    st.endNote = `Erreur d'enregistrement (${e?.error?.message || 'inconnue'}).`;
    stopRecording();
  };
  rec.onstop = () => { finalize(st); };
  try { rec.start(TIMESLICE_MS); }
  catch (e) { detachRecorder(rec); st.rec = null; throw e; }
  return rec;
}

/** Aucun chunk après DATA_WATCHDOG_MS : relance avec le MediaRecorder par défaut du navigateur (une seule fois). */
function dataWatchdog(st) {
  st.dataTimer = 0;
  if (s !== st || st.sealed || st.usedDefault || st.chunks.length) return;
  if (st.state !== 'recording' && st.state !== 'paused') return;
  const old = st.rec; st.rec = null;
  if (old) detachRecorder(old);
  try {
    st.usedDefault = true;
    const rec = openRecorder(st, true);
    if (st.state === 'paused') { try { rec.pause(); } catch { /* ignoré */ } }
  } catch (e) {
    st.endNote = `Enregistreur indisponible (${e?.message || 'erreur inconnue'}).`;
    stopRecording();
  }
}

function beginRecorder(st) {
  st.chunks = []; st.finalized = false; st.sealed = false; st.usedDefault = false;
  try {
    openRecorder(st, false);
  } catch (e1) {
    // Type MIME / débit refusé : repli immédiat sur le MediaRecorder par défaut
    try {
      st.usedDefault = true;
      openRecorder(st, true);
    } catch (e) {
      st.rec = null; releaseCapture(); setState('idle');
      setStatus(`Enregistrement impossible : ${e?.message || e1?.message || 'format vidéo non pris en charge'}.`, 'error');
      return;
    }
  }
  clearTimeout(st.dataTimer);
  st.dataTimer = setTimeout(() => dataWatchdog(st), DATA_WATCHDOG_MS);
  st.accum = 0; st.t0 = performance.now();
  q('time').textContent = fmtClock(0);
  setState('recording');
  setStatus(st.note ? `Enregistrement en cours… ${st.note}` : 'Enregistrement en cours…');
  startClock();
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
  // Filet de sécurité : finalize() s'exécute quoi qu'il arrive (idempotent)
  clearTimeout(st.dataTimer); st.dataTimer = 0;
  clearTimeout(st.stopTimer);
  st.stopTimer = setTimeout(() => finalize(st), STOP_FALLBACK_MS);
  // Ordre : flush des données, puis stop() du recorder ; les pistes ne sont arrêtées qu'ensuite (dans finalize)
  const rec = st.rec;
  if (rec && rec.state !== 'inactive') {
    try { rec.requestData(); } catch { /* recorder en pause / non supporté */ }
    try { rec.stop(); } catch { finalize(st); }
  } else {
    finalize(st); // recorder déjà inactif (arrêt automatique) : aucune attente
  }
}

/** Fin d'enregistrement : libère tous les flux, assemble le blob, prépare lecture + téléchargement. */
function finalize(st) {
  // Idempotent : « stop » du recorder, filet de 1500 ms et arrêt automatique peuvent tous l'appeler
  if (s !== st || st.finalized) return;
  if (st.state !== 'recording' && st.state !== 'paused' && st.state !== 'processing') return;
  st.finalized = true;
  clearTimeout(st.stopTimer); st.stopTimer = 0;
  if (st.state === 'recording') st.accum += performance.now() - st.t0; // arrêt automatique du recorder
  stopClock();
  clearTimeout(st.dataTimer); st.dataTimer = 0;
  if (st.state !== 'processing') setState('processing');
  const rec = st.rec;
  if (rec && rec.state !== 'inactive') {
    // Recorder encore actif (filet de 1500 ms, arrêt auto) : flush + stop, puis 250 ms avant d'arrêter les pistes
    try { rec.requestData(); } catch { /* non supporté / en pause */ }
    try { rec.stop(); } catch { /* déjà arrêté */ }
    st.flushTimer = setTimeout(() => completeFinalize(st), FLUSH_MS);
  } else {
    completeFinalize(st); // « stop » déjà reçu : le dernier chunk est livré (dataavailable précède stop)
  }
}

/** Assemble le résultat après le dernier flush ; arrête ensuite seulement les pistes. */
function completeFinalize(st) {
  clearTimeout(st.flushTimer); st.flushTimer = 0;
  if (s !== st || st.state !== 'processing') return; // reset / unmount entre-temps (déjà nettoyé)
  st.sealed = true;
  const rec = st.rec; st.rec = null;
  if (rec) detachRecorder(rec);
  releaseCapture(); // pistes arrêtées seulement après stop() + flush du recorder
  const chunks = st.chunks; st.chunks = [];
  const note = st.endNote; st.endNote = '';
  if (!chunks.length) {
    setProgress(false);
    setState('idle');
    setStatus(`${note ? note + ' ' : ''}Enregistrement vide : le navigateur n'a fourni aucune donnée. Enregistrez au moins une seconde puis réessayez.`, 'error');
    return;
  }
  st.blob = new Blob(chunks, { type: st.mime });
  const ext = extFromMime(st.mime);
  st.baseName = `capture_${stamp()}`;
  st.blobUrl = URL.createObjectURL(st.blob);

  const v = q('play');
  fixDuration(v);
  v.src = st.blobUrl;
  const link = q('link');
  link.href = st.blobUrl;
  link.download = `${st.baseName}.${ext}`;
  link.textContent = `⬇ Télécharger ${st.baseName}.${ext} (${fmtMB(st.blob.size)})`;
  q('info').textContent = `Durée ${fmtClock(st.accum)} · ${ext.toUpperCase()} natif ${fmtMB(st.blob.size)}`;
  q('mp4').hidden = ext === 'mp4'; // Safari enregistre déjà en MP4
  q('mp4').disabled = !wasmSupported();
  setProgress(false);
  q('time').textContent = fmtClock(st.accum);
  setState('done');
  setStatus(`${note ? note + ' ' : ''}Enregistrement terminé. Visionnez puis téléchargez.`, note ? undefined : 'ok');
}

/** Arrêt brutal de tout (reset / unmount) : aucun finalize, tout est libéré. */
function hardStop() {
  if (!s) return;
  s.abort?.abort(); s.abort = null;
  clearTimeout(s.stopTimer); s.stopTimer = 0;
  clearTimeout(s.dataTimer); s.dataTimer = 0;
  clearTimeout(s.flushTimer); s.flushTimer = 0;
  cancelCountdown();
  const rec = s.rec; s.rec = null;
  if (rec) {
    rec.ondataavailable = null; rec.onstop = null; rec.onerror = null;
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* déjà arrêté */ }
  }
  s.chunks = [];
  stopClock();
  releaseCapture();
  releaseResult();
}

function resetAll() {
  if (!s || s.busy) return;
  hardStop();
  s.accum = 0; s.endNote = '';
  q('time').textContent = fmtClock(0);
  q('info').textContent = '';
  setProgress(false);
  setState('idle');
  setStatus(readyMessage());
}

/* ==========================================================================
   Conversion MP4 via FFmpeg.wasm (lazy)
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

/** WEBM → MP4 (H.264 + AAC, 30 fps constants). Progression : 0–0.2 chargement FFmpeg, 0.2–1 transcodage. */
async function transcodeMp4(blob, durationS, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  let ffmpeg = null, onAbort = null;
  const logs = []; // tampon roulant des logs FFmpeg
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
        ffmpeg.on('log', ({ message }) => { logs.push(String(message)); if (logs.length > 25) logs.shift(); });
        await raceLoad(ffmpeg.load({ coreURL: core, wasmURL, classWorkerURL: workerURL }), signal, LOAD_TIMEOUT_MS);
        loaded = true;
        break;
      } catch (e) {
        if (signal.aborted) throw abortErr();
        loadErr = e;
      }
    }
    if (!loaded) throw new Error(`initialisation de FFmpeg impossible : ${errMsg(loadErr)}${tail()}`);

    await ffmpeg.writeFile('in.webm', new Uint8Array(await blob.arrayBuffer()));
    if (signal.aborted) throw abortErr();
    // Le WEBM de MediaRecorder n'a pas de durée : progression calculée sur la durée mesurée de l'enregistrement
    ffmpeg.on('progress', ({ progress, time }) => {
      const byTime = durationS > 0 && Number.isFinite(time) && time > 0 ? time / 1e6 / durationS : NaN;
      const p = clamp(Number.isFinite(byTime) ? byTime : (Number(progress) || 0), 0, 0.99);
      setProgress(0.2 + 0.8 * p);
      setStatus(`Conversion MP4 (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus('Conversion MP4 (FFmpeg)…'); setProgress(0.2);
    const code = await ffmpeg.exec([
      '-i', 'in.webm', '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', 'out.mp4',
    ]);
    if (signal.aborted) throw abortErr();
    if (code !== 0) throw new Error(`FFmpeg code ${code}${tail()}`);
    return new Blob([await ffmpeg.readFile('out.mp4')], { type: 'video/mp4' });
  } catch (e) {
    if (signal.aborted) throw abortErr();
    throw e instanceof Error ? e : new Error(errMsg(e));
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (ffmpeg) {
      if (!signal.aborted) for (const f of ['in.webm', 'out.mp4']) { try { await ffmpeg.deleteFile(f); } catch { /* absent */ } }
      try { ffmpeg.terminate(); } catch { /* déjà fermé */ } // ferme Worker + libère la mémoire wasm
    }
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function convertMp4() {
  if (!s || s.state !== 'done' || s.busy || !s.blob) return;
  const st = s;
  releaseMp4();
  st.abort = new AbortController();
  const { signal } = st.abort;
  setBusy(true); setProgress(0);
  try {
    const out = await transcodeMp4(st.blob, st.accum / 1000, signal);
    if (s !== st) return;
    releaseMp4();
    st.mp4Url = URL.createObjectURL(out);
    const link = q('mp4-link');
    link.href = st.mp4Url;
    link.download = `${st.baseName}.mp4`;
    link.textContent = `⬇ Télécharger ${st.baseName}.mp4 (${fmtMB(out.size)})`;
    link.hidden = false;
    setProgress(1);
    setStatus(`Conversion MP4 terminée : ${fmtMB(out.size)}.`, 'ok');
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Conversion annulée.');
    else setStatus(`Conversion MP4 impossible (${errMsg(e)}). Le téléchargement WEBM natif reste disponible.`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="scrrec" id="scrrec-root" data-state="idle">
  <div class="scrrec-offscreen" id="scrrec-offscreen" aria-hidden="true"></div>

  <div class="scrrec-panel">
    <div class="scrrec-modes" role="group" aria-label="Mode de capture">
      <button class="scrrec-mode" type="button" data-mode="screen" aria-pressed="true"><i data-lucide="monitor"></i> Écran seul</button>
      <button class="scrrec-mode" type="button" data-mode="webcam" aria-pressed="false"><i data-lucide="video"></i> Webcam seule</button>
      <button class="scrrec-mode" type="button" data-mode="pip" aria-pressed="false"><i data-lucide="picture-in-picture-2"></i> Écran + Webcam (PiP)</button>
    </div>

    <div class="scrrec-pip" id="scrrec-pip-opts" hidden>
      <label class="scrrec-field">Position de la webcam
        <select id="scrrec-pos">
          <option value="br" selected>Bas droite</option>
          <option value="bl">Bas gauche</option>
          <option value="tr">Haut droite</option>
          <option value="tl">Haut gauche</option>
        </select>
      </label>
      <label class="scrrec-field">Forme de la webcam
        <select id="scrrec-shape">
          <option value="rounded" selected>Rectangle arrondi</option>
          <option value="circle">Cercle</option>
        </select>
      </label>
      <p class="scrrec-hint">Astuce : partagez un écran ou une fenêtre (pas cet onglet). Si l'onglet est masqué pendant l'enregistrement, la composition continue via un minuteur de secours.</p>
    </div>

    <label class="scrrec-field">Qualité
      <select id="scrrec-quality">
        <option value="native" selected>Native (résolution d'origine)</option>
        <option value="1080">1080p (1920 × 1080 max)</option>
        <option value="720">720p (1280 × 720 max)</option>
      </select>
    </label>

    <div class="scrrec-checks">
      <label class="scrrec-check"><input type="checkbox" id="scrrec-mic"> Microphone</label>
      <label class="scrrec-check" title="Chrome / Edge uniquement : choisissez « Onglet » (ou « Écran entier ») et cochez « Partager l'audio » dans la fenêtre du navigateur. Non pris en charge par Firefox."><input type="checkbox" id="scrrec-sys"> Audio système / onglet (si disponible)</label>
      <label class="scrrec-check"><input type="checkbox" id="scrrec-countdown" checked> Compte à rebours de 3 s</label>
    </div>
    <p class="scrrec-hint">Audio système : Chrome / Edge uniquement. Dans la fenêtre de partage, choisissez « Onglet » (ou « Écran entier ») et cochez « Partager l'audio ». Firefox ne le prend pas en charge.</p>
  </div>

  <div class="scrrec-stage" id="scrrec-stage">
    <div class="scrrec-view">
      <video class="scrrec-preview" id="scrrec-preview" muted autoplay playsinline></video>
      <p class="scrrec-empty">L'aperçu en direct s'affichera ici au démarrage de la capture.</p>
      <div class="scrrec-countdown" id="scrrec-cd" aria-live="assertive" hidden></div>
    </div>
    <div class="scrrec-timer">
      <span class="scrrec-dot" aria-hidden="true"></span>
      <output id="scrrec-time" aria-live="off">0:00.0</output>
    </div>
  </div>

  <div class="scrrec-controls">
    <button class="btn-primary" id="scrrec-start" type="button"><i data-lucide="circle-dot"></i> Démarrer</button>
    <button class="btn-secondary" id="scrrec-pause" type="button" disabled>${LBL_PAUSE}</button>
    <button class="btn-secondary" id="scrrec-stop" type="button" disabled>${LBL_STOP}</button>
    <button class="btn-remove-file" id="scrrec-reset" type="button" disabled><i data-lucide="x"></i> Réinitialiser</button>
  </div>

  <div>
    <div class="scrrec-bar" id="scrrec-bar"><i></i></div>
    <p class="scrrec-status status-muted" id="scrrec-status" role="status"></p>
  </div>

  <div class="scrrec-result" id="scrrec-result" hidden>
    <video class="scrrec-video" id="scrrec-play" controls preload="metadata" playsinline></video>
    <small class="scrrec-info" id="scrrec-info"></small>
    <div class="scrrec-actions">
      <a class="btn-primary scrrec-link" id="scrrec-link"></a>
      <button class="btn-secondary" id="scrrec-mp4" type="button"><i data-lucide="refresh-cw"></i> Convertir en MP4</button>
      <button class="btn-secondary" id="scrrec-cancel" type="button" hidden>Annuler</button>
    </div>
    <div class="scrrec-actions"><a class="btn-primary scrrec-link" id="scrrec-mp4-link" hidden></a></div>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  const md = navigator.mediaDevices;
  const avail = { screen: !!md?.getDisplayMedia, webcam: !!md?.getUserMedia, pip: !!(md?.getDisplayMedia && md?.getUserMedia) };
  let unsupportedMsg = '';
  if (!window.isSecureContext) unsupportedMsg = 'Capture indisponible : la page doit être servie en HTTPS (ou localhost).';
  else if (!window.MediaRecorder) unsupportedMsg = 'Enregistrement indisponible : MediaRecorder non pris en charge par ce navigateur.';
  else if (!avail.screen && !avail.webcam) unsupportedMsg = 'Capture indisponible : getDisplayMedia / getUserMedia non pris en charge par ce navigateur.';
  const ready = !unsupportedMsg;

  s = {
    root: container, ctx, ready, unsupportedMsg, avail,
    state: 'idle',            // idle | preparing | countdown | recording | paused | processing | done
    mode: ['screen', 'webcam', 'pip'].find((m) => avail[m]) || 'screen',
    pos: 'br', shape: 'rounded', cfg: null, busy: false,
    display: null, cam: null, mic: null, canvasStream: null, mixTrack: null, ac: null, stream: null, pip: null,
    rec: null, chunks: [], mime: '', accum: 0, t0: 0, clockRaf: 0, cd: null,
    blob: null, blobUrl: null, mp4Url: null, baseName: '', endNote: '', note: '', abort: null,
    stopTimer: 0, dataTimer: 0, flushTimer: 0, finalized: false, sealed: false, usedDefault: false,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };

  // Mode de capture
  s.root.querySelectorAll('.scrrec-mode').forEach((b) => b.addEventListener('click', () => {
    if (s.state !== 'idle' || !s.avail[b.dataset.mode]) return;
    s.mode = b.dataset.mode;
    updateControls();
  }, opt));

  // Réglages d'incrustation (appliqués en direct à la composition)
  q('pos').addEventListener('change', () => { s.pos = q('pos').value; drawFrame(); }, opt);
  q('shape').addEventListener('change', () => { s.shape = q('shape').value; drawFrame(); }, opt);

  // Contrôles
  q('start').addEventListener('click', startCapture, opt);
  q('pause').addEventListener('click', togglePause, opt);
  q('stop').addEventListener('click', stopRecording, opt);
  q('reset').addEventListener('click', resetAll, opt);

  // Conversion MP4
  q('mp4').addEventListener('click', convertMp4, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);

  updateControls();
  setStatus(readyMessage(), ready ? undefined : 'error');
  icons();
}

export function unmount() {
  if (!s) return;
  hardStop();                  // MediaRecorder, tracks, rAF, Worker, AudioContext, FFmpeg (abort), objectURLs
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
