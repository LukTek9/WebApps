import { createSecurityUI, escapeHtml } from './security-tool-ui.js';

/** Valeur de chaque unité exprimée en bits. */
const UNITS = [
  { id: 'bit', label: 'Bit (bit)', bits: 1, group: 'Bits' },
  { id: 'kbit', label: 'Kilobit (kbit)', bits: 1e3, group: 'Bits' },
  { id: 'Mbit', label: 'Mégabit (Mbit)', bits: 1e6, group: 'Bits' },
  { id: 'Gbit', label: 'Gigabit (Gbit)', bits: 1e9, group: 'Bits' },
  { id: 'Tbit', label: 'Térabit (Tbit)', bits: 1e12, group: 'Bits' },
  { id: 'o', label: 'Octet (o)', bits: 8, group: 'Décimal (SI)' },
  { id: 'ko', label: 'Kilooctet (ko)', bits: 8e3, group: 'Décimal (SI)' },
  { id: 'Mo', label: 'Mégaoctet (Mo)', bits: 8e6, group: 'Décimal (SI)' },
  { id: 'Go', label: 'Gigaoctet (Go)', bits: 8e9, group: 'Décimal (SI)' },
  { id: 'To', label: 'Téraoctet (To)', bits: 8e12, group: 'Décimal (SI)' },
  { id: 'Po', label: 'Pétaoctet (Po)', bits: 8e15, group: 'Décimal (SI)' },
  { id: 'Kio', label: 'Kibioctet (Kio)', bits: 8 * 1024, group: 'Binaire (CEI)' },
  { id: 'Mio', label: 'Mébioctet (Mio)', bits: 8 * 1024 ** 2, group: 'Binaire (CEI)' },
  { id: 'Gio', label: 'Gibioctet (Gio)', bits: 8 * 1024 ** 3, group: 'Binaire (CEI)' },
  { id: 'Tio', label: 'Tébioctet (Tio)', bits: 8 * 1024 ** 4, group: 'Binaire (CEI)' },
  { id: 'Pio', label: 'Pébioctet (Pio)', bits: 8 * 1024 ** 5, group: 'Binaire (CEI)' },
];

const PRESETS = [
  ['Disque « 1 To » vendu', 1, 'To'],
  ['Clé USB « 64 Go »', 64, 'Go'],
  ['Film HD (≈ 4 Go)', 4, 'Go'],
  ['Photo (≈ 5 Mo)', 5, 'Mo'],
];

let ui;
let lastRows = [];

function optionsHtml(selected) {
  const groups = [...new Set(UNITS.map((unit) => unit.group))];
  return groups.map((group) => `<optgroup label="${escapeHtml(group)}">${UNITS.filter((unit) => unit.group === group)
    .map((unit) => `<option value="${unit.id}"${unit.id === selected ? ' selected' : ''}>${escapeHtml(unit.label)}</option>`).join('')}</optgroup>`).join('');
}

const CONTENT = `
  <div class="security-tools__panel">
    <div class="security-tools__controls">
      <label class="security-tools__field">Valeur<input data-value type="text" inputmode="decimal" value="1" autocomplete="off"></label>
      <label class="security-tools__field">Unité de départ<select data-from>${optionsHtml('Go')}</select></label>
      <label class="security-tools__field">Décimales (affichage)
        <select data-decimals>
          <option value="0">0</option><option value="2">2</option><option value="4" selected>4</option><option value="6">6</option><option value="10">10</option>
        </select>
      </label>
      <label><input data-scientific type="checkbox"> Notation scientifique pour les valeurs extrêmes</label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="swap" type="button">Inverser avec l’unité cible</button>
      <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le tableau</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger en CSV</button>
    </div>
    <div class="security-tools__actions" data-presets>${PRESETS.map(([label, value, unit], index) => `<button class="btn-secondary" type="button" data-preset="${index}" title="${value} ${unit}">${escapeHtml(label)}</button>`).join('')}</div>
    <label class="security-tools__field">Unité cible principale<select data-to>${optionsHtml('Mo')}</select></label>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Conversion</h3><p data-summary>Saisissez une valeur.</p></div></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead><tr><th scope="col">Unité</th><th scope="col">Valeur</th></tr></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint">Décimal (SI) : 1 ko = 1 000 o. Binaire (CEI) : 1 Kio = 1 024 o. Les constructeurs de disques utilisent le décimal, les systèmes d’exploitation affichent souvent le binaire.</p>
  </section>`;

