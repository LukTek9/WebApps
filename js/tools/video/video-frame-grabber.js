/**
 * video-frame-grabber.js — Outil « Capture d'images Vidéo » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Vidéo (glisser-déposer / sélecteur) → <video controls> + métadonnées + pas fin (-1 s, -1 image, +1 image, +1 s).
 *  2. Capture : <canvas> hors-écran à la résolution native (PNG / JPEG / WebP + qualité), instantanée
 *     ou automatique à intervalle (progression + Annuler).
 *  3. Galerie : miniature, temps, résolution, poids, téléchargement unitaire, suppression, ZIP (JSZip lazy).
 *  4. Chaque objectURL (source, captures) est révoqué à la suppression, au reset et à unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_AUTO_FRAMES = 300;   // garde-fou mémoire pour la capture automatique
const SEEK_TIMEOUT_MS = 15000;
const DEFAULT_FPS = 30;        // pas « 1 image » : fps réel non exposé par <video>
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

const FORMATS = {
  png:  { ext: 'png',  mime: 'image/png',  lossy: false },
  jpeg: { ext: 'jpg',  mime: 'image/jpeg', lossy: true },
  webp: { ext: 'webp', mime: 'image/webp', lossy: true },
};

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (id) => s?.root.querySelector('#vidgrab-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b >= 1048576 ? (b / 1048576).toFixed(2) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');
const fmtMBfile = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const isVideoFile = (f) => f.type.startsWith('video/') || ACCEPT_EXT.includes(extOf(f.name));

function errMsg(e) {
  if (e == null) return 'erreur inconnue';
  if (typeof e === 'string') return e || 'erreur inconnue';
  if (e.message) return String(e.message);
  if (e.type) return `événement « ${e.type} »`;
  return String(e) || 'erreur inconnue';
}

/** Secondes → « m:ss.cc » (ou « h:mm:ss.cc » à partir d'une heure). */
function fmtTime(t) {
  const cs = Math.round(Math.max(0, Number(t) || 0) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = ((cs % 6000) / 100).toFixed(2).padStart(5, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Temps utilisable dans un nom de fichier : « 1:23.45 » → « 1-23_45 ». */
const fileTime = (t) => fmtTime(t).replace(/:/g, '-').replace('.', '_');

/* ==========================================================================
   UI : statut / progression / occupation
   ========================================================================== */
function setStatus(msg, kind) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', kind === 'error');
  el.classList.toggle('status-success', kind === 'ok');
  el.classList.toggle('status-muted', !kind);
}

function setProgress(p) {
  const bar = q('bar'); if (!bar) return;
  bar.classList.toggle('is-on', p !== false);
  bar.classList.toggle('is-indeterminate', p === null);
  bar.firstElementChild.style.width = typeof p === 'number' ? Math.round(clamp(p, 0, 1) * 100) + '%' : '';
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.root.querySelectorAll('.vidgrab-step button, .vidgrab-panel select, .vidgrab-panel input, #vidgrab-grab, #vidgrab-auto').forEach((el) => { el.disabled = busy; });
  q('reset').disabled = busy;
  q('zip').disabled = busy;
  q('cancel').hidden = !busy;
  if (!busy) syncQualityUi();
}

function syncQualityUi() {
  if (!s) return;
  const lossy = FORMATS[q('format').value].lossy;
  q('quality').disabled = !lossy || s.busy;
  q('quality-val').textContent = lossy ? Math.round(Number(q('quality').value) * 100) + ' %' : 'sans perte';
}

/* ==========================================================================
   Gestion mémoire (objectURL)
   ========================================================================== */
function releaseSrc() {
  if (!s || !s.srcUrl) return;
  URL.revokeObjectURL(s.srcUrl);
  s.srcUrl = null;
}

function resetVideoEl(v) {
  if (!v) return;
  v.pause();
  v.removeAttribute('src');
  v.load();
}

/** Révoque l'URL d'une capture et la retire de l'état (le DOM est mis à jour par renderGallery). */
function revokeFrame(f) {
  if (f.url) { URL.revokeObjectURL(f.url); f.url = null; }
}

function clearFrames() {
  if (!s) return;
  s.frames.forEach(revokeFrame);
  s.frames = [];
  renderGallery();
}

/* ==========================================================================
   Galerie
   ========================================================================== */
function renderGallery() {
  if (!s) return;
  const grid = q('grid');
  grid.replaceChildren();
  q('gallery').hidden = s.frames.length === 0;
  q('count').textContent = `${s.frames.length} capture${s.frames.length > 1 ? 's' : ''}`;
  q('zip').hidden = s.frames.length < 2;

  for (const f of s.frames) {
    const item = document.createElement('div');
    item.className = 'vidgrab-item';

    const img = document.createElement('img');
    img.className = 'vidgrab-thumb';
    img.src = f.url;
    img.alt = `Capture à ${fmtTime(f.time)}`;
    img.loading = 'lazy';

    const info = document.createElement('div');
    info.className = 'vidgrab-item-info';
    const t = document.createElement('b'); t.textContent = fmtTime(f.time);
    const d = document.createElement('span'); d.textContent = `${f.w} × ${f.h} — ${fmtMB(f.blob.size)} — ${f.ext.toUpperCase()}`;
    info.append(t, d);

    const actions = document.createElement('div');
    actions.className = 'vidgrab-item-actions';
    const dl = document.createElement('a');
    dl.className = 'btn-secondary';
    dl.href = f.url;
    dl.download = f.name;
    dl.textContent = '⬇ Télécharger';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn-remove-file';
    rm.textContent = 'Retirer';
    rm.disabled = s.busy;
    rm.addEventListener('click', () => removeFrame(f.id));
    actions.append(dl, rm);

    item.append(img, info, actions);
    grid.appendChild(item);
  }
}

function removeFrame(id) {
  if (!s || s.busy) return;
  const i = s.frames.findIndex((f) => f.id === id);
  if (i < 0) return;
  revokeFrame(s.frames[i]);
  s.frames.splice(i, 1);
  renderGallery();
  setStatus(s.frames.length ? 'Capture retirée.' : 'Aucune capture.');
}

/* ==========================================================================
   Capture
   ========================================================================== */
/** Dessine l'image courante à la résolution native et encode selon le format choisi. */
async function captureCurrent() {
  const v = q('src');
  const fmt = FORMATS[q('format').value];
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) throw new Error('image vidéo indisponible');
  const time = v.currentTime;

  const canvas = document.createElement('canvas'); // hors-écran (jamais inséré dans le DOM)
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.drawImage(v, 0, 0, w, h);
  const quality = fmt.lossy ? clamp(Number(q('quality').value) || 0.92, 0.05, 1) : undefined;
  const encode = (f, qual) => new Promise((res) => canvas.toBlob(res, f.mime, qual));
  let outFmt = fmt;
  let blob = await encode(fmt, quality);
  if (fmt.mime === 'image/webp' && (!blob || blob.type !== fmt.mime)) { // Safari : WebP non encodable → repli PNG
    outFmt = FORMATS.png;
    blob = await encode(outFmt);
  }
  canvas.width = canvas.height = 0; // libère le buffer
  if (!blob) throw new Error('encodage impossible (image trop grande ?)');
  if (blob.type && blob.type !== outFmt.mime) throw new Error(`format ${outFmt.ext.toUpperCase()} non pris en charge par ce navigateur`);

  const base = `${s.base}_frame_${fileTime(time)}`;
  let name = `${base}.${outFmt.ext}`;
  if (s.frames.some((f) => f.name === name)) name = `${base}_${s.frames.length + 1}.${outFmt.ext}`; // doublon (même temps)
  s.frames.push({ id: ++s.seq, time, w, h, blob, ext: outFmt.ext, name, url: URL.createObjectURL(blob) });
}

async function grabOne() {
  if (!s?.file || s.busy) return;
  const st = s;
  try {
    q('src').pause();
    await captureCurrent();
    if (s !== st) return;
    renderGallery();
    setStatus(`Capture ajoutée (${fmtTime(st.frames.at(-1).time)}).`, 'ok');
  } catch (e) {
    if (s === st) setStatus(`Capture impossible (${errMsg(e)}).`, 'error');
  }
}

/** Positionne la vidéo à `t` et attend l'événement « seeked ». */
function seekTo(v, t, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new Error('délai dépassé lors du déplacement dans la vidéo')), SEEK_TIMEOUT_MS);
    const onSeeked = () => done(resolve);
    const onAbort = () => done(reject, abortErr());
    const done = (fn, e) => {
      clearTimeout(timer);
      v.removeEventListener('seeked', onSeeked);
      signal?.removeEventListener('abort', onAbort);
      fn(e);
    };
    if (signal?.aborted) return done(reject, abortErr());
    signal?.addEventListener('abort', onAbort, { once: true });
    v.addEventListener('seeked', onSeeked, { once: true });
    v.currentTime = t;
  });
}

