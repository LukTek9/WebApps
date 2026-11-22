import { createSecurityUI } from '../shared/security-tool-ui.js';
import { contrastRatio, hexToRgb, rgbToHex, rotateHsl, themeColorHex } from '../shared/color-utils.js';

let ui;
let output = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Couleur de départ<input data-color type="color"></label>
      <label class="security-tools__field">Harmonie<select data-harmony><option value="complementary">Complémentaire</option><option value="analogous">Analogue</option><option value="triadic">Triadique</option><option value="tetradic">Tétradique</option><option value="monochromatic">Monochromatique</option></select></label>
      <label class="security-tools__field">Nombre de couleurs<select data-count><option value="3">3 couleurs</option><option value="5" selected>5 couleurs</option><option value="7">7 couleurs</option></select></label>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier les variables CSS</button><button class="btn-secondary" data-action="download" type="button">Télécharger la palette</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Palette en direct</h3><p data-description></p></div></div>
      <div class="color-tools__palette" data-palette></div>
      <pre class="security-tools__result security-tools__result--digest" data-output></pre>
    </section>
  </div>`;

function harmonyOffsets(kind, count) {
  if (kind === 'complementary') return count === 3 ? [0, 180, 0] : [0, 180, 0, 180, 0, 180, 0];
  if (kind === 'triadic') return Array.from({ length: count }, (_, index) => index % 3 * 120);
  if (kind === 'tetradic') return Array.from({ length: count }, (_, index) => index % 4 * 90);
  if (kind === 'monochromatic') return Array(count).fill(0);
  return Array.from({ length: count }, (_, index) => (index - Math.floor((count - 1) / 2)) * 24);
}

function render() {
  const kind = ui.query('[data-harmony]').value;
  const count = Number(ui.query('[data-count]').value);
  const base = hexToRgb(ui.query('[data-color]').value);
  const offsets = harmonyOffsets(kind, count);
  const colors = offsets.map((offset, index) => {
    const cycle = kind === 'triadic' ? 3 : kind === 'tetradic' ? 4 : kind === 'complementary' ? 2 : count;
    const repetition = Math.floor(index / cycle);
    const lightnessOffset = kind === 'monochromatic'
      ? (index - (count - 1) / 2) * 14
      : repetition ? (repetition % 2 ? 14 : -14) : 0;
    return rgbToHex(rotateHsl(base, offset, lightnessOffset));
  });
  const textColor = themeColorHex('--color-text');
  const surfaceColor = themeColorHex('--color-surface');
  const container = ui.query('[data-palette]');
  container.replaceChildren();
  colors.forEach((color, index) => {
    const card = document.createElement('article');
    card.className = 'color-tools__palette-swatch';
    card.style.backgroundColor = color;
    card.style.color = contrastRatio(hexToRgb(color), hexToRgb(textColor)) >= contrastRatio(hexToRgb(color), hexToRgb(surfaceColor)) ? textColor : surfaceColor;
    const number = document.createElement('strong');
    number.textContent = `Couleur ${index + 1}`;
    const value = document.createElement('code');
    value.textContent = color.toUpperCase();
    card.append(number, value);
    container.append(card);
  });
  output = colors.map((color, index) => `--palette-${index + 1}: ${color};`).join('\n');
  ui.query('[data-output]').textContent = output;
  ui.query('[data-description]').textContent = `${ui.query('[data-harmony]').selectedOptions[0].text} · ${colors.length} nuances`;
  ui.setStatus('Palette générée localement.', 'success');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de palettes',
    description: 'Créez une harmonie colorée et exportez les couleurs en variables CSS.',
    content: CONTENT,
  });
  ui.query('[data-color]').value = themeColorHex('--theme-accent');
  ui.on('input', (event) => {
    if (event.target.matches('[data-color]')) render();
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-harmony], [data-count]')) render();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(output, 'Variables de palette copiées.');
    if (action === 'download') ui.download(`:root {\n${output}\n}\n`, 'palette.css', 'text/css;charset=utf-8');
  });
  render();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  output = '';
}
