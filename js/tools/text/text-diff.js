let state;
const TEMPLATE = `
<section class="text-tools">
  <header class="text-tools__heading"><div><span class="text-tools__eyebrow">Comparaison en direct</span><p>Repérez immédiatement les ajouts et suppressions.</p></div></header>
  <div class="tool-split"><label class="tool-field">Texte original<textarea class="tool-textarea" data-original rows="9" placeholder="Texte de départ…"></textarea></label><label class="tool-field">Texte modifié<textarea class="tool-textarea" data-modified rows="9" placeholder="Texte modifié…"></textarea></label></div>
  <div class="text-tools__controls"><label class="tool-field">Mode de comparaison<select data-mode><option value="line">Ligne par ligne</option><option value="word">Mot par mot</option></select></label><label class="text-tools__check"><input type="checkbox" data-ignore-case> Ignorer la casse</label><label class="text-tools__check"><input type="checkbox" data-ignore-space> Ignorer les espaces</label></div>
  <div class="text-tools__summary"><span class="tool-badge" data-added>0 ajout</span><span class="tool-badge text-tools__badge--removed" data-removed>0 suppression</span></div>
  <section class="tool-panel"><h3>Résultat</h3><div class="tool-preview-box text-tools__diff" data-result aria-live="polite"></div></section>
</section>`;

function tokenize(text, mode) {
  if (mode === 'word') return text.match(/\s+|[^\s]+/g) || [];
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.map((line, index) => line + (index < lines.length - 1 ? '\n' : ''));
}

function diff(a, b, normalize) {
  const n = a.length, m = b.length;
  const lineNumbers = (tokens) => {
    let line = 0;
    return tokens.map((token) => {
      const current = line;
      line += (token.match(/\n/g) || []).length;
      return current;
    });
  };
  const linesA = lineNumbers(a), linesB = lineNumbers(b);
  if (n * m > 1500000) return [
    ...a.map((value, index) => ({ type: 'removed', value, line: linesA[index] })),
    ...b.map((value, index) => ({ type: 'added', value, line: linesB[index] })),
  ];
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = normalize(a[i]) === normalize(b[j]) ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (normalize(a[i]) === normalize(b[j])) { out.push({ type: 'same', value: b[j] }); i++; j++; }
    else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) { out.push({ type: 'removed', value: a[i], line: linesA[i] }); i++; }
    else { out.push({ type: 'added', value: b[j], line: linesB[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'removed', value: a[i], line: linesA[i] }); i++; }
  while (j < m) { out.push({ type: 'added', value: b[j], line: linesB[j] }); j++; }
  return out;
}

function escapeHtml(text) { return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function render() {
  const root = state.root;
  const original = root.querySelector('[data-original]').value;
  const modified = root.querySelector('[data-modified]').value;
  const ignoreCase = root.querySelector('[data-ignore-case]').checked;
  const ignoreSpace = root.querySelector('[data-ignore-space]').checked;
  const normalize = (s) => (ignoreSpace ? s.replace(/\s/g, '') : s);
  const pieces = diff(tokenize(original, root.querySelector('[data-mode]').value), tokenize(modified, root.querySelector('[data-mode]').value), (s) => ignoreCase ? normalize(s).toLocaleLowerCase() : normalize(s));
  const addedLines = new Set(), removedLines = new Set();
  const html = pieces.map(({ type, value, line }) => {
    if (type === 'added') addedLines.add(line);
    if (type === 'removed') removedLines.add(line);
    return `<span class="text-tools__diff-${type}">${escapeHtml(value)}</span>`;
  }).join('');
  root.querySelector('[data-result]').innerHTML = html || '<span class="text-tools__empty">Saisissez les deux versions pour commencer.</span>';
  root.querySelector('[data-added]').textContent = `${addedLines.size} ligne${addedLines.size === 1 ? '' : 's'} ajoutée${addedLines.size === 1 ? '' : 's'}`;
  root.querySelector('[data-removed]').textContent = `${removedLines.size} ligne${removedLines.size === 1 ? '' : 's'} supprimée${removedLines.size === 1 ? '' : 's'}`;
}
export function mount(container) {
  container.innerHTML = TEMPLATE;
  state = { root: container };
  state.onChange = (event) => { if (event.target.matches('[data-original], [data-modified], [data-mode], [data-ignore-case], [data-ignore-space]')) render(); };
  container.addEventListener('input', state.onChange); container.addEventListener('change', state.onChange); render();
}
export function unmount() {
  if (!state) return;
  state.root.removeEventListener('input', state.onChange); state.root.removeEventListener('change', state.onChange);
  state.root.innerHTML = ''; state = null;
}
