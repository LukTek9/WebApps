/**
 * video-trimmer.js — Outil « Découpeur Vidéo » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier vidéo (glisser-déposer / sélecteur) → aperçu <video controls> + métadonnées
 *     (durée, résolution, taille). La durée doit être lisible nativement pour piloter la découpe.
 *  2. Plage : curseurs début / fin, champs horaires (m:ss.cc), boutons « début / fin à la position
 *     courante », aperçu borné du segment (lecture stoppée automatiquement à la fin).
 *  3. Export : « Rapide sans perte » (-c copy, coupe alignée sur l'image clé précédente) ou
 *     « Précis » (ré-encodage, coupe à l'image près) via FFmpeg.wasm chargé à la demande
 *     (cœur mono-thread, Worker en blob: URL, repli ESM pour Firefox), progression temps réel, Annuler.
 *  4. Aperçu du résultat + téléchargement <nom>_decoupe.<ext> ;
 *     objectURL / Worker libérés à chaque nouvel export, reset et unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576; // limite prudente : le fichier est copié dans la mémoire wasm
const MIN_GAP = 0.05;            // écart minimal début / fin (secondes)
const STEP = 0.01;               // précision des curseurs (centième de seconde)
const LOAD_TIMEOUT_MS = 90000;   // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie

const MIMES = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
};

/** Encodage « précis » par conteneur : arguments vidéo + codecs audio testés dans l'ordre (repli auto). */
const ENCODERS = {
  mp4: { v: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], a: ['aac', 'libmp3lame'] },
  mov: { v: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'], a: ['aac', 'libmp3lame'] },
  mkv: { v: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'], a: ['aac', 'libmp3lame'] },
  webm: { v: ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-crf', '10', '-b:v', '4M'], a: ['libvorbis', 'libopus'] },
  avi: { v: ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-q:v', '3'], a: ['libmp3lame', 'aac'] },
};

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
const q = (id) => s?.root.querySelector('#vidtrim-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const ffTime = (sec) => Math.max(0, sec).toFixed(3);

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

/** Secondes → « m:ss.cc » (ou « h:mm:ss.cc » à partir d'une heure). */
function fmtTime(t) {
  const cs = Math.round(Math.max(0, Number(t) || 0) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = ((cs % 6000) / 100).toFixed(2).padStart(5, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** « 83.5 » | « 1:23.50 » | « 1:02:03.4 » → secondes ; NaN si invalide. */
function parseTime(str) {
  const v = String(str).trim().replace(',', '.');
  if (!v) return NaN;
  const parts = v.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function isVideoFile(f) {
  return f.type.startsWith('video/') || ACCEPT_EXT.includes(extOf(f.name));
}

/** Extension de sortie : celle du fichier source si prise en charge, sinon mp4. */
function outExt(file) {
  const e = extOf(file.name);
  return ENCODERS[e] ? e : 'mp4';
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
  s.root.querySelectorAll('.vidtrim-ctl').forEach((el) => { el.disabled = busy; });
  q('trim').disabled = busy || !s.meta;
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
  const out = q('out');
  out.hidden = false;
  out.src = s.objectUrl;
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  q('result').hidden = false;
  setProgress(1);
  setStatus(`Découpe terminée : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Plage début / fin
   ========================================================================== */
/** Synchronise curseurs, champs horaires, durée sélectionnée et bande de sélection. */
function refreshRange() {
  if (!s?.meta) return;
  const d = s.meta.duration;
  q('r-start').value = String(s.start);
  q('r-end').value = String(s.end);
  q('t-start').value = fmtTime(s.start);
  q('t-end').value = fmtTime(s.end);
  q('t-start').classList.remove('is-invalid');
  q('t-end').classList.remove('is-invalid');
  q('sel').textContent = fmtTime(s.end - s.start);
  const tl = q('timeline');
  tl.style.setProperty('--vt-a', (s.start / d) * 100 + '%');
  tl.style.setProperty('--vt-b', (s.end / d) * 100 + '%');
  refreshCursor();
}

/** Curseur de lecture sur la frise + position texte. */
function refreshCursor() {
  if (!s?.meta) return;
  const t = q('src').currentTime || 0;
  q('timeline').style.setProperty('--vt-p', clamp(t / s.meta.duration, 0, 1) * 100 + '%');
  q('pos').textContent = `Position : ${fmtTime(t)}`;
}

function onRangeChanged() {
  stopPreview();
  clearResult();
  refreshRange();
}

/** Début borné à [0, fin − écart]. Retourne true si la valeur demandée a été ajustée. */
function setStart(v) {
  const c = clamp(v, 0, s.end - MIN_GAP);
  s.start = c;
  onRangeChanged();
  return c !== v;
}

/** Fin bornée à [début + écart, durée]. Retourne true si la valeur demandée a été ajustée. */
function setEnd(v) {
  const c = clamp(v, s.start + MIN_GAP, s.meta.duration);
  s.end = c;
  onRangeChanged();
  return c !== v;
}

/** Saisie horaire : invalide → retour à la valeur précédente + champ marqué. */
function onTimeInput(which) {
  const el = q('t-' + which);
  const v = parseTime(el.value);
  if (Number.isNaN(v)) {
    refreshRange();
    el.classList.add('is-invalid');
    setStatus('Heure invalide : utilisez 83.5, 1:23.50 ou 1:02:03.40.', 'error');
    return;
  }
  const adjusted = which === 'start' ? setStart(v) : setEnd(v);
  q('src').currentTime = which === 'start' ? s.start : s.end;
  setStatus(adjusted ? 'Valeur ajustée aux limites de la vidéo / de la sélection.' : 'Plage mise à jour.');
}

function onSliderInput(which) {
  const v = Number(q('r-' + which).value);
  if (which === 'start') setStart(v); else setEnd(v);
  q('src').currentTime = which === 'start' ? s.start : s.end;
}

function setFromPlayhead(which) {
  if (!s?.meta || s.busy) return;
  const t = q('src').currentTime || 0;
  const adjusted = which === 'start' ? setStart(t) : setEnd(t);
  setStatus(
    adjusted
      ? `${which === 'start' ? 'Début' : 'Fin'} ajusté pour rester cohérent avec ${which === 'start' ? 'la fin' : 'le début'}.`
      : `${which === 'start' ? 'Début' : 'Fin'} fixé à ${fmtTime(which === 'start' ? s.start : s.end)}.`,
  );
}

/* ==========================================================================
   Aperçu borné du segment
   ========================================================================== */
function setPreviewLabel(on) {
  const l = q('preview-lbl'); if (l) l.textContent = on ? "Arrêter l'aperçu" : 'Aperçu du segment';
}

/** Boucle de contrôle (rAF) : stoppe la lecture à la fin du segment, précision < 1 image. */
function previewTick() {
  if (!s?.previewing) return;
  const v = q('src');
  if (!v.seeking) {
    refreshCursor();
    if (v.currentTime >= s.end - 0.02) { stopPreview(); v.currentTime = s.end; return; }
  }
  s.raf = requestAnimationFrame(previewTick);
}

function stopPreview() {
  if (!s) return;
  const was = s.previewing;
  s.previewing = false;
  if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
  setPreviewLabel(false);
  if (was) q('src').pause();
}

function startPreview() {
  if (!s?.meta || s.busy) return;
  if (s.previewing) { stopPreview(); return; }
  const v = q('src');
  s.previewing = true;
  setPreviewLabel(true);
  v.currentTime = s.start; // v.seeking passe à true immédiatement : la boucle attend la fin du seek
  v.play().catch(() => stopPreview());
  s.raf = requestAnimationFrame(previewTick);
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
/** Libère tout l'état (export, résultat, aperçu source) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  stopPreview();
  clearResult();
  resetVideoEl(q('src'));
  releaseSrc();
  s.file = null; s.meta = null; s.start = 0; s.end = 0;
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  q('trim').disabled = true;
  setBusy(false);
  setProgress(false);
}

function showMeta(file, meta) {
  q('name').textContent = file.name;
  q('meta').textContent = extOf(file.name).toUpperCase() || (file.type || 'vidéo');
  q('st-dur').textContent = fmtTime(meta.duration);
  q('st-res').textContent = `${meta.width} × ${meta.height}`;
  q('st-size').textContent = fmtMB(file.size);
}

/** Lit durée / résolution via <video> (null si le navigateur ne sait pas décoder le conteneur). */
function readMeta(url) {
  return new Promise((resolve) => {
    const v = q('src');
    const done = (m) => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', ko); resolve(m); };
    const ok = () => done(v.videoWidth > 0 && Number.isFinite(v.duration) && v.duration > MIN_GAP
      ? { duration: v.duration, width: v.videoWidth, height: v.videoHeight } : null);
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

  if (!meta) {
    // Sans durée lisible, impossible de piloter la plage : retour à la zone de dépôt
    resetVideoEl(q('src'));
    releaseSrc();
    q('file').value = '';
    setProgress(false);
    setStatus('Durée illisible : ce fichier (conteneur / codec) ne peut pas être lu par le navigateur, découpe impossible.', 'error');
    return;
  }

  s.file = file; s.meta = meta; s.start = 0; s.end = meta.duration;
  q('drop').hidden = true;
  q('editor').hidden = false;
  showMeta(file, meta);
  for (const id of ['r-start', 'r-end']) {
    const r = q(id);
    r.min = '0'; r.max = String(meta.duration); r.step = String(STEP);
  }
  refreshRange();
  q('trim').disabled = false;
  setProgress(false);
  setStatus('Fichier chargé. Réglez le début et la fin, puis découpez.');
}

/* ==========================================================================
   Export FFmpeg.wasm (lazy)
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

/**
 * Arguments FFmpeg.
 *  - copy   : copie des flux, -ss avant -i (seek sur l'image clé précédente), pas de ré-encodage.
 *  - encode : -ss avant -i + ré-encodage → découpe à l'image près.
 * Pistes vidéo / audio optionnelles (`?`) ; dimensions paires (yuv420p).
 */
function ffmpegArgs(mode, inName, outName, ext, start, dur, aCodec) {
  const a = ['-ss', ffTime(start), '-i', inName, '-t', ffTime(dur), '-map', '0:v:0?', '-map', '0:a:0?', '-map_metadata', '0'];
  if (mode === 'copy') {
    a.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    if (ext === 'mp4') a.push('-movflags', '+faststart');
  } else {
    const enc = ENCODERS[ext];
    a.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...enc.v);
    if (aCodec) a.push('-c:a', aCodec, '-b:a', '160k', '-ac', '2'); else a.push('-an');
  }
  a.push(outName);
  return a;
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–1 découpe. */
async function trimFfmpeg(mode, start, dur, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const ext = outExt(s.file);
  const blobUrls = [];
  const inName = 'in.' + (extOf(s.file.name).replace(/[^a-z0-9]/g, '') || 'bin');
  const outName = 'out.' + ext;
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
    const label = mode === 'copy' ? 'Découpe rapide' : 'Découpe précise';
    ffmpeg.on('progress', ({ progress, time }) => {
      // `time` (µs de sortie produite) est rapporté à la durée du segment ; repli sur `progress`
      const raw = typeof time === 'number' && time > 0 ? time / (dur * 1e6) : Number(progress);
      const p = clamp(Number.isFinite(raw) ? raw : 0, 0, 1);
      setProgress(0.2 + 0.8 * p);
      setStatus(`${label} (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus(`${label} (FFmpeg)…`); setProgress(0.2);

    // Mode précis : codecs audio testés dans l'ordre (repli auto) ; mode copie : un seul passage
    let code = -1;
    for (const ac of (mode === 'copy' ? [null] : ENCODERS[ext].a)) {
      logs.length = 0;
      code = await ffmpeg.exec(ffmpegArgs(mode, inName, outName, ext, start, dur, ac));
      if (signal.aborted) throw abortErr();
      if (code === 0) break;
    }
    if (code !== 0) throw new Error(`FFmpeg code ${code}${tail()}`);
    return new Blob([await ffmpeg.readFile(outName)], { type: MIMES[ext] });
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

async function trim() {
  if (!s?.file || !s.meta || s.busy) return;
  const st = s;
  stopPreview();
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const mode = st.root.querySelector('input[name="vidtrim-mode"]:checked')?.value === 'encode' ? 'encode' : 'copy';
  const start = st.start, dur = st.end - st.start;
  setBusy(true); setProgress(0);

  try {
    const blob = await trimFfmpeg(mode, start, dur, signal);
    if (s !== st) return;
    const base = sanitize(st.file.name.replace(/\.[^.]+$/, '')) + '_decoupe';
    showResult(blob, `${base}.${outExt(st.file)}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Découpe annulée.');
    else setStatus(`Découpe impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vidtrim" id="vidtrim-root">
  <div class="vidtrim-drop" id="vidtrim-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier vidéo">
    <i data-lucide="scissors" class="icon-xl"></i>
    <strong>Glissez une vidéo ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="vidtrim-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" hidden>
  </div>

  <div class="vidtrim-editor" id="vidtrim-editor" hidden>
    <div class="vidtrim-head">
      <div class="vidtrim-file"><b class="vidtrim-name" id="vidtrim-name"></b><small class="vidtrim-meta" id="vidtrim-meta"></small></div>
      <button class="btn-remove-file" id="vidtrim-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <video class="vidtrim-video" id="vidtrim-src" controls preload="metadata" playsinline></video>

    <div class="vidtrim-info">
      <div class="vidtrim-stat"><small>Durée</small><b id="vidtrim-st-dur">—</b></div>
      <div class="vidtrim-stat"><small>Résolution</small><b id="vidtrim-st-res">—</b></div>
      <div class="vidtrim-stat"><small>Taille</small><b id="vidtrim-st-size">—</b></div>
    </div>

    <div class="vidtrim-panel">
      <div class="vidtrim-timeline" id="vidtrim-timeline" aria-hidden="true" title="Cliquez pour déplacer la lecture">
        <div class="vidtrim-sel"></div><div class="vidtrim-cursor"></div>
      </div>
      <div class="vidtrim-grid">
        <label class="vidtrim-field">Début (curseur)
          <input type="range" id="vidtrim-r-start" class="vidtrim-ctl" min="0" max="1" step="0.01" value="0">
        </label>
        <label class="vidtrim-field">Fin (curseur)
          <input type="range" id="vidtrim-r-end" class="vidtrim-ctl" min="0" max="1" step="0.01" value="1">
        </label>
      </div>
      <div class="vidtrim-grid">
        <label class="vidtrim-field">Début
          <input type="text" id="vidtrim-t-start" class="vidtrim-ctl" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0:00.00">
        </label>
        <label class="vidtrim-field">Fin
          <input type="text" id="vidtrim-t-end" class="vidtrim-ctl" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0:00.00">
        </label>
        <div class="vidtrim-stat"><small>Durée sélectionnée</small><b id="vidtrim-sel">—</b></div>
      </div>
      <div class="vidtrim-actions">
        <button class="btn-secondary vidtrim-ctl" id="vidtrim-set-start" type="button"><i data-lucide="chevron-first"></i> Début ici</button>
        <button class="btn-secondary vidtrim-ctl" id="vidtrim-set-end" type="button"><i data-lucide="chevron-last"></i> Fin ici</button>
        <button class="btn-secondary vidtrim-ctl" id="vidtrim-preview" type="button"><i data-lucide="play"></i> <span id="vidtrim-preview-lbl">Aperçu du segment</span></button>
        <span class="vidtrim-pos" id="vidtrim-pos">Position : 0:00.00</span>
      </div>
    </div>

    <fieldset class="vidtrim-modes">
      <legend>Mode d'export</legend>
      <label class="vidtrim-mode">
        <input type="radio" name="vidtrim-mode" value="copy" class="vidtrim-ctl" checked>
        <span><b>Rapide sans perte</b><small>Copie des flux (-c copy), sans ré-encodage. La coupe est alignée sur l'image clé précédente : le début peut être décalé de quelques secondes.</small></span>
      </label>
      <label class="vidtrim-mode">
        <input type="radio" name="vidtrim-mode" value="encode" class="vidtrim-ctl">
        <span><b>Précis à l'image près</b><small>Ré-encodage du segment (plus lent) : début et fin exacts, léger recompression.</small></span>
      </label>
    </fieldset>
  </div>

  <div>
    <div class="vidtrim-bar" id="vidtrim-bar"><i></i></div>
    <p class="vidtrim-status status-muted" id="vidtrim-status">Déposez une vidéo pour commencer.</p>
  </div>

  <div class="vidtrim-actions">
    <button class="btn-primary" id="vidtrim-trim" type="button" disabled><i data-lucide="scissors"></i> Découper</button>
    <button class="btn-secondary" id="vidtrim-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vidtrim-result" id="vidtrim-result" hidden>
    <video class="vidtrim-video" id="vidtrim-out" controls preload="metadata" playsinline></video>
    <a class="btn-primary vidtrim-link" id="vidtrim-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, file: null, meta: null, start: 0, end: 0,
    srcUrl: null, objectUrl: null, abort: null, busy: false, loading: 0,
    previewing: false, raf: 0,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root');
  const drop = q('drop'), file = q('file'), src = q('src');

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

  // Plage : curseurs, champs horaires, boutons « ici », aperçu segment
  q('r-start').addEventListener('input', () => onSliderInput('start'), opt);
  q('r-end').addEventListener('input', () => onSliderInput('end'), opt);
  q('t-start').addEventListener('change', () => onTimeInput('start'), opt);
  q('t-end').addEventListener('change', () => onTimeInput('end'), opt);
  q('t-start').addEventListener('input', (e) => e.target.classList.remove('is-invalid'), opt);
  q('t-end').addEventListener('input', (e) => e.target.classList.remove('is-invalid'), opt);
  q('set-start').addEventListener('click', () => setFromPlayhead('start'), opt);
  q('set-end').addEventListener('click', () => setFromPlayhead('end'), opt);
  q('preview').addEventListener('click', startPreview, opt);

  // Frise : clic = déplacement de la lecture
  q('timeline').addEventListener('pointerdown', (e) => {
    if (!s?.meta) return;
    const r = e.currentTarget.getBoundingClientRect();
    src.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * s.meta.duration;
  }, opt);

  // Lecteur source : curseur de la frise ; pause manuelle = fin de l'aperçu segment
  src.addEventListener('timeupdate', refreshCursor, opt);
  src.addEventListener('seeked', refreshCursor, opt);
  src.addEventListener('pause', () => { if (s?.previewing) stopPreview(); }, opt);

  // Résultat non lisible nativement (AVI / MKV…) : on masque l'aperçu, le téléchargement reste disponible
  q('out').addEventListener('error', () => {
    if (!s?.objectUrl) return;
    q('out').hidden = true;
    setStatus('Découpe terminée, mais aperçu indisponible pour ce format : téléchargez le fichier.', 'ok');
  }, opt);

  // Mode d'export : tout changement invalide le résultat précédent
  s.root.querySelectorAll('input[name="vidtrim-mode"]').forEach((r) => r.addEventListener('change', clearResult, opt));

  // Export / annulation / reset
  q('trim').addEventListener('click', trim, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez une vidéo pour commencer.');
  }, opt);

  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide une lecture de métadonnées en cours
  s.abort?.abort();            // stoppe export / chargement FFmpeg (terminate Worker)
  stopPreview();               // annule la boucle rAF + pause
  clearResult();               // pause <video> résultat + URL.revokeObjectURL
  resetVideoEl(q('src'));      // pause <video> source
  releaseSrc();                // URL.revokeObjectURL de l'aperçu source
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
