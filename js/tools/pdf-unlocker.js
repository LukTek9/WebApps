/**
 * pdf-unlocker.js — Suppresseur de mots de passe PDF 100 % client.
 * Contrat : mount(container, ctx) / unmount().
 * Moteur : @cantoo/pdf-lib (fork de pdf-lib gérant le déchiffrement), import ESM à la demande
 * avec bascule automatique entre CDN. Aucun envoi réseau des fichiers ni des mots de passe.
 * Note : import ESM (et non <script> UMD) pour ne pas écraser window.PDFLib utilisé par les autres outils.
 */

const LIB_URLS = [
  'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.3.2/+esm',
  'https://esm.sh/@cantoo/pdf-lib@2.3.2',
  'https://unpkg.com/@cantoo/pdf-lib@2.3.2/dist/pdf-lib.esm.min.js',
];
const PDFJS_BASES = [
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379',
  'https://unpkg.com/pdfjs-dist@4.0.379',
];
const RASTER_SCALE = 2; // résolution du rendu de secours (pdf.js)
const RASTER_MAX_PX = 8000; // plafond de dimension canvas (évite les échecs mémoire)
const TAIL_BYTES = 131072; // zone de fin de fichier analysée pour repérer /Encrypt (trailer)

let libPromise = null; // cache du chargement paresseux
let pdfJsPromise = null; // cache pdf.js (fallback)
let workerBlobUrl = null; // blob du worker pdf.js (révoqué au unmount)
let s = null; // état de l'instance montée

const q = (id) => s?.root.querySelector('#pdfunl-' + id);
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
          if (lib?.PDFDocument) return lib;
          lastErr = new Error('pdf-lib indisponible.');
        } catch (e) { lastErr = e; }
      }
      libPromise = null; // autorise une nouvelle tentative
      throw lastErr || new Error('Chargement de @cantoo/pdf-lib impossible (réseau / CDN).');
    })();
  }
  return libPromise;
}

/** Charge pdfjs-dist + worker (blob pour contourner le CORS des workers), avec bascule CDN. */
function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      let lastErr;
      for (const base of PDFJS_BASES) {
        try {
          const mod = await import(/* @vite-ignore */ `${base}/build/pdf.min.mjs`);
          const res = await fetch(`${base}/build/pdf.worker.min.mjs`);
          if (!res.ok) throw new Error('worker HTTP ' + res.status);
          const text = await res.text();
          workerBlobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
          mod.GlobalWorkerOptions.workerSrc = workerBlobUrl;
          return mod;
        } catch (e) { lastErr = e; }
      }
      pdfJsPromise = null;
      throw lastErr || new Error('pdf.js indisponible (réseau / CDN).');
    })();
  }
  return pdfJsPromise;
}

/** Heuristique : le trailer du PDF référence-t-il un dictionnaire /Encrypt ? */
function hasEncryptFlag(buf) {
  const u8 = new Uint8Array(buf);
  const tail = u8.subarray(Math.max(0, u8.length - TAIL_BYTES));
  return /\/Encrypt(?![A-Za-z])/.test(new TextDecoder('latin1').decode(tail));
}

/** Contrôle : sortie sans /Encrypt, rouvrable sans mot de passe, même nombre de pages. */
async function verifyUnlocked(PDFDocument, bytes, expectedPages) {
  if (hasEncryptFlag(bytes)) throw new Error('un dictionnaire /Encrypt subsiste dans le fichier généré.');
  const chk = await PDFDocument.load(bytes); // lève une erreur si encore chiffré
  if (chk.context.trailerInfo.Encrypt) throw new Error('le trailer du fichier généré référence encore /Encrypt.');
  if (chk.getPageCount() !== expectedPages) throw new Error('nombre de pages incohérent après déverrouillage.');
}

