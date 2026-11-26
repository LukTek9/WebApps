/**
 * word-to-pdf.js — Outil « Word vers PDF » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 * Moteur : docx-preview (+ JSZip) rend le .docx en HTML paginé hors écran,
 * html2canvas capture chaque page, jsPDF assemble le PDF (pages = format Word).
 * Libs chargées à la demande depuis CDN, avec fallback de sources.
 */
import { bindDropzone, createDropzone, createSecurityUI, showError } from '../shared/security-tool-ui.js';

const LIBS = {
  jszip: { global: () => window.JSZip, sources: [
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
  ] },
  docx: { global: () => window.docx?.renderAsync && window.docx, sources: [
    'https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/dist/docx-preview.min.js',
    'https://unpkg.com/docx-preview@0.3.6/dist/docx-preview.min.js',
  ] },
  html2canvas: { global: () => window.html2canvas, sources: [
    'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
    'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
  ] },
  jspdf: { global: () => window.jspdf?.jsPDF, sources: [
    'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
    'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js',
  ] },
};
/** Promesses de chargement partagées entre montages (les scripts restent en cache global). */
const libPromises = {};

/** Échelle de rendu html2canvas (netteté vs poids). */
const QUALITY = { standard: 1.5, high: 2, max: 3 };
/** Couleur de fond des pages PDF (papier), indépendante du thème de l'interface. */
const PAPER = '#ffffff';
const PX_TO_PT = 0.75;
const THUMB_WIDTH = 140;

let state = null;

function loadLib(key) {
  const lib = LIBS[key];
  if (lib.global()) return Promise.resolve(lib.global());
  if (libPromises[key]) return libPromises[key];
  libPromises[key] = (async () => {
    for (const src of lib.sources) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = resolve;
          s.onerror = () => { s.remove(); reject(new Error('load')); };
          document.head.appendChild(s);
        });
        if (lib.global()) return lib.global();
      } catch (_) { /* source suivante */ }
    }
    delete libPromises[key];
    throw new Error(`Impossible de charger ${key} (réseau).`);
  })();
  return libPromises[key];
}

