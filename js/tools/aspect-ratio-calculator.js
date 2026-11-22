import { createSecurityUI, escapeHtml } from './shared/security-tool-ui.js';

const STANDARD_RATIOS = [
  [1, 1, 'Carré (1:1)'],
  [5, 4, '5:4'],
  [4, 3, 'Écran classique (4:3)'],
  [3, 2, 'Photo 35 mm (3:2)'],
  [16, 10, '16:10'],
  [16, 9, 'Vidéo HD / 4K (16:9)'],
  [21, 9, 'Ultra-large (21:9)'],
  [32, 9, 'Super ultra-large (32:9)'],
  [2, 3, 'Portrait photo (2:3)'],
  [3, 4, 'Portrait (3:4)'],
  [4, 5, 'Portrait réseaux sociaux (4:5)'],
  [9, 16, 'Vertical mobile (9:16)'],
];

const WIDTHS = [3840, 2560, 1920, 1280, 1024, 854, 640, 480, 320];

let ui;
let lastResult = null;

const CONTENT = `
  <div class="security-tools__panel">
    <div class="security-tools__controls">
      <label class="security-tools__field">Largeur d’origine (px)<input data-width type="text" inputmode="numeric" value="1920" autocomplete="off"></label>
      <label class="security-tools__field">Hauteur d’origine (px)<input data-height type="text" inputmode="numeric" value="1080" autocomplete="off"></label>
      <label class="security-tools__field">Ratio cible
        <select data-ratio>
          <option value="original">Ratio des dimensions d’origine</option>
          ${STANDARD_RATIOS.map(([w, h, label]) => `<option value="${w}:${h}">${escapeHtml(label)}</option>`).join('')}
          <option value="custom">Personnalisé…</option>
        </select>
      </label>
      <label class="security-tools__field" data-custom-wrap hidden>Ratio personnalisé (L:H)<input data-custom type="text" value="16:9" autocomplete="off" placeholder="ex. 16:9 ou 1,85"></label>
      <label class="security-tools__field">Dimension connue
        <select data-known><option value="width">Nouvelle largeur</option><option value="height">Nouvelle hauteur</option></select>
      </label>
      <label class="security-tools__field">Nouvelle valeur (px)<input data-new type="text" inputmode="numeric" value="1280" autocomplete="off"></label>
      <label class="security-tools__field">Arrondi
        <select data-rounding><option value="round">Au plus proche</option><option value="floor">Inférieur</option><option value="ceil">Supérieur</option><option value="even">Nombre pair le plus proche</option></select>
      </label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="swap" type="button">Permuter largeur / hauteur</button>
      <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le résultat</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger le tableau en CSV</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Résultat</h3><p data-summary>Saisissez des dimensions.</p></div></div>
    <div data-preview class="aspect-ratio-preview" role="img" aria-label="Aperçu proportionnel du ratio"></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead><tr><th scope="col">Largeur</th><th scope="col">Hauteur</th></tr></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint">Les hauteurs du tableau suivent le ratio cible. Pour la vidéo, privilégiez des dimensions paires (mode d’arrondi « pair »).</p>
  </section>`;

