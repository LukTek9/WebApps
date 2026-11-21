/**
 * pdf-page-numbers.js — Numéroteur de pages PDF 100 % client.
 * Contrat : mount(container, ctx) / unmount().
 * Moteur : pdf-lib (CDN, chargé à la demande). Aucun envoi réseau des fichiers.
 */

const PDFLIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const MM_PER_PT = 25.4 / 72;
const SHEET_W = 200; // largeur CSS de l'aperçu (px) — doit rester cohérente avec .pdfnum-sheet

/** Presets de format : {n} = numéro courant, {N} = dernier numéro. */
const FORMATS = [
  { id: 'n', label: '1', tpl: '{n}' },
  { id: 'n-of-N', label: '1 / N', tpl: '{n} / {N}' },
  { id: 'page-n', label: 'Page 1', tpl: 'Page {n}' },
  { id: 'page-n-sur-N', label: 'Page 1 sur N', tpl: 'Page {n} sur {N}' },
];
const POSITIONS = [
  ['top-left', 'Haut gauche'], ['top-center', 'Haut centre'], ['top-right', 'Haut droite'],
  ['bottom-left', 'Bas gauche'], ['bottom-center', 'Bas centre'], ['bottom-right', 'Bas droite'],
];

let s = null; // état de l'instance montée
let libPromise = null; // cache du chargement paresseux

