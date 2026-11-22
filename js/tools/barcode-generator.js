import { createSecurityUI, showError } from './security-tool-ui.js';

let ui;
let barcode = null;

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Format<select data-kind><option>EAN-13</option><option>UPC-A</option><option>CODE128</option></select></label>
      <label class="security-tools__field">Données du code<input data-value type="text" spellcheck="false" placeholder="12 chiffres EAN-13 ou texte ASCII"></label>
      <p class="security-tools__hint" data-guidance>12 chiffres génèrent automatiquement le chiffre de contrôle EAN-13.</p>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier les données</button><button class="btn-secondary" data-action="download" type="button">Télécharger le SVG</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Aperçu en direct</h3><p data-preview>Entrez une valeur valide pour créer un code.</p></div></div>
      <div class="utility-tools__barcode-stage" data-barcode></div>
    </section>
  </div>`;

const CODE128_PATTERNS = '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');

function checkDigit(digits, weight) {
  const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 4 - weight : weight), 0);
  return String((10 - sum % 10) % 10);
}

function encodeCode128(value) {
  if (!value || ![...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126)) {
    throw new Error('CODE128 accepte les caractères ASCII imprimables.');
  }
  const codes = [104, ...[...value].map((char) => char.charCodeAt(0) - 32)];
  codes.push(codes.reduce((sum, code, index) => sum + code * (index || 1), 0) % 103, 106);
  let x = 0;
  let markup = '';
  for (const code of codes) {
    let black = true;
    for (const width of CODE128_PATTERNS[code]) {
      if (black) markup += `<rect x="${x}" y="0" width="${width}" height="60"/>`;
      x += Number(width);
      black = !black;
    }
  }
  return { text: value, width: x, markup };
}

function encodeEan(value, kind) {
  const length = kind === 'UPC-A' ? 12 : 13;
  if (!/^[\d\s-]*$/.test(value)) throw new Error('EAN-13 et UPC-A n’acceptent que des chiffres.');
  let digits = value.replace(/\D/g, '');
  if (kind === 'UPC-A' && digits.length === 11) digits += checkDigit(digits, 3);
  if (kind === 'EAN-13' && digits.length === 12) digits += checkDigit(digits, 1);
  if (digits.length !== length) throw new Error(`Saisissez ${kind === 'UPC-A' ? '11 chiffres (ou 12 avec contrôle)' : '12 chiffres (ou 13 avec contrôle)'}.`);
  const checkBase = digits.slice(0, -1);
  const calculated = checkDigit(checkBase, kind === 'UPC-A' ? 3 : 1);
  if (calculated !== digits[digits.length - 1]) throw new Error('Le chiffre de contrôle ne correspond pas à cette valeur.');

  const left = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const right = left.map((pattern) => pattern.replace(/0/g, 'x').replace(/1/g, '0').replace(/x/g, '1'));
  const parity = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const expanded = kind === 'UPC-A' ? `0${digits}` : digits;
  let bits = '101';
  for (let index = 1; index <= 6; index += 1) {
    const side = kind === 'UPC-A' ? 'LLLLLL' : parity[Number(expanded[0])];
    const valueAt = Number(expanded[index]);
    bits += side[index - 1] === 'L' ? left[valueAt] : side[index - 1] === 'G' ? left[valueAt].split('').reverse().join('') : right[valueAt];
    if (index === 6) bits += '01010';
  }
  for (let index = 7; index < 13; index += 1) bits += right[Number(expanded[index])];
  bits += '101';
  return {
    text: digits,
    width: bits.length,
    markup: [...bits].map((bit, index) => bit === '1'
      ? `<rect x="${index}" y="0" width="1" height="${index < 3 || index > bits.length - 4 || (index >= 45 && index <= 49) ? 60 : 52}"/>`
      : '').join(''),
  };
}

function makeSvg(value, kind) {
  return kind === 'CODE128' ? encodeCode128(value) : encodeEan(value, kind);
}

function render() {
  barcode = null;
  ui.query('[data-barcode]').innerHTML = '<p class="security-tools__hint">Le code apparaît ici dès que la valeur est valide.</p>';
  ui.query('[data-preview]').textContent = 'Entrez une valeur valide pour créer un code.';
  try {
    const kind = ui.query('[data-kind]').value;
    barcode = makeSvg(ui.query('[data-value]').value.trim(), kind);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="utility-tools__barcode-svg" width="800" height="360" viewBox="0 0 ${barcode.width} 65" role="img" aria-label="Code ${kind}"><g fill="currentColor">${barcode.markup}</g></svg>`;
    ui.query('[data-barcode]').innerHTML = svg;
    ui.query('[data-preview]').textContent = `${kind} · ${barcode.text.length} caractères`;
    ui.setStatus('Code-barres généré localement.', 'success');
  } catch (error) {
    if (ui.query('[data-value]').value.trim()) showError(ui, error, 'Valeur de code-barres invalide.');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de code-barres',
    description: 'Créez un code EAN-13, UPC-A ou CODE128 avec aperçu SVG et export local.',
    content: CONTENT,
  });
  barcode = null;
  ui.on('input', (event) => { if (event.target.matches('[data-value]')) render(); });
  ui.on('change', (event) => {
    if (!event.target.matches('[data-kind]')) return;
    const kind = event.target.value;
    ui.query('[data-value]').placeholder = kind === 'CODE128' ? 'Ex. INV-2048' : kind === 'UPC-A' ? '11 ou 12 chiffres' : '12 ou 13 chiffres';
    ui.query('[data-guidance]').textContent = kind === 'CODE128'
      ? 'CODE128 accepte les caractères ASCII imprimables.'
      : `${kind} valide le chiffre de contrôle et le calcule s’il manque.`;
    render();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') {
      if (barcode) await ui.copy(barcode.text, 'Données du code copiées.');
      else ui.setStatus('Générez un code valide avant de le copier.', 'error');
    }
    if (action === 'download') {
      if (!barcode) { ui.setStatus('Générez un code valide avant le téléchargement.', 'error'); return; }
      const svg = ui.query('[data-barcode] svg').outerHTML;
      ui.download(svg, `code-${ui.query('[data-kind]').value.toLowerCase()}.svg`, 'image/svg+xml;charset=utf-8');
    }
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  barcode = null;
}
