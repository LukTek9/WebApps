import { createWorkspace, setStats } from './tool-kit.js';

let view;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const CONTROLS = '<label class="dev-tools__check"><input type="checkbox" data-preview checked> Afficher l’aperçu isolé</label>';

function inspect(source) {
  const issues = [];
  const stack = [];
  const tokens = source.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>/g) || [];
  for (const token of tokens) {
    if (/^<!--/.test(token) || /^<!/i.test(token)) continue;
    const closing = /^<\//.test(token);
    const name = token.match(/^<\/?\s*([A-Za-z][\w:-]*)/)[1].toLowerCase();
    if (closing) {
      if (stack[stack.length - 1] === name) stack.pop();
      else if (stack.includes(name)) {
        issues.push(`Balise </${name}> fermée dans le mauvais ordre.`);
        stack.splice(stack.lastIndexOf(name), 1);
      } else issues.push(`Balise </${name}> sans ouverture correspondante.`);
    } else if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(token)) stack.push(name);
    if (name === 'img' && !/\balt\s*=/i.test(token)) issues.push('Image sans attribut alt détectée.');
    if (name === 'a' && !/\bhref\s*=/i.test(token)) issues.push('Lien <a> sans attribut href détecté.');
  }
  for (const name of stack.reverse()) issues.push(`Balise <${name}> non refermée.`);
  const doc = new DOMParser().parseFromString(source, 'text/html');
  if (doc.documentElement && !doc.documentElement.lang) issues.push('Attribut lang absent sur <html>.');
  if (!doc.title.trim()) issues.push('Titre de document <title> absent ou vide.');
  const ids = new Set();
  for (const element of doc.querySelectorAll('[id]')) {
    if (ids.has(element.id)) issues.push(`Identifiant dupliqué : "${element.id}".`);
    ids.add(element.id);
  }
  return [...new Set(issues)];
}

function update() {
  const source = view.source.value;
  const issues = inspect(source);
  view.output.textContent = issues.length ? issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n') : 'Aucun problème courant détecté.';
  view.status(issues.length ? `${issues.length} point${issues.length > 1 ? 's' : ''} à vérifier.` : 'Aucun problème courant détecté.', issues.length ? 'error' : 'success');
  setStats(view, [`${issues.length} alertes`, `${source.length} caractères`, 'Contrôles structurels et courants']);
  const enabled = view.root.querySelector('[data-preview]').checked;
  preview.hidden = !enabled;
  if (enabled) {
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:; navigate-to \'none\';">';
    preview.srcdoc = `<!doctype html><html><head>${policy}</head><body>${source}</body></html>`;
  } else preview.srcdoc = '';
}

let preview;

export function mount(container) {
  view = createWorkspace(container, { title: 'Vérificateur HTML', description: 'Repérez des erreurs de fermeture, des attributs manquants et des identifiants dupliqués ; visualisez le HTML dans un aperçu isolé.', sourceLabel: 'Fragment ou document HTML', outputLabel: 'Rapport', sourcePlaceholder: '<!doctype html>\\n<html lang="fr">\\n  <head><title>Ma page</title></head>\\n  <body><h1>Bonjour</h1></body>\\n</html>', controls: CONTROLS });
  const previewPanel = document.createElement('section');
  previewPanel.className = 'dev-tools__panel dev-tools__preview-panel';
  previewPanel.innerHTML = '<div class="dev-tools__panel-head"><strong>Aperçu HTML isolé</strong><span>Ressources externes bloquées</span></div>';
  preview = document.createElement('iframe');
  preview.className = 'dev-tools__iframe';
  preview.title = 'Aperçu HTML isolé';
  preview.setAttribute('sandbox', '');
  previewPanel.append(preview);
  view.root.append(previewPanel);
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download') view.download(view.output.textContent, 'rapport-html.txt');
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
  preview = null;
  view = null;
}
