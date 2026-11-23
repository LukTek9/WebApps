/**
 * image-converter.js — Convertisseur d'images 100 % local (Canvas API).
 * Contrat : export mount(container, ctx) / unmount().
 * Formats de sortie : PNG, JPEG, WEBP (natifs canvas), BMP et ICO (encodeurs maison).
 */

const ICO_MAX = 256; // taille max d'une entrée ICO

const FORMATS = [
  { id: 'png',  label: 'PNG',  mime: 'image/png',    ext: 'png', lossy: false },
  { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg',   ext: 'jpg', lossy: true },
  { id: 'webp', label: 'WEBP', mime: 'image/webp',   ext: 'webp', lossy: true },
  { id: 'bmp',  label: 'BMP',  mime: 'image/bmp',    ext: 'bmp', lossy: false },
  { id: 'ico',  label: 'ICO',  mime: 'image/x-icon', ext: 'ico', lossy: false },
];

const STATUS_LABEL = {
  pending: 'En attente',
  converting: 'Conversion…',
  done: 'Terminé',
  error: 'Erreur',
};

const TEMPLATE = `
<div class="imgc">
  <div class="imgc-drop" id="imgc-drop" role="button" tabindex="0" aria-label="Sélectionner des images">
    <i data-lucide="upload-cloud"></i>
    <strong>Glissez-déposez vos images ici</strong>
    <span>ou cliquez pour parcourir — plusieurs fichiers possibles</span>
    <input type="file" id="imgc-input" accept="image/*" multiple hidden>
  </div>
  <div class="imgc-opts">
    <div class="imgc-field">
      <label for="imgc-format">Format de sortie</label>
      <select id="imgc-format"></select>
    </div>
    <div class="imgc-field" id="imgc-qfield">
      <label for="imgc-quality">Qualité : <span id="imgc-qval">90</span> %</label>
      <input type="range" id="imgc-quality" min="0" max="100" value="90">
    </div>
  </div>
  <div class="imgc-actions">
    <button type="button" class="imgc-btn primary" id="imgc-convert" disabled>Convertir tout</button>
    <button type="button" class="imgc-btn" id="imgc-reset" disabled>Réinitialiser</button>
    <button type="button" class="imgc-btn" id="imgc-cancel" disabled>Annuler</button>
  </div>
  <div class="imgc-status" id="imgc-status" role="status"></div>
  <div class="imgc-viewer" id="imgc-viewer" hidden>
    <div class="imgc-vtitle" id="imgc-vtitle"></div>
    <div class="imgc-cmp checkerboard-bg">
      <img id="imgc-vafter" alt="Après conversion" hidden>
      <img id="imgc-vbefore" alt="Avant conversion">
      <div class="imgc-handle" id="imgc-vhandle" hidden></div>
      <span class="imgc-tag l">Avant</span>
      <span class="imgc-tag r" id="imgc-vtagr" hidden>Après</span>
    </div>
    <input type="range" id="imgc-vrange" min="0" max="100" value="50" aria-label="Curseur de comparaison avant / après">
    <div class="imgc-vinfo" id="imgc-vinfo"></div>
  </div>
  <div class="imgc-grid" id="imgc-grid"></div>
</div>`;

/** État du module (null si non monté). */
let s = null;

const q = (id) => s?.root.querySelector('#imgc-' + id);
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'image';
const refreshIcons = () => window.lucide?.createIcons();

function setStatus(msg, isError = false) {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', isError);
}

/* ---------- Décodage / encodage ---------- */

async function decode(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* repli <img> */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
    img.src = url;
  });
}

const toBlob = (canvas, mime, quality) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encodage impossible'))), mime, quality));

function makeCanvas(w, h, flatten) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (flatten) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); } // pas d'alpha → fond blanc
  return { c, g };
}

