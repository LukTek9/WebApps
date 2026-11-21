/**
 * image-watermark.js — Ajout de filigrane (texte / logo) 100 % local via Canvas.
 * Contrat : export mount(container, ctx) / unmount().
 */

const POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const POS_LABEL = {
  tl: 'Haut gauche', tc: 'Haut centre', tr: 'Haut droite',
  ml: 'Milieu gauche', mc: 'Centre', mr: 'Milieu droite',
  bl: 'Bas gauche', bc: 'Bas centre', br: 'Bas droite',
};
const EXPORT_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

let s = null; // état du module (null = démonté)

const q = (id) => s?.root.querySelector('#wmk-' + id);
const refreshIcons = () => window.lucide?.createIcons();
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'image';
const num = (id, fb) => { const v = parseFloat(q(id)?.value); return Number.isFinite(v) ? v : fb; };

function setStatus(msg = '', isError = false) {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#dc2626' : 'inherit';
}

/** Charge un File en HTMLImageElement ; retourne { img, url }. */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible : ' + file.name)); };
    img.src = url;
  });
}

/** Lit les réglages courants depuis l'UI. */
function readOptions() {
  return {
    type: s.type,
    text: q('text').value,
    color: q('color').value,
    fontSize: num('fsize', 48),
    textOpacity: num('t-opacity', 50) / 100,
    textAngle: num('t-angle', -30),
    logoScale: num('l-scale', 25) / 100,
    logoOpacity: num('l-opacity', 50) / 100,
    logoAngle: num('l-angle', 0),
    pos: s.pos,
    tile: q('tile').checked,
  };
}

/** Dessine un élément (texte ou logo) centré sur (cx, cy) avec rotation. Retourne rien. */
function measure(g, o) {
  if (o.type === 'text') {
    g.font = `bold ${o.fontSize}px sans-serif`;
    return { w: g.measureText(o.text).width, h: o.fontSize * 1.2 };
  }
  const w = s.logo.naturalWidth ? s.baseW * o.logoScale : 0;
  return { w, h: w * (s.logo.naturalHeight / s.logo.naturalWidth) };
}

