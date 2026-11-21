/**
 * file-compressor.js — Compresseur universel 100 % local (aucun envoi réseau).
 *
 * Routage selon type MIME / extension :
 *   a) Images (jpeg/png/webp/bmp) → Canvas HTML5 (qualité + redimensionnement + format d'export)
 *   b) Textes & données           → CompressionStream('gzip') → fichier .gz
 *   c) Autres fichiers            → archive ZIP (deflate-raw natif + CRC32), "Tout en ZIP" pour les lots
 *
 * Contrat : export mount(container, ctx) / unmount().
 * Mémoire : tous les objectURL sont révoqués (suppression, relance, reset, unmount).
 */

const STYLE_ID = 'fcmp-style';
const MAX_BYTES = 1024 * 1024 * 1024; // 1 Go par fichier (limite mémoire navigateur / ZIP32)

/** Niveaux : q = qualité canvas (0-1), maxDim = plafond de dimension appliqué si "Max" et redimensionnement actif par défaut. */
const LEVELS = {
  moderate: { label: 'Modéré', q: 0.85 },
  balanced: { label: 'Équilibré', q: 0.7 },
  max: { label: 'Max', q: 0.5 },
};

const IMG_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'];
const IMG_EXT = /\.(jpe?g|png|webp|bmp)$/i;
const TEXT_EXT = /\.(txt|md|csv|tsv|json|jsonl|xml|html?|css|js|mjs|ts|jsx|tsx|svg|yml|yaml|ini|log|sql|srt|vtt|php|py|rb|java|c|h|cpp|cs|go|rs|sh|bat|tex|rtf|toml|conf)$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|x-ndjson|x-yaml|sql|xhtml\+xml)|image\/svg\+xml)/i;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const STATUS = {
  pending: 'En attente',
  working: 'En cours…',
  done: 'Terminé',
  skip: 'Déjà optimisé',
  error: 'Erreur',
};

const CSS = `
.fcmp{display:flex;flex-direction:column;gap:16px;font-family:var(--font-base,inherit);color:var(--text,inherit)}
.fcmp-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:44px 16px;text-align:center;cursor:pointer;
  border:2px dashed var(--border,#cbd5e1);border-radius:var(--radius-lg,16px);background:var(--surface,#f8fafc);transition:border-color .15s,background .15s}
.fcmp-drop:hover,.fcmp-drop.is-over{border-color:var(--cat-utility,#4f46e5);background:var(--surface-hover,#eef2ff)}
.fcmp-drop input{display:none}
.fcmp-drop strong{font-size:1.05rem}
.fcmp-drop small{opacity:.7}
.fcmp-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.fcmp-opt{display:flex;flex-direction:column;gap:6px;font-size:.9rem}
.fcmp-opt select,.fcmp-opt input[type=number]{padding:8px 10px;border:1px solid var(--border,#cbd5e1);border-radius:var(--radius-sm,8px);background:var(--bg,#fff);color:inherit;font:inherit}
.fcmp-check{flex-direction:row;align-items:center;gap:8px}
.fcmp-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.fcmp-btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border:1px solid var(--border,#cbd5e1);border-radius:var(--radius-sm,8px);
  background:var(--bg,#fff);color:inherit;font:inherit;cursor:pointer;text-decoration:none}
.fcmp-btn:hover:not(:disabled){filter:brightness(.96)}
.fcmp-btn:disabled{opacity:.45;cursor:not-allowed}
.fcmp-btn.primary{background:var(--cat-utility,#4f46e5);border-color:transparent;color:#fff}
.fcmp-progress{height:8px;border-radius:99px;background:var(--border,#e2e8f0);overflow:hidden}
.fcmp-progress>div{height:100%;width:0;background:var(--cat-utility,#4f46e5);transition:width .2s}
.fcmp-status{min-height:1.2em;font-size:.9rem}
.fcmp-status.err{color:var(--danger,#dc2626)}
.fcmp-wrap{overflow-x:auto}
.fcmp table{width:100%;border-collapse:collapse;font-size:.9rem}
.fcmp th,.fcmp td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border,#e2e8f0);white-space:nowrap}
.fcmp td.name{max-width:260px;overflow:hidden;text-overflow:ellipsis}
.fcmp .gain{font-weight:600;color:var(--success,#16a34a)}
.fcmp .gain.none{color:inherit;opacity:.6}
.fcmp .st-error{color:var(--danger,#dc2626)}
.fcmp .icon-btn{padding:4px 8px}
.fcmp-total{font-size:.9rem;opacity:.85}
`;

