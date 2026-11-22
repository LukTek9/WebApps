import { createSecurityUI, escapeHtml } from './shared/security-tool-ui.js';

/** Taille en octets. */
const SIZE_UNITS = [
  ['o', 'octets (o)', 1],
  ['ko', 'Ko (1 000 o)', 1e3],
  ['Mo', 'Mo (1 000 000 o)', 1e6],
  ['Go', 'Go', 1e9],
  ['To', 'To', 1e12],
  ['Kio', 'Kio (1 024 o)', 1024],
  ['Mio', 'Mio', 1024 ** 2],
  ['Gio', 'Gio', 1024 ** 3],
  ['Tio', 'Tio', 1024 ** 4],
];

/** Débit en bits par seconde. */
const SPEED_UNITS = [
  ['kbit/s', 'kbit/s', 1e3],
  ['Mbit/s', 'Mbit/s', 1e6],
  ['Gbit/s', 'Gbit/s', 1e9],
  ['ko/s', 'ko/s (kilooctets / s)', 8e3],
  ['Mo/s', 'Mo/s (mégaoctets / s)', 8e6],
  ['Go/s', 'Go/s', 8e9],
];

const CONNECTIONS = [
  ['ADSL (8 Mbit/s)', 8e6],
  ['4G courante (30 Mbit/s)', 30e6],
  ['VDSL (50 Mbit/s)', 50e6],
  ['Wi-Fi / 4G+ (100 Mbit/s)', 100e6],
  ['Fibre 500 Mbit/s', 500e6],
  ['Fibre 1 Gbit/s', 1e9],
  ['Fibre 2 Gbit/s', 2e9],
  ['Réseau 10 Gbit/s', 10e9],
];

let ui;
let lastResult = null;

