let state;
const CASES = [
  ['upper', 'MAJUSCULES', (s) => s.toLocaleUpperCase('fr')],
  ['lower', 'minuscules', (s) => s.toLocaleLowerCase('fr')],
  ['title', 'Titre / Title Case', (s) => s.toLocaleLowerCase('fr').replace(/(^|[\s'’\-])(\p{L})/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase('fr'))],
  ['sentence', 'Phrase', (s) => s.toLocaleLowerCase('fr').replace(/(^\s*\p{L}|[.!?]\s+\p{L})/gu, (m) => m.toLocaleUpperCase('fr'))],
  ['camel', 'camelCase', (s) => words(s).map((w, i) => i ? capitalize(w) : w.toLocaleLowerCase('fr')).join('')],
  ['pascal', 'PascalCase', (s) => words(s).map(capitalize).join('')],
  ['snake', 'snake_case', (s) => words(s).map((w) => w.toLocaleLowerCase('fr')).join('_')],
  ['kebab', 'kebab-case', (s) => words(s).map((w) => w.toLocaleLowerCase('fr')).join('-')],
  ['constant', 'CONSTANT_CASE', (s) => words(s).map((w) => w.toLocaleUpperCase('fr')).join('_')],
];
const TEMPLATE = `<section class="text-tools"><header class="text-tools__heading"><div><span class="text-tools__eyebrow">9 formats instantanés</span><p>Écrivez une fois, copiez le format dont vous avez besoin.</p></div></header><label class="tool-field">Votre texte<textarea class="tool-textarea" data-input rows="6" placeholder="Saisissez ou collez votre texte…"></textarea></label><div class="text-tools__card-grid" data-cards></div><p class="text-tools__status" data-status role="status" aria-live="polite"></p></section>`;
function words(s) { return s.trim().match(/[\p{L}\p{N}]+/gu) || []; }
function capitalize(s) { return s ? s[0].toLocaleUpperCase('fr') + s.slice(1).toLocaleLowerCase('fr') : ''; }
function escapeHtml(text) { return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function render() {
  const value = state.root.querySelector('[data-input]').value;
  state.root.querySelector('[data-cards]').innerHTML = CASES.map(([id, label, convert]) => `<article class="text-tools__output-card"><div class="text-tools__card-head"><strong>${label}</strong><button class="btn-secondary text-tools__small-button" type="button" data-copy="${id}" aria-label="Copier ${label}">Copier</button></div><output>${escapeHtml(convert(value)) || '<span class="text-tools__empty">Résultat</span>'}</output></article>`).join('');
}
export function mount(container) {
  container.innerHTML = TEMPLATE; state = { root: container };
  state.onInput = (event) => { if (event.target.matches('[data-input]')) render(); };
  state.onClick = async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const entry = CASES.find(([id]) => id === button.dataset.copy);
    try { await navigator.clipboard.writeText(entry[2](state.root.querySelector('[data-input]').value)); state.root.querySelector('[data-status]').textContent = `${entry[1]} copié.`; }
    catch { state.root.querySelector('[data-status]').textContent = 'Copie impossible dans ce navigateur.'; }
  };
  container.addEventListener('input', state.onInput); container.addEventListener('click', state.onClick); render();
}
export function unmount() {
  if (!state) return;
  state.root.removeEventListener('input', state.onInput); state.root.removeEventListener('click', state.onClick);
  state.root.innerHTML = ''; state = null;
}
