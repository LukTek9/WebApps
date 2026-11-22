import { bindDropzone, createDropzone, createSecurityUI } from './security-tool-ui.js';
import { sanitizeSvg, serializeSvg, svgDimensions } from './svg-utils.js';

let ui;
let resultBlob = null;
let previewUrl = null;
let generation = 0;
let fileName = 'image';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      ${createDropzone({ id: 'svg', title: 'Glissez-déposez un SVG ici', hint: 'ou cliquez pour parcourir · fichier .svg', accept: '.svg,image/svg+xml', label: 'Importer un SVG' })}
      <label class="security-tools__field">Code SVG<textarea class="security-tools__textarea color-tools__svg-source" data-source rows="12" spellcheck="false" placeholder="Collez votre balisage <svg>…"></textarea></label>
      <div class="security-tools__controls">
        <label class="security-tools__field">Format<select data-format><option value="image/png">PNG</option><option value="image/webp">WebP</option></select></label>
        <label class="security-tools__field">Échelle<select data-scale><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label>
      </div>
      <div class="security-tools__actions"><button class="btn-primary" data-action="rasterize" type="button">Rasteriser</button><button class="btn-secondary" data-action="copy" type="button" disabled>Copier l’image</button><button class="btn-secondary" data-action="download" type="button" disabled>Télécharger l’image</button></div>
      <p class="security-tools__hint">Les SVG actifs et les références réseau sont retirés avant le rendu. Limite de sortie : 16 mégapixels.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Aperçu raster</h3><p data-dimensions>Collez ou importez un SVG pour commencer.</p></div></div>
      <div class="color-tools__raster-preview"><img data-preview alt="Aperçu de l’image rasterisée" hidden></div>
      <pre class="security-tools__result security-tools__result--digest" data-report></pre>
    </section>
  </div>`;

function revokePreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function invalidateResult() {
  generation += 1;
  resultBlob = null;
  revokePreview();
  ui.query('[data-preview]').hidden = true;
  ui.query('[data-action="copy"]').disabled = true;
  ui.query('[data-action="download"]').disabled = true;
  ui.query('[data-report]').textContent = '';
}

async function rasterize() {
  const activeUi = ui;
  if (!activeUi) return;
  const currentGeneration = ++generation;
  const source = activeUi.query('[data-source]').value;
  const scale = Number(activeUi.query('[data-scale]').value);
  const requestedType = activeUi.query('[data-format]').value;
  let sourceUrl = null;
  activeUi.query('[data-action="copy"]').disabled = true;
  activeUi.query('[data-action="download"]').disabled = true;
  try {
    const documentNode = sanitizeSvg(source);
    const dimensions = svgDimensions(documentNode.documentElement);
    const width = Math.round(dimensions.width * scale);
    const height = Math.round(dimensions.height * scale);
    if (width > 4096 || height > 4096 || width * height > 16000000) {
      throw new Error('La sortie dépasse la limite de 16 mégapixels ou 4096 px par côté.');
    }
    const svgBlob = new Blob([serializeSvg(documentNode)], { type: 'image/svg+xml;charset=utf-8' });
    sourceUrl = URL.createObjectURL(svgBlob);
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();
    if (!activeUi.isActive() || currentGeneration !== generation) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Le navigateur ne permet pas de créer une image raster.');
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, requestedType, 0.92));
    if (!blob) throw new Error('La création de l’image a échoué.');
    if (!activeUi.isActive() || currentGeneration !== generation) return;
    resultBlob = blob;
    revokePreview();
    previewUrl = URL.createObjectURL(blob);
    activeUi.query('[data-preview]').src = previewUrl;
    activeUi.query('[data-preview]').hidden = false;
    const format = blob.type === 'image/webp' ? 'WebP' : 'PNG';
    const extension = blob.type === 'image/webp' ? 'webp' : 'png';
    const outputName = `${fileName}.${extension}`;
    activeUi.query('[data-dimensions]').textContent = `${width} × ${height} px · ${format}`;
    activeUi.query('[data-report]').textContent = `${outputName} · ${Math.round(blob.size / 1024)} Ko`;
    activeUi.query('[data-action="copy"]').disabled = false;
    activeUi.query('[data-action="download"]').disabled = false;
    activeUi.setStatus(blob.type === requestedType ? 'Image rasterisée localement.' : `Format ${requestedType === 'image/webp' ? 'WebP' : 'PNG'} indisponible : image générée en ${format}.`, blob.type === requestedType ? 'success' : 'muted');
  } catch (error) {
    if (activeUi.isActive() && currentGeneration === generation) activeUi.setStatus(error.message, 'error');
  } finally {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
}

async function copyImage() {
  if (!resultBlob) { ui.setStatus('Rasterisez un SVG valide avant la copie.', 'error'); return; }
  if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
    ui.setStatus('La copie d’image n’est pas prise en charge ici. Téléchargez le fichier à la place.', 'error');
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ [resultBlob.type]: resultBlob })]);
    ui.setStatus('Image copiée dans le presse-papiers.', 'success');
  } catch (error) {
    ui.setStatus(`Copie d’image impossible : ${error.message}`, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Convertisseur SVG vers PNG / WebP',
    description: 'Rasterisez un SVG localement, choisissez le format et l’échelle de sortie.',
    content: CONTENT,
  });
  resultBlob = null;
  previewUrl = null;
  generation = 0;
  fileName = 'image';
  ui.on('input', (event) => {
    if (event.target.matches('[data-source]')) {
      invalidateResult();
      ui.setStatus('Source modifiée : rasterisez à nouveau pour actualiser l’aperçu.', 'muted');
    }
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-format], [data-scale]')) rasterize();
  });
  bindDropzone(ui, {
    id: 'svg',
    onFiles: async ([file]) => {
      const activeUi = ui;
      try {
        if (file.size > 10000000) throw new Error('Le fichier SVG dépasse la limite de 10 Mo.');
        const source = await file.text();
        if (!activeUi.isActive()) return;
        fileName = file.name.replace(/\.svg$/i, '').replace(/[\\/:*?"<>|]/g, '-') || 'image';
        activeUi.query('[data-source]').value = source;
        invalidateResult();
        rasterize();
      } catch (error) {
        if (activeUi.isActive()) activeUi.setStatus(`Lecture du SVG impossible : ${error.message}`, 'error');
      }
    },
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'rasterize') rasterize();
    if (action === 'copy') await copyImage();
    if (action === 'download' && resultBlob) {
      const extension = resultBlob.type === 'image/webp' ? 'webp' : 'png';
      ui.download(resultBlob, `${fileName}.${extension}`, resultBlob.type);
    }
  });
}

export function unmount() {
  generation += 1;
  revokePreview();
  ui?.destroy();
  ui = null;
  resultBlob = null;
  fileName = 'image';
}
