import { createSecurityUI, escapeHtml } from './security-tool-ui.js';

const ACTIVITY = [
  ['1.2', 'Sédentaire (peu ou pas d’exercice)'],
  ['1.375', 'Légère (1 à 3 séances / semaine)'],
  ['1.55', 'Modérée (3 à 5 séances / semaine)'],
  ['1.725', 'Intense (6 à 7 séances / semaine)'],
  ['1.9', 'Très intense (travail physique + sport)'],
];

const CATEGORIES = [
  [16, 'Dénutrition (IMC < 16)'],
  [18.5, 'Insuffisance pondérale'],
  [25, 'Corpulence normale'],
  [30, 'Surpoids'],
  [35, 'Obésité modérée (classe I)'],
  [40, 'Obésité sévère (classe II)'],
  [Infinity, 'Obésité massive (classe III)'],
];

let ui;
let lastResult = null;

const CONTENT = `
  <div class="security-tools__panel">
    <div class="security-tools__controls">
      <label class="security-tools__field">Unités
        <select data-units>
          <option value="metric">Métrique (kg, cm)</option>
          <option value="imperial">Impérial (lb, pi / po)</option>
        </select>
      </label>
      <label class="security-tools__field">Sexe (pour le métabolisme)
        <select data-sex><option value="f">Femme</option><option value="m">Homme</option></select>
      </label>
      <label class="security-tools__field">Âge (ans)<input data-age type="text" inputmode="numeric" value="30" autocomplete="off"></label>
      <label class="security-tools__field" data-weight-label>Poids (kg)<input data-weight type="text" inputmode="decimal" value="70" autocomplete="off"></label>
      <label class="security-tools__field" data-height-label>Taille (cm)<input data-height type="text" inputmode="decimal" value="170" autocomplete="off"></label>
      <label class="security-tools__field" data-inches-wrap hidden>Pouces (po)<input data-inches type="text" inputmode="decimal" value="0" autocomplete="off"></label>
      <label class="security-tools__field">Niveau d’activité
        <select data-activity>${ACTIVITY.map(([value, label], index) => `<option value="${value}"${index === 1 ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
      </label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le résumé</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger en CSV</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Résultats</h3><p data-summary>Renseignez vos mesures.</p></div></div>
    <meter data-meter min="10" max="45" low="18.5" high="25" optimum="22" value="22" hidden aria-label="Position de l’IMC entre 10 et 45"></meter>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead><tr><th scope="col">Objectif</th><th scope="col">Calories / jour</th></tr></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint">Résultats indicatifs (formule de Mifflin-St Jeor, classification OMS pour adultes). L’IMC ne distingue pas muscle et graisse et ne convient pas aux enfants, aux femmes enceintes ni aux sportifs de haut niveau. Ceci ne remplace pas un avis médical ou diététique.</p>
  </section>`;

function number(text, label, min, max) {
  const normalized = text.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!normalized) throw new Error(`${label} : valeur requise.`);
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalized)) throw new Error(`${label} : nombre invalide.`);
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} : entre ${min} et ${max}.`);
  return value;
}

const fmt = (value, digits = 1) => value.toLocaleString('fr-FR', { maximumFractionDigits: digits });

function syncUnits() {
  const imperial = ui.query('[data-units]').value === 'imperial';
  ui.query('[data-weight-label]').firstChild.textContent = imperial ? 'Poids (lb)' : 'Poids (kg)';
  ui.query('[data-height-label]').firstChild.textContent = imperial ? 'Taille (pieds, pi)' : 'Taille (cm)';
  ui.query('[data-inches-wrap]').hidden = !imperial;
}

