/**
 * audio-normalizer.js — Outil « Normaliseur Audio LUFS » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier audio (glisser-déposer / sélecteur) → AudioContext.decodeAudioData → AudioBuffer
 *     (aperçu + mesure pic / RMS de l'entrée).
 *  2. Aperçu : AudioBufferSourceNode → sortie (original).
 *  3. Export : FFmpeg.wasm (mono-thread, @ffmpeg/core@0.12.6) chargé à la demande, filtre `loudnorm`
 *     en 2 passes (mesure JSON puis application linéaire) → WAV PCM 16 bits ou MP3.
 *  4. Relecture du résultat (decodeAudioData) → pic / RMS normalisés ; aperçu <audio> + lien <nom>_norm.<ext>.
 *  5. objectURL révoqué à chaque nouvel export / reset / unmount ; AudioContext fermé, Worker FFmpeg terminé,
 *     rAF annulé, requêtes annulées, écouteurs retirés.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];

const LUFS_MIN = -24, LUFS_MAX = -9, LUFS_DEFAULT = -14;
const TP_MIN = -2, TP_MAX = -0.1, TP_DEFAULT = -1;
const LRA_TARGET = 11;

/** Préréglages de cible. */
const PRESETS = {
  streaming: { label: '-14 LUFS · Streaming', lufs: -14 },
  podcast:   { label: '-16 LUFS · Podcast',   lufs: -16 },
  broadcast: { label: '-23 LUFS · Broadcast EBU R128', lufs: -23 },
};

/** Formats d'export. */
const FORMATS = {
  wav: { ext: 'wav', mime: 'audio/wav', codec: 'pcm_s16le' },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame' },
};

/* FFmpeg.wasm : mêmes versions / schéma de chargement que audio-equalizer. */
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
const q = (id) => s?.root.querySelector('#audnorm-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');

/** Texte brut d'une valeur levée (Error, string, objet {message}, autre). FFmpeg.wasm rejette souvent une simple string. */
function rawErrText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e.trim();
  if (typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  if (typeof e.error === 'string' && e.error.trim()) return e.error.trim();
  if (typeof e.reason === 'string' && e.reason.trim()) return e.reason.trim();
  try {
    const t = String(e);
    if (t && t !== '[object Object]' && t !== '[object Event]') return t.trim();
    const j = JSON.stringify(e);
    if (j && j !== '{}') return j.slice(0, 200);
  } catch { /* ignoré */ }
  return '';
}

/** Message d'erreur français explicite ; `logs` = lignes stderr FFmpeg (dernières lignes utiles ajoutées). */
function errMsg(e, logs = []) {
  let t = rawErrText(e).replace(/^(Uncaught\s+)?(\w*Error):\s*/i, '');
  if (t.startsWith('Échec de la normalisation')) return t; // déjà formaté (re-lancé par runLoudnorm)
  if (/out of memory|memory access out of bounds|Cannot enlarge memory|OOM|RangeError|Array buffer allocation/i.test(t)) {
    t = 'mémoire insuffisante pour traiter ce fichier (essayez un fichier plus court)';
  } else if (/not loaded/i.test(t)) {
    t = 'FFmpeg.wasm n\'est pas chargé';
  } else if (/FS error|ErrnoError|ENOENT|file (not found|does not exist)/i.test(t)) {
    t = 'erreur du système de fichiers virtuel FFmpeg (' + t + ')';
  } else if (/terminate/i.test(t)) {
    t = 'FFmpeg a été interrompu';
  } else if (/Failed to fetch|NetworkError|Load failed/i.test(t)) {
    t = 'chargement de FFmpeg.wasm impossible (réseau ou CDN indisponible)';
  }
  const tail = (Array.isArray(logs) ? logs : []).map((l) => String(l).trim()).filter(Boolean)
    .filter((l) => !/^(frame=|size=|video:|audio:|\[Parsed_loudnorm)/i.test(l)).slice(-3).join(' | ');
  if (!t && !tail) return 'Échec de la normalisation (cause non précisée par FFmpeg).';
  return `Échec de la normalisation : ${t || 'erreur FFmpeg'}${tail && !t.includes(tail) ? ` — FFmpeg : ${tail}` : ''}`;
}
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'audio';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const yieldUi = () => new Promise((r) => setTimeout(r));
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const toDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
const fmtLufs = (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} LUFS`;
const fmtTp = (v) => `${Number(v).toFixed(1)} dBTP`;
const fmtDbfs = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : '-∞ dBFS');

function fmtTime(t) {
  const sec = Math.max(0, Number(t) || 0);
  const m = Math.floor(sec / 60);
  return `${m}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
}

function isAudioFile(f) {
  return f.type.startsWith('audio/') || ACCEPT_EXT.includes(extOf(f.name));
}

