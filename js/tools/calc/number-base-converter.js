import { createSecurityUI } from '../shared/security-tool-ui.js';
import { bindResultActions, updateResult } from '../shared/calculation-utils.js';

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE_NAMES = { 2: 'binaire', 8: 'octal', 10: 'décimal', 16: 'hexadécimal' };
const baseName = (base) => BASE_NAMES[base] || `base ${base}`;
const baseOptions = Array.from({ length: 35 }, (_, index) => {
  const base = index + 2;
  return `<option value="${base}">Base ${base} · ${baseName(base)}</option>`;
}).join('');

let ui;
let report = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Nombre à convertir
        <input data-value type="text" value="1010" spellcheck="false" autocomplete="off" aria-describedby="base-hint">
      </label>
      <div class="security-tools__controls">
        <label class="security-tools__field">Base d’entrée<select data-from>${baseOptions}</select></label>
        <label class="security-tools__field">Base de sortie<select data-to>${baseOptions}</select></label>
      </div>
      <p class="security-tools__hint" id="base-hint">Utilisez les chiffres 0–9 puis les lettres A–Z pour les bases supérieures à 10. Les préfixes 0b, 0o et 0x correspondants sont facultatifs.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Conversion exacte</h3><p>La représentation interne utilise les entiers BigInt; aucune précision n’est perdue.</p></div></div>
      <output class="calc-tools__answer" data-answer>—</output>
      <div class="security-tools__stats" data-stats></div>
      <pre class="security-tools__result" data-output></pre>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier les bases</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger les bases</button>
      </div>
    </section>
  </div>`;

function parseInteger(source, base) {
  let text = source.trim().replace(/[\s_]/g, '').toLowerCase();
  let sign = 1n;
  if (text.startsWith('-')) { sign = -1n; text = text.slice(1); }
  else if (text.startsWith('+')) text = text.slice(1);
  const prefixes = { 2: '0b', 8: '0o', 16: '0x' };
  if (prefixes[base] && text.startsWith(prefixes[base])) text = text.slice(2);
  if (!text) throw new Error('Saisissez un nombre entier à convertir.');
  if (text.length > 4096) throw new Error('Limite de 4 096 chiffres dépassée.');
  let value = 0n;
  for (let index = 0; index < text.length; index += 1) {
    const digit = DIGITS.indexOf(text[index]);
    if (digit < 0 || digit >= base) throw new Error(`Chiffre « ${text[index].toUpperCase()} » invalide en base ${base}, position ${index + 1}.`);
    value = value * BigInt(base) + BigInt(digit);
  }
  return sign * value;
}

function update() {
  try {
    const input = ui.query('[data-value]').value;
    const from = Number(ui.query('[data-from]').value);
    const to = Number(ui.query('[data-to]').value);
    const value = parseInteger(input, from);
    const converted = value.toString(to).toUpperCase();
    const representations = [2, 8, 10, 16].map((base) => `${baseName(base)} (base ${base}) : ${value.toString(base).toUpperCase()}`);
    report = `Entrée : ${input.trim()} (base ${from})\nSortie : ${converted} (base ${to})\n\n${representations.join('\n')}`;
    ui.query('[data-answer]').textContent = converted;
    updateResult(ui, report, [
      ['Base d’entrée', `${from} · ${baseName(from)}`],
      ['Base de sortie', `${to} · ${baseName(to)}`],
      ['Chiffres du résultat', converted.replace(/^-/, '').length],
    ]);
    ui.setStatus('Conversion exacte calculée localement.', 'success');
  } catch (error) {
    report = '';
    ui.query('[data-answer]').textContent = '—';
    updateResult(ui, '', []);
    ui.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Convertisseur de bases',
    description: 'Convertissez des entiers entre les bases 2 à 36 sans perte de précision, y compris les très grands nombres.',
    content: CONTENT,
  });
  report = '';
  ui.query('[data-from]').value = '2';
  ui.query('[data-to]').value = '10';
  ui.on('input', (event) => {
    if (event.target.matches('[data-value]')) update();
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-from], [data-to]')) update();
  });
  bindResultActions(ui, () => report, () => ({ content: report, filename: 'conversion-bases.txt', mime: 'text/plain;charset=utf-8' }), 'Conversion copiée.');
  update();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
}
