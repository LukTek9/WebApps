/**
 * zip-archiver.js — Outil « Créateur & Extracteur ZIP » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Modes :
 *  1. Créer un ZIP : fichiers multiples (dropzone), liste + poids, retrait, niveau de compression, nom, téléchargement.
 *  2. Extraire un ZIP : dropzone .zip, entrées + poids, téléchargement unitaire ou « Tout télécharger ».
 * JSZip chargé à la demande (CDN). Nettoyage complet (URL, listeners, timers) dans unmount().
 */
import { createSecurityUI, createDropzone, bindDropzone, escapeHtml, showError } from '../shared/security-tool-ui.js';

/* ---------- Constantes ---------- */
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const MULTI_DOWNLOAD_DELAY_MS = 250; // évite le blocage des téléchargements multiples

const LEVELS = [
  { value: 'store', label: 'Aucune (stockage seul)' },
  { value: '1', label: 'Rapide' },
  { value: '6', label: 'Équilibrée' },
  { value: '9', label: 'Maximale' },
];

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const fmtSize = (b) => {
  if (!Number.isFinite(b)) return '—';
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' Go';
  if (b >= 1048576) return (b / 1048576).toFixed(2) + ' Mo';
  if (b === 0) return '0 o';
  return Math.max(1, Math.round(b / 1024)) + ' Ko';
};
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const baseName = (path) => (path.split('/').filter(Boolean).pop() || 'fichier').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
const errMsg = (e) => (e instanceof Error && e.message ? e.message : 'erreur inconnue');
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const wait = (ms) => new Promise((resolve) => {
  const t = setTimeout(() => { s?.timers.delete(t); resolve(); }, ms);
  s?.timers.add(t);
});

/** Nom unique dans l'archive / le lot de téléchargements : « a.txt » → « a (2).txt ». */
function uniqueName(name, used) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = name;
  for (let i = 2; used.has(n); i++) n = `${base} (${i})${ext}`;
  used.add(n);
  return n;
}

let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipPromise ??= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = JSZIP_URL;
    sc.async = true;
    sc.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip introuvable')));
    sc.onerror = () => { jszipPromise = null; sc.remove(); reject(new Error('chargement CDN impossible')); };
    document.head.appendChild(sc);
  });
  return jszipPromise;
}

/* ==========================================================================
   UI : onglets / progression / occupation / rendu
   ========================================================================== */
const el = (sel) => s?.ui.query(sel);

function setTab(tab) {
  if (!s) return;
  s.ui.root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  s.ui.root.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
}

function setProgress(which, percent) {
  const bar = el(`[data-progress="${which}"]`);
  if (!bar) return;
  bar.hidden = percent === false;
  bar.firstElementChild.style.width = typeof percent === 'number' ? `${Math.round(Math.min(100, Math.max(0, percent)))}%` : '0';
}

function syncControls() {
  if (!s) return;
  el('[data-action="create"]').disabled = s.busy || !s.files.length;
  el('[data-action="clear"]').disabled = s.busy;
  el('[data-action="extract-all"]').disabled = s.busy || !s.entries.length;
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  s.ui.root.querySelectorAll('[data-action], [data-level], [data-archive-name]').forEach((c) => { c.disabled = busy; });
  s.zones.forEach((z) => z.setDisabled(busy));
  if (!busy) syncControls();
}

const rowHtml = (icon, name, meta, action) => `
  <li class="zipa-row">
    <i data-lucide="${icon}"></i>
    <span class="zipa-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    <span class="zipa-size">${meta}</span>
    ${action}
  </li>`;

function renderCreate() {
  if (!s) return;
  const total = s.files.reduce((n, f) => n + f.file.size, 0);
  el('[data-create-summary]').hidden = !s.files.length;
  el('[data-create-count]').textContent = `${plural(s.files.length, 'fichier')} — ${fmtSize(total)}`;
  el('[data-create-list]').innerHTML = s.files.map((f) => rowHtml(
    'file', f.file.name, fmtSize(f.file.size),
    `<button type="button" class="btn-remove-file" data-action="remove" data-id="${f.id}" aria-label="Retirer ${escapeHtml(f.file.name)}"><i data-lucide="x"></i> Retirer</button>`,
  )).join('');
  syncControls();
  icons();
}

function renderExtract() {
  if (!s) return;
  const known = s.entries.every((e) => Number.isFinite(e.size));
  const total = known ? s.entries.reduce((n, e) => n + e.size, 0) : NaN;
  el('[data-extract-info]').hidden = !s.archive;
  if (s.archive) {
    el('[data-st-name]').textContent = s.archive.name;
    el('[data-st-count]').textContent = String(s.entries.length);
    el('[data-st-size]').textContent = fmtSize(total);
  }
  el('[data-extract-list]').innerHTML = s.entries.map((e) => rowHtml(
    'file', e.path, fmtSize(e.size),
    `<button type="button" class="btn-secondary" data-action="extract-one" data-id="${e.id}" aria-label="Télécharger ${escapeHtml(baseName(e.path))}"><i data-lucide="download"></i> Télécharger</button>`,
  )).join('');
  syncControls();
  icons();
}

