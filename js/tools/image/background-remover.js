/**
 * background-remover.js — Suppression d'arrière-plan par IA, 100 % locale.
 * Contrat : export mount(container, ctx) / unmount().
 * Moteur : @imgly/background-removal (ONNX/WASM), chargé à la demande depuis le CDN.
 * Rendu : aperçu damier (transparent) ou couleur unie ; export PNG / WEBP via Canvas.
 */

const LIB_URL = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/+esm';

const MODELS = [
  { id: 'isnet_quint8', label: 'Rapide',    hint: 'Modèle léger (≈ 45 Mo) — plus rapide, détourage moins fin.' },
  { id: 'isnet_fp16',   label: 'Équilibré', hint: 'Compromis vitesse / précision (≈ 85 Mo).' },
  { id: 'isnet',        label: 'Précis',    hint: 'Modèle complet (≈ 175 Mo) — meilleur détourage, plus lent.' },
];

const EXPORTS = [
  { id: 'png',  label: 'PNG',  mime: 'image/png',  ext: 'png',  lossy: false },
  { id: 'webp', label: 'WEBP', mime: 'image/webp', ext: 'webp', lossy: true },
];

const TEMPLATE = `
<div class="imgc bgr">
  <div class="imgc-drop" id="bgr-drop" role="button" tabindex="0" aria-label="Sélectionner une image">
    <i data-lucide="upload-cloud"></i>
    <strong>Glissez-déposez votre image ici</strong>
    <span>ou cliquez pour parcourir — une image à la fois</span>
    <input type="file" id="bgr-input" accept="image/*" hidden>
  </div>
  <div class="imgc-opts">
    <div class="imgc-field">
      <label>Qualité du modèle</label>
      <div class="bgr-seg" id="bgr-models" role="group" aria-label="Qualité du modèle"></div>
    </div>
    <div class="imgc-field">
      <label>Arrière-plan</label>
      <div class="bgr-bgrow">
        <div class="bgr-seg" id="bgr-bgmode" role="group" aria-label="Arrière-plan">
          <button type="button" class="bgr-seg-btn" data-v="transparent" aria-pressed="true">Transparent</button>
          <button type="button" class="bgr-seg-btn" data-v="color" aria-pressed="false">Couleur</button>
        </div>
        <input type="color" class="bgr-color" id="bgr-color" aria-label="Couleur de fond" disabled>
      </div>
    </div>
    <div class="imgc-field">
      <label for="bgr-format">Format d'export</label>
      <select id="bgr-format"></select>
    </div>
    <div class="imgc-field" id="bgr-qfield">
      <label for="bgr-quality">Qualité : <span id="bgr-qval">90</span> %</label>
      <input type="range" id="bgr-quality" min="0" max="100" value="90">
    </div>
  </div>
  <div class="bgr-hint" id="bgr-hint"></div>
  <div class="imgc-actions">
    <button type="button" class="imgc-btn primary" id="bgr-run" disabled>Supprimer l'arrière-plan</button>
    <button type="button" class="imgc-btn primary" id="bgr-download" disabled>Télécharger</button>
    <button type="button" class="imgc-btn" id="bgr-reset" disabled>Réinitialiser</button>
    <button type="button" class="imgc-btn" id="bgr-cancel" disabled>Annuler</button>
  </div>
  <div class="bgr-progress" id="bgr-progress" hidden><div></div></div>
  <div class="imgc-status" id="bgr-plabel" role="status"></div>
  <div class="imgc-status" id="bgr-status" role="status"></div>
  <div class="imgc-viewer" id="bgr-viewer" hidden>
    <div class="imgc-vtitle" id="bgr-vtitle"></div>
    <div class="imgc-cmp checkerboard-bg" id="bgr-stage">
      <img id="bgr-vafter" alt="Après suppression du fond" hidden>
      <img id="bgr-vbefore" alt="Avant suppression du fond">
      <div class="imgc-handle" id="bgr-vhandle" hidden></div>
      <span class="imgc-tag l">Avant</span>
      <span class="imgc-tag r" id="bgr-vtagr" hidden>Après</span>
    </div>
    <input type="range" id="bgr-vrange" min="0" max="100" value="50" aria-label="Curseur de comparaison avant / après">
    <div class="imgc-vinfo" id="bgr-vinfo"></div>
  </div>
</div>`;

/** État du module (null si non monté). */
let s = null;
let libPromise = null;

const q = (id) => s?.root.querySelector('#bgr-' + id);
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'image';
const extOf = (f) => (f.name.includes('.') ? f.name.split('.').pop() : f.type.split('/')[1] || '?').toUpperCase();
const refreshIcons = () => window.lucide?.createIcons();
const abortErr = () => new DOMException('Annulé', 'AbortError');

const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: s.ac.signal });

/** Résout un token CSS en hex (aucune couleur en dur). */
function tokenHex(name) {
  const g = document.createElement('canvas').getContext('2d');
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return g.fillStyle;
}

function setStatus(msg, isError = false) {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', isError);
}

