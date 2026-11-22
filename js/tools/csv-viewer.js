import { bindDropzone, createDropzone, createSecurityUI, escapeHtml } from './shared/security-tool-ui.js';

const MAX_SOURCE_LENGTH = 5000000;
const MAX_RENDERED_ROWS = 250;
const MAX_RECORDS = 200000;
const MAX_COLUMNS = 200;
const MAX_CELLS = 250000;
let ui;
let current = null;
let fileName = 'donnees.csv';
let sortColumn = -1;
let sortDirection = 1;

const CONTENT = `
  <div class="security-tools__panel">
    ${createDropzone({ id: 'csv', title: 'Glissez-déposez un fichier CSV ici', hint: 'ou cliquez pour parcourir · .csv, texte', accept: '.csv,text/csv,text/plain', label: 'Importer un fichier CSV' })}
    <label class="security-tools__field">Données CSV<textarea class="security-tools__textarea" data-source rows="12" spellcheck="false" placeholder="Collez un CSV avec séparateur virgule, point-virgule, tabulation ou barre verticale…"></textarea></label>
    <div class="security-tools__controls">
      <label class="security-tools__field">Séparateur
        <select data-delimiter>
          <option value="auto">Détection automatique</option>
          <option value=",">Virgule</option>
          <option value=";">Point-virgule</option>
          <option value="\\t">Tabulation</option>
          <option value="|">Barre verticale</option>
        </select>
      </label>
      <label><input data-header type="checkbox" checked> La première ligne contient les en-têtes</label>
      <label class="security-tools__field">Filtrer les lignes<input data-filter type="search" placeholder="Rechercher dans toutes les colonnes…"></label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="copy-json" type="button" disabled>Copier le JSON filtré</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger le CSV filtré</button>
      <button class="btn-secondary" data-action="download-json" type="button" disabled>Télécharger le JSON filtré</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Analyse et aperçu</h3><p data-summary>Collez ou importez un fichier CSV.</p></div></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead data-head></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint" data-limit hidden></p>
  </section>`;

function parseRecords(source, delimiter) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let cellCount = 0;
  const pushField = () => {
    record.push(field);
    field = '';
    cellCount += 1;
    if (record.length > MAX_COLUMNS) throw new Error(`Le CSV dépasse la limite de ${MAX_COLUMNS} colonnes.`);
    if (cellCount > MAX_CELLS) throw new Error(`Le CSV dépasse la limite de ${MAX_CELLS.toLocaleString('fr-FR')} cellules.`);
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
    if (records.length > MAX_RECORDS) throw new Error(`Le CSV dépasse la limite de ${MAX_RECORDS.toLocaleString('fr-FR')} lignes.`);
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === '\n' || char === '\r') {
      pushRecord();
      if (char === '\r' && source[index + 1] === '\n') index += 1;
    } else if (char === '"') {
      throw new Error(`Guillemet inattendu à la position ${index + 1}.`);
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('Le CSV contient un champ entre guillemets qui n’est pas terminé.');
  if (field.length || record.length) {
    pushRecord();
  }
  while (records.length && records[records.length - 1].every((value) => value === '')) records.pop();
  return records;
}

function detectDelimiter(source) {
  const candidates = [',', ';', '\t', '|'];
  const firstLine = source.split(/\r\n|\n|\r/, 1)[0];
  return candidates.map((delimiter) => {
    let quoted = false;
    let count = 0;
    for (let index = 0; index < firstLine.length; index += 1) {
      if (firstLine[index] === '"' && firstLine[index + 1] === '"') index += 1;
      else if (firstLine[index] === '"') quoted = !quoted;
      else if (firstLine[index] === delimiter && !quoted) count += 1;
    }
    return { delimiter, count };
  }).sort((a, b) => b.count - a.count)[0].delimiter;
}

function numericValue(value) {
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function serializeCsv(headers, rows) {
  const quote = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...rows].map((row) => row.map(quote).join(',')).join('\r\n');
}

