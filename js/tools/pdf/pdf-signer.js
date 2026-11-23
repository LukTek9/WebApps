/**
 * pdf-signer.js — Outil « Signataire de PDF » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 * Libs (pdf-lib, pdfjs-dist) chargées à la demande depuis des CDN avec bascule automatique (même schéma que pdf-organizer).
 *
 * Flux :
 *  1. PDF (dropzone) → aperçu pdf.js de la page choisie.
 *  2. Signature : Dessiner (canvas pointeur/tactile) | Texte (cursive → PNG) | Image (PNG/JPG) → PNG rogné.
 *  3. Placement : glisser la signature / cliquer sur la page / curseurs X, Y, Taille.
 *  4. « Signer et télécharger » : PNG incrusté via pdf-lib (rotation de page gérée).
 */
import { createSecurityUI, createDropzone, bindDropzone, escapeHtml, showError } from '../shared/security-tool-ui.js';

/* ---------- Constantes ---------- */
const PDFLIB_URLS = [
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm',
  'https://esm.sh/pdf-lib@1.17.1',
  'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js',
];
const PDFJS_BASES = [
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379',
  'https://unpkg.com/pdfjs-dist@4.0.379',
];
const MAX_PREVIEW_W = 720;
const PAD_W = 800;
const PAD_H = 240;
const SIG_MAX_DIM = 1200;
const SIG_ACCEPT = 'image/png,image/jpeg,.png,.jpg,.jpeg';
const FONTS = [
  { label: 'Script', style: 'normal', stack: '"Segoe Script", "Brush Script MT", "Apple Chancery", cursive' },
  { label: 'Manuscrite', style: 'normal', stack: '"Lucida Handwriting", "Bradley Hand", "Comic Sans MS", cursive' },
  { label: 'Élégante', style: 'italic', stack: '"Snell Roundhand", "Apple Chancery", "URW Chancery L", Georgia, serif' },
];

/* ---------- Chargement paresseux ---------- */
let pdfLibPromise = null;
let pdfJsPromise = null;
let workerBlobUrl = null; // blob du worker pdf.js (révoqué au unmount)

function loadPdfLib() {
  pdfLibPromise ??= (async () => {
    let lastErr;
    for (const url of PDFLIB_URLS) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        const lib = mod.PDFDocument ? mod : mod.default;
        if (lib?.PDFDocument) return lib;
      } catch (e) { lastErr = e; }
    }
    pdfLibPromise = null;
    throw lastErr || new Error('pdf-lib indisponible');
  })();
  return pdfLibPromise;
}

function loadPdfJs() {
  pdfJsPromise ??= (async () => {
    let lastErr;
    for (const base of PDFJS_BASES) {
      try {
        const mod = await import(/* @vite-ignore */ `${base}/build/pdf.min.mjs`);
        const res = await fetch(`${base}/build/pdf.worker.min.mjs`);
        if (!res.ok) throw new Error('worker HTTP ' + res.status);
        workerBlobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
        mod.GlobalWorkerOptions.workerSrc = workerBlobUrl;
        return mod;
      } catch (e) { lastErr = e; }
    }
    pdfJsPromise = null;
    throw lastErr || new Error('pdfjs indisponible');
  })();
  return pdfJsPromise;
}

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (sel) => s?.ui.query(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const norm = (a) => ((a % 360) + 360) % 360;
const errMsg = (e) => (e instanceof Error && e.message ? e.message : 'erreur inconnue');
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const fmtSize = (b) => (b < 1024 ? b + ' o' : b < 1048576 ? (b / 1024).toFixed(1) + ' Ko' : (b / 1048576).toFixed(2) + ' Mo');
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Rogne un canvas aux pixels non transparents (null si vide). */
function trimCanvas(src, pad = 6) {
  const { width: w, height: h } = src;
  const d = src.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/* ==========================================================================
   UI : mode / contrôles / occupation
   ========================================================================== */
function setMode(mode) {
  if (!s) return;
  s.mode = mode;
  s.ui.root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  s.ui.root.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== mode; });
  q('[data-field-color]').hidden = mode === 'image';
  applySignature();
}