const sizeOptions = (selected) => SIZE_UNITS.map(([id, label]) => `<option value="${id}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
const speedOptions = (selected) => SPEED_UNITS.map(([id, label]) => `<option value="${id}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');

const CONTENT = `
  <div class="security-tools__panel">
    <div class="security-tools__controls">
      <label class="security-tools__field">Taille du fichier<input data-size type="text" inputmode="decimal" value="4" autocomplete="off"></label>
      <label class="security-tools__field">Unité de taille<select data-size-unit>${sizeOptions('Go')}</select></label>
      <label class="security-tools__field">Débit de la connexion<input data-speed type="text" inputmode="decimal" value="100" autocomplete="off"></label>
      <label class="security-tools__field">Unité de débit<select data-speed-unit>${speedOptions('Mbit/s')}</select></label>
      <label class="security-tools__field">Rendement réel (%)<input data-efficiency type="text" inputmode="decimal" value="90" autocomplete="off"></label>
    </div>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="copy" type="button" disabled>Copier le résultat</button>
      <button class="btn-secondary" data-action="download-csv" type="button" disabled>Télécharger en CSV</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Durée estimée</h3><p data-summary>Saisissez une taille et un débit.</p></div></div>
    <div class="security-tools__stats" data-stats></div>
    <div class="data-tools__table-wrap">
      <table class="data-tools__table" data-table hidden><thead><tr><th scope="col">Connexion</th><th scope="col">Durée</th></tr></thead><tbody data-body></tbody></table>
    </div>
    <p class="security-tools__hint">Estimation théorique : le débit réel varie selon le serveur, le Wi-Fi, la congestion et le protocole. Le rendement (90 % par défaut) tient compte de l’overhead réseau (TCP/IP, chiffrement).</p>
  </section>`;

function number(text, label, min, max) {
  const normalized = text.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!normalized) throw new Error(`${label} : valeur requise.`);
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalized)) throw new Error(`${label} : nombre invalide.`);
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} : valeur entre ${min} et ${max}.`);
  return value;
}

function duration(seconds) {
  if (seconds < 1) return `${(seconds * 1000).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} ms`;
  let rest = Math.round(seconds);
  const years = Math.floor(rest / 31536000); rest -= years * 31536000;
  const days = Math.floor(rest / 86400); rest -= days * 86400;
  const hours = Math.floor(rest / 3600); rest -= hours * 3600;
  const minutes = Math.floor(rest / 60); rest -= minutes * 60;
  const parts = [];
  if (years) parts.push(`${years} an${years > 1 ? 's' : ''}`);
  if (days) parts.push(`${days} j`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (rest || !parts.length) parts.push(`${rest} s`);
  return parts.slice(0, 4).join(' ');
}

function render() {
  const summary = ui.query('[data-summary]');
  const stats = ui.query('[data-stats]');
  const table = ui.query('[data-table]');
  const body = ui.query('[data-body]');
  const buttons = [...ui.root.querySelectorAll('[data-action]')];
  const sizeValue = number(ui.query('[data-size]').value, 'Taille', 0, 1e15);
  const speedValue = number(ui.query('[data-speed]').value, 'Débit', 0.000001, 1e15);
  const efficiency = number(ui.query('[data-efficiency]').value, 'Rendement', 1, 100) / 100;
  const sizeUnit = SIZE_UNITS.find(([id]) => id === ui.query('[data-size-unit]').value);
  const speedUnit = SPEED_UNITS.find(([id]) => id === ui.query('[data-speed-unit]').value);
  const bits = sizeValue * sizeUnit[2] * 8;
  const effectiveBps = speedValue * speedUnit[2] * efficiency;
  const seconds = bits / effectiveBps;
  const finish = new Date(Date.now() + seconds * 1000);
  const finishText = seconds < 31536000 * 50
    ? finish.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
    : 'au-delà de 50 ans';
  lastResult = { seconds, bits, effectiveBps, sizeValue, sizeUnit: sizeUnit[0], speedValue, speedUnit: speedUnit[0], efficiency };
  summary.textContent = `${duration(seconds)} pour télécharger ${sizeValue.toLocaleString('fr-FR')} ${sizeUnit[0]} à ${speedValue.toLocaleString('fr-FR')} ${speedUnit[0]}`;
  stats.innerHTML = [
    ['Durée estimée', duration(seconds)],
    ['Secondes', seconds.toLocaleString('fr-FR', { maximumFractionDigits: 2 })],
    ['Débit effectif', `${(effectiveBps / 8e6).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Mo/s`],
    ['Terminé le (si lancé maintenant)', finishText],
  ].map(([label, text]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(text)}</strong></article>`).join('');
  body.innerHTML = CONNECTIONS.map(([label, bps]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(duration(bits / (bps * efficiency)))}</td></tr>`).join('');
  table.hidden = false;
  buttons.forEach((button) => { button.disabled = false; });
}

function safeRender(activeUi) {
  try {
    render();
  } catch (error) {
    if (!activeUi.isActive()) return;
    lastResult = null;
    activeUi.query('[data-table]').hidden = true;
    activeUi.query('[data-stats]').innerHTML = '';
    activeUi.query('[data-summary]').textContent = 'Calcul impossible.';
    activeUi.root.querySelectorAll('[data-action]').forEach((button) => { button.disabled = true; });
    activeUi.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Calculateur de temps de téléchargement',
    description: 'Estimez la durée d’un téléchargement selon la taille du fichier, le débit et le rendement réel de la connexion.',
    content: CONTENT,
  });
  lastResult = null;
  const activeUi = ui;
  ui.on('input', (event) => {
    if (event.target.matches('[data-size], [data-speed], [data-efficiency]')) safeRender(activeUi);
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-size-unit], [data-speed-unit]')) safeRender(activeUi);
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || !lastResult) return;
    const r = lastResult;
    if (action === 'copy') {
      await ui.copy(`${r.sizeValue} ${r.sizeUnit} à ${r.speedValue} ${r.speedUnit} (rendement ${Math.round(r.efficiency * 100)} %) : ${duration(r.seconds)}`, 'Résultat copié.');
    }
    if (action === 'download-csv') {
      const rows = [['connexion', 'duree_secondes', 'duree'], ['Saisie utilisateur', Math.round(r.seconds), duration(r.seconds)],
        ...CONNECTIONS.map(([label, bps]) => [label, Math.round(r.bits / (bps * r.efficiency)), duration(r.bits / (bps * r.efficiency))])];
      ui.download(`\uFEFF${rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\r\n')}`, 'temps-telechargement.csv', 'text/csv;charset=utf-8');
    }
  });
  safeRender(ui);
}

export function unmount() {
  ui?.destroy();
  ui = null;
  lastResult = null;
}