/** Voie 1 : @cantoo/pdf-lib → load({ password }) → purge /Encrypt → copie des pages dans un document neuf. */
async function unlockNative(PDFDocument, buf, password) {
  const srcDoc = await PDFDocument.load(buf, { password });
  try { delete srcDoc.context.trailerInfo.Encrypt; } catch { /* déjà absent */ }
  const out = await PDFDocument.create();
  const pages = await out.copyPages(srcDoc, srcDoc.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  const bytes = await out.save();
  await verifyUnlocked(PDFDocument, bytes, pages.length);
  return bytes;
}

/** Voie 2 (AES-256 / PDF 2.0…) : pdf.js déchiffre, chaque page est rendue (scale 2) dans un PDF neuf. */
async function unlockRaster(PDFDocument, buf, password) {
  const pdfjs = await loadPdfJs();
  if (!s) throw new Error('annulé');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf).slice(), password });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    task.destroy?.();
    if (e?.name === 'PasswordException') {
      const err = new Error('WRONG_PASSWORD');
      err.wrong = true;
      throw err;
    }
    throw e;
  }
  try {
    const out = await PDFDocument.create();
    const n = pdf.numPages;
    for (let i = 1; i <= n; i++) {
      if (!s) throw new Error('annulé');
      const page = await pdf.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const scale = Math.min(RASTER_SCALE, RASTER_MAX_PX / Math.max(v1.width, v1.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const ctx2d = canvas.getContext('2d');
      ctx2d.fillStyle = '#fff'; // fond blanc (JPEG sans alpha)
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx2d, viewport: vp }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      canvas.width = canvas.height = 0; // libère la mémoire du canvas
      page.cleanup();
      if (!blob) throw new Error('rendu de la page ' + i + ' impossible.');
      const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const pg = out.addPage([v1.width, v1.height]);
      pg.drawImage(img, { x: 0, y: 0, width: v1.width, height: v1.height });
      setProgress(40 + (i / n) * 45);
      setStatus(`Rendu de secours : page ${i}/${n}…`);
      await tick();
    }
    const bytes = await out.save();
    await verifyUnlocked(PDFDocument, bytes, n);
    return bytes;
  } finally {
    try { await pdf.destroy(); } catch { /* noop */ }
  }
}

function setStatus(msg = '', kind = '') {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pdfunl-status' + (kind ? ' is-' + kind : '');
}

function setProgress(pct) {
  const bar = q('bar');
  if (!bar) return;
  bar.classList.toggle('is-on', pct !== null);
  bar.firstElementChild.style.width = (pct ?? 0) + '%';
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
  const pw = q('pw');
  if (pw) pw.disabled = s.busy;
  s.root.querySelectorAll('[data-toggle]').forEach((b) => (b.disabled = s.busy));
  q('go').disabled = s.busy || s.kind === 'open';
  q('reset').disabled = s.busy;
}

/** Détection automatique : ouvert / restrictions seules / mot de passe requis. */
async function loadFile(file) {
  if (!isPdf(file)) return setStatus('Fichier non PDF.', 'error');
  s.busy = true;
  try {
    setStatus('Chargement du moteur PDF…');
    const { PDFDocument } = await loadLib();
    setStatus('Analyse du PDF…');
    const buf = await file.arrayBuffer();
    let kind;
    let pages = 0;
    try {
      const doc = await PDFDocument.load(buf); // sans mot de passe
      pages = doc.getPageCount();
      kind = hasEncryptFlag(buf) ? 'restricted' : 'open';
    } catch (e) {
      if (!/encrypt|password/i.test(e?.message || '') && !hasEncryptFlag(buf)) throw e;
      kind = 'locked';
    }
    if (!s) return;
    Object.assign(s, { file, buf, kind, pages, busy: false });
    renderWork();
  } catch (e) {
    if (!s) return;
    s.busy = false;
    setStatus('PDF illisible ou corrompu : ' + (e?.message || e), 'error');
  }
}

/** Déchiffrement : load({ password }) → save() → contrôle → téléchargement. */
async function run() {
  if (!s.file || s.busy || s.kind === 'open') return;
  const locked = s.kind === 'locked';
  const password = locked ? q('pw').value : '';
  if (locked) {
    q('pw').classList.toggle('is-invalid', !password);
    if (!password) return setStatus('Saisissez le mot de passe du document.', 'error');
  }
  s.busy = true;
  syncUi();
  setProgress(5);
  try {
    setStatus('Chargement du moteur PDF…');
    const { PDFDocument } = await loadLib();
    if (!s) return;
    setStatus('Déchiffrement du document…');
    setProgress(30);
    await tick();
    let bytes;
    let raster = false;
    try {
      bytes = await unlockNative(PDFDocument, s.buf, password); // voie 1 (contrôle inclus)
    } catch {
      // Échec natif (algorithme non géré, mot de passe refusé…) : pdf.js tranche (PasswordException = mot de passe faux)
      if (!s) return;
      raster = true;
      setProgress(40);
      setStatus('Chiffrement non géré nativement : bascule sur pdf.js…');
      await tick();
      bytes = await unlockRaster(PDFDocument, s.buf, password); // voie 2 (contrôle inclus)
    }
    setProgress(95);
    if (!s) return;
    const name = s.file.name.replace(/\.pdf$/i, '') + '_deverrouille.pdf';
    download(new Blob([bytes], { type: 'application/pdf' }), name);
    setProgress(100);
    setStatus(`Terminé : ${name} (${fmtSize(bytes.byteLength)})${raster ? ' · pages converties en images (texte non sélectionnable).' : '.'}`, 'ok');
  } catch (e) {
    if (!s) return;
    setProgress(null);
    if (e.wrong) {
      q('pw').classList.add('is-invalid');
      setStatus('Mot de passe incorrect. Vérifiez la saisie et réessayez.', 'error');
    } else {
      setStatus('Échec du déverrouillage : ' + (e?.message || e), 'error');
    }
  } finally {
    if (s) {
      s.busy = false;
      syncUi();
      if (q('pw')?.classList.contains('is-invalid')) q('pw').focus();
    }
  }
}

