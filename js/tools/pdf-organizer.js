/**
 * pdf-organizer.js — Rotateur & Réorganisateur de PDF (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 * Libs (pdf-lib, pdfjs-dist) chargées à la demande depuis des CDN avec bascule automatique.
 */

/* ───────────────────────── Constantes & chargement paresseux ───────────────────────── */

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
const THUMB_H = 200;
const STYLE_ID = 'po-organizer-style';

let pdfLibPromise = null;
let pdfJsPromise = null;
let workerBlobUrl = null; // blob du worker pdf.js (révoqué au unmount)

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
      throw lastErr || new Error('pdf-lib indisponible');
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
      throw lastErr || new Error('pdfjs indisponible');
    })();
  }
  return pdfJsPromise;
}

/* ───────────────────────── Styles (tokens de thème via var(--…)) ───────────────────────── */

const CSS = `
.po-root{display:flex;flex-direction:column;gap:12px;width:100%;box-sizing:border-box}
.po-drop{flex:none;height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  border:2px dashed var(--border,#44475a);border-radius:var(--radius,12px);cursor:pointer;text-align:center;
  color:var(--text-muted,#9aa0b4);transition:border-color .15s,background .15s}
.po-drop:hover,.po-drop.is-over{border-color:var(--primary,#ef4444);background:rgba(239,68,68,.06)}
.po-drop strong{color:var(--text,inherit);font-size:1rem}
.po-meta{flex:none;height:52px;display:flex;align-items:center;gap:16px;padding:0 4px;overflow:hidden;white-space:nowrap}
.po-meta-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.po-meta-info{color:var(--text-muted,#9aa0b4);font-size:.9rem;flex:none}
.po-actions{flex:none;display:flex;flex-wrap:wrap;gap:8px}
.po-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;border:1px solid var(--border,#44475a);
  border-radius:var(--radius,12px);background:var(--surface,transparent);color:var(--text,inherit);font:inherit;cursor:pointer;transition:background .15s,opacity .15s}
.po-btn:hover:not(:disabled){background:rgba(127,127,127,.15)}
.po-btn:disabled{opacity:.45;cursor:not-allowed}
.po-btn.primary,.btn-primary{background:var(--primary,#ef4444);border-color:var(--primary,#ef4444);color:#fff;font-weight:600;padding:10px 20px;font-size:14px;display:inline-flex;align-items:center;gap:8px;height:auto;max-width:max-content;flex:none;white-space:nowrap}
.po-remove{flex:none}
.po-remove svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.po-btn svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.po-btn.primary:hover:not(:disabled){filter:brightness(1.1);background:var(--primary,#ef4444)}
.organizer-preview-box{height:480px;flex:none;overflow-y:auto;contain:size layout paint;background:var(--bg-preview,#1e1e2e);
  border-radius:var(--radius,12px);padding:16px;width:100%;box-sizing:border-box}
.po-empty{height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted,#9aa0b4);text-align:center}
.po-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:14px;align-content:start}
.po-card{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:var(--radius,12px);background:rgba(255,255,255,.06);
  border:1px solid transparent;cursor:grab;user-select:none}
.po-card.is-dragging{opacity:.4}
.po-card.is-target{border-color:var(--primary,#ef4444)}
.po-thumb{height:${THUMB_H}px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:rgba(0,0,0,.25);border-radius:6px}
.po-thumb canvas{background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.po-card-bar{display:flex;align-items:center;justify-content:space-between;gap:4px;color:#e5e7eb}
.po-num{font-size:.8rem;color:#c3c7d6;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.po-ibtn{width:30px;height:30px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;
  background:rgba(255,255,255,.1);color:#e5e7eb;cursor:pointer}
.po-ibtn:hover:not(:disabled){background:rgba(255,255,255,.22)}
.po-ibtn:disabled{opacity:.3;cursor:not-allowed}
.po-ibtn.danger:hover:not(:disabled){background:#dc2626}
.po-ibtn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.po-foot{flex:none;display:flex;align-items:center;gap:14px;height:44px}
.po-progress{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;justify-content:center}
.po-bar{height:8px;border-radius:99px;background:rgba(127,127,127,.25);overflow:hidden}
.po-bar>div{height:100%;width:0;background:var(--primary,#ef4444);transition:width .15s}
.po-status{font-size:.8rem;color:var(--text-muted,#9aa0b4);height:1.1em;line-height:1.1em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.po-status.error{color:#ef4444}
`;

