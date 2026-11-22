import { createSecurityUI, showError } from './security-tool-ui.js';

let ui;
let values = [];
let uuids = [];

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Format<select data-format><option value="standard">UUID v4 standard</option><option value="upper">Majuscules</option><option value="braces">Avec accolades</option><option value="compact">Sans tirets</option></select></label>
        <label class="security-tools__field">Quantité<input data-count type="number" min="1" max="500" value="5"></label>
      </div>
      <div class="security-tools__actions"><button class="btn-primary" data-action="generate" type="button">Générer de nouveaux UUID</button><button class="btn-secondary" data-action="copy" type="button">Copier</button><button class="btn-secondary" data-action="download" type="button">Télécharger .txt</button></div>
      <p class="security-tools__hint">Chaque identifiant est créé avec crypto.randomUUID() ou crypto.getRandomValues().</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Aperçu des identifiants</h3><p data-summary>5 identifiants prêts à être générés.</p></div></div>
      <output class="security-tools__result" data-output aria-label="UUID générés"></output>
    </section>
  </div>`;

function randomUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatUuid(value) {
  const format = ui.query('[data-format]').value;
  if (format === 'upper') return value.toUpperCase();
  if (format === 'braces') return `{${value}}`;
  if (format === 'compact') return value.replace(/-/g, '');
  return value;
}

function generate() {
  const count = Math.max(1, Math.min(500, Number(ui.query('[data-count]').value) || 1));
  uuids = Array.from({ length: count }, randomUuid);
  renderValues();
  ui.setStatus(`${count} identifiant(s) généré(s).`, 'success');
}

function renderValues() {
  values = uuids.map(formatUuid);
  ui.query('[data-output]').textContent = values.join('\n');
  ui.query('[data-summary]').textContent = `${values.length} UUID v4 · format ${ui.query('[data-format]').selectedOptions[0].textContent}`;
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur UUID / GUID',
    description: 'Générez des identifiants UUID v4 en lot, avec plusieurs formats d’affichage.',
    content: CONTENT,
  });
  values = [];
  uuids = [];
  ui.on('input', (event) => {
    if (event.target.matches('[data-count]')) {
      const count = Math.max(1, Math.min(500, Number(event.target.value) || 1));
      ui.query('[data-summary]').textContent = `${count} UUID v4 configuré(s) · régénérez pour obtenir de nouvelles valeurs.`;
    }
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-format]') && uuids.length) renderValues();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'generate') {
      try { generate(); } catch (error) { showError(ui, error); }
    }
    if (action === 'copy') await ui.copy(values.join('\n'), 'UUID copiés.');
    if (action === 'download') {
      if (!values.length) { ui.setStatus('Générez des identifiants avant le téléchargement.', 'error'); return; }
      ui.download(values.join('\n'), 'identifiants-uuid.txt');
    }
  });
  generate();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  values = [];
  uuids = [];
}