function syncControls() {
  if (!s) return;
  q('[data-action="sign"]').disabled = s.busy || !s.pdfDoc || !s.sigBlob;
  const none = !s.sigCanvas;
  q('[data-sig-hint]').textContent = none ? 'Créez une signature pour la placer sur la page.' : 'Glissez la signature sur la page, cliquez pour la déplacer, ou réglez X / Y / Taille.';
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.ui.root.querySelectorAll('button, select, input, textarea').forEach((c) => { c.disabled = busy; });
  s.zones.forEach((z) => z.setDisabled(busy));
  if (!busy) syncControls();
}

/* ==========================================================================
   Signature : application, aperçu, positionnement
   ========================================================================== */
function revokeSigUrl() {
  if (s?.sigUrl) { URL.revokeObjectURL(s.sigUrl); s.sigUrl = null; }
}

/** Convertit la signature du mode actif en PNG (Blob) + miniature d'aperçu. */
function applySignature() {
  if (!s) return;
  const canvas = s.sigs[s.mode] ?? null;
  const seq = ++s.sigSeq;
  revokeSigUrl();
  s.sigBlob = null;
  s.sigCanvas = canvas;
  const preview = q('[data-preview]');
  preview.replaceChildren(...(canvas && s.mode !== 'draw' ? [canvas] : []));
  layoutSig();
  syncControls();
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!s || seq !== s.sigSeq || !blob) return;
    s.sigBlob = blob;
    s.sigUrl = URL.createObjectURL(blob);
    q('[data-sig]').src = s.sigUrl;
    clampPos();
    layoutSig();
    syncControls();
  }, 'image/png');
}

/** Hauteur de la signature en fraction de la hauteur de page. */
function sigHeightFrac() {
  if (!s.sigCanvas) return 0;
  return s.scale * (s.sigCanvas.height / s.sigCanvas.width) * s.pageAspect;
}

function clampPos() {
  if (!s) return;
  s.x = clamp(s.x, 0, Math.max(0, 1 - s.scale));
  s.y = clamp(s.y, 0, Math.max(0, 1 - sigHeightFrac()));
}

/** Reporte l'état (x, y, taille) sur l'overlay et les curseurs. */
function layoutSig() {
  if (!s) return;
  const img = q('[data-sig]');
  if (!img) return;
  img.hidden = !(s.pdfDoc && s.sigUrl);
  img.style.left = (s.x * 100) + '%';
  img.style.top = (s.y * 100) + '%';
  img.style.width = (s.scale * 100) + '%';
  const set = (key, val) => { q(`[data-${key}]`).value = String(val); q(`[data-out-${key}]`).textContent = `${Math.round(val)} %`; };
  set('x', s.x * 100);
  set('y', s.y * 100);
  set('size', s.scale * 100);
}

/* ---------- Mode Dessiner ---------- */
function bindPad() {
  const pad = q('[data-pad]');
  const ctx = pad.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const opt = { signal: s.ui.signal };
  let drawing = false;
  let prev = null;
  let mid = null;
  let width = 3;
  let color = '#000000';

  const pos = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (pad.width / (r.width || 1)), y: (e.clientY - r.top) * (pad.height / (r.height || 1)) };
  };
  const ratio = () => pad.width / (pad.getBoundingClientRect().width || 1);

  pad.addEventListener('pointerdown', (e) => {
    if (s.busy) return;
    e.preventDefault();
    drawing = true;
    pad.setPointerCapture(e.pointerId);
    color = q('[data-color]').value;
    width = Number(q('[data-thick]').value) * ratio();
    prev = mid = pos(e);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(prev.x, prev.y, width / 2, 0, Math.PI * 2);
    ctx.fill();
  }, opt);

  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const events = e.getCoalescedEvents?.() ?? [e];
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const ev of events.length ? events : [e]) {
      const p = pos(ev);
      const m = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
      ctx.beginPath();
      ctx.moveTo(mid.x, mid.y);
      ctx.quadraticCurveTo(prev.x, prev.y, m.x, m.y); // lissage par points médians
      ctx.stroke();
      prev = p;
      mid = m;
    }
  }, opt);

  const end = (e) => {
    if (!drawing) return;
    drawing = false;
    try { pad.releasePointerCapture(e.pointerId); } catch { /* ignoré */ }
    commitPad();
  };
  pad.addEventListener('pointerup', end, opt);
  pad.addEventListener('pointercancel', end, opt);
}