/** Pic et RMS (dBFS) sur tous les canaux. */
function analyse(buf) {
  let peak = 0, sum = 0, count = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    count += d.length;
  }
  return { peak: toDb(peak), rms: toDb(count ? Math.sqrt(sum / count) : 0) };
}

/** Texte de relevé : pic · RMS · LUFS (optionnel). */
function fmtStats(st, lufs, tp) {
  const parts = [`Pic ${fmtDbfs(st.peak)}`, `RMS ${fmtDbfs(st.rms)}`];
  if (Number.isFinite(lufs)) parts.push(fmtLufs(lufs));
  if (Number.isFinite(tp)) parts.push(`TP ${fmtTp(tp)}`);
  return parts.join(' · ');
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
  s.root.querySelectorAll('.audeq-export select, .audeq-chip, #audnorm-target, #audnorm-tp').forEach((el) => { el.disabled = busy; });
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
  q('out').textContent = '—';
}

function showResult(blob, name, outText) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  q('audio').src = s.objectUrl;
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  q('out').textContent = outText;
  q('result').hidden = false;
  setProgress(1);
  setStatus(`Normalisation terminée : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   AudioContext (aperçu + décodage)
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

/* ==========================================================================
   Lecture (AudioBufferSourceNode jetable + décalage manuel)
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
    : '<i data-lucide="play"></i> Lecture (original)';
  icons();
}

async function play(from) {
  if (!s?.buffer) return;
  const ac = ensureAC();
  if (ac.state === 'suspended') { try { await ac.resume(); } catch { /* ignoré */ } }
  if (!s || s.ac !== ac) return; // reset / unmount pendant resume
  stopSource();
  cancelRaf();

  const dur = s.buffer.duration;
  let off = from ?? s.offset;
  if (off >= dur - 0.01) off = 0;
  const src = ac.createBufferSource();
  src.buffer = s.buffer;
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

/* ==========================================================================
   UI : réglages (cible LUFS, plafond true-peak, presets)
   ========================================================================== */
function renderTarget() {
  const v = s.settings.target;
  q('target').value = String(v);
  q('target-val').textContent = fmtLufs(v);
  s.root.querySelectorAll('.audeq-chip').forEach((chip) => {
    chip.classList.toggle('is-active', PRESETS[chip.dataset.preset].lufs === v);
  });
}

function renderTp() {
  const v = s.settings.tp;
  q('tp').value = String(v);
  q('tp-val').textContent = fmtTp(v);
}

function onSettingsChanged() {
  clearResult(); // l'export précédent ne correspond plus aux réglages
}

/* ==========================================================================
   FFmpeg.wasm (lazy) : loudnorm 2 passes
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
  if (!ffmpegLibPromise) {
    ffmpegLibPromise = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = `${FFMPEG_CDN}/ffmpeg.js`;
      sc.async = true;
      sc.onload = () => {
        if (window.FFmpegWASM?.FFmpeg) resolve(window.FFmpegWASM.FFmpeg);
        else { sc.remove(); reject(new Error('FFmpeg UMD introuvable')); }
      };
      sc.onerror = () => { sc.remove(); reject(new Error('chargement CDN impossible')); };
      document.head.appendChild(sc);
    }).catch((e) => { ffmpegLibPromise = null; throw e; }); // tout échec → nouvelle tentative possible
  }
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

/** Dernier bloc JSON `loudnorm` des logs FFmpeg. */
function parseLoudnorm(logs) {
  const m = logs.join('\n').match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!m) throw new Error('mesure loudnorm introuvable dans les logs FFmpeg');
  return JSON.parse(m[m.length - 1]);
}

/**
 * Progression : 0–0.2 chargement FFmpeg, 0.2–0.5 mesure (passe 1), 0.5–1 normalisation (passe 2).
 * Retourne { blob, inLufs, inTp, outLufs, outTp }.
 */
async function runLoudnorm(st, fmt, kbps, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const { target, tp } = st.settings;
  const I = target.toFixed(1), TP = tp.toFixed(1);
  const rate = fmt.ext === 'mp3' ? Math.min(st.buffer.sampleRate, 48000) : st.buffer.sampleRate;
  const inExt = extOf(st.file.name).replace(/[^a-z0-9]/g, '') || 'bin';
  const inName = `in.${inExt}`, outName = `out.${fmt.ext}`;

  const blobUrls = [];
  let ffmpeg = null, onAbort = null, base = 0, span = 0;
  const logs = [];
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(0.02 + p * 0.18); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

    onAbort = () => { try { ffmpeg?.terminate(); } catch { /* déjà fermé */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    // Tentative 1 : blob: URLs (schéma du convertisseur) ; tentative 2 : URLs CDN directes (importScripts cross-origin).
    const attempts = [
      { coreURL, wasmURL },
      { coreURL: `${FFMPEG_CORE_CDN}/ffmpeg-core.js`, wasmURL: `${FFMPEG_CORE_CDN}/ffmpeg-core.wasm` },
    ];
    let loadErr = null;
    for (const cfg of attempts) {
      ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => { logs.push(message); });
      ffmpeg.on('progress', ({ progress }) => { if (span) setProgress(base + span * clamp(Number(progress) || 0, 0, 1)); });
      try {
        await ffmpeg.load({ ...cfg, classWorkerURL: workerURL });
        loadErr = null;
        break;
      } catch (e) {
        loadErr = e;
        try { ffmpeg.terminate(); } catch { /* déjà fermé */ }
        ffmpeg = null;
        if (signal.aborted) throw abortErr();
      }
    }
    if (!ffmpeg) throw loadErr || new Error('chargement de FFmpeg.wasm impossible');
    if (signal.aborted) throw abortErr();

    await ffmpeg.writeFile(inName, new Uint8Array(await st.file.arrayBuffer()));
    if (signal.aborted) throw abortErr();

    // Passe 1 : mesure
    setStatus('Mesure du volume (passe 1/2)…'); base = 0.2; span = 0.3; setProgress(0.2);
    let code = await ffmpeg.exec(['-i', inName, '-vn', '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA_TARGET}:print_format=json`, '-f', 'null', '-']);
    if (code !== 0) throw new Error(`FFmpeg a échoué lors de la mesure (code ${code})`);
    const m = parseLoudnorm(logs);
    const meas = {
      i: parseFloat(m.input_i), tp: parseFloat(m.input_tp), lra: parseFloat(m.input_lra),
      thresh: parseFloat(m.input_thresh), offset: parseFloat(m.target_offset),
    };
    if (!Object.values(meas).every(Number.isFinite)) throw new Error('audio silencieux ou trop faible pour être mesuré');

    // Passe 2 : application linéaire avec les valeurs mesurées
    logs.length = 0;
    setStatus('Normalisation (passe 2/2)…'); base = 0.5; span = 0.5; setProgress(0.5);
    const filter = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA_TARGET}`
      + `:measured_I=${meas.i}:measured_TP=${meas.tp}:measured_LRA=${meas.lra}:measured_thresh=${meas.thresh}`
      + `:offset=${meas.offset}:linear=true:print_format=json`;
    const args = ['-i', inName, '-vn', '-af', filter, '-ar', String(rate), '-c:a', fmt.codec];
    if (fmt.ext === 'mp3') args.push('-b:a', `${kbps}k`);
    args.push(outName);
    code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error(`FFmpeg a échoué lors de la normalisation (code ${code})`);
    let out = null;
    try { out = parseLoudnorm(logs); } catch { /* relevé de sortie facultatif */ }

    const data = await ffmpeg.readFile(outName);
    if (!(data instanceof Uint8Array) || !data.length) throw new Error('fichier de sortie vide ou absent');
    const blob = new Blob([data], { type: fmt.mime });
    return {
      blob, inLufs: meas.i, inTp: meas.tp,
      outLufs: out ? parseFloat(out.output_i) : NaN, outTp: out ? parseFloat(out.output_tp) : NaN,
    };
  } catch (e) {
    if (signal.aborted) throw abortErr();
    throw new Error(errMsg(e, logs)); // normalise string / objet / Error + dernières lignes stderr
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
    const r = await runLoudnorm(st, fmt, kbps, signal);
    if (s !== st) return;
    if (Number.isFinite(r.inLufs)) q('in').textContent = fmtStats(st.inStats, r.inLufs, r.inTp);

    // Relevé pic / RMS du fichier normalisé
    setStatus('Analyse du résultat…'); setProgress(1);
    let outText = '—';
    try {
      const decoded = await ensureAC().decodeAudioData(await r.blob.arrayBuffer());
      if (s !== st) return;
      outText = fmtStats(analyse(decoded), r.outLufs, r.outTp);
    } catch { outText = Number.isFinite(r.outLufs) ? `${fmtLufs(r.outLufs)} · TP ${fmtTp(r.outTp)}` : '—'; }
    if (s !== st) return;

    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_norm';
    showResult(r.blob, `${base}.${fmt.ext}`, outText);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Export annulé.');
    else setStatus(errMsg(e), 'error');
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
  s.file = null; s.buffer = null; s.inStats = null;
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
    setStatus('Format non pris en charge : utilisez MP3, WAV, OGG, M4A ou FLAC.', 'error');
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
  s.inStats = analyse(buf);
  q('drop').hidden = true;
  q('editor').hidden = false;
  showMeta(file, buf);
  q('in').textContent = fmtStats(s.inStats);
  q('out').textContent = '—';
  syncOptions();
  q('export').disabled = false;
  setProgress(false);
  setStatus('Fichier chargé. Choisissez une cible LUFS puis exportez.');
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const chipsHtml = Object.entries(PRESETS).map(([k, p]) =>
  `<button type="button" class="audeq-chip" data-preset="${k}">${p.label}</button>`).join('');

const TEMPLATE = `
<div class="audeq" id="audnorm-root">
  <div class="audeq-drop" id="audnorm-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier audio">
    <i data-lucide="volume-2" class="icon-xl"></i>
    <strong>Glissez un fichier audio ici</strong>
    <small>ou cliquez pour parcourir — MP3, WAV, OGG, M4A, FLAC</small>
    <input type="file" id="audnorm-file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac" hidden>
  </div>

  <div class="audeq-editor" id="audnorm-editor" hidden>
    <div class="audeq-head">
      <div class="audeq-file"><b class="audeq-name" id="audnorm-name"></b><small class="audeq-meta" id="audnorm-meta"></small></div>
      <button class="btn-remove-file" id="audnorm-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <div class="audeq-player">
      <button class="btn-primary" id="audnorm-play" type="button"><i data-lucide="play"></i> Lecture (original)</button>
      <input type="range" class="audeq-seek" id="audnorm-seek" min="0" max="1000" step="1" value="0" aria-label="Position de lecture">
      <span class="audeq-time" id="audnorm-time">0:00 / 0:00</span>
    </div>

    <div class="audeq-panel">
      <div class="audeq-chips" role="group" aria-label="Cibles de volume">${chipsHtml}</div>
      <div class="audeq-grid">
        <label class="audeq-field">Cible de volume intégré
          <span class="audeq-val" id="audnorm-target-val">${fmtLufs(LUFS_DEFAULT)}</span>
          <input type="range" id="audnorm-target" min="${LUFS_MIN}" max="${LUFS_MAX}" step="0.5" value="${LUFS_DEFAULT}">
        </label>
        <label class="audeq-field">Plafond true-peak
          <span class="audeq-val" id="audnorm-tp-val">${fmtTp(TP_DEFAULT)}</span>
          <input type="range" id="audnorm-tp" min="${TP_MIN}" max="${TP_MAX}" step="0.1" value="${TP_DEFAULT}">
        </label>
      </div>
    </div>

    <div class="audeq-panel">
      <div class="audeq-grid">
        <div class="audeq-field">Entrée
          <span class="audeq-val" id="audnorm-in">—</span>
        </div>
        <div class="audeq-field">Normalisé
          <span class="audeq-val" id="audnorm-out">—</span>
        </div>
      </div>
    </div>

    <div class="audeq-panel audeq-export">
      <label class="audeq-field">Format d'export
        <select id="audnorm-format">
          <option value="wav" selected>WAV (PCM 16 bits)</option>
          <option value="mp3">MP3 (FFmpeg.wasm)</option>
        </select>
      </label>
      <label class="audeq-field" id="audnorm-kbps-wrap" hidden>Débit
        <select id="audnorm-kbps">
          <option value="128">128 kbit/s</option>
          <option value="192" selected>192 kbit/s</option>
          <option value="256">256 kbit/s</option>
          <option value="320">320 kbit/s</option>
        </select>
      </label>
    </div>
  </div>

  <div>
    <div class="audeq-bar" id="audnorm-bar"><i></i></div>
    <p class="audeq-status status-muted" id="audnorm-status">Déposez un fichier audio pour commencer.</p>
  </div>

  <div class="audeq-actions">
    <button class="btn-primary" id="audnorm-export" type="button" disabled><i data-lucide="download"></i> Normaliser &amp; exporter</button>
    <button class="btn-secondary" id="audnorm-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="audeq-result" id="audnorm-result" hidden>
    <audio class="audeq-audio" id="audnorm-audio" controls preload="metadata"></audio>
    <a class="btn-primary audeq-link" id="audnorm-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, ac: null, file: null, buffer: null, inStats: null,
    src: null, playing: false, offset: 0, startedAt: 0, raf: 0, seeking: false,
    objectUrl: null, abort: null, busy: false, loading: 0,
    settings: { target: LUFS_DEFAULT, tp: TP_DEFAULT },
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

  // Cible LUFS / true-peak / presets
  q('target').addEventListener('input', () => { s.settings.target = Number(q('target').value); renderTarget(); onSettingsChanged(); }, opt);
  q('tp').addEventListener('input', () => { s.settings.tp = Number(q('tp').value); renderTp(); onSettingsChanged(); }, opt);
  s.root.querySelectorAll('.audeq-chip').forEach((chip) => {
    chip.addEventListener('click', () => { s.settings.target = PRESETS[chip.dataset.preset].lufs; renderTarget(); onSettingsChanged(); }, opt);
  });

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

  renderTarget(); renderTp();
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
