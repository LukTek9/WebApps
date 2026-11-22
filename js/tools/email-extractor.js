import { createSecurityUI, escapeHtml } from './shared/security-tool-ui.js';

const MAX_SOURCE_LENGTH = 5000000;
const MAX_ROWS_PREVIEW = 200;
const EMAIL_PATTERN = /[A-Z0-9._%+\-]+@(?:[A-Z0-9](?:[A-Z0-9\-]*[A-Z0-9])?\.)+[A-Z]{2,24}/gi;

let ui;
let results = [];
let fileName = 'emails';

const CONTENT = `
  <div class="security-tools__panel">
    <label class="security-tools__field">Importer un fichier (.txt, .csv, .html, .eml…)<input data-file type="file" accept=".txt,.csv,.html,.htm,.eml,.json,.xml,.md,text/*"></label>
    <label class="security-tools__field">Texte ou données<textarea class="security-tools__textarea" data-source rows="10" spellcheck="false" placeholder="Collez un texte, un export CSV, un e-mail, une page HTML…"></textarea></label>
    <div class="security-tools__controls">
      <label class="security-tools__field">Filtrer par domaine<input data-domain type="search" placeholder="ex. gmail.com"></label>
      <label class="security-tools__field">Exclure les domaines (séparés par des virgules)<input data-exclude type="text" placeholder="ex. exemple.com, test.fr"></label>
      <label class="security-tools__field">Tri
        <select data-sort>
          <option value="source">Ordre d’apparition</option>
          <option value="alpha">Alphabétique</option>
          <option value="domain">Par domaine</option>
        </select>
      </label>
      <label class="security-tools__field">Séparateur de copie
        <select data-separator>
          <option value="\\n">Un par ligne</option>
          <option value=", ">Virgule</option>
          <option value="; ">Point-virgule (Outlook)</option>
        </select>
      </label>
      <label><input data-unique type="checkbox" checked> Supprimer les doublons</label>
      <label><input data-lower type="checkbox" checked> Mettre en minuscules</label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="copy" type="button" disabled>Copier les adresses</button>
      <button class="btn-secondary" data-action="download-txt" type="button" disabled>Télécharger en TXT</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger en CSV</button>
      <button class="btn-secondary" data-action="clear" type="button">Effacer</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Résultats</h3><p data-summary>Collez ou importez du contenu.</p></div></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead><tr><th scope="col">#</th><th scope="col">Adresse</th><th scope="col">Identifiant</th><th scope="col">Domaine</th></tr></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint" data-limit hidden></p>
    <p class="security-tools__hint">Extraction par motif : une adresse détectée n’est pas forcément valide ni active. Respectez le RGPD et la législation sur la prospection.</p>
  </section>`;

function extract() {
  const source = ui.query('[data-source]').value;
  if (source.length > MAX_SOURCE_LENGTH) throw new Error('Le contenu dépasse la limite de 5 Mo de texte.');
  const domainFilter = ui.query('[data-domain]').value.trim().toLocaleLowerCase('fr-FR');
  const excluded = ui.query('[data-exclude]').value.split(',').map((item) => item.trim().toLocaleLowerCase('fr-FR')).filter(Boolean);
  const unique = ui.query('[data-unique]').checked;
  const lower = ui.query('[data-lower]').checked;
  const sort = ui.query('[data-sort]').value;
  const matches = source.match(EMAIL_PATTERN) || [];
  const seen = new Set();
  const list = [];
  for (const raw of matches) {
    const address = lower ? raw.toLocaleLowerCase('fr-FR') : raw;
    const at = address.lastIndexOf('@');
    const local = address.slice(0, at);
    const domain = address.slice(at + 1).toLocaleLowerCase('fr-FR');
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) continue;
    if (domainFilter && !domain.includes(domainFilter)) continue;
    if (excluded.includes(domain)) continue;
    const key = address.toLocaleLowerCase('fr-FR');
    if (unique) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    list.push({ address, local, domain });
  }
  if (sort === 'alpha') list.sort((a, b) => a.address.localeCompare(b.address, 'fr-FR'));
  if (sort === 'domain') list.sort((a, b) => a.domain.localeCompare(b.domain, 'fr-FR') || a.local.localeCompare(b.local, 'fr-FR'));
  return { list, total: matches.length };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function separator() {
  const value = ui.query('[data-separator]').value;
  return value === '\\n' ? '\n' : value;
}

