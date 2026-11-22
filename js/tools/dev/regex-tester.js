import { createWorkspace, setStats } from '../shared/dev-tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field dev-tools__field--grow">Expression régulière<input class="dev-tools__input" data-pattern value="(\\w+)" placeholder="Votre motif, sans délimiteurs"></label><label class="dev-tools__field">Drapeaux<input class="dev-tools__input" data-flags value="gi" aria-label="Drapeaux de l’expression régulière"></label><label class="dev-tools__field">Action<select class="dev-tools__select" data-mode><option value="matches">Afficher les correspondances</option><option value="replace">Remplacer</option></select></label><label class="dev-tools__field dev-tools__field--grow">Remplacement<input class="dev-tools__input" data-replacement placeholder="$1"></label>';

function update() {
  const source = view.source.value;
  try {
    const pattern = view.root.querySelector('[data-pattern]').value;
    const flags = view.root.querySelector('[data-flags]').value;
    const expression = new RegExp(pattern, flags);
    const matches = [...source.matchAll(new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : `${expression.flags}g`))];
    const replacement = view.root.querySelector('[data-replacement]').value;
    const replacing = view.root.querySelector('[data-mode]').value === 'replace';
    view.output.textContent = replacing
      ? source.replace(expression, replacement)
      : matches.map((match, index) => `${index + 1}. ${match[0]}${match.length > 1 ? ` — groupes : ${match.slice(1).join(' | ')}` : ''} (index ${match.index})`).join('\n');
    if (!matches.length && !replacing) view.output.textContent = 'Aucune correspondance.';
    view.status(`${matches.length} correspondance${matches.length > 1 ? 's' : ''} trouvée${matches.length > 1 ? 's' : ''}.`, 'success');
    setStats(view, [`${matches.length} correspondances`, `${new Set(flags).size} drapeaux`, replacing ? 'Mode remplacement' : 'Mode correspondances']);
  } catch (error) {
    view.output.textContent = '';
    view.status(`Expression régulière invalide : ${error.message}`, 'error');
    setStats(view, ['Vérifiez le motif et les drapeaux']);
  }
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Testeur d’expressions régulières', description: 'Testez motifs, drapeaux, groupes capturés et remplacements sur un texte sans envoyer de données.', sourceLabel: 'Texte à tester', outputLabel: 'Correspondances et groupes', sourcePlaceholder: 'Collez ou saisissez un texte à analyser…', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, 'resultats-regex.txt');
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
