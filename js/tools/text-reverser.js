let state;
const MODES = [
  ['characters', 'Inverser tous les caractères', (text) => Array.from(text).reverse().join('')],
  ['words', 'Inverser l’ordre des mots', (text) => text.split(/(\s+)/).reverse().join('')],
  ['each-word', 'Inverser chaque mot individuellement', (text) => text.replace(/\S+/g, (word) => Array.from(word).reverse().join(''))],
  ['lines', 'Inverser l’ordre des lignes', (text) => text.split(/\r\n|\r|\n/).reverse().join('\n')],
];
const TEMPLATE = `<section class="text-tools"><header class="text-tools__heading"><div><span class="text-tools__eyebrow">Transformations instantanées</span><h2>Inverseur de texte</h2><p>Chaque carte présente une inversion différente.</p></div></header><label class="tool-field">Votre texte<textarea class="tool-textarea" data-input rows="7" placeholder="Saisissez le texte à inverser…"></textarea></label><div class="text-tools__card-grid text-tools__reverse-grid" data-cards></div><p class="text-tools__status" data-status role="status" aria-live="polite"></p></section>`;
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function render() {
  const text = state.root.querySelector('[data-input]').value;
  state.root.querySelector('[data-cards]').innerHTML = MODES.map(([id, label, reverse]) => `<article class="text-tools__output-card"><div class="text-tools__card-head"><strong>${label}</strong><button class="btn-secondary text-tools__small-button" type="button" data-copy="${id}">Copier</button></div><output>${escapeHtml(reverse(text)) || '<span class="text-tools__empty">Résultat</span>'}</output></article>`).join('');
}
export function mount(container) {
  container.innerHTML = TEMPLATE; state = { root: container };
  state.onInput = (event) => { if (event.target.matches('[data-input]')) render(); };
  state.onClick = async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const mode = MODES.find(([id]) => id === button.dataset.copy);
    try { await navigator.clipboard.writeText(mode[2](state.root.querySelector('[data-input]').value)); state.root.querySelector('[data-status]').textContent = 'Texte copié.'; }
    catch { state.root.querySelector('[data-status]').textContent = 'Copie impossible dans ce navigateur.'; }
  };
  container.addEventListener('input', state.onInput); container.addEventListener('click', state.onClick); render();
}
export function unmount() {
  if (!state) return;
  state.root.removeEventListener('input', state.onInput); state.root.removeEventListener('click', state.onClick); state.root.innerHTML = ''; state = null;
}
