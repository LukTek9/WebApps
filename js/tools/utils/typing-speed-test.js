import { createSecurityUI } from '../shared/security-tool-ui.js';

let ui;
let interval = null;
let startedAt = 0;
let duration = 60;
let active = false;
let finalReport = '';

const SAMPLES = [
  'Le navigateur permet de traiter vos fichiers localement et de préserver votre confidentialité. Prenez le temps de saisir chaque phrase avec précision.',
  'La régularité aide à progresser : choisissez un rythme confortable, gardez les épaules détendues et relisez votre texte pendant la saisie.',
  'Un petit outil bien conçu rend les tâches quotidiennes plus simples, plus accessibles et plus agréables pour toutes et tous.',
];

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Texte d’entraînement<select data-sample><option value="0">Confidentialité numérique</option><option value="1">Conseils de frappe</option><option value="2">Outils du quotidien</option></select></label>
      <label class="security-tools__field">Durée<select data-duration><option value="30">30 secondes</option><option value="60" selected>1 minute</option><option value="120">2 minutes</option></select></label>
      <div class="security-tools__actions"><button class="btn-primary" data-action="start" type="button">Démarrer le test</button><button class="btn-secondary" data-action="stop" type="button" disabled>Terminer</button></div>
      <div class="security-tools__stats">
        <div class="security-tools__stat"><span>Temps restant</span><strong data-time>60 s</strong></div>
        <div class="security-tools__stat"><span>Vitesse</span><strong data-wpm>0 mots/min</strong></div>
        <div class="security-tools__stat"><span>Précision</span><strong data-accuracy>0 %</strong></div>
        <div class="security-tools__stat"><span>Caractères corrects</span><strong data-correct>0 / 0</strong></div>
      </div>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le résultat</button><button class="btn-secondary" data-action="download" type="button">Télécharger le résultat</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>À saisir</h3><p>Le score se met à jour pendant la frappe.</p></div></div>
      <p class="security-tools__result utility-tools__typing-sample" data-text></p>
      <label class="security-tools__field">Votre saisie<textarea class="security-tools__textarea" data-entry rows="7" disabled placeholder="Démarrez le test pour écrire…"></textarea></label>
    </section>
  </div>`;

function getScore() {
  const typed = ui.query('[data-entry]').value;
  const sample = SAMPLES[Number(ui.query('[data-sample]').value)];
  let correct = 0;
  for (let index = 0; index < typed.length; index += 1) {
    if (typed[index] === sample[index]) correct += 1;
  }
  const elapsedMinutes = Math.max((performance.now() - startedAt) / 60000, 1 / 60);
  return {
    typed,
    correct,
    wpm: Math.round(correct / 5 / elapsedMinutes),
    accuracy: typed.length ? Math.round(correct / typed.length * 100) : 0,
  };
}

function updateScore() {
  if (!ui) return;
  const score = getScore();
  ui.query('[data-wpm]').textContent = `${score.wpm} mots/min`;
  ui.query('[data-accuracy]').textContent = `${score.accuracy} %`;
  ui.query('[data-correct]').textContent = `${score.correct} / ${score.typed.length}`;
}

function stop(reason = 'manual') {
  if (!ui) return;
  const elapsedSeconds = Math.min(duration, Math.max(0, (performance.now() - startedAt) / 1000));
  active = false;
  if (interval !== null) ui.clearInterval(interval);
  interval = null;
  ui.query('[data-entry]').disabled = true;
  ui.query('[data-sample]').disabled = false;
  ui.query('[data-duration]').disabled = false;
  ui.query('[data-time]').textContent = `${Math.ceil(Math.max(0, duration - elapsedSeconds))} s`;
  ui.query('[data-action="start"]').disabled = false;
  ui.query('[data-action="stop"]').disabled = true;
  updateScore();
  const score = getScore();
  finalReport = `Vitesse : ${score.wpm} mots/min\nPrécision : ${score.accuracy} %\nCaractères corrects : ${score.correct} / ${score.typed.length}\nDurée réalisée : ${elapsedSeconds.toFixed(1)} s`;
  if (reason === 'timeout') ui.setStatus('Temps écoulé : test terminé.', 'success');
  else if (reason === 'sample') ui.setStatus('Texte terminé : test réussi.', 'success');
  else ui.setStatus('Test terminé.', 'success');
}

function tick() {
  if (!active) return;
  const elapsed = (performance.now() - startedAt) / 1000;
  const remaining = Math.max(0, duration - elapsed);
  ui.query('[data-time]').textContent = `${Math.ceil(remaining)} s`;
  updateScore();
  if (remaining <= 0) stop('timeout');
}

function resetSample() {
  const sampleIndex = Number(ui.query('[data-sample]').value);
  ui.query('[data-text]').textContent = SAMPLES[sampleIndex];
  ui.query('[data-entry]').value = '';
  ui.query('[data-time]').textContent = `${duration} s`;
  ui.query('[data-wpm]').textContent = '0 mots/min';
  ui.query('[data-accuracy]').textContent = '0 %';
  ui.query('[data-correct]').textContent = '0 / 0';
  finalReport = '';
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Test de vitesse de frappe',
    description: 'Mesurez votre vitesse réelle et votre précision avec un exercice chronométré.',
    content: CONTENT,
  });
  duration = Number(ui.query('[data-duration]').value);
  resetSample();
  ui.on('change', (event) => {
    if (event.target.matches('[data-sample]')) {
      if (active) stop();
      resetSample();
    }
    if (event.target.matches('[data-duration]')) {
      duration = Number(event.target.value);
      resetSample();
    }
  });
  ui.on('input', (event) => {
    if (event.target.matches('[data-entry]')) {
      updateScore();
      const sample = SAMPLES[Number(ui.query('[data-sample]').value)];
      if (event.target.value.length >= sample.length) stop('sample');
    }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'start') {
      if (active) return;
      duration = Number(ui.query('[data-duration]').value);
      ui.query('[data-entry]').value = '';
      ui.query('[data-entry]').disabled = false;
      ui.query('[data-entry]').focus();
      ui.query('[data-sample]').disabled = true;
      ui.query('[data-duration]').disabled = true;
      ui.query('[data-action="start"]').disabled = true;
      ui.query('[data-action="stop"]').disabled = false;
      finalReport = '';
      startedAt = performance.now();
      active = true;
      tick();
      interval = ui.setInterval(tick, 200);
      ui.setStatus('Le test a commencé.', 'success');
    }
    if (action === 'stop' && active) stop();
    if (action === 'copy' || action === 'download') {
      if (!finalReport) { ui.setStatus('Terminez un test avant d’exporter son résultat.', 'error'); return; }
      if (action === 'copy') await ui.copy(finalReport, 'Résultat copié.');
      else ui.download(`${finalReport}\n`, 'test-de-frappe.txt');
    }
  });
}

export function unmount() {
  if (ui && interval !== null) ui.clearInterval(interval);
  ui?.destroy();
  ui = null;
  interval = null;
  active = false;
  finalReport = '';
}
