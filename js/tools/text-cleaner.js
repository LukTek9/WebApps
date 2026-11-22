let state;
const OPTIONS = [['accent', 'Supprimer les accents'], ['html', 'Supprimer les balises HTML'], ['spaces', 'Réduire les espaces multiples'], ['lines', 'Supprimer les sauts de ligne'], ['punctuation', 'Supprimer la ponctuation'], ['digits', 'Supprimer les chiffres']];
const TEMPLATE = `<section class="text-tools"><header class="text-tools__heading"><div><span class="text-tools__eyebrow">Prévisualisation instantanée</span><h2>Nettoyeur de texte</h2><p>Activez uniquement les transformations souhaitées.</p></div><div class="tool-copy-bar"><button class="btn-secondary" type="button" data-action="copy">Copier</button><button class="btn" type="button" data-action="download">Télécharger .txt</button></div></header><div class="text-tools__switches" data-switches></div><div class="text-tools__summary"><span class="tool-badge" data-delta>0 caractère modifié</span></div><div class="tool-split"><label class="tool-field">Texte d’origine<textarea class="tool-textarea" data-input rows="12" placeholder="Collez votre texte…"></textarea></label><label class="tool-field">Aperçu nettoyé<textarea class="tool-textarea" data-output rows="12" readonly></textarea></label></div><p class="text-tools__status" data-status role="status" aria-live="polite"></p></section>`;
function clean(text) {
  const enabled = (name) => state.root.querySelector(`[data-opt="${name}"]`).checked;
  let result = text;
  if (enabled('html')) result = result.replace(/<[^>]*>/g, ' ');
  if (enabled('accent')) result = result.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (enabled('spaces')) result = result.replace(/[^\S\r\n]+/g, ' ').replace(/ {2,}/g, ' ');
  if (enabled('lines')) result = result.replace(/\s*[\r\n]+\s*/g, ' ');
  if (enabled('punctuation')) result = result.replace(/[^\p{L}\p{N}\s]/gu, '');
  if (enabled('digits')) result = result.replace(/\p{N}/gu, '');
  return result;
}
function render() {
  const input = state.root.querySelector('[data-input]').value, output = clean(input);
  state.root.querySelector('[data-output]').value = output;
  const delta = input.length - output.length;
  state.root.querySelector('[data-delta]').textContent = `${Math.abs(delta)} caractère${Math.abs(delta) === 1 ? '' : 's'} ${delta >= 0 ? 'supprimé' : 'ajouté'}${Math.abs(delta) === 1 ? '' : 's'}`;
}
function save() {
  const url = URL.createObjectURL(new Blob([state.root.querySelector('[data-output]').value], { type: 'text/plain;charset=utf-8' }));
  state.urls.add(url); const a = document.createElement('a'); a.href = url; a.download = 'texte-nettoye.txt'; document.body.append(a); a.click(); a.remove();
  const timer = setTimeout(() => { URL.revokeObjectURL(url); state?.urls.delete(url); state?.timers.delete(timer); }, 1000); state.timers.add(timer);
}
export function mount(container) {
  container.innerHTML = TEMPLATE; state = { root: container, urls: new Set(), timers: new Set() };
  state.root.querySelector('[data-switches]').innerHTML = OPTIONS.map(([id, label]) => `<label class="text-tools__switch"><input type="checkbox" data-opt="${id}"><span class="text-tools__switch-track" aria-hidden="true"></span><span>${label}</span></label>`).join('');
  state.onChange = (event) => { if (event.target.matches('[data-input], [data-opt]')) render(); };
  state.onClick = async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'download') save();
    if (action === 'copy') {
      try { await navigator.clipboard.writeText(state.root.querySelector('[data-output]').value); state.root.querySelector('[data-status]').textContent = 'Texte nettoyé copié.'; }
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
