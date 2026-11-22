import { createSecurityUI } from './shared/security-tool-ui.js';

let ui;
let numbers = [];

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Valeur minimale<input data-min type="number" step="any" value="1"></label>
        <label class="security-tools__field">Valeur maximale<input data-max type="number" step="any" value="100"></label>
        <label class="security-tools__field">Quantité<input data-count type="number" min="1" max="100" value="10"></label>
        <label class="security-tools__field">Type de résultat<select data-kind><option value="integer">Entiers inclusifs</option><option value="decimal">Décimaux</option></select></label>
      </div>
      <p class="security-tools__hint" data-preview>10 nombres entiers entre 1 et 100 inclus.</p>
      <div class="security-tools__actions"><button class="btn-primary" data-action="generate" type="button">Tirer au sort</button><button class="btn-secondary" data-action="copy" type="button">Copier</button><button class="btn-secondary" data-action="download" type="button">Télécharger .txt</button></div>
      <p class="security-tools__hint">Génération par crypto.getRandomValues() avec tirage sans biais pour les entiers.</p>
    </section>
    <section class="security-tools__panel"><div class="security-tools__panel-heading"><div><h3>Tirage</h3><p data-summary>Aucun tirage effectué</p></div></div>
      <output class="security-tools__result" data-output></output>
      <div class="security-tools__stats" data-stats></div>
    </section>
  </div>`;

function randomBelow(limit) {
  if (limit <= 1n) return 0n;
  const bits = (limit - 1n).toString(2).length;
  const byteCount = Math.ceil(bits / 8);
  const excess = byteCount * 8 - bits;
  const bytes = new Uint8Array(byteCount);
  let value;
  do {
    crypto.getRandomValues(bytes);
    if (excess) bytes[0] &= 0xff >>> excess;
    value = bytes.reduce((total, byte) => (total << 8n) | BigInt(byte), 0n);
  } while (value >= limit);
  return value;
}

function updatePreview() {
  const min = Number(ui.query('[data-min]').value);
  const max = Number(ui.query('[data-max]').value);
  const count = Math.max(1, Math.min(100, Number(ui.query('[data-count]').value) || 1));
  const kind = ui.query('[data-kind]').value;
  ui.query('[data-preview]').textContent = Number.isFinite(min) && Number.isFinite(max)
    ? `${count} nombres ${kind === 'integer' ? 'entiers inclusifs' : 'décimaux'} entre ${min} et ${max}.`
    : 'Saisissez des bornes numériques valides.';
}

function generate() {
  const min = Number(ui.query('[data-min]').value);
  const max = Number(ui.query('[data-max]').value);
  const count = Math.max(1, Math.min(100, Number(ui.query('[data-count]').value) || 1));
  const kind = ui.query('[data-kind]').value;
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('Les deux bornes doivent être des nombres finis.');
  if (max < min) throw new Error('La borne maximale doit être supérieure ou égale à la borne minimale.');
  if (kind === 'integer' && (!Number.isSafeInteger(min) || !Number.isSafeInteger(max))) throw new Error('Pour un tirage entier, les bornes doivent être des entiers sûrs.');
  if (kind === 'decimal' && !Number.isFinite(max - min)) throw new Error('L’écart entre les bornes décimales est trop grand.');
  if (kind === 'integer') {
    const lower = BigInt(min);
    const range = BigInt(max) - lower + 1n;
    numbers = Array.from({ length: count }, () => String(lower + randomBelow(range)));
  } else {
    const word = new Uint32Array(1);
    numbers = Array.from({ length: count }, () => {
      crypto.getRandomValues(word);
      return String(min + (word[0] / 0x100000000) * (max - min));
    });
  }
  const numeric = numbers.map(Number);
  ui.query('[data-output]').textContent = numbers.join('\n');
  ui.query('[data-summary]').textContent = `${count} valeur(s) · ${kind === 'integer' ? 'entiers' : 'décimaux'}`;
  ui.query('[data-stats]').innerHTML = [
    ['Minimum obtenu', Math.min(...numeric)],
    ['Maximum obtenu', Math.max(...numeric)],
    ['Moyenne', numeric.reduce((sum, value) => sum + value / numeric.length, 0).toLocaleString('fr-FR', { maximumFractionDigits: 6 })],
  ].map(([label, value]) => `<article class="security-tools__stat"><span>${label}</span><strong>${value}</strong></article>`).join('');
  ui.setStatus(`${count} valeur(s) générée(s) cryptographiquement.`, 'success');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur aléatoire sécurisé',
    description: 'Tirez des nombres entiers sans biais ou des valeurs décimales dans une plage personnalisée.',
    content: CONTENT,
  });
  numbers = [];
  ui.on('input', (event) => {
    if (event.target.matches('[data-min], [data-max], [data-count]')) updatePreview();
  });
  ui.on('change', (event) => { if (event.target.matches('[data-kind]')) updatePreview(); });
  ui.on('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'generate') {
      try { generate(); } catch (error) { ui.setStatus(error instanceof Error ? error.message : 'Tirage impossible.', 'error'); }
    }
    if (action === 'copy') ui.copy(numbers.join('\n'), 'Valeurs copiées.');
    if (action === 'download') {
      if (!numbers.length) { ui.setStatus('Effectuez un tirage avant le téléchargement.', 'error'); return; }
      ui.download(numbers.join('\n'), 'nombres-aleatoires.txt');
    }
  });
  updatePreview();
  generate();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  numbers = [];
}
