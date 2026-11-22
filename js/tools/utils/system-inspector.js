import { createSecurityUI } from '../shared/security-tool-ui.js';

let ui;
let report = [];

const CONTENT = `
  <section class="security-tools__panel">
    <div class="security-tools__actions"><button class="btn-primary" data-action="refresh" type="button">Actualiser les informations</button><button class="btn-secondary" data-action="copy" type="button">Copier le rapport</button><button class="btn-secondary" data-action="download" type="button">Télécharger le rapport</button></div>
    <p class="security-tools__hint">Informations fournies par le navigateur ; certaines données matérielles peuvent être masquées pour protéger la vie privée.</p>
    <div class="security-tools__stats" data-info></div>
  </section>`;

async function inspect() {
  const activeUi = ui;
  const connection = navigator.connection;
  const storageAvailable = (() => {
    const key = `webapps-inspector-${Date.now()}`;
    try { localStorage.setItem(key, '1'); localStorage.removeItem(key); return 'Disponible'; }
    catch { return 'Indisponible ou bloqué'; }
  })();
  const graphics = (() => {
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!context) return { status: 'WebGL indisponible', device: 'Non communiqué' };
      const extension = context.getExtension('WEBGL_debug_renderer_info');
      const device = extension
        ? `${context.getParameter(extension.UNMASKED_VENDOR_WEBGL)} · ${context.getParameter(extension.UNMASKED_RENDERER_WEBGL)}`
        : 'Non communiqué par le navigateur';
      return { status: 'WebGL disponible', device };
    } catch { return { status: 'WebGL indisponible', device: 'Non communiqué' }; }
  })();
  let batteryInfo = 'Non communiqué';
  if (typeof navigator.getBattery === 'function') {
    try {
      const battery = await navigator.getBattery();
      batteryInfo = `${Math.round(battery.level * 100)} %${battery.charging ? ' · en charge' : ''}`;
    } catch {
      batteryInfo = 'Non disponible';
    }
  }
  if (!activeUi.isActive()) return;
  report = [
    ['Navigateur', navigator.userAgentData?.brands?.map((item) => `${item.brand} ${item.version}`).join(', ') || navigator.userAgent],
    ['Plateforme', navigator.userAgentData?.platform || navigator.platform || 'Non communiquée'],
    ['Langue', navigator.language || 'Non communiquée'],
    ['Langues préférées', (navigator.languages || []).join(', ') || 'Non communiquées'],
    ['Écran', `${screen.width} × ${screen.height} px · ratio ${window.devicePixelRatio || 1}`],
    ['Fenêtre', `${window.innerWidth} × ${window.innerHeight} px`],
    ['Cœurs logiques', navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : 'Non communiqué'],
    ['Mémoire déclarée', navigator.deviceMemory ? `${navigator.deviceMemory} Go` : 'Non communiquée'],
    ['Connexion', navigator.onLine ? 'En ligne' : 'Hors ligne'],
    ['Réseau', connection ? `${connection.effectiveType || 'Type inconnu'} · ${connection.downlink || '?'} Mbit/s` : 'Non communiqué'],
    ['Batterie', batteryInfo],
    ['Écran tactile', navigator.maxTouchPoints ? `Oui · ${navigator.maxTouchPoints} point(s)` : 'Non détecté'],
    ['Cookies', navigator.cookieEnabled ? 'Activés' : 'Désactivés'],
    ['Stockage local', storageAvailable],
    ['Graphismes', graphics.status],
    ['Carte graphique', graphics.device],
  ];
  const container = activeUi.query('[data-info]');
  container.replaceChildren();
  for (const [label, value] of report) {
    const card = document.createElement('article');
    card.className = 'security-tools__stat';
    const heading = document.createElement('strong');
    heading.textContent = label;
    const detail = document.createElement('span');
    detail.textContent = value;
    card.append(heading, detail);
    container.append(card);
  }
  activeUi.setStatus('Rapport actualisé localement.', 'success');
}

function asText() {
  return report.map(([label, value]) => `${label} : ${value}`).join('\n');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Inspecteur système',
    description: 'Consultez les capacités que votre navigateur choisit de communiquer à cette page.',
    content: CONTENT,
  });
  inspect();
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'refresh') inspect();
    if (action === 'copy') await ui.copy(asText(), 'Rapport copié.');
    if (action === 'download') ui.download(`${asText()}\n`, 'rapport-navigateur.txt');
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = [];
}
