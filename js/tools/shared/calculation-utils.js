import { escapeHtml } from './security-tool-ui.js';

export function parseNumber(value, label = 'Valeur') {
  const normalized = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!normalized) throw new Error(`Saisissez ${label.toLocaleLowerCase('fr-FR')}.`);
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(`${label} doit être un nombre valide.`);
  return number;
}

export function formatNumber(value, maximumFractionDigits = 10) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits }).format(value);
}

export function formatCurrency(value, currency = 'EUR') {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(value);
}

export function updateResult(ui, report, metrics = []) {
  const text = report || '';
  ui.query('[data-output]').textContent = text;
  ui.query('[data-action="copy"]').disabled = !text;
  ui.query('[data-action="download"]').disabled = !text;
  ui.query('[data-stats]').innerHTML = metrics.map(([label, value]) => (
    `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
  )).join('');
}

export function bindResultActions(ui, getReport, getDownload, copyMessage = 'Résultat copié.') {
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') {
      const report = getReport();
      if (report) await ui.copy(report, copyMessage);
    }
    if (action === 'download') {
      const file = getDownload();
      if (file) ui.download(file.content, file.filename, file.mime);
    }
  });
}
