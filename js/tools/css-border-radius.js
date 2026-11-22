import { createSecurityUI } from './security-tool-ui.js';
import { themeColorHex } from './color-utils.js';

let ui;
let output = '';

const CORNERS = [
  ['Haut gauche', 35, 30],
  ['Haut droite', 65, 40],
  ['Bas droite', 70, 60],
  ['Bas gauche', 30, 70],
];

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Forme de départ<select data-preset><option value="custom">Personnalisée</option><option value="circle">Cercle</option><option value="oval">Ovale</option><option value="blob">Blob organique</option></select></label>
      <label class="security-tools__field">Couleur de l’aperçu<input data-color type="color"></label>
      <div class="color-tools__radius-controls" data-corners></div>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier la règle CSS</button><button class="btn-secondary" data-action="download" type="button">Télécharger le CSS</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Aperçu de la forme</h3><p data-shape-label></p></div></div>
      <div class="color-tools__radius-stage"><div class="color-tools__radius-shape" data-preview></div></div>
      <pre class="security-tools__result security-tools__result--digest" data-output></pre>
    </section>
  </div>`;

function renderControls(xValues, yValues) {
  const container = ui.query('[data-corners]');
  container.replaceChildren();
  CORNERS.forEach(([name], index) => {
    const row = document.createElement('div');
    row.className = 'color-tools__radius-row';
    const heading = document.createElement('strong');
    heading.textContent = name;
    row.append(heading);
    for (const [axis, value, label] of [['x', xValues[index], 'Horizontal'], ['y', yValues[index], 'Vertical']]) {
      const field = document.createElement('label');
      field.className = 'security-tools__field';
      field.textContent = `${label} · ${value} %`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.value = String(value);
      input.dataset[axis] = String(index);
      field.append(input);
      row.append(field);
    }
    container.append(row);
  });
}

function readRadius() {
  const x = [...ui.query('[data-corners]').querySelectorAll('[data-x]')].map((input) => Number(input.value));
  const y = [...ui.query('[data-corners]').querySelectorAll('[data-y]')].map((input) => Number(input.value));
  return { x, y };
}

function render() {
  const { x, y } = readRadius();
  const radius = `${x.map((value) => `${value}%`).join(' ')} / ${y.map((value) => `${value}%`).join(' ')}`;
  const color = ui.query('[data-color]').value;
  output = `border-radius: ${radius};`;
  ui.query('[data-preview]').style.borderRadius = radius;
  ui.query('[data-preview]').style.backgroundColor = color;
  ui.query('[data-output]').textContent = output;
  ui.query('[data-shape-label]').textContent = `Rayons horizontaux ${x.join(' %, ')} % · verticaux ${y.join(' %, ')} %`;
  ui.setStatus('Forme actualisée.', 'success');
}

function applyPreset(value) {
  let x;
  let y;
  if (value === 'circle') { x = [50, 50, 50, 50]; y = [50, 50, 50, 50]; }
  else if (value === 'oval') { x = [50, 50, 50, 50]; y = [35, 35, 35, 35]; }
  else if (value === 'blob') { x = [35, 65, 70, 30]; y = [30, 40, 60, 70]; }
  else { ({ x, y } = readRadius()); }
  renderControls(x, y);
  render();
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de border-radius',
    description: 'Composez des coins arrondis personnalisés ou partez d’un cercle, d’un ovale ou d’un blob.',
    content: CONTENT,
  });
  ui.query('[data-color]').value = themeColorHex('--theme-accent');
  applyPreset('blob');
  ui.on('input', (event) => {
    if (event.target.matches('[data-x], [data-y]')) {
      event.target.closest('label').firstChild.textContent = `${event.target.dataset.x !== undefined ? 'Horizontal' : 'Vertical'} · ${event.target.value} %`;
      ui.query('[data-preset]').value = 'custom';
      render();
    }
    if (event.target.matches('[data-color]')) render();
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-preset]')) applyPreset(event.target.value);
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(output, 'Règle CSS copiée.');
    if (action === 'download') ui.download(`${output}\n`, 'border-radius.css', 'text/css;charset=utf-8');
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  output = '';
}
