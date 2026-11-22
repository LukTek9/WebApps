/**
 * audio-trimmer.js — Outil « Découpeur Audio » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier audio (glisser-déposer / sélecteur) → décodage AudioContext.decodeAudioData.
 *  2. Forme d'onde Canvas : poignées début/fin déplaçables, tête de lecture, champs de temps précis.
 *  3. Fondus (entrée/sortie) → aperçu de la zone via AudioBufferSourceNode + GainNode.
 *  4. Export WAV PCM 16 bits natif (rapide) ou MP3 via FFmpeg.wasm (chargé à la demande, Worker).
 *  5. Lien objectURL révoqué après clic / modification / reset / unmount ; AudioContext fermé au reset/unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'webm'];
const MIN_LEN = 0.05;          // durée minimale de sélection (s)
const FADE_MAX = 10;           // fondu max (s)
const HANDLE_HIT = 12;         // zone de saisie des poignées (px)
const REVOKE_DELAY_MS = 2000;  // délai avant révocation de l'objectURL après clic
const PLAY_LABEL = '▶ Prévisualiser';
const STOP_LABEL = '■ Arrêter';

/* FFmpeg.wasm : cœur MONO-thread (pas de SharedArrayBuffer / COOP-COEP requis), chargé uniquement pour l'export MP3.
   Worker et cœur passés en blob: URL (Worker cross-origin direct bloqué). Mêmes versions que youtube-converter. */
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
const q = (id) => s?.root.querySelector('#audtrim-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round3 = (v) => Math.round(v * 1000) / 1000;
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'audio';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const yieldUi = () => new Promise((r) => setTimeout(r));

/** Secondes → « m:ss.cc ». */
function fmtTime(t) {
  const cs = Math.round(Math.max(0, Number(t) || 0) * 100);
  const m = Math.floor(cs / 6000);
  const sec = (cs % 6000) / 100;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}

/** « 83.5 », « 1:23.45 », « 0:01:23,4 » → secondes (NaN si invalide). */
function parseTime(str) {
  const parts = String(str).trim().replace(',', '.').split(':');
  if (parts.length < 1 || parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(p.trim())) return NaN;
    total = total * 60 + parseFloat(p);
  }
  return total;
}

/** Gain du fondu à l'instant t (s) dans la zone de durée dur. */
function fadeGain(t, dur, fi, fo) {
  let g = 1;
  if (fi > 0 && t < fi) g = t / fi;
  if (fo > 0 && t > dur - fo) g = Math.min(g, (dur - t) / fo);
  return clamp(g, 0, 1);
}

function isAudioFile(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  return f.type.startsWith('audio/') || f.type === 'video/webm' || ACCEPT_EXT.includes(ext);
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
  s.root.querySelectorAll('.audtrim-panel input, .audtrim-panel select').forEach((el) => { el.disabled = busy; });
  q('export').disabled = busy || !s.buffer;
  q('play').disabled = busy;
  q('reset').disabled = busy;
  q('cancel').hidden = !busy;
}

/* ==========================================================================
   Résultat / objectURL
   ========================================================================== */
function releaseUrl() {
  if (!s) return;
  clearTimeout(s.revokeTimer);
  if (s.objectUrl) { URL.revokeObjectURL(s.objectUrl); s.objectUrl = null; }
}

function clearResult() {
  releaseUrl();
  const box = q('result'); if (!box) return;
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
  q('result').hidden = false;
  setProgress(1);
  setStatus('Prêt : cliquez sur le lien pour enregistrer le fichier.', 'ok');
}

/* ==========================================================================
   Audio : contexte, chargement
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

/** Libère tout l'état audio (lecture, résultat, buffer, AudioContext) et revient à la zone de dépôt. */
function discardAudio() {
  if (!s) return;
  s.abort?.abort(); s.abort = null;
  stopPreview();
  clearResult();
  closeAC();
  s.buffer = null; s.peaks = null; s.view = null; s.drag = null;
  s.start = 0; s.end = 0; s.fadeIn = 0; s.fadeOut = 0;
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  setBusy(false);
  setProgress(false);
}

