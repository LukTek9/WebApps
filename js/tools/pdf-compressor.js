/**
 * pdf-compressor.js — Compresseur de PDF 100 % client.
 * Contrat : export mount(container, ctx) / unmount().
 * Moteur : pdfjs-dist (rendu pages) + pdf-lib (reconstruction PDF), chargés à la demande.
 * Méthode : chaque page est ré-échantillonnée (canvas → JPEG) selon le niveau choisi,
 * puis réinsérée dans un nouveau PDFDocument.create() aux dimensions d'origine.
 * Note : le texte devient image (non sélectionnable) — compromis inhérent au ré-échantillonnage.
 */

const PDFJS_VERSION = '4.4.168';
const PDFLIB_VERSION = '1.17.1';

/** Sources de secours (fallback automatique). */
const PDFJS_SOURCES = [
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`,
  `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`,
];
const PDFJS_WORKER_SOURCES = [
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`,
  `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`,
];
const PDFLIB_SOURCES = [
  `https://cdn.jsdelivr.net/npm/pdf-lib@${PDFLIB_VERSION}/+esm`,
  `https://esm.sh/pdf-lib@${PDFLIB_VERSION}`,
];

/** Niveaux : scale = résolution de rendu (1 = 72 dpi), quality = JPEG 0-1. */
const LEVELS = {
  recommended: { label: 'Recommandée', desc: 'Équilibre qualité / poids', scale: 1.5, quality: 0.7 },
  strong:      { label: 'Forte compression', desc: 'Poids minimal, qualité réduite', scale: 1.0, quality: 0.5 },
  light:       { label: 'Faible compression', desc: 'Qualité maximale, gain modéré', scale: 2.0, quality: 0.85 },
};

const STYLE_ID = 'pdf-compressor-style';
const CSS = `
.pdfc{display:flex;flex-direction:column;gap:16px;max-width:900px;margin:0 auto}
.pdfc-drop{border:2px dashed var(--border,#3a3a4e);border-radius:var(--radius,12px);padding:56px 24px;text-align:center;cursor:pointer;transition:background .2s,border-color .2s}
.pdfc-drop:hover,.pdfc-drop.is-over{background:rgba(127,127,127,.08);border-color:var(--primary,#ef4444)}
.pdfc-drop p{margin:8px 0 0;opacity:.7}
.pdfc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pdfc-meta{display:flex;gap:16px;flex-wrap:wrap;align-items:baseline}
.pdfc-meta strong{word-break:break-all}
.pdfc-meta span{opacity:.7;font-size:.9em}
.pdfc-reset{display:inline-flex;align-items:center;gap:6px;cursor:pointer;background:none;border:1px solid var(--border,#3a3a4e);color:inherit;border-radius:var(--radius,12px);padding:6px 12px}
.compressor-preview-box{height:440px;flex:none;overflow-y:auto;contain:size layout paint;background:var(--bg-preview,#1e1e2e);border-radius:var(--radius,12px);padding:16px;box-sizing:border-box;display:flex;gap:16px;flex-wrap:wrap;align-content:flex-start;justify-content:center}
.pdfc-thumb{flex:none;width:260px;display:flex;flex-direction:column;align-items:center;gap:8px;color:#fff}
.pdfc-thumb canvas{max-width:100%;height:auto;background:#fff;border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,.4)}
.pdfc-thumb small{opacity:.7}
.pdfc-compare{flex:1 1 260px;min-width:240px;display:flex;flex-direction:column;gap:12px;color:#fff}
.pdfc-row{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(255,255,255,.06);border-radius:8px}
.pdfc-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:600;background:#16a34a;color:#fff}
.pdfc-badge.is-neg{background:#dc2626}
.pdfc-levels{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.pdfc-level{display:block;cursor:pointer}
.pdfc-level input{position:absolute;opacity:0;pointer-events:none}
.pdfc-level div{border:2px solid var(--border,#3a3a4e);border-radius:var(--radius,12px);padding:12px 14px;transition:border-color .2s,background .2s}
.pdfc-level input:checked + div{border-color:var(--primary,#ef4444);background:rgba(239,68,68,.08)}
.pdfc-level b{display:block}.pdfc-level span{font-size:.85em;opacity:.7}
.pdfc-actions{display:flex;flex-direction:column;gap:8px}
.pdfc-bar{height:8px;border-radius:999px;background:rgba(127,127,127,.25);overflow:hidden}
.pdfc-bar i{display:block;height:100%;width:0;background:var(--primary,#ef4444);transition:width .15s}
.pdfc-status{font-size:.9em;opacity:.8;min-height:1.2em}
.pdfc-btns{display:flex;gap:12px;flex-wrap:wrap}
.pdfc-error{color:#dc2626;font-size:.9em}
.pdfc [hidden]{display:none!important}
`;