/** BMP 24 bits (bottom-up, lignes alignées sur 4 octets). */
function encodeBmp(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const imgSize = rowSize * h;
  const buf = new ArrayBuffer(54 + imgSize);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x42); dv.setUint8(1, 0x4d);
  dv.setUint32(2, 54 + imgSize, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, imgSize, true);
  dv.setUint32(38, 2835, true);
  dv.setUint32(42, 2835, true);
  const px = new Uint8Array(buf, 54);
  for (let y = 0; y < h; y++) {
    let o = (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[o++] = data[i + 2]; px[o++] = data[i + 1]; px[o++] = data[i];
    }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

/** ICO = en-tête + 1 entrée contenant un PNG (supporté depuis Vista). */
async function encodeIco(canvas) {
  const png = new Uint8Array(await (await toBlob(canvas, 'image/png')).arrayBuffer());
  const { width: w, height: h } = canvas;
  const head = new ArrayBuffer(22);
  const dv = new DataView(head);
  dv.setUint16(2, 1, true);               // type = icône
  dv.setUint16(4, 1, true);               // 1 image
  dv.setUint8(6, w >= 256 ? 0 : w);
  dv.setUint8(7, h >= 256 ? 0 : h);
  dv.setUint16(10, 1, true);              // plans
  dv.setUint16(12, 32, true);             // bpp
  dv.setUint32(14, png.length, true);
  dv.setUint32(18, 22, true);             // offset des données
  return new Blob([head, png], { type: 'image/x-icon' });
}

async function convertFile(file, fmt, quality) {
  const src = await decode(file);
  try {
    let w = src.naturalWidth ?? src.width;
    let h = src.naturalHeight ?? src.height;
    if (fmt.id === 'ico' && Math.max(w, h) > ICO_MAX) {
      const k = ICO_MAX / Math.max(w, h);
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
    const { c, g } = makeCanvas(w, h, fmt.id === 'jpeg' || fmt.id === 'bmp');
    g.drawImage(src, 0, 0, w, h);
    if (fmt.id === 'bmp') return encodeBmp(c);
    if (fmt.id === 'ico') return await encodeIco(c);
    let blob = null, encErr = null;
    try { blob = await toBlob(c, fmt.mime, fmt.lossy ? quality : undefined); } catch (e) { encErr = e; }
    if (!blob || blob.type !== fmt.mime) {
      if (fmt.id === 'webp') blob = await toBlob(c, 'image/png'); // Safari : WebP non encodable → repli PNG (.png)
      else if (encErr) throw encErr;
      else throw new Error(`${fmt.label} non supporté par ce navigateur`);
    }
    return blob;
  } finally {
    src.close?.(); // libère l'ImageBitmap
  }
}

/* ---------- Gestion des éléments ---------- */

function releaseOutput(item) {
  if (item.outUrl) URL.revokeObjectURL(item.outUrl);
  item.outUrl = null;
  item.outName = '';
  item.outSize = 0;
}

function releaseItem(item) {
  releaseOutput(item);
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  item.thumbUrl = null;
}

function addFiles(fileList) {
  if (!s || s.busy) return;
  const imgs = [...fileList].filter((f) => f.type.startsWith('image/'));
  const skipped = fileList.length - imgs.length;
  for (const file of imgs) {
    s.items.push({ id: ++s.seq, file, thumbUrl: URL.createObjectURL(file), status: 'pending', outUrl: null, outName: '', outSize: 0, error: '' });
  }
  setStatus(skipped ? `${skipped} fichier(s) ignoré(s) (non image).` : '', skipped > 0 && !imgs.length);
  render();
}

function removeItem(id) {
  if (!s || s.busy) return;
  const i = s.items.findIndex((it) => it.id === id);
  if (i < 0) return;
  releaseItem(s.items[i]);
  s.items.splice(i, 1);
  render();
}

function render() {
  if (!s) return;
  const grid = q('grid');
  pickView();
  grid.replaceChildren();
  for (const it of s.items) {
    const card = document.createElement('div');
    card.className = 'imgc-card';

    const img = document.createElement('img');
    img.className = 'imgc-thumb checkerboard-bg';
    img.src = it.thumbUrl;
    img.alt = '';
    img.title = 'Comparer avant / après';
    if (it.id === s.viewId) card.classList.add('is-active');
    img.addEventListener('click', () => { s.viewId = it.id; render(); });

    const name = document.createElement('div');
    name.className = 'imgc-name';
    name.textContent = it.file.name;
    name.title = it.file.name;

    const meta = document.createElement('div');
    meta.className = 'imgc-meta';
    const size = document.createElement('span');
    size.textContent = it.outUrl ? `${fmtSize(it.file.size)} → ${fmtSize(it.outSize)}` : fmtSize(it.file.size);
    const state = document.createElement('span');
    state.className = 'imgc-state';
    state.dataset.s = it.status;
    state.textContent = STATUS_LABEL[it.status];
    if (it.status === 'error') state.title = it.error;
    meta.append(size, state);

    const row = document.createElement('div');
    row.className = 'imgc-row';
    if (it.outUrl) {
      const a = document.createElement('a');
      a.className = 'imgc-btn primary';
      a.href = it.outUrl;
      a.download = it.outName;
      a.textContent = 'Télécharger';
      row.append(a);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'imgc-btn';
    rm.textContent = 'Retirer';
    rm.disabled = s.busy;
    rm.addEventListener('click', () => removeItem(it.id));
    row.append(rm);

    card.append(img, name, meta);
    if (it.status === 'error') {
      const err = document.createElement('div');
      err.className = 'imgc-meta';
      err.textContent = it.error;
      card.append(err);
    }
    card.append(row);
    grid.append(card);
  }
  syncButtons();
  renderViewer();
}

/* ---------- Visionneuse comparative avant / après ---------- */

const escH = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const extOf = (f) => (f.name.includes('.') ? f.name.split('.').pop() : f.type.split('/')[1] || '?').toUpperCase();

/** Sélection par défaut : premier fichier converti. */
function pickView() {
  if (!s.items.some((x) => x.id === s.viewId)) s.viewId = s.items.find((x) => x.outUrl)?.id ?? null;
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
  const it = s.items.find((x) => x.id === s.viewId);
  q('viewer').hidden = !it;
  if (!it) return;
  const done = !!it.outUrl;
  const before = q('vbefore');
  const after = q('vafter');
  if (before.getAttribute('src') !== it.thumbUrl) before.src = it.thumbUrl;
  if (done) { if (after.getAttribute('src') !== it.outUrl) after.src = it.outUrl; } else after.removeAttribute('src');
  after.hidden = !done;
  q('vhandle').hidden = !done;
  q('vtagr').hidden = !done;
  q('vrange').disabled = !done;
  q('vtitle').textContent = it.file.name;

  const targetLabel = done ? it.outFmt : FORMATS.find((f) => f.id === q('format').value).label;
  const gain = done ? Math.round((1 - it.outSize / it.file.size) * 100) : null;
  const gainTxt = gain === null ? '—' : gain > 0 ? `-${gain} %` : gain < 0 ? `+${-gain} %` : '0 %';
  q('vinfo').innerHTML = `
    <div><span>Original</span><b>${escH(extOf(it.file))}</b><b>${fmtSize(it.file.size)}</b></div>
    <div><span>${done ? 'Converti' : 'Cible'}</span><b>${escH(targetLabel)}</b><b>${done ? fmtSize(it.outSize) : '—'}</b></div>
    <div><span>Variation</span><b class="${gain > 0 ? 'gain' : ''}">${gainTxt}</b></div>`;
  applySlider();
}

function syncButtons() {
  if (!s) return;
  q('convert').disabled = s.busy || !s.items.length;
  q('reset').disabled = s.busy || !s.items.length;
  q('cancel').disabled = !s.busy;
  q('format').disabled = s.busy;
  q('quality').disabled = s.busy;
}

function syncQuality() {
  const fmt = FORMATS.find((f) => f.id === q('format').value);
  q('qfield').hidden = !fmt.lossy;
  q('qval').textContent = q('quality').value;
}

/* ---------- Actions ---------- */

async function convertAll() {
  if (!s || s.busy || !s.items.length) return;
  const fmt = FORMATS.find((f) => f.id === q('format').value);
  const quality = Number(q('quality').value) / 100;
  s.busy = true;
  s.cancel = false;
  syncButtons();

  let done = 0, failed = 0, fellBack = 0;
  const total = s.items.length;
  for (const it of s.items) {
    if (s.cancel) break;
    releaseOutput(it);
    it.status = 'converting';
    it.error = '';
    setStatus(`Conversion ${done + failed + 1}/${total}…`);
    render();
    try {
      const blob = await convertFile(it.file, fmt, quality);
      if (!s) return; // démonté pendant la conversion
      const eff = FORMATS.find((f) => f.mime === blob.type) || fmt; // format réellement produit (repli PNG Safari)
      if (eff !== fmt) fellBack++;
      it.outUrl = URL.createObjectURL(blob);
      it.outSize = blob.size;
      it.outName = `${baseName(it.file.name)}.${eff.ext}`;
      it.outFmt = eff.label;
      it.status = 'done';
      done++;
    } catch (e) {
      if (!s) return;
      it.status = 'error';
      it.error = e?.message || 'Échec de conversion';
      failed++;
    }
    render();
  }
  if (!s) return;
  const canceled = s.cancel;
  for (const it of s.items) if (it.status === 'converting') it.status = 'pending';
  s.busy = false;
  s.cancel = false;
  render();
  setStatus(
    `${canceled ? 'Annulé — ' : ''}${done} converti(s)${failed ? `, ${failed} erreur(s)` : ''} sur ${total}.${fellBack ? ` ${fmt.label} non pris en charge par ce navigateur : ${fellBack} fichier(s) généré(s) en PNG.` : ''}`,
    failed > 0 && !done,
  );
}

function cancel() {
  if (!s?.busy) return;
  s.cancel = true; // stoppe avant le prochain fichier
  setStatus('Annulation…');
}

function reset() {
  if (!s || s.busy) return;
  s.items.forEach(releaseItem);
  s.items = [];
  q('input').value = '';
  setStatus('');
  render();
}

/* ---------- Contrat module ---------- */

export function mount(container, ctx) {
  unmount();
  container.innerHTML = TEMPLATE;
  s = { root: container, ctx, items: [], seq: 0, busy: false, cancel: false };

  const fmtSel = q('format');
  fmtSel.innerHTML = FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');

  const drop = q('drop');
  const input = q('input');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer?.files ?? []));

  fmtSel.addEventListener('change', syncQuality);
  fmtSel.addEventListener('change', renderViewer);
  q('vrange').addEventListener('input', applySlider);
  q('quality').addEventListener('input', syncQuality);
  q('convert').addEventListener('click', convertAll);
  q('reset').addEventListener('click', reset);
  q('cancel').addEventListener('click', cancel);

  syncQuality();
  render();
  refreshIcons();
}

export function unmount() {
  if (!s) return;
  s.items.forEach(releaseItem); // revokeObjectURL
  s.root.replaceChildren();
  s = null;
}
