import { createSecurityUI } from './security-tool-ui.js';
import { bindResultActions, formatNumber, updateResult } from './calculation-utils.js';

let ui;
let report = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Date de naissance<input data-birth type="date" value="2000-01-01"></label>
        <label class="security-tools__field">Calculer l’âge au<input data-reference type="date"></label>
      </div>
      <p class="security-tools__hint">Le calcul utilise les dates civiles et reste stable quelle que soit la durée des journées ou le fuseau horaire.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Âge exact</h3><p>Années, mois, jours et prochain anniversaire.</p></div></div>
      <output class="calc-tools__answer" data-answer>—</output>
      <div class="security-tools__stats" data-stats></div>
      <p class="calc-tools__callout" data-next-birthday></p>
      <pre class="security-tools__result" data-output></pre>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le résultat</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger le résultat</button>
      </div>
    </section>
  </div>`;

function parseDate(value, label) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Saisissez une ${label} valide.`);
  const parts = { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
  const date = utcDate(parts.year, parts.month, parts.day);
  if (date.getUTCFullYear() !== parts.year || date.getUTCMonth() !== parts.month || date.getUTCDate() !== parts.day) {
    throw new Error(`Saisissez une ${label} valide.`);
  }
  return parts;
}

function utcDate(year, month, day) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date;
}

function utcValue(parts) {
  return utcDate(parts.year, parts.month, parts.day).getTime();
}

function compareDates(a, b) {
  return utcValue(a) - utcValue(b);
}

function addMonthsClamped(date, count) {
  const total = date.month + count;
  const year = date.year + Math.floor(total / 12);
  const month = total % 12;
  const lastDay = utcDate(year, month + 1, 0).getUTCDate();
  return { year, month, day: Math.min(date.day, lastDay) };
}

function localDateValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function update() {
  try {
    const birth = parseDate(ui.query('[data-birth]').value, 'date de naissance');
    const reference = parseDate(ui.query('[data-reference]').value, 'date de référence');
    if (compareDates(reference, birth) < 0) throw new Error('La date de référence ne peut pas précéder la naissance.');
    let totalMonths = 0;
    while (compareDates(addMonthsClamped(birth, totalMonths + 1), reference) <= 0) totalMonths += 1;
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    const cursor = addMonthsClamped(birth, totalMonths);
    const days = Math.round((utcValue(reference) - utcValue(cursor)) / 86400000);
    const totalDays = Math.floor((utcValue(reference) - utcValue(birth)) / 86400000);
    const weeks = Math.floor(totalDays / 7);
    let nextBirthday = { year: reference.year, month: birth.month, day: birth.day };
    const nextMonthEnd = utcDate(nextBirthday.year, nextBirthday.month + 1, 0).getUTCDate();
    nextBirthday.day = Math.min(nextBirthday.day, nextMonthEnd);
    if (compareDates(nextBirthday, reference) <= 0) {
      nextBirthday = { year: reference.year + 1, month: birth.month, day: birth.day };
      nextBirthday.day = Math.min(nextBirthday.day, utcDate(nextBirthday.year, nextBirthday.month + 1, 0).getUTCDate());
    }
    const untilNext = Math.floor((utcValue(nextBirthday) - utcValue(reference)) / 86400000);
    const birthdayLabel = `${years} an${years === 1 ? '' : 's'}, ${months} mois et ${days} jour${days === 1 ? '' : 's'}`;
    report = `Âge au ${ui.query('[data-reference]').value} : ${birthdayLabel}\nDurée vécue : ${formatNumber(totalDays)} jours · ${formatNumber(weeks)} semaines\nProchain anniversaire : dans ${formatNumber(untilNext)} jour${untilNext === 1 ? '' : 's'}`;
    ui.query('[data-answer]').textContent = birthdayLabel;
    ui.query('[data-next-birthday]').textContent = `Prochain anniversaire : dans ${formatNumber(untilNext)} jour${untilNext === 1 ? '' : 's'} (${nextBirthday.day.toString().padStart(2, '0')}/${String(nextBirthday.month + 1).padStart(2, '0')}/${nextBirthday.year}).`;
    updateResult(ui, report, [
      ['Jours vécus', formatNumber(totalDays)],
      ['Semaines vécues', formatNumber(weeks)],
      ['Date de référence', ui.query('[data-reference]').value],
    ]);
    ui.setStatus('Âge calculé localement.', 'success');
  } catch (error) {
    report = '';
    ui.query('[data-answer]').textContent = '—';
    ui.query('[data-next-birthday]').textContent = '';
    updateResult(ui, '', []);
    ui.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur d’âge',
    description: 'Calculez un âge exact à une date donnée, le nombre de jours vécus et le délai jusqu’au prochain anniversaire.',
    content: CONTENT,
  });
  report = '';
  ui.query('[data-reference]').value = localDateValue(new Date());
  ui.on('input', (event) => {
    if (event.target.matches('[data-birth], [data-reference]')) update();
  });
  bindResultActions(ui, () => report, () => ({ content: report, filename: 'calcul-age.txt', mime: 'text/plain;charset=utf-8' }), 'Résultat copié.');
  update();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
}
