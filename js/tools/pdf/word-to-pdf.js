/**
 * word-to-pdf.js — Outil « Word vers PDF » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 * Moteur : docx-preview (+ JSZip) rend le .docx en HTML paginé hors écran,
 * puis shared/dom-to-pdf.js produit le PDF :
 *  - mode « Texte modifiable » (défaut) : texte réel sélectionnable/éditable, polices embarquées ;
 *  - mode « Image » : pages capturées (html2canvas), fidélité visuelle maximale.
 * Libs chargées à la demande depuis CDN, avec fallback de sources.
 */
import { bindDropzone, createDropzone, createSecurityUI, showError } from '../shared/security-tool-ui.js';
import { loadScriptLib, paginateOverflow, renderPagesToPdf } from '../shared/dom-to-pdf.js';

const JSZIP_LIB = {
  key: 'jszip',
  global: () => window.JSZip,
  sources: [
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
  ],
};
const DOCX_LIB = {
  key: 'docx-preview',
  global: () => window.docx?.renderAsync && window.docx,
  sources: [
    'https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/dist/docx-preview.min.js',
    'https://unpkg.com/docx-preview@0.3.6/dist/docx-preview.min.js',
  ],
};

/** Échelle de rendu html2canvas (mode image : netteté vs poids). */
const QUALITY = { standard: 1.5, high: 2, max: 3 };
const NOTES = {
  vector: 'Texte réel : sélectionnable, copiable et modifiable dans un éditeur PDF. Polices remplacées par des équivalents libres (Carlito, Tinos, Cousine). Format .doc (Word 97-2003) non pris en charge : enregistrez-le d\'abord en .docx.',
  image: 'Pages rendues en images : fidélité visuelle maximale, mais texte non sélectionnable ni modifiable. Format .doc (Word 97-2003) non pris en charge : enregistrez-le d\'abord en .docx.',
};
const EMPTY_PREVIEW = '<div class="doc2pdf-empty">L\'aperçu des pages apparaîtra après conversion</div>';

const fmtSize = (b) => {
  if (b < 1024) return `${b} o`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} Ko`;
  return `${(b / 1048576).toFixed(2)} Mo`;
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

let state = null;

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
          <label class="tool-field">Type de PDF
            <select data-role="mode">
              <option value="vector" selected>Texte modifiable (recommandé)</option>
              <option value="image">Image (fidélité maximale)</option>
            </select>
          </label>
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
        <div class="doc2pdf-preview" data-role="preview">${EMPTY_PREVIEW}</div>
        <p class="doc2pdf-note status-muted" data-role="note"></p>
      </div>`,
  });

  state = { ui, file: null, busy: false, stage: null, mounted: true };
  const $ = (r) => ui.query(`[data-role="${r}"]`);
  const fileBox = $('file'), convertBtn = $('convert'), clearBtn = $('clear'), preview = $('preview');
  const modeSel = $('mode'), qualitySel = $('quality'), formatSel = $('format');
  let dz = null;

  const render = () => {
    const has = Boolean(state.file);
    const image = modeSel.value === 'image';
    fileBox.hidden = !has;
    if (has) {
      $('name').textContent = state.file.name;
      $('sub').textContent = fmtSize(state.file.size);
    }
    convertBtn.disabled = !has || state.busy;
    clearBtn.disabled = state.busy;
    modeSel.disabled = state.busy;
    qualitySel.disabled = state.busy || !image; // options propres au mode image
    formatSel.disabled = state.busy || !image;
    $('note').textContent = NOTES[modeSel.value];
    dz?.setDisabled(state.busy);
  };

  dz = bindDropzone(ui, {
    id: 'docx',
    multiple: false,
    onFiles: ([file]) => {
      state.file = file;
      ui.setStatus('');
      preview.innerHTML = EMPTY_PREVIEW;
      render();
    },
  });

  clearBtn.addEventListener('click', () => {
    state.file = null;
    ui.setStatus('');
    preview.innerHTML = EMPTY_PREVIEW;
    render();
  }, { signal: ui.signal });
  modeSel.addEventListener('change', render, { signal: ui.signal });

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
    const mode = modeSel.value;
    const withHeaders = $('headers').value === '1';
    const file = state.file;
    try {
      label.textContent = 'Chargement des moteurs…';
      await loadScriptLib(JSZIP_LIB);
      const docx = await loadScriptLib(DOCX_LIB);
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
      [...stage.querySelectorAll('section.docx')].forEach((sec) => paginateOverflow(sec));
      const sections = [...stage.querySelectorAll('section.docx')];
      if (!sections.length) throw new Error('Document vide ou illisible.');

      const result = await renderPagesToPdf(sections, {
        mode,
        root: stage,
        scale: QUALITY[qualitySel.value],
        imageFormat: formatSel.value,
        onProgress: (msg) => { label.textContent = msg; },
        isActive: () => Boolean(state?.mounted),
      });
      if (!result || !state?.mounted) return;
      removeStage();

      const outName = `${file.name.replace(/\.docx$/i, '') || 'document'}.pdf`;
      ui.download(result.blob, outName, 'application/pdf');
      preview.innerHTML = `<div class="doc2pdf-grid">${result.thumbs.map((src, i) => `
        <figure class="doc2pdf-page"><img src="${src}" alt="Page ${i + 1}"><figcaption>${i + 1}</figcaption></figure>`).join('')}</div>`;
      const n = result.pageCount;
      ui.setStatus(`${outName} : ${n} page${n > 1 ? 's' : ''} · ${fmtSize(result.blob.size)}${mode === 'vector' ? ' · texte modifiable' : ''}.`, 'success');
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