function render() {
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const body = ui.query('[data-body]');
  const limit = ui.query('[data-limit]');
  const buttons = [...ui.root.querySelectorAll('[data-action]')].filter((button) => button.dataset.action !== 'clear');
  if (!ui.query('[data-source]').value.trim()) {
    results = [];
    summary.textContent = 'Collez ou importez du contenu.';
    stats.innerHTML = '';
    body.innerHTML = '';
    table.hidden = true;
    limit.hidden = true;
    buttons.forEach((button) => { button.disabled = true; });
    return;
  }
  const { list, total } = extract();
  results = list;
  const domains = new Map();
  list.forEach((item) => domains.set(item.domain, (domains.get(item.domain) || 0) + 1));
  const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  summary.textContent = list.length
    ? `${list.length.toLocaleString('fr-FR')} adresse(s) retenue(s) sur ${total.toLocaleString('fr-FR')} détectée(s).`
    : 'Aucune adresse trouvée avec ces réglages.';
  stats.innerHTML = [
    ['Détectées', total.toLocaleString('fr-FR')],
    ['Retenues', list.length.toLocaleString('fr-FR')],
    ['Domaines', domains.size.toLocaleString('fr-FR')],
    ...top.map(([domain, count]) => [domain, `${count} adresse(s)`]),
  ].map(([label, value]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
  body.innerHTML = list.slice(0, MAX_ROWS_PREVIEW).map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.address)}</td><td>${escapeHtml(item.local)}</td><td>${escapeHtml(item.domain)}</td></tr>`).join('');
  table.hidden = list.length === 0;
  limit.hidden = list.length <= MAX_ROWS_PREVIEW;
  limit.textContent = `Aperçu limité aux ${MAX_ROWS_PREVIEW} premières lignes; les exports contiennent tous les résultats.`;
  buttons.forEach((button) => { button.disabled = list.length === 0; });
}

function safeRender(activeUi) {
  try {
    render();
  } catch (error) {
    if (!activeUi.isActive()) return;
    results = [];
    activeUi.query('[data-table]').hidden = true;
    activeUi.query('[data-stats]').innerHTML = '';
    activeUi.query('[data-summary]').textContent = 'Extraction impossible.';
    activeUi.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Extracteur d’e-mails',
    description: 'Repérez et exportez les adresses e-mail présentes dans un texte, un fichier ou du HTML, 100 % localement.',
    content: CONTENT,
  });
  results = [];
  fileName = 'emails';
  const activeUi = ui;
  ui.on('input', (event) => {
    if (event.target.matches('[data-source], [data-domain], [data-exclude]')) safeRender(activeUi);
  });
  ui.on('change', async (event) => {
    if (event.target.matches('[data-sort], [data-unique], [data-lower]')) {
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
      fileName = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-') || 'emails';
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
    if (!results.length) return;
    if (action === 'copy') await ui.copy(results.map((item) => item.address).join(separator()), 'Adresses copiées.');
    if (action === 'download-txt') ui.download(results.map((item) => item.address).join('\n'), `${fileName}-emails.txt`, 'text/plain;charset=utf-8');
    if (action === 'download-csv') {
      const rows = [['adresse', 'identifiant', 'domaine'], ...results.map((item) => [item.address, item.local, item.domain])];
      ui.download(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), `${fileName}-emails.csv`, 'text/csv;charset=utf-8');
    }
  });
  render();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  results = [];
  fileName = 'emails';
}
