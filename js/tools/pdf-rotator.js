/**
 * pdf-rotator.js — Rotation de pages PDF 100 % client.
 * Contrat : mount(container, ctx) / unmount().
 * Libs (pdf-lib, pdfjs-dist) chargées à la demande depuis des CDN avec bascule automatique.
 * pdf.js : vignettes uniquement ; pdf-lib : écriture des rotations dans le PDF final.
 */

const PDFLIB_URLS = [
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm',
  'https://esm.sh/pdf-lib@1.17.1',
  'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js',
];
const PDFJS_BASES = [
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379',
  'https://unpkg.com/pdfjs-dist@4.0.379',
];
const THUMB_W = 150;
const THUMB_H = 200; // = hauteur .pdfrot-thumb (CSS)

let pdfLibPromise = null;
let pdfJsPromise = null;
let workerBlobUrl = null; // blob du worker pdf.js (révoqué au unmount)
let s = null; // état de l'instance montée

const q = (cls) => s?.root.querySelector('.pdfrot-' + cls);
const refreshIcons = () => window.lucide?.createIcons();
const norm = (a) => ((a % 360) + 360) % 360;
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (b) =>
  b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(2)} Mo`;
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Charge pdf-lib (cache + fallback sur les URLs de secours). */
function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = (async () => {
      let lastErr;
      for (const url of PDFLIB_URLS) {
        try {
          const mod = await import(/* @vite-ignore */ url);
          const lib = mod.PDFDocument ? mod : mod.default;
          if (lib && lib.PDFDocument) return lib;
        } catch (e) { lastErr = e; }
      }
      pdfLibPromise = null;
      throw lastErr || new Error('pdf-lib indisponible (réseau / CDN).');
    })();
  }
  return pdfLibPromise;
}

/** Charge pdfjs-dist + worker (récupéré en blob pour contourner le CORS des workers). */
function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      let lastErr;
      for (const base of PDFJS_BASES) {
        try {
          const mod = await import(/* @vite-ignore */ `${base}/build/pdf.min.mjs`);
          const res = await fetch(`${base}/build/pdf.worker.min.mjs`);
          if (!res.ok) throw new Error('worker HTTP ' + res.status);
          const text = await res.text();
          workerBlobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
          mod.GlobalWorkerOptions.workerSrc = workerBlobUrl;
          return mod;
        } catch (e) { lastErr = e; }
      }
      pdfJsPromise = null;
      throw lastErr || new Error('pdf.js indisponible (réseau / CDN).');
    })();
  }
  return pdfJsPromise;
}

/* ───────────────────────── Statut / progression ───────────────────────── */

function setStatus(msg = '', kind = '') {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pdfrot-status' + (kind ? ' is-' + kind : '');
}

function setProgress(pct) {
  const bar = q('barline');
  if (bar) bar.firstElementChild.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function syncControls() {
  if (!s?.file) return;
  const off = s.busy || !s.entries.length;
  s.root.querySelectorAll('[data-batch], [data-act="go"]').forEach((b) => (b.disabled = off));
  s.root.querySelectorAll('.pdfrot-ibtn').forEach((b) => (b.disabled = s.busy));
  const reset = q('tools')?.querySelector('[data-batch="reset"]');
  if (reset) reset.disabled = off || s.entries.every((e) => e.add === 0);
  const rm = s.root.querySelector('[data-act="remove"]');
  if (rm) rm.disabled = s.exporting;
}

/* ───────────────────────── Libération mémoire ───────────────────────── */

function clearUrls() {
  if (!s) return;
  s.timers.forEach(clearTimeout);
  s.timers.clear();
  s.urls.forEach((u) => URL.revokeObjectURL(u));
  s.urls.clear();
}

function releaseDoc() {
  if (s?.pdfDoc) { try { s.pdfDoc.destroy(); } catch { /* noop */ } }
  if (s) s.pdfDoc = null;
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
  }, 10000);
  s.timers.add(t);
}

/* ───────────────────────── Vignettes ───────────────────────── */

/** Rendu (ou re-rendu après rotation) d'une vignette, via file séquentielle. */
function queueThumb(e, token) {
  if (!s) return Promise.resolve();
  s.chain = s.chain.then(async () => {
    if (!s || token !== s.token || !s.pdfDoc) return;
    try {
      const page = await s.pdfDoc.getPage(e.idx + 1);
      const rot = norm(e.base + e.add);
      const v1 = page.getViewport({ scale: 1, rotation: rot });
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const scale = Math.min(THUMB_W / v1.width, THUMB_H / v1.height) * dpr;
      const vp = page.getViewport({ scale, rotation: rot });
      const c = e.canvas;
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      c.style.width = c.width / dpr + 'px';
      c.style.height = c.height / dpr + 'px';
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
    } catch { /* rendu annulé / page illisible : ignoré */ }
  });
  return s.chain;
}

/** Met à jour badge + état visuel d'une carte. */
function updateCard(e) {
  const rot = norm(e.base + e.add);
  e.badge.textContent = rot + '°';
  e.el.classList.toggle('is-rotated', e.add !== 0);
}

function makeEntry(idx) {
  const el = document.createElement('div');
  el.className = 'pdfrot-card';
  el.dataset.idx = idx;
  el.innerHTML = `
    <div class="pdfrot-thumb"><canvas width="1" height="1"></canvas><span class="pdfrot-badge">0°</span></div>
    <div class="pdfrot-bar">
      <button type="button" class="pdfrot-ibtn" data-a="ccw" title="Pivoter à gauche (-90°)" aria-label="Pivoter à gauche"><i data-lucide="rotate-ccw"></i></button>
      <span class="pdfrot-num">Page ${idx + 1}</span>
      <button type="button" class="pdfrot-ibtn" data-a="cw" title="Pivoter à droite (+90°)" aria-label="Pivoter à droite"><i data-lucide="rotate-cw"></i></button>
    </div>`;
  return { idx, base: 0, add: 0, el, canvas: el.querySelector('canvas'), badge: el.querySelector('.pdfrot-badge') };
}

/* ───────────────────────── Rotations ───────────────────────── */

/** scope : 'all' | 'even' | 'odd' (numérotation 1-based) ; delta en degrés. */
function rotate(scope, delta) {
  if (!s || s.busy) return;
  let n = 0;
  s.entries.forEach((e) => {
    const page = e.idx + 1;
    if (scope === 'even' && page % 2 !== 0) return;
    if (scope === 'odd' && page % 2 === 0) return;
    e.add = norm(e.add + delta);
    updateCard(e);
    queueThumb(e, s.token);
    n++;
  });
  setStatus(`${n} page${n > 1 ? 's' : ''} pivotée${n > 1 ? 's' : ''} (${delta > 0 ? '+' : ''}${delta}°).`);
  syncControls();
}

function resetAll() {
  if (!s || s.busy) return;
  s.entries.forEach((e) => {
    if (e.add === 0) return;
    e.add = 0;
    updateCard(e);
    queueThumb(e, s.token);
  });
  setStatus('Rotations réinitialisées.');
  syncControls();
}

/* ───────────────────────── Chargement du PDF ───────────────────────── */

async function loadFile(file) {
  if (!s) return;
  if (!isPdf(file)) return showDropError('Fichier non valide : PDF attendu.');
  const token = ++s.token;
  s.busy = true;
  s.file = file;
  s.entries = [];
  renderWork();
  setProgress(0);
  setStatus('Chargement des bibliothèques…');
  try {
    const [pdfjs] = await Promise.all([loadPdfJs(), loadPdfLib()]);
    if (!s || token !== s.token) return;
    setStatus('Lecture du PDF…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!s || token !== s.token) return;
    s.bytes = bytes;
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise; // copie : pdf.js détache le buffer
    if (!s || token !== s.token) { doc.destroy(); return; }
    s.pdfDoc = doc;

    // Rotation intrinsèque de chaque page (affichée dans le badge)
    const grid = q('grid');
    const meta = q('meta');
    const entries = [];
    for (let i = 0; i < doc.numPages; i++) {
      const e = makeEntry(i);
      const page = await doc.getPage(i + 1);
      e.base = norm(page.rotate || 0);
      page.cleanup();
      if (!s || token !== s.token) return;
      updateCard(e);
      grid.appendChild(e.el);
      entries.push(e);
    }
    s.entries = entries;
    meta.textContent = `${fmtSize(file.size)} · ${entries.length} page${entries.length > 1 ? 's' : ''}`;
    refreshIcons();
    s.busy = false;
    syncControls();

    setStatus('Génération des aperçus…');
    let done = 0;
    await Promise.all(
      entries.map((e) =>
        queueThumb(e, token).then(() => {
          if (!s || token !== s.token) return;
          setProgress((++done / entries.length) * 100);
        })
      )
    );
    if (s && token === s.token) setStatus('Prêt : pivotez les pages puis téléchargez.');
  } catch (err) {
    if (!s || token !== s.token) return;
    const enc = /password|encrypt/i.test(err?.message || '');
    releaseDoc();
    s.file = null;
    s.bytes = null;
    s.entries = [];
    s.busy = false;
    renderDrop();
    showDropError(enc ? 'PDF protégé par mot de passe : impossible de le traiter.' : 'Erreur : ' + (err?.message || 'PDF illisible.'));
  }
}

/* ───────────────────────── Export (pdf-lib) ───────────────────────── */

async function exportPdf() {
  if (!s || s.busy || !s.bytes) return;
  const token = s.token;
  s.busy = true;
  s.exporting = true;
  syncControls();
  setProgress(5);
  setStatus('Chargement du moteur PDF…');
  try {
    const { PDFDocument, degrees } = await loadPdfLib();
    if (!s || token !== s.token) return;
    setStatus('Application des rotations…');
    const doc = await PDFDocument.load(s.bytes, { ignoreEncryption: true });
    const pages = doc.getPages();
    const total = s.entries.length;
    s.entries.forEach((e, i) => {
      const pg = pages[e.idx];
      if (pg && e.add) pg.setRotation(degrees(norm(pg.getRotation().angle + e.add)));
      if (i % 25 === 24) setProgress(10 + (i / total) * 70);
    });
    setProgress(85);
    setStatus('Génération du fichier…');
    const out = await doc.save();
    if (!s || token !== s.token) return;
    const name = s.file.name.replace(/\.pdf$/i, '') + '_pivote.pdf';
    download(new Blob([out], { type: 'application/pdf' }), name);
    setProgress(100);
    setStatus(`Terminé : ${name} (${fmtSize(out.byteLength)}).`, 'ok');
  } catch (err) {
    if (s && token === s.token) {
      setProgress(0);
      setStatus('Échec de l\'export : ' + (err?.message || err), 'error');
    }
  } finally {
    if (s && token === s.token) {
      s.busy = false;
      s.exporting = false;
      syncControls();
    }
  }
}

/* ───────────────────────── Vues ───────────────────────── */

/** Retire le fichier : invalide les tâches, libère buffers et URLs, revient au dépôt. */
function reset() {
  if (!s) return;
  s.token++;
  clearUrls();
  releaseDoc();
  s.file = null;
  s.bytes = null;
  s.entries = [];
  s.busy = false;
  s.exporting = false;
  s.chain = Promise.resolve();
  renderDrop();
}

function showDropError(msg) {
  const el = q('dropstatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pdfrot-status is-error';
}

function renderDrop() {
  s.root.innerHTML = `
    <div class="pdfrot">
      <div class="pdfrot-drop" tabindex="0" role="button" aria-label="Choisir un fichier PDF">
        <i data-lucide="upload-cloud"></i>
        <strong>Glissez-déposez votre PDF ici</strong>
        <small>ou cliquez pour parcourir · un seul fichier</small>
        <input type="file" accept="application/pdf" hidden />
      </div>
      <div class="pdfrot-status pdfrot-dropstatus" role="status" aria-live="polite"></div>
    </div>`;
  const drop = q('drop');
  const input = drop.querySelector('input');
  const pick = (files) => {
    const f = [...files][0];
    if (f && !s.busy) loadFile(f);
  };
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
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

function renderWork() {
  s.root.innerHTML = `
    <div class="pdfrot">
      <div class="pdfrot-file">
        <i data-lucide="file-text"></i>
        <div class="pdfrot-file-txt">
          <div class="pdfrot-name" title="${esc(s.file.name)}">${esc(s.file.name)}</div>
          <div class="pdfrot-meta">${fmtSize(s.file.size)}</div>
        </div>
        <button type="button" class="btn-remove-file" data-act="remove"><i data-lucide="x"></i>Retirer</button>
      </div>
      <div class="pdfrot-tools">
        <label class="pdfrot-field">Angle des actions groupées
          <select class="pdfrot-angle">
            <option value="90">90° à droite (↻)</option>
            <option value="-90">90° à gauche (↺)</option>
            <option value="180">180°</option>
          </select>
        </label>
        <button type="button" class="pdfrot-btn" data-batch="all" disabled><i data-lucide="layers"></i>Toutes les pages</button>
        <button type="button" class="pdfrot-btn" data-batch="even" disabled><i data-lucide="list-ordered"></i>Pages paires</button>
        <button type="button" class="pdfrot-btn" data-batch="odd" disabled><i data-lucide="list"></i>Pages impaires</button>
        <button type="button" class="pdfrot-btn" data-batch="reset" disabled><i data-lucide="undo-2"></i>Tout réinitialiser</button>
      </div>
      <div class="pdfrot-preview-box"><div class="pdfrot-grid"></div></div>
      <div class="pdfrot-foot">
        <div class="pdfrot-progress">
          <div class="pdfrot-barline"><i></i></div>
          <div class="pdfrot-status" role="status" aria-live="polite"></div>
        </div>
        <button type="button" class="btn-primary" data-act="go" disabled><i data-lucide="download"></i>Télécharger le PDF pivoté</button>
      </div>
    </div>`;
  // Les métadonnées (.pdfrot-meta) sont complétées une fois les pages comptées
  s.root.querySelector('[data-act="remove"]').addEventListener('click', reset);
  s.root.querySelector('[data-act="go"]').addEventListener('click', exportPdf);
  q('tools').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-batch]');
    if (!b) return;
    const what = b.dataset.batch;
    if (what === 'reset') return resetAll();
    rotate(what, parseInt(q('angle').value, 10));
  });
  q('grid').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-a]');
    const card = ev.target.closest('.pdfrot-card');
    if (!b || !card || s.busy) return;
    const e = s.entries[Number(card.dataset.idx)];
    if (!e) return;
    e.add = norm(e.add + (b.dataset.a === 'cw' ? 90 : -90));
    updateCard(e);
    queueThumb(e, s.token);
    syncControls();
  });
  refreshIcons();
}

export function mount(container, ctx) {
  s = {
    root: container, ctx, file: null, bytes: null, pdfDoc: null, entries: [],
    token: 0, chain: Promise.resolve(), busy: false, exporting: false,
    urls: new Set(), timers: new Set(),
  };
  renderDrop();
}

export function unmount() {
  if (!s) return;
  s.token++; // stoppe rendus et exports en cours
  clearUrls(); // révoque les URL Blob de téléchargement
  releaseDoc();
  s.bytes = null;
  s.entries = [];
  s.root.innerHTML = '';
  if (workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
    pdfJsPromise = null; // le worker sera recréé au prochain montage
  }
  s = null;
}
