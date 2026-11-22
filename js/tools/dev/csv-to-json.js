import { createWorkspace, setStats } from '../shared/dev-tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field">Séparateur<select class="dev-tools__select" data-delimiter><option value=",">Virgule</option><option value=";">Point-virgule</option><option value="\\t">Tabulation</option></select></label><label class="dev-tools__check"><input type="checkbox" data-header checked> Première ligne = en-têtes</label><label class="dev-tools__check"><input type="checkbox" data-infer checked> Déduire nombres et booléens</label>';

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('Une cellule entre guillemets n’est pas terminée.');
  if (cell || row.length || text.endsWith(delimiter)) { row.push(cell); rows.push(row); }
  return rows.filter((values) => values.some((value) => value !== ''));
}

function infer(value, enabled) {
  if (!enabled || value === '') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function update() {
  try {
    const value = view.root.querySelector('[data-delimiter]').value;
    const delimiter = value === '\\t' ? '\t' : value;
    const rows = parseCsv(view.source.value, delimiter);
    const hasHeader = view.root.querySelector('[data-header]').checked;
    const convert = view.root.querySelector('[data-infer]').checked;
    const headers = hasHeader ? (rows.shift() || []).map((name, index) => name.trim() || `colonne_${index + 1}`) : [];
    const data = rows.map((row) => {
      const values = row.map((cell) => infer(cell, convert));
      if (!hasHeader) return values;
      return Object.fromEntries(headers.map((name, index) => [name, values[index] ?? '']));
    });
    view.output.textContent = JSON.stringify(data, null, 2);
    view.status(`${data.length} ligne${data.length > 1 ? 's' : ''} convertie${data.length > 1 ? 's' : ''}.`, 'success');
    setStats(view, [`${data.length} lignes`, `${headers.length || (rows[0] || []).length} colonnes`, hasHeader ? 'Objets JSON' : 'Tableau de tableaux']);
  } catch (error) {
    view.output.textContent = '';
    view.status(`CSV invalide : ${error.message}`, 'error');
    setStats(view, ['Vérifiez les guillemets et le séparateur']);
  }
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Convertisseur CSV vers JSON', description: 'Importez des valeurs tabulaires, choisissez les en-têtes et les types, puis récupérez un JSON prêt à l’emploi.', sourceLabel: 'Données CSV', outputLabel: 'JSON', sourcePlaceholder: 'nom,actif,score\nAlice,true,12\nMarc,false,8', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, 'donnees.json', 'application/json;charset=utf-8');
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
