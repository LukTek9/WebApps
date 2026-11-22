import { createSecurityUI, escapeHtml } from './security-tool-ui.js';

const RATES = [
  ['20', '20 % — taux normal'],
  ['10', '10 % — taux intermédiaire'],
  ['5.5', '5,5 % — taux réduit'],
  ['2.1', '2,1 % — taux particulier'],
  ['0', '0 % — exonéré'],
  ['custom', 'Autre taux…'],
];

let ui;
let lastResult = null;

const CONTENT = `
  <div class="security-tools__panel">
    <div class="security-tools__controls">
      <label class="security-tools__field">Sens du calcul
        <select data-mode>
          <option value="ht">HT → TTC (ajouter la TVA)</option>
          <option value="ttc">TTC → HT (retirer la TVA)</option>
        </select>
      </label>
      <label class="security-tools__field">Prix unitaire (€)<input data-amount type="text" inputmode="decimal" value="100" autocomplete="off"></label>
      <label class="security-tools__field">Quantité<input data-quantity type="text" inputmode="decimal" value="1" autocomplete="off"></label>
      <label class="security-tools__field">Remise (%)<input data-discount type="text" inputmode="decimal" value="0" autocomplete="off"></label>
      <label class="security-tools__field">Taux de TVA
        <select data-rate>${RATES.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select>
      </label>
      <label class="security-tools__field" data-custom-wrap hidden>Taux personnalisé (%)<input data-custom type="text" inputmode="decimal" value="19" autocomplete="off"></label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le détail</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger en CSV</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Résultat</h3><p data-summary>Saisissez un montant.</p></div></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead><tr><th scope="col">Taux</th><th scope="col">Total HT</th><th scope="col">TVA</th><th scope="col">Total TTC</th></tr></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint">Calcul indicatif arrondi au centime. Les taux proposés sont ceux de la France métropolitaine; utilisez « Autre taux » pour un autre pays. Vérifiez auprès de votre comptable pour vos obligations déclaratives.</p>
  </section>`;

function number(text, label, { min = 0, max = Infinity, allowEmpty = false } = {}) {
  const normalized = text.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!normalized) {
    if (allowEmpty) return null;
    throw new Error(`${label} : valeur requise.`);
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) throw new Error(`${label} : nombre invalide.`);
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} : valeur hors limites (${min} à ${max === Infinity ? '∞' : max}).`);
  return value;
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const euro = (value) => value.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

function currentRate() {
  const choice = ui.query('[data-rate]').value;
  return choice === 'custom' ? number(ui.query('[data-custom]').value, 'Taux personnalisé', { min: 0, max: 100 }) : Number(choice);
}

function compute(base, mode, rate) {
  if (mode === 'ht') {
    const ht = round2(base);
    const tva = round2(ht * rate / 100);
    return { ht, tva, ttc: round2(ht + tva) };
  }
  const ttc = round2(base);
  const ht = round2(ttc / (1 + rate / 100));
  return { ht, tva: round2(ttc - ht), ttc };
}

function render() {
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const body = ui.query('[data-body]');
  const buttons = [...ui.root.querySelectorAll('[data-action]')];
  ui.query('[data-custom-wrap]').hidden = ui.query('[data-rate]').value !== 'custom';
  const amountText = ui.query('[data-amount]').value;
  if (!amountText.trim()) {
    lastResult = null;
    summary.textContent = 'Saisissez un montant.';
    stats.innerHTML = '';
    body.innerHTML = '';
    table.hidden = true;
    buttons.forEach((button) => { button.disabled = true; });
    return;
  }
  const unit = number(amountText, 'Prix unitaire', { max: 1e12 });
  const quantity = number(ui.query('[data-quantity]').value, 'Quantité', { min: 0, max: 1e9 });
  const discount = number(ui.query('[data-discount]').value || '0', 'Remise', { min: 0, max: 100 });
  const rate = currentRate();
  const mode = ui.query('[data-mode]').value;
  const base = unit * quantity * (1 - discount / 100);
  const result = compute(base, mode, rate);
  lastResult = { ...result, rate, mode, unit, quantity, discount, base: round2(base) };
  summary.textContent = `${mode === 'ht' ? 'HT → TTC' : 'TTC → HT'} au taux de ${rate.toLocaleString('fr-FR')} %`;
  stats.innerHTML = [
    ['Total HT', euro(result.ht)],
    [`TVA (${rate.toLocaleString('fr-FR')} %)`, euro(result.tva)],
    ['Total TTC', euro(result.ttc)],
    ['Coefficient', (1 + rate / 100).toLocaleString('fr-FR', { maximumFractionDigits: 4 })],
  ].map(([label, text]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(text)}</strong></article>`).join('');
  body.innerHTML = RATES.filter(([value]) => value !== 'custom').map(([value]) => {
    const row = compute(base, mode, Number(value));
    return `<tr><th scope="row">${Number(value).toLocaleString('fr-FR')} %</th><td>${euro(row.ht)}</td><td>${euro(row.tva)}</td><td>${euro(row.ttc)}</td></tr>`;
  }).join('');
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
    activeUi.root.querySelectorAll('[data-action]').forEach((button) => { button.disabled = true; });
    activeUi.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur de TVA',
    description: 'Passez du HT au TTC (et inversement) avec quantité, remise et taux de TVA, y compris un taux personnalisé.',
    content: CONTENT,
  });
  lastResult = null;
  const activeUi = ui;
  ui.on('input', (event) => {
    if (event.target.matches('[data-amount], [data-quantity], [data-discount], [data-custom]')) safeRender(activeUi);
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-mode], [data-rate]')) safeRender(activeUi);
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || !lastResult) return;
    const r = lastResult;
    if (action === 'copy') {
      await ui.copy(`Total HT : ${euro(r.ht)}\nTVA (${r.rate} %) : ${euro(r.tva)}\nTotal TTC : ${euro(r.ttc)}`, 'Détail copié.');
    }
    if (action === 'download-csv') {
      const text = ['sens;prix_unitaire;quantite;remise_pct;taux_tva_pct;total_ht;tva;total_ttc',
        [r.mode === 'ht' ? 'HT>TTC' : 'TTC>HT', r.unit, r.quantity, r.discount, r.rate, r.ht, r.tva, r.ttc].map((value) => String(value).replace('.', ',')).join(';')].join('\r\n');
      ui.download(`\uFEFF${text}`, 'calcul-tva.csv', 'text/csv;charset=utf-8');
    }
  });
  safeRender(ui);
}

export function unmount() {
  ui?.destroy();
  ui = null;
  lastResult = null;
}