/** pct : nombre = déterminé, null = indéterminé, undefined = masqué. */
function setProgress(pct, label = '') {
  const bar = q('progress');
  if (!bar) return;
  bar.hidden = pct === undefined;
  bar.classList.toggle('is-indeterminate', pct === null);
  bar.firstElementChild.style.width = typeof pct === 'number' ? pct.toFixed(1) + '%' : '';
  q('plabel').textContent = pct === undefined ? '' : label;
}

/* ---------- Bibliothèque IA (lazy) ---------- */

function loadLib() {
  if (!libPromise) {
    libPromise = import(/* @vite-ignore */ LIB_URL).catch((e) => {
      libPromise = null;
      throw new Error('Impossible de charger la bibliothèque IA (connexion requise la première fois).');
    });
  }
  return libPromise;
}

/** Course promesse / signal d'annulation (la lib n'expose pas d'abort natif). */
function race(p, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortErr());
    const onAbort = () => reject(abortErr());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(p).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/* ---------- Ressources ---------- */

function releaseResult() {
  if (!s) return;
  if (s.cutUrl) URL.revokeObjectURL(s.cutUrl);
  s.cutBitmap?.close?.();
  s.cutUrl = null;
  s.cutBitmap = null;
  s.cutBlob = null;
}

function releaseSource() {
  if (s?.srcUrl) URL.revokeObjectURL(s.srcUrl);
  if (s) s.srcUrl = null;
}

function setFile(file) {
  if (!s || s.busy || !file) return;
  if (!file.type.startsWith('image/')) { setStatus('Fichier ignoré (non image).', true); return; }
  releaseResult();
  releaseSource();
  s.file = file;
  s.srcUrl = URL.createObjectURL(file);
  q('vrange').value = 50;
  setStatus('');
  render();
}

/* ---------- Rendu ---------- */

function applyBg() {
  const stage = q('stage');
  const solid = s.bg === 'color';
  stage.classList.toggle('checkerboard-bg', !solid);
  stage.style.backgroundColor = solid ? q('color').value : '';
}

function applySlider() {
  if (!s) return;
  const r = q('vrange');
  const v = r.disabled ? 100 : Number(r.value);
  q('vbefore').style.clipPath = r.disabled ? '' : `inset(0 ${100 - v}% 0 0)`;
  q('vhandle').style.left = v + '%';
}

function renderViewer() {
  if (!s) return;
  q('viewer').hidden = !s.file;
  if (!s.file) return;
  const done = !!s.cutUrl;
  const before = q('vbefore');
  const after = q('vafter');
  if (before.getAttribute('src') !== s.srcUrl) before.src = s.srcUrl;
  if (done) { if (after.getAttribute('src') !== s.cutUrl) after.src = s.cutUrl; } else after.removeAttribute('src');
  after.hidden = !done;
  q('vhandle').hidden = !done;
  q('vtagr').hidden = !done;
  q('vrange').disabled = !done;
  q('vtitle').textContent = s.file.name;
  const dims = done ? `${s.cutBitmap.width} × ${s.cutBitmap.height}` : '—';
  const info = q('vinfo');
  info.replaceChildren();
  const rows = [
    ['Original', extOf(s.file), fmtSize(s.file.size)],
    ['Résultat', done ? 'PNG' : '—', done ? fmtSize(s.cutBlob.size) : '—'],
    ['Dimensions', dims],
  ];
  for (const [label, ...vals] of rows) {
    const row = document.createElement('div');
    const sp = document.createElement('span');
    sp.textContent = label;
    row.append(sp);
    for (const v of vals) {
      const b = document.createElement('b');
      b.textContent = v;
      row.append(b);
    }
    info.append(row);
  }
  applyBg();
  applySlider();
}

function syncSegs() {
  q('models').querySelectorAll('.bgr-seg-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === s.model));
    b.disabled = s.busy;
  });
  q('bgmode').querySelectorAll('.bgr-seg-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === s.bg));
  });
  q('hint').textContent = MODELS.find((m) => m.id === s.model).hint + ' Téléchargé une seule fois (cache navigateur).';
}

function syncButtons() {
  if (!s) return;
  q('run').disabled = s.busy || !s.file;
  q('download').disabled = s.busy || !s.cutBitmap;
  q('reset').disabled = s.busy || !s.file;
  q('cancel').disabled = !s.busy;
  q('format').disabled = s.busy;
  q('quality').disabled = s.busy;
  q('color').disabled = s.bg !== 'color';
  syncSegs();
}

function syncQuality() {
  const fmt = EXPORTS.find((f) => f.id === q('format').value);
  q('qfield').hidden = !fmt.lossy;
  q('qval').textContent = q('quality').value;
}

function render() {
  if (!s) return;
  syncButtons();
  renderViewer();
}

/* ---------- Actions ---------- */

