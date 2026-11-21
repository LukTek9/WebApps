/**
 * pdf-protector.js — Protecteur de PDF (chiffrement par mot de passe) 100 % client.
 * Contrat : mount(container, ctx) / unmount().
 * Moteur : @cantoo/pdf-lib (fork de pdf-lib avec encrypt()), import ESM à la demande
 * avec bascule automatique entre CDN. Aucun envoi réseau des fichiers ni des mots de passe.
 * Note : import ESM (et non <script> UMD) pour ne pas écraser window.PDFLib utilisé par les autres outils.
 */

const LIB_URLS = [
  'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.3.2/+esm',
  'https://esm.sh/@cantoo/pdf-lib@2.3.2',
  'https://unpkg.com/@cantoo/pdf-lib@2.3.2/dist/pdf-lib.esm.min.js',
];

let libPromise = null; // cache du chargement paresseux
let s = null; // état de l'instance montée

const q = (id) => s?.root.querySelector('#pdfprot-' + id);
const refreshIcons = () => window.lucide?.createIcons();
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (b) =>
  b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(2)} Mo`;
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const tick = () => new Promise((r) => setTimeout(r)); // rend la main à l'UI

/** Charge @cantoo/pdf-lib (cache + fallback sur les URLs de secours). */
function loadLib() {
  if (!libPromise) {
    libPromise = (async () => {
      let lastErr;
      for (const url of LIB_URLS) {
        try {
          const mod = await import(/* @vite-ignore */ url);
          const lib = mod.PDFDocument ? mod : mod.default;
          if (lib?.PDFDocument?.prototype?.encrypt) return lib;
          lastErr = new Error('Version de pdf-lib sans chiffrement.');
        } catch (e) { lastErr = e; }
      }
      libPromise = null; // autorise une nouvelle tentative
      throw lastErr || new Error('Chargement de @cantoo/pdf-lib impossible (réseau / CDN).');
    })();
  }
  return libPromise;
}

function setStatus(msg = '', kind = '') {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pdfprot-status' + (kind ? ' is-' + kind : '');
}

function setProgress(pct) {
  const bar = q('bar');
  if (!bar) return;
  bar.classList.toggle('is-on', pct !== null);
  bar.firstElementChild.style.width = (pct ?? 0) + '%';
}

/** Force du mot de passe : niveau 0..4 selon longueur et variété de caractères. */
function strength(pw) {
  if (!pw) return { level: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (kinds >= 3) score++;
  if (kinds === 4 && pw.length >= 10) score++;
  const level = pw.length < 6 ? 1 : Math.max(1, Math.min(4, score));
  return { level, label: ['', 'Faible', 'Moyen', 'Bon', 'Très fort'][level] };
}

function updateStrength() {
  const { level, label } = strength(q('user').value);
  const box = q('strength');
  box.dataset.level = level;
  q('strength-label').textContent = label ? `Robustesse : ${label}` : '';
}

/** Mot de passe propriétaire aléatoire (si non fourni) : les permissions ne peuvent pas être levées sans lui. */
function randomPassword(n = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(buf, (v) => chars[v % chars.length]).join('');
}

/** Déclenche le téléchargement puis révoque l'URL Blob. */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  s.urls.add(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  const t = setTimeout(() => {
    URL.revokeObjectURL(url);
    s?.urls.delete(url);
    s?.timers.delete(t);
  }, 10000);
  s.timers.add(t);
}

function syncUi() {
  if (!s?.file) return;
  s.root.querySelectorAll('.pdfprot-panel input, .pdfprot-panel button').forEach((el) => (el.disabled = s.busy));
  q('go').disabled = s.busy;
  q('reset').disabled = s.busy;
}

/** Chargement du PDF : validation + détection d'un fichier déjà chiffré. */
async function loadFile(file) {
  if (!isPdf(file)) return setStatus('Fichier non PDF.', 'error');
  s.busy = true;
  try {
    setStatus('Chargement du moteur PDF…');
    const { PDFDocument } = await loadLib();
    setStatus('Lecture du PDF…');
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf); // lève si déjà chiffré / corrompu
    if (!s) return;
    s.file = file;
    s.buf = buf;
    s.pages = doc.getPageCount();
    s.busy = false;
    renderWork();
  } catch (e) {
    if (!s) return;
    s.busy = false;
    const enc = /encrypt/i.test(e?.message || '');
    setStatus(
      enc ? 'Ce PDF est déjà protégé : retirez d\'abord sa protection.' : 'PDF illisible ou corrompu : ' + (e?.message || e),
      'error'
    );
  }
}

/** Chiffrement : encrypt() puis save() → Blob → téléchargement. */
async function run() {
  if (!s.file || s.busy) return;
  const user = q('user').value;
  const ownerIn = q('owner').value;
  q('user').classList.toggle('is-invalid', !user);
  if (!user) return setStatus('Saisissez un mot de passe d\'ouverture.', 'error');

  const allow = { print: q('p-print').checked, copy: q('p-copy').checked, modify: q('p-modify').checked };
  s.busy = true;
  syncUi();
  setProgress(5);
  try {
    setStatus('Chargement du moteur PDF…');
    const { PDFDocument } = await loadLib();
    if (!s) return;
    setStatus('Lecture du PDF…');
    setProgress(25);
    await tick();
    const doc = await PDFDocument.load(s.buf);
    setStatus('Chiffrement du document…');
    setProgress(55);
    await tick();
    doc.encrypt({
      userPassword: user,
      ownerPassword: ownerIn || randomPassword(),
      permissions: {
        printing: allow.print ? 'highResolution' : false,
        copying: allow.copy,
        modifying: allow.modify,
        annotating: allow.modify,
        fillingForms: allow.modify,
        documentAssembly: allow.modify,
        contentAccessibility: true, // accessibilité (lecteurs d'écran) toujours autorisée
      },
    });
    setProgress(80);
    const bytes = await doc.save();
    if (!s) return;
    const name = s.file.name.replace(/\.pdf$/i, '') + '_protege.pdf';
    download(new Blob([bytes], { type: 'application/pdf' }), name);
    setProgress(100);
    setStatus(`Terminé : ${name} (${fmtSize(bytes.byteLength)}). Conservez bien votre mot de passe.`, 'ok');
  } catch (e) {
    if (s) {
      setProgress(null);
      setStatus('Échec du chiffrement : ' + (e?.message || e), 'error');
    }
  } finally {
    if (s) {
      s.busy = false;
      syncUi();
    }
  }
}

/** Réinitialise : libère buffer, URLs Blob, champs mot de passe ; retour à la zone de dépôt. */
function reset() {
  if (!s) return;
  s.timers.forEach(clearTimeout);
  s.timers.clear();
  s.urls.forEach((u) => URL.revokeObjectURL(u));
  s.urls.clear();
  s.file = null;
  s.buf = null;
  s.pages = 0;
  s.busy = false;
  renderDrop();
}

function renderDrop() {
  s.root.innerHTML = `
    <div class="pdfprot">
      <div class="pdfprot-drop" id="pdfprot-drop" tabindex="0" role="button" aria-label="Choisir un fichier PDF">
        <i data-lucide="upload-cloud"></i>
        <strong>Glissez-déposez votre PDF ici</strong>
        <small>ou cliquez pour parcourir · un seul fichier</small>
        <input id="pdfprot-input" type="file" accept="application/pdf" hidden />
      </div>
      <div class="pdfprot-status" id="pdfprot-status" role="status" aria-live="polite"></div>
    </div>`;
  const drop = q('drop');
  const input = q('input');
  const pick = (files) => {
    const f = [...files][0];
    if (f && !s.busy) loadFile(f);
  };
  drop.addEventListener('click', () => !s.busy && input.click());
  drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !s.busy) {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    pick(files);
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); })
  );
  drop.addEventListener('drop', (e) => pick(e.dataTransfer?.files ?? []));
  refreshIcons();
}

/** Champ mot de passe avec bouton afficher/masquer. */
const pwField = (id, label, hint, placeholder) => `
  <div class="pdfprot-field">
    <label for="pdfprot-${id}">${label}</label>
    <div class="pdfprot-input">
      <input id="pdfprot-${id}" type="password" autocomplete="new-password" spellcheck="false" placeholder="${placeholder}" />
      <button type="button" class="icon-btn" data-toggle="${id}" aria-label="Afficher le mot de passe" title="Afficher / masquer"><i data-lucide="eye"></i></button>
    </div>
    <span class="pdfprot-hint">${hint}</span>
  </div>`;

function renderWork() {
  const f = s.file;
  s.root.innerHTML = `
    <div class="pdfprot">
      <div class="pdfprot-file">
        <i data-lucide="file-lock"></i>
        <div class="pdfprot-file-txt">
          <div class="pdfprot-name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="pdfprot-meta">${s.pages} page${s.pages > 1 ? 's' : ''} · ${fmtSize(f.size)}</div>
        </div>
        <button type="button" class="btn-remove-file" id="pdfprot-reset"><i data-lucide="x"></i>Retirer</button>
      </div>
      <div class="pdfprot-panel">
        ${pwField('user', 'Mot de passe d\'ouverture', 'Requis pour ouvrir le document.', 'Choisissez un mot de passe')}
        <div class="pdfprot-strength" id="pdfprot-strength" data-level="0">
          <div class="pdfprot-strength-bar"><i></i><i></i><i></i><i></i></div>
          <span class="pdfprot-strength-label" id="pdfprot-strength-label"></span>
        </div>
        ${pwField('owner', 'Mot de passe propriétaire (optionnel)', 'Permet de lever les restrictions ci-dessous. Laissé vide, un mot de passe aléatoire est généré et non conservé.', 'Facultatif')}
        <fieldset class="pdfprot-perms">
          <legend>Autorisations pour qui ouvre le PDF</legend>
          <label class="pdfprot-check"><input type="checkbox" id="pdfprot-p-print" checked /> Autoriser l'impression</label>
          <label class="pdfprot-check"><input type="checkbox" id="pdfprot-p-copy" checked /> Autoriser la copie du contenu</label>
          <label class="pdfprot-check"><input type="checkbox" id="pdfprot-p-modify" /> Autoriser la modification</label>
          <span class="pdfprot-hint">Les restrictions sont respectées par la plupart des lecteurs PDF, mais seul le mot de passe d'ouverture garantit la confidentialité.</span>
        </fieldset>
      </div>
      <div class="pdfprot-bar" id="pdfprot-bar"><i></i></div>
      <div class="pdfprot-status" id="pdfprot-status" role="status" aria-live="polite"></div>
      <div class="pdfprot-actions">
        <button type="button" class="btn-primary" id="pdfprot-go"><i data-lucide="lock"></i>Protéger &amp; télécharger</button>
      </div>
    </div>`;
  q('reset').addEventListener('click', reset);
  q('go').addEventListener('click', run);
  q('user').addEventListener('input', () => {
    q('user').classList.remove('is-invalid');
    updateStrength();
  });
  q('user').addEventListener('keydown', (e) => e.key === 'Enter' && run());
  s.root.querySelectorAll('[data-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const input = q(btn.dataset.toggle);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
      btn.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}"></i>`;
      refreshIcons();
    })
  );
  syncUi();
  refreshIcons();
  q('user').focus();
}

export function mount(container, ctx) {
  s = { root: container, ctx, file: null, buf: null, pages: 0, busy: false, urls: new Set(), timers: new Set() };
  renderDrop();
}

export function unmount() {
  if (!s) return;
  s.timers.forEach(clearTimeout);
  s.urls.forEach((u) => URL.revokeObjectURL(u)); // libération mémoire Blob
  s.buf = null;
  s.root.innerHTML = ''; // détruit aussi les champs mot de passe
  s = null;
}
