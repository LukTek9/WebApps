import { createWorkspace, setStats } from '../shared/dev-tool-kit.js';

let view;
const FILES = { csv: 'donnees.csv', xml: 'donnees.xml' };
const CONTROLS = '<label class="dev-tools__field">Format<select class="dev-tools__select" data-format><option value="csv">CSV</option><option value="xml">XML</option></select></label><label class="dev-tools__field">Séparateur CSV<select class="dev-tools__select" data-delimiter><option value=",">Virgule</option><option value=";">Point-virgule</option><option value="\\t">Tabulation</option></select></label>';

function csvCell(value, delimiter) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function update() {
  try {
    const rows = JSON.parse(view.source.value);
    if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) throw new Error('Entrez un tableau d’objets JSON.');
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const format = view.root.querySelector('[data-format]').value;
    const delimiterValue = view.root.querySelector('[data-delimiter]').value;
    const delimiter = delimiterValue === '\\t' ? '\t' : delimiterValue;
    const result = format === 'csv'
      ? [columns.map((key) => csvCell(key, delimiter)).join(delimiter), ...rows.map((row) => columns.map((key) => csvCell(row[key], delimiter)).join(delimiter))].join('\n')
      : `<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n${rows.map((row) => `  <row>\n${columns.map((key) => `    <${key.replace(/[^A-Za-z0-9_.-]/g, '_') || 'champ'}>${xmlEscape(row[key] == null ? '' : typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])}</${key.replace(/[^A-Za-z0-9_.-]/g, '_') || 'champ'}>`).join('\n')}\n  </row>`).join('\n')}\n</rows>`;
    view.output.textContent = result;
    view.status(`${rows.length} ligne${rows.length > 1 ? 's' : ''} convertie${rows.length > 1 ? 's' : ''}.`, 'success');
    setStats(view, [`${rows.length} lignes`, `${columns.length} colonnes`, `Sortie ${format.toUpperCase()}`]);
  } catch (error) {
    view.output.textContent = '';
    view.status(`Conversion impossible : ${error.message}`, 'error');
    setStats(view, ['Tableau JSON d’objets attendu']);
  }
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Convertisseur JSON vers CSV / XML', description: 'Transformez un tableau d’objets JSON, ajustez le séparateur et prévisualisez le fichier exporté.', sourceLabel: 'Tableau JSON', outputLabel: 'Conversion', sourcePlaceholder: '[{"nom":"Alice","ville":"Lyon"},{"nom":"Marc","ville":"Paris"}]', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) {
      const format = view.root.querySelector('[data-format]').value;
      view.download(view.output.textContent, FILES[format], format === 'csv' ? 'text/csv;charset=utf-8' : 'application/xml;charset=utf-8');
    }
  };
  view.root.addEventListener('input', view.onInput);
  view.root.addEventListener('change', view.onInput);
  view.root.addEventListener('click', view.onClick);
  update();
}

export function unmount() {
  if (!view) return;
  view.root.removeEventListener('input', view.onInput);
  view.root.removeEventListener('change', view.onInput);
  view.root.removeEventListener('click', view.onClick);
  view.dispose();
  view = null;
}