/* ───────────────────────── Icônes SVG inline (style Lucide) ───────────────────────── */

const ICONS = {
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  rotateCcw: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

/* ───────────────────────── État du module ───────────────────────── */

let S = null; // état courant (null = non monté)

function fmtSize(b) {
  if (b < 1024) return b + ' o';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' Ko';
  return (b / 1048576).toFixed(2) + ' Mo';
}
const norm = (a) => ((a % 360) + 360) % 360;

/* ───────────────────────── mount / unmount ───────────────────────── */

export function mount(container, ctx) {
  unmount(); // sécurité : un seul montage

  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const root = document.createElement('div');
  root.className = 'po-root';
  root.innerHTML = `
    <div class="po-drop" tabindex="0" role="button" aria-label="Choisir un fichier PDF">
      ${svg('upload').replace('<svg', '<svg style="width:32px;height:32px;fill:none;stroke:currentColor;stroke-width:2"')}
      <strong>Glissez-déposez un PDF ici</strong>
      <span class="po-drop-hint">ou cliquez pour parcourir</span>
      <input type="file" accept="application/pdf" hidden>
    </div>
    <div class="po-meta">
      <span class="po-meta-name">Aucun fichier</span>
      <span class="po-meta-info">—</span>
      <button type="button" class="btn-remove-file po-remove" data-act="remove" title="Retirer le fichier" aria-label="Retirer le fichier">${svg('trash')} Retirer le fichier</button>
    </div>
    <div class="po-actions">
      <button type="button" class="po-btn" data-act="rot-all-cw" disabled>${svg('rotate')} Pivoter tout +90°</button>
      <button type="button" class="po-btn" data-act="rot-all-ccw" disabled>${svg('rotateCcw')} Pivoter tout -90°</button>
      <button type="button" class="po-btn" data-act="reset" disabled>${svg('reset')} Réinitialiser</button>
    </div>
    <div class="organizer-preview-box"><div class="po-empty">Aucune page à afficher</div></div>
    <div class="po-foot">
      <div class="po-progress">
        <div class="po-bar"><div></div></div>
        <div class="po-status"></div>
      </div>
      <button type="button" class="po-btn primary btn-primary" data-act="download" disabled>${svg('download')} Télécharger le PDF réorganisé</button>
    </div>`;
  container.appendChild(root);

  S = {
    ctx,
    root,
    container,
    token: 0,           // invalide les rendus asynchrones obsolètes
    file: null,
    bytes: null,        // Uint8Array du PDF source
    pdfDoc: null,       // document pdfjs
    original: [],       // entrées d'origine (pour reset)
    pages: [],          // entrées courantes (ordre / suppression)
    renderChain: Promise.resolve(),
    dlUrl: null,
    dlTimer: null,
    dragFrom: null,
    busy: false,
    el: {
      drop: root.querySelector('.po-drop'),
      hint: root.querySelector('.po-drop-hint'),
      meta: root.querySelector('.po-meta'),
      actions: root.querySelector('.po-actions'),
      foot: root.querySelector('.po-foot'),
      remove: root.querySelector('[data-act=remove]'),
      input: root.querySelector('input[type=file]'),
      name: root.querySelector('.po-meta-name'),
      info: root.querySelector('.po-meta-info'),
      box: root.querySelector('.organizer-preview-box'),
      bar: root.querySelector('.po-bar > div'),
      status: root.querySelector('.po-status'),
      btns: {
        cw: root.querySelector('[data-act=rot-all-cw]'),
        ccw: root.querySelector('[data-act=rot-all-ccw]'),
        reset: root.querySelector('[data-act=reset]'),
        dl: root.querySelector('[data-act=download]'),
      },
    },
  };

  const { el } = S;

  // Drop zone
  el.drop.addEventListener('click', () => el.input.click());
  el.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.input.click(); } });
  el.drop.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); el.drop.classList.add('is-over'); } });
  el.drop.addEventListener('dragleave', () => el.drop.classList.remove('is-over'));
  el.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    el.drop.classList.remove('is-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  el.input.addEventListener('change', () => {
    const f = el.input.files && el.input.files[0];
    if (f) loadFile(f);
    el.input.value = '';
  });

  // Actions globales
  el.btns.cw.addEventListener('click', () => rotateAll(90));
  el.btns.ccw.addEventListener('click', () => rotateAll(-90));
  el.btns.reset.addEventListener('click', resetAll);
  el.btns.dl.addEventListener('click', exportPdf);
  el.remove.addEventListener('click', removeFile);

  setView(false); // état initial : seule la zone de dépôt est visible
}

