import { createSecurityUI } from '../shared/security-tool-ui.js';

let ui;
let result = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Conversion<select data-mode>
        <option value="text-hex">Texte → hexadécimal</option><option value="hex-text">Hexadécimal → texte</option>
        <option value="text-binary">Texte → binaire</option><option value="binary-text">Binaire → texte</option>
        <option value="text-decimal">Texte → décimal</option><option value="decimal-text">Décimal → texte</option>
      </select></label>
      <label class="security-tools__field" data-input-label>Texte source<textarea class="tool-textarea security-tools__textarea" data-input rows="7" placeholder="Saisissez le texte à convertir…"></textarea></label>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le résultat</button><button class="btn-secondary" data-action="download" type="button">Télécharger .txt</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Résultat en direct</h3><p data-meta>En attente d’une entrée</p></div></div>
      <pre class="security-tools__result" data-output></pre>
    </section>
  </div>`;

function parseBytes(input, base) {
  const tokens = input.trim().split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) throw new Error('Saisissez une valeur à convertir.');
  return tokens.map((token) => {
    const valid = base === 16 ? /^[\da-f]{1,2}$/i.test(token)
      : base === 2 ? /^[01]{8}$/.test(token)
        : /^(?:0|[1-9]\d{0,2})$/.test(token);
    const byte = Number.parseInt(token, base);
    if (!valid || byte > 255) throw new Error(`Valeur « ${token} » invalide pour la base ${base}.`);
    return byte;
  });
}

function parseHexBytes(input) {
  const normalized = input.trim().replace(/0x/gi, '');
  if (/^[\da-f]+$/i.test(normalized)) {
    if (normalized.length % 2) throw new Error('Une suite hexadécimale sans séparateur doit contenir un nombre pair de chiffres.');
    return normalized.match(/.{2}/g).map((token) => Number.parseInt(token, 16));
  }
  const tokens = normalized.split(/[\s,;:]+/).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !/^[\da-f]{1,2}$/i.test(token))) throw new Error('Utilisez des octets hexadécimaux séparés par des espaces, virgules ou deux-points.');
  return tokens.map((token) => Number.parseInt(token, 16));
}

function convert() {
  const text = ui.query('[data-input]').value;
  result = '';
  if (!text) {
    ui.query('[data-output]').textContent = '';
    ui.query('[data-meta]').textContent = 'En attente d’une entrée';
    return;
  }
  try {
    const mode = ui.query('[data-mode]').value;
    const bytes = new TextEncoder().encode(text);
    if (mode === 'text-hex') result = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    if (mode === 'text-binary') result = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join(' ');
    if (mode === 'text-decimal') result = [...bytes].join(' ');
    if (mode === 'hex-text') result = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(parseHexBytes(text)));
    if (mode === 'binary-text') result = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(parseBytes(text, 2)));
    if (mode === 'decimal-text') result = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(parseBytes(text, 10)));
    ui.query('[data-output]').textContent = result;
    ui.query('[data-meta]').textContent = `${new TextEncoder().encode(result).length.toLocaleString('fr-FR')} octets UTF-8`;
    ui.setStatus('Conversion mise à jour.', 'success');
  } catch (error) {
    ui.query('[data-output]').textContent = '';
    ui.query('[data-meta]').textContent = 'Entrée à corriger';
    ui.setStatus(error instanceof Error ? error.message : 'Conversion impossible.', 'error');
  }
}

function updateInputLabel() {
  const mode = ui.query('[data-mode]').value;
  const decoding = mode.endsWith('-text');
  const base = mode === 'hex-text' ? 'hexadécimal' : mode === 'binary-text' ? 'binaire' : 'décimal';
  ui.query('[data-input-label]').firstChild.textContent = decoding ? `Valeurs ${base} (séparées par espaces)` : 'Texte source';
  ui.query('[data-input]').placeholder = decoding ? 'Ex. 48 65 6c 6c 6f' : 'Saisissez le texte à convertir…';
  convert();
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Convertisseur ASCII / Hex / Binaire',
    description: 'Convertissez du texte UTF-8 en octets hexadécimaux, binaires ou décimaux et inversement.',
    content: CONTENT,
  });
  result = '';
  ui.on('input', (event) => { if (event.target.matches('[data-input]')) convert(); });
  ui.on('change', (event) => { if (event.target.matches('[data-mode]')) updateInputLabel(); });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(result, 'Résultat copié.');
    if (action === 'download') {
      if (!result) { ui.setStatus('Saisissez une entrée valide avant le téléchargement.', 'error'); return; }
      ui.download(result, 'conversion-octets.txt');
    }
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  result = '';
}