/* ==========================================================================
   Mode « Créer un ZIP »
   ========================================================================== */
function addFiles(files) {
  if (!s || s.busy) return;
  for (const file of files) s.files.push({ id: ++s.seq, file });
  renderCreate();
  s.ui.setStatus(`${plural(files.length, 'fichier')} ajouté${files.length > 1 ? 's' : ''}.`);
}

function removeFile(id) {
  if (!s || s.busy) return;
  s.files = s.files.filter((f) => f.id !== id);
  renderCreate();
  s.ui.setStatus(s.files.length ? 'Fichier retiré.' : 'Aucun fichier à archiver.');
}

function clearFiles() {
  if (!s || s.busy) return;
  s.files = [];
  renderCreate();
  s.ui.setStatus('Aucun fichier à archiver.');
}

const archiveName = () => (el('[data-archive-name]').value || '')
  .trim().replace(/\.zip$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'archive';

async function createZip() {
  const cur = s;
  if (!cur || cur.busy || !cur.files.length) return;
  setBusy(true);
  setProgress('create', 0);
  cur.ui.setStatus('Création de l\'archive ZIP…');
  try {
    const JSZip = await loadJSZip();
    if (s !== cur) return;
    const zip = new JSZip();
    const used = new Set();
    for (const { file } of cur.files) zip.file(uniqueName(file.name, used), file, { binary: true });
    const level = el('[data-level]').value;
    const opts = level === 'store'
      ? { compression: 'STORE' }
      : { compression: 'DEFLATE', compressionOptions: { level: Number(level) } };
    const blob = await zip.generateAsync({ type: 'blob', streamFiles: true, ...opts }, (m) => { if (s === cur) setProgress('create', m.percent); });
    if (s !== cur) return;
    const filename = `${archiveName()}.zip`;
    cur.ui.download(blob, filename, 'application/zip');
    cur.ui.setStatus(`${filename} créé (${plural(cur.files.length, 'fichier')}, ${fmtSize(blob.size)}).`, 'success');
  } catch (e) {
    if (s === cur) showError(cur.ui, new Error(`ZIP impossible (${errMsg(e)}).`));
  } finally {
    if (s === cur) { setProgress('create', false); setBusy(false); }
  }
}

/* ==========================================================================
   Mode « Extraire un ZIP »
   ========================================================================== */
async function loadArchive(file) {
  const cur = s;
  if (!cur || cur.busy) return;
  setBusy(true);
  setProgress('extract', null);
  cur.ui.setStatus(`Lecture de « ${file.name} »…`);
  try {
    const JSZip = await loadJSZip();
    if (s !== cur) return;
    const zip = await JSZip.loadAsync(file);
    if (s !== cur) return;
    const entries = Object.values(zip.files)
      .filter((e) => !e.dir)
      .map((entry, id) => ({ id, entry, path: entry.name, size: entry._data?.uncompressedSize ?? NaN }));
    cur.archive = file;
    cur.entries = entries;
    renderExtract();
    cur.ui.setStatus(entries.length ? `${plural(entries.length, 'fichier')} dans l'archive.` : 'Archive vide.', entries.length ? 'success' : 'muted');
  } catch (e) {
    if (s !== cur) return;
    cur.archive = null;
    cur.entries = [];
    renderExtract();
    showError(cur.ui, new Error(`Archive illisible (${errMsg(e)}).`));
  } finally {
    if (s === cur) { setProgress('extract', false); setBusy(false); }
  }
}

async function extractOne(id) {
  const cur = s;
  const item = cur?.entries.find((e) => e.id === id);
  if (!cur || cur.busy || !item) return;
  setBusy(true);
  setProgress('extract', null);
  cur.ui.setStatus(`Extraction de « ${baseName(item.path)} »…`);
  try {
    const blob = await item.entry.async('blob');
    if (s !== cur) return;
    cur.ui.download(blob, baseName(item.path), 'application/octet-stream');
  } catch (e) {
    if (s === cur) showError(cur.ui, new Error(`Extraction impossible (${errMsg(e)}).`));
  } finally {
    if (s === cur) { setProgress('extract', false); setBusy(false); }
  }
}

async function extractAll() {
  const cur = s;
  if (!cur || cur.busy || !cur.entries.length) return;
  setBusy(true);
  const used = new Set();
  const total = cur.entries.length;
  let n = 0;
  try {
    for (const item of cur.entries) {
      cur.ui.setStatus(`Extraction… ${n + 1} / ${total}`);
      setProgress('extract', (n / total) * 100);
      const blob = await item.entry.async('blob');
      if (s !== cur) return;
      cur.ui.download(blob, uniqueName(baseName(item.path), used), 'application/octet-stream');
      n++;
      await wait(MULTI_DOWNLOAD_DELAY_MS);
      if (s !== cur) return;
    }
    cur.ui.setStatus(`${plural(n, 'fichier')} extrait${n > 1 ? 's' : ''}.`, 'success');
  } catch (e) {
    if (s === cur) showError(cur.ui, new Error(`Extraction interrompue (${errMsg(e)}) — ${n} / ${total}.`));
  } finally {
    if (s === cur) { setProgress('extract', false); setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const progressHtml = (which) => `<div class="security-tools__meter-bar" data-progress="${which}" hidden><span></span></div>`;

const TEMPLATE = `
  <div class="zipa-tabs" role="tablist" aria-label="Mode de l'outil">
    <button type="button" class="zipa-tab" role="tab" id="zipa-tab-create" aria-selected="true" aria-controls="zipa-panel-create" data-tab="create">Créer un ZIP</button>
    <button type="button" class="zipa-tab" role="tab" id="zipa-tab-extract" aria-selected="false" aria-controls="zipa-panel-extract" data-tab="extract">Extraire un ZIP</button>
  </div>

  <section class="security-tools__panel zipa-panel" role="tabpanel" id="zipa-panel-create" aria-labelledby="zipa-tab-create" data-panel="create">
    ${createDropzone({ id: 'zipa-create', title: 'Glissez-déposez vos fichiers ici', hint: 'ou cliquez pour parcourir — plusieurs fichiers acceptés', multiple: true, label: 'Ajouter des fichiers à archiver' })}
    <div class="zipa-summary" data-create-summary hidden>
      <span data-create-count></span>
      <button type="button" class="btn-remove-file" data-action="clear"><i data-lucide="trash-2"></i> Tout retirer</button>
    </div>
    <ul class="zipa-list" data-create-list></ul>
    <div class="security-tools__controls">
      <label class="security-tools__field">Niveau de compression
        <select data-level>
          ${LEVELS.map((l) => `<option value="${l.value}"${l.value === '6' ? ' selected' : ''}>${l.label}</option>`).join('')}
        </select>
      </label>
      <label class="security-tools__field">Nom de l'archive
        <input type="text" data-archive-name value="archive" maxlength="100" autocomplete="off" spellcheck="false">
      </label>
    </div>
    ${progressHtml('create')}
    <div class="security-tools__actions">
      <button type="button" class="btn-primary" data-action="create" disabled><i data-lucide="file-archive"></i> Créer et télécharger le ZIP</button>
    </div>
  </section>

  <section class="security-tools__panel zipa-panel" role="tabpanel" id="zipa-panel-extract" aria-labelledby="zipa-tab-extract" data-panel="extract" hidden>
    ${createDropzone({ id: 'zipa-extract', title: 'Glissez-déposez une archive ZIP ici', hint: 'ou cliquez pour parcourir — fichier .zip', accept: '.zip,application/zip', multiple: false, label: 'Choisir une archive ZIP' })}
    <div class="security-tools__stats" data-extract-info hidden>
      <div class="security-tools__stat"><span>Archive</span><strong data-st-name>—</strong></div>
      <div class="security-tools__stat"><span>Fichiers</span><strong data-st-count>—</strong></div>
      <div class="security-tools__stat"><span>Taille décompressée</span><strong data-st-size>—</strong></div>
    </div>
    <ul class="zipa-list" data-extract-list></ul>
    ${progressHtml('extract')}
    <div class="security-tools__actions">
      <button type="button" class="btn-primary" data-action="extract-all" disabled><i data-lucide="download"></i> Tout télécharger</button>
    </div>
  </section>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount();
  const ui = createSecurityUI(container, { content: TEMPLATE });
  s = { ui, ctx, busy: false, seq: 0, files: [], archive: null, entries: [], zones: [], timers: new Set() };

  s.zones.push(
    bindDropzone(ui, { id: 'zipa-create', multiple: true, onFiles: addFiles }),
    bindDropzone(ui, { id: 'zipa-extract', accept: '.zip,application/zip', multiple: false, onFiles: (files) => loadArchive(files[0]) }),
  );

  ui.on('click', (e) => {
    const btn = e.target.closest('[data-tab], [data-action]');
    if (!btn || !s) return;
    if (btn.dataset.tab) { setTab(btn.dataset.tab); return; }
    const id = Number(btn.dataset.id);
    switch (btn.dataset.action) {
      case 'remove': removeFile(id); break;
      case 'clear': clearFiles(); break;
      case 'create': createZip(); break;
      case 'extract-one': extractOne(id); break;
      case 'extract-all': extractAll(); break;
      default: break;
    }
  });

  ui.setStatus('Ajoutez des fichiers pour créer une archive.');
  icons();
}

export function unmount() {
  if (!s) return;
  const cur = s;
  s = null;                                  // invalide toute opération asynchrone en cours
  cur.timers.forEach(clearTimeout);          // délais entre téléchargements
  cur.timers.clear();
  cur.files = [];
  cur.entries = [];
  cur.archive = null;
  cur.ui.destroy();                          // abort listeners + revokeObjectURL + timers + vidage du conteneur
}
