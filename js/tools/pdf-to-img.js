/**
 * pdf-to-img.js — PDF vers Images (PNG / JPG / WebP), 100 % local.
 * Contrat : mount(container, ctx) / unmount().
 * Libs CDN chargées à la demande : pdfjs-dist (UMD) + JSZip.
 */

const PDFJS_VERSION = '3.11.174';
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

const FORMATS = {
  png: { mime: 'image/png', ext: 'png', quality: undefined },
  jpg: { mime: 'image/jpeg', ext: 'jpg', quality: 0.92 },
  webp: { mime: 'image/webp', ext: 'webp', quality: 0.92 },
};
const MAX_CANVAS_PIXELS = 50_000_000; // garde-fou mémoire
const THUMB_WIDTH = 140;

// ---- État du module (réinitialisé à chaque mount) ----
let root = null;
let styleEl = null;
let pdfDoc = null;
let pdfFile = null;
let selected = new Set();
let renderToken = 0; // invalide les rendus de vignettes en cours
let workerBlobUrl = null;
let objectUrls = new Set();
let busy = false;

// ---- Chargeurs paresseux (mémorisés) ----
const scriptPromises = {};
function loadScript(url) {
  if (!scriptPromises[url]) {
    scriptPromises[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        delete scriptPromises[url];
        s.remove();
        reject(new Error(`Chargement impossible : ${url}`));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromises[url];
}

async function loadPdfJs() {
  if (!window.pdfjsLib) await loadScript(PDFJS_URL);
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('pdfjs-dist indisponible');
  if (!workerBlobUrl) {
    // Worker cross-origin interdit → récupération en Blob local
    const res = await fetch(PDFJS_WORKER_URL);
    if (!res.ok) throw new Error('Worker pdf.js indisponible');
    const blob = new Blob([await res.text()], { type: 'text/javascript' });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  lib.GlobalWorkerOptions.workerSrc = workerBlobUrl;
  return lib;
}

async function loadJSZip() {
  if (!window.JSZip) await loadScript(JSZIP_URL);
  if (!window.JSZip) throw new Error('JSZip indisponible');
  return window.JSZip;
}

// ---- Utilitaires ----
const $ = (sel) => root.querySelector(sel);

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(2)} Mo`;
}

function baseName(name) {
  return name.replace(/\.pdf$/i, '') || 'document';
}

function icons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
}

function setStatus(msg, isError = false) {
  const el = $('.pdf2img-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? 'var(--danger, #ef4444)' : 'var(--text-muted, #94a3b8)';
}

function setProgress(ratio) {
  const wrap = $('.pdf2img-progress');
  const bar = $('.pdf2img-progress-bar');
  if (!wrap || !bar) return;
  wrap.style.visibility = ratio == null ? 'hidden' : 'visible';
  bar.style.width = `${Math.round((ratio || 0) * 100)}%`;
}

function trackUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

function revokeAll() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls.clear();
}

function download(blob, filename) {
  const url = trackUrl(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Libération différée pour laisser le navigateur démarrer le téléchargement
  setTimeout(() => {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }, 1500);
}

function canvasToBlob(canvas, fmt) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Export image échoué'))),
      fmt.mime,
      fmt.quality
    );
  });
}

// ---- Styles (scopés, tokens de thème) ----
const CSS = `
.pdf2img { display:flex; flex-direction:column; gap:16px; }
.pdf2img [hidden] { display:none !important; }
.pdf2img-drop { border:2px dashed var(--border, #475569); border-radius:var(--radius, 12px); min-height:260px;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; cursor:pointer;
  text-align:center; padding:24px; transition:border-color .2s, background .2s; }
.pdf2img-drop:hover, .pdf2img-drop.is-over { border-color:var(--cat-pdf, #ef4444); background:rgba(239,68,68,.06); }
.pdf2img-drop svg, .pdf2img-drop i { width:48px; height:48px; color:var(--cat-pdf, #ef4444); }
.pdf2img-meta { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.pdf2img-meta-info { display:flex; flex-direction:column; gap:2px; min-width:0; }
.pdf2img-meta-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:60vw; }
.pdf2img-meta-sub { font-size:.85rem; color:var(--text-muted, #94a3b8); }
.pdf2img-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; min-height:36px; }
.pdf2img-toolbar-actions { display:flex; gap:8px; }
.pdf2img-preview-box { height:480px; flex:none; overflow-y:auto; contain:size layout paint;
  background:var(--bg-preview, #1e1e2e); border-radius:var(--radius, 12px); padding:16px; box-sizing:border-box; }
.pdf2img-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(${THUMB_WIDTH}px, 1fr)); gap:12px; }
.pdf2img-thumb { position:relative; border:2px solid transparent; border-radius:8px; padding:6px; cursor:pointer;
  background:rgba(255,255,255,.04); display:flex; flex-direction:column; align-items:center; gap:6px;
  user-select:none; transition:border-color .15s, background .15s; }
.pdf2img-thumb:hover { background:rgba(255,255,255,.08); }
.pdf2img-thumb.is-selected { border-color:var(--cat-pdf, #ef4444); background:rgba(239,68,68,.12); }
.pdf2img-thumb-slot { width:100%; aspect-ratio:3/4; display:flex; align-items:center; justify-content:center;
  background:rgba(255,255,255,.04); border-radius:4px; overflow:hidden; }
.pdf2img-thumb canvas { max-width:100%; max-height:100%; background:#fff; display:block; }
.pdf2img-thumb-label { font-size:.8rem; color:var(--text-muted, #cbd5e1); }
.pdf2img-check { position:absolute; top:10px; left:10px; width:18px; height:18px; accent-color:var(--cat-pdf, #ef4444); cursor:pointer; }
.pdf2img-options { display:flex; gap:16px; flex-wrap:wrap; align-items:flex-end; }
.pdf2img-field { display:flex; flex-direction:column; gap:6px; min-width:180px; }
.pdf2img-field label { font-size:.85rem; color:var(--text-muted, #94a3b8); }
.pdf2img-field select { padding:10px 12px; border-radius:var(--radius, 8px); border:1px solid var(--border, #475569);
  background:var(--bg-input, transparent); color:inherit; font:inherit; }
.pdf2img-progress { height:8px; border-radius:999px; background:rgba(148,163,184,.2); overflow:hidden; visibility:hidden; }
.pdf2img-progress-bar { height:100%; width:0; background:var(--cat-pdf, #ef4444); transition:width .15s; }
.pdf2img-status { min-height:1.2em; font-size:.9rem; }
.pdf2img .btn-primary.pdf2img-go { background:var(--cat-pdf, #ef4444); border-color:var(--cat-pdf, #ef4444); color:#fff;
  display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:14px 24px; font-size:1.05rem; }
.pdf2img .btn-primary.pdf2img-go:disabled { opacity:.5; cursor:not-allowed; }
.pdf2img .btn-secondary { display:inline-flex; align-items:center; gap:6px; }
`;

// ---- Gabarit UI ----
const TEMPLATE = `
<div class="pdf2img">
  <div class="pdf2img-drop" tabindex="0" role="button" aria-label="Déposer un fichier PDF">
    <i data-lucide="file-up"></i>
    <strong>Glissez-déposez votre PDF ici</strong>
    <span class="pdf2img-meta-sub">ou cliquez pour sélectionner un fichier</span>
    <input type="file" accept="application/pdf" hidden />
  </div>

  <div class="pdf2img-work" hidden>
    <div class="pdf2img-meta">
      <div class="pdf2img-meta-info">
        <span class="pdf2img-meta-name"></span>
        <span class="pdf2img-meta-sub"></span>
      </div>
      <button type="button" class="btn-remove-file pdf2img-change"><i data-lucide="trash-2"></i>Changer de fichier</button>
    </div>

    <div class="pdf2img-toolbar">
      <span class="pdf2img-count"></span>
      <div class="pdf2img-toolbar-actions">
        <button type="button" class="btn-secondary pdf2img-all">Tout sélectionner</button>
        <button type="button" class="btn-secondary pdf2img-none">Tout désélectionner</button>
      </div>
    </div>

    <div class="pdf2img-preview-box"><div class="pdf2img-grid"></div></div>

    <div class="pdf2img-options">
      <div class="pdf2img-field">
        <label for="pdf2img-format">Format</label>
        <select id="pdf2img-format">
          <option value="png">PNG (sans perte)</option>
          <option value="jpg">JPG</option>
          <option value="webp">WebP</option>
        </select>
      </div>
      <div class="pdf2img-field">
        <label for="pdf2img-scale">Résolution</label>
        <select id="pdf2img-scale">
          <option value="1">1x Standard</option>
          <option value="2" selected>2x HD</option>
          <option value="3">3x Ultra-HD</option>
        </select>
      </div>
    </div>

    <div class="pdf2img-progress"><div class="pdf2img-progress-bar"></div></div>
    <div class="pdf2img-status"></div>

    <button type="button" class="btn-primary pdf2img-go" disabled><i data-lucide="download"></i><span>Convertir et télécharger</span></button>
  </div>
</div>
`;

// ---- Logique ----
function updateCount() {
  const total = pdfDoc ? pdfDoc.numPages : 0;
  const n = selected.size;
  const el = $('.pdf2img-count');
  if (el) el.textContent = `${n} / ${total} page${total > 1 ? 's' : ''} sélectionnée${n > 1 ? 's' : ''}`;
  const go = $('.pdf2img-go');
  if (go) go.disabled = busy || n === 0;
}

function toggleThumb(thumb, pageNum, force) {
  const on = force === undefined ? !selected.has(pageNum) : force;
  if (on) selected.add(pageNum);
  else selected.delete(pageNum);
  thumb.classList.toggle('is-selected', on);
  const cb = thumb.querySelector('.pdf2img-check');
  if (cb) cb.checked = on;
  updateCount();
}

function setAll(on) {
  root.querySelectorAll('.pdf2img-thumb').forEach((t) => toggleThumb(t, Number(t.dataset.page), on));
}

async function renderThumbnails() {
  const token = ++renderToken;
  const grid = $('.pdf2img-grid');
  grid.textContent = '';
  const doc = pdfDoc;

  // Squelettes d'abord (cadre stable, aucun saut)
  const thumbs = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const t = document.createElement('div');
    t.className = 'pdf2img-thumb is-selected';
    t.dataset.page = String(i);
    t.innerHTML = `<input type="checkbox" class="pdf2img-check" checked aria-label="Page ${i}" />
      <div class="pdf2img-thumb-slot"></div><span class="pdf2img-thumb-label">Page ${i}</span>`;
    t.addEventListener('click', (e) => {
      if (e.target.classList.contains('pdf2img-check')) toggleThumb(t, i, e.target.checked);
      else toggleThumb(t, i);
    });
    grid.appendChild(t);
    thumbs.push(t);
  }

  for (let i = 1; i <= doc.numPages; i++) {
    if (token !== renderToken) return; // fichier changé / unmount
    try {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (THUMB_WIDTH * 2) / base.width }); // 2x pour netteté
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const c2d = canvas.getContext('2d');
      c2d.fillStyle = '#fff';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: c2d, viewport }).promise;
      page.cleanup();
      if (token !== renderToken) return;
      thumbs[i - 1].querySelector('.pdf2img-thumb-slot').appendChild(canvas);
    } catch (err) {
      console.error(`[pdf-to-img] vignette page ${i}`, err);
    }
  }
}

async function handleFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    setStatus('Fichier invalide : PDF requis.', true);
    return;
  }
  try {
    $('.pdf2img-drop').style.opacity = '.6';
    const lib = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({ data }).promise;

    await resetFile(false);
    pdfDoc = doc;
    pdfFile = file;
    selected = new Set(Array.from({ length: doc.numPages }, (_, i) => i + 1));

    $('.pdf2img-meta-name').textContent = file.name;
    $('.pdf2img-meta-sub').textContent = `${formatSize(file.size)} · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`;
    $('.pdf2img-drop').hidden = true;
    $('.pdf2img-work').hidden = false;
    setStatus('');
    setProgress(null);
    updateCount();
    icons();
    renderThumbnails();
  } catch (err) {
    console.error('[pdf-to-img]', err);
    setStatus(`Lecture impossible : ${err.message || err}`, true);
  } finally {
    const drop = $('.pdf2img-drop');
    if (drop) drop.style.opacity = '';
  }
}

async function resetFile(showDrop = true) {
  renderToken++; // stoppe les rendus en cours
  if (pdfDoc) {
    try { await pdfDoc.destroy(); } catch (_) { /* ignore */ }
  }
  pdfDoc = null;
  pdfFile = null;
  selected = new Set();
  if (!root) return;
  const grid = $('.pdf2img-grid');
  if (grid) grid.textContent = ''; // libère les canvas
  const input = $('.pdf2img-drop input');
  if (input) input.value = '';
  if (showDrop) {
    $('.pdf2img-drop').hidden = false;
    $('.pdf2img-work').hidden = true;
    setStatus('');
    setProgress(null);
  }
}

async function convert() {
  if (busy || !pdfDoc || selected.size === 0) return;
  busy = true;
  updateCount();
  const go = $('.pdf2img-go');
  go.disabled = true;

  const fmt = FORMATS[$('#pdf2img-format').value];
  const wantedScale = Number($('#pdf2img-scale').value);
  const pages = [...selected].sort((a, b) => a - b);
  const name = baseName(pdfFile.name);
  const results = []; // { blob, filename }

  try {
    for (let k = 0; k < pages.length; k++) {
      const num = pages[k];
      setStatus(`Rendu page ${num} (${k + 1}/${pages.length})…`);
      setProgress(k / pages.length);

      const page = await pdfDoc.getPage(num);
      let scale = wantedScale;
      const base = page.getViewport({ scale: 1 });
      // Réduit l'échelle si le canvas dépasse le garde-fou mémoire
      while (scale > 0.5 && base.width * scale * base.height * scale > MAX_CANVAS_PIXELS) scale -= 0.25;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const c2d = canvas.getContext('2d');
      c2d.fillStyle = '#fff'; // fond blanc (JPG sans transparence)
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: c2d, viewport }).promise;
      page.cleanup();

      const blob = await canvasToBlob(canvas, fmt);
      canvas.width = canvas.height = 0; // libère la mémoire du canvas
      results.push({ blob, filename: `${name}_page_${num}.${fmt.ext}` });
    }

    if (results.length === 1) {
      setProgress(1);
      download(results[0].blob, results[0].filename);
    } else {
      setStatus('Compression ZIP…');
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      results.forEach((r) => zip.file(r.filename, r.blob));
      const zipBlob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' }, // images déjà compressées
        (m) => setProgress(0.9 + (m.percent / 100) * 0.1)
      );
      download(zipBlob, `${name}_images.zip`);
    }
    setProgress(1);
    setStatus(`Terminé : ${results.length} image${results.length > 1 ? 's' : ''}.`);
  } catch (err) {
    console.error('[pdf-to-img]', err);
    setStatus(`Erreur : ${err.message || err}`, true);
    setProgress(null);
  } finally {
    results.length = 0; // libère les Blobs
    busy = false;
    updateCount();
  }
}

// ---- API du module ----
export function mount(container, ctx) {
  unmount(); // sécurité : état propre
  root = container;

  styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  root.innerHTML = TEMPLATE;
  icons();

  const drop = $('.pdf2img-drop');
  const input = drop.querySelector('input');

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => handleFile(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
    })
  );
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  $('.pdf2img-change').addEventListener('click', () => resetFile(true));
  $('.pdf2img-all').addEventListener('click', () => setAll(true));
  $('.pdf2img-none').addEventListener('click', () => setAll(false));
  $('.pdf2img-go').addEventListener('click', convert);
}

export function unmount() {
  renderToken++;
  busy = false;
  if (pdfDoc) {
    try { pdfDoc.destroy(); } catch (_) { /* ignore */ }
  }
  pdfDoc = null;
  pdfFile = null;
  selected = new Set();
  revokeAll();
  if (workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
  }
  if (styleEl) {
    styleEl.remove();
    styleEl = null;
  }
  if (root) {
    root.textContent = '';
    root = null;
  }
}
