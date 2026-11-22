import { createWorkspace, setStats } from './tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field">Langage<select class="dev-tools__select" data-kind><option value="html">HTML</option><option value="xml">XML</option><option value="sql">SQL</option></select></label><label class="dev-tools__field">Indentation<select class="dev-tools__select" data-indent><option value="2">2 espaces</option><option value="4">4 espaces</option><option value="tab">Tabulation</option></select></label>';
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const CLAUSES = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'SET', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'UNION', 'RETURNING']);

function formatMarkup(source, indent) {
  const tokens = source.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g) || [];
  const lines = [];
  let depth = 0;
  for (const token of tokens) {
    const value = token.trim();
    if (!value) continue;
    const closing = /^<\//.test(value);
    const name = value.match(/^<\/?\s*([\w:-]+)/)?.[1]?.toLowerCase();
    if (closing) depth = Math.max(0, depth - 1);
    lines.push(`${indent.repeat(depth)}${value}`);
    if (name && !closing && !VOID_TAGS.has(name) && !/\/\s*>$/.test(value) && !/^<!/.test(value) && !/^<\?/.test(value)) depth += 1;
  }
  return lines.join('\n');
}

function formatSql(source, indent) {
  let normalized = '', word = '', quote = '', escaped = false, depth = 0;
  const flush = () => {
    if (!word) return;
    const upper = word.toUpperCase();
    if (CLAUSES.has(upper)) {
      if (normalized.trim()) normalized = `${normalized.trimEnd()}\n${indent.repeat(depth)}`;
      normalized += upper === 'GROUP' || upper === 'ORDER' ? `${upper} ` : `${upper} `;
    } else normalized += word;
    word = '';
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote && source[index + 1] !== quote) quote = '';
      else if (char === quote && source[index + 1] === quote) normalized += source[++index];
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { flush(); quote = char; normalized += char; continue; }
    if (/\s/.test(char)) { flush(); if (normalized && !normalized.endsWith(' ') && !normalized.endsWith('\n')) normalized += ' '; continue; }
    if (char === ',') { flush(); normalized = `${normalized.trimEnd()},\n${indent.repeat(depth + (depth ? 1 : 0))}`; continue; }
    if (char === '(') { flush(); normalized = `${normalized.trimEnd()} (`; depth += 1; normalized += '\n' + indent.repeat(depth); continue; }
    if (char === ')') { flush(); depth = Math.max(0, depth - 1); normalized = `${normalized.trimEnd()}\n${indent.repeat(depth)})`; continue; }
    if (char === ';') { flush(); normalized = `${normalized.trimEnd()};\n`; continue; }
    word += char;
  }
  flush();
  return normalized.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).join('\n');
}

function update() {
  const kind = view.root.querySelector('[data-kind]').value;
  const spacing = view.root.querySelector('[data-indent]').value;
  const indent = spacing === 'tab' ? '\t' : ' '.repeat(Number(spacing));
  const source = view.source.value;
  const result = kind === 'sql' ? formatSql(source, indent) : formatMarkup(source, indent);
  view.output.textContent = result;
  view.status('Mise en forme terminée ; vérifiez la structure et la syntaxe dans votre outil de développement.', 'success');
  setStats(view, [`${source.length} caractères en entrée`, `${result.length} caractères en sortie`, kind.toUpperCase(), `Indentation : ${spacing === 'tab' ? 'tabulation' : `${spacing} espaces`}`]);
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Formateur SQL / HTML / XML', description: 'Rendez vos requêtes ou balises plus lisibles avec une indentation réglable et un résultat exportable.', sourceLabel: 'Code à formater', outputLabel: 'Code indenté', sourcePlaceholder: 'Collez une requête SQL ou du HTML / XML…', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const kind = view.root.querySelector('[data-kind]').value;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, `code-formate.${kind === 'sql' ? 'sql' : kind}`);
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
