import { createSecurityUI } from './shared/security-tool-ui.js';

let ui;
let interval = null;
let running = false;
let startedAt = 0;
let elapsed = 0;
let laps = [];
let audioContext = null;

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Mode<select data-mode><option value="stopwatch">Chronomètre</option><option value="timer">Minuteur</option></select></label>
      <div class="security-tools__controls" data-timer-inputs hidden>
        <label class="security-tools__field">Minutes<input data-minutes type="number" min="0" max="999" value="5"></label>
        <label class="security-tools__field">Secondes<input data-seconds type="number" min="0" max="59" value="0"></label>
      </div>
      <div class="utility-tools__timer" data-display aria-live="polite">00:00.00</div>
      <div class="security-tools__actions"><button class="btn-primary" data-action="start" type="button">Démarrer</button><button class="btn-secondary" data-action="pause" type="button" disabled>Pause</button><button class="btn-secondary" data-action="reset" type="button">Réinitialiser</button><button class="btn-secondary" data-action="lap" type="button" disabled>Tour</button></div>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier les temps</button><button class="btn-secondary" data-action="download" type="button">Télécharger</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Temps intermédiaires</h3><p>Les tours sont disponibles en mode chronomètre.</p></div></div>
      <ol class="utility-tools__laps" data-laps><li class="security-tools__hint">Aucun tour enregistré.</li></ol>
    </section>
  </div>`;

function formatTime(milliseconds, hundredths = true) {
  const total = Math.max(0, Math.floor(milliseconds));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor(total % 60000 / 1000);
  const fraction = Math.floor(total % 1000 / 10);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${hundredths ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}

function currentElapsed() {
  return running ? elapsed + performance.now() - startedAt : elapsed;
}

function renderLaps() {
  const list = ui.query('[data-laps]');
  list.replaceChildren();
  if (!laps.length) {
    const empty = document.createElement('li');
    empty.className = 'security-tools__hint';
    empty.textContent = 'Aucun tour enregistré.';
    list.append(empty);
    return;
  }
  laps.forEach((lap, index) => {
    const row = document.createElement('li');
    row.textContent = `Tour ${index + 1} · ${formatTime(lap.split)} · total ${formatTime(lap.total)}`;
    list.append(row);
  });
}

function update() {
  const mode = ui.query('[data-mode]').value;
  const current = currentElapsed();
  if (mode === 'timer') {
    const remaining = Math.max(0, getDuration() - current);
    ui.query('[data-display]').textContent = formatTime(remaining);
    if (remaining <= 0 && running) finishTimer();
  } else {
    ui.query('[data-display]').textContent = formatTime(current);
  }
}

function getDuration() {
  const minutes = Number(ui.query('[data-minutes]').value);
  const seconds = Number(ui.query('[data-seconds]').value);
  if (!Number.isInteger(minutes) || minutes < 0 || !Number.isInteger(seconds) || seconds < 0 || seconds > 59 || minutes * 60 + seconds < 1) {
    throw new Error('Choisissez une durée valide d’au moins une seconde.');
  }
  return (minutes * 60 + seconds) * 1000;
}

function setRunning(value) {
  running = value;
  ui.query('[data-action="start"]').disabled = value;
  ui.query('[data-action="pause"]').disabled = !value;
  ui.query('[data-action="lap"]').disabled = !value || ui.query('[data-mode]').value !== 'stopwatch';
  ui.query('[data-mode]').disabled = value;
  ui.query('[data-timer-inputs]').hidden = ui.query('[data-mode]').value !== 'timer';
  ui.query('[data-minutes]').disabled = value;
  ui.query('[data-seconds]').disabled = value;
  if (value) {
    startedAt = performance.now();
    interval = ui.setInterval(update, 50);
  } else if (interval !== null) {
    ui.clearInterval(interval);
    interval = null;
  }
}

function finishTimer() {
  elapsed = getDuration();
  setRunning(false);
  ui.query('[data-display]').textContent = formatTime(0);
  ui.setStatus('Le minuteur est terminé.', 'success');
  if (audioContext?.state === 'running') {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.08;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.35);
  }
}

function summary() {
  const current = currentElapsed();
  return [
    `${ui.query('[data-mode]').value === 'timer' ? 'Minuteur' : 'Chronomètre'} · ${formatTime(ui.query('[data-mode]').value === 'timer' ? Math.max(0, getDuration() - current) : current)}`,
    ...laps.map((lap, index) => `Tour ${index + 1} · ${formatTime(lap.split)} · total ${formatTime(lap.total)}`),
  ].join('\n');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Chronomètre & Minuteur',
    description: 'Chronométrez vos activités, marquez des tours ou lancez un compte à rebours sonore.',
    content: CONTENT,
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-mode]')) {
      ui.query('[data-timer-inputs]').hidden = event.target.value !== 'timer';
      elapsed = 0;
      laps = [];
      update();
      renderLaps();
    }
    if (event.target.matches('[data-minutes], [data-seconds]')) {
      try { update(); }
      catch (error) { ui.setStatus(error.message, 'error'); }
    }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'start') {
      const activeUi = ui;
      try {
        if (ui.query('[data-mode]').value === 'timer') getDuration();
        if (!audioContext && (window.AudioContext || window.webkitAudioContext)) {
          const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
          audioContext = new AudioContextConstructor();
          await audioContext.resume();
        }
        if (!activeUi.isActive()) return;
        setRunning(true);
        update();
        ui.setStatus('Chronométrage en cours.', 'success');
      } catch (error) {
        if (activeUi.isActive()) activeUi.setStatus(error.message, 'error');
      }
    }
    if (action === 'pause' && running) {
      elapsed += performance.now() - startedAt;
      setRunning(false);
      update();
      ui.setStatus('Chronométrage en pause.', 'muted');
    }
    if (action === 'reset') {
      setRunning(false);
      elapsed = 0;
      laps = [];
      update();
      renderLaps();
      ui.setStatus('Chronomètre réinitialisé.', 'muted');
    }
    if (action === 'lap' && running) {
      const current = currentElapsed();
      const previous = laps.reduce((sum, lap) => sum + lap.split, 0);
      laps.push({ total: current, split: current - previous });
      renderLaps();
    }
    if (action === 'copy' || action === 'download') {
      try {
        const text = summary();
        if (action === 'copy') await ui.copy(text, 'Temps copiés.');
        else ui.download(`${text}\n`, 'chronometre-minuteur.txt');
      } catch (error) { ui.setStatus(error.message, 'error'); }
    }
  });
  ui.query('[data-mode]').dispatchEvent(new Event('change', { bubbles: true }));
  ui.query('[data-timer-inputs]').hidden = true;
}

export function unmount() {
  if (ui && interval !== null) ui.clearInterval(interval);
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  ui?.destroy();
  ui = null;
  interval = null;
  running = false;
  elapsed = 0;
  laps = [];
  audioContext = null;
}
