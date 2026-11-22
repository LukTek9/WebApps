import { createSecurityUI, showError } from '../shared/security-tool-ui.js';

let ui;
let code = '';
let requestId = 0;

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Secret partagé (Base32)<input data-secret type="password" autocomplete="off" spellcheck="false" placeholder="JBSWY3DPEHPK3PXP"></label>
      <div class="security-tools__controls">
        <label class="security-tools__field">Algorithme<select data-algorithm><option>SHA-1</option><option>SHA-256</option><option>SHA-512</option></select></label>
        <label class="security-tools__field">Chiffres<select data-digits><option value="6">6 chiffres</option><option value="8">8 chiffres</option></select></label>
        <label class="security-tools__field">Période<select data-period><option value="30">30 secondes</option><option value="60">60 secondes</option></select></label>
      </div>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le code</button><button class="btn-secondary" data-action="download" type="button">Télécharger le code</button></div>
      <p class="security-tools__hint">Le secret ne quitte jamais cette page. Ne le partagez pas et ne téléchargez le code que sur un appareil de confiance.</p>
    </section>
    <section class="security-tools__panel security-tools__totp-panel">
      <div class="security-tools__panel-heading"><div><h3>Code à usage unique</h3><p>Renouvellement automatique selon les paramètres choisis.</p></div></div>
      <output class="security-tools__totp-code" data-code>••••••</output>
      <div class="security-tools__countdown"><span data-remaining>—</span><div class="security-tools__meter-bar" data-progress role="meter" aria-label="Temps restant" aria-valuemin="0" aria-valuemax="30" aria-valuenow="0"><span data-progress-fill></span></div></div>
      <p class="security-tools__hint" data-account>Entrez le secret Base32 fourni par votre service.</p>
    </section>
  </div>`;

function decodeBase32(secret) {
  const normalized = secret.toUpperCase().replace(/[\s=-]/g, '');
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('Le secret doit contenir uniquement des caractères Base32 A–Z et 2–7.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  const bytes = [];
  for (const char of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (!bytes.length) throw new Error('Le secret Base32 ne contient pas assez de données.');
  return new Uint8Array(bytes);
}

async function update(reportError = true) {
  const activeUi = ui;
  if (!activeUi?.isActive()) return;
  const request = ++requestId;
  const secret = activeUi.query('[data-secret]').value.trim();
  const period = Number(activeUi.query('[data-period]').value);
  const digits = Number(activeUi.query('[data-digits]').value);
  const now = Date.now();
  const remaining = period - Math.floor(now / 1000) % period;
  activeUi.query('[data-progress]').setAttribute('aria-valuemax', String(period));
  activeUi.query('[data-progress]').setAttribute('aria-valuenow', String(remaining));
  activeUi.query('[data-progress-fill]').style.width = `${remaining / period * 100}%`;
  activeUi.query('[data-remaining]').textContent = `Renouvellement dans ${remaining} s`;
  if (!secret) {
    code = '';
    activeUi.query('[data-code]').textContent = '•'.repeat(digits);
    activeUi.query('[data-account]').textContent = 'Entrez le secret Base32 fourni par votre service.';
    if (reportError) activeUi.setStatus('En attente d’un secret TOTP.');
    return;
  }
  try {
    const key = await crypto.subtle.importKey('raw', decodeBase32(secret), { name: 'HMAC', hash: activeUi.query('[data-algorithm]').value }, false, ['sign']);
    const counter = Math.floor(now / (period * 1000));
    const message = new ArrayBuffer(8);
    const view = new DataView(message);
    view.setUint32(0, Math.floor(counter / 0x100000000));
    view.setUint32(4, counter >>> 0);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
    if (!activeUi.isActive() || request !== requestId) return;
    const offset = mac[mac.length - 1] & 15;
    const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    code = String(binary % (10 ** digits)).padStart(digits, '0');
    activeUi.query('[data-code]').textContent = code;
    activeUi.query('[data-account]').textContent = `${activeUi.query('[data-algorithm]').value} · ${digits} chiffres · période de ${period} s`;
    if (reportError) activeUi.setStatus('Code calculé dans le navigateur.', 'success');
  } catch (error) {
    code = '';
    activeUi.query('[data-code]').textContent = '•'.repeat(digits);
    if (reportError) showError(activeUi, error, 'Impossible de calculer le code TOTP.');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de codes TOTP',
    description: 'Générez localement des codes de vérification à usage unique compatibles avec RFC 6238.',
    content: CONTENT,
  });
  code = '';
  requestId = 0;
  ui.on('input', (event) => { if (event.target.matches('[data-secret]')) update(); });
  ui.on('change', (event) => {
    if (event.target.matches('[data-algorithm], [data-digits], [data-period]')) update();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(code, 'Code TOTP copié.');
    if (action === 'download') {
      if (!code) { ui.setStatus('Saisissez un secret valide avant le téléchargement.', 'error'); return; }
      ui.download(`${code}\n`, 'code-totp.txt');
    }
  });
  update();
  ui.setInterval(() => update(false), 1000);
}

export function unmount() {
  requestId += 1;
  ui?.destroy();
  ui = null;
  code = '';
}