function filteredRows() {
  if (!current) return [];
  const query = ui.query('[data-filter]').value.trim().toLocaleLowerCase('fr-FR');
  let rows = current.rows.map((row, index) => ({ row, index }));
  if (query) rows = rows.filter(({ row }) => row.some((value) => value.toLocaleLowerCase('fr-FR').includes(query)));
  if (sortColumn >= 0) {
    const column = sortColumn;
    rows.sort((a, b) => a.row[column].localeCompare(b.row[column], 'fr-FR', { numeric: true, sensitivity: 'base' }) * sortDirection || a.index - b.index);
  }
  return rows.map(({ row }) => row);
}

function render() {
  const source = ui.query('[data-source]').value.replace(/^\uFEFF/, '');
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const head = ui.query('[data-head]');
  const body = ui.query('[data-body]');
  const limit = ui.query('[data-limit]');
  const actions = [...ui.root.querySelectorAll('[data-action]')];
  if (!source.trim()) {
    current = null;
    summary.textContent = 'Collez ou importez un fichier CSV.';
    stats.innerHTML = '';
    head.innerHTML = '';
    body.innerHTML = '';
    table.hidden = true;
    limit.hidden = true;
    actions.forEach((button) => { button.disabled = true; });
    return;
  }
  if (source.length > MAX_SOURCE_LENGTH) throw new Error('Le CSV dépasse la limite de 5 Mo de texte.');
  const requested = ui.query('[data-delimiter]').value;
  const delimiter = requested === 'auto' ? detectDelimiter(source) : requested === '\\t' ? '\t' : requested;
  const records = parseRecords(source, delimiter);
  if (!records.length) throw new Error('Le CSV ne contient aucune ligne exploitable.');
  const hasHeader = ui.query('[data-header]').checked;
  const columnCount = records.reduce((max, record) => Math.max(max, record.length), 0);
  const rawHeaders = hasHeader
    ? Array.from({ length: columnCount }, (_, index) => records[0][index]?.trim() || `Colonne ${index + 1}`)
    : Array.from({ length: columnCount }, (_, index) => `Colonne ${index + 1}`);
  const headerCounts = new Map();
  const headers = rawHeaders.map((header) => {
    const count = (headerCounts.get(header) || 0) + 1;
    headerCounts.set(header, count);
    return count === 1 ? header : `${header} (${count})`;
  });
  const dataRecords = hasHeader ? records.slice(1) : records;
  const rows = dataRecords.map((record) => Array.from({ length: columnCount }, (_, index) => record[index] ?? ''));
  if (sortColumn >= headers.length) sortColumn = -1;
  current = { headers, rows, delimiter };
  const visible = filteredRows();
  summary.textContent = `${rows.length.toLocaleString('fr-FR')} lignes · ${headers.length} colonnes · ${visible.length.toLocaleString('fr-FR')} affichées · séparateur ${delimiter === '\t' ? 'tabulation' : delimiter}`;
  stats.innerHTML = headers.map((header, index) => {
    const values = rows.map((row) => row[index]).filter((value) => value.trim() !== '');
    const numbers = values.map(numericValue);
    const allNumeric = values.length > 0 && numbers.every((value) => value !== null);
    const aggregate = allNumeric ? numbers.reduce((result, value) => ({
      min: Math.min(result.min, value),
      max: Math.max(result.max, value),
      sum: result.sum + value,
    }), { min: Infinity, max: -Infinity, sum: 0 }) : null;
    const detail = allNumeric
      ? `min ${aggregate.min} · max ${aggregate.max} · moy. ${(aggregate.sum / numbers.length).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`
      : `${values.length} valeurs renseignées · texte`;
    return `<article class="security-tools__stat"><span>${escapeHtml(header)}</span><strong>${detail}</strong></article>`;
  }).join('');
  head.innerHTML = `<tr>${headers.map((header, index) => `<th scope="col"><button class="data-tools__sort" type="button" data-sort="${index}" aria-label="Trier par ${escapeHtml(header)}">${escapeHtml(header)} ↕</button></th>`).join('')}</tr>`;
  body.innerHTML = visible.slice(0, MAX_RENDERED_ROWS).map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('');
  table.hidden = visible.length === 0;
  limit.hidden = visible.length <= MAX_RENDERED_ROWS;
  limit.textContent = `Aperçu limité aux ${MAX_RENDERED_ROWS} premières lignes filtrées; les exports contiennent toutes les lignes correspondantes.`;
  actions.forEach((button) => { button.disabled = visible.length === 0; });
}