/** Capture automatique : de la position actuelle jusqu'à la fin, toutes les N secondes. */
async function grabAuto() {
  if (!s?.file || s.busy) return;
  const st = s;
  const v = q('src');
  const step = Number(q('interval').value);
  if (!(step >= 0.1)) { setStatus('Intervalle invalide (minimum 0,1 s).', 'error'); return; }
  const dur = v.duration;
  const from = v.currentTime;
  const times = [];
  for (let t = from; t <= dur + 1e-6 && times.length < MAX_AUTO_FRAMES; t += step) times.push(Math.min(t, Math.max(0, dur - 0.001)));
  if (!times.length) { setStatus('Aucune capture à effectuer depuis cette position.', 'error'); return; }

  st.abort = new AbortController();
  const { signal } = st.abort;
  setBusy(true); setProgress(0);
  v.pause();
  let n = 0;
  try {
    for (const t of times) {
      await seekTo(v, t, signal);
      await captureCurrent();
      n++;
      if (s !== st) return;
      setProgress(n / times.length);
      setStatus(`Capture automatique… ${n} / ${times.length}`);
    }
    renderGallery();
    setStatus(`${n} capture${n > 1 ? 's' : ''} ajoutée${n > 1 ? 's' : ''}${times.length === MAX_AUTO_FRAMES ? ` (limite de ${MAX_AUTO_FRAMES} atteinte)` : ''}.`, 'ok');
  } catch (e) {
    if (s !== st) return;
    renderGallery();
    if (isAbort(e)) setStatus(`Capture automatique annulée (${n} capture${n > 1 ? 's' : ''} conservée${n > 1 ? 's' : ''}).`);
    else setStatus(`Capture automatique interrompue (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); setProgress(false); try { v.currentTime = from; } catch { /* ignoré */ } }
  }
}

/* ==========================================================================
   ZIP (JSZip lazy)
   ========================================================================== */
let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipPromise ??= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = JSZIP_URL;
    sc.async = true;
    sc.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip introuvable')));
    sc.onerror = () => { jszipPromise = null; sc.remove(); reject(new Error('chargement CDN impossible')); };
    document.head.appendChild(sc);
  });
  return jszipPromise;
}

async function downloadZip() {
  if (!s || s.busy || s.frames.length < 2) return;
  const st = s;
  const btn = q('zip');
  btn.disabled = true;
  setStatus('Création de l\'archive ZIP…'); setProgress(null);
  try {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const used = new Set();
    for (const f of st.frames) {
      let n = f.name;
      for (let i = 2; used.has(n); i++) n = f.name.replace(/(\.[^.]+)$/, `_${i}$1`);
      used.add(n);
      zip.file(n, f.blob, { binary: true });
    }
    // Images déjà compressées : STORE évite un double calcul inutile
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => { if (s === st) setProgress(m.percent / 100); });
    if (s !== st) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${st.base}_frames.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); // laisse le temps au navigateur de lancer le téléchargement
    setProgress(false);
    setStatus(`Archive ZIP créée (${st.frames.length} images, ${fmtMBfile(blob.size)}).`, 'ok');
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    setStatus(`ZIP impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) btn.disabled = false;
  }
}