function commitPad() {
  if (!s) return;
  s.sigs.draw = trimCanvas(q('[data-pad]'));
  if (s.mode === 'draw') applySignature();
}

function clearPad() {
  if (!s) return;
  const pad = q('[data-pad]');
  pad.getContext('2d').clearRect(0, 0, pad.width, pad.height);
  s.sigs.draw = null;
  if (s.mode === 'draw') applySignature();
}

/* ---------- Mode Texte ---------- */
function renderText() {
  if (!s) return;
  const text = q('[data-text]').value.trim().slice(0, 40);
  if (!text) {
    s.sigs.text = null;
  } else {
    const f = FONTS[Number(q('[data-font]').value)] ?? FONTS[0];
    const size = 160;
    const font = `${f.style} ${size}px ${f.stack}`;
    const m = document.createElement('canvas').getContext('2d');
    m.font = font;
    const c = document.createElement('canvas');
    c.width = Math.ceil(m.measureText(text).width) + size;
    c.height = size * 2;
    const g = c.getContext('2d');
    g.font = font;
    g.fillStyle = q('[data-color]').value;
    g.textBaseline = 'alphabetic';
    g.fillText(text, size / 2, size * 1.3);
    s.sigs.text = trimCanvas(c);
  }
  if (s.mode === 'text') applySignature();
}

/* ---------- Mode Image ---------- */
async function loadSigImage(file) {
  const cur = s;
  if (!cur || cur.busy) return;
  try {
    const bmp = await createImageBitmap(file);
    if (s !== cur) { bmp.close?.(); return; }
    const k = Math.min(1, SIG_MAX_DIM / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    cur.imgSrc = c;
    processImage();
    cur.ui.setStatus(`Image de signature chargée (${file.name}).`, 'success');
  } catch (e) {
    if (s === cur) showError(cur.ui, new Error(`Image illisible (${errMsg(e)}).`));
  }
}

function processImage() {
  if (!s?.imgSrc) return;
  const src = s.imgSrc;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  if (q('[data-transparent]').checked) { // fond blanc → transparent
    const id = g.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] >= 235 && d[i + 1] >= 235 && d[i + 2] >= 235) d[i + 3] = 0;
    }
    g.putImageData(id, 0, 0);
  }
  s.sigs.image = trimCanvas(c);
  if (!s.sigs.image) s.ui.setStatus('Image vide après traitement : décochez « fond transparent ».', 'error');
  if (s.mode === 'image') applySignature();
}

/* ==========================================================================
   PDF : chargement, rendu, retrait
   ========================================================================== */
async function loadPdf(file) {
  const cur = s;
  if (!cur || cur.busy) return;
  if (!isPdf(file)) { cur.ui.setStatus('Fichier non valide : PDF attendu.', 'error'); return; }
  setBusy(true);
  cur.ui.setStatus('Chargement des bibliothèques…');
  try {
    const [pdfjs] = await Promise.all([loadPdfJs(), loadPdfLib()]);
    if (s !== cur) return;
    cur.ui.setStatus('Lecture du PDF…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (s !== cur) return;
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    if (s !== cur) { doc.destroy(); return; }
    await releaseDoc();
    cur.pdfDoc = doc;
    cur.bytes = bytes;
    cur.file = file;
    cur.page = 0;
    q('[data-page]').innerHTML = Array.from({ length: doc.numPages }, (_, i) => `<option value="${i}">Page ${i + 1} / ${doc.numPages}</option>`).join('');
    q('[data-file-name]').textContent = file.name;
    q('[data-file-meta]').textContent = `${fmtSize(file.size)} · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`;
    q('[data-drop-wrap]').hidden = true;
    q('[data-work]').hidden = false;
    setBusy(false);
    icons();
    await renderPage();
    if (s === cur) cur.ui.setStatus('Créez votre signature puis placez-la sur la page.');
  } catch (e) {
    if (s !== cur) return;
    setBusy(false);
    cur.ui.setStatus(e?.name === 'PasswordException' ? 'PDF protégé par mot de passe : impossible de le signer.' : `PDF illisible (${errMsg(e)}).`, 'error');
  }
}

async function cancelRender() {
  const task = s?.renderTask;
  if (!task) return;
  s.renderTask = null;
  try { task.cancel(); } catch { /* ignoré */ }
  try { await task.promise; } catch { /* annulation attendue */ }
}

async function renderPage() {
  const cur = s;
  if (!cur?.pdfDoc) return;
  const tok = ++cur.token;
  await cancelRender();
  if (s !== cur || tok !== cur.token) return;
  try {
    const page = await cur.pdfDoc.getPage(cur.page + 1);
    if (s !== cur || tok !== cur.token) { page.cleanup?.(); return; }
    const base = page.getViewport({ scale: 1 });
    const stage = q('[data-stage]');
    const cssW = Math.min(MAX_PREVIEW_W, Math.max(240, (stage.clientWidth || MAX_PREVIEW_W) - 24));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (cssW / base.width) * dpr });
    const c = q('[data-page-canvas]');
    c.width = Math.max(1, Math.floor(vp.width));
    c.height = Math.max(1, Math.floor(vp.height));
    c.style.width = cssW + 'px';
    cur.pageAspect = base.width / base.height;
    const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    cur.renderTask = task;
    await task.promise;
    if (s === cur && cur.renderTask === task) cur.renderTask = null;
    page.cleanup?.();
    if (s === cur && tok === cur.token) { clampPos(); layoutSig(); }
  } catch (e) {
    if (e?.name === 'RenderingCancelledException') return;
    if (s === cur) showError(cur.ui, new Error(`Rendu impossible (${errMsg(e)}).`));
  }
}

