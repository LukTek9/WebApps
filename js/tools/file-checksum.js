import { bindDropzone, createDropzone, createSecurityUI, showError } from './security-tool-ui.js';

let ui;
let file = null;
let checksum = '';
let revision = 0;

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      ${createDropzone({ id: 'file', title: 'Glissez-déposez un fichier ici', hint: 'ou cliquez pour parcourir · tous formats', label: 'Choisir un fichier à analyser' })}
      <div class="security-tools__controls">
        <label class="security-tools__field">Algorithme<select data-algorithm><option>SHA-256</option><option>SHA-384</option><option>SHA-512</option><option>SHA-1</option></select></label>
        <label class="security-tools__field">Empreinte de référence<input data-expected type="text" spellcheck="false" placeholder="Facultatif"></label>
      </div>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier l’empreinte</button><button class="btn-secondary" data-action="download" type="button">Télécharger le rapport</button></div>
      <p class="security-tools__hint">La comparaison se fait localement. SHA-1 est fourni pour compatibilité, préférez SHA-256 ou supérieur.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Empreinte du fichier</h3><p data-file-meta>Aucun fichier sélectionné</p></div></div>
      <output class="security-tools__result security-tools__result--digest" data-output></output>
      <div class="security-tools__comparison" data-comparison>Choisissez un fichier pour commencer.</div>
    </section>
  </div>`;

async function calculate(activeUi) {
  if (!activeUi?.isActive()) return;
  const request = ++revision;
  const selected = file;
  const algorithm = activeUi.query('[data-algorithm]').value;
  checksum = '';
  activeUi.query('[data-output]').textContent = '';
  activeUi.query('[data-comparison]').textContent = selected ? 'Calcul de l’empreinte…' : 'Choisissez un fichier pour commencer.';
  activeUi.query('[data-comparison]').dataset.state = 'muted';
  if (!selected) {
    activeUi.query('[data-file-meta]').textContent = 'Aucun fichier sélectionné';
    activeUi.setStatus('Choisissez un fichier pour commencer.');
    return;
  }
  activeUi.setStatus('Calcul de l’empreinte…');
  const bytes = await selected.arrayBuffer();
  if (!activeUi.isActive() || request !== revision) return;
  const hash = await crypto.subtle.digest(algorithm, bytes);
  if (!activeUi.isActive() || request !== revision) return;
  checksum = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  activeUi.query('[data-output]').textContent = checksum;
  activeUi.query('[data-file-meta]').textContent = `${selected.name} · ${selected.size.toLocaleString('fr-FR')} octets`;
  compare();
  activeUi.setStatus('Empreinte calculée localement.', 'success');
}

function compare() {
  if (!ui) return;
  const expected = ui.query('[data-expected]').value.trim().toLowerCase();
  const node = ui.query('[data-comparison]');
  node.textContent = !expected ? 'Saisissez une empreinte de référence pour la comparer.'
    : !checksum ? 'Aucune empreinte disponible.'
      : expected === checksum ? 'Correspondance exacte.' : 'Les empreintes sont différentes.';
  node.dataset.state = expected && checksum ? (expected === checksum ? 'success' : 'error') : 'muted';
}

async function update() {
  const activeUi = ui;
  try { await calculate(activeUi); } catch (error) { showError(activeUi, error, 'Impossible de lire ou de hacher ce fichier.'); }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Checksum de fichier',
    description: 'Calculez l’empreinte cryptographique d’un fichier local et vérifiez son intégrité.',
    content: CONTENT,
  });
  file = null;
  checksum = '';
  revision = 0;
  bindDropzone(ui, {
    id: 'file',
    onFiles: ([selected]) => {
      file = selected;
      update();
    },
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-algorithm]')) update();
  });
  ui.on('input', (event) => { if (event.target.matches('[data-expected]')) compare(); });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(checksum, 'Empreinte copiée.');
    if (action === 'download') {
      if (!checksum) { ui.setStatus('Choisissez un fichier avant le téléchargement.', 'error'); return; }
      const report = `${ui.query('[data-algorithm]').value}  ${checksum}\nFichier : ${ui.query('[data-file-meta]').textContent}\n`;
      ui.download(report, 'checksum-fichier.txt');
    }
  });
}

export function unmount() {
  revision += 1;
  ui?.destroy();
  ui = null;
  file = null;
  checksum = '';
}
