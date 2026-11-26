let state;
const TEMPLATE = `<section class="text-tools"><header class="text-tools__heading"><div><span class="text-tools__eyebrow">Nettoyage de liste</span><p>Choisissez les règles, le résultat se met à jour instantanément.</p></div><div class="tool-copy-bar"><button class="btn-secondary" type="button" data-action="copy">Copier</button><button class="btn" type="button" data-action="download">Télécharger .txt</button></div></header><div class="text-tools__controls"><label class="text-tools__check"><input type="checkbox" data-opt="case"> Ignorer la casse</label><label class="text-tools__check"><input type="checkbox" data-opt="trim" checked> Supprimer espaces début/fin</label><label class="text-tools__check"><input type="checkbox" data-opt="empty" checked> Supprimer les lignes vides</label><label class="text-tools__check"><input type="checkbox" data-opt="sort"> Trier le résultat</label></div><div class="text-tools__summary"><span class="tool-badge" data-total>0 lignes</span><span class="tool-badge text-tools__badge--removed" data-dupes>0 doublon supprimé</span><span class="tool-badge" data-remaining>0 restantes</span></div><div class="tool-split"><label class="tool-field">Texte d’origine<textarea class="tool-textarea" data-input rows="14" placeholder="Une entrée par ligne…"></textarea></label><label class="tool-field">Résultat<textarea class="tool-textarea" data-output rows="14" readonly></textarea></label></div><p class="text-tools__status" data-status role="status" aria-live="polite"></p></section>`;
function render() {
  const root = state.root, lines = root.querySelector('[data-input]').value.split(/\r\n|\r|\n/);
  const seen = new Set(), output = [];
  let duplicates = 0;
  const trim = root.querySelector('[data-opt="trim"]').checked;
  const ignoreCase = root.querySelector('[data-opt="case"]').checked;
  const removeEmpty = root.querySelector('[data-opt="empty"]').checked;
  for (let line of lines) {
    if (trim) line = line.trim();
    if (removeEmpty && !line.trim()) continue;
    const key = ignoreCase ? line.toLocaleLowerCase() : line;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); output.push(line);
  }
  if (root.querySelector('[data-opt="sort"]').checked) output.sort((a, b) => a.localeCompare(b, 'fr'));
  root.querySelector('[data-output]').value = output.join('\n');
  root.querySelector('[data-total]').textContent = `${lines.length} ligne${lines.length === 1 ? '' : 's'}`;
  root.querySelector('[data-dupes]').textContent = `${duplicates} doublon${duplicates === 1 ? '' : 's'} supprimé${duplicates === 1 ? '' : 's'}`;
  root.querySelector('[data-remaining]').textContent = `${output.length} restante${output.length === 1 ? '' : 's'}`;
}
function save() {
  const blob = new Blob([state.root.querySelector('[data-output]').value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob); state.urls.add(url);
  const a = document.createElement('a'); a.href = url; a.download = 'liste-nettoyee.txt'; document.body.append(a); a.click(); a.remove();
  const timer = setTimeout(() => { URL.revokeObjectURL(url); state?.urls.delete(url); state?.timers.delete(timer); }, 1000); state.timers.add(timer);
}
export function mount(container) {
  container.innerHTML = TEMPLATE; state = { root: container, urls: new Set(), timers: new Set() };
  state.onChange = (event) => { if (event.target.matches('[data-input], [data-opt]')) render(); };
  state.onClick = async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'download') save();
    if (action === 'copy') {
      try { await navigator.clipboard.writeText(state.root.querySelector('[data-output]').value); state.root.querySelector('[data-status]').textContent = 'Résultat copié.'; }
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