async function loadFile(file) {
  if (!s || !file || s.busy) return;
  if (!isAudioFile(file)) {
    setStatus('Format non pris en charge : utilisez MP3, WAV, OGG, M4A ou WEBM.', 'error');
    return;
  }
  discardAudio();
  const token = ++s.loading;
  setStatus(`Décodage de « ${file.name} »…`); setProgress(null);
  try {
    const ac = ensureAC();
    const buf = await ac.decodeAudioData(await file.arrayBuffer());
    if (!s || s.loading !== token) return; // reset / nouveau fichier / unmount entre-temps
    if (!(buf.duration > 0)) throw new Error('durée nulle');
    s.buffer = buf; s.name = file.name;
    s.start = 0; s.end = round3(buf.duration);
    s.fadeIn = 0; s.fadeOut = 0; s.peaks = null;

    q('drop').hidden = true;
    q('editor').hidden = false;
    q('name').textContent = file.name;
    q('meta').textContent = [fmtTime(buf.duration), `${buf.sampleRate} Hz`,
      buf.numberOfChannels > 1 ? `${buf.numberOfChannels} canaux` : 'mono', fmtMB(file.size)].join(' · ');
    q('total').textContent = fmtTime(buf.duration);
    q('export').disabled = false;
    syncUI(); layout(); draw();
    setProgress(false);
    setStatus('Fichier chargé. Ajustez la sélection puis exportez.');
  } catch (e) {
    if (!s || s.loading !== token) return;
    closeAC();
    setProgress(false);
    setStatus('Décodage impossible : format non pris en charge par ce navigateur ou fichier corrompu.', 'error');
  }
}

/* ==========================================================================
   Sélection / champs
   ========================================================================== */
function syncUI() {
  const dur = s.end - s.start;
  q('start').value = fmtTime(s.start);
  q('end').value = fmtTime(s.end);
  q('dur').value = fmtTime(dur);
  for (const k of ['start', 'end', 'dur']) q(k).classList.remove('is-invalid');
  const max = Math.min(FADE_MAX, dur);
  for (const [k, v] of [['fadein', s.fadeIn], ['fadeout', s.fadeOut]]) {
    const r = q(k);
    r.max = String(max); r.value = String(v);
    q(k + '-val').textContent = v.toFixed(2) + ' s';
  }
}

/** Garde fondu entrée + sortie ≤ durée ; `keep` = fondu prioritaire ('in' | 'out'). */
function clampFades(keep) {
  const dur = s.end - s.start;
  const max = Math.min(FADE_MAX, dur);
  s.fadeIn = clamp(s.fadeIn, 0, max);
  s.fadeOut = clamp(s.fadeOut, 0, max);
  const over = s.fadeIn + s.fadeOut - dur;
  if (over > 0) { if (keep === 'in') s.fadeOut -= over; else s.fadeIn -= over; }
  s.fadeIn = Math.max(0, s.fadeIn); s.fadeOut = Math.max(0, s.fadeOut);
}

function setRegion(start, end) {
  const total = s.buffer.duration;
  const a = clamp(round3(start), 0, Math.max(0, total - MIN_LEN));
  const b = clamp(round3(end), a + MIN_LEN, total);
  s.start = a; s.end = b;
  stopPreview(); clearResult();
  clampFades('in');
  syncUI(); draw();
}

function onEnvelopeChange() {
  stopPreview(); clearResult();
  syncUI(); draw();
}

function onTime(key) {
  if (!s?.buffer || s.busy) return;
  const el = q(key);
  const v = parseTime(el.value);
  if (!Number.isFinite(v)) {
    el.classList.add('is-invalid');
    setStatus('Temps invalide : utilisez des secondes (83.5) ou m:ss.cc (1:23.45).', 'error');
    return;
  }
  if (key === 'start') setRegion(Math.min(v, s.end - MIN_LEN), s.end);
  else if (key === 'end') setRegion(s.start, Math.max(v, s.start + MIN_LEN));
  else setRegion(s.start, s.start + Math.max(v, MIN_LEN));
  setStatus('Sélection mise à jour.');
}

/* ==========================================================================
   Forme d'onde Canvas
   ========================================================================== */
