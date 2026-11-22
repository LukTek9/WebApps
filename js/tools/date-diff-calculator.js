import { createSecurityUI } from './shared/security-tool-ui.js';

let ui;
let result = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Opération<select data-mode><option value="difference">Écart entre deux dates</option><option value="offset">Ajouter ou retirer des jours</option></select></label>
      <label class="security-tools__field">Date de départ<input data-start type="date"></label>
      <label class="security-tools__field" data-end-field>Date de fin<input data-end type="date"></label>
      <div class="security-tools__controls" data-offset-controls hidden>
        <label class="security-tools__field">Nombre de jours<input data-days type="number" value="30" step="1"></label>
        <label class="security-tools__field">Sens<select data-direction><option value="1">Ajouter</option><option value="-1">Retirer</option></select></label>
      </div>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le résultat</button><button class="btn-secondary" data-action="download" type="button">Télécharger le résultat</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Résultat</h3><p>Calcul exact en dates civiles, sans effet des changements d’heure.</p></div></div>
      <output class="security-tools__result" data-result aria-live="polite">Choisissez une date pour commencer.</output>
      <p class="security-tools__hint" data-breakdown></p>
    </section>
  </div>`;

function readDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function addCalendarMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(result);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  result.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return result;
}

function calculate() {
  const mode = ui.query('[data-mode]').value;
  const start = readDate(ui.query('[data-start]').value);
  const endField = ui.query('[data-end-field]');
  const breakdown = ui.query('[data-breakdown]');
  result = '';
  endField.hidden = mode === 'offset';
  ui.query('[data-offset-controls]').hidden = mode !== 'offset';
  try {
    if (!start) throw new Error('Choisissez une date de départ valide.');
    if (mode === 'offset') {
      const days = Number(ui.query('[data-days]').value);
      if (!Number.isSafeInteger(days)) throw new Error('Le nombre de jours doit être un entier valide.');
      const output = new Date(start.getTime() + days * Number(ui.query('[data-direction]').value) * 86400000);
      result = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeZone: 'UTC' }).format(output);
      breakdown.textContent = `${ui.query('[data-direction]').selectedOptions[0].text} ${days} jour(s) à partir du ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(start)}.`;
    } else {
      const end = readDate(ui.query('[data-end]').value);
      if (!end) throw new Error('Choisissez une date de fin valide.');
      const earlier = Math.min(start.getTime(), end.getTime());
      const later = Math.max(start.getTime(), end.getTime());
      const totalDays = (later - earlier) / 86400000;
      const cursor = new Date(earlier);
      let years = 0;
      let months = 0;
      let candidate = addCalendarMonths(cursor, 12);
      while (candidate.getTime() <= later) {
        cursor.setTime(candidate.getTime());
        years += 1;
        candidate = addCalendarMonths(cursor, 12);
      }
      candidate = addCalendarMonths(cursor, 1);
      while (candidate.getTime() <= later) {
        cursor.setTime(candidate.getTime());
        months += 1;
        candidate = addCalendarMonths(cursor, 1);
      }
      const days = (later - cursor.getTime()) / 86400000;
      let businessDays = 0;
      for (let timestamp = earlier; timestamp <= later; timestamp += 86400000) {
        const weekday = new Date(timestamp).getUTCDay();
        if (weekday !== 0 && weekday !== 6) businessDays += 1;
      }
      result = `${years} an${years === 1 ? '' : 's'}, ${months} mois, ${days} jour${days === 1 ? '' : 's'}`;
      breakdown.textContent = `${totalDays} jour(s) au total · ${Math.floor(totalDays / 7)} semaine(s) et ${totalDays % 7} jour(s) · ${businessDays} jour(s) ouvré(s), dates incluses.`;
    }
    ui.query('[data-result]').textContent = result;
    ui.setStatus('Calcul mis à jour.', 'success');
  } catch (error) {
    ui.query('[data-result]').textContent = 'Résultat indisponible.';
    breakdown.textContent = '';
    if (ui.query('[data-start]').value || (mode === 'difference' && ui.query('[data-end]').value)) {
      ui.setStatus(error.message, 'error');
    }
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur de dates',
    description: 'Comparez deux dates ou calculez une échéance, sans dépendance au fuseau horaire.',
    content: CONTENT,
  });
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
  ui.query('[data-start]').value = today;
  ui.query('[data-end]').value = today;
  ui.on('input', calculate);
  ui.on('change', calculate);
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (!result) { ui.setStatus('Calculez un résultat valide avant de continuer.', 'error'); return; }
    if (action === 'copy') await ui.copy(`${ui.query('[data-result]').textContent}\n${ui.query('[data-breakdown]').textContent}`, 'Résultat copié.');
    if (action === 'download') ui.download(`${result}\n${ui.query('[data-breakdown]').textContent}\n`, 'calcul-de-dates.txt');
  });
  calculate();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  result = '';
}
