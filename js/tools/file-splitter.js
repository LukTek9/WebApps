import { bindDropzone, createDropzone, createSecurityUI, escapeHtml } from './security-tool-ui.js';

const MAX_PARTS = 1000;
let ui;
let sourceFile = null;
let chunks = [];
let safeBaseName = 'fichier';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      ${createDropzone({ id: 'file', title: 'Glissez-déposez un fichier ici', hint: 'ou cliquez pour parcourir · tous formats', label: 'Choisir un fichier à découper' })}
      <div class="security-tools__controls">
        <label class="security-tools__field">Taille maximale d’une partie (Mo)
          <input data-size type="number" min="0.1" max="1024" step="0.1" value="10">
        </label>
      </div>
      <div class="security-tools__stats" data-summary></div>
      <p class="security-tools__hint">Le fichier est découpé par tranches sans être chargé intégralement en mémoire. Chaque partie peut être téléchargée séparément.</p>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le manifeste</button>
        <button class="btn-secondary" data-action="manifest" type="button" disabled>Télécharger le manifeste</button>
      </div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Parties générées</h3><p data-caption>Choisissez un fichier pour calculer son découpage.</p></div></div>
      <div class="data-tools__parts" data-parts></div>
    </section>
  </div>`;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${units[unit]}`;
}

function buildChunks() {
  if (!sourceFile) return [];
  const megabytes = Number(ui.query('[data-size]').value);
  if (!Number.isFinite(megabytes) || megabytes < 0.1 || megabytes > 1024) {
    throw new Error('Choisissez une taille comprise entre 0,1 et 1 024 Mo.');
  }
  const chunkSize = Math.max(1, Math.floor(megabytes * 1024 * 1024));
  const count = Math.max(1, Math.ceil(sourceFile.size / chunkSize));
  if (count > MAX_PARTS) throw new Error(`Le découpage créerait plus de ${MAX_PARTS} parties. Augmentez leur taille.`);
  return Array.from({ length: count }, (_, index) => {
    const start = index * chunkSize;
    const end = Math.min(sourceFile.size, start + chunkSize);
    return { index, start, end, size: end - start };
  });
}

function manifestText() {
  return JSON.stringify({
    fichier: sourceFile.name,
    taille: sourceFile.size,
    parties: chunks.map((chunk, index) => ({
      nom: `${safeBaseName}.part-${String(index + 1).padStart(3, '0')}-of-${String(chunks.length).padStart(3, '0')}`,
      debut: chunk.start,
      finExclusive: chunk.end,
      taille: chunk.size,
    })),
  }, null, 2);
}

function render() {
  const summary = ui.query('[data-summary]');
  const caption = ui.query('[data-caption]');
  const list = ui.query('[data-parts]');
  const buttons = [...ui.root.querySelectorAll('[data-action]')];
  if (!sourceFile) {
    chunks = [];
    summary.innerHTML = '';
    list.innerHTML = '';
    buttons.forEach((button) => { button.disabled = true; });
    caption.textContent = 'Choisissez un fichier pour calculer son découpage.';
    return;
  }
  chunks = buildChunks();
  summary.innerHTML = [
    ['Fichier', sourceFile.name],
    ['Taille', formatBytes(sourceFile.size)],
    ['Nombre de parties', chunks.length],
  ].map(([label, value]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
  caption.textContent = `${chunks.length} partie(s) · taille maximale demandée ${formatBytes(Math.floor(Number(ui.query('[data-size]').value) * 1024 * 1024))}`;
  list.innerHTML = chunks.map((chunk, index) => {
    const name = `${safeBaseName}.part-${String(index + 1).padStart(3, '0')}-of-${String(chunks.length).padStart(3, '0')}`;
    return `<article class="data-tools__part"><div><strong>Partie ${index + 1} / ${chunks.length}</strong><span>${formatBytes(chunk.size)} · octets [${chunk.start.toLocaleString('fr-FR')}, ${chunk.end.toLocaleString('fr-FR')})</span></div><button class="btn-secondary" type="button" data-part="${index}">Télécharger</button><code>${escapeHtml(name)}</code></article>`;
  }).join('');
  buttons.forEach((button) => { button.disabled = false; });
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Découpeur de fichiers',
    description: 'Divisez un fichier volumineux en parties de taille contrôlée, sans envoyer ni charger le contenu en mémoire.',
    content: CONTENT,
  });
  sourceFile = null;
  chunks = [];
  safeBaseName = 'fichier';
  const recompute = () => {
    try {
      render();
      if (sourceFile) ui.setStatus('Découpage calculé localement.', 'success');
    } catch (error) {
      chunks = [];
      ui.query('[data-parts]').innerHTML = '';
      ui.query('[data-summary]').innerHTML = '';
      ui.query('[data-action="copy"]').disabled = true;
      ui.query('[data-action="manifest"]').disabled = true;
      ui.setStatus(error.message, 'error');
    }
  };
  bindDropzone(ui, {
    id: 'file',
    onFiles: ([file]) => {
      sourceFile = file;
      safeBaseName = file.name.replace(/[\\/:*?"<>|]/g, '-') || 'fichier';
      recompute();
    },
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-size]')) recompute();
  });
  ui.on('click', async (event) => {
    const partButton = event.target.closest('[data-part]');
    if (partButton && sourceFile) {
      const chunk = chunks[Number(partButton.dataset.part)];
      if (!chunk) return;
      const name = `${safeBaseName}.part-${String(chunk.index + 1).padStart(3, '0')}-of-${String(chunks.length).padStart(3, '0')}`;
      ui.download(sourceFile.slice(chunk.start, chunk.end), name, 'application/octet-stream');
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!sourceFile || !chunks.length) return;
    if (action === 'copy') await ui.copy(manifestText(), 'Manifeste copié.');
    if (action === 'manifest') ui.download(manifestText(), `${safeBaseName}-manifest.json`, 'application/json;charset=utf-8');
  });
  try { render(); } catch (error) { ui.setStatus(error.message, 'error'); }
}

export function unmount() {
  ui?.destroy();
  ui = null;
  sourceFile = null;
  chunks = [];
  safeBaseName = 'fichier';
}
