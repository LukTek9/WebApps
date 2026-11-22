import { createSecurityUI } from './security-tool-ui.js';
import { themeColorHex } from './color-utils.js';

let ui;
let stops = [];
let output = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Type<select data-type><option value="linear">Linéaire</option><option value="radial">Radial</option></select></label>
        <label class="security-tools__field" data-angle-field>Angle<input data-angle type="range" min="0" max="360" value="90"><output data-angle-value>90°</output></label>
      </div>
      <div class="security-tools__panel-heading"><div><h3>Points de couleur</h3><p>Ajoutez jusqu’à six couleurs et déplacez chaque point.</p></div><button class="btn-secondary" data-action="add" type="button">Ajouter une couleur</button></div>
      <div class="color-tools__stops" data-stops></div>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le CSS</button><button class="btn-secondary" data-action="download" type="button">Télécharger le CSS</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Aperçu en direct</h3><p data-description></p></div></div>
      <div class="color-tools__gradient-preview" data-preview></div>
      <pre class="security-tools__result security-tools__result--digest" data-output></pre>
    </section>
  </div>`;

function renderStops() {
  const container = ui.query('[data-stops]');
  container.replaceChildren();
  stops.forEach((stop, index) => {
    const row = document.createElement('div');
    row.className = 'color-tools__stop';
    const label = document.createElement('label');
    label.className = 'security-tools__field';
    label.textContent = `Couleur ${index + 1}`;
    const color = document.createElement('input');
    color.type = 'color';
    color.value = stop.color;
    color.dataset.stopColor = '';
    label.append(color);
    const positionLabel = document.createElement('label');
    positionLabel.className = 'security-tools__field';
    positionLabel.textContent = `Position ${index + 1} · ${stop.position} %`;
    const position = document.createElement('input');
    position.type = 'range';
    position.min = '0';
    position.max = '100';
    position.value = String(stop.position);
    position.dataset.stopPosition = '';
    positionLabel.append(position);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-secondary';
    remove.dataset.action = 'remove';
    remove.dataset.index = String(index);
    remove.textContent = 'Retirer';
    remove.disabled = stops.length <= 2;
    row.append(label, positionLabel, remove);
    container.append(row);
  });
}

function render() {
  const type = ui.query('[data-type]').value;
  const angle = Number(ui.query('[data-angle]').value);
  const sorted = stops.map((stop, index) => ({ ...stop, index })).sort((a, b) => a.position - b.position || a.index - b.index);
  const list = sorted.map((stop) => `${stop.color} ${stop.position}%`).join(', ');
  output = `background: ${type === 'linear' ? `linear-gradient(${angle}deg, ${list})` : `radial-gradient(circle, ${list})`};`;
  ui.query('[data-preview]').style.backgroundImage = output.slice('background: '.length, -1);
  ui.query('[data-output]').textContent = output;
  ui.query('[data-angle-field]').hidden = type !== 'linear';
  ui.query('[data-angle-value]').textContent = `${angle}°`;
  ui.query('[data-description]').textContent = `${type === 'linear' ? `Linéaire · ${angle}°` : 'Radial'} · ${stops.length} points`;
  ui.query('[data-action="add"]').disabled = stops.length >= 6;
  ui.setStatus('Dégradé mis à jour.', 'success');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de dégradés CSS',
    description: 'Composez un dégradé avec plusieurs points, un angle réglable et un aperçu instantané.',
    content: CONTENT,
  });
  stops = [
    { color: themeColorHex('--color-primary'), position: 0 },
    { color: themeColorHex('--color-text-muted'), position: 100 },
  ];
  renderStops();
  render();
  ui.on('input', (event) => {
    if (event.target.matches('[data-angle]')) render();
    if (event.target.matches('[data-stop-color]')) {
      const index = [...ui.query('[data-stops]').querySelectorAll('[data-stop-color]')].indexOf(event.target);
      if (index >= 0) stops[index].color = event.target.value;
      render();
    }
    if (event.target.matches('[data-stop-position]')) {
      const index = [...ui.query('[data-stops]').querySelectorAll('[data-stop-position]')].indexOf(event.target);
      if (index >= 0) {
        stops[index].position = Number(event.target.value);
        event.target.closest('label').firstChild.textContent = `Position ${index + 1} · ${stops[index].position} %`;
        render();
      }
    }
  });
  ui.on('change', (event) => { if (event.target.matches('[data-type]')) render(); });
  ui.on('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'add' && stops.length < 6) {
      stops.push({ color: themeColorHex('--theme-accent'), position: Math.round(stops.length / (stops.length + 1) * 100) });
      renderStops();
      render();
    }
    if (button.dataset.action === 'remove' && stops.length > 2) {
      stops.splice(Number(button.dataset.index), 1);
      renderStops();
      render();
    }
    if (button.dataset.action === 'copy') await ui.copy(output, 'Règle CSS copiée.');
    if (button.dataset.action === 'download') ui.download(`${output}\n`, 'degrade.css', 'text/css;charset=utf-8');
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  stops = [];
  output = '';
}
