import { createSecurityUI, showError } from '../shared/security-tool-ui.js';

let ui;
let publicPem = '';
let privatePem = '';
let generation = 0;

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Type de clé<select data-algorithm><option value="rsa2048">RSA-OAEP · 2048 bits</option><option value="rsa4096">RSA-OAEP · 4096 bits</option><option value="ecdsa">ECDSA · courbe P-256</option></select></label>
      <div class="security-tools__actions"><button class="btn-primary" data-action="generate" type="button">Générer une paire de clés</button></div>
      <p class="security-tools__hint">Les clés sont générées et restent dans cette page. La clé privée exportée n’est pas chiffrée : conservez-la dans un emplacement protégé.</p>
      <div class="security-tools__stats" data-meta><article class="security-tools__stat"><span>Algorithme</span><strong>RSA-OAEP 2048</strong></article><article class="security-tools__stat"><span>État</span><strong>En attente</strong></article></div>
    </section>
    <section class="security-tools__panel"><div class="security-tools__panel-heading"><div><h3>Clé publique</h3><p>Format PEM · SPKI</p></div></div>
      <pre class="security-tools__result security-tools__key" data-public></pre>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy-public" type="button">Copier</button><button class="btn-secondary" data-action="save-public" type="button">Télécharger</button></div>
    </section>
    <section class="security-tools__panel"><div class="security-tools__panel-heading"><div><h3>Clé privée</h3><p>Format PEM · PKCS#8</p></div></div>
      <pre class="security-tools__result security-tools__key" data-private></pre>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy-private" type="button">Copier</button><button class="btn-secondary" data-action="save-private" type="button">Télécharger</button></div>
    </section>
  </div>`;

function toPem(label, bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function generate() {
  const activeUi = ui;
  const request = ++generation;
  const algorithm = activeUi.query('[data-algorithm]').value;
  const button = activeUi.query('[data-action="generate"]');
  const selector = activeUi.query('[data-algorithm]');
  publicPem = '';
  privatePem = '';
  activeUi.query('[data-public]').textContent = '';
  activeUi.query('[data-private]').textContent = '';
  button.disabled = true;
  selector.disabled = true;
  activeUi.setStatus('Génération de la paire de clés…');
  activeUi.query('[data-meta]').lastElementChild.lastElementChild.textContent = 'Génération…';
  try {
    const ecdsa = algorithm === 'ecdsa';
    const pair = await crypto.subtle.generateKey(
      ecdsa
        ? { name: 'ECDSA', namedCurve: 'P-256' }
        : { name: 'RSA-OAEP', modulusLength: algorithm === 'rsa4096' ? 4096 : 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ecdsa ? ['sign', 'verify'] : ['encrypt', 'decrypt'],
    );
    const exportedPublic = toPem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey));
    const exportedPrivate = toPem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    if (!activeUi.isActive() || request !== generation) return;
    publicPem = exportedPublic;
    privatePem = exportedPrivate;
    activeUi.query('[data-public]').textContent = publicPem;
    activeUi.query('[data-private]').textContent = privatePem;
    activeUi.query('[data-meta]').firstElementChild.lastElementChild.textContent = ecdsa ? 'ECDSA P-256' : `RSA-OAEP ${algorithm === 'rsa4096' ? '4096' : '2048'}`;
    activeUi.query('[data-meta]').lastElementChild.lastElementChild.textContent = 'Prête à exporter';
    activeUi.setStatus('Paire de clés générée localement.', 'success');
  } catch (error) {
    if (activeUi.isActive()) activeUi.query('[data-meta]').lastElementChild.lastElementChild.textContent = 'Échec de génération';
    throw error;
  } finally {
    if (activeUi.isActive() && request === generation) {
      button.disabled = false;
      selector.disabled = false;
    }
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de clés RSA / ECDSA',
    description: 'Créez une paire de clés WebCrypto et exportez les clés au format PEM.',
    content: CONTENT,
  });
  publicPem = '';
  privatePem = '';
  generation = 0;
  ui.on('click', async (event) => {
    const activeUi = ui;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'generate') {
      try { await generate(); } catch (error) { showError(activeUi, error, 'La génération de clés a échoué.'); }
    }
    if (action === 'copy-public') await ui.copy(publicPem, 'Clé publique copiée.');
    if (action === 'copy-private') await ui.copy(privatePem, 'Clé privée copiée.');
    if (action === 'save-public') {
      if (!publicPem) { ui.setStatus('Générez une paire avant l’export.', 'error'); return; }
      ui.download(publicPem, 'cle-publique.pem');
    }
    if (action === 'save-private') {
      if (!privatePem) { ui.setStatus('Générez une paire avant l’export.', 'error'); return; }
      ui.download(privatePem, 'cle-privee.pem');
    }
  });
}

export function unmount() {
  generation += 1;
  ui?.destroy();
  ui = null;
  publicPem = '';
  privatePem = '';
}