function jsonResult() {
  const rows = filteredRows();
  return JSON.stringify(rows.map((row) => Object.fromEntries(current.headers.map((header, index) => [header, row[index]]))), null, 2);
}

function showParseError(activeUi, error) {
  if (!activeUi.isActive()) return;
  current = null;
  activeUi.query('[data-table]').hidden = true;
  activeUi.query('[data-head]').innerHTML = '';
  activeUi.query('[data-body]').innerHTML = '';
  activeUi.query('[data-stats]').innerHTML = '';
  activeUi.query('[data-limit]').hidden = true;
  activeUi.query('[data-summary]').textContent = 'Le CSV ne peut pas être analysé.';
  activeUi.root.querySelectorAll('[data-action]').forEach((button) => { button.disabled = true; });
  activeUi.setStatus(error.message, 'error');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Visualiseur et analyseur CSV',
    description: 'Explorez un fichier délimité, filtrez et triez les lignes, consultez les statistiques et exportez les résultats.',
    content: CONTENT,
  });
  current = null;
  fileName = 'donnees.csv';
  sortColumn = -1;
  sortDirection = 1;
  ui.on('input', (event) => {
    if (!event.target.matches('[data-source], [data-filter]')) return;
    try {
      if (event.target.matches('[data-source]')) {
        sortColumn = -1;
        sortDirection = 1;
      }
      render();
      if (event.target.matches('[data-source]')) ui.setStatus('Analyse actualisée localement.', 'success');
    } catch (error) {
      showParseError(ui, error);
    }
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-delimiter], [data-header]')) {
      try { render(); ui.setStatus('Analyse actualisée localement.', 'success'); }
      catch (error) {
        showParseError(ui, error);
      }
      return;
    }
  });
  bindDropzone(ui, {
    id: 'csv',
    onFiles: async ([file]) => {
      const activeUi = ui;
      try {
        if (file.size > MAX_SOURCE_LENGTH) throw new Error('Le fichier CSV dépasse la limite de 5 Mo.');
        const source = await file.text();
        if (!activeUi.isActive()) return;
        fileName = file.name.replace(/\.csv$/i, '').replace(/[\\/:*?"<>|]/g, '-') || 'donnees';
        sortColumn = -1;
        sortDirection = 1;
        activeUi.query('[data-source]').value = source;
        render();
        activeUi.setStatus(`${file.name} analysé localement.`, 'success');
      } catch (error) {
        showParseError(activeUi, new Error(`Lecture ou analyse impossible : ${error.message}`));
      }
    },
  });
  ui.on('click', async (event) => {
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) {
      const column = Number(sortButton.dataset.sort);
      sortDirection = sortColumn === column ? -sortDirection : 1;
      sortColumn = column;
      try { render(); } catch (error) { ui.setStatus(error.message, 'error'); }
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || !current) return;
    const rows = filteredRows();
    if (!rows.length) return;
    if (action === 'copy-json') await ui.copy(jsonResult(), 'JSON filtré copié.');
    if (action === 'download-json') ui.download(jsonResult(), `${fileName}-filtre.json`, 'application/json;charset=utf-8');
    if (action === 'download-csv') ui.download(serializeCsv(current.headers, rows), `${fileName}-filtre.csv`, 'text/csv;charset=utf-8');
  });
  try { render(); } catch (error) { showParseError(ui, error); }
}

export function unmount() {
  ui?.destroy();
  ui = null;
  current = null;
  fileName = 'donnees.csv';
}
