import { bindDropzone, createDropzone, createSecurityUI, escapeHtml } from '../shared/security-tool-ui.js';

const MAX_SOURCE_LENGTH = 5000000;
const MAX_TABLES = 100;
const MAX_CELLS = 500000;
const MAX_ROWS_PREVIEW = 100;

let ui;
let tables = [];
let fileName = 'tableau';

const CONTENT = `
  <div class="security-tools__panel">
    ${createDropzone({ id: 'file', title: 'Glissez-déposez un fichier HTML ici', hint: 'ou cliquez pour parcourir · .html, .htm', accept: '.html,.htm,.xhtml,text/html,text/plain', label: 'Importer un fichier HTML', inputData: 'file' })}
    <label class="security-tools__field">Code HTML contenant un ou plusieurs &lt;table&gt;<textarea class="security-tools__textarea" data-source rows="10" spellcheck="false" placeholder="Collez ici le HTML (copié depuis l’inspecteur du navigateur ou un fichier enregistré)…"></textarea></label>
    <div class="security-tools__controls">
      <label class="security-tools__field">Tableau à exporter<select data-table-index disabled><option value="0">Aucun tableau</option></select></label>
      <label class="security-tools__field">Séparateur de sortie
        <select data-delimiter>
          <option value=",">Virgule</option>
          <option value=";">Point-virgule (Excel FR)</option>
          <option value="\\t">Tabulation</option>
          <option value="|">Barre verticale</option>
        </select>
      </label>
      <label><input data-bom type="checkbox" checked> Ajouter le BOM UTF-8 (accents dans Excel)</label>
      <label><input data-trim type="checkbox" checked> Nettoyer les espaces</label>
      <label><input data-header type="checkbox" checked> Première ligne = en-têtes (JSON)</label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="copy-csv" type="button" disabled>Copier le CSV</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger le CSV</button>
      <button class="btn-secondary" data-action="download-json" type="button" disabled>Télécharger le JSON</button>
      <button class="btn-secondary" data-action="download-all" type="button" disabled>Tous les tableaux (CSV concaténés)</button>
      <button class="btn-secondary" data-action="clear" type="button">Effacer</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Aperçu</h3><p data-summary>Collez ou importez du HTML.</p></div></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint" data-limit hidden></p>
    <p class="security-tools__hint">Le HTML est analysé dans un document inerte : aucun script n’est exécuté et rien n’est envoyé. Les cellules fusionnées (colspan / rowspan) sont dépliées.</p>
  </section>`;

function cleanText(node, trim) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  clone.querySelectorAll('script, style').forEach((element) => element.remove());
  const text = clone.textContent || '';
  return trim ? text.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim() : text;
}

function tableToMatrix(table, trim) {
  const matrix = [];
  let cells = 0;
  const rows = [...table.querySelectorAll('tr')].filter((row) => row.closest('table') === table);
  rows.forEach((row, rowIndex) => {
    matrix[rowIndex] ||= [];
    let column = 0;
    [...row.children].filter((cell) => /^(td|th)$/i.test(cell.tagName)).forEach((cell) => {
      while (matrix[rowIndex][column] !== undefined) column += 1;
      const colspan = Math.min(Math.max(Number.parseInt(cell.getAttribute('colspan') || '1', 10) || 1, 1), 100);
      const rowspan = Math.min(Math.max(Number.parseInt(cell.getAttribute('rowspan') || '1', 10) || 1, 1), 500);
      const text = cleanText(cell, trim);
      for (let r = 0; r < rowspan; r += 1) {
        matrix[rowIndex + r] ||= [];
        for (let c = 0; c < colspan; c += 1) {
          cells += 1;
          if (cells > MAX_CELLS) throw new Error(`Le tableau dépasse la limite de ${MAX_CELLS.toLocaleString('fr-FR')} cellules.`);
          matrix[rowIndex + r][column + c] = r === 0 && c === 0 ? text : '';
        }
      }
      column += colspan;
    });
  });
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  return matrix.map((row) => Array.from({ length: width }, (_, index) => row?.[index] ?? ''));
}

function delimiterValue() {
  const value = ui.query('[data-delimiter]').value;
  return value === '\\t' ? '\t' : value;
}

function toCsv(matrix) {
  const delimiter = delimiterValue();
  const quote = (value) => {
    const text = String(value ?? '');
    return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return matrix.map((row) => row.map(quote).join(delimiter)).join('\r\n');
}

function toJson(matrix) {
  if (!matrix.length) return '[]';
  if (!ui.query('[data-header]').checked) return JSON.stringify(matrix, null, 2);
  const used = new Map();
  const headers = matrix[0].map((value, index) => {
    const base = value || `Colonne ${index + 1}`;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  return JSON.stringify(matrix.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]]))), null, 2);
}

function selected() {
  const index = Number(ui.query('[data-table-index]').value) || 0;
  return tables[index] || null;
}

