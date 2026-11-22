import { createSecurityUI } from './security-tool-ui.js';
import { hexToRgb, themeColorHex } from './color-utils.js';

let ui;
let output = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Couleur de l’ombre<input data-color type="color"></label>
      <label class="security-tools__field">Décalage horizontal · <output data-value="x">12 px</output><input data-x type="range" min="-40" max="40" value="12"></label>
      <label class="security-tools__field">Décalage vertical · <output data-value="y">12 px</output><input data-y type="range" min="-40" max="40" value="12"></label>
      <label class="security-tools__field">Flou · <output data-value="blur">24 px</output><input data-blur type="range" min="0" max="80" value="24"></label>
      <label class="security-tools__field">Extension · <output data-value="spread">0 px</output><input data-spread type="range" min="-24" max="40" value="0"></label>
      <label class="security-tools__field">Opacité · <output data-value="opacity">24 %</output><input data-opacity type="range" min="0" max="100" value="24"></label>
      <label class="security-tools__options"><span><input data-inset type="checkbox"> Ombre intérieure</span></label>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le CSS</button><button class="btn-secondary" data-action="download" type="button">Télécharger le CSS</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Aperçu en direct</h3><p>Réglez les dimensions et la transparence à votre convenance.</p></div></div>
      <div class="color-tools__shadow-stage"><div class="color-tools__shadow-card" data-preview>Élément avec ombre</div></div>
      <pre class="security-tools__result security-tools__result--digest" data-output></pre>
    </section>
  </div>`;

function render() {
  const x = Number(ui.query('[data-x]').value);
  const y = Number(ui.query('[data-y]').value);
  const blur = Number(ui.query('[data-blur]').value);
  const spread = Number(ui.query('[data-spread]').value);
  const opacity = Number(ui.query('[data-opacity]').value);
  const rgb = hexToRgb(ui.query('[data-color]').value);
  const color = `rgba(${rgb.join(', ')}, ${(opacity / 100).toFixed(2)})`;
  output = `box-shadow: ${ui.query('[data-inset]').checked ? 'inset ' : ''}${x}px ${y}px ${blur}px ${spread}px ${color};`;
  ui.query('[data-preview]').style.boxShadow = output.slice('box-shadow: '.length, -1);
  ui.query('[data-output]').textContent = output;
  for (const [key, value] of Object.entries({ x, y, blur, spread })) ui.query(`[data-value="${key}"]`).textContent = `${value} px`;
  ui.query('[data-value="opacity"]').textContent = `${opacity} %`;
  ui.setStatus('Ombre actualisée.', 'success');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur d’ombres CSS',
    description: 'Réglez le décalage, le flou, l’extension, l’opacité et le type d’ombre avec aperçu.',
    content: CONTENT,
  });
  ui.query('[data-color]').value = themeColorHex('--theme-accent');
  ui.on('input', (event) => {
    if (event.target.matches('[data-x], [data-y], [data-blur], [data-spread], [data-opacity], [data-color]')) render();
  });
  ui.on('change', (event) => { if (event.target.matches('[data-inset]')) render(); });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(output, 'Règle CSS copiée.');
    if (action === 'download') ui.download(`${output}\n`, 'ombre.css', 'text/css;charset=utf-8');
  });
  render();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  output = '';
}
