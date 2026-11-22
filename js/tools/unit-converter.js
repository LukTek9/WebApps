import { createSecurityUI, escapeHtml } from './shared/security-tool-ui.js';
import { bindResultActions, formatNumber, parseNumber, updateResult } from './shared/calculation-utils.js';

const GROUPS = {
  length: { label: 'Longueur', units: [['mm', 'Millimètre', 0.001], ['cm', 'Centimètre', 0.01], ['m', 'Mètre', 1], ['km', 'Kilomètre', 1000], ['in', 'Pouce', 0.0254], ['ft', 'Pied', 0.3048], ['mi', 'Mile', 1609.344]], from: 'm', to: 'km' },
  mass: { label: 'Masse', units: [['mg', 'Milligramme', 0.001], ['g', 'Gramme', 1], ['kg', 'Kilogramme', 1000], ['t', 'Tonne', 1000000], ['oz', 'Once', 28.349523125], ['lb', 'Livre', 453.59237]], from: 'kg', to: 'lb' },
  temperature: { label: 'Température', units: [['C', 'Celsius (°C)'], ['F', 'Fahrenheit (°F)'], ['K', 'Kelvin (K)']], from: 'C', to: 'F' },
  volume: { label: 'Volume', units: [['ml', 'Millilitre', 0.001], ['L', 'Litre', 1], ['m3', 'Mètre cube', 1000], ['gal', 'Gallon US', 3.785411784]], from: 'L', to: 'ml' },
  area: { label: 'Surface', units: [['cm2', 'Centimètre carré', 0.0001], ['m2', 'Mètre carré', 1], ['ha', 'Hectare', 10000], ['km2', 'Kilomètre carré', 1000000], ['ft2', 'Pied carré', 0.09290304], ['acre', 'Acre', 4046.8564224]], from: 'm2', to: 'ha' },
  speed: { label: 'Vitesse', units: [['ms', 'Mètre par seconde', 1], ['kmh', 'Kilomètre par heure', 1 / 3.6], ['mph', 'Mile par heure', 0.44704], ['knot', 'Nœud', 0.514444]], from: 'kmh', to: 'ms' },
};

let ui;
let report = '';
let filename = 'conversion-unites.txt';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Grandeur
          <select data-group>${Object.entries(GROUPS).map(([id, group]) => `<option value="${id}">${group.label}</option>`).join('')}</select>
        </label>
        <label class="security-tools__field">Valeur
          <input data-value type="text" inputmode="decimal" value="1" autocomplete="off">
        </label>
        <label class="security-tools__field">De
          <select data-from></select>
        </label>
        <label class="security-tools__field">Vers
          <select data-to></select>
        </label>
      </div>
      <p class="security-tools__hint">Les unités sont converties avec leurs facteurs standards; la température utilise les transformations Celsius/Fahrenheit/Kelvin.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Conversion en direct</h3><p>Le calcul se met à jour à chaque modification.</p></div></div>
      <output class="calc-tools__answer" data-answer>—</output>
      <div class="security-tools__stats" data-stats></div>
      <div class="calc-tools__equivalents" data-equivalents></div>
      <pre class="security-tools__result" data-output></pre>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier la conversion</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger le résultat</button>
      </div>
    </section>
  </div>`;

function unitOptions(groupId) {
  return GROUPS[groupId].units.map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join('');
}

function baseValue(value, unit, groupId) {
  if (groupId !== 'temperature') return value * GROUPS[groupId].units.find(([id]) => id === unit)[2];
  if (unit === 'F') return (value - 32) * 5 / 9;
  if (unit === 'K') return value - 273.15;
  return value;
}

function fromBase(value, unit, groupId) {
  if (groupId !== 'temperature') return value / GROUPS[groupId].units.find(([id]) => id === unit)[2];
  if (unit === 'F') return value * 9 / 5 + 32;
  if (unit === 'K') return value + 273.15;
  return value;
}

function update() {
  try {
    const groupId = ui.query('[data-group]').value;
    const group = GROUPS[groupId];
    const amount = parseNumber(ui.query('[data-value]').value, 'une valeur');
    const from = ui.query('[data-from]').value;
    const to = ui.query('[data-to]').value;
    const base = baseValue(amount, from, groupId);
    if (groupId === 'temperature' && base < -273.15 - 1e-10) {
      throw new Error('Une température ne peut pas être inférieure au zéro absolu.');
    }
    const result = fromBase(base, to, groupId);
    if (!Number.isFinite(result)) throw new Error('Le résultat dépasse la plage numérique prise en charge.');
    const sourceUnit = group.units.find(([id]) => id === from)[1];
    const targetUnit = group.units.find(([id]) => id === to)[1];
    const symbol = groupId === 'temperature' ? ` ${from === 'C' ? '°C' : from === 'F' ? '°F' : 'K'}` : ` ${from}`;
    const targetSymbol = groupId === 'temperature' ? ` ${to === 'C' ? '°C' : to === 'F' ? '°F' : 'K'}` : ` ${to}`;
    const valueText = `${formatNumber(amount)}${symbol} = ${formatNumber(result)}${targetSymbol}`;
    report = `${group.label}\n${valueText}\n${sourceUnit} → ${targetUnit}`;
    ui.query('[data-answer]').textContent = valueText;
    const equivalents = group.units.map(([id, label]) => {
      const equivalent = fromBase(base, id, groupId);
      return `<article class="calc-tools__equivalent"><span>${escapeHtml(label)}</span><strong>${formatNumber(equivalent)} ${escapeHtml(id === 'C' ? '°C' : id === 'F' ? '°F' : id === 'K' ? 'K' : id)}</strong></article>`;
    }).join('');
    ui.query('[data-equivalents]').innerHTML = equivalents;
    updateResult(ui, report, [['Grandeur', group.label], ['Valeur de départ', `${formatNumber(amount)}${symbol}`], ['Unité d’arrivée', targetUnit]]);
    ui.setStatus('Conversion calculée localement.', 'success');
  } catch (error) {
    report = '';
    ui.query('[data-answer]').textContent = '—';
    ui.query('[data-equivalents]').innerHTML = '';
    updateResult(ui, '', []);
    ui.setStatus(error.message, 'error');
  }
}

function updateUnitSelects() {
  const groupId = ui.query('[data-group]').value;
  const group = GROUPS[groupId];
  ui.query('[data-from]').innerHTML = unitOptions(groupId);
  ui.query('[data-to]').innerHTML = unitOptions(groupId);
  ui.query('[data-from]').value = group.from;
  ui.query('[data-to]').value = group.to;
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Convertisseur d’unités',
    description: 'Convertissez longueur, masse, température, volume, surface et vitesse avec un aperçu de toutes les unités disponibles.',
    content: CONTENT,
  });
  report = '';
  filename = 'conversion-unites.txt';
  updateUnitSelects();
  ui.on('input', (event) => {
    if (event.target.matches('[data-value]')) update();
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-group]')) updateUnitSelects();
    if (event.target.matches('[data-group], [data-from], [data-to]')) update();
  });
  bindResultActions(ui, () => report, () => ({ content: report, filename, mime: 'text/plain;charset=utf-8' }), 'Conversion copiée.');
  update();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
  filename = 'conversion-unites.txt';
}