export function unmount() {
  if (!S) return;
  S.token++; // stoppe les rendus en cours
  clearDownloadUrl();
  if (S.pdfDoc) { try { S.pdfDoc.destroy(); } catch (_) { /* noop */ } }
  if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
  if (workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
    pdfJsPromise = null; // le worker sera recréé au prochain montage
  }
  const st = document.getElementById(STYLE_ID);
  if (st) st.remove();
  S = null;
}

/* ───────────────────────── Utilitaires UI ───────────────────────── */

function hasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}
function setStatus(msg, isError = false) {
  if (!S) return;
  S.el.status.textContent = msg || '';
  S.el.status.classList.toggle('error', !!isError);
}
function setProgress(p) {
  if (S) S.el.bar.style.width = Math.max(0, Math.min(100, p)) + '%';
}
function setControls() {
  if (!S) return;
  const has = S.pages.length > 0 && !S.busy;
  S.el.btns.cw.disabled = !has;
  S.el.btns.ccw.disabled = !has;
  S.el.btns.reset.disabled = !S.original.length || S.busy;
  S.el.btns.dl.disabled = !has;
}
function clearDownloadUrl() {
  if (!S) return;
  if (S.dlTimer) { clearTimeout(S.dlTimer); S.dlTimer = null; }
  if (S.dlUrl) { URL.revokeObjectURL(S.dlUrl); S.dlUrl = null; }
}
function updateMeta() {
  if (!S) return;
  const n = S.pages.length, total = S.original.length;
  S.el.name.textContent = S.file ? S.file.name : 'Aucun fichier';
  S.el.info.textContent = S.file
    ? `${fmtSize(S.file.size)} · ${n} page${n > 1 ? 's' : ''}${n !== total ? ` (sur ${total})` : ''}`
    : '—';
}

/* ───────────────────────── Chargement du PDF ───────────────────────── */

async function loadFile(file) {
  if (!S) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) { showDropError('Fichier non valide : PDF attendu.'); return; }

  const token = ++S.token;
  setView(true);
  S.busy = true;
  clearDownloadUrl();
  if (S.pdfDoc) { try { S.pdfDoc.destroy(); } catch (_) { /* noop */ } S.pdfDoc = null; }
  S.file = file;
  S.original = [];
  S.pages = [];
  renderGrid();
  updateMeta();
  setControls();
  setProgress(0);
  setStatus('Chargement des bibliothèques…');

  try {
    const [pdfjs] = await Promise.all([loadPdfJs(), loadPdfLib()]);
    if (!S || token !== S.token) return;
    setStatus('Lecture du PDF…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!S || token !== S.token) return;
    S.bytes = bytes;
    // pdfjs transfère/détache le buffer → on lui donne une copie
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    if (!S || token !== S.token) { doc.destroy(); return; }
    S.pdfDoc = doc;

    S.original = Array.from({ length: doc.numPages }, (_, i) => makeEntry(i));
    S.pages = S.original.slice();
    updateMeta();
    renderGrid();

    // Vignettes en série (file d'attente)
    let done = 0;
    for (const e of S.pages.slice()) {
      queueThumb(e, token).then(() => {
        if (!S || token !== S.token) return;
        done++;
        setProgress((done / S.original.length) * 100);
        if (done === S.original.length) { setStatus('Prêt.'); S.busy = false; setControls(); }
      });
    }
    setStatus('Génération des aperçus…');
    S.busy = false; // actions disponibles dès l'affichage de la grille
    setControls();
  } catch (err) {
    if (!S || token !== S.token) return;
    S.busy = false;
    S.file = null;
    S.original = [];
    S.pages = [];
    renderGrid();
    updateMeta();
    setControls();
    setProgress(0);
    setStatus('');
    setView(false);
    showDropError('Erreur : ' + (err && err.message ? err.message : 'PDF illisible ou protégé.'));
  }
}

