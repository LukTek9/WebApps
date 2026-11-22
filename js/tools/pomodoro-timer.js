import { createSecurityUI } from './security-tool-ui.js';

let ui;
let interval = null;
let running = false;
let startedAt = 0;
let remaining = 0;
let phase = 'focus';
let completedFocus = 0;

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Concentration (min)<input data-focus type="number" min="1" max="180" value="25"></label>
        <label class="security-tools__field">Pause courte (min)<input data-short type="number" min="1" max="60" value="5"></label>
        <label class="security-tools__field">Pause longue (min)<input data-long type="number" min="1" max="60" value="15"></label>
        <label class="security-tools__field">Pause longue après<input data-cycle type="number" min="2" max="12" value="4"></label>
      </div>
      <div class="utility-tools__pomodoro">
        <p data-phase>Concentration</p>
        <div class="utility-tools__timer" data-time aria-live="polite">25:00</div>
        <p><span data-completed>0</span> session(s) de concentration terminée(s)</p>
      </div>
      <div class="security-tools__actions"><button class="btn-primary" data-action="start" type="button">Démarrer</button><button class="btn-secondary" data-action="skip" type="button">Passer à l’étape suivante</button><button class="btn-secondary" data-action="reset" type="button">Réinitialiser</button></div>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier la session</button><button class="btn-secondary" data-action="download" type="button">Télécharger le bilan</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Cycle Pomodoro</h3><p>Une pause longue est proposée après le nombre de sessions choisi.</p></div></div>
      <ol class="utility-tools__phase-list" data-phases></ol>
    </section>
  </div>`;

function phaseDuration(name = phase) {
  const field = name === 'focus' ? '[data-focus]' : name === 'short' ? '[data-short]' : '[data-long]';
  return Number(ui.query(field).value) * 60;
}

function validateSettings() {
  const settings = [
    ['Concentration', ui.query('[data-focus]'), 1, 180],
    ['Pause courte', ui.query('[data-short]'), 1, 60],
    ['Pause longue', ui.query('[data-long]'), 1, 60],
    ['Nombre de sessions', ui.query('[data-cycle]'), 2, 12],
  ];
  for (const [label, field, min, max] of settings) {
    const value = Number(field.value);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} : choisissez un entier entre ${min} et ${max}.`);
  }
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function update() {
  const current = running ? remaining - (performance.now() - startedAt) / 1000 : remaining;
  ui.query('[data-time]').textContent = formatTime(current);
  if (current <= 0 && running) advance();
}

function setRunning(value) {
  running = value;
  ui.query('[data-action="start"]').textContent = value ? 'Mettre en pause' : 'Démarrer';
  for (const selector of ['[data-focus]', '[data-short]', '[data-long]', '[data-cycle]']) ui.query(selector).disabled = value;
  if (value) {
    startedAt = performance.now();
    interval = ui.setInterval(update, 250);
  } else if (interval !== null) {
    remaining = Math.max(0, remaining - (performance.now() - startedAt) / 1000);
    ui.clearInterval(interval);
    interval = null;
  }
}

function renderPhases() {
  const list = ui.query('[data-phases]');
  list.replaceChildren();
  const count = Number(ui.query('[data-cycle]').value);
  for (let index = 1; index <= count; index += 1) {
    const item = document.createElement('li');
    item.textContent = `Session ${index} : concentration${index === count ? ' · suivie d’une pause longue' : ' · suivie d’une pause courte'}`;
    if (index <= completedFocus) item.dataset.state = 'done';
    list.append(item);
  }
}

function advance() {
  if (phase === 'focus') {
    completedFocus += 1;
    const cycle = Number(ui.query('[data-cycle]').value);
    phase = completedFocus % cycle === 0 ? 'long' : 'short';
  } else {
    phase = 'focus';
  }
  remaining = phaseDuration();
  ui.query('[data-phase]').textContent = phase === 'focus' ? 'Concentration' : phase === 'short' ? 'Pause courte' : 'Pause longue';
  ui.query('[data-completed]').textContent = String(completedFocus);
  renderPhases();
  ui.setStatus(phase === 'focus' ? 'Nouvelle session de concentration.' : 'Temps de pause.', 'success');
  if (running) startedAt = performance.now();
  update();
}

function summary() {
  const displayed = running ? Math.max(0, remaining - (performance.now() - startedAt) / 1000) : remaining;
  return `Sessions de concentration terminées : ${completedFocus}\nÉtape en cours : ${ui.query('[data-phase]').textContent}\nTemps restant : ${formatTime(displayed)}\nDurées configurées : ${ui.query('[data-focus]').value} / ${ui.query('[data-short]').value} / ${ui.query('[data-long]').value} min`;
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Minuteur Pomodoro',
    description: 'Réglez vos durées de concentration et de pause, puis suivez votre cycle en direct.',
    content: CONTENT,
  });
  phase = 'focus';
  completedFocus = 0;
  remaining = phaseDuration();
  renderPhases();
  ui.on('input', (event) => {
    if (event.target.matches('[data-focus], [data-short], [data-long]')) {
      try {
        validateSettings();
        if (phase === 'focus') remaining = phaseDuration();
        ui.query('[data-time]').textContent = formatTime(remaining);
        ui.setStatus('Durées actualisées.', 'muted');
      } catch (error) { ui.setStatus(error.message, 'error'); }
    }
    if (event.target.matches('[data-cycle]')) renderPhases();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'start') {
      if (running) {
        setRunning(false);
        ui.query('[data-action="start"]').textContent = 'Reprendre';
        ui.setStatus('Minuteur en pause.', 'muted');
      } else {
        try {
          validateSettings();
          if (remaining <= 0) remaining = phaseDuration();
          setRunning(true);
          update();
          ui.setStatus('Cycle en cours.', 'success');
        } catch (error) { ui.setStatus(error.message, 'error'); }
      }
    }
    if (action === 'skip') {
      if (running) setRunning(false);
      advance();
    }
    if (action === 'reset') {
      setRunning(false);
      phase = 'focus';
      completedFocus = 0;
      try {
        validateSettings();
        remaining = phaseDuration();
        ui.query('[data-phase]').textContent = 'Concentration';
        ui.query('[data-completed]').textContent = '0';
        ui.query('[data-action="start"]').textContent = 'Démarrer';
        ui.query('[data-time]').textContent = formatTime(remaining);
        renderPhases();
        ui.setStatus('Cycle réinitialisé.', 'muted');
      } catch (error) { ui.setStatus(error.message, 'error'); }
    }
    if (action === 'copy' || action === 'download') {
      if (action === 'copy') await ui.copy(summary(), 'Bilan copié.');
      else ui.download(`${summary()}\n`, 'bilan-pomodoro.txt');
    }
  });
}

export function unmount() {
  if (ui && interval !== null) ui.clearInterval(interval);
  ui?.destroy();
  ui = null;
  interval = null;
  running = false;
  remaining = 0;
  completedFocus = 0;
}