async function releaseDoc() {
  if (!s) return;
  s.token++;
  await cancelRender();
  if (s?.pdfDoc) { try { s.pdfDoc.destroy(); } catch { /* ignoré */ } s.pdfDoc = null; }
}

async function removePdf() {
  const cur = s;
  if (!cur || cur.busy) return;
  await releaseDoc();
  if (s !== cur) return;
  cur.bytes = null;
  cur.file = null;
  q('[data-work]').hidden = true;
  q('[data-drop-wrap]').hidden = false;
  layoutSig();
  syncControls();
  cur.ui.setStatus('Déposez un PDF pour commencer.');
}

/* ==========================================================================
   Placement interactif (glisser / clic)
   ========================================================================== */
function bindPlacement() {
  const sheet = q('[data-sheet]');
  const img = q('[data-sig]');
  const canvas = q('[data-page-canvas]');
  const opt = { signal: s.ui.signal };
  let drag = null;

  img.addEventListener('pointerdown', (e) => {
    if (s.busy) return;
    e.preventDefault();
    img.setPointerCapture(e.pointerId);
    drag = { px: e.clientX, py: e.clientY, x: s.x, y: s.y };
  }, opt);

  img.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = sheet.getBoundingClientRect();
    s.x = drag.x + (e.clientX - drag.px) / (r.width || 1);
    s.y = drag.y + (e.clientY - drag.py) / (r.height || 1);
    clampPos();
    layoutSig();
  }, opt);

  const end = (e) => {
    if (!drag) return;
    drag = null;
    try { img.releasePointerCapture(e.pointerId); } catch { /* ignoré */ }
  };
  img.addEventListener('pointerup', end, opt);
  img.addEventListener('pointercancel', end, opt);

  canvas.addEventListener('click', (e) => { // clic sur la page : centre la signature
    if (s.busy || !s.sigUrl) return;
    const r = canvas.getBoundingClientRect();
    s.x = (e.clientX - r.left) / (r.width || 1) - s.scale / 2;
    s.y = (e.clientY - r.top) / (r.height || 1) - sigHeightFrac() / 2;
    clampPos();
    layoutSig();
  }, opt);
}

/* ==========================================================================
   Signature du PDF (pdf-lib)
   ========================================================================== */
