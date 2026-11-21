/**
 * file-compressor.js — Compresseur universel 100 % local (aucun envoi réseau).
 *
 * Règle : chaque fichier conserve son format et son extension d'origine.
 * Moteurs (lossy/lossless dans le même format) :
 *   - Images JPEG / WebP → ré-encodage Canvas HTML5 (qualité selon le niveau)
 *   - Images PNG         → ré-encodage Canvas (sans perte)
 *   - JSON               → minification (sans perte)
 *   - Autres formats     → non compressibles sans changer de format : original conservé
 * Si le résultat n'est pas plus léger, l'original est conservé (« Déjà optimisé »).
 *
 * Contrat : export mount(container, ctx) / unmount().
 * Mémoire : objectURL révoqués (retrait d'un fichier, relance, unmount).
 */

/** Niveaux : q = qualité canvas (0-1) pour JPEG / WebP. */
const LEVELS = {
  moderate: { label: 'Modéré', q: 0.85 },
  balanced: { label: 'Équilibré', q: 0.7 },
  max: { label: 'Max', q: 0.5 },
};

const IMG_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const STATUS = {
  pending: 'En attente',
  working: 'En cours…',
  done: 'Terminé',
  skip: 'Déjà optimisé',
  nocomp: 'Format non compressible',
  error: 'Erreur',
};

const TEMPLATE = `
<div class="fcmp">
  <label class="fcmp-drop" id="fcmp-drop">
    <i data-lucide="archive" class="fcmp-drop-icon"></i>
    <strong>Glissez vos fichiers ici ou cliquez pour parcourir</strong>
    <small>Tous types de fichiers · format d'origine conservé · traitement 100 % local</small>
    <input type="file" id="fcmp-input" accept="*/*" multiple>
  </label>
  <div class="fcmp-bar">
    <label class="fcmp-opt">Niveau de compression
      <select id="fcmp-level">
        <option value="moderate">Modéré (qualité haute)</option>
        <option value="balanced" selected>Équilibré</option>
        <option value="max">Max (poids minimal)</option>
      </select>
    </label>
    <button class="fcmp-btn primary" id="fcmp-run" disabled><i data-lucide="zap"></i> Compresser</button>
  </div>
  <div class="fcmp-progress"><div id="fcmp-bar"></div></div>
  <div class="fcmp-status" id="fcmp-msg" role="status"></div>
  <div class="fcmp-wrap">
    <table id="fcmp-table" hidden>
      <thead><tr><th>Nom</th><th>Taille initiale</th><th>Taille finale</th><th>Gain</th><th>Statut</th><th></th></tr></thead>
      <tbody id="fcmp-rows"></tbody>
    </table>
  </div>
  <div class="fcmp-viewer" id="fcmp-viewer" hidden></div>
  <div class="fcmp-total" id="fcmp-total"></div>
</div>`;

/** État du module (null quand démonté). */
let s = null;

const q = (id) => s?.root.querySelector('#fcmp-' + id);
const refreshIcons = () => window.lucide?.createIcons();
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (b) =>
  b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' Go'
  : b >= 1048576 ? (b / 1048576).toFixed(1) + ' Mo'
  : Math.max(b ? 1 : 0, Math.round(b / 1024)) + ' Ko';

function setStatus(msg = '', isError = false) {
  const el = q('msg');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', isError);
}

/* ------------------------------ Routage ------------------------------ */

/** Retourne le type MIME image supporté (d'après MIME ou extension), sinon null. */
function imageMime(file) {
  if (IMG_MIMES.includes(file.type)) return file.type;
  if (!file.type) return EXT_MIME[file.name.split('.').pop().toLowerCase()] ?? null;
  return null;
}

function routeOf(file) {
  if (imageMime(file)) return 'image';
  if (file.type === 'application/json' || /\.json$/i.test(file.name)) return 'json';
  return 'none';
}

/* ------------------------------- Moteurs ------------------------------ */

const canvasBlob = (canvas, mime, quality) =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Encodage image impossible.'))), mime, quality));