function parseValue(text) {
  const normalized = text.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!normalized) return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) throw new Error('Valeur numérique invalide (ex. 1,5 ou 2e6).');
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error('La valeur est trop grande.');
  if (number < 0) throw new Error('Une quantité de données ne peut pas être négative.');
  return number;
}

function format(number) {
  const decimals = Number(ui.query('[data-decimals]').value);
  const scientific = ui.query('[data-scientific]').checked;
  if (number === 0) return '0';
  if (scientific && (number >= 1e15 || number < 10 ** -decimals)) return number.toExponential(Math.min(decimals, 6)).replace('.', ',');
  return number.toLocaleString('fr-FR', { maximumFractionDigits: decimals });
}

function render() {
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const body = ui.query('[data-body]');
  const buttons = [...ui.root.querySelectorAll('[data-action]')].filter((button) => button.dataset.action !== 'swap');
  const value = parseValue(ui.query('[data-value]').value);
  if (value === null) {
    lastRows = [];
    summary.textContent = 'Saisissez une valeur.';
    stats.innerHTML = '';
    body.innerHTML = '';
    table.hidden = true;
    buttons.forEach((button) => { button.disabled = true; });
    return;
  }
  const from = UNITS.find((unit) => unit.id === ui.query('[data-from]').value);
  const to = UNITS.find((unit) => unit.id === ui.query('[data-to]').value);
  const bits = value * from.bits;
  lastRows = UNITS.map((unit) => ({ unit, amount: bits / unit.bits }));
  const main = bits / to.bits;
  summary.textContent = `${format(value)} ${from.id} = ${format(main)} ${to.id}`;
  stats.innerHTML = [
    ['Résultat principal', `${format(main)} ${to.id}`],
    ['En octets', `${format(bits / 8)} o`],
    ['En bits', `${format(bits)} bit`],
  ].map(([label, text]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(text)}</strong></article>`).join('');
  body.innerHTML = lastRows.map(({ unit, amount }) => `<tr><th scope="row">${escapeHtml(unit.label)}</th><td>${escapeHtml(format(amount))}</td></tr>`).join('');
  table.hidden = false;
  buttons.forEach((button) => { button.disabled = false; });
}

function safeRender(activeUi) {
  try {
    render();
  } catch (error) {
    if (!activeUi.isActive()) return;
    lastRows = [];
    activeUi.query('[data-table]').hidden = true;
    activeUi.query('[data-stats]').innerHTML = '';
    activeUi.query('[data-summary]').textContent = 'Conversion impossible.';
    activeUi.root.querySelectorAll('[data-action]').forEach((button) => { if (button.dataset.action !== 'swap') button.disabled = true; });
    activeUi.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Convertisseur d’unités de données',
    description: 'Convertissez bits, octets, ko/Mo/Go/To (décimal) et Kio/Mio/Gio/Tio (binaire) avec tableau complet.',
    content: CONTENT,
  });
  lastRows = [];
  const activeUi = ui;
  ui.on('input', (event) => {
    if (event.target.matches('[data-value]')) safeRender(activeUi);
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-from], [data-to], [data-decimals], [data-scientific]')) safeRender(activeUi);
  });
  ui.on('click', async (event) => {
    const preset = event.target.closest('[data-preset]');
    if (preset) {
      const [, value, unit] = PRESETS[Number(preset.dataset.preset)];
      ui.query('[data-value]').value = String(value);
      ui.query('[data-from]').value = unit;
      safeRender(ui);
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'swap') {
      const from = ui.query('[data-from]');
      const to = ui.query('[data-to]');
      const previous = from.value;
      from.value = to.value;
      to.value = previous;
      safeRender(ui);
      return;
    }
    if (!lastRows.length) return;
    if (action === 'copy') await ui.copy(lastRows.map(({ unit, amount }) => `${unit.label}\t${format(amount)}`).join('\n'), 'Tableau copié.');
    if (action === 'download-csv') {
      const text = ['unité;valeur', ...lastRows.map(({ unit, amount }) => `${unit.id};${String(amount).replace('.', ',')}`)].join('\r\n');
      ui.download(`\uFEFF${text}`, 'conversion-unites-donnees.csv', 'text/csv;charset=utf-8');
    }
  });
  safeRender(ui);
}

export function unmount() {
  ui?.destroy();
  ui = null;
  lastRows = [];
}
