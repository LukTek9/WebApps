const STOP_FR = new Set('alors au aucun aussi autre avant avec avoir bon car ce cela ces ceux chaque ci comme comment dans des du dedans dehors depuis deux elle elles en encore entre est et été être eu fait faites fois font hors ici il ils je juste leur là ma maintenant mais mes moins mon même ni notre nous ou où par parce pas peut peu plupart pour pourquoi quand que quel quelle quels quelles qui sa sans ses seulement si sien son sont sous sur ta tandis tels tes ton tous tout très tu un une vos votre vous y d dont'.split(' '));
const STOP_EN = new Set('a an and are as at be been but by can for from had has have he her hers him his i if in into is it its me my no not of on or our she so than that the their them then there these they this those to too up us was we were what when where which who will with would you your'.split(' '));
let state;

const TEMPLATE = `
<section class="text-tools">
  <header class="text-tools__heading"><div><span class="text-tools__eyebrow">Analyse en direct</span><h2>Compteur de mots & caractères</h2><p>Collez votre texte ou déposez un fichier .txt / .md.</p></div><button class="btn-secondary" type="button" data-action="copy-stats">Copier les statistiques</button></header>
  <label class="tool-field">Votre texte<textarea class="tool-textarea text-tools__editor" data-text rows="10" placeholder="Commencez à écrire ou collez votre texte…"></textarea></label>
  <label class="tool-dropzone text-tools__drop" data-drop>Déposez un fichier texte ici ou <span>parcourir</span><input type="file" accept=".txt,.md,text/plain,text/markdown" data-file hidden></label>
  <div class="tool-stats-grid text-tools__stats" data-stats></div>
  <section class="tool-panel"><header class="text-tools__section-head"><div><h3>Mots-clés fréquents</h3><p>Les mots courants sont exclus de l’analyse.</p></div><label class="text-tools__check"><input type="checkbox" data-stop checked> Exclure les mots vides français et anglais</label></header><div class="tool-preview-box"><table class="tool-table"><thead><tr><th>Mot</th><th>Fréquence</th><th>Part du texte</th></tr></thead><tbody data-keywords></tbody></table><p class="text-tools__empty" data-key-empty>Saisissez du texte pour afficher les mots-clés.</p></div></section>
  <p class="text-tools__status" data-status role="status" aria-live="polite"></p>
</section>`;

function formatTime(n) {
  if (!n) return '0 min';
  const mins = Math.ceil(n);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function analyze(text) {
  const words = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || [];
  const lines = text ? text.split(/\r\n|\r|\n/) : [];
  const paragraphs = text.trim() ? text.trim().split(/\n\s*\n/).filter((p) => p.trim()).length : 0;
  const sentences = text.trim() ? (text.match(/[.!?…]+(?=\s|$)/g) || []).length || 1 : 0;
  return { words, stats: [
    ['Mots', words.length],
    ['Caractères avec espaces', text.length],
    ['Caractères sans espaces', text.replace(/\s/g, '').length],
    ['Phrases', sentences],
    ['Paragraphes', paragraphs],
    ['Lignes', lines.length],
    ['Lecture (~225 m/min)', formatTime(words.length / 225)],
    ['Parole (~135 m/min)', formatTime(words.length / 135)],
  ] };
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render() {
  const text = state.root.querySelector('[data-text]').value;
  const { words, stats } = analyze(text);
  state.root.querySelector('[data-stats]').innerHTML = stats.map(([label, value]) => `<article class="tool-stat-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
  const stop = state.root.querySelector('[data-stop]').checked ? new Set([...STOP_FR, ...STOP_EN]) : new Set();
  const counts = new Map();
  for (const word of words) {
    const key = word.toLocaleLowerCase('fr');
    if (key.length < 2 || stop.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr')).slice(0, 10);
  const max = top[0]?.[1] || 1;
  state.root.querySelector('[data-keywords]').innerHTML = top.map(([word, count]) => `<tr><td>${escapeHtml(word)}</td><td>${count}</td><td><span class="text-tools__bar"><i style="width:${Math.max(4, count / max * 100)}%"></i></span> ${(count / (words.length || 1) * 100).toFixed(1)} %</td></tr>`).join('');
  state.root.querySelector('[data-key-empty]').hidden = top.length > 0;
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  state.urls.add(url);
  const link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  const timer = setTimeout(() => { URL.revokeObjectURL(url); state?.urls.delete(url); state?.timers.delete(timer); }, 1000);
  state.timers.add(timer);
}

async function copyStats() {
  const { stats } = analyze(state.root.querySelector('[data-text]').value);
  try { await navigator.clipboard.writeText(stats.map(([label, value]) => `${label} : ${value}`).join('\n')); state.root.querySelector('[data-status]').textContent = 'Statistiques copiées.'; }
  catch { state.root.querySelector('[data-status]').textContent = 'Copie impossible dans ce navigateur.'; }
}

async function loadFile(file) {
  if (!/\.(txt|md)$/i.test(file.name)) { state.root.querySelector('[data-status]').textContent = 'Choisissez un fichier .txt ou .md.'; return; }
  try {
    const text = await file.text();
    if (!state) return;
    state.root.querySelector('[data-text]').value = text;
    render();
  } catch {
    if (state) state.root.querySelector('[data-status]').textContent = 'Lecture du fichier impossible.';
  }
}

export function mount(container) {
  container.innerHTML = TEMPLATE;
  state = { root: container, urls: new Set(), timers: new Set() };
  state.onInput = (event) => { if (event.target.matches('[data-text], [data-stop]')) render(); };
  state.onClick = (event) => { if (event.target.closest('[data-action="copy-stats"]')) copyStats(); };
  state.onChange = (event) => { if (event.target.matches('[data-file]') && event.target.files?.[0]) loadFile(event.target.files[0]); };
  state.onDrag = (event) => {
    if (event.type === 'dragover') { event.preventDefault(); event.currentTarget.classList.add('is-dragging'); return; }
    event.currentTarget.classList.remove('is-dragging');
    if (event.type === 'drop') {
      event.preventDefault();
      if (event.dataTransfer.files[0]) loadFile(event.dataTransfer.files[0]);
    }
  };
  container.addEventListener('input', state.onInput);
  container.addEventListener('change', state.onInput);
  container.addEventListener('change', state.onChange);
  container.addEventListener('click', state.onClick);
  container.addEventListener('dragover', state.onDrag);
  container.addEventListener('dragleave', state.onDrag);
  container.addEventListener('drop', state.onDrag);
  render();
}

export function unmount() {
  if (!state) return;
  state.root.removeEventListener('input', state.onInput);
  state.root.removeEventListener('change', state.onInput);
  state.root.removeEventListener('change', state.onChange);
  state.root.removeEventListener('click', state.onClick);
  state.root.removeEventListener('dragover', state.onDrag);
  state.root.removeEventListener('dragleave', state.onDrag);
  state.root.removeEventListener('drop', state.onDrag);
  state.timers.forEach(clearTimeout);
  state.urls.forEach(URL.revokeObjectURL);
  state.root.innerHTML = '';
  state = null;
}
