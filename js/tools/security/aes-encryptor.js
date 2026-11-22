import { createSecurityUI, showError } from '../shared/security-tool-ui.js';

let ui;
let result = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__controls">
        <label class="security-tools__field">Opération<select data-mode><option value="encrypt">Chiffrer un texte</option><option value="decrypt">Déchiffrer un paquet</option></select></label>
        <label class="security-tools__field">Phrase secrète<input data-password type="password" autocomplete="new-password" placeholder="Utilisez une phrase secrète forte"></label>
      </div>
      <label class="security-tools__field" data-input-label>Texte à chiffrer<textarea class="tool-textarea security-tools__textarea" data-input rows="7" placeholder="Saisissez le texte à protéger…"></textarea></label>
      <div class="security-tools__actions"><button class="btn-primary" data-action="run" type="button">Lancer le chiffrement</button><button class="btn-secondary" data-action="copy" type="button">Copier le résultat</button><button class="btn-secondary" data-action="download" type="button">Télécharger le résultat</button></div>
      <p class="security-tools__hint">AES-256-GCM · dérivation PBKDF2-SHA-256 (310 000 itérations). Gardez votre phrase secrète : elle ne peut pas être récupérée.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Résultat</h3><p data-result-meta>Prêt à traiter localement.</p></div></div>
      <pre class="security-tools__result" data-output></pre>
    </section>
  </div>`;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function deriveKey(password, salt, usage, iterations = 310000) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

async function run() {
  const activeUi = ui;
  const password = activeUi.query('[data-password]').value;
  const input = activeUi.query('[data-input]').value;
  if (!password) throw new Error('Saisissez une phrase secrète.');
  if (!input) throw new Error('Saisissez un texte ou un paquet à traiter.');
  const mode = activeUi.query('[data-mode]').value;
  const button = activeUi.query('[data-action="run"]');
  const controls = [activeUi.query('[data-mode]'), activeUi.query('[data-password]'), activeUi.query('[data-input]')];
  result = '';
  activeUi.query('[data-output]').textContent = '';
  activeUi.query('[data-result-meta]').textContent = 'Opération en cours…';
  button.disabled = true;
  controls.forEach((control) => { control.disabled = true; });
  activeUi.setStatus('Calcul cryptographique en cours…');
  let output;
  try {
    if (mode === 'encrypt') {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(password, salt, 'encrypt');
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(input)));
      output = `aesgcm1.${toBase64Url(salt)}.${toBase64Url(iv)}.${toBase64Url(cipher)}`;
    } else {
      const legacy = input.trim().startsWith('aes:');
      const parts = legacy ? input.trim().split(':') : input.trim().split('.');
      if (legacy ? parts.length !== 4 : parts.length !== 4 || parts[0] !== 'aesgcm1') {
        throw new Error('Format invalide : fournissez un paquet aesgcm1 complet ou un paquet aes: hérité.');
      }
      const [, saltText, ivText, cipherText] = parts;
      const salt = fromBase64Url(saltText);
      const iv = fromBase64Url(ivText);
      if (salt.length !== 16 || iv.length !== 12) throw new Error('Paquet invalide : sel ou vecteur d’initialisation incorrect.');
      const key = await deriveKey(password, salt, 'decrypt', legacy ? 250000 : 310000);
      output = decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromBase64Url(cipherText)));
    }
    if (!activeUi.isActive()) return;
    result = output;
    activeUi.query('[data-result-meta]').textContent = mode === 'encrypt'
      ? `Texte chiffré · ${encoder.encode(input).length.toLocaleString('fr-FR')} octets avant chiffrement`
      : `Texte déchiffré · ${encoder.encode(output).length.toLocaleString('fr-FR')} octets`;
    activeUi.query('[data-output]').textContent = output;
    activeUi.setStatus(mode === 'encrypt' ? 'Chiffrement terminé. Le paquet peut être conservé hors ligne.' : 'Déchiffrement authentifié terminé.', 'success');
  } catch (error) {
    if (activeUi.isActive()) activeUi.query('[data-result-meta]').textContent = 'Opération échouée.';
    throw error;
  } finally {
    if (activeUi.isActive()) {
      button.disabled = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Chiffreur / Déchiffreur AES',
    description: 'Protégez et récupérez du texte avec AES-GCM et une phrase secrète choisie par vous.',
    content: CONTENT,
  });
  result = '';
  ui.on('change', (event) => {
    if (!event.target.matches('[data-mode]')) return;
    const decrypt = event.target.value === 'decrypt';
    ui.query('[data-input-label]').firstChild.textContent = decrypt ? 'Paquet chiffré à déchiffrer' : 'Texte à chiffrer';
    ui.query('[data-input]').placeholder = decrypt ? 'Collez un paquet aesgcm1… ou aes:…' : 'Saisissez le texte à protéger…';
    ui.query('[data-action="run"]').textContent = decrypt ? 'Lancer le déchiffrement' : 'Lancer le chiffrement';
    result = '';
    ui.query('[data-output]').textContent = '';
    ui.query('[data-result-meta]').textContent = 'Prêt à traiter localement.';
  });
  ui.on('input', (event) => {
    if (event.target.matches('[data-input]')) ui.query('[data-result-meta]').textContent = `${event.target.value.length.toLocaleString('fr-FR')} caractères en entrée`;
  });
  ui.on('click', async (event) => {
    const activeUi = ui;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'run') {
      try { await run(); } catch (error) { showError(activeUi, error, 'Opération impossible. Vérifiez la phrase secrète et le paquet.'); }
    }
    if (action === 'copy') await ui.copy(result, 'Résultat copié.');
    if (action === 'download') {
      if (!result) { ui.setStatus('Lancez une opération avant le téléchargement.', 'error'); return; }
      ui.download(result, ui.query('[data-mode]').value === 'encrypt' ? 'texte-chiffre.aes' : 'texte-dechiffre.txt');
    }
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  result = '';
}