const TEMPLATE = `
<div class="fcmp">
  <label class="fcmp-drop" id="fcmp-drop">
    <i data-lucide="archive" style="width:42px;height:42px"></i>
    <strong>Glissez vos fichiers ici ou cliquez pour parcourir</strong>
    <small>Tous types de fichiers · multi-sélection · traitement 100 % local</small>
    <input type="file" id="fcmp-input" accept="*/*" multiple>
  </label>
  <div class="fcmp-opts">
    <label class="fcmp-opt">Niveau de compression
      <select id="fcmp-level">
        <option value="moderate">Modéré (qualité haute)</option>
        <option value="balanced" selected>Équilibré</option>
        <option value="max">Max (poids minimal)</option>
      </select>
    </label>
    <label class="fcmp-opt">Format d'export des images
      <select id="fcmp-format">
        <option value="auto">Identique à la source</option>
        <option value="image/webp">WebP</option>
        <option value="image/jpeg">JPEG</option>
      </select>
    </label>
    <label class="fcmp-opt fcmp-check"><input type="checkbox" id="fcmp-resize"> Redimensionner les images</label>
    <label class="fcmp-opt">Dimension max (px)
      <input type="number" id="fcmp-maxdim" min="16" max="16000" step="1" value="1920" disabled>
    </label>
  </div>
  <div class="fcmp-bar">
    <button class="fcmp-btn primary" id="fcmp-run" disabled><i data-lucide="zap"></i> Compresser</button>
    <button class="fcmp-btn" id="fcmp-zip" disabled><i data-lucide="package"></i> Tout en ZIP</button>
    <button class="fcmp-btn" id="fcmp-cancel" disabled><i data-lucide="x"></i> Annuler</button>
    <button class="fcmp-btn" id="fcmp-reset" disabled><i data-lucide="trash-2"></i> Vider</button>
  </div>
  <div class="fcmp-progress"><div id="fcmp-bar"></div></div>
  <div class="fcmp-status" id="fcmp-msg" role="status"></div>
  <div class="fcmp-wrap">
    <table id="fcmp-table" hidden>
      <thead><tr><th>Nom</th><th>Taille initiale</th><th>Taille compressée</th><th>Gain</th><th>Statut</th><th></th></tr></thead>
      <tbody id="fcmp-rows"></tbody>
    </table>
  </div>
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
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'fichier';

function setStatus(msg = '', isError = false) {
  const el = q('msg');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', isError);
}

/* ------------------------------ Routage ------------------------------ */

function routeOf(file) {
  if (IMG_MIMES.includes(file.type) || (!file.type && IMG_EXT.test(file.name))) return 'image';
  if (TEXT_MIME.test(file.type) || TEXT_EXT.test(file.name)) return 'text';
  return 'archive';
}

/* ------------------------- Primitives binaires ------------------------ */

const hasCompression = () => typeof CompressionStream === 'function';

/** Compresse un Blob via CompressionStream (gzip | deflate-raw). */
const pipe = (blob, format) => new Response(blob.stream().pipeThrough(new CompressionStream(format))).blob();

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Prépare une entrée ZIP : deflate-raw si gain, sinon stockage brut. */
async function zipEntry(name, blob) {
  const raw = new Uint8Array(await blob.arrayBuffer());
  let method = 0;
  let data = raw;
  if (raw.length > 0) {
    const d = new Uint8Array(await (await pipe(blob, 'deflate-raw')).arrayBuffer());
    if (d.length < raw.length) { method = 8; data = d; }
  }
  return { name, crc: crc32(raw), size: raw.length, data, method };
}

/** Assemble un ZIP (sans dépendance) à partir d'entrées préparées. */
function buildZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  let cdSize = 0;
  for (const e of entries) {
    const nm = enc.encode(e.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // noms UTF-8
    lh.setUint16(8, e.method, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, e.crc, true);
    lh.setUint32(18, e.data.length, true);
    lh.setUint32(22, e.size, true);
    lh.setUint16(26, nm.length, true);
    parts.push(lh.buffer, nm, e.data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, e.method, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, e.crc, true);
    ch.setUint32(20, e.data.length, true);
    ch.setUint32(24, e.size, true);
    ch.setUint16(28, nm.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nm);
    cdSize += 46 + nm.length;
    offset += 30 + nm.length + e.data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

const zipOf = async (entries) => buildZip(await Promise.all(entries.map((e) => zipEntry(e.name, e.blob))));

/** Dédoublonne les noms d'entrées ZIP. */
function uniqueName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const [b, e] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let i = 2;
  while (used.has(`${b} (${i})${e}`)) i++;
  const n = `${b} (${i})${e}`;
  used.add(n);
  return n;
}

/* ------------------------------- Moteurs ------------------------------ */

const canvasBlob = (canvas, mime, quality) =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Encodage image impossible.'))), mime, quality));

async function compressImage(file, opts) {
  const bmp = await createImageBitmap(file);
  try {
    let w = bmp.width;
    let h = bmp.height;
    if (opts.resize) {
      const m = Math.max(w, h);
      if (m > opts.maxDim) {
        const k = opts.maxDim / m;
        w = Math.max(1, Math.round(w * k));
        h = Math.max(1, Math.round(h * k));
      }
    }
    const mime = opts.format === 'auto'
      ? (['image/jpeg', 'image/webp', 'image/png'].includes(file.type) ? file.type : 'image/webp')
      : opts.format;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (mime === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); } // pas de transparence en JPEG
    g.drawImage(bmp, 0, 0, w, h);
    const blob = await canvasBlob(canvas, mime, opts.q);
    canvas.width = canvas.height = 0; // libère le buffer
    const ext = MIME_EXT[blob.type] ?? 'png';
    return { blob, name: `${baseName(file.name)}.${ext}` };
  } finally {
    bmp.close?.();
  }
}

async function compressText(file) {
  return { blob: await pipe(file, 'gzip'), name: file.name + '.gz' };
}

async function compressArchive(file) {
  return { blob: await zipOf([{ name: file.name, blob: file }]), name: `${baseName(file.name)}.zip` };
}

async function processItem(item, opts) {
  const { file } = item;
  if (file.size > MAX_BYTES) throw new Error('Fichier trop volumineux (> 1 Go).');
  if (item.route !== 'image' && !hasCompression()) throw new Error('CompressionStream non supporté par ce navigateur.');
  const res = item.route === 'image' ? await compressImage(file, opts)
    : item.route === 'text' ? await compressText(file)
    : await compressArchive(file);
  releaseOutput(item);
  // Pas de gain → on conserve l'original (téléchargement inchangé)
  if (res.blob.size >= file.size) {
    item.out = file;
    item.outName = file.name;
    item.status = 'skip';
  } else {
    item.out = res.blob;
    item.outName = res.name;
    item.status = 'done';
  }
  item.url = URL.createObjectURL(item.out);
}

/* ------------------------------ Mémoire ------------------------------- */

function releaseOutput(item) {
  if (item.url) URL.revokeObjectURL(item.url);
  item.url = null;
  item.out = null;
  item.outName = '';
}

function releaseZip() {
  if (s?.zipUrl) URL.revokeObjectURL(s.zipUrl);
  if (s) s.zipUrl = null;
}

function releaseAll() {
  if (!s) return;
  s.items.forEach(releaseOutput);
  releaseZip();
}

/* --------------------------------- UI --------------------------------- */

function readOpts() {
  const level = LEVELS[q('level').value] ?? LEVELS.balanced;
  const maxDim = Math.min(16000, Math.max(16, parseInt(q('maxdim').value, 10) || 1920));
  return { q: level.q, format: q('format').value, resize: q('resize').checked, maxDim };
}

function syncButtons() {
  const hasItems = s.items.length > 0;
  const hasDone = s.items.some((i) => i.url);
  q('run').disabled = s.busy || !hasItems;
  q('zip').disabled = s.busy || !hasDone || !hasCompression();
  q('cancel').disabled = !s.busy;
  q('reset').disabled = s.busy || !hasItems;
  q('maxdim').disabled = !q('resize').checked;
}

function render() {
  const rows = q('rows');
  q('table').hidden = s.items.length === 0;
  rows.innerHTML = s.items.map((it) => {
    const done = it.out && (it.status === 'done' || it.status === 'skip');
    const gain = done ? Math.round((1 - it.out.size / it.file.size) * 100) : null;
    const gainTxt = gain === null ? '—' : gain > 0 ? `-${gain} %` : '0 %';
    return `<tr data-id="${it.id}">
      <td class="name" title="${esc(it.file.name)}">${esc(it.file.name)}</td>
      <td>${fmtSize(it.file.size)}</td>
      <td>${done ? fmtSize(it.out.size) : '—'}</td>
      <td class="gain${gain > 0 ? '' : ' none'}">${gainTxt}</td>
      <td class="st-${it.status}" title="${esc(it.error ?? '')}">${STATUS[it.status]}${it.error ? ' : ' + esc(it.error) : ''}</td>
      <td>${it.url ? `<a class="fcmp-btn icon-btn" href="${it.url}" download="${esc(it.outName)}" title="Télécharger"><i data-lucide="download"></i></a>` : ''}
          <button class="fcmp-btn icon-btn" data-remove="${it.id}" title="Retirer" ${s.busy ? 'disabled' : ''}><i data-lucide="trash-2"></i></button></td>
    </tr>`;
  }).join('');

  const done = s.items.filter((i) => i.out);
  const tin = done.reduce((a, i) => a + i.file.size, 0);
  const tout = done.reduce((a, i) => a + i.out.size, 0);
  q('total').textContent = done.length
    ? `Total : ${fmtSize(tin)} → ${fmtSize(tout)} (${tin > tout ? '-' + Math.round((1 - tout / tin) * 100) : '0'} %)`
    : '';
  syncButtons();
  refreshIcons();
}

let nextId = 1;
function addFiles(list) {
  const files = Array.from(list ?? []);
  if (!files.length) return;
  for (const file of files) {
    s.items.push({ id: nextId++, file, route: routeOf(file), status: 'pending', out: null, outName: '', url: null, error: '' });
  }
  releaseZip();
  setStatus(`${files.length} fichier(s) ajouté(s).`);
  render();
}

function removeItem(id) {
  const i = s.items.findIndex((x) => x.id === id);
  if (i < 0) return;
  releaseOutput(s.items[i]);
  s.items.splice(i, 1);
  releaseZip();
  render();
}

async function runAll() {
  if (s.busy || !s.items.length) return;
  s.busy = true;
  s.cancelled = false;
  releaseZip();
  const opts = readOpts();
  const todo = s.items;
  q('bar').style.width = '0%';
  syncButtons();
  for (let i = 0; i < todo.length; i++) {
    if (s.cancelled) break;
    const it = todo[i];
    it.status = 'working';
    it.error = '';
    setStatus(`Compression ${i + 1}/${todo.length} : ${it.file.name}`);
    render();
    try {
      await processItem(it, opts);
    } catch (e) {
      releaseOutput(it);
      it.status = 'error';
      it.error = e?.message ?? 'échec';
    }
    if (!s) return; // démonté pendant le traitement
    q('bar').style.width = Math.round(((i + 1) / todo.length) * 100) + '%';
  }
  s.busy = false;
  todo.forEach((it) => { if (it.status === 'working') it.status = 'pending'; });
  setStatus(s.cancelled ? 'Opération annulée.' : 'Compression terminée.');
  render();
}

async function zipAll() {
  const done = s.items.filter((i) => i.out);
  if (!done.length || s.busy) return;
  s.busy = true;
  syncButtons();
  setStatus('Création de l\'archive ZIP…');
  try {
    const used = new Set();
    const blob = await zipOf(done.map((i) => ({ name: uniqueName(i.outName, used), blob: i.out })));
    if (!s) return;
    releaseZip();
    s.zipUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = s.zipUrl;
    a.download = `compression-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(`Archive ZIP prête (${fmtSize(blob.size)}).`);
  } catch (e) {
    if (s) setStatus(e?.message ?? 'Création du ZIP impossible.', true);
  } finally {
    if (s) { s.busy = false; syncButtons(); }
  }
}