function integer(text, label, min = 1, max = 100000) {
  const normalized = text.trim().replace(/[\s\u00a0\u202f]/g, '');
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} : entier positif requis.`);
  const value = Number(normalized);
  if (value < min || value > max) throw new Error(`${label} : valeur entre ${min} et ${max.toLocaleString('fr-FR')}.`);
  return value;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function parseCustom(text) {
  const normalized = text.trim().replace(',', '.');
  const pair = normalized.match(/^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/i);
  if (pair) {
    const w = Number(pair[1]);
    const h = Number(pair[2]);
    if (w > 0 && h > 0) return [w, h];
  }
  if (/^\d+(?:\.\d+)?$/.test(normalized) && Number(normalized) > 0) return [Number(normalized), 1];
  throw new Error('Ratio personnalisé invalide (ex. 16:9 ou 1,85).');
}

function roundValue(value) {
  const mode = ui.query('[data-rounding]').value;
  if (mode === 'floor') return Math.max(1, Math.floor(value));
  if (mode === 'ceil') return Math.max(1, Math.ceil(value));
  if (mode === 'even') return Math.max(2, Math.round(value / 2) * 2);
  return Math.max(1, Math.round(value));
}

function render() {
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const body = ui.query('[data-body]');
  const preview = ui.query('[data-preview]');
  const buttons = [...ui.root.querySelectorAll('[data-action]')].filter((button) => button.dataset.action !== 'swap');
  const choice = ui.query('[data-ratio]').value;
  ui.query('[data-custom-wrap]').hidden = choice !== 'custom';
  const width = integer(ui.query('[data-width]').value, 'Largeur');
  const height = integer(ui.query('[data-height]').value, 'Hauteur');
  const divisor = gcd(width, height);
  const simpleW = width / divisor;
  const simpleH = height / divisor;
  let targetW;
  let targetH;
  if (choice === 'original') { targetW = width; targetH = height; }
  else if (choice === 'custom') { [targetW, targetH] = parseCustom(ui.query('[data-custom]').value); }
  else { [targetW, targetH] = choice.split(':').map(Number); }
  const known = ui.query('[data-known]').value;
  const newValue = integer(ui.query('[data-new]').value, 'Nouvelle valeur');
  const resultW = known === 'width' ? newValue : roundValue(newValue * targetW / targetH);
  const resultH = known === 'height' ? newValue : roundValue(newValue * targetH / targetW);
  const decimal = width / height;
  const nearest = STANDARD_RATIOS.reduce((best, entry) => (Math.abs(entry[0] / entry[1] - decimal) < Math.abs(best[0] / best[1] - decimal) ? entry : best));
  const orientation = width === height ? 'Carré' : (width > height ? 'Paysage' : 'Portrait');
  const exact = Math.abs(nearest[0] / nearest[1] - decimal) < 0.005;
  lastResult = { width, height, ratio: `${simpleW}:${simpleH}`, decimal, resultW, resultH, targetW, targetH };
  summary.textContent = `${width} × ${height} → ratio ${simpleW}:${simpleH} · redimensionné : ${resultW} × ${resultH} px`;
  stats.innerHTML = [
    ['Ratio simplifié', `${simpleW}:${simpleH}`],
    ['Ratio décimal', decimal.toLocaleString('fr-FR', { maximumFractionDigits: 4 })],
    ['Format le plus proche', `${nearest[2]}${exact ? '' : ' (approx.)'}`],
    ['Orientation', orientation],
    ['Mégapixels', (width * height / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 2 })],
    ['Nouvelles dimensions', `${resultW} × ${resultH} px`],
  ].map(([label, text]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(text)}</strong></article>`).join('');
  const previewRatio = resultW / resultH;
  preview.style.aspectRatio = `${resultW} / ${resultH}`;
  preview.style.width = `${Math.min(previewRatio, 1) * 100}%`;
  preview.style.maxWidth = '20rem';
  preview.style.minWidth = '3rem';
  preview.style.border = '2px solid var(--color-primary)';
  preview.style.background = 'var(--color-primary-soft)';
  preview.style.borderRadius = 'var(--radius-sm)';
  body.innerHTML = WIDTHS.map((w) => `<tr><td>${w} px</td><td>${roundValue(w * targetH / targetW)} px</td></tr>`).join('');
  table.hidden = false;
  buttons.forEach((button) => { button.disabled = false; });
}

function safeRender(activeUi) {
  try {
    render();
  } catch (error) {
    if (!activeUi.isActive()) return;
    lastResult = null;
    activeUi.query('[data-table]').hidden = true;
    activeUi.query('[data-stats]').innerHTML = '';
    activeUi.query('[data-summary]').textContent = 'Calcul impossible.';
    activeUi.root.querySelectorAll('[data-action]').forEach((button) => { if (button.dataset.action !== 'swap') button.disabled = true; });
    activeUi.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur de ratio d’aspect',
    description: 'Trouvez le ratio d’une image ou d’une vidéo et calculez les dimensions proportionnelles pour redimensionner sans déformation.',
    content: CONTENT,
  });
  lastResult = null;
  const activeUi = ui;
  ui.on('input', (event) => {
    if (event.target.matches('[data-width], [data-height], [data-custom], [data-new]')) safeRender(activeUi);
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-ratio], [data-known], [data-rounding]')) safeRender(activeUi);
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'swap') {
      const w = ui.query('[data-width]');
      const h = ui.query('[data-height]');
      const previous = w.value;
      w.value = h.value;
      h.value = previous;
      safeRender(ui);
      return;
    }
    if (!action || !lastResult) return;
    const r = lastResult;
    if (action === 'copy') await ui.copy(`${r.width}×${r.height} (${r.ratio}) → ${r.resultW}×${r.resultH} px`, 'Résultat copié.');
    if (action === 'download-csv') {
      const rows = [['largeur_px', 'hauteur_px'], ...WIDTHS.map((w) => [w, roundValue(w * r.targetH / r.targetW)])];
      ui.download(rows.map((row) => row.join(';')).join('\r\n'), 'dimensions-ratio.csv', 'text/csv;charset=utf-8');
    }
  });
  safeRender(ui);
}

export function unmount() {
  ui?.destroy();
  ui = null;
  lastResult = null;
}
