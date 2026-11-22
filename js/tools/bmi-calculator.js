import { createSecurityUI } from './security-tool-ui.js';
import { bindResultActions, formatNumber, parseNumber, updateResult } from './calculation-utils.js';

let ui;
let report = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Poids (kg)<input data-weight type="text" inputmode="decimal" value="70"></label>
        <label class="security-tools__field">Taille (cm)<input data-height type="text" inputmode="decimal" value="170"></label>
      </div>
      <p class="security-tools__hint">L’IMC est un indicateur statistique général pour les adultes, pas un diagnostic ni une évaluation individuelle de santé.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Indice de masse corporelle</h3><p>Repères adultes couramment utilisés.</p></div></div>
      <output class="calc-tools__answer" data-answer>—</output>
      <p class="calc-tools__classification" data-classification></p>
      <div class="calc-tools__gauge" role="img" aria-label="Échelle indicative de l’IMC">
        <div class="calc-tools__gauge-track"><i data-marker></i></div>
        <div class="calc-tools__gauge-labels"><span>18,5</span><span>25</span><span>30</span><span>40</span></div>
      </div>
      <div class="security-tools__stats" data-stats></div>
      <pre class="security-tools__result" data-output></pre>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le résultat</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger le résultat</button>
      </div>
    </section>
  </div>`;

function update() {
  try {
    const weight = parseNumber(ui.query('[data-weight]').value, 'un poids');
    const heightCm = parseNumber(ui.query('[data-height]').value, 'une taille');
    if (weight <= 0 || weight > 500) throw new Error('Le poids doit être compris entre 0 et 500 kg.');
    if (heightCm < 50 || heightCm > 280) throw new Error('La taille doit être comprise entre 50 et 280 cm.');
    const height = heightCm / 100;
    const bmi = weight / (height * height);
    if (!Number.isFinite(bmi)) throw new Error('Impossible de calculer cet IMC.');
    const category = bmi < 18.5 ? 'Insuffisance pondérale'
      : bmi < 25 ? 'Corpulence de référence'
        : bmi < 30 ? 'Surpoids'
          : 'Obésité (indication générale)';
    const lower = 18.5 * height * height;
    const upper = 24.9 * height * height;
    report = `IMC : ${formatNumber(bmi, 1)}\nCatégorie indicative : ${category}\nPoids : ${formatNumber(weight, 1)} kg\nTaille : ${formatNumber(heightCm, 1)} cm\nIntervalle de poids correspondant à un IMC de 18,5 à 24,9 : ${formatNumber(lower, 1)} à ${formatNumber(upper, 1)} kg`;
    ui.query('[data-answer]').textContent = formatNumber(bmi, 1);
    ui.query('[data-classification]').textContent = category;
    ui.query('[data-marker]').style.left = `${Math.max(0, Math.min(100, bmi / 40 * 100))}%`;
    updateResult(ui, report, [
      ['Poids saisi', `${formatNumber(weight, 1)} kg`],
      ['Taille saisie', `${formatNumber(heightCm, 1)} cm`],
      ['Intervalle de référence', `${formatNumber(lower, 1)}–${formatNumber(upper, 1)} kg`],
    ]);
    ui.setStatus('IMC calculé localement.', 'success');
  } catch (error) {
    report = '';
    ui.query('[data-answer]').textContent = '—';
    ui.query('[data-classification]').textContent = '';
    ui.query('[data-marker]').style.left = '0%';
    updateResult(ui, '', []);
    ui.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur IMC',
    description: 'Calculez un indice de masse corporelle indicatif et visualisez les repères adultes.',
    content: CONTENT,
  });
  report = '';
  ui.on('input', (event) => {
    if (event.target.matches('[data-weight], [data-height]')) update();
  });
  bindResultActions(ui, () => report, () => ({ content: report, filename: 'calcul-imc.txt', mime: 'text/plain;charset=utf-8' }), 'Résultat copié.');
  update();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
}
