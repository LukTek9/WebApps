import { createSecurityUI } from './shared/security-tool-ui.js';
import { bindResultActions, formatNumber, parseNumber, updateResult } from './shared/calculation-utils.js';

let ui;
let report = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Calcul
        <select data-mode>
          <option value="part">Calculer un pourcentage d’une valeur</option>
          <option value="share">Part en pourcentage d’un total</option>
          <option value="change">Variation entre deux valeurs</option>
        </select>
      </label>
      <div class="security-tools__controls">
        <label class="security-tools__field"><span data-label-a>Pourcentage (%)</span><input data-a type="text" inputmode="decimal" value="20"></label>
        <label class="security-tools__field"><span data-label-b>Valeur de référence</span><input data-b type="text" inputmode="decimal" value="100"></label>
      </div>
      <p class="security-tools__hint">Les séparateurs décimaux français (virgule) ou internationaux (point) sont acceptés.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Résultat</h3><p>Le calcul se met à jour en direct.</p></div></div>
      <output class="calc-tools__answer" data-answer>—</output>
      <div class="security-tools__stats" data-stats></div>
      <pre class="security-tools__result" data-output></pre>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le calcul</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger le résultat</button>
      </div>
    </section>
  </div>`;

function updateLabels() {
  const mode = ui.query('[data-mode]').value;
  const labels = mode === 'part'
    ? ['Pourcentage (%)', 'Valeur de référence']
    : mode === 'share'
      ? ['Part', 'Total']
      : ['Valeur initiale', 'Valeur finale'];
  ui.query('[data-label-a]').textContent = labels[0];
  ui.query('[data-label-b]').textContent = labels[1];
}

function update() {
  try {
    const mode = ui.query('[data-mode]').value;
    const a = parseNumber(ui.query('[data-a]').value, ui.query('[data-label-a]').textContent);
    const b = parseNumber(ui.query('[data-b]').value, ui.query('[data-label-b]').textContent);
    let answer;
    let detail;
    let metrics;
    if (mode === 'part') {
      answer = a * b / 100;
      detail = `${formatNumber(a)} % de ${formatNumber(b)} = ${formatNumber(answer)}`;
      metrics = [['Pourcentage', `${formatNumber(a)} %`], ['Valeur de référence', formatNumber(b)], ['Part calculée', formatNumber(answer)]];
    } else if (mode === 'share') {
      if (b === 0) throw new Error('Le total ne peut pas être égal à zéro.');
      answer = a / b * 100;
      detail = `${formatNumber(a)} représente ${formatNumber(answer)} % de ${formatNumber(b)}`;
      metrics = [['Part', formatNumber(a)], ['Total', formatNumber(b)], ['Proportion', `${formatNumber(answer)} %`]];
    } else {
      if (a === 0) throw new Error('La valeur initiale ne peut pas être égale à zéro pour calculer une variation relative.');
      answer = (b - a) / a * 100;
      const difference = b - a;
      detail = `Variation : ${difference > 0 ? '+' : ''}${formatNumber(difference)} · ${answer > 0 ? '+' : ''}${formatNumber(answer)} %`;
      metrics = [['Valeur initiale', formatNumber(a)], ['Valeur finale', formatNumber(b)], ['Écart absolu', formatNumber(difference)]];
    }
    if (!Number.isFinite(answer)) throw new Error('Le résultat dépasse la plage numérique prise en charge.');
    report = detail;
    ui.query('[data-answer]').textContent = mode === 'change' ? `${answer > 0 ? '+' : ''}${formatNumber(answer)} %` : mode === 'share' ? `${formatNumber(answer)} %` : formatNumber(answer);
    updateResult(ui, report, metrics);
    ui.setStatus('Calcul effectué localement.', 'success');
  } catch (error) {
    report = '';
    ui.query('[data-answer]').textContent = '—';
    updateResult(ui, '', []);
    ui.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur de pourcentages',
    description: 'Calculez une part, une proportion ou la variation relative entre deux valeurs.',
    content: CONTENT,
  });
  report = '';
  ui.on('input', (event) => {
    if (event.target.matches('[data-a], [data-b]')) update();
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-mode]')) updateLabels();
    if (event.target.matches('[data-mode]')) update();
  });
  bindResultActions(ui, () => report, () => ({ content: report, filename: 'calcul-pourcentage.txt', mime: 'text/plain;charset=utf-8' }), 'Calcul copié.');
  update();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
}
