/**
 * exif-cleaner.js — Nettoyeur de métadonnées EXIF (JPG / PNG / WEBP), 100 % local.
 * Redessine chaque image sur un <canvas> hors-écran à sa taille native → aucune métadonnée conservée.
 */
import { readJpegExif } from '../shared/exif-utils.js';

const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const SUPPORTED = new Set(Object.values(EXT_MIME));

let state = null;

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const fmtSize = (bytes) => {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1048576).toFixed(2)} Mo`;
};

const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const baseOf = (name) => name.replace(/\.[^.]+$/, '');
const mimeOf = (file) => SUPPORTED.has(file.type) ? file.type : (EXT_MIME[extOf(file.name)] || '');

/* ---------- Détection métadonnées ---------- */

function scanJpegSegments(buffer) {
  const found = [];
  const view = new DataView(buffer);
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xFF) { offset += 1; continue; }
    while (offset < view.byteLength && view.getUint8(offset) === 0xFF) offset += 1;
    const marker = view.getUint8(offset);
    offset += 1;
    if (marker === 0xD9 || marker === 0xDA) break;
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) continue;
    if (offset + 2 > view.byteLength) break;
    const len = view.getUint16(offset, false);
    if (len < 2) break;
    const head = new Uint8Array(buffer, offset + 2, Math.min(32, Math.max(0, len - 2)));
    const text = String.fromCharCode(...head);
    if (marker === 0xE1 && text.startsWith('http://ns.adobe.com/xap')) found.push('XMP');
    else if (marker === 0xED) found.push('IPTC');
    else if (marker === 0xE2 && text.startsWith('ICC_PROFILE')) found.push('Profil ICC');
    else if (marker === 0xFE) found.push('Commentaire');
    offset += len;
  }
  return found;
}

function scanPng(buffer) {
  const found = [];
  const view = new DataView(buffer);
  let offset = 8;
  while (offset + 12 <= view.byteLength) {
    const len = view.getUint32(offset, false);
    const type = String.fromCharCode(...new Uint8Array(buffer, offset + 4, 4));
    if (type === 'eXIf') found.push('EXIF');
    else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') found.push('Texte');
    else if (type === 'tIME') found.push('Date');
    else if (type === 'iCCP') found.push('Profil ICC');
    if (type === 'IEND') break;
    offset += 12 + len;
  }
  return [...new Set(found)];
}

function scanWebp(buffer) {
  const found = [];
  const view = new DataView(buffer);
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const type = String.fromCharCode(...new Uint8Array(buffer, offset, 4));
    const len = view.getUint32(offset + 4, true);
    if (type === 'EXIF') found.push('EXIF');
    else if (type === 'XMP ') found.push('XMP');
    else if (type === 'ICCP') found.push('Profil ICC');
    offset += 8 + len + (len % 2);
  }
  return found;
}

async function detectMetadata(file, mime) {
  const info = { tags: [], exifCount: 0, gps: null, camera: '' };
  try {
    const buffer = await file.arrayBuffer();
    if (mime === 'image/jpeg') {
      info.tags.push(...scanJpegSegments(buffer));
      try {
        const { metadata, location } = readJpegExif(buffer);
        info.exifCount = metadata.length;
        info.gps = location;
        const make = metadata.find((m) => m.label === 'Fabricant')?.value;
        const model = metadata.find((m) => m.label === 'Modèle')?.value;
        info.camera = [make, model].filter(Boolean).join(' ');
        info.tags.unshift('EXIF');
      } catch { /* pas d'EXIF lisible */ }
    } else if (mime === 'image/png') {
      info.tags.push(...scanPng(buffer));
    } else if (mime === 'image/webp') {
      info.tags.push(...scanWebp(buffer));
    }
  } catch { /* lecture impossible */ }
  info.tags = [...new Set(info.tags)];
  return info;
}

/* ---------- Décodage / nettoyage ---------- */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function readDimensions(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return { w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function stripItem(item, quality) {
  const url = URL.createObjectURL(item.file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c2d = canvas.getContext('2d');
    c2d.drawImage(img, 0, 0, w, h);
    let type = item.mime;
    let ext = extOf(item.file.name) || 'png';
    const q = type === 'image/png' ? undefined : quality;
    let blob = await canvasToBlob(canvas, type, q);
    if (!blob || blob.type !== type) {
      if (type === 'image/webp') { // Fallback Safari : WebP → PNG
        blob = await canvasToBlob(canvas, 'image/png');
        type = 'image/png';
        ext = 'png';
        item.fallback = true;
      } else {
        throw new Error('Export impossible');
      }
    }
    item.blob = blob;
    item.outName = `${baseOf(item.file.name)}-sans-exif.${ext}`;
    canvas.width = canvas.height = 0;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- Montage ---------- */

export function mount(container, ctx) {
  unmount();
  const ac = new AbortController();
  const { signal } = ac;
  const timers = new Set();
  const items = [];
  let uid = 0;
  let busy = false;
  let notice = '';

  state = { ac, timers, items, container };

  const root = el('div', 'exif-cleaner');
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.gap = 'var(--space-4)';

  /* Dropzone */
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
  input.multiple = true;
  input.hidden = true;

  const dropzone = el('div', 'dropzone');
  dropzone.tabIndex = 0;
  dropzone.setAttribute('role', 'button');
  dropzone.setAttribute('aria-label', 'Ajouter des images JPG, PNG ou WEBP');
  dropzone.append(
    el('strong', '', 'Glissez-déposez vos images ici'),
    el('span', '', 'ou cliquez pour sélectionner · JPG, PNG, WEBP (un ou plusieurs fichiers)'),
    input,
  );

  /* Options */
  const options = el('div', 'exif-cleaner-options');
  options.style.display = 'flex';
  options.style.alignItems = 'center';
  options.style.gap = 'var(--space-3)';
  options.style.flexWrap = 'wrap';
  const qLabel = el('label', '', 'Qualité JPEG / WEBP');
  const qInput = document.createElement('input');
  qInput.type = 'range';
  qInput.min = '50';
  qInput.max = '100';
  qInput.step = '1';
  qInput.value = '92';
  qInput.id = 'exif-cleaner-quality';
  qLabel.htmlFor = qInput.id;
  const qValue = el('span', '', '92 %');
  options.append(qLabel, qInput, qValue);

  /* Résumé + liste */
  const summary = el('div', 'zipa-summary');
  const list = el('div', 'zipa-list');

  /* Actions */
  const actions = el('div', 'exif-cleaner-actions');
  actions.style.display = 'flex';
  actions.style.gap = 'var(--space-3)';
  actions.style.flexWrap = 'wrap';
  const btnClean = el('button', 'btn btn-primary', 'Supprimer les métadonnées');
  btnClean.type = 'button';
  const btnAll = el('button', 'btn btn-secondary', 'Tout télécharger');
  btnAll.type = 'button';
  const btnClear = el('button', 'btn btn-secondary', 'Vider la liste');
  btnClear.type = 'button';
  actions.append(btnClean, btnAll, btnClear);

  root.append(dropzone, options, summary, list, actions);
  container.append(root);

  /* ----- helpers ----- */
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };

  const downloadItem = (item) => {
    if (!item.blob) return;
    const url = URL.createObjectURL(item.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.outName;
    document.body.append(a);
    a.click();
    a.remove();
    later(() => URL.revokeObjectURL(url), 2000);
  };

  const resetResults = () => {
    items.forEach((it) => { it.blob = null; it.outName = ''; it.status = 'pending'; it.fallback = false; });
    render();
  };

  const removeItem = (id) => {
    const i = items.findIndex((it) => it.id === id);
    if (i >= 0) items.splice(i, 1);
    render();
  };

  /* ----- rendu ----- */
  function metaText(it) {
    const parts = [];
    if (it.w) parts.push(`${it.w} × ${it.h} px`);
    if (it.meta) {
      if (it.meta.tags.length) {
        let t = `Métadonnées : ${it.meta.tags.join(', ')}`;
        if (it.meta.exifCount) t += ` (${it.meta.exifCount} tags EXIF)`;
        parts.push(t);
      } else {
        parts.push('Aucune métadonnée détectée');
      }
      if (it.meta.camera) parts.push(it.meta.camera);
      if (it.meta.gps) parts.push(`GPS : ${it.meta.gps.latitude}, ${it.meta.gps.longitude}`);
    }
    return parts.join(' · ');
  }

  function render() {
    list.replaceChildren();
    for (const it of items) {
      const row = el('div', 'zipa-row');
      const name = el('span', 'zipa-name', it.file.name);
      name.title = it.file.name;
      const size = el('span', 'zipa-size', fmtSize(it.file.size));
      row.append(name, size);

      const info = el('span', 'zipa-size', metaText(it) || 'Analyse…');
      row.append(info);

      if (it.status === 'busy') row.append(el('span', 'zipa-size', 'Nettoyage…'));
      else if (it.status === 'error') row.append(el('span', 'zipa-size', 'Erreur'));
      else if (it.status === 'done' && it.blob) {
        const delta = it.file.size - it.blob.size;
        const pct = it.file.size ? Math.round((delta / it.file.size) * 100) : 0;
        row.append(el('span', 'zipa-size', `→ ${fmtSize(it.blob.size)} (${pct >= 0 ? '−' : '+'}${Math.abs(pct)} %)${it.fallback ? ' · PNG (WebP non supporté)' : ''}`));
        const dl = el('button', 'btn btn-secondary', 'Télécharger');
        dl.type = 'button';
        dl.addEventListener('click', () => downloadItem(it), { signal });
        row.append(dl);
      }

      const rm = el('button', 'btn-remove-file', '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Retirer ${it.file.name}`);
      rm.addEventListener('click', () => removeItem(it.id), { signal });
      row.append(rm);
      list.append(row);
    }

    const total = items.reduce((s, it) => s + it.file.size, 0);
    const done = items.filter((it) => it.status === 'done').length;
    const withGps = items.filter((it) => it.meta?.gps).length;
    const lines = [];
    if (items.length) {
      lines.push(`${items.length} fichier(s) · ${fmtSize(total)}${done ? ` · ${done} nettoyé(s)` : ''}${withGps ? ` · ${withGps} avec GPS` : ''}`);
    }
    if (notice) lines.push(notice);
    summary.textContent = lines.join(' — ');
    summary.hidden = lines.length === 0;
    list.hidden = items.length === 0;
    actions.hidden = items.length === 0;
    options.hidden = items.length === 0;
    btnClean.disabled = busy || items.length === 0;
    btnAll.disabled = busy || done === 0;
    btnClear.disabled = busy;
    const hasLossy = items.some((it) => it.mime !== 'image/png');
    options.hidden = items.length === 0 || !hasLossy;
    if (ctx?.refreshIcons) ctx.refreshIcons(root);
  }

  /* ----- ajout de fichiers ----- */
  async function addFiles(fileList) {
    const rejected = [];
    const fresh = [];
    for (const file of fileList) {
      const mime = mimeOf(file);
      if (!mime) { rejected.push(file.name); continue; }
      const item = { id: ++uid, file, mime, w: 0, h: 0, meta: null, status: 'pending', blob: null, outName: '', fallback: false };
      items.push(item);
      fresh.push(item);
    }
    notice = rejected.length ? `Format non pris en charge : ${rejected.join(', ')}` : '';
    render();
    await Promise.all(fresh.map(async (it) => {
      try {
        const [dims, meta] = await Promise.all([readDimensions(it.file), detectMetadata(it.file, it.mime)]);
        it.w = dims.w;
        it.h = dims.h;
        it.meta = meta;
      } catch {
        it.status = 'error';
      }
      if (state && state.ac === ac) render();
    }));
  }

  async function cleanAll() {
    if (busy) return;
    busy = true;
    const quality = Number(qInput.value) / 100;
    for (const it of items) {
      if (signal.aborted) return;
      if (it.status === 'done' && it.blob) continue;
      it.status = 'busy';
      render();
      try {
        await stripItem(it, quality);
        it.status = 'done';
      } catch {
        it.status = 'error';
      }
      render();
    }
    busy = false;
    render();
  }

  function downloadAll() {
    items.filter((it) => it.blob).forEach((it, i) => later(() => downloadItem(it), i * 300));
  }

  /* ----- événements ----- */
  dropzone.addEventListener('click', (e) => { if (e.target !== input) input.click(); }, { signal });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  }, { signal });
  input.addEventListener('change', () => {
    if (input.files?.length) addFiles([...input.files]);
    input.value = '';
  }, { signal });
  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover', 'is-dragover');
  }, { signal }));
  ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover', 'is-dragover');
  }, { signal }));
  dropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files);
  }, { signal });

  qInput.addEventListener('input', () => {
    qValue.textContent = `${qInput.value} %`;
  }, { signal });
  qInput.addEventListener('change', () => { if (!busy) resetResults(); }, { signal });
  btnClean.addEventListener('click', cleanAll, { signal });
  btnAll.addEventListener('click', downloadAll, { signal });
  btnClear.addEventListener('click', () => { items.length = 0; notice = ''; render(); }, { signal });

  render();
}

export function unmount() {
  if (!state) return;
  state.ac.abort();
  state.timers.forEach((id) => clearTimeout(id));
  state.timers.clear();
  state.items.length = 0;
  state.container?.replaceChildren();
  state = null;
}