function render() {
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const body = ui.query('[data-body]');
  const meter = ui.query('[data-meter]');
  const buttons = [...ui.root.querySelectorAll('[data-action]')];
  syncUnits();
  const imperial = ui.query('[data-units]').value === 'imperial';
  const age = number(ui.query('[data-age]').value, 'Âge', 18, 120);
  const weightKg = imperial ? number(ui.query('[data-weight]').value, 'Poids', 66, 1100) * 0.45359237 : number(ui.query('[data-weight]').value, 'Poids', 30, 500);
  const heightCm = imperial
    ? (number(ui.query('[data-height]').value, 'Pieds', 3, 8) * 12 + number(ui.query('[data-inches]').value || '0', 'Pouces', 0, 11.99)) * 2.54
    : number(ui.query('[data-height]').value, 'Taille', 100, 250);
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  const category = CATEGORIES.find(([limit]) => bmi < limit)[1];
  const sex = ui.query('[data-sex]').value;
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'm' ? 5 : -161);
  const factor = Number(ui.query('[data-activity]').value);
  const tdee = bmr * factor;
  const minIdeal = 18.5 * heightM * heightM;
  const maxIdeal = 24.9 * heightM * heightM;
  const toDisplay = (kg) => (imperial ? `${fmt(kg / 0.45359237)} lb` : `${fmt(kg)} kg`);
  const goals = [
    ['Perte de poids modérée (−500 kcal)', Math.max(tdee - 500, bmr)],
    ['Maintien du poids', tdee],
    ['Prise de masse légère (+300 kcal)', tdee + 300],
  ];
  lastResult = { bmi, category, bmr, tdee, goals, weightKg, heightCm, minIdeal, maxIdeal };
  summary.textContent = `IMC ${fmt(bmi)} — ${category}`;
  meter.value = Math.min(Math.max(bmi, 10), 45);
  meter.hidden = false;
  stats.innerHTML = [
    ['IMC', fmt(bmi)],
    ['Catégorie OMS', category],
    ['Poids de référence (IMC 18,5–24,9)', `${toDisplay(minIdeal)} – ${toDisplay(maxIdeal)}`],
    ['Métabolisme de base', `${fmt(bmr, 0)} kcal`],
    ['Dépense journalière', `${fmt(tdee, 0)} kcal`],
  ].map(([label, text]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(text)}</strong></article>`).join('');
  body.innerHTML = goals.map(([label, kcal]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${fmt(kcal, 0)} kcal</td></tr>`).join('');
  table.hidden = false;
  buttons.forEach((button) => { button.disabled = false; });
  if (goals[0][1] === bmr && tdee - 500 < bmr) ui.setStatus('Le déficit proposé est plafonné au métabolisme de base : consultez un professionnel de santé avant toute restriction.', 'success');
}

function safeRender(activeUi) {
  try {
    render();
  } catch (error) {
    if (!activeUi.isActive()) return;
    lastResult = null;
    activeUi.query('[data-table]').hidden = true;
    activeUi.query('[data-meter]').hidden = true;
    activeUi.query('[data-stats]').innerHTML = '';
    activeUi.query('[data-summary]').textContent = 'Calcul impossible.';
    activeUi.root.querySelectorAll('[data-action]').forEach((button) => { button.disabled = true; });
    activeUi.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur IMC & calories',
    description: 'Calculez votre IMC, votre métabolisme de base et vos besoins caloriques quotidiens selon votre activité.',
    content: CONTENT,
  });
  lastResult = null;
  const activeUi = ui;
  ui.on('input', (event) => {
    if (event.target.matches('[data-age], [data-weight], [data-height], [data-inches]')) safeRender(activeUi);
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-units]')) {
      const imperial = event.target.value === 'imperial';
      ui.query('[data-weight]').value = imperial ? '154' : '70';
      ui.query('[data-height]').value = imperial ? '5' : '170';
      ui.query('[data-inches]').value = imperial ? '7' : '0';
      safeRender(activeUi);
    } else if (event.target.matches('[data-sex], [data-activity]')) {
      safeRender(activeUi);
    }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || !lastResult) return;
    const r = lastResult;
    if (action === 'copy') {
      await ui.copy([
        `IMC : ${fmt(r.bmi)} (${r.category})`,
        `Métabolisme de base : ${fmt(r.bmr, 0)} kcal`,
        `Dépense journalière : ${fmt(r.tdee, 0)} kcal`,
        ...r.goals.map(([label, kcal]) => `${label} : ${fmt(kcal, 0)} kcal`),
      ].join('\n'), 'Résumé copié.');
    }
    if (action === 'download-csv') {
      const rows = [['mesure', 'valeur'], ['imc', fmt(r.bmi, 2)], ['categorie', r.category], ['metabolisme_base_kcal', fmt(r.bmr, 0)], ['depense_kcal', fmt(r.tdee, 0)], ...r.goals.map(([label, kcal]) => [label, fmt(kcal, 0)])];
      ui.download(`\uFEFF${rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\r\n')}`, 'imc-calories.csv', 'text/csv;charset=utf-8');
    }
  });
  safeRender(ui);
}

export function unmount() {
  ui?.destroy();
  ui = null;
  lastResult = null;
}