const q = (id) => s?.root.querySelector('#pdfnum-' + id);
const refreshIcons = () => window.lucide?.createIcons();
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (b) =>
  b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(2)} Mo`;
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const tick = () => new Promise((r) => setTimeout(r)); // rend la main à l'UI

/** Chargement paresseux de pdf-lib (une seule fois, reset si échec). */
function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = PDFLIB_URL;
    el.async = true;
    el.onload = () => (window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib indisponible.')));
    el.onerror = () => {
      el.remove();
      reject(new Error('Chargement de pdf-lib impossible (réseau / CDN).'));
    };
    document.head.appendChild(el);
  }).catch((e) => {
    libPromise = null; // autorise une nouvelle tentative
    throw e;
  });
  return libPromise;
}

function setStatus(msg = '', kind = '') {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pdfnum-status' + (kind ? ' is-' + kind : '');
}

function setProgress(pct) {
  const bar = q('bar');
  if (!bar) return;
  bar.classList.toggle('is-on', pct !== null);
  bar.firstElementChild.style.width = (pct ?? 0) + '%';
}

/** Libellé d'une page selon le preset. */
function labelFor(tpl, n, last) {
  return tpl.replace('{n}', n).replace('{N}', last);
}

/** Lit les options courantes depuis l'état (avec bornes de sécurité). */
function opts() {
  const clamp = (v, min, max, d) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  return {
    pos: s.pos,
    tpl: FORMATS.find((f) => f.id === q('format').value)?.tpl ?? '{n}',
    start: Math.trunc(clamp(parseInt(q('start').value, 10), 0, 99999, 1)),
    size: clamp(parseFloat(q('size').value), 4, 96, 12),
    margin: clamp(parseFloat(q('margin').value), 0, 300, 24),
    color: q('color').value,
  };
}

/** Aperçu live : page factice (ratio de la 1re page) + libellé positionné. */
function updatePreview() {
  if (!s?.file) return;
  const o = opts();
  const { w, h } = s.firstSize;
  const k = SHEET_W / w; // pt → px
  const sheet = q('sheet');
  sheet.style.height = Math.round(h * k) + 'px';
  const lab = q('label');
  lab.textContent = labelFor(o.tpl, o.start, o.start + s.pages - 1);
  lab.style.fontSize = Math.max(4, o.size * k) + 'px';
  lab.style.color = o.color;
  const m = o.margin * k + 'px';
  const [v, hz] = o.pos.split('-');
  lab.style.top = v === 'top' ? m : 'auto';
  lab.style.bottom = v === 'bottom' ? m : 'auto';
  lab.style.left = hz === 'left' ? m : hz === 'center' ? '50%' : 'auto';
  lab.style.right = hz === 'right' ? m : 'auto';
  lab.style.transform = hz === 'center' ? 'translateX(-50%)' : 'none';
  q('pos').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pos === o.pos)));
  q('hint').textContent = `Aperçu : page 1 → « ${lab.textContent} »`;
}

/** Hex (#rrggbb) → composantes 0..1. */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex) || [null, '000000'];
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Charge le PDF : validation, nombre de pages, métadonnées. */
async function loadFile(file) {
  if (!isPdf(file)) return setStatus('Fichier non PDF.', 'error');
  s.busy = true;
  syncUi();
  try {
    setStatus('Chargement du moteur PDF…');
    const { PDFDocument } = await loadPdfLib();
    setStatus('Lecture du PDF…');
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf); // lève si chiffré / corrompu
    if (!s) return;
    const first = doc.getPage(0);
    const rot = ((first.getRotation().angle % 360) + 360) % 360;
    const { width, height } = first.getSize();
    const swap = rot === 90 || rot === 270;
    s.file = file;
    s.buf = buf;
    s.pages = doc.getPageCount();
    s.firstSize = { w: swap ? height : width, h: swap ? width : height };
    s.metaInfo = { title: doc.getTitle() || '', author: doc.getAuthor() || '' };
    setStatus('');
    setProgress(null);
    renderWork();
  } catch (e) {
    if (!s) return;
    const enc = /encrypt/i.test(e?.message || '');
    setStatus(enc ? 'PDF chiffré : impossible de le numéroter.' : 'PDF illisible ou corrompu : ' + (e?.message || e), 'error');
  } finally {
    if (s) {
      s.busy = false;
      syncUi();
    }
  }
}

/** Réinitialise : libère buffer, URLs Blob, revient à la zone de dépôt. */
function reset() {
  if (!s) return;
  s.timers.forEach(clearTimeout);
  s.timers.clear();
  s.urls.forEach((u) => URL.revokeObjectURL(u));
  s.urls.clear();
  s.file = null;
  s.buf = null;
  s.pages = 0;
  s.busy = false;
  renderDrop();
}

/** Déclenche le téléchargement puis révoque l'URL Blob. */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  s.urls.add(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  const t = setTimeout(() => {
    URL.revokeObjectURL(url);
    s?.urls.delete(url);
    s?.timers.delete(t);
  }, 4000);
  s.timers.add(t);
}

function syncUi() {
  const go = q('go');
  if (go) go.disabled = s.busy || !s.file;
  const rm = q('reset');
  if (rm) rm.disabled = s.busy;
  s.root.querySelectorAll('.pdfnum-panel input, .pdfnum-panel select, .pdfnum-pos button').forEach((el) => (el.disabled = s.busy));
}

/** Numérotation : drawText sur chaque page, en tenant compte de /Rotate. */
async function run() {
  if (!s.file || s.busy) return;
  const o = opts();
  s.busy = true;
  syncUi();
  setProgress(0);
  try {
    setStatus('Chargement du moteur PDF…');
    const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
    const doc = await PDFDocument.load(s.buf);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const total = pages.length;
    const last = o.start + total - 1;
    const [r, g, b] = hexToRgb(o.color);
    const [v, hz] = o.pos.split('-');

    for (const [i, page] of pages.entries()) {
      if (!s) return; // démonté entre-temps
      const text = labelFor(o.tpl, o.start + i, last);
      const tw = font.widthOfTextAtSize(text, o.size);
      const { width: W, height: H } = page.getSize();
      const rot = ((page.getRotation().angle % 360) + 360) % 360;
      const VW = rot === 90 || rot === 270 ? H : W; // dimensions visuelles
      const VH = rot === 90 || rot === 270 ? W : H;
      // Position visuelle (origine bas-gauche de la page affichée)
      const vx = hz === 'left' ? o.margin : hz === 'center' ? (VW - tw) / 2 : VW - o.margin - tw;
      const vy = v === 'bottom' ? o.margin : VH - o.margin - o.size * 0.72;
      // Conversion vers l'espace non pivoté du PDF
      let x = vx, y = vy;
      if (rot === 90) { x = W - vy; y = vx; }
      else if (rot === 180) { x = W - vx; y = H - vy; }
      else if (rot === 270) { x = vy; y = H - vx; }
      page.drawText(text, { x, y, size: o.size, font, color: rgb(r, g, b), rotate: degrees(rot) });
      if (i % 20 === 19) {
        setProgress(Math.round(((i + 1) / total) * 90));
        setStatus(`Numérotation ${i + 1}/${total}…`);
        await tick();
      }
    }
    setStatus('Génération du fichier…');
    setProgress(95);
    await tick();
    const bytes = await doc.save();
    if (!s) return;
    const name = s.file.name.replace(/\.pdf$/i, '') + '_numerote.pdf';
    download(new Blob([bytes], { type: 'application/pdf' }), name);
    setProgress(100);
    setStatus(`Terminé : ${name} (${fmtSize(bytes.byteLength)}).`, 'ok');
  } catch (e) {
    if (s) {
      setProgress(null);
      setStatus('Échec de la numérotation : ' + (e?.message || e), 'error');
    }
  } finally {
    if (s) {
      s.busy = false;
      syncUi();
    }
  }
}

/** Vue 1 : zone de dépôt. */
function renderDrop() {
  s.root.innerHTML = `
    <div class="pdfnum">
      <div class="pdfnum-drop" id="pdfnum-drop" tabindex="0" role="button" aria-label="Choisir un fichier PDF">
        <i data-lucide="upload-cloud"></i>
        <strong>Glissez-déposez votre PDF ici</strong>
        <small>ou cliquez pour parcourir · un seul fichier</small>
        <input id="pdfnum-input" type="file" accept="application/pdf" hidden />
      </div>
      <div class="pdfnum-status" id="pdfnum-status" role="status" aria-live="polite"></div>
    </div>`;
  const drop = q('drop');
  const input = q('input');
  const pick = (files) => {
    const f = [...files][0];
    if (f && !s.busy) loadFile(f);
  };
  drop.addEventListener('click', () => !s.busy && input.click());
  drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !s.busy) {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    pick(files);
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); })
  );
  drop.addEventListener('drop', (e) => pick(e.dataTransfer?.files ?? []));
  refreshIcons();
}

/** Vue 2 : options + aperçu. */
function renderWork() {
  const f = s.file;
  const mm = (pt) => Math.round(pt * MM_PER_PT);
  const meta = [
    `${s.pages} page${s.pages > 1 ? 's' : ''}`,
    fmtSize(f.size),
    `${mm(s.firstSize.w)} × ${mm(s.firstSize.h)} mm`,
    s.metaInfo.title && `Titre : ${esc(s.metaInfo.title)}`,
    s.metaInfo.author && `Auteur : ${esc(s.metaInfo.author)}`,
  ].filter(Boolean);
  s.pos = s.pos || 'bottom-center';
  s.root.innerHTML = `
    <div class="pdfnum">
      <div class="pdfnum-file">
        <i data-lucide="file-text"></i>
        <div class="pdfnum-file-txt">
          <div class="pdfnum-name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="pdfnum-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
        </div>
        <button type="button" class="btn-remove-file" id="pdfnum-reset"><i data-lucide="x"></i>Retirer</button>
      </div>
      <div class="pdfnum-work">
        <div class="pdfnum-main">
          <div class="pdfnum-panel">
            <div class="pdfnum-field">Position
              <div class="pdfnum-pos" id="pdfnum-pos" role="group" aria-label="Position du numéro">
                ${POSITIONS.map(([id, l]) => `<button type="button" data-pos="${id}" aria-pressed="${id === s.pos}">${l}</button>`).join('')}
              </div>
            </div>
            <label class="pdfnum-field">Format
              <select id="pdfnum-format">${FORMATS.map((x, i) => `<option value="${x.id}"${i === 0 ? ' selected' : ''}>${x.label}</option>`).join('')}</select>
            </label>
            <label class="pdfnum-field">Numéro de départ
              <input id="pdfnum-start" type="number" min="0" max="99999" step="1" value="1" />
            </label>
            <label class="pdfnum-field">Taille de police (pt)
              <input id="pdfnum-size" type="number" min="4" max="96" step="1" value="12" />
            </label>
            <label class="pdfnum-field">Marge (pt)
              <input id="pdfnum-margin" type="number" min="0" max="300" step="1" value="24" />
            </label>
            <label class="pdfnum-field">Couleur du texte
              <input id="pdfnum-color" type="color" value="#000000" />
            </label>
          </div>
          <div class="pdfnum-bar" id="pdfnum-bar"><i></i></div>
          <div class="pdfnum-status" id="pdfnum-status" role="status" aria-live="polite"></div>
          <div class="pdfnum-actions">
            <button type="button" class="btn-primary" id="pdfnum-go"><i data-lucide="download"></i>Numéroter &amp; télécharger</button>
          </div>
        </div>
        <aside class="pdfnum-side" aria-label="Aperçu">
          <h4>Aperçu</h4>
          <div class="pdfnum-sheet" id="pdfnum-sheet"><span class="pdfnum-label" id="pdfnum-label"></span></div>
          <p class="pdfnum-hint" id="pdfnum-hint"></p>
        </aside>
      </div>
    </div>`;
  q('reset').addEventListener('click', reset);
  q('go').addEventListener('click', run);
  q('pos').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pos]');
    if (!b || s.busy) return;
    s.pos = b.dataset.pos;
    updatePreview();
  });
  ['format', 'start', 'size', 'margin', 'color'].forEach((id) => {
    q(id).addEventListener('input', updatePreview);
    q(id).addEventListener('change', updatePreview);
  });
  updatePreview();
  syncUi();
  refreshIcons();
}

export function mount(container, ctx) {
  s = {
    root: container, ctx, file: null, buf: null, pages: 0, firstSize: { w: 595, h: 842 },
    metaInfo: {}, pos: 'bottom-center', busy: false, urls: new Set(), timers: new Set(),
  };
  renderDrop();
}

export function unmount() {
  if (!s) return;
  s.timers.forEach(clearTimeout);
  s.urls.forEach((u) => URL.revokeObjectURL(u)); // libération mémoire Blob
  s.buf = null;
  s.root.innerHTML = '';
  s = null;
}
