/**
 * subtitle-burner.js — Outil « Sous-titres & Incrustation SRT » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Vidéo (glisser-déposer / sélecteur) + .srt optionnel (déposé en même temps ou importé ensuite)
 *     → aperçu <video controls> + métadonnées ; sous-titre courant affiché sous le lecteur.
 *  2. Éditeur de cues : début / fin / texte, ajout à l'instant de lecture, suppression, import / téléchargement .srt.
 *  3. Incrustation : FFmpeg.wasm (cœur mono-thread @ffmpeg/core@0.12.6, Worker en blob: URL) ;
 *     police TTF téléchargée depuis le CDN puis écrite dans /fonts (MEMFS) pour libass ;
 *     filtre `subtitles` (taille de police + marge basse), sortie MP4 ou WEBM.
 *  4. Aperçu du résultat + téléchargement <nom>_soustitre.<ext> ;
 *     objectURL / Worker / <style> libérés à chaque nouvel export, reset et unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576; // limite prudente : le fichier est copié dans la mémoire wasm
const MAX_SRT_BYTES = 2 * 1048576;
const FS_DEFAULT = 32, MARGIN_DEFAULT = 40;
const ASS_BASE_H = 288; // PlayResY par défaut de libass pour un SRT
const CUE_DEFAULT_MS = 2000;

/** Formats de sortie : codecs FFmpeg + qualité (index 0 = Haute, 1 = Équilibrée, 2 = Compacte). */
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
};
const QUALITY_INDEX = { high: 0, balanced: 1, compact: 2 };
const AUDIO_BITRATES = ['192k', '128k', '96k'];
const LOAD_TIMEOUT_MS = 90000; // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie

