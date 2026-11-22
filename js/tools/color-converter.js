import { createSecurityUI } from './shared/security-tool-ui.js';
import { contrastRatio, parseColor, rgbToCmyk, rgbToHex, rgbToHsl, rgbToHsv, themeColorHex } from './shared/color-utils.js';

let ui;
let output = '';
let textColor = '';
let surfaceColor = '';
let textRgb = [];
let surfaceRgb = [];

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Couleur à convertir<input data-color type="text" spellcheck="false" placeholder="#e5322d, rgb(), hsl(), hsv() ou cmyk()"></label>
      <label class="security-tools__field">Sélecteur de couleur<input data-picker type="color" aria-label="Choisir une couleur"></label>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier les conversions</button><button class="btn-secondary" data-action="download" type="button">Télécharger les conversions</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Aperçu de la couleur</h3><p data-preview-label></p></div></div>
      <div class="color-tools__swatch" data-swatch><strong>Exemple de couleur</strong><span>Texte secondaire</span></div>
      <div class="color-tools__format-list" data-formats></div>
    </section>
  </div>`;

function render() {
  try {
    const rgb = parseColor(ui.query('[data-color]').value);
    const hex = rgbToHex(rgb);
    const foreground = contrastRatio(rgb, textRgb) >= contrastRatio(rgb, surfaceRgb) ? textColor : surfaceColor;
    ui.query('[data-picker]').value = hex;
    ui.query('[data-swatch]').style.backgroundColor = hex;
    ui.query('[data-swatch]').style.color = foreground;
    ui.query('[data-preview-label]').textContent = hex.toUpperCase();
    const hsl = rgbToHsl(rgb);
    const hsv = rgbToHsv(rgb);
    const cmyk = rgbToCmyk(rgb);
    const formats = [
      ['HEX', hex.toUpperCase()],
      ['RGB', `rgb(${rgb.map(Math.round).join(', ')})`],
      ['HSL', `hsl(${hsl[0]} ${hsl[1]}% ${hsl[2]}%)`],
      ['HSV', `hsv(${hsv[0]} ${hsv[1]}% ${hsv[2]}%)`],
      ['CMYK', `cmyk(${cmyk.map((value) => `${value}%`).join(', ')})`],
    ];
    const list = ui.query('[data-formats]');
    list.replaceChildren();
    for (const [label, value] of formats) {
      const row = document.createElement('div');
      row.className = 'color-tools__format-row';
      const name = document.createElement('strong');
      name.textContent = label;
      const code = document.createElement('code');
      code.textContent = value;
      row.append(name, code);
      list.append(row);
    }
    output = formats.map(([label, value]) => `${label} ${value}`).join('\n');
    ui.setStatus('Conversions actualisées.', 'success');
  } catch (error) {
    output = '';
    ui.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Convertisseur de couleurs',
    description: 'Convertissez une couleur entre HEX, RGB, HSL, HSV et CMYK avec un aperçu en direct.',
    content: CONTENT,
  });
  textColor = themeColorHex('--color-text');
  surfaceColor = themeColorHex('--color-surface');
  textRgb = parseColor(textColor);
  surfaceRgb = parseColor(surfaceColor);
  ui.query('[data-color]').value = themeColorHex('--theme-accent');
  ui.on('input', (event) => {
    if (event.target.matches('[data-color]')) render();
    if (event.target.matches('[data-picker]')) {
      ui.query('[data-color]').value = event.target.value;
      render();
    }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (!output) { ui.setStatus('Saisissez une couleur valide avant de continuer.', 'error'); return; }
    if (action === 'copy') await ui.copy(output, 'Conversions copiées.');
    if (action === 'download') ui.download(`${output}\n`, 'conversions-couleur.txt');
  });
  render();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  output = '';
  textColor = '';
  surfaceColor = '';
  textRgb = [];
  surfaceRgb = [];
}