async function removeBg() {
  if (!s || s.busy || !s.file) return;
  const run = new AbortController();
  s.run = run;
  s.busy = true;
  releaseResult();
  setStatus('');
  setProgress(null, 'Chargement de la bibliothèque IA…');
  render();
  const t0 = performance.now();
  const fetched = new Map();
  try {
    const lib = await race(loadLib(), run.signal);
    const remove = lib.removeBackground ?? lib.default;
    const work = remove(s.file, {
      model: s.model,
      output: { format: 'image/png', quality: 1 },
      progress: (key, cur, total) => {
        if (!s || run.signal.aborted) return;
        if (String(key).startsWith('fetch')) {
          fetched.set(key, [cur, total]);
          let c = 0, t = 0;
          for (const [a, b] of fetched.values()) { c += a; t += b; }
          const pct = t ? (c / t) * 100 : null;
          setProgress(pct, `Téléchargement du modèle… ${pct === null ? '' : Math.round(pct) + ' %'}`);
        } else {
          setProgress(null, 'Détourage en cours…');
        }
      },
    });
    const blob = await race(work, run.signal);
    if (!s) return; // démonté pendant le traitement
    const bmp = await createImageBitmap(blob);
    if (!s || run.signal.aborted) { bmp.close(); throw abortErr(); }
    s.cutBlob = blob;
    s.cutBitmap = bmp;
    s.cutUrl = URL.createObjectURL(blob);
    setStatus(`Terminé en ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  } catch (e) {
    if (!s) return;
    if (e?.name === 'AbortError') setStatus('Annulé.');
    else setStatus(e?.message || 'Échec de la suppression du fond.', true);
  } finally {
    if (s && s.run === run) {
      s.busy = false;
      s.run = null;
      setProgress(undefined);
      render();
    }
  }
}

function cancel() {
  if (!s?.busy) return;
  s.run?.abort();
  setStatus('Annulation…');
}

async function exportImage() {
  if (!s?.cutBitmap) return;
  const fmt = EXPORTS.find((f) => f.id === q('format').value);
  const { width: w, height: h } = s.cutBitmap;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (s.bg === 'color') { g.fillStyle = q('color').value; g.fillRect(0, 0, w, h); }
  g.drawImage(s.cutBitmap, 0, 0);
  const blob = await new Promise((res) =>
    c.toBlob(res, fmt.mime, fmt.lossy ? Number(q('quality').value) / 100 : undefined));
  if (!s) return;
  if (!blob || blob.type !== fmt.mime) { setStatus(`${fmt.label} non supporté par ce navigateur.`, true); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName(s.file.name)}-sans-fond.${fmt.ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  const t = setTimeout(() => { URL.revokeObjectURL(url); s?.pending.delete(url); }, 10000);
  s.pending.set(url, t);
  setStatus(`${fmt.label} exporté — ${fmtSize(blob.size)}.`);
}

function reset() {
  if (!s || s.busy) return;
  releaseResult();
  releaseSource();
  s.file = null;
  q('input').value = '';
  setStatus('');
  render();
}

/* ---------- Contrat module ---------- */

export function mount(container, ctx) {
  unmount();
  container.innerHTML = TEMPLATE;
  s = {
    root: container, ctx, ac: new AbortController(), pending: new Map(),
    file: null, srcUrl: null, cutUrl: null, cutBitmap: null, cutBlob: null,
    run: null, busy: false, model: 'isnet_fp16', bg: 'transparent',
  };

  q('models').innerHTML = MODELS
    .map((m) => `<button type="button" class="bgr-seg-btn" data-v="${m.id}" aria-pressed="false">${m.label}</button>`).join('');
  q('format').innerHTML = EXPORTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
  q('color').value = tokenHex('--color-surface');

  const drop = q('drop');
  const input = q('input');
  on(drop, 'click', () => input.click());
  on(drop, 'keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  on(input, 'change', () => { setFile(input.files[0]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) =>
    on(drop, ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    on(drop, ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  on(drop, 'drop', (e) => setFile(e.dataTransfer?.files?.[0]));

  on(q('models'), 'click', (e) => {
    const b = e.target.closest('.bgr-seg-btn');
    if (!b || s.busy) return;
    s.model = b.dataset.v;
    syncSegs();
  });
  on(q('bgmode'), 'click', (e) => {
    const b = e.target.closest('.bgr-seg-btn');
    if (!b) return;
    s.bg = b.dataset.v;
    syncButtons();
    applyBg();
  });
  on(q('color'), 'input', applyBg);
  on(q('format'), 'change', syncQuality);
  on(q('quality'), 'input', syncQuality);
  on(q('vrange'), 'input', applySlider);
  on(q('run'), 'click', removeBg);
  on(q('download'), 'click', exportImage);
  on(q('reset'), 'click', reset);
  on(q('cancel'), 'click', cancel);

  syncQuality();
  render();
  refreshIcons();
}

export function unmount() {
  if (!s) return;
  s.run?.abort();
  s.ac.abort(); // retire tous les listeners
  for (const [url, t] of s.pending) { clearTimeout(t); URL.revokeObjectURL(url); }
  s.pending.clear();
  releaseResult();
  releaseSource();
  s.root.replaceChildren();
  s = null;
}
