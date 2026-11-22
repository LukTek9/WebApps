import { createWorkspace, setStats } from '../shared/dev-tool-kit.js';

let view;
const FILE = 'json-formate.json';
const CONTROLS = '<label class="dev-tools__field">Format<select class="dev-tools__select" data-mode><option value="pretty">Lisible</option><option value="compact">Minifié</option></select></label><label class="dev-tools__check"><input type="checkbox" data-sort> Trier les clés par ordre alphabétique</label>';

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b, 'fr')).map((key) => [key, sortKeys(value[key])]));
  return value;
}

function update() {
  const source = view.source.value;
  try {
    const data = JSON.parse(source);
    const ordered = view.root.querySelector('[data-sort]').checked ? sortKeys(data) : data;
    const compact = view.root.querySelector('[data-mode]').value === 'compact';
    view.output.textContent = JSON.stringify(ordered, null, compact ? 0 : 2);
    view.status('JSON valide.', 'success');
    setStats(view, [`${source.length} caractères`, `${view.output.textContent.length} caractères en sortie`, Array.isArray(data) ? `${data.length} éléments` : 'JSON valide']);
  } catch (error) {
    view.output.textContent = '';
    view.status(`JSON invalide : ${error.message}`, 'error');
    setStats(view, [`${source.length} caractères`, 'En attente d’un JSON valide']);
  }
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Formateur JSON', description: 'Validez, indentez, triez et exportez vos données JSON sans quitter votre navigateur.', sourceLabel: 'JSON source', outputLabel: 'JSON formaté', sourcePlaceholder: '{"nom":"Alice","outils":["éditeur","terminal"]}', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, FILE, 'application/json;charset=utf-8');
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
