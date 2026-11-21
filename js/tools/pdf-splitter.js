/**
 * pdf-splitter.js — Diviseur de PDF 100 % client.
 * Contrat : mount(container, ctx) / unmount().
 * Moteurs (CDN, chargés à la demande) : pdf-lib (extraction), pdf.js (vignettes), JSZip (export multi-fichiers).
 * Mise en page stabilisée : zone d'aperçu à dimensions fixes, cellules pré-dimensionnées,
 * sélection = simple bascule de classe CSS (aucune modification de taille).
 */

const LIBS = {
  pdflib: ['https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', 'PDFLib'],
  pdfjs: ['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', 'pdfjsLib'],
  jszip: ['https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', 'JSZip'],
};
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const THUMB_W = 120; // largeur CSS cible des vignettes (px)
const libCache = {};

let s = null; // état de l'instance montée

const q = (id) => s?.root.querySelector('#spl-' + id);
const refreshIcons = () => window.lucide?.createIcons();
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'document';
const tick = () => new Promise((r) => setTimeout(r));
const fmtSize = (b) =>
  b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(2)} Mo`;

/** Chargement paresseux d'une librairie CDN (cache + nouvelle tentative possible). */
function loadLib(key) {
  const [url, g] = LIBS[key];
  const ready = () => {
    if (key === 'pdfjs') window[g].GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return window[g];
  };
  if (window[g]) return Promise.resolve(ready());
  return (libCache[key] ??= new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => (window[g] ? res(ready()) : rej(new Error(`${g} indisponible.`)));
    el.onerror = () => { el.remove(); rej(new Error(`Chargement de ${g} impossible (réseau / CDN).`)); };
    document.head.appendChild(el);
  }).catch((e) => { delete libCache[key]; throw e; }));
}

/* ------------------------------ Plages ------------------------------ */

/** "1-3, 5, 8-10" → { set } ou { error }. Texte vide = sélection vide. */
function parseRanges(text, max) {
  const set = new Set();
  for (const part of text.split(/[,;]/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return { error: `Plage invalide : « ${part} »` };
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b > max) return { error: `Page hors limites (1-${max}) : « ${part} »` };
    if (a > b) return { error: `Plage inversée : « ${part} »` };
    for (let i = a; i <= b; i++) set.add(i);
  }
  return { set };
}

/** Set → "1-3, 5, 8-10". */
function formatRanges(set) {
  const a = [...set].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < a.length; ) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/* -------------------------------- UI -------------------------------- */

function setStatus(msg = '', isError = false) {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'spl-status' + (isError ? ' is-error' : '');
}

/** Téléchargement direct puis révocation de l'URL Blob. */
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

function paintSel() {
  s.cells.forEach((c, i) => {
    const on = s.sel.has(i + 1);
    c.classList.toggle('is-sel', on);
    c.setAttribute('aria-pressed', String(on));
  });
  syncUI();
}

function syncUI() {
  const hasFile = !!s.file;
  const all = s.mode === 'all';
  q('range').disabled = s.busy || !hasFile || all;
  ['sel-all', 'sel-none', 'sel-inv'].forEach((id) => (q(id).disabled = s.busy || !hasFile || all));
  q('reset').disabled = s.busy || !hasFile;
  q('run').disabled = s.busy || !hasFile || (!all && s.sel.size === 0);
  q('run').lastElementChild.textContent = all ? 'Séparer en ZIP' : 'Extraire les pages';
  q('grid').classList.toggle('is-all', all);
  q('count').textContent = !hasFile
    ? ''
    : all
      ? `${s.pages} fichier${s.pages > 1 ? 's' : ''} PDF (ZIP)`
      : `${s.sel.size} / ${s.pages} page${s.pages > 1 ? 's' : ''} sélectionnée${s.sel.size > 1 ? 's' : ''}`;
}

/* ---------------------------- Vignettes ----------------------------- */

async function renderPage(doc, n) {
  const page = await doc.getPage(n);
  try {
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (THUMB_W * Math.min(window.devicePixelRatio || 1, 2)) / base.width });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width);
    cv.height = Math.ceil(vp.height);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const url = cv.toDataURL('image/jpeg', 0.75);
    cv.width = cv.height = 0;
    return url;
  } finally {
    page.cleanup();
  }
}

/** File séquentielle : seules les pages visibles (IntersectionObserver) sont rendues. */
async function pump() {
  const me = s;
  if (!me || me.pumping || !me.pdfDoc) return;
  me.pumping = true;
  const gen = me.gen;
  try {
    while (s === me && me.gen === gen && me.queue.length) {
      const n = me.queue.shift();
      try {
        const url = await renderPage(me.pdfDoc, n);
        if (s !== me || me.gen !== gen) return;
        const img = me.cells[n - 1].querySelector('img');
        img.src = url;
        img.hidden = false;
      } catch { /* vignette indisponible : placeholder conservé */ }
    }
  } finally {
    me.pumping = false;
    if (s === me && me.queue.length) pump();
  }
}

function resetDoc() {
  s.gen++;
  s.queue = [];
  s.observer?.disconnect();
  s.observer = null;
  s.pdfDoc = null;
  s.pdfTask?.destroy?.();
  s.pdfTask = null;
  s.srcDoc = s.buf = s.file = null;
  s.pages = 0;
  s.cells = [];
  s.sel = new Set();
  s.last = 0;
  q('grid').innerHTML = '';
  q('range').value = '';
  q('range').classList.remove('is-invalid');
  q('empty').hidden = false;
  q('fname').textContent = 'Aucun fichier sélectionné';
  q('fmeta').textContent = '—';
}

function buildGrid() {
  const grid = q('grid');
  grid.innerHTML = Array.from({ length: s.pages }, (_, i) =>
    `<button type="button" class="spl-cell" data-p="${i + 1}" aria-pressed="false" aria-label="Page ${i + 1}">
       <span class="spl-page"><img alt="" hidden draggable="false"></span>
       <span class="spl-num">${i + 1}</span>
       <span class="spl-check"><i data-lucide="check"></i></span>
     </button>`
  ).join('');
  s.cells = [...grid.children];
  q('empty').hidden = true;
  s.observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        s.observer.unobserve(e.target);
        s.queue.push(Number(e.target.dataset.p));
      }
      pump();
    },
    { root: q('preview'), rootMargin: '240px' }
  );
  s.cells.forEach((c) => s.observer.observe(c));
  refreshIcons();
}

/* ------------------------------ Fichier ------------------------------ */

async function loadFile(file) {
  if (!file || s.busy) return;
  if (!isPdf(file)) return setStatus('Un fichier PDF est requis.', true);
  const me = s;
  s.busy = true;
  syncUI();
  try {
    setStatus('Chargement du moteur PDF…');
    const [{ PDFDocument }, pdfjs] = await Promise.all([loadLib('pdflib'), loadLib('pdfjs').catch(() => null)]);
    const buf = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(buf);
    if (s !== me) return;
    resetDoc();
    Object.assign(s, { file, buf, srcDoc, pages: srcDoc.getPageCount() });
    q('fname').textContent = file.name;
    q('fname').title = file.name;
    q('fmeta').textContent = `${fmtSize(file.size)} · ${s.pages} page${s.pages > 1 ? 's' : ''}`;
    buildGrid();
    syncUI();
    setStatus('');
    if (pdfjs) {
      const gen = s.gen;
      try {
        s.pdfTask = pdfjs.getDocument({ data: buf.slice(0) }); // copie : pdf.js détache le buffer
        const doc = await s.pdfTask.promise;
        if (s !== me || s.gen !== gen) return doc.destroy();
        s.pdfDoc = doc;
        pump();
      } catch {
        if (s === me) setStatus('Aperçu indisponible pour ce fichier (découpe toujours possible).', true);
      }
    } else {
      setStatus('Moteur d’aperçu indisponible (découpe toujours possible).', true);
    }
  } catch (e) {
    if (s === me) setStatus(`Lecture impossible (PDF chiffré ou corrompu) : ${e?.message || e}`, true);
  } finally {
    if (s === me) {
      s.busy = false;
      syncUI();
    }
  }
}

/* ------------------------------ Export ------------------------------- */

async function exportRange() {
  const { PDFDocument } = await loadLib('pdflib');
  const idx = [...s.sel].sort((a, b) => a - b).map((n) => n - 1);
  const out = await PDFDocument.create();
  (await out.copyPages(s.srcDoc, idx)).forEach((p) => out.addPage(p));
  const bytes = await out.save();
  if (!s) return;
  download(new Blob([bytes], { type: 'application/pdf' }), `${baseName(s.file.name)}_extrait.pdf`);
  setStatus(`Terminé : ${idx.length} page${idx.length > 1 ? 's' : ''} extraite${idx.length > 1 ? 's' : ''} (${fmtSize(bytes.byteLength)}).`);
}

async function exportAll() {
  const me = s;
  const [{ PDFDocument }, JSZip] = await Promise.all([loadLib('pdflib'), loadLib('jszip')]);
  const zip = new JSZip();
  const base = baseName(s.file.name);
  const w = String(s.pages).length;
  for (let i = 0; i < s.pages; i++) {
    setStatus(`Découpe ${i + 1}/${s.pages}…`);
    const out = await PDFDocument.create();
    (await out.copyPages(s.srcDoc, [i])).forEach((p) => out.addPage(p));
    zip.file(`${base}_page_${String(i + 1).padStart(w, '0')}.pdf`, await out.save());
    if (i % 5 === 4) await tick(); // laisse respirer l'UI
    if (s !== me) return;
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) =>
    setStatus(`Création de l’archive ZIP : ${Math.round(m.percent)} %`)
  );
  if (s !== me) return;
  download(blob, `${base}_pages.zip`);
  setStatus(`Terminé : ${s.pages} fichier${s.pages > 1 ? 's' : ''} PDF dans ${base}_pages.zip (${fmtSize(blob.size)}).`);
}

async function run() {
  if (!s.file || s.busy) return;
  const me = s;
  s.busy = true;
  syncUI();
  try {
    if (s.mode === 'all') await exportAll();
    else await exportRange();
  } catch (e) {
    if (s === me) setStatus('Échec : ' + (e?.message || e), true);
  } finally {
    if (s === me) {
      s.busy = false;
      syncUI();
    }
  }
}

/* ------------------------------ Contrat ------------------------------ */

export function mount(container, ctx) {
  if (s) unmount();
  s = {
    root: container, ctx, mode: 'range', busy: false, gen: 0, queue: [], cells: [], sel: new Set(), last: 0, pages: 0,
    file: null, buf: null, srcDoc: null, pdfDoc: null, pdfTask: null, observer: null, pumping: false,
    urls: new Set(), timers: new Set(),
  };
  container.innerHTML = `
    <div class="spl">
      <div class="spl-drop" id="spl-drop" tabindex="0" role="button" aria-label="Choisir un fichier PDF">
        <i data-lucide="upload-cloud"></i>
        <div><strong>Glissez-déposez un PDF ici</strong><small>ou cliquez pour parcourir · un seul fichier (remplace le fichier actuel)</small></div>
        <input id="spl-input" type="file" accept="application/pdf" hidden>
      </div>
      <div class="spl-info">
        <i data-lucide="file-text"></i>
        <div class="spl-infotxt"><div class="spl-fname" id="spl-fname">Aucun fichier sélectionné</div><div class="spl-fmeta" id="spl-fmeta">—</div></div>
      </div>
      <div class="spl-modes" role="radiogroup" aria-label="Mode de découpe">
        <label class="spl-mode"><input type="radio" name="spl-mode" value="range" checked> Plage personnalisée</label>
        <label class="spl-mode"><input type="radio" name="spl-mode" value="all"> Séparer toutes les pages</label>
      </div>
      <div class="spl-rangebar">
        <input type="text" id="spl-range" placeholder="ex. 1-3, 5, 8-10" aria-label="Plages de pages" autocomplete="off" spellcheck="false" disabled>
        <button type="button" class="spl-btn" id="spl-sel-all">Tout</button>
        <button type="button" class="spl-btn" id="spl-sel-none">Aucune</button>
        <button type="button" class="spl-btn" id="spl-sel-inv">Inverser</button>
        <span class="spl-count" id="spl-count"></span>
      </div>
      <div class="splitter-preview-box" id="spl-preview">
        <div class="spl-empty" id="spl-empty"><i data-lucide="scissors"></i><span>L’aperçu des pages apparaîtra ici</span></div>
        <div class="spl-grid" id="spl-grid"></div>
      </div>
      <div class="spl-bar">
        <button type="button" class="spl-btn" id="spl-reset"><i data-lucide="x"></i><span>Retirer le fichier</span></button>
        <button type="button" class="spl-btn is-primary" id="spl-run"><i data-lucide="scissors"></i><span>Extraire les pages</span></button>
      </div>
      <div class="spl-status" id="spl-status" role="status" aria-live="polite"></div>
    </div>`;

  const drop = q('drop');
  const input = q('input');
  drop.addEventListener('click', () => !s.busy && input.click());
  drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !s.busy) { e.preventDefault(); input.click(); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    const f = input.files[0];
    input.value = '';
    loadFile(f);
  });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', (e) => loadFile([...(e.dataTransfer?.files ?? [])].find(isPdf) ?? e.dataTransfer?.files?.[0]));

  // Mode de découpe
  container.querySelectorAll('input[name="spl-mode"]').forEach((r) =>
    r.addEventListener('change', () => { s.mode = r.value; syncUI(); setStatus(''); })
  );

  // Vignette → sélection (Maj+clic = plage) → champ texte
  q('grid').addEventListener('click', (e) => {
    const c = e.target.closest('.spl-cell');
    if (!c || s.mode === 'all' || s.busy) return;
    const n = Number(c.dataset.p);
    if (e.shiftKey && s.last) {
      const [a, b] = [Math.min(s.last, n), Math.max(s.last, n)];
      const on = !s.sel.has(n);
      for (let i = a; i <= b; i++) on ? s.sel.add(i) : s.sel.delete(i);
    } else {
      s.sel.has(n) ? s.sel.delete(n) : s.sel.add(n);
    }
    s.last = n;
    q('range').value = formatRanges(s.sel);
    q('range').classList.remove('is-invalid');
    setStatus('');
    paintSel();
  });

  // Champ texte → vignettes
  q('range').addEventListener('input', () => {
    const r = parseRanges(q('range').value, s.pages);
    if (r.error) {
      q('range').classList.add('is-invalid');
      setStatus(r.error, true);
      return;
    }
    q('range').classList.remove('is-invalid');
    setStatus('');
    s.sel = r.set;
    paintSel();
  });

  const setSel = (set) => {
    s.sel = set;
    q('range').value = formatRanges(set);
    q('range').classList.remove('is-invalid');
    setStatus('');
    paintSel();
  };
  q('sel-all').addEventListener('click', () => setSel(new Set(Array.from({ length: s.pages }, (_, i) => i + 1))));
  q('sel-none').addEventListener('click', () => setSel(new Set()));
  q('sel-inv').addEventListener('click', () =>
    setSel(new Set(Array.from({ length: s.pages }, (_, i) => i + 1).filter((n) => !s.sel.has(n))))
  );

  q('reset').addEventListener('click', () => {
    if (s.busy) return;
    resetDoc();
    setStatus('');
    syncUI();
  });
  q('run').addEventListener('click', run);

  syncUI();
  refreshIcons();
}

export function unmount() {
  if (!s) return;
  s.gen++;
  s.observer?.disconnect();
  s.pdfTask?.destroy?.();
  s.timers.forEach(clearTimeout);
  s.urls.forEach((u) => URL.revokeObjectURL(u)); // libération mémoire Blob
  s.root.innerHTML = '';
  s = null;
}