function parse() {
  const source = ui.query('[data-source]').value;
  const select = ui.query('[data-table-index]');
  if (!source.trim()) {
    tables = [];
    return;
  }
  if (source.length > MAX_SOURCE_LENGTH) throw new Error('Le HTML dépasse la limite de 5 Mo de texte.');
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const nodes = [...doc.querySelectorAll('table')].slice(0, MAX_TABLES);
  const trim = ui.query('[data-trim]').checked;
  const previous = select.value;
  tables = nodes.map((node, index) => {
    const caption = node.querySelector('caption')?.textContent.trim();
    return { label: `Tableau ${index + 1}${caption ? ` — ${caption.slice(0, 40)}` : ''}`, matrix: tableToMatrix(node, trim) };
  }).filter((entry) => entry.matrix.length);
  select.innerHTML = tables.length
    ? tables.map((entry, index) => `<option value="${index}">${escapeHtml(entry.label)} (${entry.matrix.length}×${entry.matrix[0]?.length || 0})</option>`).join('')
    : '<option value="0">Aucun tableau</option>';
  select.disabled = tables.length < 2;
  if (previous && Number(previous) < tables.length) select.value = previous;
}

function render() {
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const body = ui.query('[data-body]');
  const limit = ui.query('[data-limit]');
  const buttons = [...ui.root.querySelectorAll('[data-action]')].filter((button) => button.dataset.action !== 'clear');
  parse();
  const current = selected();
  if (!current) {
    summary.textContent = ui.query('[data-source]').value.trim() ? 'Aucun tableau trouvé dans ce HTML.' : 'Collez ou importez du HTML.';
    stats.innerHTML = '';
    body.innerHTML = '';
    table.hidden = true;
    limit.hidden = true;
    buttons.forEach((button) => { button.disabled = true; });
    return;
  }
  const { matrix } = current;
  summary.textContent = `${tables.length} tableau(x) détecté(s) · ${current.label}`;
  stats.innerHTML = [
    ['Lignes', matrix.length.toLocaleString('fr-FR')],
    ['Colonnes', (matrix[0]?.length || 0).toLocaleString('fr-FR')],
    ['Cellules', (matrix.length * (matrix[0]?.length || 0)).toLocaleString('fr-FR')],
  ].map(([label, value]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
  body.innerHTML = matrix.slice(0, MAX_ROWS_PREVIEW).map((row, index) => `<tr>${row.map((value) => (index === 0 && ui.query('[data-header]').checked ? `<th scope="col">${escapeHtml(value)}</th>` : `<td>${escapeHtml(value)}</td>`)).join('')}</tr>`).join('');
  table.hidden = false;
  limit.hidden = matrix.length <= MAX_ROWS_PREVIEW;
  limit.textContent = `Aperçu limité aux ${MAX_ROWS_PREVIEW} premières lignes; les exports contiennent tout le tableau.`;
  buttons.forEach((button) => { button.disabled = false; });
  ui.root.querySelector('[data-action="download-all"]').disabled = tables.length < 2;
}

function safeRender(activeUi) {
  try {
    render();
  } catch (error) {
    if (!activeUi.isActive()) return;
    tables = [];
    activeUi.query('[data-table]').hidden = true;
    activeUi.query('[data-stats]').innerHTML = '';
    activeUi.query('[data-summary]').textContent = 'Conversion impossible.';
    activeUi.root.querySelectorAll('[data-action]').forEach((button) => { if (button.dataset.action !== 'clear') button.disabled = true; });
    activeUi.setStatus(error.message, 'error');
  }
}

function withBom(text) {
  return ui.query('[data-bom]').checked ? `\uFEFF${text}` : text;
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'HTML (tableau) vers CSV',
    description: 'Extrayez les tableaux d’un code HTML et exportez-les en CSV ou JSON, avec gestion des cellules fusionnées.',
    content: CONTENT,
  });
  tables = [];
  fileName = 'tableau';
  const activeUi = ui;
  ui.on('input', (event) => {
    if (event.target.matches('[data-source]')) safeRender(activeUi);
  });
  bindDropzone(ui, { id: 'file' });
  ui.on('change', async (event) => {
    if (event.target.matches('[data-table-index], [data-delimiter], [data-bom], [data-trim], [data-header]')) {
      safeRender(activeUi);
      return;
    }
    if (!event.target.matches('[data-file]')) return;
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_SOURCE_LENGTH) throw new Error('Le fichier dépasse la limite de 5 Mo.');
      const text = await file.text();
      if (!activeUi.isActive()) return;
      fileName = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-') || 'tableau';
      activeUi.query('[data-source]').value = text;
      safeRender(activeUi);
      activeUi.setStatus(`${file.name} analysé localement.`, 'success');
    } catch (error) {
      activeUi.setStatus(`Lecture impossible : ${error.message}`, 'error');
    }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'clear') {
      ui.query('[data-source]').value = '';
      ui.query('[data-file]').value = '';
      safeRender(ui);
      return;
    }
    const current = selected();
    if (!current) return;
    const index = tables.indexOf(current) + 1;
    if (action === 'copy-csv') await ui.copy(toCsv(current.matrix), 'CSV copié.');
    if (action === 'download-csv') ui.download(withBom(toCsv(current.matrix)), `${fileName}-${index}.csv`, 'text/csv;charset=utf-8');
    if (action === 'download-json') ui.download(toJson(current.matrix), `${fileName}-${index}.json`, 'application/json;charset=utf-8');
    if (action === 'download-all') {
      const text = tables.map((entry) => `# ${entry.label}\r\n${toCsv(entry.matrix)}`).join('\r\n\r\n');
      ui.download(withBom(text), `${fileName}-tous.csv`, 'text/csv;charset=utf-8');
    }
  });
  render();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  tables = [];
  fileName = 'tableau';
}