/* ==========================================================================
   Pas fin / position
   ========================================================================== */
const frameStep = () => 1 / clamp(Number(q('fps').value) || DEFAULT_FPS, 1, 240);

function stepBy(delta) {
  const v = q('src');
  if (!s?.file || s.busy) return;
  v.pause();
  v.currentTime = clamp(v.currentTime + delta, 0, v.duration || 0);
}

function updatePos() {
  const v = q('src'); if (!v) return;
  q('pos').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
}

/* ==========================================================================
   Chargement fichier / métadonnées
   ========================================================================== */
function discard() {
  if (!s) return;
  s.loading++;
  s.abort?.abort(); s.abort = null;
  clearFrames();
  resetVideoEl(q('src'));
  releaseSrc();
  s.file = null; s.meta = null; s.base = 'video';
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  setBusy(false);
  setProgress(false);
}

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

async function loadFile(file) {
  if (!s || !file || s.busy) return;
  if (!isVideoFile(file)) {
    setStatus('Format non pris en charge : utilisez MP4, WEBM, MOV, AVI ou MKV.', 'error');
    return;
  }
  discard();
  const token = ++s.loading;
  setStatus(`Lecture de « ${file.name} »…`); setProgress(null);

  s.srcUrl = URL.createObjectURL(file);
  const meta = await readMeta(s.srcUrl);
  if (!s || s.loading !== token) return;

  if (!meta || !Number.isFinite(meta.duration)) {
    // Capture Canvas impossible sans décodage natif (typiquement AVI / MKV selon le navigateur)
    resetVideoEl(q('src')); releaseSrc();
    q('file').value = '';
    setProgress(false);
    setStatus('Lecture native impossible dans ce navigateur (codec ou conteneur non pris en charge) : capture indisponible. Convertissez d\'abord la vidéo en MP4 ou WEBM.', 'error');
    return;
  }

  s.file = file; s.meta = meta;
  s.base = sanitize(file.name.replace(/\.[^.]+$/, ''));
  q('drop').hidden = true;
  q('editor').hidden = false;
  q('name').textContent = file.name;
  q('meta').textContent = extOf(file.name).toUpperCase() || (file.type || 'vidéo');
  q('st-dur').textContent = fmtTime(meta.duration);
  q('st-res').textContent = `${meta.width} × ${meta.height}`;
  q('st-size').textContent = fmtMBfile(file.size);
  updatePos();
  setBusy(false);
  setProgress(false);
  setStatus('Positionnez la vidéo puis capturez l\'image courante.');
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vidgrab" id="vidgrab-root">
  <div class="vidgrab-drop" id="vidgrab-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier vidéo">
    <i data-lucide="camera" class="icon-xl"></i>
    <strong>Glissez une vidéo ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV</small>
    <input type="file" id="vidgrab-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" hidden>
  </div>

  <div class="vidgrab-editor" id="vidgrab-editor" hidden>
    <div class="vidgrab-head">
      <div class="vidgrab-file"><b class="vidgrab-name" id="vidgrab-name"></b><small class="vidgrab-meta" id="vidgrab-meta"></small></div>
      <button class="btn-remove-file" id="vidgrab-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <video class="vidgrab-video" id="vidgrab-src" controls preload="auto" playsinline></video>

    <div class="vidgrab-info">
      <div class="vidgrab-stat"><small>Durée</small><b id="vidgrab-st-dur">—</b></div>
      <div class="vidgrab-stat"><small>Résolution native</small><b id="vidgrab-st-res">—</b></div>
      <div class="vidgrab-stat"><small>Taille</small><b id="vidgrab-st-size">—</b></div>
    </div>

    <div class="vidgrab-step">
      <button class="btn-secondary" id="vidgrab-m1s" type="button" title="Reculer d'une seconde">−1 s</button>
      <button class="btn-secondary" id="vidgrab-m1f" type="button" title="Reculer d'une image">−1 image</button>
      <span class="vidgrab-pos" id="vidgrab-pos">0:00.00 / 0:00.00</span>
      <button class="btn-secondary" id="vidgrab-p1f" type="button" title="Avancer d'une image">+1 image</button>
      <button class="btn-secondary" id="vidgrab-p1s" type="button" title="Avancer d'une seconde">+1 s</button>
    </div>

    <div class="vidgrab-panel">
      <label class="vidgrab-field">Format de sortie
        <select id="vidgrab-format">
          <option value="png" selected>PNG (sans perte)</option>
          <option value="jpeg">JPEG</option>
          <option value="webp">WebP</option>
        </select>
      </label>
      <label class="vidgrab-field">Qualité : <span id="vidgrab-quality-val">sans perte</span>
        <input type="range" id="vidgrab-quality" min="0.3" max="1" step="0.01" value="0.92" disabled>
      </label>
      <label class="vidgrab-field">Images/s de la vidéo (pas « 1 image »)
        <input type="number" id="vidgrab-fps" min="1" max="240" step="1" value="${DEFAULT_FPS}">
      </label>
      <label class="vidgrab-field">Intervalle auto (secondes)
        <input type="number" id="vidgrab-interval" min="0.1" step="0.1" value="1">
      </label>
    </div>

    <div class="vidgrab-actions">
      <button class="btn-primary" id="vidgrab-grab" type="button"><i data-lucide="camera"></i> Capturer l'image courante</button>
      <button class="btn-secondary" id="vidgrab-auto" type="button"><i data-lucide="timer"></i> Capture automatique (jusqu'à la fin)</button>
      <button class="btn-secondary" id="vidgrab-cancel" type="button" hidden>Annuler</button>
    </div>
  </div>

  <div>
    <div class="vidgrab-bar" id="vidgrab-bar"><i></i></div>
    <p class="vidgrab-status status-muted" id="vidgrab-status">Déposez une vidéo pour commencer.</p>
  </div>

  <div class="vidgrab-gallery" id="vidgrab-gallery" hidden>
    <div class="vidgrab-gallery-head">
      <span class="vidgrab-count" id="vidgrab-count"></span>
      <button class="btn-primary" id="vidgrab-zip" type="button" hidden><i data-lucide="file-archive"></i> Tout télécharger (ZIP)</button>
    </div>
    <div class="vidgrab-grid" id="vidgrab-grid"></div>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount();
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, file: null, meta: null, base: 'video',
    srcUrl: null, abort: null, busy: false, loading: 0, seq: 0, frames: [],
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root');
  const drop = q('drop'), file = q('file'), v = q('src');

  drop.addEventListener('click', () => file.click(), opt);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } }, opt);
  file.addEventListener('change', () => { const f = file.files?.[0]; if (f) loadFile(f); }, opt);
  root.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); }, opt);
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) drop.classList.remove('is-over'); }, opt);
  root.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f);
  }, opt);

  // Position / pas fin
  ['timeupdate', 'seeked', 'loadedmetadata'].forEach((ev) => v.addEventListener(ev, updatePos, opt));
  q('m1s').addEventListener('click', () => stepBy(-1), opt);
  q('p1s').addEventListener('click', () => stepBy(1), opt);
  q('m1f').addEventListener('click', () => stepBy(-frameStep()), opt);
  q('p1f').addEventListener('click', () => stepBy(frameStep()), opt);

  // Options
  q('format').addEventListener('change', syncQualityUi, opt);
  q('quality').addEventListener('input', syncQualityUi, opt);

  // Actions
  q('grab').addEventListener('click', grabOne, opt);
  q('auto').addEventListener('click', grabAuto, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('zip').addEventListener('click', downloadZip, opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez une vidéo pour commencer.');
  }, opt);

  syncQualityUi();
  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide une lecture de métadonnées en cours
  s.abort?.abort();            // stoppe la capture automatique
  s.frames.forEach(revokeFrame); // URL.revokeObjectURL de toutes les captures
  s.frames = [];
  resetVideoEl(q('src'));      // pause <video> source
  releaseSrc();                // URL.revokeObjectURL de la source
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
