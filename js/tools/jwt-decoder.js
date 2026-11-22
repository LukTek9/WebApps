import { createSecurityUI } from './shared/security-tool-ui.js';

let ui;
let report = '';

const CONTENT = `
  <label class="security-tools__field">Jeton JWT<textarea class="tool-textarea security-tools__textarea" data-token rows="5" spellcheck="false" placeholder="Collez un jeton au format en-tête.charge-utile.signature…"></textarea></label>
  <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier l’analyse</button><button class="btn-secondary" data-action="download" type="button">Télécharger le rapport</button></div>
  <div class="security-tools__layout security-tools__layout--three">
    <section class="security-tools__panel"><div class="security-tools__panel-heading"><h3>En-tête</h3></div><pre class="security-tools__result" data-header>—</pre></section>
    <section class="security-tools__panel"><div class="security-tools__panel-heading"><h3>Charge utile</h3></div><pre class="security-tools__result" data-payload>—</pre></section>
    <section class="security-tools__panel"><div class="security-tools__panel-heading"><h3>Signature</h3></div><div class="security-tools__comparison" data-signature>En attente d’un jeton.</div></section>
  </div>
  <p class="security-tools__hint">Décoder ne vérifie pas la signature. Ne faites pas confiance aux déclarations avant validation côté serveur avec une clé de confiance.</p>`;

function decodeSegment(segment) {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function analyze() {
  const token = ui.query('[data-token]').value.trim();
  report = '';
  if (!token) {
    ['[data-header]', '[data-payload]'].forEach((selector) => { ui.query(selector).textContent = '—'; });
    ui.query('[data-signature]').textContent = 'En attente d’un jeton.';
    ui.setStatus('Collez un JWT pour afficher son contenu.');
    return;
  }
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1]) throw new Error('Un JWT compact doit contenir trois parties séparées par des points.');
    const header = decodeSegment(parts[0]);
    const payload = decodeSegment(parts[1]);
    if (!header || Array.isArray(header) || typeof header !== 'object') throw new Error('L’en-tête JWT doit être un objet JSON.');
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('La charge utile JWT doit être un objet JSON.');
    ui.query('[data-header]').textContent = JSON.stringify(header, null, 2);
    ui.query('[data-payload]').textContent = JSON.stringify(payload, null, 2);
    const now = Math.floor(Date.now() / 1000);
    const claims = [];
    for (const [claim, label] of [['iat', 'Émis le'], ['nbf', 'Valide à partir du'], ['exp', 'Expire le']]) {
      if (Number.isFinite(payload[claim])) claims.push(`${label} : ${new Date(payload[claim] * 1000).toLocaleString('fr-FR')}`);
    }
    const validity = Number.isFinite(payload.exp)
      ? payload.exp <= now ? 'Jeton expiré selon la déclaration exp.' : 'La déclaration exp indique que le jeton n’est pas encore expiré.'
      : 'Aucune déclaration exp.';
    ui.query('[data-signature]').textContent = `Algorithme déclaré : ${String(header.alg || 'absent')}\n${parts[2].length} caractères de signature\n${claims.join('\n')}${claims.length ? '\n' : ''}${validity}\nSignature non vérifiée.`;
    report = `En-tête\n${JSON.stringify(header, null, 2)}\n\nCharge utile\n${JSON.stringify(payload, null, 2)}\n\n${ui.query('[data-signature]').textContent}`;
    ui.setStatus('En-tête et charge utile décodés localement. Signature non vérifiée.', 'success');
  } catch (error) {
    ui.query('[data-header]').textContent = '—';
    ui.query('[data-payload]').textContent = '—';
    ui.query('[data-signature]').textContent = 'Impossible de décoder ce jeton.';
    ui.setStatus(error instanceof Error ? error.message : 'JWT invalide.', 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Décodeur JWT',
    description: 'Inspectez les déclarations, dates d’expiration et métadonnées d’un jeton sans appeler de service externe.',
    content: CONTENT,
  });
  report = '';
  ui.on('input', (event) => { if (event.target.matches('[data-token]')) analyze(); });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') await ui.copy(report, 'Analyse copiée.');
    if (action === 'download') {
      if (!report) { ui.setStatus('Décodez un jeton valide avant le téléchargement.', 'error'); return; }
      ui.download(report, 'analyse-jwt.txt');
    }
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
}
