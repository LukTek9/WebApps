import { createSecurityUI } from '../shared/security-tool-ui.js';

let ui;
let report = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Mot de passe à analyser
        <div class="security-tools__input-action"><input data-password type="password" autocomplete="off" spellcheck="false" placeholder="Saisissez un mot de passe"><button class="btn-secondary" data-action="reveal" type="button" aria-pressed="false">Afficher</button></div>
      </label>
      <div class="security-tools__meter"><div><strong data-verdict>En attente</strong><span data-score>0 / 100</span></div><div class="security-tools__meter-bar" data-meter role="meter" aria-label="Robustesse estimée" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-meter-fill></span></div></div>
      <div class="security-tools__stats" data-stats></div>
      <p class="security-tools__hint">Cette estimation est indicative : elle ne vérifie ni les fuites connues ni les habitudes de réutilisation.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Conseils personnalisés</h3><p>Les contrôles sont effectués dans votre navigateur.</p></div></div>
      <ul class="security-tools__advice" data-advice><li>Saisissez un mot de passe pour commencer.</li></ul>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le rapport</button><button class="btn-secondary" data-action="download" type="button">Télécharger le rapport</button></div>
    </section>
  </div>`;

function analyze() {
  const value = ui.query('[data-password]').value;
  const classes = [
    /[a-z]/.test(value) ? 26 : 0,
    /[A-Z]/.test(value) ? 26 : 0,
    /\d/.test(value) ? 10 : 0,
    /[^a-zA-Z0-9]/.test(value) ? 33 : 0,
  ];
  const pool = classes.reduce((sum, size) => sum + size, 0);
  const unique = new Set(value).size;
  const entropy = value.length && pool ? value.length * Math.log2(pool) : 0;
  const repetitionPenalty = value.length ? Math.max(0, 1 - (value.length - unique) / value.length) : 0;
  const score = Math.round(Math.min(100, entropy / 1.28) * repetitionPenalty);
  const verdict = !value ? 'En attente' : score < 30 ? 'Faible' : score < 55 ? 'Moyen' : score < 80 ? 'Bon' : 'Très bon';
  const tips = [];
  if (value.length < 12) tips.push('Visez au moins 12 caractères, idéalement une phrase longue.');
  if (unique < value.length * 0.75) tips.push('Évitez les suites répétées ou les caractères réutilisés.');
  if (pool < 60) tips.push('Mélangez plusieurs familles de caractères, ou augmentez la longueur.');
  if (/(password|motdepasse|1234|qwerty|azerty)/i.test(value)) tips.push('Évitez les mots et suites très courants.');
  if (value && !tips.length) tips.push('Utilisez ce mot de passe pour un seul compte et conservez-le dans un gestionnaire.');
  if (!value) tips.push('Saisissez un mot de passe pour commencer.');
  const text = [
    `Évaluation indicative : ${verdict} (${score}/100)`,
    `Longueur : ${value.length} caractères`,
    `Caractères distincts : ${unique}`,
    `Entropie théorique maximale : ${entropy.toFixed(1)} bits`,
    ...tips.map((tip) => `Conseil : ${tip}`),
  ].join('\n');
  ui.query('[data-meter]').setAttribute('aria-valuenow', String(score));
  ui.query('[data-meter-fill]').style.width = `${score}%`;
  ui.query('[data-verdict]').textContent = verdict;
  ui.query('[data-score]').textContent = `${score} / 100`;
  ui.query('[data-stats]').innerHTML = [
    ['Longueur', `${value.length} caractères`],
    ['Caractères distincts', `${unique}`],
    ['Entropie estimée', `${entropy.toFixed(1)} bits`],
    ['Familles utilisées', `${classes.filter(Boolean).length} / 4`],
  ].map(([label, amount]) => `<article class="security-tools__stat"><span>${label}</span><strong>${amount}</strong></article>`).join('');
  ui.query('[data-advice]').innerHTML = tips.map((tip) => `<li>${tip}</li>`).join('');
  report = text;
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Testeur de robustesse',
    description: 'Obtenez une estimation locale de la longueur, de la diversité et de l’entropie.',
    content: CONTENT,
  });
  report = '';
  ui.on('input', (event) => { if (event.target.matches('[data-password]')) analyze(); });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'reveal') {
      const input = ui.query('[data-password]');
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      event.target.textContent = visible ? 'Masquer' : 'Afficher';
      event.target.setAttribute('aria-pressed', String(visible));
    }
    if (action === 'copy') await ui.copy(report, 'Rapport copié.');
    if (action === 'download') ui.download(report, 'analyse-mot-de-passe.txt');
  });
  analyze();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
}