/** Polices TTF CDN (essayées dans l'ordre) ; `family` = nom de famille interne pour force_style. */
const FONT_SOURCES = [
  { url: 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf', family: 'DejaVu Sans' },
  { url: 'https://cdn.jsdelivr.net/gh/ffmpegwasm/testdata@master/arial.ttf', family: 'Arial' },
];

/* FFmpeg.wasm : mêmes versions / schéma de chargement que video-converter. */
const FFMPEG_VERSION = '0.12.10';
const FFMPEG_CORE_VERSION = '0.12.6';
const FFMPEG_CDN = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;
const FFMPEG_CORE_CDN = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;
const FFMPEG_WORKER_FILE = '814.ffmpeg.js';

/* Styles propres à l'outil (jetons du design system uniquement, aucune couleur en dur) — retirés à l'unmount. */
const STYLE_ID = 'subburn-style';
const STYLE = `
.subburn-toolbar { display: flex; flex-wrap: wrap; gap: var(--space-2, .5rem); }
.subburn-live { min-height: 2.5rem; margin: 0; padding: var(--space-2, .5rem) var(--space-3, .75rem); text-align: center; white-space: pre-line;
  border-radius: var(--radius-md, .5rem); background: color-mix(in srgb, currentColor 8%, transparent); }
.subburn-cues { display: flex; flex-direction: column; gap: var(--space-2, .5rem); max-height: 24rem; overflow: auto; }
.subburn-cue { display: grid; grid-template-columns: 8.5rem 8.5rem minmax(0, 1fr) auto auto; gap: var(--space-2, .5rem); align-items: start;
  padding: var(--space-2, .5rem); border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: var(--radius-md, .5rem); }
.subburn-in { box-sizing: border-box; width: 100%; font: inherit; color: inherit; background: transparent; padding: .4rem .55rem;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: var(--radius-sm, .375rem); }
.subburn-in:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: 1px; }
textarea.subburn-in { resize: vertical; min-height: 2.4rem; }
@media (max-width: 40rem) {
  .subburn-cue { grid-template-columns: 1fr 1fr; }
  .subburn-cue textarea.subburn-in { grid-column: 1 / -1; }
}`;

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (id) => s?.root.querySelector('#subburn-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const baseOf = (name) => name.replace(/\.[^.]+$/, '');

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
const isSrtFile = (f) => extOf(f.name) === 'srt';

/* ==========================================================================
   SRT : temps / parse / sérialisation
   ========================================================================== */
/** ms → HH:MM:SS,mmm */
function fmtTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`;
}

/** « HH:MM:SS,mmm » | « MM:SS.mmm » | secondes décimales → ms (NaN si invalide). */
function parseTime(str) {
  const v = String(str).trim();
  const m = v.match(/^(?:(\d+):)?(\d+):(\d+)(?:[.,](\d{1,3}))?$/);
  if (m) return ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + Number((m[4] || '0').padEnd(3, '0'));
  if (/^\d+([.,]\d+)?$/.test(v)) return Math.round(parseFloat(v.replace(',', '.')) * 1000);
  return NaN;
}

function parseSrt(text) {
  const out = [];
  const blocks = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, c] = lines[i].split('-->');
    const start = parseTime(a), end = parseTime((c || '').trim().split(/\s+/)[0]);
    const txt = lines.slice(i + 1).join('\n').trim();
    if (Number.isFinite(start) && Number.isFinite(end)) out.push({ id: ++s.cueSeq, start, end, text: txt });
  }
  return out;
}

/** Cues valides (texte non vide, fin > début), triées. */
function validCues() {
  return s.cues.filter((c) => c.text.trim() && c.end > c.start).sort((x, y) => x.start - y.start);
}

function toSrt(cues = validCues()) {
  return cues.map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text.trim().replace(/\n{2,}/g, '\n')}\n`).join('\n');
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
  s.root.querySelectorAll('.vidconv-panel select, .vidconv-panel input, .subburn-cues input, .subburn-cues textarea, .subburn-cues button, .subburn-toolbar button').forEach((el) => { el.disabled = busy; });
  q('burn').disabled = busy || !s.file;
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

function releaseSrt() {
  if (!s || !s.srtUrl) return;
  URL.revokeObjectURL(s.srtUrl);
  s.srtUrl = null;
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
  setStatus(`Incrustation terminée : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Éditeur de cues
   ========================================================================== */
function rowEl(c) {
  const row = document.createElement('div');
  row.className = 'subburn-cue';
  row.dataset.id = String(c.id);
  row.innerHTML = `
    <input class="subburn-in" data-f="start" aria-label="Début (HH:MM:SS,mmm)" inputmode="decimal" spellcheck="false" autocomplete="off">
    <input class="subburn-in" data-f="end" aria-label="Fin (HH:MM:SS,mmm)" inputmode="decimal" spellcheck="false" autocomplete="off">
    <textarea class="subburn-in" data-f="text" rows="2" aria-label="Texte du sous-titre" placeholder="Texte du sous-titre"></textarea>
    <button class="btn-secondary" type="button" data-act="go" aria-label="Aller à ce sous-titre"><i data-lucide="locate-fixed"></i></button>
    <button class="btn-remove-file" type="button" data-act="del" aria-label="Supprimer ce sous-titre"><i data-lucide="trash-2"></i></button>`;
  row.querySelector('[data-f="start"]').value = fmtTime(c.start);
  row.querySelector('[data-f="end"]').value = fmtTime(c.end);
  row.querySelector('[data-f="text"]').value = c.text;
  return row;
}

function renderCues() {
  const list = q('cues'); if (!list) return;
  list.textContent = '';
  if (!s.cues.length) {
    const p = document.createElement('p');
    p.className = 'status-muted';
    p.textContent = 'Aucun sous-titre : ajoutez-en un ou importez un fichier .srt.';
    list.appendChild(p);
  } else {
    s.cues.forEach((c) => list.appendChild(rowEl(c)));
  }
  q('count').textContent = `${s.cues.length} sous-titre${s.cues.length > 1 ? 's' : ''}`;
  icons();
}

function updateLive() {
  const v = q('src'), live = q('live');
  if (!v || !live) return;
  const t = v.currentTime * 1000;
  const c = s.cues.find((x) => x.text.trim() && t >= x.start && t < x.end);
  live.textContent = c ? c.text : '';
}

function addCue() {
  if (!s || s.busy) return;
  const v = q('src');
  const hasVideo = s.file && s.meta;
  const last = s.cues.reduce((m, c) => Math.max(m, c.end), 0);
  const start = Math.round(hasVideo ? v.currentTime * 1000 : last);
  const cue = { id: ++s.cueSeq, start, end: start + CUE_DEFAULT_MS, text: '' };
  s.cues.push(cue);
  s.cues.sort((a, b) => a.start - b.start);
  clearResult();
  renderCues();
  q('cues').querySelector(`[data-id="${cue.id}"] textarea`)?.focus();
}

async function importSrt(file) {
  if (!s || !file || s.busy) return;
  if (file.size > MAX_SRT_BYTES) { setStatus(`Fichier .srt trop volumineux (${fmtMB(file.size)}).`, 'error'); return; }
  let cues;
  try { cues = parseSrt(await file.text()); } catch { cues = []; }
  if (!s) return;
  if (!cues.length) { setStatus('Aucun sous-titre valide trouvé dans ce fichier .srt.', 'error'); return; }
  s.cues = cues.sort((a, b) => a.start - b.start);
  s.srtName = baseOf(file.name);
  clearResult();
  renderCues();
  updateLive();
  setStatus(`${cues.length} sous-titre${cues.length > 1 ? 's' : ''} importé${cues.length > 1 ? 's' : ''}${s.file ? '.' : ' : déposez maintenant une vidéo.'}`, 'ok');
}

function downloadSrt() {
  if (!s) return;
  const txt = toSrt();
  if (!txt) { setStatus('Aucun sous-titre valide à télécharger (texte et durée requis).', 'error'); return; }
  releaseSrt();
  s.srtUrl = URL.createObjectURL(new Blob([txt], { type: 'application/x-subrip' }));
  const a = document.createElement('a');
  a.href = s.srtUrl;
  a.download = `${sanitize(s.file ? baseOf(s.file.name) : (s.srtName || 'sous-titres'))}.srt`;
  a.click();
}

/** Délégation d'événements sur la liste de cues. */
function onCueInput(e) {
  const f = e.target.dataset?.f;
  if (f !== 'text') return;
  const cue = s.cues.find((c) => String(c.id) === e.target.closest('.subburn-cue')?.dataset.id);
  if (!cue) return;
  cue.text = e.target.value;
  clearResult(); updateLive();
}

function onCueChange(e) {
  const f = e.target.dataset?.f;
  if (f !== 'start' && f !== 'end') return;
  const cue = s.cues.find((c) => String(c.id) === e.target.closest('.subburn-cue')?.dataset.id);
  if (!cue) return;
  const ms = parseTime(e.target.value);
  if (!Number.isFinite(ms)) {
    e.target.value = fmtTime(cue[f]);
    setStatus('Temps invalide : utilisez HH:MM:SS,mmm (ex. 00:01:05,500).', 'error');
    return;
  }
  cue[f] = ms;
  e.target.value = fmtTime(ms);
  clearResult(); updateLive();
}

function onCueClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || s.busy) return;
  const id = btn.closest('.subburn-cue')?.dataset.id;
  const cue = s.cues.find((c) => String(c.id) === id);
  if (!cue) return;
  if (btn.dataset.act === 'del') {
    s.cues = s.cues.filter((c) => c !== cue);
    clearResult(); renderCues(); updateLive();
  } else if (btn.dataset.act === 'go' && s.file && s.meta) {
    const v = q('src');
    v.currentTime = cue.start / 1000;
    updateLive();
  }
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
/** Libère l'état vidéo / export et revient à la zone de dépôt (cues conservées sauf `clearCues`). */
function discard(clearCues) {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  clearResult();
  resetVideoEl(q('src'));
  releaseSrc();
  s.file = null; s.meta = null;
  if (clearCues) { s.cues = []; s.srtName = ''; renderCues(); }
  q('live').textContent = '';
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

async function loadFile(file, srtFile) {
  if (!s || !file || s.busy) return;
  if (!isVideoFile(file)) {
    setStatus('Format non pris en charge : utilisez MP4, WEBM, MOV, AVI ou MKV.', 'error');
    return;
  }
  if (file.size > MAX_BYTES) {
    setStatus(`Fichier trop volumineux (${fmtMB(file.size)}) : limite ${fmtMB(MAX_BYTES)} pour un traitement 100 % navigateur.`, 'error');
    return;
  }
  discard(false);
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
  q('burn').disabled = false;
  setProgress(false);
  if (meta) setStatus('Vidéo chargée. Éditez les sous-titres puis lancez l\'incrustation.');
  else setStatus('Aperçu et métadonnées indisponibles (lecture native impossible) : l\'incrustation utilisera FFmpeg.');
  if (srtFile) await importSrt(srtFile);
}

/** Répartit les fichiers déposés / choisis : une vidéo (+ un .srt optionnel) ou un .srt seul. */
function handleFiles(files) {
  const list = [...(files || [])];
  const video = list.find(isVideoFile);
  const srt = list.find(isSrtFile);
  if (video) loadFile(video, srt);
  else if (srt) importSrt(srt);
  else if (list.length) setStatus('Format non pris en charge : vidéo (MP4, WEBM, MOV, AVI, MKV) ou sous-titres .srt.', 'error');
}

/* ==========================================================================
   Incrustation FFmpeg.wasm (lazy)
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

/** Police TTF (CDN, avec repli) → { data, family } ; libass ne trouve aucune police système dans le wasm. */
async function fetchFont(signal) {
  let lastErr = null;
  for (const f of FONT_SOURCES) {
    try {
      const res = await fetch(f.url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} (${f.url.split('/').pop()})`);
      return { data: new Uint8Array(await res.arrayBuffer()), family: f.family };
    } catch (e) {
      if (signal.aborted) throw abortErr();
      lastErr = e;
    }
  }
  throw new Error(`police de sous-titres introuvable (${errMsg(lastErr)})`);
}

