import { createWorkspace, setStats } from '../shared/dev-tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field">Langage<select class="dev-tools__select" data-kind><option value="css">CSS</option><option value="js">JavaScript</option></select></label>';

function stripComments(source, kind) {
  let result = '', quote = '', lineComment = false, blockComment = false, escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index], next = source[index + 1];
    if (lineComment) { if (char === '\n' || char === '\r') { lineComment = false; result += char; } continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; result += ' '; } continue; }
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || (kind === 'js' && char === '`')) { quote = char; result += char; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (kind === 'js' && char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    result += char;
  }
  return result;
}

function minify(source, kind) {
  const withoutComments = stripComments(source, kind);
  if (kind === 'css') {
    return withoutComments
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>+~])\s*/g, '$1')
      .replace(/;}/g, '}')
      .trim();
  }
  let result = '', quote = '', escaped = false, whitespace = false;
  for (const char of withoutComments) {
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      if (whitespace && /[\w$]/.test(result.slice(-1) || '') && /[\w$]/.test(char)) result += ' ';
      whitespace = false; quote = char; result += char; continue;
    }
    if (/\s/.test(char)) { whitespace = true; continue; }
    if (whitespace && /[\w$]/.test(result.slice(-1) || '') && /[\w$]/.test(char)) result += ' ';
    whitespace = false;
    result += char;
  }
  return result.trim();
}

function update() {
  const source = view.source.value;
  const kind = view.root.querySelector('[data-kind]').value;
  const output = minify(source, kind);
  view.output.textContent = output;
  const saved = source.length ? Math.max(0, Math.round((1 - output.length / source.length) * 100)) : 0;
  view.status('Minification basique effectuée ; vérifiez le résultat dans votre projet avant publication.', 'success');
  setStats(view, [`Avant : ${source.length} caractères`, `Après : ${output.length} caractères`, `Réduction : ${saved} %`, kind.toUpperCase()]);
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Minificateur CSS / JavaScript', description: 'Supprimez commentaires et espaces superflus, mesurez la réduction et exportez votre code. Le traitement reste local.', sourceLabel: 'Code source', outputLabel: 'Code minifié', sourcePlaceholder: 'Collez votre CSS ou JavaScript…', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const extension = view.root.querySelector('[data-kind]').value;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, `code.min.${extension}`, extension === 'css' ? 'text/css;charset=utf-8' : 'text/javascript;charset=utf-8');
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
