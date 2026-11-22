import { createWorkspace, setStats } from './tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field">Contenu<select class="dev-tools__select" data-kind><option value="url-component">Composant URL</option><option value="url-full">URL complète</option><option value="html">Entités HTML</option></select></label><label class="dev-tools__field">Opération<select class="dev-tools__select" data-mode><option value="encode">Encoder</option><option value="decode">Décoder</option></select></label>';

function encodeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function decodeHtml(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function update() {
  const source = view.source.value;
  const kind = view.root.querySelector('[data-kind]').value;
  const mode = view.root.querySelector('[data-mode]').value;
  try {
    let result;
    if (kind === 'html') result = mode === 'encode' ? encodeHtml(source) : decodeHtml(source);
    else if (mode === 'encode') result = kind === 'url-full' ? encodeURI(source) : encodeURIComponent(source);
    else result = kind === 'url-full' ? decodeURI(source) : decodeURIComponent(source);
    view.output.textContent = result;
    view.status(mode === 'encode' ? 'Encodage terminé.' : 'Décodage terminé.', 'success');
    setStats(view, [`${source.length} caractères en entrée`, `${result.length} caractères en sortie`, kind === 'html' ? 'Entités HTML' : kind === 'url-full' ? 'URL complète' : 'Composant URL']);
  } catch (error) {
    view.output.textContent = '';
    view.status(`Décodage impossible : ${error.message}`, 'error');
    setStats(view, ['Séquence encodée invalide']);
  }
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Encodeur URL / HTML', description: 'Encodez et décodez du texte, des composants d’URL ou des entités HTML avec aperçu immédiat.', sourceLabel: 'Texte source', outputLabel: 'Texte transformé', sourcePlaceholder: 'Saisissez un texte, une URL ou des entités HTML…', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, 'texte-converti.txt');
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