/** Filtre vidéo : dimensions paires + `subtitles` (taille en pixels vidéo via original_size si connue). */
function buildFilter(family, fontPx, marginPx) {
  const m = s.meta;
  let fs = fontPx, mv = marginPx, orig = '';
  if (m) {
    const w = m.width - (m.width % 2), h = m.height - (m.height % 2);
    orig = `:original_size=${w}x${h}`;
  } else { // dimensions inconnues : conversion approximative d'une vidéo 1080p vers la base libass
    fs = Math.round(fontPx * ASS_BASE_H / 1080);
    mv = Math.round(marginPx * ASS_BASE_H / 1080);
  }
  const style = `FontName=${family},FontSize=${fs},MarginV=${mv},Outline=2,Shadow=0,BorderStyle=1`;
  return `scale=trunc(iw/2)*2:trunc(ih/2)*2,subtitles=sub.srt:fontsdir=/fonts${orig}:force_style='${style}'`;
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–1 incrustation. */
async function burnFfmpeg(fmt, qi, srtText, fontPx, marginPx, signal) {
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
      (p) => { setProgress(0.02 + p * 0.16); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

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

    // Police dans le MEMFS (/fonts) + fichier SRT
    setStatus('Chargement de la police des sous-titres…'); setProgress(0.18);
    const font = await fetchFont(signal);
    try { await ffmpeg.createDir('/fonts'); } catch { /* existe déjà */ }
    await ffmpeg.writeFile('/fonts/font.ttf', font.data);
    await ffmpeg.writeFile('sub.srt', new TextEncoder().encode(srtText));
    await ffmpeg.writeFile(inName, new Uint8Array(await s.file.arrayBuffer()));
    if (signal.aborted) throw abortErr();

    ffmpeg.on('progress', ({ progress }) => {
      const p = clamp(Number(progress) || 0, 0, 1);
      setProgress(0.2 + 0.8 * p);
      setStatus(`Incrustation ${fmt.ext.toUpperCase()} (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus(`Incrustation ${fmt.ext.toUpperCase()} (FFmpeg)…`); setProgress(0.2);

    const vf = buildFilter(font.family, fontPx, marginPx);
    // Codecs audio testés dans l'ordre (repli automatique) ; sans piste audio → `0:a:0?` ignoré
    let code = -1;
    for (const ac of fmt.aCodecs) {
      logs.length = 0;
      code = await ffmpeg.exec([
        '-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0',
        '-vf', vf, ...fmt.vArgs(qi),
        '-c:a', ac, '-b:a', AUDIO_BITRATES[qi], '-ac', '2',
        outName,
      ]);
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
      if (!signal.aborted) for (const f of [inName, outName, 'sub.srt', '/fonts/font.ttf']) { try { await ffmpeg.deleteFile(f); } catch { /* absent */ } }
      try { ffmpeg.terminate(); } catch { /* déjà fermé */ } // ferme Worker + libère la mémoire wasm
    }
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function burn() {
  if (!s?.file || s.busy) return;
  const st = s;
  const cues = validCues();
  if (!cues.length) { setStatus('Aucun sous-titre valide : renseignez un texte et une fin postérieure au début.', 'error'); return; }
  const fontPx = clamp(Math.round(Number(q('fsize').value)) || FS_DEFAULT, 8, 200);
  const marginPx = clamp(Math.round(Number(q('margin').value)) || 0, 0, 500);
  q('fsize').value = String(fontPx); q('margin').value = String(marginPx);
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value];
  const qi = QUALITY_INDEX[q('quality').value] ?? 1;
  setBusy(true); setProgress(0);

  try {
    const blob = await burnFfmpeg(fmt, qi, toSrt(cues), fontPx, marginPx, signal);
    if (s !== st) return;
    showResult(blob, `${sanitize(baseOf(st.file.name))}_soustitre.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Incrustation annulée.');
    else setStatus(`Incrustation ${fmt.ext.toUpperCase()} impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vidconv" id="subburn-root">
  <div class="vidconv-drop" id="subburn-drop" tabindex="0" role="button" aria-label="Choisir ou déposer une vidéo et un fichier SRT">
    <i data-lucide="captions" class="icon-xl"></i>
    <strong>Glissez une vidéo ici (+ un fichier .srt optionnel)</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="subburn-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv,.srt" multiple hidden>
  </div>

  <div class="vidconv-editor" id="subburn-editor" hidden>
    <div class="vidconv-head">
      <div class="vidconv-file"><b class="vidconv-name" id="subburn-name"></b><small class="vidconv-meta" id="subburn-meta"></small></div>
      <button class="btn-remove-file" id="subburn-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <video class="vidconv-video" id="subburn-src" controls preload="metadata" playsinline></video>
    <p class="subburn-live status-muted" id="subburn-live" aria-live="off"></p>

    <div class="vidconv-info">
      <div class="vidconv-stat"><small>Durée</small><b id="subburn-st-dur">—</b></div>
      <div class="vidconv-stat"><small>Résolution</small><b id="subburn-st-res">—</b></div>
      <div class="vidconv-stat"><small>Taille</small><b id="subburn-st-size">—</b></div>
    </div>
  </div>

  <div class="vidconv-panel">
    <div class="subburn-toolbar">
      <button class="btn-secondary" id="subburn-add" type="button"><i data-lucide="plus"></i> Ajouter un sous-titre</button>
      <button class="btn-secondary" id="subburn-import" type="button"><i data-lucide="file-up"></i> Importer .srt</button>
      <button class="btn-secondary" id="subburn-dl" type="button"><i data-lucide="download"></i> Télécharger .srt</button>
      <input type="file" id="subburn-srt" accept=".srt,text/plain" hidden>
    </div>
    <small class="status-muted" id="subburn-count">0 sous-titre</small>
    <div class="subburn-cues" id="subburn-cues"></div>
  </div>

  <div class="vidconv-panel">
    <label class="vidconv-field">Taille de police (px vidéo)
      <input type="number" class="subburn-in" id="subburn-fsize" min="8" max="200" step="1" value="${FS_DEFAULT}">
    </label>
    <label class="vidconv-field">Marge basse (px vidéo)
      <input type="number" class="subburn-in" id="subburn-margin" min="0" max="500" step="1" value="${MARGIN_DEFAULT}">
    </label>
    <label class="vidconv-field">Format de sortie
      <select id="subburn-format">
        <option value="mp4" selected>MP4 (H.264 + AAC)</option>
        <option value="webm">WEBM (VP8 + Vorbis)</option>
      </select>
    </label>
    <label class="vidconv-field">Qualité
      <select id="subburn-quality">
        <option value="high">Haute</option>
        <option value="balanced" selected>Équilibrée</option>
        <option value="compact">Compacte</option>
      </select>
    </label>
  </div>

  <div>
    <div class="vidconv-bar" id="subburn-bar"><i></i></div>
    <p class="vidconv-status status-muted" id="subburn-status">Déposez une vidéo (et un .srt) pour commencer.</p>
  </div>

  <div class="vidconv-actions">
    <button class="btn-primary" id="subburn-burn" type="button" disabled><i data-lucide="captions"></i> Incruster les sous-titres</button>
    <button class="btn-secondary" id="subburn-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vidconv-result" id="subburn-result" hidden>
    <video class="vidconv-video" id="subburn-out" controls preload="metadata" playsinline></video>
    <a class="btn-primary vidconv-link" id="subburn-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);

  s = {
    root: container, ctx, file: null, meta: null, style,
    cues: [], cueSeq: 0, srtName: '',
    srcUrl: null, objectUrl: null, srtUrl: null, abort: null, busy: false, loading: 0,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root');
  const drop = q('drop'), file = q('file'), srt = q('srt');

  // Zone de dépôt + sélecteur
  drop.addEventListener('click', () => file.click(), opt);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } }, opt);
  file.addEventListener('change', () => { handleFiles(file.files); file.value = ''; }, opt);
  // Dépôt n'importe où dans l'outil (évite la navigation du navigateur vers le fichier)
  root.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); }, opt);
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) drop.classList.remove('is-over'); }, opt);
  root.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    handleFiles(e.dataTransfer?.files);
  }, opt);

  // Éditeur de cues
  q('add').addEventListener('click', addCue, opt);
  q('import').addEventListener('click', () => srt.click(), opt);
  srt.addEventListener('change', () => { const f = srt.files?.[0]; if (f) importSrt(f); srt.value = ''; }, opt);
  q('dl').addEventListener('click', downloadSrt, opt);
  const list = q('cues');
  list.addEventListener('input', onCueInput, opt);
  list.addEventListener('change', onCueChange, opt);
  list.addEventListener('click', onCueClick, opt);

  // Sous-titre courant sous le lecteur
  const v = q('src');
  ['timeupdate', 'seeked', 'loadedmetadata'].forEach((ev) => v.addEventListener(ev, updateLive, opt));

  // Options : tout changement invalide le résultat précédent
  ['fsize', 'margin', 'format', 'quality'].forEach((id) => q(id).addEventListener('change', clearResult, opt));

  // Incrustation / annulation / reset
  q('burn').addEventListener('click', burn, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard(true);
    setStatus('Déposez une vidéo (et un .srt) pour commencer.');
  }, opt);

  renderCues();
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide une lecture de métadonnées en cours
  s.abort?.abort();            // stoppe incrustation / chargement FFmpeg (terminate Worker)
  clearResult();               // pause <video> résultat + URL.revokeObjectURL
  resetVideoEl(q('src'));      // pause <video> source
  releaseSrc();                // URL.revokeObjectURL de l'aperçu source
  releaseSrt();                // URL.revokeObjectURL du .srt téléchargé
  s.listeners.abort();         // retire tous les écouteurs
  s.style?.remove();           // retire le <style> de l'outil
  s.root.innerHTML = '';
  s = null;
}
