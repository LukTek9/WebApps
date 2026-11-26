import { bindDropzone, createDropzone, createSecurityUI, showError } from '../shared/security-tool-ui.js';

let ui;
let file = null;
let digest = '';
let revision = 0;

function md5(bytes) {
  const input = new Uint8Array(bytes);
  const bitLength = input.length * 8;
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true);
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let index = 0; index < 64; index += 1) {
      let fn;
      let word;
      let shift;
      if (index < 16) { fn = (b & c) | (~b & d); word = index; shift = shifts[index % 4]; }
      else if (index < 32) { fn = (d & b) | (~d & c); word = (5 * index + 1) % 16; shift = shifts[4 + index % 4]; }
      else if (index < 48) { fn = b ^ c ^ d; word = (3 * index + 5) % 16; shift = shifts[8 + index % 4]; }
      else { fn = c ^ (b | ~d); word = (7 * index) % 16; shift = shifts[12 + index % 4]; }
      const sum = (a + fn + constants[index] + words[word]) >>> 0;
      [a, d, c, b] = [d, c, b, (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0];
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((word) => [0, 8, 16, 24].map((shift) => ((word >>> shift) & 255).toString(16).padStart(2, '0')).join('')).join('');
}

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Algorithme<select data-algorithm><option>SHA-256</option><option>SHA-384</option><option>SHA-512</option><option>SHA-1</option><option>MD5</option></select></label>
        <label class="security-tools__field">Comparer à une empreinte<input data-expected type="text" placeholder="Facultatif"></label>
      </div>
      <label class="security-tools__field">Texte à hacher<textarea class="tool-textarea security-tools__textarea" data-text rows="7" placeholder="Saisissez ou collez votre texte…"></textarea></label>
      ${createDropzone({ id: 'file', title: 'Ou glissez-déposez un fichier ici', hint: 'ou cliquez pour parcourir · tout format', accept: '', label: 'Choisir un fichier à hacher', inputData: 'file' })}
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier l’empreinte</button><button class="btn-secondary" data-action="download" type="button">Télécharger le rapport</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Empreinte calculée</h3><p data-source>Aucune source sélectionnée</p></div></div>
      <output class="security-tools__result security-tools__result--digest" data-output></output>
      <div class="security-tools__comparison" data-comparison>Ajoutez du texte ou choisissez un fichier.</div>
      <p class="security-tools__hint">MD5 et SHA-1 ne conviennent pas aux usages de sécurité modernes. Préférez SHA-256 ou supérieur.</p>
    </section>
  </div>`;

async function calculate(activeUi) {
  const request = ++revision;
  const selectedFile = file;
  const input = activeUi.query('[data-text]').value;
  const algorithm = activeUi.query('[data-algorithm]').value;
  digest = '';
  activeUi.query('[data-output]').textContent = '';
  activeUi.query('[data-comparison]').dataset.state = 'muted';
  activeUi.setStatus('Calcul de l’empreinte…');
  const source = selectedFile ? await selectedFile.arrayBuffer() : new TextEncoder().encode(input);
  if (!activeUi.isActive() || request !== revision) return;
  if (!selectedFile && !input) {
    digest = '';
    activeUi.query('[data-output]').textContent = '';
    activeUi.query('[data-source]').textContent = 'Aucune source sélectionnée';
    activeUi.query('[data-comparison]').textContent = 'Ajoutez du texte ou choisissez un fichier.';
    activeUi.query('[data-comparison]').dataset.state = 'muted';
    activeUi.setStatus('Ajoutez du texte ou choisissez un fichier.');
    return;
  }
  const bytes = algorithm === 'MD5'
    ? md5(source)
    : [...new Uint8Array(await crypto.subtle.digest(algorithm, source))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!activeUi.isActive() || request !== revision) return;
  digest = bytes;
  activeUi.query('[data-output]').textContent = digest;
  activeUi.query('[data-source]').textContent = selectedFile
    ? `${selectedFile.name} · ${selectedFile.size.toLocaleString('fr-FR')} octets · ${algorithm}`
    : `${source.byteLength.toLocaleString('fr-FR')} octets UTF-8 · ${algorithm}`;
  compare(activeUi);
  activeUi.setStatus('Empreinte calculée localement.', 'success');
}

function compare(activeUi = ui) {
  if (!activeUi?.isActive()) return;
  const expected = activeUi.query('[data-expected]').value.trim().toLowerCase();
  const result = activeUi.query('[data-comparison]');
  result.textContent = !expected ? 'Saisissez une empreinte de référence pour la comparer.'
    : !digest ? 'Aucune empreinte à comparer.'
      : expected === digest ? 'Correspondance exacte.' : 'Les empreintes sont différentes.';
  result.dataset.state = expected && digest ? (expected === digest ? 'success' : 'error') : 'muted';
}

async function update() {
  const activeUi = ui;
  try { await calculate(activeUi); } catch (error) { showError(activeUi, error, 'Impossible de calculer cette empreinte.'); }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de hash',
    description: 'Calculez une empreinte SHA d’un texte ou d’un fichier, puis comparez-la à une référence.',
    content: CONTENT,
  });
  file = null;
  digest = '';
  revision = 0;
  ui.on('input', (event) => {
    if (event.target.matches('[data-text]')) { file = null; update(); }
    if (event.target.matches('[data-expected]')) compare();
  });
  bindDropzone(ui, { id: 'file' });
  ui.on('change', (event) => {
    if (event.target.matches('[data-algorithm]')) update();
    if (event.target.matches('[data-file]')) {
      file = event.target.files?.[0] || null;
      if (file) ui.query('[data-text]').value = '';
      update();
    }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(digest, 'Empreinte copiée.');
    if (action === 'download') {
      if (!digest) { ui.setStatus('Calculez une empreinte avant le téléchargement.', 'error'); return; }
      const report = `${ui.query('[data-algorithm]').value}  ${digest}\nSource : ${ui.query('[data-source]').textContent}\n`;
      ui.download(report, 'empreinte-sha.txt');
    }
  });
}

export function unmount() {
  revision += 1;
  ui?.destroy();
  ui = null;
  file = null;
  digest = '';
}
