import { createSecurityUI } from '../shared/security-tool-ui.js';

let ui;
let interval;
let zones = [];

const AVAILABLE_ZONES = {
  'Europe/Paris': 'Paris',
  'Europe/London': 'Londres',
  'America/Montreal': 'Montréal',
  'America/New_York': 'New York',
  'America/Los_Angeles': 'Los Angeles',
  'America/Sao_Paulo': 'São Paulo',
  'Asia/Tokyo': 'Tokyo',
  'Asia/Shanghai': 'Shanghai',
  'Asia/Dubai': 'Dubaï',
  'Australia/Sydney': 'Sydney',
};

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Ville à ajouter<select data-zone>${Object.entries(AVAILABLE_ZONES).map(([zone, city]) => `<option value="${zone}">${city}</option>`).join('')}</select></label>
      <div class="security-tools__actions"><button class="btn-primary" data-action="add" type="button">Ajouter la ville</button><button class="btn-secondary" data-action="copy" type="button">Copier les heures</button><button class="btn-secondary" data-action="download" type="button">Télécharger</button></div>
      <p class="security-tools__hint">Les heures sont actualisées chaque seconde et suivent les changements d’heure de chaque ville.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Heures locales</h3><p data-now></p></div></div>
      <div class="security-tools__stats" data-clocks></div>
    </section>
  </div>`;

function render() {
  if (!ui?.isActive()) return;
  const container = ui.query('[data-clocks]');
  container.replaceChildren();
  const now = new Date();
  ui.query('[data-now]').textContent = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'long' }).format(now);
  for (const zone of zones) {
    const card = document.createElement('article');
    card.className = 'security-tools__stat';
    const heading = document.createElement('strong');
    heading.textContent = AVAILABLE_ZONES[zone];
    const time = document.createElement('span');
    time.textContent = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'medium', timeZone: zone }).format(now);
    const date = document.createElement('span');
    date.textContent = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeZone: zone }).format(now);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-secondary';
    remove.dataset.remove = zone;
    remove.textContent = 'Retirer';
    card.append(heading, time, date, remove);
    container.append(card);
  }
}

function textSnapshot() {
  const now = new Date();
  return zones.map((zone) => `${AVAILABLE_ZONES[zone]} · ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'medium', timeZone: zone }).format(now)} (${zone})`).join('\n');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Horloges mondiales',
    description: 'Comparez les heures locales de plusieurs villes, mises à jour en temps réel.',
    content: CONTENT,
  });
  zones = ['Europe/Paris', 'America/New_York', 'Asia/Tokyo'];
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const removeZone = event.target.closest('[data-remove]')?.dataset.remove;
    if (action === 'add') {
      const zone = ui.query('[data-zone]').value;
      if (!zones.includes(zone)) zones.push(zone);
      else ui.setStatus(`${AVAILABLE_ZONES[zone]} est déjà affichée.`, 'error');
      render();
    } else if (removeZone) {
      zones = zones.filter((zone) => zone !== removeZone);
      render();
    } else if (action === 'copy') {
      const snapshot = textSnapshot();
      if (snapshot) await ui.copy(snapshot, 'Horaires copiés.');
      else ui.setStatus('Ajoutez au moins une ville avant de copier.', 'error');
    } else if (action === 'download') {
      const snapshot = textSnapshot();
      if (snapshot) ui.download(`${snapshot}\n`, 'horloges-mondiales.txt');
      else ui.setStatus('Ajoutez au moins une ville avant le téléchargement.', 'error');
    }
  });
  render();
  interval = ui.setInterval(render, 1000);
}

export function unmount() {
  if (ui && interval !== null && interval !== undefined) ui.clearInterval(interval);
  ui?.destroy();
  ui = null;
  interval = null;
  zones = [];
}