function drawItem(g, o, cx, cy, size) {
  const angle = ((o.type === 'text' ? o.textAngle : o.logoAngle) * Math.PI) / 180;
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);
  if (o.type === 'text') {
    g.fillStyle = o.color;
    g.font = `bold ${o.fontSize}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(o.text, 0, 0);
  } else {
    g.drawImage(s.logo, -size.w / 2, -size.h / 2, size.w, size.h);
  }
  g.restore();
}

/** Moteur : composite image + filigrane sur `canvas`. flatten = fond blanc (JPEG). */
function composite(canvas, o, flatten = false) {
  const w = s.img.naturalWidth, h = s.img.naturalHeight;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (flatten) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
  g.drawImage(s.img, 0, 0, w, h);

  const hasMark = o.type === 'text' ? o.text.trim() !== '' : !!s.logo;
  if (!hasMark) return;
  s.baseW = w;
  const size = measure(g, o);
  if (size.w <= 0 || size.h <= 0) return;

  g.save();
  g.globalAlpha = o.type === 'text' ? o.textOpacity : o.logoOpacity;
  const angle = ((o.type === 'text' ? o.textAngle : o.logoAngle) * Math.PI) / 180;

  if (o.tile) {
    // Motif répétitif : grille couvrant le canevas, pivotée autour du centre.
    const stepX = size.w * 1.5, stepY = size.h * 2;
    const diag = Math.hypot(w, h);
    g.translate(w / 2, h / 2);
    g.rotate(angle);
    let row = 0;
    for (let y = -diag / 2; y <= diag / 2; y += stepY, row++) {
      const off = row % 2 ? stepX / 2 : 0; // décalage en quinconce
      for (let x = -diag / 2 - off; x <= diag / 2; x += stepX) drawItem(g, { ...o, textAngle: 0, logoAngle: 0 }, x, y, size);
    }
  } else {
    const a = Math.abs(angle);
    const bw = Math.abs(size.w * Math.cos(a)) + Math.abs(size.h * Math.sin(a));
    const bh = Math.abs(size.w * Math.sin(a)) + Math.abs(size.h * Math.cos(a));
    const m = Math.min(w, h) * 0.02;
    const col = o.pos[1], row = o.pos[0];
    const cx = col === 'l' ? m + bw / 2 : col === 'r' ? w - m - bw / 2 : w / 2;
    const cy = row === 't' ? m + bh / 2 : row === 'b' ? h - m - bh / 2 : h / 2;
    drawItem(g, o, cx, cy, size);
  }
  g.restore();
}

function renderPreview() {
  if (!s?.img) return;
  composite(q('canvas'), readOptions());
}

const schedule = () => {
  if (!s || s.raf) return;
  s.raf = requestAnimationFrame(() => { if (s) { s.raf = 0; renderPreview(); } });
};

function exportMime() {
  const f = q('format').value;
  if (f === 'original') return EXT[s.imgMime] ? s.imgMime : 'image/png';
  return EXPORT_MIME[f];
}

function revokeDownload() {
  if (s?.dlUrl) { URL.revokeObjectURL(s.dlUrl); s.dlUrl = null; }
}

function download() {
  if (!s?.img) return;
  const mime = exportMime();
  const out = document.createElement('canvas');
  composite(out, readOptions(), mime === 'image/jpeg');
  out.toBlob((blob) => {
    if (!s) return;
    if (!blob) { setStatus('Export impossible dans ce format.', true); return; }
    revokeDownload();
    s.dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = s.dlUrl;
    a.download = `${baseName(s.imgName)}-watermark.${EXT[mime]}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('Téléchargement lancé.');
    setTimeout(revokeDownload, 10000);
  }, mime, 0.92);
}

function removeImage() {
  if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
  s.img = null; s.imgUrl = null; s.imgName = ''; s.imgMime = '';
  q('workarea').hidden = true;
  q('drop-main').hidden = false;
  q('main-input').value = '';
  setStatus('');
}

function removeLogo() {
  if (s.logoUrl) URL.revokeObjectURL(s.logoUrl);
  s.logo = null; s.logoUrl = null;
  q('logo-name').textContent = 'Aucun logo';
  q('logo-input').value = '';
  schedule();
}

async function onMainFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { setStatus('Fichier non image.', true); return; }
  try {
    const { img, url } = await loadImage(file);
    if (!s) { URL.revokeObjectURL(url); return; }
    if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
    s.img = img; s.imgUrl = url; s.imgName = file.name; s.imgMime = file.type;
    q('fsize').value = Math.max(12, Math.round(img.naturalWidth / 15));
    q('fsize-v').textContent = q('fsize').value;
    q('drop-main').hidden = true;
    q('workarea').hidden = false;
    q('file-name').textContent = file.name;
    setStatus('');
    renderPreview();
  } catch (e) { setStatus(e.message, true); }
}

async function onLogoFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { setStatus('Logo : fichier non image.', true); return; }
  try {
    const { img, url } = await loadImage(file);
    if (!s) { URL.revokeObjectURL(url); return; }
    if (s.logoUrl) URL.revokeObjectURL(s.logoUrl);
    s.logo = img; s.logoUrl = url;
    q('logo-name').textContent = file.name;
    setStatus('');
    schedule();
  } catch (e) { setStatus(e.message, true); }
}

function setType(type) {
  s.type = type;
  q('opt-text').hidden = type !== 'text';
  q('opt-logo').hidden = type !== 'image';
  s.root.querySelectorAll('[name="wmk-type"]').forEach((r) => { r.checked = r.value === type; });
  schedule();
}

function setPos(p) {
  s.pos = p;
  s.root.querySelectorAll('.wmk-cell').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pos === p)));
  schedule();
}