async function signPdf() {
  const cur = s;
  if (!cur || cur.busy || !cur.bytes || !cur.sigBlob || !cur.sigCanvas) return;
  setBusy(true);
  cur.ui.setStatus('Incrustation de la signature…');
  try {
    const { PDFDocument, degrees } = await loadPdfLib();
    if (s !== cur) return;
    const doc = await PDFDocument.load(cur.bytes, { ignoreEncryption: true });
    const png = await doc.embedPng(await cur.sigBlob.arrayBuffer());
    const page = doc.getPage(cur.page);
    const rot = norm(page.getRotation().angle);
    const box = page.getCropBox();
    const W = box.width;
    const H = box.height;
    const swap = rot === 90 || rot === 270;
    const VW = swap ? H : W; // dimensions visuelles (page affichée)
    const VH = swap ? W : H;
    const w = cur.scale * VW;
    const h = w * (cur.sigCanvas.height / cur.sigCanvas.width);
    const vx = cur.x * VW;
    const vy = VH - cur.y * VH - h; // coin bas-gauche visuel (origine bas-gauche)
    let x = vx;
    let y = vy;
    if (rot === 90) { x = W - vy; y = vx; }
    else if (rot === 180) { x = W - vx; y = H - vy; }
    else if (rot === 270) { x = vy; y = H - vx; }
    page.drawImage(png, { x: box.x + x, y: box.y + y, width: w, height: h, rotate: degrees(rot) });
    const out = await doc.save();
    if (s !== cur) return;
    const name = cur.file.name.replace(/\.pdf$/i, '') + '_signe.pdf';
    cur.ui.download(new Blob([out], { type: 'application/pdf' }), name, 'application/pdf');
    cur.ui.setStatus(`${name} signé (page ${cur.page + 1}, ${fmtSize(out.byteLength)}).`, 'success');
  } catch (e) {
    if (s === cur) showError(cur.ui, new Error(`Signature impossible (${errMsg(e)}).`));
  } finally {
    if (s === cur) setBusy(false);
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const field = (label, control, extra = '') => `<label class="security-tools__field" ${extra}>${label}${control}</label>`;
const slider = (key, label, min, max, step, val) => field(
  `${label} : <output data-out-${key}>${val} %</output>`,
  `<input type="range" data-${key} min="${min}" max="${max}" step="${step}" value="${val}">`,
);

const TEMPLATE = `
  <div data-drop-wrap>
    ${createDropzone({ id: 'pdfs-pdf', title: 'Glissez-déposez votre PDF ici', hint: 'ou cliquez pour parcourir — un seul fichier .pdf', accept: '.pdf,application/pdf', multiple: false, label: 'Choisir un fichier PDF' })}
  </div>

  <div class="pdfs-work" data-work hidden>
    <div class="pdfs-file">
      <i data-lucide="file-text"></i>
      <div class="pdfs-file-info"><strong data-file-name></strong><small data-file-meta></small></div>
      <button type="button" class="btn-remove-file" data-action="remove"><i data-lucide="x"></i> Retirer le fichier</button>
    </div>

    <div class="pdfs-layout">
      <section class="security-tools__panel">
        <div class="zipa-tabs" role="tablist" aria-label="Mode de signature">
          <button type="button" class="zipa-tab" role="tab" aria-selected="true" data-mode="draw">Dessiner</button>
          <button type="button" class="zipa-tab" role="tab" aria-selected="false" data-mode="text">Texte</button>
          <button type="button" class="zipa-tab" role="tab" aria-selected="false" data-mode="image">Image</button>
        </div>

        <div class="pdfs-pane" data-pane="draw">
          <canvas class="pdfs-pad" data-pad width="${PAD_W}" height="${PAD_H}" aria-label="Zone de dessin de la signature"></canvas>
          <div class="security-tools__controls">
            ${field('Épaisseur', '<input type="range" data-thick min="1" max="12" step="1" value="3">')}
            <div class="security-tools__actions"><button type="button" class="btn-secondary" data-action="clear-pad"><i data-lucide="eraser"></i> Effacer</button></div>
          </div>
        </div>

        <div class="pdfs-pane" data-pane="text" hidden>
          ${field('Votre signature', '<input type="text" data-text maxlength="40" placeholder="Prénom Nom" autocomplete="off" spellcheck="false">')}
          ${field('Style', `<select data-font>${FONTS.map((f, i) => `<option value="${i}">${f.label}</option>`).join('')}</select>`)}
        </div>

        <div class="pdfs-pane" data-pane="image" hidden>
          ${createDropzone({ id: 'pdfs-sig-img', title: 'Glissez-déposez votre signature', hint: 'ou cliquez — PNG ou JPG', accept: SIG_ACCEPT, multiple: false, label: 'Choisir une image de signature' })}
          <label class="security-tools__options"><span><input type="checkbox" data-transparent checked> Rendre le fond blanc transparent</span></label>
        </div>

        ${field('Couleur', '<input type="color" data-color value="#000000">', 'data-field-color')}
        <div class="pdfs-preview" data-preview></div>

        <div class="security-tools__controls">
          ${field('Page', '<select data-page></select>')}
          ${slider('x', 'Position X', 0, 100, 0.5, 0)}
          ${slider('y', 'Position Y', 0, 100, 0.5, 0)}
          ${slider('size', 'Taille (largeur de page)', 5, 60, 1, 25)}
        </div>
        <p class="security-tools__hint" data-sig-hint></p>
        <div class="security-tools__actions">
          <button type="button" class="btn-primary" data-action="sign" disabled><i data-lucide="pen-tool"></i> Signer et télécharger</button>
        </div>
      </section>

      <section class="security-tools__panel">
        <div class="pdfs-stage" data-stage>
          <div class="pdfs-sheet" data-sheet>
            <canvas data-page-canvas width="1" height="1" aria-label="Aperçu de la page du PDF"></canvas>
            <img class="pdfs-sig" data-sig alt="Signature" draggable="false" hidden>
          </div>
        </div>
      </section>
    </div>
  </div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount();
  const ui = createSecurityUI(container, { content: `<div class="pdfs">${TEMPLATE}</div>` });
  s = {
    ui, ctx, busy: false, token: 0, sigSeq: 0,
    file: null, bytes: null, pdfDoc: null, renderTask: null, page: 0, pageAspect: 0.707,
    mode: 'draw', sigs: { draw: null, text: null, image: null }, sigCanvas: null, sigBlob: null, sigUrl: null, imgSrc: null,
    x: 0.55, y: 0.8, scale: 0.25, zones: [],
  };

  s.zones.push(
    bindDropzone(ui, { id: 'pdfs-pdf', accept: '.pdf,application/pdf', multiple: false, onFiles: (files) => loadPdf(files[0]) }),
    bindDropzone(ui, { id: 'pdfs-sig-img', accept: SIG_ACCEPT, multiple: false, onFiles: (files) => loadSigImage(files[0]) }),
  );
  bindPad();
  bindPlacement();

  ui.on('click', (e) => {
    const btn = e.target.closest('[data-mode], [data-action]');
    if (!btn || !s) return;
    if (btn.dataset.mode) { setMode(btn.dataset.mode); return; }
    switch (btn.dataset.action) {
      case 'clear-pad': clearPad(); break;
      case 'remove': removePdf(); break;
      case 'sign': signPdf(); break;
      default: break;
    }
  });

  ui.on('input', (e) => {
    if (!s) return;
    const t = e.target;
    if (t.matches('[data-text]')) renderText();
    else if (t.matches('[data-color]')) { if (s.mode === 'text') renderText(); }
    else if (t.matches('[data-x], [data-y], [data-size]')) {
      s.x = Number(q('[data-x]').value) / 100;
      s.y = Number(q('[data-y]').value) / 100;
      s.scale = Number(q('[data-size]').value) / 100;
      clampPos();
      layoutSig();
    }
  });

  ui.on('change', (e) => {
    if (!s) return;
    const t = e.target;
    if (t.matches('[data-font]')) renderText();
    else if (t.matches('[data-transparent]')) processImage();
    else if (t.matches('[data-page]')) { s.page = Number(t.value) || 0; renderPage(); }
  });

  layoutSig();
  syncControls();
  ui.setStatus('Déposez un PDF pour commencer.');
  icons();
}

export function unmount() {
  if (!s) return;
  const cur = s;
  s = null;                                          // invalide toute opération asynchrone en cours
  cur.token++;
  try { cur.renderTask?.cancel(); } catch { /* ignoré */ } // annule le rendu pdf.js en attente
  cur.renderTask = null;
  if (cur.pdfDoc) { try { cur.pdfDoc.destroy(); } catch { /* ignoré */ } cur.pdfDoc = null; }
  if (cur.sigUrl) { URL.revokeObjectURL(cur.sigUrl); cur.sigUrl = null; }
  cur.bytes = null;
  cur.sigs = { draw: null, text: null, image: null };
  cur.sigCanvas = cur.sigBlob = cur.imgSrc = null;
  if (workerBlobUrl) {                                // worker pdf.js recréé au prochain montage
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
    pdfJsPromise = null;
  }
  cur.ui.destroy();                                  // abort listeners (pad, drag, delegation) + URLs de téléchargement + timers
}
