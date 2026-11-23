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

function legacyCopy(text) {
  const active = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.tabIndex = -1;
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '-9999px';
  field.style.opacity = '0';
  document.body.append(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    field.remove();
    try { active?.focus?.({ preventScroll: true }); } catch { /* ignoré */ }
  }
  return copied;
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* repli execCommand */ }
  }
  return legacyCopy(text);
}

export function bindResultActions(ui, getReport, getDownload, copyMessage = 'Résultat copié.') {
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') {
      const report = getReport();
      if (report) {
        if (await copyText(report)) ui.setStatus(copyMessage, 'success');
        else await ui.copy(report, copyMessage);
      }
    }
    if (action === 'download') {
      const file = getDownload();
      if (file) ui.download(file.content, file.filename, file.mime);
    }
  });
}
