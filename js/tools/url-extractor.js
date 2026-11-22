import { createSecurityUI, escapeHtml } from './security-tool-ui.js';

const MAX_SOURCE_LENGTH = 5000000;
const MAX_ROWS_PREVIEW = 200;
const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s<>"'`\\^{}|]+/gi;
const ATTR_PATTERN = /\b(?:href|src|action|data-src)\s*=\s*["']([^"'<>\s]+)["']/gi;
const TRAILING = /[.,;:!?)\]}»”’]+$/;

let ui;
let results = [];
let fileName = 'urls';

const CONTENT = `
  <div class="security-tools__panel">
    <label class="security-tools__field">Importer un fichier (.txt, .html, .md, .csv…)<input data-file type="file" accept=".txt,.html,.htm,.md,.csv,.json,.xml,text/*"></label>
    <label class="security-tools__field">Texte ou code source<textarea class="security-tools__textarea" data-source rows="10" spellcheck="false" placeholder="Collez un texte, une page HTML, un e-mail, un journal…"></textarea></label>
    <div class="security-tools__controls">
      <label class="security-tools__field">Protocole
        <select data-protocol>
          <option value="all">Tous (http, https, ftp)</option>
          <option value="https">HTTPS uniquement</option>
          <option value="http">HTTP uniquement</option>
          <option value="ftp">FTP uniquement</option>
        </select>
      </label>
      <label class="security-tools__field">Filtrer par domaine<input data-domain type="search" placeholder="ex. exemple.fr"></label>
      <label class="security-tools__field">Tri
        <select data-sort>
          <option value="source">Ordre d’apparition</option>
          <option value="alpha">Alphabétique</option>
          <option value="domain">Par domaine</option>
        </select>
      </label>
      <label><input data-unique type="checkbox" checked> Supprimer les doublons</label>
      <label><input data-attrs type="checkbox" checked> Lire aussi href / src (HTML)</label>
      <label><input data-strip type="checkbox"> Retirer les paramètres et ancres</label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="copy" type="button" disabled>Copier la liste</button>
      <button class="btn-secondary" data-action="download-txt" type="button" disabled>Télécharger en TXT</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger en CSV</button>
      <button class="btn-secondary" data-action="clear" type="button">Effacer</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Résultats</h3><p data-summary>Collez ou importez du contenu.</p></div></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead><tr><th scope="col">#</th><th scope="col">URL</th><th scope="col">Domaine</th><th scope="col">Protocole</th></tr></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint" data-limit hidden></p>
  </section>`;

function parseUrl(raw) {
  try {
    const url = new URL(raw);
    return url;
  } catch {
    return null;
  }
}

function extract() {
  const source = ui.query('[data-source]').value;
  if (source.length > MAX_SOURCE_LENGTH) throw new Error('Le contenu dépasse la limite de 5 Mo de texte.');
  const protocol = ui.query('[data-protocol]').value;
  const domainFilter = ui.query('[data-domain]').value.trim().toLocaleLowerCase('fr-FR');
  const unique = ui.query('[data-unique]').checked;
  const withAttrs = ui.query('[data-attrs]').checked;
  const strip = ui.query('[data-strip]').checked;
  const sort = ui.query('[data-sort]').value;

  const found = [];
  for (const match of source.matchAll(URL_PATTERN)) found.push({ raw: match[0], index: match.index });
  if (withAttrs) {
    for (const match of source.matchAll(ATTR_PATTERN)) {
      if (/^(?:https?|ftp):\/\//i.test(match[1])) found.push({ raw: match[1], index: match.index });
    }
  }
  found.sort((a, b) => a.index - b.index);

  const seen = new Set();
  const list = [];
  for (const item of found) {
    const cleaned = item.raw.replace(TRAILING, '');
    const parsed = parseUrl(cleaned);
    if (!parsed || !parsed.hostname) continue;
    if (protocol !== 'all' && parsed.protocol !== `${protocol}:`) continue;
    if (domainFilter && !parsed.hostname.toLocaleLowerCase('fr-FR').includes(domainFilter)) continue;
    let value = cleaned;
    if (strip) {
      parsed.search = '';
      parsed.hash = '';
      value = parsed.href;
    }
    if (unique) {
      if (seen.has(value)) continue;
      seen.add(value);
    }
    list.push({ url: value, domain: parsed.hostname, protocol: parsed.protocol.replace(':', '') });
  }
  if (sort === 'alpha') list.sort((a, b) => a.url.localeCompare(b.url, 'fr-FR'));
  if (sort === 'domain') list.sort((a, b) => a.domain.localeCompare(b.domain, 'fr-FR') || a.url.localeCompare(b.url, 'fr-FR'));
  return { list, total: found.length };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
    ? `${list.length.toLocaleString('fr-FR')} URL retenue(s) sur ${total.toLocaleString('fr-FR')} détectée(s).`
    : 'Aucune URL trouvée avec ces réglages.';
  stats.innerHTML = [
    ['Détectées', total.toLocaleString('fr-FR')],
    ['Retenues', list.length.toLocaleString('fr-FR')],
    ['Domaines', domains.size.toLocaleString('fr-FR')],
    ...top.map(([domain, count]) => [domain, `${count} URL`]),
  ].map(([label, value]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
  body.innerHTML = list.slice(0, MAX_ROWS_PREVIEW).map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.url)}</td><td>${escapeHtml(item.domain)}</td><td>${escapeHtml(item.protocol)}</td></tr>`).join('');
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
    title: 'Extracteur d’URL',
    description: 'Repérez et exportez tous les liens présents dans un texte, un e-mail ou une page HTML, sans transfert.',
    content: CONTENT,
  });
  results = [];
  fileName = 'urls';
  const activeUi = ui;
  ui.on('input', (event) => {
    if (event.target.matches('[data-source], [data-domain]')) safeRender(activeUi);
  });
  ui.on('change', async (event) => {
    if (event.target.matches('[data-protocol], [data-sort], [data-unique], [data-attrs], [data-strip]')) {
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
      fileName = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-') || 'urls';
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
    if (action === 'copy') await ui.copy(results.map((item) => item.url).join('\n'), 'Liste d’URL copiée.');
    if (action === 'download-txt') ui.download(results.map((item) => item.url).join('\n'), `${fileName}-urls.txt`, 'text/plain;charset=utf-8');
    if (action === 'download-csv') {
      const rows = [['url', 'domaine', 'protocole'], ...results.map((item) => [item.url, item.domain, item.protocol])];
      ui.download(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), `${fileName}-urls.csv`, 'text/csv;charset=utf-8');
    }
  });
  render();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  results = [];
  fileName = 'urls';
}
