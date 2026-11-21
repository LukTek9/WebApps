/**
 * pdf-merger.js — Fusionneur de PDF 100 % client.
 * Contrat : mount(container, ctx) / unmount().
 * Moteur : pdf-lib (CDN, chargé à la demande). Aucun envoi réseau des fichiers.
 */

const PDFLIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const THUMB_W = 170; // largeur CSS des vignettes (px)
const OUT_NAME = 'fusion_documents.pdf';

let s = null; // état de l'instance montée
let libPromise = null; // cache du chargement paresseux

const q = (id) => s?.root.querySelector('#pdfm-' + id);
const refreshIcons = () => window.lucide?.createIcons();
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (b) =>
  b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(2)} Mo`;
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

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

/** Chargement paresseux de pdf.js (rendu des vignettes uniquement). */
let jsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (jsPromise) return jsPromise;
  jsPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = PDFJS_URL;
    el.async = true;
    el.onload = () => {
      if (!window.pdfjsLib) return reject(new Error('pdf.js indisponible.'));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      resolve(window.pdfjsLib);
    };
    el.onerror = () => { el.remove(); reject(new Error('Chargement de pdf.js impossible.')); };
    document.head.appendChild(el);
  }).catch((e) => { jsPromise = null; throw e; });
  return jsPromise;
}

/** Rend la 1re page en JPEG (data URL). Copie du buffer : pdf.js transfère/détache l'ArrayBuffer. */
async function renderCover(it) {
  const lib = await loadPdfJs();
  const task = lib.getDocument({ data: it.buf.slice(0) });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (THUMB_W * Math.min(window.devicePixelRatio || 1, 2)) / base.width });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width);
    cv.height = Math.ceil(vp.height);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const url = cv.toDataURL('image/jpeg', 0.8);
    cv.width = cv.height = 0; // libère le buffer canvas
    return url;
  } finally {
    task.destroy();
  }
}

/** File séquentielle : génère les vignettes manquantes sans bloquer l'UI. */
async function makeThumbs() {
  const me = s;
  if (!me || me.thumbing) return;
  me.thumbing = true;
  try {
    for (let it; s === me && (it = me.items.find((x) => x.thumb === undefined)); ) {
      it.thumb = null; // en cours (placeholder affiché)
      try { it.thumb = await renderCover(it); } catch { it.thumb = null; }
      if (s !== me) return;
      const box = me.root.querySelector(`.pdfm-card[data-id="${it.id}"] .pdfm-thumb`);
      if (box && it.thumb) box.innerHTML = `<img src="${it.thumb}" alt="" draggable="false"><span class="pdfm-idx">${box.dataset.idx}</span>`;
    }
  } finally {
    me.thumbing = false;
  }
}

/** Réordonnancement par glisser-déposer : le DOM est réordonné en direct, l'état synchronisé au relâchement. */
function bindDrag() {
  const list = q('list');
  let dragEl = null;
  const renumber = () =>
    [...list.children].forEach((li, i) => {
      const idx = li.querySelector('.pdfm-idx');
      if (idx) idx.textContent = i + 1;
      const th = li.querySelector('.pdfm-thumb');
      if (th) th.dataset.idx = i + 1;
    });
  list.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('.pdfm-card');
    if (!c || s.busy) return e.preventDefault();
    dragEl = c;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', c.dataset.id);
    requestAnimationFrame(() => c.classList.add('is-drag'));
  });
  list.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const over = e.target.closest('.pdfm-card');
    if (!over || over === dragEl) return;
    const r = over.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    list.insertBefore(dragEl, after ? over.nextSibling : over);
    renumber();
  });
  list.addEventListener('drop', (e) => { if (dragEl) e.preventDefault(); });
  list.addEventListener('dragend', () => {
    if (!dragEl) return;
    dragEl.classList.remove('is-drag');
    dragEl = null;
    const byId = new Map(s.items.map((it) => [it.id, it]));
    s.items = [...list.children].map((li) => byId.get(Number(li.dataset.id))).filter(Boolean);
    render();
  });
}

function setStatus(msg = '', isError = false) {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pdfm-status' + (isError ? ' is-error' : '');
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

function syncButtons() {
  const n = s.items.length;
  q('clear').disabled = s.busy || n === 0;
  q('merge').disabled = s.busy || n < 2;
  const pages = s.items.reduce((a, it) => a + it.pages, 0);
  q('summary').textContent = n ? `${n} fichier${n > 1 ? 's' : ''} · ${pages} page${pages > 1 ? 's' : ''} au total` : '';
}

function render() {
  const list = q('list');
  const last = s.items.length - 1;
  list.innerHTML = s.items
    .map(
      (it, i) => `
    <li class="pdfm-card" data-id="${it.id}" draggable="${!s.busy}">
      <div class="pdfm-thumb" data-idx="${i + 1}" title="Glisser pour réordonner">
        ${it.thumb ? `<img src="${it.thumb}" alt="Couverture de ${esc(it.name)}" draggable="false">` : '<i data-lucide="file-text" class="pdfm-fileicon"></i>'}
        <span class="pdfm-idx">${i + 1}</span>
      </div>
      <div class="pdfm-info">
        <div class="pdfm-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="pdfm-meta">${fmtSize(it.size)} · ${it.pages} page${it.pages > 1 ? 's' : ''}</div>
      </div>
      <div class="pdfm-actions">
        <button type="button" data-act="up" aria-label="Avancer" ${i === 0 || s.busy ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
        <button type="button" data-act="down" aria-label="Reculer" ${i === last || s.busy ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
        <button type="button" data-act="del" class="is-danger" aria-label="Supprimer" ${s.busy ? 'disabled' : ''}><i data-lucide="trash-2"></i></button>
      </div>
    </li>`
    )
    .join('');
  syncButtons();
  refreshIcons();
}

/** Ajoute des fichiers : lecture ArrayBuffer + comptage des pages. */
async function addFiles(fileList) {
  const files = [...fileList].filter(isPdf);
  const rejected = fileList.length - files.length;
  if (!files.length) return setStatus('Aucun fichier PDF valide.', true);
  s.busy = true;
  syncButtons();
  const errors = [];
  try {
    setStatus('Chargement du moteur PDF…');
    const { PDFDocument } = await loadPdfLib();
    for (const [i, file] of files.entries()) {
      if (!s) return; // démonté entre-temps
      setStatus(`Lecture ${i + 1}/${files.length} : ${file.name}`);
      try {
        const buf = await file.arrayBuffer();
        const doc = await PDFDocument.load(buf);
        s.items.push({ id: ++s.seq, name: file.name, size: file.size, pages: doc.getPageCount(), buf });
      } catch (e) {
        errors.push(file.name);
      }
    }
  } catch (e) {
    if (s) setStatus(e.message, true);
    if (s) {
      s.busy = false;
      render();
    }
    return;
  }
  if (!s) return;
  s.busy = false;
  render();
  makeThumbs();
  const problems = errors.length + rejected;
  setStatus(
    problems
      ? `${problems} fichier(s) ignoré(s) (non PDF, chiffré ou corrompu)${errors.length ? ' : ' + errors.join(', ') : ''}.`
      : `${files.length} fichier(s) ajouté(s).`,
    problems > 0
  );
}

function move(id, dir) {
  const i = s.items.findIndex((it) => it.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.items.length) return;
  [s.items[i], s.items[j]] = [s.items[j], s.items[i]];
  render();
}

function clearAll() {
  s.items = []; // libère les ArrayBuffer
  render();
  setStatus('');
}

/** Fusion : copyPages dans l'ordre de la liste → save() → Blob → téléchargement. */
async function merge() {
  if (s.items.length < 2 || s.busy) return;
  s.busy = true;
  render();
  try {
    setStatus('Chargement du moteur PDF…');
    const { PDFDocument } = await loadPdfLib();
    const out = await PDFDocument.create();
    for (const [i, it] of s.items.entries()) {
      setStatus(`Fusion ${i + 1}/${s.items.length} : ${it.name}`);
      const src = await PDFDocument.load(it.buf);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    setStatus('Génération du fichier…');
    const bytes = await out.save();
    if (!s) return;
    download(new Blob([bytes], { type: 'application/pdf' }), OUT_NAME);
    setStatus(`Terminé : ${OUT_NAME} (${fmtSize(bytes.byteLength)}).`);
  } catch (e) {
    if (s) setStatus('Échec de la fusion : ' + (e?.message || e), true);
  } finally {
    if (s) {
      s.busy = false;
      render();
    }
  }
}

const STYLE = `
.pdfm{display:flex;flex-direction:column;gap:16px;max-width:960px;margin:0 auto;width:100%}
.pdfm-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:40px 20px;text-align:center;cursor:pointer;
  border:2px dashed var(--border, var(--color-border, #cbd5e1));border-radius:var(--radius, 14px);background:var(--surface, var(--color-surface, #fff));transition:.2s}
.pdfm-drop:hover,.pdfm-drop.is-over{border-color:var(--cat-pdf,#ef4444);background:color-mix(in srgb,var(--cat-pdf,#ef4444) 6%,transparent)}
.pdfm-drop i,.pdfm-drop svg{width:40px;height:40px;color:var(--cat-pdf,#ef4444)}
.pdfm-drop strong{font-size:1.05rem}
.pdfm-drop small{opacity:.65}
.pdfm-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.pdfm-card{display:flex;flex-direction:column;gap:8px;padding:10px;cursor:grab;transition:.15s;border:1px solid var(--border, var(--color-border, #e2e8f0));
  border-radius:var(--radius, 12px);background:var(--surface, var(--color-surface, #fff))}
.pdfm-idx{position:absolute;top:6px;left:6px;box-shadow:0 1px 3px rgba(0,0,0,.3);min-width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:.75rem;font-weight:600;color:#fff;background:var(--cat-pdf,#ef4444)}
.pdfm-fileicon,.pdfm-card svg.pdfm-fileicon{width:40px;height:40px;color:var(--cat-pdf,#ef4444);opacity:.6}
.pdfm-thumb{position:relative;aspect-ratio:3/4;display:grid;place-items:center;overflow:hidden;border-radius:8px;border:1px solid var(--border, var(--color-border, #e2e8f0));background:color-mix(in srgb,currentColor 6%,transparent)}
.pdfm-thumb img{width:100%;height:100%;object-fit:contain;background:#fff;pointer-events:none}
.pdfm-card.is-drag{opacity:.45;transform:scale(.97)}
.pdfm-card:active{cursor:grabbing}
.pdfm-info{text-align:center}
.pdfm-actions{justify-content:center}
.pdfm-info{flex:1;min-width:0}
.pdfm-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfm-meta{font-size:.8rem;opacity:.65}
.pdfm-actions{display:flex;gap:4px}
.pdfm-actions button{width:32px;height:32px;display:grid;place-items:center;border:1px solid var(--border, var(--color-border, #e2e8f0));
  border-radius:8px;background:transparent;color:inherit;cursor:pointer;transition:.15s}
.pdfm-actions button:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}
.pdfm-actions button.is-danger:hover:not(:disabled){color:#ef4444;border-color:#ef4444}
.pdfm-actions button:disabled{opacity:.35;cursor:not-allowed}
.pdfm-actions svg{width:16px;height:16px}
.pdfm-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.pdfm-summary{flex:1;font-size:.85rem;opacity:.7}
.pdfm-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:var(--radius, 10px);border:1px solid var(--border, var(--color-border, #cbd5e1));
  background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;transition:.15s}
.pdfm-btn svg{width:16px;height:16px}
.pdfm-btn.is-primary{background:var(--cat-pdf,#ef4444);border-color:var(--cat-pdf,#ef4444);color:#fff}
.pdfm-btn:hover:not(:disabled){filter:brightness(.95)}
.pdfm-btn:disabled{opacity:.45;cursor:not-allowed}
.pdfm-status{min-height:1.2em;font-size:.9rem;opacity:.8}
.pdfm-status.is-error{color:#ef4444;opacity:1}
`;

export function mount(container, ctx) {
  s = { root: container, ctx, items: [], seq: 0, busy: false, urls: new Set(), timers: new Set() };
  container.innerHTML = `
    <style>${STYLE}</style>
    <div class="pdfm">
      <div class="pdfm-drop" id="pdfm-drop" tabindex="0" role="button" aria-label="Ajouter des fichiers PDF">
        <i data-lucide="upload-cloud"></i>
        <strong>Glissez-déposez vos PDF ici</strong>
        <small>ou cliquez pour parcourir · plusieurs fichiers possibles</small>
        <input id="pdfm-input" type="file" accept="application/pdf" multiple hidden />
      </div>
      <ul class="pdfm-list" id="pdfm-list"></ul>
      <div class="pdfm-bar">
        <span class="pdfm-summary" id="pdfm-summary"></span>
        <button type="button" class="pdfm-btn" id="pdfm-clear"><i data-lucide="trash-2"></i>Tout vider</button>
        <button type="button" class="pdfm-btn is-primary" id="pdfm-merge"><i data-lucide="files"></i>Fusionner les PDF</button>
      </div>
      <div class="pdfm-status" id="pdfm-status" role="status" aria-live="polite"></div>
    </div>`;

  const drop = q('drop');
  const input = q('input');

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
    input.value = ''; // permet de rajouter le même fichier
    if (files.length && !s.busy) addFiles(files);
  });
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
  drop.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length && !s.busy) addFiles(files);
  });

  q('list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    const card = e.target.closest('.pdfm-card');
    if (!btn || !card || s.busy) return;
    const id = Number(card.dataset.id);
    if (btn.dataset.act === 'up') move(id, -1);
    else if (btn.dataset.act === 'down') move(id, 1);
    else if (btn.dataset.act === 'del') {
      s.items = s.items.filter((it) => it.id !== id);
      render();
    }
  });
  q('clear').addEventListener('click', clearAll);
  bindDrag();
  q('merge').addEventListener('click', merge);

  render();
}

export function unmount() {
  if (!s) return;
  s.timers.forEach(clearTimeout);
  s.urls.forEach((u) => URL.revokeObjectURL(u)); // libération mémoire Blob
  s.root.innerHTML = '';
  s = null;
}