/** Ré-encode une image dans son format d'origine, dimensions inchangées. */
async function compressImage(file, level) {
  const mime = imageMime(file);
  const bmp = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const g = canvas.getContext('2d');
    if (mime === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); }
    g.drawImage(bmp, 0, 0);
    const blob = await canvasBlob(canvas, mime, level.q);
    canvas.width = canvas.height = 0; // libère le buffer
    // Le navigateur ne sait pas encoder ce format (ex. WebP ancien) → format non préservable
    return blob.type === mime ? blob : null;
  } finally {
    bmp.close?.();
  }
}

/** Minifie un JSON (sans perte de données). */
async function compressJson(file) {
  const text = await file.text();
  return new Blob([JSON.stringify(JSON.parse(text.replace(/^\uFEFF/, '')))], { type: file.type || 'application/json' });
}

async function processItem(item, level) {
  const { file } = item;
  releaseOutput(item);
  let out = null;
  if (item.route === 'image') out = await compressImage(file, level);
  else if (item.route === 'json') out = await compressJson(file);

  if (item.route === 'none' || !out) {
    item.out = file;
    item.status = 'nocomp';
  } else if (out.size >= file.size) {
    item.out = file; // pas de gain → original conservé
    item.status = 'skip';
  } else {
    item.out = out;
    item.status = 'done';
  }
  item.url = URL.createObjectURL(item.out);
}

/* ------------------------------ Mémoire ------------------------------- */

function releaseOutput(item) {
  if (item.url) URL.revokeObjectURL(item.url);
  item.url = null;
  item.out = null;
}

function releaseSrc(item) {
  if (item.srcUrl) URL.revokeObjectURL(item.srcUrl);
  item.srcUrl = null;
}

function releaseAll() {
  s?.items.forEach((i) => { releaseOutput(i); releaseSrc(i); });
}

/* --------------------------------- UI --------------------------------- */

function render() {
  pickView();
  q('table').hidden = s.items.length === 0;
  q('run').disabled = s.busy || !s.items.length;
  q('level').disabled = s.busy;
  q('rows').innerHTML = s.items.map((it) => {
    const gain = it.out ? Math.round((1 - it.out.size / it.file.size) * 100) : null;
    const gainTxt = gain === null ? '—' : gain > 0 ? `-${gain} %` : '0 %';
    return `<tr class="fcmp-row${it.id === s.viewId ? ' sel' : ''}" data-view="${it.id}">
      <td class="name" title="${esc(it.file.name)}">${esc(it.file.name)}</td>
      <td>${fmtSize(it.file.size)}</td>
      <td>${it.out ? fmtSize(it.out.size) : '—'}</td>
      <td class="gain${gain > 0 ? '' : ' none'}">${gainTxt}</td>
      <td class="st-${it.status}${it.status === 'error' ? ' status-error' : ''}" title="${esc(it.error)}">${STATUS[it.status]}${it.error ? ' : ' + esc(it.error) : ''}</td>
      <td>${it.url ? `<a class="fcmp-btn icon-btn" href="${it.url}" download="${esc(it.file.name)}" title="Télécharger"><i data-lucide="download"></i></a>` : ''}
          <button class="fcmp-btn icon-btn" data-remove="${it.id}" title="Retirer" ${s.busy ? 'disabled' : ''}><i data-lucide="trash-2"></i></button></td>
    </tr>`;
  }).join('');

  const done = s.items.filter((i) => i.out);
  const tin = done.reduce((a, i) => a + i.file.size, 0);
  const tout = done.reduce((a, i) => a + i.out.size, 0);
  q('total').textContent = done.length
    ? `Total : ${fmtSize(tin)} → ${fmtSize(tout)} (${tin > tout ? '-' + Math.round((1 - tout / tin) * 100) : '0'} %)`
    : '';
  renderViewer();
  refreshIcons();
}

/* ----------------------- Visionneuse comparative ----------------------- */

/** Sélection par défaut : premier fichier traité, sinon le premier de la liste. */
function pickView() {
  if (!s.items.some((x) => x.id === s.viewId)) s.viewId = (s.items.find((x) => x.out) ?? s.items[0])?.id ?? null;
}

const extOf = (f) => (f.name.includes('.') ? f.name.split('.').pop() : f.type.split('/')[1] || 'fichier').toUpperCase();