/** Lie une zone de dépôt + input fichier. */
function bindDrop(zone, input, handler) {
  const on = (el, ev, fn) => { el.addEventListener(ev, fn); s.cleanups.push(() => el.removeEventListener(ev, fn)); };
  on(input, 'change', () => handler(input.files[0]));
  on(zone, 'dragover', (e) => { e.preventDefault(); zone.classList.add('wmk-over'); });
  on(zone, 'dragleave', () => zone.classList.remove('wmk-over'));
  on(zone, 'drop', (e) => { e.preventDefault(); zone.classList.remove('wmk-over'); handler(e.dataTransfer.files[0]); });
}

function range(id, label, min, max, val, unit) {
  return `<label class="wmk-row">${label} <output id="wmk-${id}-v">${val}</output>${unit}
    <input type="range" id="wmk-${id}" min="${min}" max="${max}" value="${val}"></label>`;
}

export function mount(container, ctx) {
  s = { root: container, ctx, type: 'text', pos: 'mc', img: null, imgUrl: null, imgName: '', imgMime: '',
        logo: null, logoUrl: null, baseW: 0, raf: 0, dlUrl: null, cleanups: [] };

  container.innerHTML = `
  <style>
    .wmk{display:grid;gap:1rem;font-family:var(--font-family,inherit)}
    .wmk-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;min-height:220px;
      border:2px dashed rgba(128,128,128,.5);border-radius:var(--radius,12px);cursor:pointer;text-align:center;padding:1rem}
    .wmk-drop.wmk-over{border-color:var(--primary,#4f46e5);background:rgba(79,70,229,.08)}
    .wmk-drop.wmk-mini{min-height:64px;flex-direction:row;padding:.5rem}
    .wmk-drop input{display:none}
    .wmk-main{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:1rem;align-items:start}
    @media(max-width:820px){.wmk-main{grid-template-columns:1fr}}
    .wmk-preview{border:1px solid rgba(128,128,128,.35);border-radius:var(--radius,12px);padding:.5rem;text-align:center;
      background:repeating-conic-gradient(rgba(128,128,128,.15) 0 25%,transparent 0 50%) 0 0/16px 16px}
    .wmk-preview canvas{max-width:100%;max-height:70vh;height:auto}
    .wmk-panel{display:grid;gap:.75rem;border:1px solid rgba(128,128,128,.35);border-radius:var(--radius,12px);padding:1rem}
    .wmk-panel fieldset{border:0;padding:0;margin:0;display:grid;gap:.5rem}
    .wmk-row{display:grid;gap:.25rem;font-size:.9rem}
    .wmk-row input[type=text],.wmk-row select{padding:.4rem;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit}
    .wmk-seg{display:flex;gap:1rem}
    .wmk-grid{display:grid;grid-template-columns:repeat(3,36px);gap:4px}
    .wmk-cell{width:36px;height:36px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;cursor:pointer}
    .wmk-cell[aria-pressed=true]{background:var(--primary,#4f46e5);border-color:var(--primary,#4f46e5)}
    .wmk-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;padding:.7rem 1rem;border:0;border-radius:var(--radius,12px);
      background:var(--primary,#4f46e5);color:#fff;font-weight:600;cursor:pointer}
    .wmk-btn.wmk-ghost{background:transparent;color:inherit;border:1px solid rgba(128,128,128,.5)}
    .wmk-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
  </style>
  <div class="wmk">
    <label class="wmk-drop" id="wmk-drop-main">
      <i data-lucide="image-plus"></i>
      <strong>Glissez une image ici ou cliquez pour parcourir</strong>
      <input type="file" id="wmk-main-input" accept="image/*">
    </label>

    <div id="wmk-workarea" hidden>
      <div class="wmk-head">
        <span id="wmk-file-name"></span>
        <button class="wmk-btn wmk-ghost" id="wmk-remove" type="button"><i data-lucide="trash-2"></i>Supprimer</button>
      </div>
      <div class="wmk-main">
        <div class="wmk-preview"><canvas id="wmk-canvas"></canvas></div>

        <div class="wmk-panel">
          <fieldset>
            <legend>Type de filigrane</legend>
            <div class="wmk-seg">
              <label><input type="radio" name="wmk-type" value="text" checked> Texte</label>
              <label><input type="radio" name="wmk-type" value="image"> Image (logo)</label>
            </div>
          </fieldset>

          <fieldset id="wmk-opt-text">
            <label class="wmk-row">Texte <input type="text" id="wmk-text" value="© Mon filigrane"></label>
            <label class="wmk-row">Couleur <input type="color" id="wmk-color" value="#ffffff"></label>
            ${range('fsize', 'Taille police', 8, 400, 48, ' px')}
            ${range('t-opacity', 'Opacité', 0, 100, 50, ' %')}
            ${range('t-angle', 'Rotation', -180, 180, -30, '°')}
          </fieldset>

          <fieldset id="wmk-opt-logo" hidden>
            <label class="wmk-drop wmk-mini" id="wmk-drop-logo">
              <i data-lucide="upload"></i><span id="wmk-logo-name">Aucun logo</span>
              <input type="file" id="wmk-logo-input" accept="image/*">
            </label>
            <button class="wmk-btn wmk-ghost" id="wmk-logo-remove" type="button">Retirer le logo</button>
            ${range('l-scale', 'Échelle', 1, 100, 25, ' %')}
            ${range('l-opacity', 'Opacité', 0, 100, 50, ' %')}
            ${range('l-angle', 'Rotation', -180, 180, 0, '°')}
          </fieldset>

          <fieldset>
            <legend>Position</legend>
            <div class="wmk-grid" role="group" aria-label="Position du filigrane">
              ${POSITIONS.map((p) => `<button type="button" class="wmk-cell" data-pos="${p}" title="${POS_LABEL[p]}" aria-label="${POS_LABEL[p]}" aria-pressed="${p === 'mc'}"></button>`).join('')}
            </div>
            <label><input type="checkbox" id="wmk-tile"> Mode Mosaïque / Répétition</label>
          </fieldset>

          <fieldset>
            <label class="wmk-row">Format d'export
              <select id="wmk-format">
                <option value="original">Format d'origine</option>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WEBP</option>
              </select>
            </label>
            <button class="wmk-btn" id="wmk-download" type="button"><i data-lucide="download"></i>Télécharger</button>
          </fieldset>
        </div>
      </div>
    </div>
    <p id="wmk-status" role="status"></p>
  </div>`;

  const on = (el, ev, fn) => { el.addEventListener(ev, fn); s.cleanups.push(() => el.removeEventListener(ev, fn)); };

  bindDrop(q('drop-main'), q('main-input'), onMainFile);
  bindDrop(q('drop-logo'), q('logo-input'), onLogoFile);

  on(q('remove'), 'click', removeImage);
  on(q('logo-remove'), 'click', removeLogo);
  on(q('download'), 'click', download);

  container.querySelectorAll('[name="wmk-type"]').forEach((r) => on(r, 'change', () => setType(r.value)));
  container.querySelectorAll('.wmk-cell').forEach((b) => on(b, 'click', () => setPos(b.dataset.pos)));

  // Curseurs : MAJ de la valeur affichée + re-rendu.
  container.querySelectorAll('input[type=range]').forEach((r) =>
    on(r, 'input', () => { q(r.id.slice(4) + '-v').textContent = r.value; schedule(); }));
  [q('text'), q('color'), q('tile')].forEach((el) => on(el, 'input', schedule));

  refreshIcons();
}

export function unmount() {
  if (!s) return;
  if (s.raf) cancelAnimationFrame(s.raf);
  s.cleanups.forEach((fn) => fn());
  if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
  if (s.logoUrl) URL.revokeObjectURL(s.logoUrl);
  revokeDownload();
  s.root.innerHTML = '';
  s = null;
}
