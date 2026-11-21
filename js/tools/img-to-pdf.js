/**
 * img-to-pdf.js — Outil « Images vers PDF » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 * Moteur : pdf-lib (chargé à la demande depuis CDN, avec fallback).
 */

const PDF_LIB_SOURCES = [
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
];

/** Dimensions de page en points PDF (portrait). */
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
/** Marges en points. */
const MARGINS = { none: 0, small: 20, large: 50 };

/** État du module (réinitialisé au mount/unmount). */
let state = null;

/** Charge pdf-lib paresseusement (script classique → window.PDFLib), avec fallback de sources. */
function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (state && state.pdfLibPromise) return state.pdfLibPromise;
  const p = (async () => {
    for (const src of PDF_LIB_SOURCES) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = resolve;
          s.onerror = () => { s.remove(); reject(new Error('load')); };
          document.head.appendChild(s);
        });
        if (window.PDFLib) return window.PDFLib;
      } catch (_) { /* source suivante */ }
    }
    throw new Error('Impossible de charger pdf-lib (réseau).');
  })();
  if (state) state.pdfLibPromise = p;
  return p;
}

const fmtSize = (b) => {
  if (b < 1024) return `${b} o`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} Ko`;
  return `${(b / 1048576).toFixed(2)} Mo`;
};
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const refreshIcons = (root) => { try { window.lucide?.createIcons({ root }); } catch (_) { /* icônes optionnelles */ } };

/** Lit les dimensions d'une image via un <img> temporaire. */
function readDims(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => reject(new Error('Image illisible'));
    im.src = url;
  });
}

/** Rend une image (WebP/BMP/autre) en PNG via Canvas → Uint8Array. */
async function toPngBytes(url, w, h) {
  const im = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Image illisible'));
    i.src = url;
  });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(im, 0, 0, w, h);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  c.width = c.height = 0; // libère le canvas
  if (!blob) throw new Error('Rendu canvas échoué');
  return new Uint8Array(await blob.arrayBuffer());
}

export function mount(container, ctx) {
  state = { items: [], busy: false, dragFrom: null, uid: 0, container, root: null, pdfLibPromise: null, mounted: true, onChange: null };

  container.innerHTML = `
    <div class="img2pdf">
      <div class="img2pdf-drop" data-role="drop">
        <i data-lucide="file-up"></i>
        <p><strong>Glissez vos images ici</strong> ou cliquez pour parcourir</p>
        <p class="img2pdf-hint">PNG, JPG, WebP — plusieurs fichiers</p>
        <input type="file" accept="image/*" multiple hidden data-role="input">
      </div>
      <div class="img2pdf-head">
        <span class="img2pdf-meta" data-role="meta">0 image · 0 o</span>
        <button type="button" class="btn-remove-file" data-role="clear"><i data-lucide="trash-2"></i> Tout effacer</button>
      </div>
      <div class="img2pdf-preview-box" data-role="preview"></div>
      <div class="img2pdf-options">
        <label>Orientation
          <select data-role="orientation">
            <option value="auto">Auto</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Paysage</option>
          </select>
        </label>
        <label>Format de page
          <select data-role="size">
            <option value="fit">Fit (taille de l'image)</option>
            <option value="a4">A4</option>
            <option value="letter">Lettre</option>
          </select>
        </label>
        <label>Marges
          <select data-role="margin">
            <option value="none">Aucune</option>
            <option value="small">Petite</option>
            <option value="large">Grande</option>
          </select>
        </label>
      </div>
      <div class="img2pdf-error" data-role="error"></div>
      <button type="button" class="btn-primary img2pdf-convert" data-role="convert" disabled>
        <i data-lucide="download"></i><span>Convertir et télécharger le PDF</span>
      </button>
    </div>`;

  const $ = (r) => container.querySelector(`[data-role="${r}"]`);
  const drop = $('drop'), input = $('input'), meta = $('meta'), clearBtn = $('clear');
  const preview = $('preview'), errBox = $('error'), convertBtn = $('convert');
  state.root = container.firstElementChild;

  const setError = (m = '') => { errBox.textContent = m; };

  const render = () => {
    const n = state.items.length;
    const total = state.items.reduce((a, i) => a + i.size, 0);
    meta.textContent = `${n} image${n > 1 ? 's' : ''} · ${fmtSize(total)}`;
    clearBtn.disabled = !n || state.busy;
    convertBtn.disabled = !n || state.busy;
    if (!n) {
      preview.innerHTML = '<div class="img2pdf-empty">Aucune image chargée</div>';
      return;
    }
    preview.innerHTML = `<div class="img2pdf-grid">${state.items.map((it, i) => `
      <div class="img2pdf-card" draggable="true" data-id="${it.id}" data-i="${i}">
        <span class="img2pdf-idx">${i + 1}</span>
        <img class="img2pdf-thumb" src="${it.url}" alt="">
        <div class="img2pdf-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="img2pdf-actions">
          <button type="button" data-act="left" ${i === 0 ? 'disabled' : ''} title="Avancer">◀</button>
          <button type="button" data-act="del" class="img2pdf-del" title="Supprimer">✕</button>
          <button type="button" data-act="right" ${i === n - 1 ? 'disabled' : ''} title="Reculer">▶</button>
        </div>
      </div>`).join('')}</div>`;
  };

  const move = (from, to) => {
    if (to < 0 || to >= state.items.length || from === to) return;
    const [it] = state.items.splice(from, 1);
    state.items.splice(to, 0, it);
    render();
  };

  const addFiles = async (files) => {
    setError();
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    if (imgs.length < files.length) setError('Fichiers non-image ignorés.');
    for (const f of imgs) {
      const url = URL.createObjectURL(f);
      try {
        const { w, h } = await readDims(url);
        if (!state || !state.mounted) { URL.revokeObjectURL(url); return; }
        state.items.push({ id: ++state.uid, file: f, url, name: f.name, size: f.size, type: f.type, w, h });
      } catch (_) {
        URL.revokeObjectURL(url);
        setError(`« ${f.name} » illisible : ignoré.`);
      }
    }
    render();
  };

  const clearAll = () => {
    state.items.forEach((i) => URL.revokeObjectURL(i.url));
    state.items = [];
    setError();
    render();
  };

  // --- Zone de dépôt
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  clearBtn.addEventListener('click', clearAll);

  // --- Vignettes : boutons + drag-and-drop (délégation)
  preview.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = Number(btn.closest('.img2pdf-card').dataset.i);
    if (btn.dataset.act === 'left') move(i, i - 1);
    else if (btn.dataset.act === 'right') move(i, i + 1);
    else if (btn.dataset.act === 'del') {
      URL.revokeObjectURL(state.items[i].url);
      state.items.splice(i, 1);
      render();
    }
  });
  preview.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.img2pdf-card');
    if (!card) return;
    state.dragFrom = Number(card.dataset.i);
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(state.dragFrom));
  });
  preview.addEventListener('dragover', (e) => {
    if (state.dragFrom === null) return;
    e.preventDefault();
    preview.querySelectorAll('.is-target').forEach((c) => c.classList.remove('is-target'));
    e.target.closest('.img2pdf-card')?.classList.add('is-target');
  });
  preview.addEventListener('drop', (e) => {
    if (state.dragFrom === null) return;
    e.preventDefault();
    const card = e.target.closest('.img2pdf-card');
    if (card) move(state.dragFrom, Number(card.dataset.i));
    state.dragFrom = null;
  });
  preview.addEventListener('dragend', () => {
    state.dragFrom = null;
    preview.querySelectorAll('.is-dragging, .is-target').forEach((c) => c.classList.remove('is-dragging', 'is-target'));
  });

  // --- Conversion
  convertBtn.addEventListener('click', async () => {
    if (state.busy || !state.items.length) return;
    state.busy = true;
    setError();
    convertBtn.disabled = true;
    clearBtn.disabled = true;
    const label = convertBtn.querySelector('span');
    const original = label.textContent;
    try {
      label.textContent = 'Chargement du moteur PDF…';
      const { PDFDocument } = await loadPdfLib();
      const orientation = $('orientation').value;
      const sizeOpt = $('size').value;
      const m = MARGINS[$('margin').value];
      const pdf = await PDFDocument.create();
      const items = state.items.slice();

      for (let i = 0; i < items.length; i++) {
        label.textContent = `Conversion ${i + 1}/${items.length}…`;
        const it = items[i];
        const isJpg = it.type === 'image/jpeg' || it.type === 'image/jpg';
        const isPng = it.type === 'image/png';
        let img;
        if (isJpg) img = await pdf.embedJpg(new Uint8Array(await it.file.arrayBuffer()));
        else if (isPng) img = await pdf.embedPng(new Uint8Array(await it.file.arrayBuffer()));
        else img = await pdf.embedPng(await toPngBytes(it.url, it.w, it.h)); // WebP/BMP/etc.

        // Dimensions de page
        let pw, ph;
        if (sizeOpt === 'fit') {
          pw = it.w + 2 * m;
          ph = it.h + 2 * m;
          if (orientation === 'portrait' && pw > ph) [pw, ph] = [ph, pw];
          if (orientation === 'landscape' && ph > pw) [pw, ph] = [ph, pw];
        } else {
          [pw, ph] = PAGE_SIZES[sizeOpt];
          const landscape = orientation === 'auto' ? it.w > it.h : orientation === 'landscape';
          if (landscape) [pw, ph] = [ph, pw];
        }

        // Image centrée, proportions conservées, dans la zone utile
        const aw = Math.max(pw - 2 * m, 1), ah = Math.max(ph - 2 * m, 1);
        const scale = Math.min(aw / img.width, ah / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        const page = pdf.addPage([pw, ph]);
        page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      }

      label.textContent = 'Génération du PDF…';
      const bytes = await pdf.save();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'images_combines.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); // libération mémoire post-téléchargement
      ctx?.toast?.('PDF généré.');
    } catch (err) {
      setError(`Erreur : ${err.message || err}`);
    } finally {
      label.textContent = original;
      state.busy = false;
      render();
    }
  });

  render();
  refreshIcons(container);
}

export function unmount() {
  if (!state) return;
  state.mounted = false;
  state.items.forEach((i) => URL.revokeObjectURL(i.url));
  state.items = [];
  if (state.container) state.container.innerHTML = '';
  state = null;
}