/** Réinitialise : libère buffer et URLs Blob ; retour à la zone de dépôt. */
function reset() {
  if (!s) return;
  s.timers.forEach(clearTimeout);
  s.timers.clear();
  s.urls.forEach((u) => URL.revokeObjectURL(u));
  s.urls.clear();
  Object.assign(s, { file: null, buf: null, kind: null, pages: 0, busy: false });
  renderDrop();
}

function renderDrop() {
  s.root.innerHTML = `
    <div class="pdfunl">
      <div class="pdfunl-drop" id="pdfunl-drop" tabindex="0" role="button" aria-label="Choisir un fichier PDF">
        <i data-lucide="upload-cloud"></i>
        <strong>Glissez-déposez votre PDF protégé ici</strong>
        <small>ou cliquez pour parcourir · un seul fichier</small>
        <input id="pdfunl-input" type="file" accept="application/pdf" hidden />
      </div>
      <div class="pdfunl-status" id="pdfunl-status" role="status" aria-live="polite"></div>
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

const BADGES = {
  locked: ['is-locked', 'lock', 'Protégé par mot de passe'],
  restricted: ['is-restricted', 'shield-alert', 'Restrictions sans mot de passe d\'ouverture'],
  open: ['is-open', 'unlock', 'Non protégé'],
};
const HINTS = {
  locked: 'Saisissez le mot de passe d\'ouverture pour créer une copie sans protection.',
  restricted: 'Ce PDF s\'ouvre librement mais comporte des restrictions (impression, copie…). Une copie sans restriction sera créée.',
  open: 'Ce PDF n\'est pas protégé : aucun déverrouillage nécessaire.',
};

function renderWork() {
  const f = s.file;
  const [cls, icon, label] = BADGES[s.kind];
  const pagesTxt = s.pages ? ` · ${s.pages} page${s.pages > 1 ? 's' : ''}` : '';
  s.root.innerHTML = `
    <div class="pdfunl">
      <div class="pdfunl-file">
        <i data-lucide="file-key"></i>
        <div class="pdfunl-file-txt">
          <div class="pdfunl-name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="pdfunl-meta">${fmtSize(f.size)}${pagesTxt}</div>
        </div>
        <button type="button" class="btn-remove-file" id="pdfunl-reset"><i data-lucide="x"></i>Retirer</button>
      </div>
      <div class="pdfunl-panel">
        <span class="pdfunl-badge ${cls}"><i data-lucide="${icon}"></i>${label}</span>
        <p class="pdfunl-hint">${HINTS[s.kind]}</p>
        ${s.kind === 'locked' ? `
        <div class="pdfunl-field">
          <label for="pdfunl-pw">Mot de passe du document</label>
          <div class="pdfunl-input">
            <input id="pdfunl-pw" type="password" autocomplete="off" spellcheck="false" placeholder="Mot de passe" />
            <button type="button" class="icon-btn" data-toggle="pw" aria-label="Afficher le mot de passe" title="Afficher / masquer"><i data-lucide="eye"></i></button>
          </div>
        </div>` : ''}
      </div>
      <div class="pdfunl-bar" id="pdfunl-bar"><i></i></div>
      <div class="pdfunl-status" id="pdfunl-status" role="status" aria-live="polite"></div>
      <div class="pdfunl-actions">
        <button type="button" class="btn-primary" id="pdfunl-go"><i data-lucide="unlock"></i>Déverrouiller &amp; télécharger</button>
      </div>
    </div>`;
  q('reset').addEventListener('click', reset);
  q('go').addEventListener('click', run);
  const pw = q('pw');
  if (pw) {
    pw.addEventListener('input', () => pw.classList.remove('is-invalid'));
    pw.addEventListener('keydown', (e) => e.key === 'Enter' && run());
    s.root.querySelector('[data-toggle]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
      btn.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}"></i>`;
      refreshIcons();
    });
  }
  syncUi();
  refreshIcons();
  pw?.focus();
}

export function mount(container, ctx) {
  s = { root: container, ctx, file: null, buf: null, kind: null, pages: 0, busy: false, urls: new Set(), timers: new Set() };
  renderDrop();
}

export function unmount() {
  if (!s) return;
  s.timers.forEach(clearTimeout);
  s.urls.forEach((u) => URL.revokeObjectURL(u)); // libération mémoire Blob
  s.buf = null;
  s.root.innerHTML = ''; // détruit aussi le champ mot de passe
  if (workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
    pdfJsPromise = null; // worker recréé au prochain montage
  }
  s = null;
}