const fmtSize = (b) => {
  if (b < 1024) return `${b} o`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} Ko`;
  return `${(b / 1048576).toFixed(2)} Mo`;
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * Pagination DOM : docx-preview ne coupe qu'aux sauts explicites/mémorisés par Word.
 * Une section qui dépasse sa hauteur de page est scindée en sections clones (en-tête/pied
 * dupliqués), en déplaçant les blocs (paragraphes, tableaux…) de fin d'<article> vers la suivante.
 */
function paginateSection(sec) {
  const limit = parseFloat(getComputedStyle(sec).minHeight);
  if (!limit) return;
  let cur = sec;
  while (cur.offsetHeight > limit + 1) {
    const art = cur.querySelector(':scope > article');
    if (!art || art.children.length < 2) return; // bloc unique trop haut : repli découpe canvas
    const next = cur.cloneNode(false);
    let nextArt = null;
    for (const child of cur.children) {
      if (child === art) { nextArt = art.cloneNode(false); next.appendChild(nextArt); }
      else next.appendChild(child.cloneNode(true));
    }
    cur.after(next);
    while (cur.offsetHeight > limit + 1 && art.children.length > 1) nextArt.prepend(art.lastElementChild);
    cur = next;
  }
}

/** Découpe un canvas de page trop haut en plusieurs pages de hauteur `pageH` (px canvas). */
function sliceCanvas(canvas, pageH) {
  if (canvas.height <= pageH * 1.02) return [canvas];
  const out = [];
  for (let y = 0; y < canvas.height - pageH * 0.02; y += pageH) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = pageH;
    const g = c.getContext('2d');
    g.fillStyle = PAPER;
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(canvas, 0, y, canvas.width, Math.min(pageH, canvas.height - y), 0, 0, canvas.width, Math.min(pageH, canvas.height - y));
    out.push(c);
  }
  return out;
}

function makeThumb(canvas) {
  const t = document.createElement('canvas');
  t.width = THUMB_WIDTH;
  t.height = Math.round(canvas.height * (THUMB_WIDTH / canvas.width));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  const url = t.toDataURL('image/jpeg', 0.8);
  t.width = t.height = 0;
  return url;
}

export function mount(container, ctx) {
  const ui = createSecurityUI(container, {
    content: `
      <div class="doc2pdf">
        ${createDropzone({ id: 'docx', title: 'Glissez-déposez un document Word ici', hint: 'ou cliquez pour parcourir · fichier .docx', accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Importer un document Word' })}
        <div class="doc2pdf-file" data-role="file" hidden>
          <i data-lucide="file-text"></i>
          <div class="doc2pdf-file-info">
            <span class="doc2pdf-file-name" data-role="name"></span>
            <span class="doc2pdf-file-sub" data-role="sub"></span>
          </div>
          <button type="button" class="btn-remove-file" data-role="clear"><i data-lucide="trash-2"></i> Retirer</button>
        </div>
        <div class="doc2pdf-options">
          <label class="tool-field">Qualité de rendu
            <select data-role="quality">
              <option value="standard">Standard (léger)</option>
              <option value="high" selected>Haute</option>
              <option value="max">Maximale (lourd)</option>
            </select>
          </label>
          <label class="tool-field">Compression des pages
            <select data-role="format">
              <option value="jpeg">JPEG (fichier léger)</option>
              <option value="png">PNG (sans perte)</option>
            </select>
          </label>
          <label class="tool-field">En-têtes & pieds de page
            <select data-role="headers">
              <option value="1">Inclure</option>
              <option value="0">Ignorer</option>
            </select>
          </label>
        </div>
        <button type="button" class="btn-primary doc2pdf-convert" data-role="convert" disabled>
          <i data-lucide="download"></i><span>Convertir et télécharger le PDF</span>
        </button>
        <div class="doc2pdf-preview" data-role="preview">
          <div class="doc2pdf-empty">L'aperçu des pages apparaîtra après conversion</div>
        </div>
        <p class="doc2pdf-note status-muted">Les pages sont rendues en images : mise en page fidèle, mais texte non sélectionnable. Format .doc (Word 97-2003) non pris en charge : enregistrez-le d'abord en .docx.</p>
      </div>`,
  });

  state = { ui, file: null, busy: false, stage: null, mounted: true };
  const $ = (r) => ui.query(`[data-role="${r}"]`);
  const fileBox = $('file'), convertBtn = $('convert'), clearBtn = $('clear'), preview = $('preview');

  const render = () => {
    const has = Boolean(state.file);
    fileBox.hidden = !has;
    if (has) {
      $('name').textContent = state.file.name;
      $('sub').textContent = fmtSize(state.file.size);
    }
    convertBtn.disabled = !has || state.busy;
    clearBtn.disabled = state.busy;
    dz.setDisabled(state.busy);
  };

  const resetPreview = () => {
    preview.innerHTML = '<div class="doc2pdf-empty">L\'aperçu des pages apparaîtra après conversion</div>';
  };

  const dz = bindDropzone(ui, {
    id: 'docx',
    multiple: false,
    onFiles: ([file]) => {
      state.file = file;
      ui.setStatus('');
      resetPreview();
      render();
    },
  });

  clearBtn.addEventListener('click', () => {
    state.file = null;
    ui.setStatus('');
    resetPreview();
    render();
  }, { signal: ui.signal });

  const removeStage = () => {
    state?.stage?.remove();
    if (state) state.stage = null;
  };

  convertBtn.addEventListener('click', async () => {
    if (state.busy || !state.file) return;
    state.busy = true;
    render();
    const label = convertBtn.querySelector('span');
    const original = label.textContent;
    const scale = QUALITY[$('quality').value];
    const usePng = $('format').value === 'png';
    const withHeaders = $('headers').value === '1';
    const file = state.file;
    try {
      label.textContent = 'Chargement des moteurs…';
      await loadLib('jszip');
      const [docx, html2canvas, jsPDF] = await Promise.all([loadLib('docx'), loadLib('html2canvas'), loadLib('jspdf')]);
      if (!state?.mounted) return;

      label.textContent = 'Lecture du document…';
      // Scène hors écran (non display:none pour que la mise en page soit calculée).
      const stage = document.createElement('div');
      stage.className = 'doc2pdf-stage';
      stage.setAttribute('aria-hidden', 'true');
      document.body.appendChild(stage);
      state.stage = stage;
      await docx.renderAsync(await file.arrayBuffer(), stage, stage, {
        className: 'docx',
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderHeaders: withHeaders,
        renderFooters: withHeaders,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: true,
      });
      if (!state?.mounted) return;
      if (document.fonts?.ready) await document.fonts.ready;
      await nextFrame();

      label.textContent = 'Mise en page…';
      [...stage.querySelectorAll('section.docx')].forEach(paginateSection);
      const sections = [...stage.querySelectorAll('section.docx')];
      if (!sections.length) throw new Error('Document vide ou illisible.');

      let pdf = null;
      let count = 0;
      const thumbs = [];
      for (let i = 0; i < sections.length; i++) {
        label.textContent = `Rendu de la page ${i + 1}/${sections.length}…`;
        const sec = sections[i];
        const cs = getComputedStyle(sec);
        const wPx = sec.offsetWidth;
        const hPx = parseFloat(cs.minHeight) || sec.offsetHeight;
        const canvas = await html2canvas(sec, { scale, backgroundColor: PAPER, useCORS: true, logging: false });
        if (!state?.mounted) return;
        const pageHCanvas = Math.round(hPx * (canvas.width / wPx));
        const wPt = wPx * PX_TO_PT, hPt = hPx * PX_TO_PT;
        const orientation = wPt > hPt ? 'l' : 'p';
        for (const page of sliceCanvas(canvas, pageHCanvas)) {
          if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [wPt, hPt], orientation, compress: true });
          else pdf.addPage([wPt, hPt], orientation);
          const data = usePng ? page.toDataURL('image/png') : page.toDataURL('image/jpeg', 0.92);
          pdf.addImage(data, usePng ? 'PNG' : 'JPEG', 0, 0, wPt, hPt, undefined, 'FAST');
          thumbs.push(makeThumb(page));
          count++;
          if (page !== canvas) page.width = page.height = 0;
        }
        canvas.width = canvas.height = 0;
        await nextFrame();
      }
      removeStage();

      label.textContent = 'Génération du PDF…';
      const blob = pdf.output('blob');
      const outName = `${file.name.replace(/\.docx$/i, '') || 'document'}.pdf`;
      ui.download(blob, outName, 'application/pdf');
      preview.innerHTML = `<div class="doc2pdf-grid">${thumbs.map((src, i) => `
        <figure class="doc2pdf-page"><img src="${src}" alt="Page ${i + 1}"><figcaption>${i + 1}</figcaption></figure>`).join('')}</div>`;
      ui.setStatus(`${outName} : ${count} page${count > 1 ? 's' : ''} · ${fmtSize(blob.size)}.`, 'success');
      ctx?.toast?.('PDF généré.');
    } catch (err) {
      showError(ui, err instanceof Error ? new Error(`Erreur : ${err.message}`) : err, 'Conversion impossible.');
    } finally {
      removeStage();
      if (state?.mounted) {
        label.textContent = original;
        state.busy = false;
        render();
      }
    }
  }, { signal: ui.signal });

  render();
  try { window.lucide?.createIcons({ root: container }); } catch (_) { /* icônes optionnelles */ }
}

export function unmount() {
  if (!state) return;
  state.mounted = false;
  state.stage?.remove();
  state.ui.destroy();
  state = null;
}
