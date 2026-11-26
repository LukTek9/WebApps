let state;
const MODES = [
  ['az', 'Alphabétique A→Z'], ['za', 'Z→A'], ['numeric-up', 'Numérique croissant'],
  ['numeric-down', 'Numérique décroissant'], ['length', 'Par longueur courte→longue'],
  ['shuffle', 'Mélanger aléatoirement'], ['reverse', 'Inverser l’ordre'],
];
const TEMPLATE = `<section class="text-tools"><header class="text-tools__heading"><div><span class="text-tools__eyebrow">Réorganisation en direct</span><p>Une entrée par ligne, puis choisissez votre ordre de tri.</p></div><div class="tool-copy-bar"><button class="btn-secondary" type="button" data-action="copy">Copier</button><button class="btn" type="button" data-action="download">Télécharger .txt</button></div></header><div class="text-tools__toolbar" data-modes role="group" aria-label="Mode de tri"></div><div class="text-tools__controls"><label class="text-tools__check"><input type="checkbox" data-ignore-case checked> Comparer sans tenir compte de la casse</label><label class="text-tools__check"><input type="checkbox" data-ignore-empty checked> Ignorer les lignes vides</label></div><div class="tool-split"><label class="tool-field">Liste d’origine<textarea class="tool-textarea" data-input rows="16" placeholder="Pomme&#10;Banane&#10;Cerise"></textarea></label><label class="tool-field">Résultat<textarea class="tool-textarea" data-output rows="16" readonly></textarea></label></div><p class="text-tools__status" data-status role="status" aria-live="polite"></p></section>`;
function sort(items) {
  const mode = state.mode, insensitive = state.root.querySelector('[data-ignore-case]').checked;
  const compareText = (a, b) => insensitive ? a.localeCompare(b, 'fr', { sensitivity: 'base' }) : a.localeCompare(b, 'fr');
  if (mode === 'az') items.sort(compareText);
  if (mode === 'za') items.sort((a, b) => compareText(b, a));
  if (mode === 'numeric-up') items.sort((a, b) => (Number(a) - Number(b)) || compareText(a, b));
  if (mode === 'numeric-down') items.sort((a, b) => (Number(b) - Number(a)) || compareText(b, a));
  if (mode === 'length') items.sort((a, b) => Array.from(a).length - Array.from(b).length || compareText(a, b));
  if (mode === 'shuffle') for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  if (mode === 'reverse') items.reverse();
  return items;
}
function render() {
  const input = state.root.querySelector('[data-input]').value.split(/\r\n|\r|\n/);
  const items = state.root.querySelector('[data-ignore-empty]').checked ? input.filter((line) => line.trim()) : input;
  state.root.querySelector('[data-output]').value = sort(items).join('\n');
  state.root.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
  });
}
function save() {
  const url = URL.createObjectURL(new Blob([state.root.querySelector('[data-output]').value], { type: 'text/plain;charset=utf-8' }));
  state.urls.add(url); const a = document.createElement('a'); a.href = url; a.download = 'liste-triee.txt'; document.body.append(a); a.click(); a.remove();
  const timer = setTimeout(() => { URL.revokeObjectURL(url); state?.urls.delete(url); state?.timers.delete(timer); }, 1000); state.timers.add(timer);
}
export function mount(container) {
  container.innerHTML = TEMPLATE; state = { root: container, mode: 'az', urls: new Set(), timers: new Set() };
  state.root.querySelector('[data-modes]').innerHTML = MODES.map(([id, label]) => `<button class="btn-secondary" type="button" data-mode="${id}" aria-pressed="${id === state.mode}">${label}</button>`).join('');
  state.onChange = (event) => { if (event.target.matches('[data-input], [data-ignore-case], [data-ignore-empty]')) render(); };
  state.onClick = async (event) => {
    const mode = event.target.closest('[data-mode]');
    if (mode) { state.mode = mode.dataset.mode; render(); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'download') save();
    if (action === 'copy') {
      try { await navigator.clipboard.writeText(state.root.querySelector('[data-output]').value); state.root.querySelector('[data-status]').textContent = 'Liste copiée.'; }
      catch { state.root.querySelector('[data-status]').textContent = 'Copie impossible dans ce navigateur.'; }
    }
  };
  container.addEventListener('input', state.onChange); container.addEventListener('change', state.onChange); container.addEventListener('click', state.onClick); render();
}
export function unmount() {
  if (!state) return;
  state.root.removeEventListener('input', state.onChange); state.root.removeEventListener('change', state.onChange); state.root.removeEventListener('click', state.onClick);
  state.timers.forEach(clearTimeout); state.urls.forEach(URL.revokeObjectURL); state.root.innerHTML = ''; state = null;
}