/* ───────────────────────── Entrées de pages & vignettes ───────────────────────── */

function makeEntry(origIndex) {
  const e = { orig: origIndex, add: 0, base: 0 };
  const card = document.createElement('div');
  card.className = 'po-card';
  card.draggable = true;
  card.innerHTML = `
    <div class="po-thumb"><canvas width="1" height="1"></canvas></div>
    <div class="po-card-bar">
      <button type="button" class="po-ibtn" data-a="left" title="Déplacer à gauche" aria-label="Déplacer à gauche">${svg('left')}</button>
      <span class="po-num"></span>
      <button type="button" class="po-ibtn" data-a="rot" title="Pivoter +90°" aria-label="Pivoter de 90 degrés">${svg('rotate')}</button>
      <button type="button" class="po-ibtn danger" data-a="del" title="Supprimer la page" aria-label="Supprimer la page">${svg('trash')}</button>
      <button type="button" class="po-ibtn" data-a="right" title="Déplacer à droite" aria-label="Déplacer à droite">${svg('right')}</button>
    </div>`;
  e.el = card;
  e.canvas = card.querySelector('canvas');
  e.num = card.querySelector('.po-num');

  card.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-a]');
    if (!b || !S) return;
    const i = S.pages.indexOf(e);
    if (i < 0) return;
    const a = b.dataset.a;
    if (a === 'left') movePage(i, i - 1);
    else if (a === 'right') movePage(i, i + 1);
    else if (a === 'rot') { e.add = norm(e.add + 90); queueThumb(e, S.token); }
    else if (a === 'del') deletePage(i);
  });

  // Drag & drop de réorganisation
  card.addEventListener('dragstart', (ev) => {
    if (!S) return;
    S.dragFrom = S.pages.indexOf(e);
    card.classList.add('is-dragging');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(S.dragFrom)); // requis par Firefox
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('is-dragging');
    if (S) { S.dragFrom = null; S.pages.forEach((p) => p.el.classList.remove('is-target')); }
  });
  card.addEventListener('dragover', (ev) => {
    if (!S || S.dragFrom === null || hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    card.classList.add('is-target');
  });
  card.addEventListener('dragleave', () => card.classList.remove('is-target'));
  card.addEventListener('drop', (ev) => {
    if (!S || S.dragFrom === null) return;
    ev.preventDefault();
    card.classList.remove('is-target');
    movePage(S.dragFrom, S.pages.indexOf(e));
    S.dragFrom = null;
  });
  return e;
}

/** Rendu (ou re-rendu après rotation) de la vignette, via file d'attente séquentielle. */
function queueThumb(e, token) {
  if (!S) return Promise.resolve();
  S.renderChain = S.renderChain.then(async () => {
    if (!S || token !== S.token || !S.pdfDoc) return;
    try {
      const page = await S.pdfDoc.getPage(e.orig + 1);
      e.base = page.rotate || 0;
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
    } catch (_) { /* rendu annulé / page illisible : on ignore */ }
  });
  return S.renderChain;
}

/* ───────────────────────── Grille & opérations ───────────────────────── */

/** Reconstruit la grille en réutilisant les éléments existants (pas de re-rendu des canvas). */
function renderGrid() {
  if (!S) return;
  const { box } = S.el;
  if (!S.pages.length) {
    box.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'po-empty';
    empty.textContent = S.file && S.original.length
      ? 'Toutes les pages ont été supprimées. Cliquez sur « Réinitialiser ».'
      : 'Aucune page à afficher';
    box.appendChild(empty);
    return;
  }
  let grid = box.querySelector('.po-grid');
  if (!grid) {
    box.innerHTML = '';
    grid = document.createElement('div');
    grid.className = 'po-grid';
    box.appendChild(grid);
  }
  // Retire les cartes supprimées
  Array.from(grid.children).forEach((c) => { if (!S.pages.some((p) => p.el === c)) c.remove(); });
  const n = S.pages.length;
  S.pages.forEach((p, i) => {
    grid.appendChild(p.el); // ré-ordonne
    p.num.textContent = `Page ${i + 1}` + (p.orig !== i ? ` (orig. ${p.orig + 1})` : '');
    p.el.querySelector('[data-a=left]').disabled = i === 0;
    p.el.querySelector('[data-a=right]').disabled = i === n - 1;
  });
}

