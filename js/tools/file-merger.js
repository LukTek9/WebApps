import { createSecurityUI, escapeHtml } from './security-tool-ui.js';

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_TEXT_BYTES = 100 * 1024 * 1024;

let ui;
let files = [];
let objectUrls = new Set();
let revokeTimers = new Set();
let lastResult = null;

const CONTENT = `
  <div class="security-tools__panel">
    <label class="security-tools__field">Ajouter des fichiers (glisser-déposer possible)<input data-file type="file" multiple></label>
    <div class="security-tools__controls">
      <label class="security-tools__field">Mode de fusion
        <select data-mode>
          <option value="binary">Concaténation binaire (octet par octet)</option>
          <option value="text">Texte (séparateur entre fichiers)</option>
          <option value="csv">CSV (ignorer les en-têtes des fichiers suivants)</option>
        </select>
      </label>
      <label class="security-tools__field">Séparateur (mode texte)
        <select data-separator>
          <option value="\\n">Saut de ligne</option>
          <option value="\\n\\n">Ligne vide</option>
          <option value="">Aucun</option>
          <option value="\\n----\\n">Ligne « ---- »</option>
        </select>
      </label>
      <label class="security-tools__field">Nom du fichier fusionné<input data-name type="text" value="fusion" maxlength="80"></label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="sort-name" type="button" disabled>Trier par nom</button>
      <button class="btn-secondary" data-action="merge" type="button" disabled>Fusionner</button>
      <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger le résultat</button>
      <button class="btn-secondary" data-action="clear" type="button" disabled>Tout retirer</button>
    </div>
    <progress data-progress max="100" value="0" hidden></progress>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Fichiers à fusionner</h3><p data-summary>Aucun fichier sélectionné.</p></div></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead><tr><th scope="col">Ordre</th><th scope="col">Nom</th><th scope="col">Taille</th><th scope="col">Type</th><th scope="col">Actions</th></tr></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint">Le mode binaire convient aux archives découpées (.part, .001) et aux fichiers identiques. Pour les PDF, images ou vidéos, utilisez l’outil dédié du même format.</p>
  </section>`;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Kio', 'Mio', 'Gio'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${units[unit]}`;
}

