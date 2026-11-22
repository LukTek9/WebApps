import { createSecurityUI } from './security-tool-ui.js';

let ui;
let output = '';
let hasResult = false;
let fileName = 'liste-deduplication.txt';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Importer une liste<input data-file type="file" accept=".txt,.csv,text/plain,text/csv"></label>
      <label class="security-tools__field">Lignes à traiter<textarea class="security-tools__textarea" data-source rows="14" placeholder="Une valeur par ligne…"></textarea></label>
      <div class="security-tools__controls">
        <label class="security-tools__field">Comparaison
          <select data-mode>
            <option value="exact">Exacte</option>
            <option value="insensitive">Sans tenir compte de la casse</option>
            <option value="trim-insensitive">Espaces extérieurs et casse ignorés</option>
          </select>
        </label>
        <label><input data-keep-empty type="checkbox"> Conserver une ligne vide</label>
      </div>
      <p class="security-tools__hint">La première occurrence est conservée. Les lignes vides sont ignorées par défaut.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Résultat dédupliqué</h3><p data-summary>Ajoutez une liste pour afficher les statistiques.</p></div></div>
      <div class="security-tools__stats" data-stats></div>
      <pre class="security-tools__result" data-output></pre>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier la liste</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger la liste</button>
      </div>
    </section>
  </div>`;

function analyze() {
  const source = ui.query('[data-source]').value;
  const result = ui.query('[data-output]');
  const stats = ui.query('[data-stats]');
  const summary = ui.query('[data-summary]');
  const copy = ui.query('[data-action="copy"]');
  const download = ui.query('[data-action="download"]');
  if (!source) {
    output = '';
    hasResult = false;
    result.textContent = '';
    stats.innerHTML = '';
    summary.textContent = 'Ajoutez une liste pour afficher les statistiques.';
    copy.disabled = true;
    download.disabled = true;
    return;
  }

  const mode = ui.query('[data-mode]').value;
  const keepEmpty = ui.query('[data-keep-empty]').checked;
  const lines = source.split(/\r\n|\n|\r/);
  const seen = new Set();
  const unique = [];
  let removed = 0;
  for (const line of lines) {
    const blank = !line.trim();
    if (blank && !keepEmpty) {
      removed += 1;
      continue;
    }
    let key = blank ? '' : line;
    if (mode === 'trim-insensitive') key = key.trim();
    if (mode !== 'exact') key = key.toLocaleLowerCase('fr-FR');
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    unique.push(line);
  }

  output = unique.join('\n');
  hasResult = unique.length > 0;
  result.textContent = output;
  summary.textContent = `${lines.length.toLocaleString('fr-FR')} lignes analysées · ${unique.length.toLocaleString('fr-FR')} conservées`;
  stats.innerHTML = [
    ['Lignes uniques', unique.length],
    ['Doublons ou vides retirés', removed],
    ['Réduction', `${Math.round((removed / Math.max(1, lines.length)) * 100)} %`],
  ].map(([label, value]) => `<article class="security-tools__stat"><span>${label}</span><strong>${value}</strong></article>`).join('');
  copy.disabled = !hasResult;
  download.disabled = !hasResult;
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Déduplicateur de listes',
    description: 'Nettoyez une liste de valeurs ou un fichier texte en conservant l’ordre des premières occurrences.',
    content: CONTENT,
  });
  output = '';
  hasResult = false;
  fileName = 'liste-deduplication.txt';
  ui.on('input', (event) => {
    if (event.target.matches('[data-source]')) analyze();
  });
  ui.on('change', async (event) => {
    if (event.target.matches('[data-mode], [data-keep-empty]')) analyze();
    if (!event.target.matches('[data-file]')) return;
    const file = event.target.files?.[0];
    if (!file) return;
    const activeUi = ui;
    try {
      if (file.size > 10000000) throw new Error('Le fichier dépasse la limite de 10 Mo.');
      const source = await file.text();
      if (!activeUi.isActive()) return;
      fileName = `${file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-') || 'liste'}-dedupliquee.txt`;
      activeUi.query('[data-source]').value = source;
      analyze();
      activeUi.setStatus(`${file.name} chargé localement.`, 'success');
    } catch (error) {
      if (activeUi.isActive()) activeUi.setStatus(`Lecture impossible : ${error.message}`, 'error');
    }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy' && hasResult) await ui.copy(output, 'Liste dédupliquée copiée.');
    if (action === 'download' && hasResult) ui.download(`${output}\n`, fileName, 'text/plain;charset=utf-8');
  });
  analyze();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  output = '';
  hasResult = false;
  fileName = 'liste-deduplication.txt';
}