function layout() {
  const wave = q('wave'), c = q('canvas');
  if (!wave || !c || !s.buffer) return;
  const w = Math.floor(wave.clientWidth), h = Math.floor(wave.clientHeight);
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  if (s.view?.w !== w) s.peaks = null;
  s.view = { w, h, dpr };
}

/** Crête min/max par colonne (échantillonnage à pas limité → coût borné). */
function computePeaks(w) {
  const buf = s.buffer, n = buf.length, ch = buf.numberOfChannels;
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  const out = new Float32Array(w * 2);
  const per = n / w;
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor(x * per);
    const i1 = Math.max(i0 + 1, Math.floor((x + 1) * per));
    const stride = Math.max(1, Math.floor((i1 - i0) / 64));
    let mn = 1, mx = -1;
    for (let c = 0; c < ch; c++) {
      const d = data[c];
      for (let i = i0; i < i1 && i < n; i += stride) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    if (mn > mx) mn = mx = 0;
    out[2 * x] = mn; out[2 * x + 1] = mx;
  }
  s.peaks = { w, data: out };
}

/** Position de lecture courante (s, temps source) ou null. */
function playPos() {
  const p = s?.play;
  if (!p || !s.ac) return null;
  return clamp(s.start + p.offset + Math.max(0, s.ac.currentTime - p.t0), s.start, s.end);
}