function totalBytes() {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function addFiles(list) {
  const incoming = [...list];
  let skipped = 0;
  for (const file of incoming) {
    if (files.length >= MAX_FILES || totalBytes() + file.size > MAX_TOTAL_BYTES) { skipped += 1; continue; }
    files.push(file);
  }
  render();
  if (skipped) ui.setStatus(`${skipped} fichier(s) ignoré(s) : limite de ${MAX_FILES} fichiers ou de ${formatSize(MAX_TOTAL_BYTES)} atteinte.`, 'error');
  else if (incoming.length) ui.setStatus(`${incoming.length} fichier(s) ajouté(s).`, 'success');
}

function releaseResult() {
  if (lastResult?.url) {
    URL.revokeObjectURL(lastResult.url);
    objectUrls.delete(lastResult.url);
  }
  lastResult = null;
}

function render() {
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const body = ui.query('[data-body]');
  const has = files.length > 0;
  ui.root.querySelector('[data-action="merge"]').disabled = files.length < 2;
  ui.root.querySelector('[data-action="sort-name"]').disabled = files.length < 2;
  ui.root.querySelector('[data-action="clear"]').disabled = !has;
  ui.root.querySelector('[data-action="download"]').disabled = !lastResult;
  summary.textContent = has ? `${files.length} fichier(s) · ${formatSize(totalBytes())}` : 'Aucun fichier sélectionné.';
  stats.innerHTML = has ? [['Fichiers', String(files.length)], ['Taille totale', formatSize(totalBytes())], ['Limite', formatSize(MAX_TOTAL_BYTES)]]
    .map(([label, value]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('') : '';
  body.innerHTML = files.map((file, index) => `<tr>
    <td>${index + 1}</td><td>${escapeHtml(file.name)}</td><td>${formatSize(file.size)}</td><td>${escapeHtml(file.type || 'inconnu')}</td>
    <td><button class="btn-secondary" type="button" data-move="up" data-index="${index}" aria-label="Monter ${escapeHtml(file.name)}"${index === 0 ? ' disabled' : ''}>↑</button>
    <button class="btn-secondary" type="button" data-move="down" data-index="${index}" aria-label="Descendre ${escapeHtml(file.name)}"${index === files.length - 1 ? ' disabled' : ''}>↓</button>
    <button class="btn-secondary" type="button" data-move="remove" data-index="${index}" aria-label="Retirer ${escapeHtml(file.name)}">✕</button></td></tr>`).join('');
  table.hidden = !has;
}

function stripHeader(text) {
  const newline = text.search(/\r\n|\n|\r/);
  if (newline < 0) return '';
  const match = text.slice(newline).match(/^(\r\n|\n|\r)/);
  return text.slice(newline + match[0].length);
}

async function merge() {
  const activeUi = ui;
  const mode = ui.query('[data-mode]').value;
  const progress = ui.query('[data-progress]');
  const rawSeparator = ui.query('[data-separator]').value;
  const separator = rawSeparator.replace(/\\n/g, '\n');
  releaseResult();
  progress.hidden = false;
  progress.value = 0;
  const mergeButton = ui.root.querySelector('[data-action="merge"]');
  mergeButton.disabled = true;
  try {
    let blob;
    let extension = '';
    if (mode === 'binary') {
      if (totalBytes() > MAX_TOTAL_BYTES) throw new Error('Taille totale trop élevée.');
      blob = new Blob(files, { type: files[0].type || 'application/octet-stream' });
      progress.value = 100;
      const match = files[0].name.match(/\.[^.]+$/);
      extension = match ? match[0].replace(/\.(part\d*|\d{3})$/i, '') : '';
    } else {
      if (totalBytes() > MAX_TEXT_BYTES) throw new Error(`Le mode texte est limité à ${formatSize(MAX_TEXT_BYTES)}.`);
      const parts = [];
      for (let index = 0; index < files.length; index += 1) {
        let text = (await files[index].text()).replace(/^\uFEFF/, '');
        if (!activeUi.isActive()) return;
        if (mode === 'csv' && index > 0) text = stripHeader(text);
        if (mode === 'csv') text = text.replace(/(\r\n|\n|\r)+$/, '');
        parts.push(text);
        progress.value = Math.round(((index + 1) / files.length) * 100);
      }
      const joiner = mode === 'csv' ? '\r\n' : separator;
      const typeMime = mode === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8';
      blob = new Blob([parts.join(joiner)], { type: typeMime });
      extension = mode === 'csv' ? '.csv' : (files[0].name.match(/\.[^.]+$/)?.[0] || '.txt');
    }
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const base = (ui.query('[data-name]').value.trim() || 'fusion').replace(/[\\/:*?"<>|]/g, '-');
    lastResult = { url, name: `${base}${extension}`, size: blob.size };
    render();
    ui.setStatus(`Fusion terminée : ${lastResult.name} (${formatSize(blob.size)}).`, 'success');
  } catch (error) {
    if (activeUi.isActive()) activeUi.setStatus(`Fusion impossible : ${error.message}`, 'error');
  } finally {
    if (activeUi.isActive()) {
      progress.hidden = true;
      mergeButton.disabled = files.length < 2;
    }
  }
}

function download() {
  if (!lastResult) return;
  const anchor = document.createElement('a');
  anchor.href = lastResult.url;
  anchor.download = lastResult.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Fusionneur de fichiers',
    description: 'Assemblez plusieurs fichiers en un seul (binaire, texte ou CSV) et réordonnez-les avant fusion, sans transfert.',
    content: CONTENT,
  });
  files = [];
  objectUrls = new Set();
  revokeTimers = new Set();
  lastResult = null;
  ui.on('change', (event) => {
    if (event.target.matches('[data-file]')) {
      addFiles(event.target.files || []);
      event.target.value = '';
      releaseResult();
      render();
    } else if (event.target.matches('[data-mode], [data-separator], [data-name]')) {
      releaseResult();
      render();
    }
  });
  ui.on('dragover', (event) => { event.preventDefault(); });
  ui.on('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) { releaseResult(); addFiles(event.dataTransfer.files); }
  });
  ui.on('click', async (event) => {
    const move = event.target.closest('[data-move]');
    if (move) {
      const index = Number(move.dataset.index);
      if (move.dataset.move === 'remove') files.splice(index, 1);
      if (move.dataset.move === 'up' && index > 0) [files[index - 1], files[index]] = [files[index], files[index - 1]];
      if (move.dataset.move === 'down' && index < files.length - 1) [files[index + 1], files[index]] = [files[index], files[index + 1]];
      releaseResult();
      render();
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'sort-name') { files.sort((a, b) => a.name.localeCompare(b.name, 'fr-FR', { numeric: true, sensitivity: 'base' })); releaseResult(); render(); }
    if (action === 'clear') { files = []; releaseResult(); render(); ui.setStatus('Liste vidée.', 'success'); }
    if (action === 'merge' && files.length >= 2) await merge();
    if (action === 'download') download();
  });
  render();
}

export function unmount() {
  revokeTimers.forEach((timer) => clearTimeout(timer));
  revokeTimers.clear();
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
  lastResult = null;
  files = [];
  ui?.destroy();
  ui = null;
}