function movePage(from, to) {
  if (!S || from === to || to < 0 || to >= S.pages.length || from < 0) return;
  const [m] = S.pages.splice(from, 1);
  S.pages.splice(to, 0, m);
  renderGrid();
}

function deletePage(i) {
  if (!S) return;
  const [rm] = S.pages.splice(i, 1);
  if (rm) rm.el.remove();
  renderGrid();
  updateMeta();
  setControls();
}

function rotateAll(delta) {
  if (!S) return;
  S.pages.forEach((p) => { p.add = norm(p.add + delta); queueThumb(p, S.token); });
}

function resetAll() {
  if (!S || !S.original.length) return;
  S.original.forEach((p) => { p.add = 0; queueThumb(p, S.token); });
  S.pages = S.original.slice();
  renderGrid();
  updateMeta();
  setControls();
  setStatus('Réinitialisé.');
}

/* ───────────────────────── Export (pdf-lib) ───────────────────────── */

async function exportPdf() {
  if (!S || S.busy || !S.bytes) return;
  if (S.pages.length < 1) { setStatus('Aucune page à exporter.', true); return; }
  const token = S.token;
  S.busy = true;
  setControls();
  clearDownloadUrl();
  setProgress(5);
  setStatus('Reconstruction du PDF…');

  try {
    const { PDFDocument, degrees } = await loadPdfLib();
    if (!S || token !== S.token) return;
    const src = await PDFDocument.load(S.bytes, { ignoreEncryption: true });
    setProgress(30);
    const out = await PDFDocument.create();
    const order = S.pages.map((p) => p.orig);
    const copied = await out.copyPages(src, order);
    setProgress(65);
    copied.forEach((pg, i) => {
      const add = S.pages[i].add;
      if (add) pg.setRotation(degrees(norm(pg.getRotation().angle + add)));
      out.addPage(pg);
    });
    const outBytes = await out.save();
    setProgress(90);

    const blob = new Blob([outBytes], { type: 'application/pdf' });
    S.dlUrl = URL.createObjectURL(blob);
    const base = S.file.name.replace(/\.pdf$/i, '');
    const a = document.createElement('a');
    a.href = S.dlUrl;
    a.download = `${base}_organise.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setProgress(100);
    setStatus(`Téléchargé : ${base}_organise.pdf (${fmtSize(blob.size)})`);
    // Libération mémoire après le déclenchement du téléchargement
    S.dlTimer = setTimeout(clearDownloadUrl, 10000);
  } catch (err) {
    setProgress(0);
    setStatus('Erreur export : ' + (err && err.message ? err.message : 'échec'), true);
  } finally {
    if (S && token === S.token) { S.busy = false; setControls(); }
  }
}

/* ───────────────────────── Vue (dépôt ↔ espace de travail) & retrait du fichier ───────────────────────── */

const DROP_HINT = 'ou cliquez pour parcourir';

/** hasFile=true → espace de travail visible, dropzone masquée ; false → l'inverse. */
function setView(hasFile) {
  if (!S) return;
  const { drop, meta, actions, box, foot, hint } = S.el;
  drop.style.display = hasFile ? 'none' : '';
  [meta, actions, box, foot].forEach((n) => { n.style.display = hasFile ? '' : 'none'; });
  if (hasFile) { hint.textContent = DROP_HINT; hint.style.color = ''; }
}

/** Message d'erreur affiché dans la dropzone (statut du pied masqué hors fichier). */
function showDropError(msg) {
  if (!S) return;
  S.el.hint.textContent = msg;
  S.el.hint.style.color = '#ef4444';
}

/** Retire le fichier : libère la mémoire, réinitialise l'état, réaffiche la dropzone. */
function removeFile() {
  if (!S) return;
  S.token++; // invalide chargements / rendus / exports en cours
  clearDownloadUrl();
  if (S.pdfDoc) { try { S.pdfDoc.destroy(); } catch (_) { /* noop */ } S.pdfDoc = null; }
  S.file = null;
  S.bytes = null;
  S.original = [];
  S.pages = [];       // rotations perdues avec les entrées
  S.dragFrom = null;
  S.busy = false;
  S.renderChain = Promise.resolve();
  renderGrid();
  updateMeta();
  setControls();
  setProgress(0);
  setStatus('');
  setView(false);
}