function draw() {
  if (!s?.buffer || !s.view) return;
  const { w, h, dpr } = s.view;
  const g = q('canvas').getContext('2d');
  if (!s.peaks) computePeaks(w);
  const css = getComputedStyle(s.root);
  const col = (n) => css.getPropertyValue(n).trim() || 'currentColor';

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = col('--color-surface-alt'); g.fillRect(0, 0, w, h);

  const total = s.buffer.duration;
  const xs = (s.start / total) * w, xe = (s.end / total) * w;
  const mid = h / 2, amp = h / 2 - 6, pk = s.peaks.data;
  g.fillStyle = col('--color-border'); g.fillRect(0, mid - 0.5, w, 1);

  const bars = () => {
    for (let x = 0; x < w; x++) {
      const y0 = mid - pk[2 * x + 1] * amp, y1 = mid - pk[2 * x] * amp;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  };
  g.fillStyle = col('--cat-audio');
  g.globalAlpha = 0.3; bars(); g.globalAlpha = 1;            // hors sélection : atténué
  g.save(); g.beginPath(); g.rect(xs, 0, xe - xs, h); g.clip(); bars(); g.restore(); // sélection

  // Enveloppe des fondus
  if (s.fadeIn > 0 || s.fadeOut > 0) {
    const fiW = (s.fadeIn / total) * w, foW = (s.fadeOut / total) * w, top = 4, bot = h - 4;
    g.save();
    g.strokeStyle = col('--color-text'); g.lineWidth = 1.5; g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(xs, s.fadeIn > 0 ? bot : top); g.lineTo(xs + fiW, top);
    g.lineTo(xe - foW, top); g.lineTo(xe, s.fadeOut > 0 ? bot : top);
    g.stroke(); g.restore();
  }

  // Poignées
  g.fillStyle = col('--color-text');
  for (const x of [xs, xe]) {
    g.fillRect(x - 1, 0, 2, h);
    g.fillRect(x - 5, mid - 14, 10, 28);
  }

  // Tête de lecture
  const pos = playPos();
  if (pos != null) {
    const px = (pos / total) * w;
    g.fillStyle = col('--color-primary'); g.fillRect(px - 1, 0, 2, h);
  }
}

/* ---------- Interaction souris / tactile ---------- */
function canvasX(e) {
  const r = q('canvas').getBoundingClientRect();
  return clamp(e.clientX - r.left, 0, r.width);
}

function hitHandle(x) {
  const { w } = s.view, total = s.buffer.duration;
  const xs = (s.start / total) * w, xe = (s.end / total) * w;
  const ds = Math.abs(x - xs), de = Math.abs(x - xe);
  if (Math.min(ds, de) > HANDLE_HIT) return null;
  if (ds === de) return x <= xs ? 'start' : 'end';
  return ds < de ? 'start' : 'end';
}

function onPointerDown(e) {
  if (!s?.buffer || s.busy || !s.view) return;
  const x = canvasX(e);
  const which = hitHandle(x);
  if (which) {
    s.drag = which;
    stopPreview();
    q('canvas').setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  const t = (x / s.view.w) * s.buffer.duration; // clic dans la sélection → lecture depuis ce point
  if (t >= s.start && t <= s.end) startPreview(t - s.start);
}

function onPointerMove(e) {
  if (!s?.buffer || !s.view) return;
  const x = canvasX(e);
  if (!s.drag) { q('canvas').classList.toggle('is-handle', !s.busy && !!hitHandle(x)); return; }
  const t = (x / s.view.w) * s.buffer.duration;
  if (s.drag === 'start') setRegion(Math.min(t, s.end - MIN_LEN), s.end);
  else setRegion(s.start, Math.max(t, s.start + MIN_LEN));
}

function onPointerUp(e) {
  if (!s) return;
  s.drag = null;
  try { q('canvas').releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
}

/* ==========================================================================
   Aperçu (lecture de la zone avec fondus)
   ========================================================================== */
/** Automation du gain : valeur courante à l'offset, puis rampes linéaires jusqu'aux points suivants. */
function automate(param, t0, offset, dur, fi, fo) {
  param.setValueAtTime(fadeGain(offset, dur, fi, fo), t0);
  const pts = [[fi, 1], [dur - fo, 1], [dur, fo > 0 ? 0 : 1]];
  for (const [t, v] of pts) if (t > offset) param.linearRampToValueAtTime(v, t0 + (t - offset));
}

function startPreview(offset = 0) {
  if (!s?.buffer || s.busy) return;
  stopPreview();
  let ac;
  try { ac = ensureAC(); } catch (e) { setStatus(e.message, 'error'); return; }
  ac.resume?.();
  const dur = s.end - s.start;
  offset = clamp(offset, 0, dur - 0.001);

  const src = ac.createBufferSource();
  const gain = ac.createGain();
  src.buffer = s.buffer;
  src.connect(gain); gain.connect(ac.destination);
  const t0 = ac.currentTime + 0.02;
  automate(gain.gain, t0, offset, dur, s.fadeIn, s.fadeOut);
  src.onended = () => { if (s?.play?.src === src) stopPreview(); };
  src.start(t0, s.start + offset, dur - offset);

  s.play = { src, gain, t0, offset };
  q('play').textContent = STOP_LABEL;
  tick();
}

function tick() {
  if (!s?.play) return;
  draw();
  const pos = playPos();
  const el = q('pos');
  if (el && pos != null) el.textContent = `${fmtTime(pos - s.start)} / ${fmtTime(s.end - s.start)}`;
  s.raf = requestAnimationFrame(tick);
}

function stopPreview() {
  if (!s) return;
  cancelAnimationFrame(s.raf); s.raf = 0;
  const p = s.play; s.play = null;
  if (!p) return;
  p.src.onended = null;
  try { p.src.stop(); } catch { /* déjà arrêtée */ }
  try { p.src.disconnect(); p.gain.disconnect(); } catch { /* déjà déconnectés */ }
  const b = q('play'); if (b) b.textContent = PLAY_LABEL;
  const el = q('pos'); if (el) el.textContent = '';
  draw();
}

/* ==========================================================================
   Export : WAV PCM natif, MP3 via FFmpeg.wasm (lazy)
   ========================================================================== */
/** Découpe + fondus + encodage WAV PCM 16 bits en une seule passe (mémoire minimale). */
async function encodeWavRegion(signal, onProgress) {
  const buf = s.buffer, rate = buf.sampleRate, ch = buf.numberOfChannels;
  const i0 = Math.min(buf.length - 1, Math.round(s.start * rate));
  const n = Math.max(1, Math.min(buf.length - i0, Math.round((s.end - s.start) * rate)));
  const nIn = Math.min(n, Math.round(s.fadeIn * rate));
  const nOut = Math.min(n, Math.round(s.fadeOut * rate));
  const bytes = n * ch * 2;
  if (bytes > 0xFFFFFFFF - 36) throw new Error('sélection trop longue pour un fichier WAV (> 4 Go)');

  let dv;
  try { dv = new DataView(new ArrayBuffer(44 + bytes)); }
  catch { throw new Error('mémoire insuffisante pour cette sélection'); }
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, bytes, true);

  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < nIn) g = i / nIn;
    if (nOut && i >= n - nOut) g = Math.min(g, (n - i) / nOut);
    for (let c = 0; c < ch; c++) {
      const x = clamp(data[c][i0 + i] * g, -1, 1);
      dv.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
    if (i % 262144 === 0) { // rend la main + annulation + progression
      if (signal.aborted) throw abortErr();
      onProgress(i / n);
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

/** WAV → MP3 (libmp3lame) dans un Worker. Progression : 0.2–0.35 chargement, 0.35–1 encodage. */
async function encodeMp3(wav, kbps, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly non pris en charge');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.2);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  let ffmpeg = null, onAbort = null, lastLog = '';
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(0.2 + p * 0.15); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

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
  if (!s?.buffer || s.busy) return;
  const st = s;
  clearResult(); stopPreview();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = q('format').value;
  const kbps = Number(q('kbps').value) || 192;
  const mp3 = fmt === 'mp3';
  setBusy(true); setProgress(0);

  try {
    setStatus('Découpe et application des fondus…');
    const wav = await encodeWavRegion(signal, (p) => setProgress(p * (mp3 ? 0.2 : 1)));
    if (s !== st) return;
    let blob = wav;
    if (mp3) {
      try { blob = await encodeMp3(wav, kbps, signal); }
      catch (e) {
        if (isAbort(e)) throw e;
        throw new Error(`Export MP3 impossible (${e.message}). L'export WAV reste disponible (natif, sans FFmpeg).`);
      }
    }
    if (s !== st) return;
    const base = sanitize(st.name.replace(/\.[^.]+$/, '')) + '_decoupe';
    showBlobLink(blob, `${base}.${mp3 ? 'mp3' : 'wav'}`);
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
<div class="audtrim" id="audtrim-root">
  <div class="audtrim-drop" id="audtrim-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier audio">
    <i data-lucide="audio-waveform" class="icon-xl"></i>
    <strong>Glissez un fichier audio ici</strong>
    <small>ou cliquez pour parcourir — MP3, WAV, OGG, M4A, WEBM</small>
    <input type="file" id="audtrim-file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.webm" hidden>
  </div>

  <div class="audtrim-editor" id="audtrim-editor" hidden>
    <div class="audtrim-head">
      <div class="audtrim-file"><b class="audtrim-name" id="audtrim-name"></b><small class="audtrim-meta" id="audtrim-meta"></small></div>
      <button class="btn-remove-file" id="audtrim-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <div class="audtrim-wave" id="audtrim-wave">
      <canvas class="audtrim-canvas" id="audtrim-canvas" tabindex="0" role="img"
        aria-label="Forme d'onde : glissez les poignées pour définir le début et la fin, Espace pour prévisualiser"></canvas>
    </div>
    <div class="audtrim-scale"><span>0:00.00</span><small>Glissez les poignées · cliquez dans la sélection pour lire depuis ce point</small><span id="audtrim-total"></span></div>

    <div class="audtrim-panel">
      <label class="audtrim-field">Début<input type="text" id="audtrim-start" inputmode="decimal" autocomplete="off" spellcheck="false"></label>
      <label class="audtrim-field">Fin<input type="text" id="audtrim-end" inputmode="decimal" autocomplete="off" spellcheck="false"></label>
      <label class="audtrim-field">Durée<input type="text" id="audtrim-dur" inputmode="decimal" autocomplete="off" spellcheck="false"></label>
      <label class="audtrim-field">Fondu d'entrée <span class="audtrim-val" id="audtrim-fadein-val">0.00 s</span>
        <input type="range" id="audtrim-fadein" min="0" max="10" step="0.05" value="0"></label>
      <label class="audtrim-field">Fondu de sortie <span class="audtrim-val" id="audtrim-fadeout-val">0.00 s</span>
        <input type="range" id="audtrim-fadeout" min="0" max="10" step="0.05" value="0"></label>
    </div>

    <div class="audtrim-actions">
      <button class="btn-secondary" id="audtrim-play" type="button">${PLAY_LABEL}</button>
      <span class="audtrim-pos" id="audtrim-pos" aria-live="off"></span>
    </div>

    <div class="audtrim-panel">
      <label class="audtrim-field">Format d'export
        <select id="audtrim-format">
          <option value="wav">WAV (PCM 16 bits — natif, rapide)</option>
          <option value="mp3">MP3 (FFmpeg.wasm — chargé à la demande)</option>
        </select>
      </label>
      <label class="audtrim-field" id="audtrim-kbps-wrap" hidden>Débit MP3
        <select id="audtrim-kbps">
          <option value="128">128 kbit/s</option>
          <option value="192" selected>192 kbit/s</option>
          <option value="256">256 kbit/s</option>
          <option value="320">320 kbit/s</option>
        </select>
      </label>
    </div>
  </div>

  <div>
    <div class="audtrim-bar" id="audtrim-bar"><i></i></div>
    <p class="audtrim-status status-muted" id="audtrim-status">Déposez un fichier audio pour commencer.</p>
  </div>

  <div class="audtrim-actions">
    <button class="btn-primary" id="audtrim-export" type="button"><i data-lucide="download"></i> Découper et exporter</button>
    <button class="btn-secondary" id="audtrim-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="audtrim-result" id="audtrim-result" hidden><a class="btn-primary" id="audtrim-link"></a></div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, ac: null, buffer: null, name: '',
    start: 0, end: 0, fadeIn: 0, fadeOut: 0,
    peaks: null, view: null, play: null, raf: 0, drag: null,
    objectUrl: null, revokeTimer: null, abort: null, busy: false, loading: 0, ro: null,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root');
  const drop = q('drop'), file = q('file'), canvas = q('canvas');

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

  // Canvas
  canvas.addEventListener('pointerdown', onPointerDown, opt);
  canvas.addEventListener('pointermove', onPointerMove, opt);
  canvas.addEventListener('pointerup', onPointerUp, opt);
  canvas.addEventListener('pointercancel', onPointerUp, opt);
  canvas.addEventListener('pointerleave', () => canvas.classList.remove('is-handle'), opt);
  canvas.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); q('play').click(); }
  }, opt);
  if (typeof ResizeObserver === 'function') {
    s.ro = new ResizeObserver(() => { layout(); draw(); });
    s.ro.observe(q('wave'));
  } else {
    window.addEventListener('resize', () => { layout(); draw(); }, opt);
  }

  // Champs de temps / fondus
  for (const k of ['start', 'end', 'dur']) q(k).addEventListener('change', () => onTime(k), opt);
  q('fadein').addEventListener('input', () => {
    if (!s?.buffer || s.busy) return;
    s.fadeIn = Number(q('fadein').value); clampFades('in'); onEnvelopeChange();
  }, opt);
  q('fadeout').addEventListener('input', () => {
    if (!s?.buffer || s.busy) return;
    s.fadeOut = Number(q('fadeout').value); clampFades('out'); onEnvelopeChange();
  }, opt);

  // Transport / export / reset
  q('play').addEventListener('click', () => { if (s.play) stopPreview(); else startPreview(0); }, opt);
  q('format').addEventListener('change', () => { q('kbps-wrap').hidden = q('format').value !== 'mp3'; clearResult(); }, opt);
  q('kbps').addEventListener('change', clearResult, opt);
  q('export').addEventListener('click', exportAudio, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discardAudio();
    setStatus('Déposez un fichier audio pour commencer.');
  }, opt);

  q('export').disabled = true;
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide un décodage en cours
  s.abort?.abort();            // stoppe encodage / chargement FFmpeg
  stopPreview();               // stoppe lecture + rAF
  releaseUrl();                // URL.revokeObjectURL
  closeAC();                   // ferme l'AudioContext
  s.ro?.disconnect();
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