// ── État module ─────────────────────────────────────────────────────────────
let root = null;
let pdfjsLib = null;
let pdfLib = null;
let workerBlobUrl = null;
let pdfDoc = null;          // proxy pdfjs
let fileBuf = null;         // ArrayBuffer d'origine
let file = null;
let level = 'recommended';
let resultBlob = null;
let resultUrl = null;
let estimateBytes = null;
let busy = false;
let runId = 0;              // jeton anti-course (async obsolètes)
let cancelFlag = false;

// ── Utilitaires ─────────────────────────────────────────────────────────────
const fmt = (b) => {
  if (b < 1024) return `${b} o`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} Ko`;
  return `${(b / 1048576).toFixed(2)} Mo`;
};
const $ = (sel) => root.querySelector(sel);
const icons = () => { try { window.lucide?.createIcons({ root }); } catch { /* optionnel */ } };

async function importFirst(urls) {
  let lastErr;
  for (const u of urls) {
    try { return await import(/* @vite-ignore */ u); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Chargement impossible');
}

/** Chargement paresseux pdfjs-dist (worker via blob pour contourner le cross-origin). */
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await importFirst(PDFJS_SOURCES);
  let code = null;
  for (const u of PDFJS_WORKER_SOURCES) {
    try { const r = await fetch(u); if (r.ok) { code = await r.text(); break; } } catch { /* fallback */ }
  }
  if (!code) throw new Error('Worker PDF.js indisponible');
  workerBlobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;
  return pdfjsLib;
}

/** Chargement paresseux pdf-lib. */
async function loadPdfLib() {
  if (pdfLib) return pdfLib;
  const m = await importFirst(PDFLIB_SOURCES);
  pdfLib = m.PDFDocument ? m : (m.default || m);
  return pdfLib;
}

function setStatus(msg, pct) {
  const s = $('.pdfc-status'); if (s) s.textContent = msg || '';
  if (pct != null) { const b = $('.pdfc-bar i'); if (b) b.style.width = `${pct}%`; }
}
function showError(msg) { const e = $('.pdfc-error'); if (e) { e.textContent = msg || ''; e.hidden = !msg; } }

function revokeResult() {
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  resultBlob = null;
}

/** Rend une page en JPEG (Uint8Array) + dimensions d'origine (points PDF). */
async function renderPageJpeg(pageNum, scale, quality) {
  const page = await pdfDoc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const c2d = canvas.getContext('2d', { alpha: false });
  c2d.fillStyle = '#fff';
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: c2d, viewport: vp }).promise;
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  canvas.width = canvas.height = 0; // libère la mémoire
  page.cleanup();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: base.width, h: base.height };
}

// ── Aperçu & estimation ─────────────────────────────────────────────────────
async function renderThumbnail(id) {
  const holder = $('.pdfc-thumb-canvas');
  const page = await pdfDoc.getPage(1);
  const vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 260 / vp0.width * (window.devicePixelRatio || 1) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  page.cleanup();
  if (id !== runId) return;
  holder.replaceChildren(canvas);
}

/** Estimation = taille JPEG page 1 × nb pages (+ surcoût fixe). */
async function updateEstimate() {
  const id = runId;
  const lv = LEVELS[level];
  $('.pdfc-new').textContent = 'Calcul…';
  $('.pdfc-badge').hidden = true;
  try {
    const { bytes } = await renderPageJpeg(1, lv.scale, lv.quality);
    if (id !== runId) return;
    estimateBytes = Math.round(bytes.length * pdfDoc.numPages + 1500 + pdfDoc.numPages * 200);
    showComparison(estimateBytes, true);
  } catch (e) {
    if (id === runId) $('.pdfc-new').textContent = '—';
  }
}

function showComparison(newSize, isEstimate) {
  const old = file.size;
  const pct = Math.round((1 - newSize / old) * 100);
  $('.pdfc-new-label').textContent = isEstimate ? 'Poids réestimé' : 'Poids compressé';
  $('.pdfc-new').textContent = `${isEstimate ? '≈ ' : ''}${fmt(newSize)}`;
  const badge = $('.pdfc-badge');
  badge.hidden = false;
  badge.classList.toggle('is-neg', pct < 0);
  badge.textContent = pct >= 0 ? `-${pct} %` : `+${Math.abs(pct)} %`;
}

// ── Chargement fichier ──────────────────────────────────────────────────────
async function handleFile(f) {
  showError('');
  if (!f || (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name))) {
    showError('Fichier PDF requis.'); return;
  }
  reset(true);
  const id = ++runId;
  file = f;
  $('.pdfc-drop').hidden = true;
  $('.pdfc-work').hidden = false;
  setStatus('Chargement du moteur PDF…', 0);
  try {
    const lib = await loadPdfjs();
    fileBuf = await f.arrayBuffer();
    // slice() : pdfjs transfère le buffer au worker → on garde une copie
    pdfDoc = await lib.getDocument({ data: new Uint8Array(fileBuf.slice(0)) }).promise;
    if (id !== runId) return;
    $('.pdfc-name').textContent = f.name;
    $('.pdfc-size').textContent = fmt(f.size);
    $('.pdfc-pages').textContent = `${pdfDoc.numPages} page${pdfDoc.numPages > 1 ? 's' : ''}`;
    $('.pdfc-old').textContent = fmt(f.size);
    setStatus('', 0);
    await renderThumbnail(id);
    await updateEstimate();
  } catch (e) {
    if (id !== runId) return;
    showError(`Erreur de lecture : ${e.message || e}`);
    reset(false);
  }
}

// ── Compression ─────────────────────────────────────────────────────────────
async function compress() {
  if (busy || !pdfDoc) return;
  busy = true; cancelFlag = false;
  const id = runId;
  showError('');
  revokeResult();
  $('.pdfc-go').disabled = true;
  $('.pdfc-dl').hidden = true;
  try {
    const { PDFDocument } = await loadPdfLib();
    const lv = LEVELS[level];
    const out = await PDFDocument.create();
    const n = pdfDoc.numPages;
    for (let i = 1; i <= n; i++) {
      if (cancelFlag || id !== runId) return;
      setStatus(`Page ${i} / ${n}…`, Math.round(((i - 1) / n) * 100));
      const { bytes, w, h } = await renderPageJpeg(i, lv.scale, lv.quality);
      const img = await out.embedJpg(bytes);
      out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    setStatus('Finalisation…', 98);
    const saved = await out.save({ useObjectStreams: true });
    if (id !== runId) return;
    resultBlob = new Blob([saved], { type: 'application/pdf' });
    setStatus('Terminé', 100);
    showComparison(resultBlob.size, false);
    if (resultBlob.size >= file.size) {
      showError('Le fichier obtenu n\'est pas plus léger : essayez « Forte compression » (ou conservez l\'original).');
    }
    $('.pdfc-dl').hidden = false;
  } catch (e) {
    if (id === runId) { showError(`Échec de la compression : ${e.message || e}`); setStatus('', 0); }
  } finally {
    busy = false;
    const go = $('.pdfc-go'); if (go) go.disabled = false;
  }
}

function download() {
  if (!resultBlob) return;
  const url = URL.createObjectURL(resultBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${file.name.replace(/\.pdf$/i, '')}_compresse.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Libération mémoire après déclenchement du téléchargement
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Réinitialise l'outil. `keepUi` = conserve l'état d'affichage (changement de fichier). */
function reset(keepUi) {
  runId++; cancelFlag = true;
  revokeResult();
  if (pdfDoc) { try { pdfDoc.destroy(); } catch { /* ignore */ } pdfDoc = null; }
  fileBuf = null; file = null; estimateBytes = null;
  if (!root) return;
  if (!keepUi) {
    $('.pdfc-work').hidden = true;
    $('.pdfc-drop').hidden = false;
    $('.pdfc-input').value = '';
  }
  const holder = $('.pdfc-thumb-canvas'); if (holder) holder.replaceChildren();
  $('.pdfc-dl').hidden = true;
  $('.pdfc-badge').hidden = true;
  setStatus('', 0);
}

// ── Contrat module ──────────────────────────────────────────────────────────
export function mount(container, ctx) {
  root = container;
  level = 'recommended';
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }

  const levelsHtml = Object.entries(LEVELS).map(([k, v]) => `
    <label class="pdfc-level">
      <input type="radio" name="pdfc-level" value="${k}" ${k === level ? 'checked' : ''}>
      <div><b>${v.label}</b><span>${v.desc}</span></div>
    </label>`).join('');

  root.innerHTML = `
  <div class="pdfc">
    <div class="pdfc-drop" tabindex="0" role="button" aria-label="Déposer un PDF">
      <i data-lucide="file-archive" style="width:48px;height:48px"></i>
      <h3>Glissez votre PDF ici</h3>
      <p>ou cliquez pour sélectionner un fichier</p>
      <input class="pdfc-input" type="file" accept="application/pdf" hidden>
    </div>
    <div class="pdfc-work" hidden>
      <div class="pdfc-head">
        <div class="pdfc-meta">
          <strong class="pdfc-name"></strong>
          <span class="pdfc-size"></span>
          <span class="pdfc-pages"></span>
        </div>
        <button type="button" class="pdfc-reset" title="Changer de fichier"><i data-lucide="trash-2" style="width:16px;height:16px"></i> Changer de fichier</button>
      </div>
      <div class="compressor-preview-box" style="margin-top:16px">
        <div class="pdfc-thumb"><div class="pdfc-thumb-canvas"></div><small>Page 1</small></div>
        <div class="pdfc-compare">
          <div class="pdfc-row"><span>Poids initial</span><strong class="pdfc-old">—</strong></div>
          <div class="pdfc-row"><span class="pdfc-new-label">Poids réestimé</span><strong class="pdfc-new">—</strong></div>
          <div><span class="pdfc-badge" hidden></span></div>
        </div>
      </div>
      <div class="pdfc-levels" style="margin-top:16px">${levelsHtml}</div>
      <div class="pdfc-actions" style="margin-top:16px">
        <div class="pdfc-bar"><i></i></div>
        <div class="pdfc-status"></div>
        <div class="pdfc-btns">
          <button type="button" class="btn-primary pdfc-go">Compresser</button>
          <button type="button" class="btn-primary pdfc-dl" hidden>Télécharger</button>
        </div>
      </div>
    </div>
    <div class="pdfc-error" hidden></div>
  </div>`;

  const drop = $('.pdfc-drop');
  const input = $('.pdfc-input');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    handleFile(e.dataTransfer.files?.[0]);
  });
  input.addEventListener('change', () => handleFile(input.files?.[0]));
  $('.pdfc-reset').addEventListener('click', () => reset(false));
  $('.pdfc-go').addEventListener('click', compress);
  $('.pdfc-dl').addEventListener('click', download);
  root.querySelectorAll('input[name="pdfc-level"]').forEach((r) =>
    r.addEventListener('change', () => {
      level = r.value;
      revokeResult();
      $('.pdfc-dl').hidden = true;
      setStatus('', 0);
      if (pdfDoc && !busy) updateEstimate();
    }));
  icons();
}

export function unmount() {
  runId++; cancelFlag = true; busy = false;
  revokeResult();
  if (pdfDoc) { try { pdfDoc.destroy(); } catch { /* ignore */ } pdfDoc = null; }
  if (workerBlobUrl) { URL.revokeObjectURL(workerBlobUrl); workerBlobUrl = null; if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = ''; pdfjsLib = null; }
  fileBuf = null; file = null; estimateBytes = null;
  if (root) root.innerHTML = '';
  root = null;
}
