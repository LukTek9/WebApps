import { createSecurityUI } from './security-tool-ui.js';
import { bindResultActions, formatNumber, parseNumber, updateResult } from './calculation-utils.js';

const LABELS = { a: 'A', b: 'B', c: 'C', d: 'D' };
let ui;
let report = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Valeur à calculer
        <select data-unknown>
          <option value="d">D · quatrième valeur</option>
          <option value="a">A · première valeur</option>
          <option value="b">B · deuxième valeur</option>
          <option value="c">C · troisième valeur</option>
        </select>
      </label>
      <div class="calc-tools__proportion">
        <label class="security-tools__field">A<input data-value="a" type="text" inputmode="decimal" value="2"></label>
        <span>:</span>
        <label class="security-tools__field">B<input data-value="b" type="text" inputmode="decimal" value="4"></label>
        <span>=</span>
        <label class="security-tools__field">C<input data-value="c" type="text" inputmode="decimal" value="3"></label>
        <span>:</span>
        <label class="security-tools__field">D<input data-value="d" type="text" inputmode="decimal" value="6"></label>
      </div>
      <p class="security-tools__hint">La proportion est interprétée comme A / B = C / D.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Résultat de la proportion</h3><p>Modifiez les trois valeurs connues pour recalculer la quatrième.</p></div></div>
      <output class="calc-tools__answer" data-answer>—</output>
      <div class="security-tools__stats" data-stats></div>
      <pre class="security-tools__result" data-output></pre>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le résultat</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger le résultat</button>
      </div>
    </section>
  </div>`;

function update() {
  const unknown = ui.query('[data-unknown]').value;
  for (const key of Object.keys(LABELS)) ui.query(`[data-value="${key}"]`).disabled = key === unknown;
  try {
    const values = {};
    for (const key of Object.keys(LABELS)) {
      if (key !== unknown) values[key] = parseNumber(ui.query(`[data-value="${key}"]`).value, `la valeur ${LABELS[key]}`);
    }
    let result;
    if (unknown === 'a') {
      if (values.d === 0) throw new Error('D ne peut pas être égal à zéro pour calculer A.');
      result = values.b * values.c / values.d;
    } else if (unknown === 'b') {
      if (values.c === 0) throw new Error('C ne peut pas être égal à zéro pour calculer B.');
      result = values.a * values.d / values.c;
    } else if (unknown === 'c') {
      if (values.b === 0) throw new Error('B ne peut pas être égal à zéro pour calculer C.');
      result = values.a * values.d / values.b;
    } else {
      if (values.a === 0) throw new Error('A ne peut pas être égal à zéro pour calculer D.');
      result = values.b * values.c / values.a;
    }
    if (!Number.isFinite(result)) throw new Error('Le résultat dépasse la plage numérique prise en charge.');
    values[unknown] = result;
    if (values.b === 0 || values.d === 0) throw new Error('Les dénominateurs B et D doivent être différents de zéro.');
    const formula = `${formatNumber(values.a)} / ${formatNumber(values.b)} = ${formatNumber(values.c)} / ${formatNumber(values.d)}`;
    report = `${LABELS[unknown]} = ${formatNumber(result)}\n${formula}`;
    ui.query('[data-answer]').textContent = `${LABELS[unknown]} = ${formatNumber(result)}`;
    updateResult(ui, report, [
      ['Rapport A / B', formatNumber(values.a / values.b)],
      ['Rapport C / D', formatNumber(values.c / values.d)],
      ['Valeur calculée', formatNumber(result)],
    ]);
    ui.setStatus('Proportion calculée localement.', 'success');
  } catch (error) {
    report = '';
    ui.query('[data-answer]').textContent = '—';
    updateResult(ui, '', []);
    ui.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Règle de trois',
    description: 'Résolvez une proportion A / B = C / D en choisissant la valeur inconnue.',
    content: CONTENT,
  });
  report = '';
  ui.on('input', (event) => {
    if (event.target.matches('[data-value]')) update();
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-unknown]')) update();
  });
  bindResultActions(ui, () => report, () => ({ content: report, filename: 'regle-de-trois.txt', mime: 'text/plain;charset=utf-8' }), 'Résultat copié.');
  update();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
}