function renderViewer() {
  const box = q('viewer');
  const it = s.items.find((x) => x.id === s.viewId);
  box.hidden = !it;
  if (!it) return;
  const kind = it.route;
  if (kind === 'image' && !it.srcUrl) it.srcUrl = URL.createObjectURL(it.file); // révoqué via releaseSrc
  const gain = it.out ? Math.round((1 - it.out.size / it.file.size) * 100) : null;
  const badge = gain === null ? '—' : gain > 0 ? `-${gain} %` : '0 %';
  const body = (url, k) =>
    kind === 'image' ? `<img src="${url}" alt="">`
    : kind === 'json' ? `<pre class="fcmp-pre" data-k="${k}"></pre>`
    : `<div class="fcmp-ph"><i data-lucide="file"></i><span>${esc(extOf(it.file))}</span></div>`;
  const pane = (title, size, inner) =>
    `<figure class="fcmp-pane"><figcaption>${title} · <b>${size}</b></figcaption><div class="fcmp-prev checkerboard-bg">${inner}</div></figure>`;
  box.innerHTML = `
    <div class="fcmp-vhead">
      <strong title="${esc(it.file.name)}">${esc(it.file.name)}</strong>
      <small>${STATUS[it.status]}</small>
      <span class="fcmp-badge${gain > 0 ? '' : ' none'}">${badge}</span>
    </div>
    <div class="fcmp-cmp">
      ${pane('Avant', fmtSize(it.file.size), body(it.srcUrl, 'a'))}
      ${pane('Après', it.out ? fmtSize(it.out.size) : '—', it.out ? body(it.url, 'b') : `<div class="fcmp-ph"><span>${STATUS[it.status]}</span></div>`)}
    </div>`;
  if (kind === 'json') {
    const me = s;
    const fill = async (k, blob) => {
      if (!blob) return;
      const t = (await blob.text()).slice(0, 800);
      const el = me === s ? box.querySelector(`[data-k="${k}"]`) : null;
      if (el && s.viewId === it.id) el.textContent = t;
    };
    fill('a', it.file);
    fill('b', it.out);
  }
}

let nextId = 1;
function addFiles(list) {
  const files = Array.from(list ?? []);
  if (!files.length) return;
  for (const file of files) {
    s.items.push({ id: nextId++, file, route: routeOf(file), status: 'pending', out: null, url: null, error: '' });
  }
  setStatus(`${files.length} fichier(s) ajouté(s).`);
  render();
}

function removeItem(id) {
  const i = s.items.findIndex((x) => x.id === id);
  if (i < 0) return;
  releaseOutput(s.items[i]);
  releaseSrc(s.items[i]);
  s.items.splice(i, 1);
  render();
}

async function runAll() {
  if (s.busy || !s.items.length) return;
  s.busy = true;
  const level = LEVELS[q('level').value] ?? LEVELS.balanced;
  const todo = [...s.items];
  q('bar').style.width = '0%';
  for (let i = 0; i < todo.length; i++) {
    const it = todo[i];
    it.status = 'working';
    it.error = '';
    setStatus(`Compression ${i + 1}/${todo.length} : ${it.file.name}`);
    render();
    try {
      await processItem(it, level);
    } catch (e) {
      releaseOutput(it);
      it.status = 'error';
      it.error = e instanceof SyntaxError ? 'JSON invalide' : (e?.message ?? 'échec');
    }
    if (!s) return; // démonté pendant le traitement
    q('bar').style.width = Math.round(((i + 1) / todo.length) * 100) + '%';
  }
  s.busy = false;
  setStatus('Compression terminée.');
  render();
}

/* ------------------------------ Contrat ------------------------------- */

export function mount(container, ctx) {
  if (s) unmount();
  container.innerHTML = TEMPLATE;
  s = { root: container, ctx, items: [], busy: false };

  const drop = q('drop');
  const on = (el, ev, fn) => el.addEventListener(ev, fn);
  on(q('input'), 'change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => on(drop, ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => on(drop, ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  on(drop, 'drop', (e) => addFiles(e.dataTransfer?.files));
  on(q('run'), 'click', runAll);
  on(q('rows'), 'click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) return removeItem(Number(b.dataset.remove));
    if (e.target.closest('a')) return; // téléchargement : ne pas re-rendre
    const r = e.target.closest('[data-view]');
    if (r) { s.viewId = Number(r.dataset.view); render(); }
  });
  render();
}

export function unmount() {
  if (!s) return;
  releaseAll();
  s.root.innerHTML = '';
  s = null;
}