function reset() {
  if (s.busy) return;
  releaseAll();
  s.items = [];
  q('bar').style.width = '0%';
  q('input').value = '';
  setStatus('');
  render();
}

/* ------------------------------ Contrat ------------------------------- */

export function mount(container, ctx) {
  if (s) unmount();
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  container.innerHTML = TEMPLATE;
  s = { root: container, ctx, items: [], busy: false, cancelled: false, zipUrl: null };

  const drop = q('drop');
  const on = (el, ev, fn) => el.addEventListener(ev, fn);
  on(q('input'), 'change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => on(drop, ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => on(drop, ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  on(drop, 'drop', (e) => addFiles(e.dataTransfer?.files));
  on(q('resize'), 'change', syncButtons);
  on(q('run'), 'click', runAll);
  on(q('zip'), 'click', zipAll);
  on(q('cancel'), 'click', () => { s.cancelled = true; setStatus('Annulation…'); });
  on(q('reset'), 'click', reset);
  on(q('rows'), 'click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) removeItem(Number(b.dataset.remove));
  });

  if (!hasCompression()) setStatus('CompressionStream indisponible : seules les images seront compressées.', true);
  render();
}

export function unmount() {
  if (!s) return;
  s.cancelled = true;
  releaseAll();
  s.root.innerHTML = '';
  document.getElementById(STYLE_ID)?.remove();
  s = null;
}
