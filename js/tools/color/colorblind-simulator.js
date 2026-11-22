import { bindDropzone, createDropzone, createSecurityUI } from '../shared/security-tool-ui.js';

let ui;
let imageFile = null;
let sourceUrl = null;
let resultUrl = null;
let resultBlob = null;
let report = '';
let generation = 0;

const MATRICES = {
  protanopia: [.567, .433, 0, .558, .442, 0, .242, .758, 0],
  deuteranopia: [.625, .375, 0, .7, .3, 0, .3, .7, 0],
  tritanopia: [.95, .05, 0, 0, .433, .567, 0, .475, .525],
  achromatopsia: [.299, .587, .114, .299, .587, .114, .299, .587, .114],
};

const MODE_LABELS = {
  protanopia: 'Protanopie',
  deuteranopia: 'Deutéranopie',
  tritanopia: 'Tritanopie',
  achromatopsia: 'Achromatopsie',
};

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      ${createDropzone({ id: 'image', title: 'Glissez-déposez une image ici', hint: 'ou cliquez pour parcourir · PNG, JPEG, WebP…', accept: 'image/*', label: 'Choisir une image à simuler' })}
      <label class="security-tools__field">Type de perception<select data-mode><option value="protanopia">Protanopie</option><option value="deuteranopia">Deutéranopie</option><option value="tritanopia">Tritanopie</option><option value="achromatopsia">Achromatopsie</option></select></label>
      <p class="security-tools__hint">L’image est traitée uniquement dans votre navigateur. La simulation est indicative et ne remplace pas un test de vision professionnel.</p>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button" disabled>Copier le rapport</button><button class="btn-secondary" data-action="download" type="button" disabled>Télécharger l’image</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Comparaison</h3><p data-dimensions>Choisissez une image pour commencer.</p></div></div>
      <div class="color-tools__image-comparison">
        <figure><figcaption>Image originale</figcaption><img data-original alt="Image originale" hidden></figure>
        <figure><figcaption data-result-label>Simulation</figcaption><img data-result alt="Simulation daltonisme" hidden></figure>
      </div>
    </section>
  </div>`;

function revokePreview(url) {
  if (url) URL.revokeObjectURL(url);
}

async function simulate() {
  if (!imageFile || !ui) return;
  const activeUi = ui;
  const currentGeneration = ++generation;
  const file = imageFile;
  const mode = activeUi.query('[data-mode]').value;
  activeUi.query('[data-action="download"]').disabled = true;
  activeUi.query('[data-action="copy"]').disabled = true;
  activeUi.query('[data-result]').hidden = true;
  resultBlob = null;
  try {
    const image = await createImageBitmap(file);
    try {
      if (!activeUi.isActive() || currentGeneration !== generation) return;
      if (image.width * image.height > 16000000) throw new Error('L’image dépasse la limite de 16 mégapixels.');
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Le navigateur ne permet pas de traiter cette image.');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const matrix = MATRICES[mode];
      for (let index = 0; index < pixels.data.length; index += 4) {
        const red = pixels.data[index];
        const green = pixels.data[index + 1];
        const blue = pixels.data[index + 2];
        pixels.data[index] = red * matrix[0] + green * matrix[1] + blue * matrix[2];
        pixels.data[index + 1] = red * matrix[3] + green * matrix[4] + blue * matrix[5];
        pixels.data[index + 2] = red * matrix[6] + green * matrix[7] + blue * matrix[8];
      }
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('La création de l’image simulée a échoué.');
      if (!activeUi.isActive() || currentGeneration !== generation) return;
      revokePreview(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      resultBlob = blob;
      activeUi.query('[data-result]').src = resultUrl;
      activeUi.query('[data-result]').hidden = false;
      activeUi.query('[data-result-label]').textContent = MODE_LABELS[mode];
      activeUi.query('[data-dimensions]').textContent = `${canvas.width} × ${canvas.height} px · ${file.name}`;
      report = `Simulation : ${MODE_LABELS[mode]}\nFichier : ${file.name}\nDimensions : ${canvas.width} × ${canvas.height} px`;
      activeUi.query('[data-action="download"]').disabled = false;
      activeUi.query('[data-action="copy"]').disabled = false;
      activeUi.setStatus('Simulation générée localement.', 'success');
    } finally {
      image.close();
    }
  } catch (error) {
    if (activeUi.isActive() && currentGeneration === generation) activeUi.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Simulateur de daltonisme',
    description: 'Comparez une image originale avec une simulation de quatre types de déficience de la vision des couleurs.',
    content: CONTENT,
  });
  imageFile = null;
  sourceUrl = null;
  resultUrl = null;
  resultBlob = null;
  report = '';
  generation = 0;
  bindDropzone(ui, {
    id: 'image',
    onFiles: ([file]) => {
      if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
        ui.setStatus('Choisissez une image matricielle valide (PNG, JPEG, WebP…).', 'error');
        return;
      }
      imageFile = file;
      generation += 1;
      revokePreview(sourceUrl);
      revokePreview(resultUrl);
      sourceUrl = null;
      resultUrl = null;
      resultBlob = null;
      report = '';
      ui.query('[data-original]').hidden = true;
      ui.query('[data-result]').hidden = true;
      ui.query('[data-action="download"]').disabled = true;
      ui.query('[data-action="copy"]').disabled = true;
      try {
        if (imageFile.size > 50000000) throw new Error('Le fichier image dépasse la limite de 50 Mo.');
        sourceUrl = URL.createObjectURL(imageFile);
      } catch (error) {
        imageFile = null;
        ui.setStatus(`Aperçu impossible : ${error.message}`, 'error');
        return;
      }
      ui.query('[data-original]').src = sourceUrl;
      ui.query('[data-original]').hidden = false;
      ui.query('[data-result]').hidden = true;
      ui.query('[data-dimensions]').textContent = 'Simulation en cours…';
      simulate();
    },
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-mode]')) simulate();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(report, 'Rapport de simulation copié.');
    if (action === 'download' && resultBlob) {
      const name = imageFile.name.replace(/\.[^.]+$/, '') || 'image';
      ui.download(resultBlob, `${name}-${ui.query('[data-mode]').value}.png`, 'image/png');
    }
  });
}

export function unmount() {
  generation += 1;
  revokePreview(sourceUrl);
  revokePreview(resultUrl);
  ui?.destroy();
  ui = null;
  imageFile = null;
  sourceUrl = null;
  resultUrl = null;
  resultBlob = null;
  report = '';
}
