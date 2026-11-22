import { createSecurityUI } from '../shared/security-tool-ui.js';
import { bindResultActions, formatCurrency, formatNumber, parseNumber, updateResult } from '../shared/calculation-utils.js';

let ui;
let report = '';
let scheduleCsv = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Capital emprunté (€)<input data-principal type="text" inputmode="decimal" value="150000"></label>
        <label class="security-tools__field">Taux annuel (%)<input data-rate type="text" inputmode="decimal" value="3.5"></label>
        <label class="security-tools__field">Durée (années)<input data-years type="text" inputmode="decimal" value="20"></label>
      </div>
      <p class="security-tools__hint">Estimation à taux fixe, avec échéances mensuelles constantes; hors assurance, frais, taxes et autres conditions contractuelles.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Simulation du prêt</h3><p>Le tableau présente les douze premières échéances et la dernière.</p></div></div>
      <output class="calc-tools__answer" data-answer>—</output>
      <div class="security-tools__stats" data-stats></div>
      <div class="calc-tools__stack" role="img" aria-label="Répartition du remboursement">
        <span class="calc-tools__stack-capital" data-capital></span><span class="calc-tools__stack-interest" data-interest></span>
      </div>
      <p class="security-tools__hint" data-legend></p>
      <div class="data-tools__table-wrap">
        <table class="data-tools__table" data-table hidden>
          <thead><tr><th>Mois</th><th>Mensualité</th><th>Capital</th><th>Intérêts</th><th>Solde</th></tr></thead>
          <tbody data-rows></tbody>
        </table>
      </div>
      <pre class="security-tools__result" data-output></pre>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier la synthèse</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger l’échéancier CSV</button>
      </div>
    </section>
  </div>`;

function update() {
  try {
    const principal = parseNumber(ui.query('[data-principal]').value, 'un capital emprunté');
    const annualRate = parseNumber(ui.query('[data-rate]').value, 'un taux annuel');
    const years = parseNumber(ui.query('[data-years]').value, 'une durée');
    if (principal <= 0) throw new Error('Le capital emprunté doit être supérieur à zéro.');
    if (annualRate < 0 || annualRate > 1000) throw new Error('Le taux annuel doit être compris entre 0 et 1 000 %.');
    if (years <= 0 || years > 80) throw new Error('La durée doit être comprise entre 0 et 80 ans.');
    const months = Math.max(1, Math.round(years * 12));
    const monthlyRate = annualRate / 1200;
    const payment = monthlyRate === 0
      ? principal / months
      : principal * monthlyRate / (1 - (1 + monthlyRate) ** -months);
    if (!Number.isFinite(payment)) throw new Error('Cette simulation dépasse la plage numérique prise en charge.');

    let balance = principal;
    const schedule = [];
    for (let month = 1; month <= months; month += 1) {
      const interest = balance * monthlyRate;
      const paid = month === months ? balance + interest : payment;
      const capital = paid - interest;
      balance = Math.max(0, balance - capital);
      schedule.push({ month, paid, capital, interest, balance });
    }
    const total = schedule.reduce((sum, item) => sum + item.paid, 0);
    const totalInterest = Math.max(0, total - principal);
    const paymentText = formatCurrency(payment);
    report = `Capital : ${formatCurrency(principal)}\nTaux annuel : ${formatNumber(annualRate, 3)} %\nDurée : ${months} mois\nMensualité estimée : ${paymentText}\nTotal remboursé : ${formatCurrency(total)}\nCoût des intérêts : ${formatCurrency(totalInterest)}`;
    scheduleCsv = [
      'Mois;Mensualité (€);Capital (€);Intérêts (€);Solde (€)',
      ...schedule.map((item) => [item.month, item.paid, item.capital, item.interest, item.balance].map((value) => typeof value === 'number' ? value.toFixed(2) : value).join(';')),
    ].join('\r\n');
    ui.query('[data-answer]').textContent = paymentText;
    updateResult(ui, report, [
      ['Total remboursé', formatCurrency(total)],
      ['Coût des intérêts', formatCurrency(totalInterest)],
      ['Échéances', `${months} mois`],
    ]);
    const capitalWidth = Math.max(0, Math.min(100, principal / Math.max(total, 1) * 100));
    ui.query('[data-capital]').style.width = `${capitalWidth}%`;
    ui.query('[data-interest]').style.width = `${100 - capitalWidth}%`;
    ui.query('[data-legend]').textContent = `Capital ${formatCurrency(principal)} · intérêts ${formatCurrency(totalInterest)}`;
    const preview = months <= 13 ? schedule : [...schedule.slice(0, 12), schedule[schedule.length - 1]];
    ui.query('[data-rows]').innerHTML = preview.map((item) => `<tr><td>${item.month}</td><td>${formatCurrency(item.paid)}</td><td>${formatCurrency(item.capital)}</td><td>${formatCurrency(item.interest)}</td><td>${formatCurrency(item.balance)}</td></tr>`).join('');
    ui.query('[data-table]').hidden = false;
    ui.setStatus('Simulation calculée localement; elle ne constitue pas une offre de prêt.', 'success');
  } catch (error) {
    report = '';
    scheduleCsv = '';
    ui.query('[data-answer]').textContent = '—';
    ui.query('[data-table]').hidden = true;
    ui.query('[data-rows]').innerHTML = '';
    ui.query('[data-capital]').style.width = '0%';
    ui.query('[data-interest]').style.width = '0%';
    ui.query('[data-legend]').textContent = '';
    updateResult(ui, '', []);
    ui.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur de prêt',
    description: 'Estimez votre mensualité, le montant total remboursé et le coût des intérêts d’un prêt amortissable.',
    content: CONTENT,
  });
  report = '';
  scheduleCsv = '';
  ui.on('input', (event) => {
    if (event.target.matches('[data-principal], [data-rate], [data-years]')) update();
  });
  bindResultActions(
    ui,
    () => report,
    () => scheduleCsv ? { content: scheduleCsv, filename: 'echeancier-pret.csv', mime: 'text/csv;charset=utf-8' } : null,
    'Synthèse copiée.',
  );
  update();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
  scheduleCsv = '';
}
