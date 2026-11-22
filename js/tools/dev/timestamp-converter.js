import { createWorkspace, setStats } from './tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field">Valeur source<select class="dev-tools__select" data-mode><option value="epoch">Timestamp Unix</option><option value="date">Date / ISO 8601</option></select></label><label class="dev-tools__field">Unité Unix<select class="dev-tools__select" data-unit><option value="s">Secondes</option><option value="ms">Millisecondes</option></select></label><label class="dev-tools__field">Affichage<select class="dev-tools__select" data-zone><option value="local">Heure locale</option><option value="utc">UTC</option></select></label>';

function update() {
  const source = view.source.value.trim();
  const mode = view.root.querySelector('[data-mode]').value;
  const unit = view.root.querySelector('[data-unit]').value;
  const zone = view.root.querySelector('[data-zone]').value;
  if (!source) {
    view.output.textContent = '';
    view.status('Saisissez un timestamp ou une date pour commencer.');
    setStats(view, ['Secondes et millisecondes', 'ISO 8601']);
    return;
  }
  const numeric = mode === 'epoch' ? Number(source) : NaN;
  const date = mode === 'epoch'
    ? Number.isFinite(numeric) ? new Date(numeric * (unit === 's' ? 1000 : 1)) : new Date(NaN)
    : new Date(source);
  if (!Number.isFinite(date.getTime())) {
    view.output.textContent = '';
    view.status(mode === 'epoch' ? 'Timestamp Unix invalide.' : 'Date invalide. Essayez un format ISO 8601.', 'error');
    setStats(view, ['Valeur impossible à convertir']);
    return;
  }
  const seconds = Math.floor(date.getTime() / 1000);
  const milliseconds = date.getTime();
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'full', timeStyle: 'long', timeZone: zone === 'utc' ? 'UTC' : undefined,
  });
  view.output.textContent = [
    `Date affichée : ${formatter.format(date)}`,
    `ISO 8601 : ${date.toISOString()}`,
    `Unix (secondes) : ${seconds}`,
    `Unix (millisecondes) : ${milliseconds}`,
  ].join('\n');
  view.status('Conversion terminée.', 'success');
  setStats(view, [`${seconds} s`, `${milliseconds} ms`, zone === 'utc' ? 'UTC' : 'Fuseau local']);
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Convertisseur de timestamps', description: 'Convertissez des timestamps Unix en dates lisibles et en ISO 8601, ou faites l’opération inverse.', sourceLabel: 'Timestamp ou date', outputLabel: 'Conversions', sourcePlaceholder: 'Ex. 1735689600 ou 2025-01-01T00:00:00Z', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, 'conversion-timestamp.txt');
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
