import { createSecurityUI } from './security-tool-ui.js';
import { themeColorHex } from './color-utils.js';

let ui;
let output = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Motif<select data-pattern><option value="stripes">Rayures</option><option value="dots">Points</option><option value="grid">Grille</option><option value="checker">Damier</option></select></label>
      <label class="security-tools__field">Couleur du motif<input data-foreground type="color"></label>
      <label class="security-tools__field">Couleur de fond<input data-background type="color"></label>
      <label class="security-tools__field">Espacement · <output data-value="spacing">24 px</output><input data-spacing type="range" min="16" max="80" value="24"></label>
      <label class="security-tools__field">Épaisseur · <output data-value="thickness">2 px</output><input data-thickness type="range" min="1" max="12" value="2"></label>
      <label class="security-tools__field" data-angle-field>Angle · <output data-value="angle">45°</output><input data-angle type="range" min="0" max="180" value="45"></label>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le CSS</button><button class="btn-secondary" data-action="download" type="button">Télécharger le CSS</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Aperçu du motif</h3><p>Le motif se met à jour à chaque réglage.</p></div></div>
      <div class="color-tools__pattern-preview" data-preview></div>
      <pre class="security-tools__result security-tools__result--digest" data-output></pre>
    </section>
  </div>`;

function render() {
  const kind = ui.query('[data-pattern]').value;
  const foreground = ui.query('[data-foreground]').value;
  const background = ui.query('[data-background]').value;
  const spacing = Number(ui.query('[data-spacing]').value);
  const thickness = Number(ui.query('[data-thickness]').value);
  const angle = Number(ui.query('[data-angle]').value);
  let images;
  let size = `${spacing}px ${spacing}px`;
  let position = '0 0';
  if (kind === 'stripes') {
    images = `repeating-linear-gradient(${angle}deg, ${foreground} 0, ${foreground} ${thickness}px, ${background} ${thickness}px, ${background} ${spacing}px)`;
    size = 'auto';
  } else if (kind === 'dots') {
    images = `radial-gradient(${foreground} ${Math.max(1, thickness / 2)}px, ${background} ${Math.max(1, thickness / 2)}px)`;
  } else if (kind === 'grid') {
    images = `linear-gradient(${foreground} ${thickness}px, ${background} ${thickness}px), linear-gradient(90deg, ${foreground} ${thickness}px, ${background} ${thickness}px)`;
  } else {
    images = `linear-gradient(45deg, ${foreground} 25%, transparent 25%, transparent 75%, ${foreground} 75%), linear-gradient(45deg, ${foreground} 25%, transparent 25%, transparent 75%, ${foreground} 75%)`;
    size = `${spacing * 2}px ${spacing * 2}px`;
    position = `0 0, ${spacing}px ${spacing}px`;
  }
  const declarations = [`background-color: ${background};`, `background-image: ${images};`, `background-size: ${size};`];
  if (kind === 'checker') declarations.push(`background-position: ${position};`);
  ui.query('[data-preview]').style.backgroundSize = size;
  ui.query('[data-preview]').style.backgroundPosition = position;
  ui.query('[data-preview]').style.backgroundColor = background;
  ui.query('[data-preview]').style.backgroundImage = images;
  output = declarations.join('\n');
  ui.query('[data-output]').textContent = output;
  ui.query('[data-angle-field]').hidden = kind !== 'stripes';
  ui.query('[data-value="spacing"]').textContent = `${spacing} px`;
  ui.query('[data-value="thickness"]').textContent = `${thickness} px`;
  ui.query('[data-value="angle"]').textContent = `${angle}°`;
  ui.setStatus('Motif CSS actualisé.', 'success');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de motifs CSS',
    description: 'Créez des rayures, points, grilles ou damiers et ajustez leurs couleurs et dimensions.',
    content: CONTENT,
  });
  ui.query('[data-foreground]').value = themeColorHex('--color-primary');
  ui.query('[data-background]').value = themeColorHex('--color-surface');
  ui.on('input', (event) => {
    if (event.target.matches('[data-foreground], [data-background], [data-spacing], [data-thickness], [data-angle]')) render();
  });
  ui.on('change', (event) => { if (event.target.matches('[data-pattern]')) render(); });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(output, 'Motif CSS copié.');
    if (action === 'download') ui.download(`${output}\n`, 'motif.css', 'text/css;charset=utf-8');
  });
  render();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  output = '';
}
