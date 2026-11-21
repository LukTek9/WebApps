/**
 * favicon-generator.js — Génération locale de favicon.ico (16/32/48) + PNG Apple/PWA.
 * Pipeline : image → canvas (forme + ajustement cover/contain + fond) → PNG → conteneur ICO (PNG embarqués).
 * Contrat : mount(container, ctx) / unmount().
 */

const PREVIEW_SIZES = [16, 32, 48, 180, 512];
const ICO_SIZES = [16, 32, 48];
const PNG_EXPORTS = [
  { size: 16,  name: 'favicon-16x16.png',    label: '16×16' },
  { size: 32,  name: 'favicon-32x32.png',    label: '32×32' },
  { size: 180, name: 'apple-touch-icon.png', label: 'Apple 180' },
  { size: 192, name: 'icon-192.png',         label: 'PWA 192' },
  { size: 512, name: 'icon-512.png',         label: 'PWA 512' },
];
const HTML_SNIPPET = `<!-- Favicon -->
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">

<!-- PWA : dans manifest.webmanifest, "icons" -->
<!-- [{"src":"/icon-192.png","sizes":"192x192","type":"image/png"},
     {"src":"/icon-512.png","sizes":"512x512","type":"image/png"}] -->
<link rel="manifest" href="/manifest.webmanifest">`;

let state = null;

/* ------------------------------------------------------------------ */
/* Moteur Canvas                                                      */
/* ------------------------------------------------------------------ */

/** Réduction progressive (÷2) pour une qualité de redimensionnement supérieure. */
function stepDown(src, sw, sh, tw, th) {
  let cur = src, cw = sw, ch = sh, tmpCanvases = [];
  while (cw / 2 >= tw && ch / 2 >= th) {
    const nw = Math.floor(cw / 2), nh = Math.floor(ch / 2);
    const c = document.createElement('canvas');
    c.width = nw; c.height = nh;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    tmpCanvases.push(c);
    cur = c; cw = nw; ch = nh;
  }
  return { canvas: cur, w: cw, h: ch, tmp: tmpCanvases };
}

/** Trace la forme (carré / arrondi / cercle) comme chemin de clipping. */
function shapePath(ctx, size, shape) {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  } else if (shape === 'rounded') {
    const r = size * 0.22;
    ctx.moveTo(r, 0);
    ctx.arcTo(size, 0, size, size, r);
    ctx.arcTo(size, size, 0, size, r);
    ctx.arcTo(0, size, 0, 0, r);
    ctx.arcTo(0, 0, size, 0, r);
    ctx.closePath();
  } else {
    ctx.rect(0, 0, size, size);
  }
}

/** Rend l'icône à `size` px dans un nouveau canvas. */
function renderIcon(img, size, o) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const iw = img.naturalWidth, ih = img.naturalHeight;
  ctx.save();
  shapePath(ctx, size, o.shape);
  ctx.clip();
  if (!o.transparent) {
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, size, size);
  }
  // Rectangle de destination : cover = remplit, contain = tient entièrement
  const k = o.fit === 'cover' ? Math.max(size / iw, size / ih) : Math.min(size / iw, size / ih);
  const dw = iw * k, dh = ih * k;
  const dx = (size - dw) / 2, dy = (size - dh) / 2;
  const { canvas, tmp } = stepDown(img, iw, ih, Math.ceil(dw), Math.ceil(dh));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, dx, dy, dw, dh);
  ctx.restore();
  tmp.forEach((c) => { c.width = c.height = 0; }); // libère les canvas intermédiaires
  return cv;
}

const toPng = (cv) =>
  new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Encodage PNG impossible.'))), 'image/png'));

/** Encode un ICO multi-tailles (images PNG embarquées, supporté par tous les navigateurs modernes). */
async function encodeIco(img, sizes, o) {
  const pngs = [];
  for (const sz of sizes) {
    const cv = renderIcon(img, sz, o);
    pngs.push(new Uint8Array(await (await toPng(cv)).arrayBuffer()));
    cv.width = cv.height = 0;
  }
  const headLen = 6 + 16 * pngs.length;
  const total = headLen + pngs.reduce((a, p) => a + p.length, 0);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint16(0, 0, true);            // réservé
  dv.setUint16(2, 1, true);            // type 1 = ICO
  dv.setUint16(4, pngs.length, true);  // nb d'images
  let offset = headLen;
  pngs.forEach((p, i) => {
    const e = 6 + i * 16;
    dv.setUint8(e, sizes[i] >= 256 ? 0 : sizes[i]);      // largeur
    dv.setUint8(e + 1, sizes[i] >= 256 ? 0 : sizes[i]);  // hauteur
    dv.setUint8(e + 2, 0);                                // palette
    dv.setUint8(e + 3, 0);                                // réservé
    dv.setUint16(e + 4, 1, true);                         // plans
    dv.setUint16(e + 6, 32, true);                        // bits/pixel
    dv.setUint32(e + 8, p.length, true);                  // taille données
    dv.setUint32(e + 12, offset, true);                   // offset données
    u8.set(p, offset);
    offset += p.length;
  });
  return new Blob([buf], { type: 'image/x-icon' });
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

export function mount(container, ctx) {
  unmount();

  container.innerHTML = `
    <div class="fav">
      <div class="fav-drop" tabindex="0">
        <strong>Déposez votre logo ici ou cliquez pour parcourir</strong>
        <span class="fav-info">PNG, JPG, WEBP, SVG — carré de 512 px minimum recommandé</span>
        <input type="file" accept="image/*" hidden>
      </div>
      <div class="fav-panel" hidden>
        <label>Forme d'icône
          <select data-k="shape">
            <option value="square">Carré</option>
            <option value="rounded">Bords arrondis</option>
            <option value="circle">Cercle</option>
          </select>
        </label>
        <label>Ajustement
          <select data-k="fit">
            <option value="cover">Couvrir (Cover)</option>
            <option value="contain">Contenir (Contain)</option>
          </select>
        </label>
        <label>Couleur de fond
          <input type="color" data-k="bg" value="#ffffff">
        </label>
        <label class="fav-chk"><input type="checkbox" data-k="transparent"> Fond transparent</label>
      </div>
      <div class="fav-grid checkerboard-bg" hidden></div>
      <div class="fav-export" hidden>
        <button class="fav-btn" data-ico><i data-lucide="download"></i>favicon.ico</button>
        <span data-png class="fav-export"></span>
      </div>
      <div class="fav-code" hidden>
        <pre><code data-code></code></pre>
        <button class="fav-btn alt" data-copy><i data-lucide="copy"></i><span>Copier</span></button>
      </div>
      <div class="fav-info" data-status></div>
    </div>`;

  const $ = (sel) => container.querySelector(sel);
  const s = state = {
    container,
    drop: $('.fav-drop'),
    input: $('input[type=file]'),
    panel: $('.fav-panel'),
    grid: $('.fav-grid'),
    exp: $('.fav-export'),
    code: $('.fav-code'),
    status: $('[data-status]'),
    img: null,
    imgUrl: null,
    dlUrl: null,
    baseName: 'favicon',
    timer: null,
    listeners: [],
    copyTimer: null,
  };
  const refreshIcons = () => window.lucide?.createIcons();
  const on = (el, ev, fn) => { el.addEventListener(ev, fn); s.listeners.push([el, ev, fn]); };
  const setStatus = (m = '') => { s.status.textContent = m; };

  $('[data-code]').textContent = HTML_SNIPPET;

  // Boutons PNG
  const pngBox = $('[data-png]');
  PNG_EXPORTS.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'fav-btn alt';
    b.dataset.png = p.size;
    b.innerHTML = `<i data-lucide="image"></i>${p.label}`;
    pngBox.appendChild(b);
    on(b, 'click', () => exportPng(p));
  });
  refreshIcons();

  /* Dépôt */
  on(s.drop, 'click', () => s.input.click());
  on(s.drop, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.input.click(); } });
  on(s.drop, 'dragover', (e) => { e.preventDefault(); s.drop.classList.add('over'); });
  on(s.drop, 'dragleave', () => s.drop.classList.remove('over'));
  on(s.drop, 'drop', (e) => {
    e.preventDefault();
    s.drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
  on(s.input, 'change', () => { if (s.input.files[0]) loadFile(s.input.files[0]); });

  /* Réglages */
  container.querySelectorAll('[data-k]').forEach((el) => {
    on(el, 'input', () => {
      if (el.dataset.k === 'transparent') $('[data-k="bg"]').disabled = el.checked;
      schedule();
    });
  });

  /* Export ICO */
  on($('[data-ico]'), 'click', async () => {
    if (!s.img) return;
    try {
      setStatus('Encodage ICO…');
      download(await encodeIco(s.img, ICO_SIZES, opts()), 'favicon.ico');
      setStatus('favicon.ico (16, 32, 48 px) généré.');
    } catch (err) {
      setStatus(`Erreur : ${err.message}`);
    }
  });

  /* Copie HTML */
  on($('[data-copy]'), 'click', async () => {
    const label = $('[data-copy] span');
    let ok = false;
    try {
      await navigator.clipboard.writeText(HTML_SNIPPET);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = HTML_SNIPPET;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { /* ignoré */ }
      ta.remove();
    }
    label.textContent = ok ? 'Copié !' : 'Échec';
    clearTimeout(s.copyTimer);
    s.copyTimer = setTimeout(() => { if (state === s) label.textContent = 'Copier'; }, 1500);
  });

  function opts() {
    const v = (k) => container.querySelector(`[data-k="${k}"]`);
    return {
      shape: v('shape').value,
      fit: v('fit').value,
      bg: v('bg').value,
      transparent: v('transparent').checked,
    };
  }

  function download(blob, name) {
    if (s.dlUrl) URL.revokeObjectURL(s.dlUrl);
    s.dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = s.dlUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { if (s.dlUrl) { URL.revokeObjectURL(s.dlUrl); s.dlUrl = null; } }, 1000);
  }

  async function exportPng(p) {
    if (!s.img) return;
    try {
      const cv = renderIcon(s.img, p.size, opts());
      const blob = await toPng(cv);
      cv.width = cv.height = 0;
      download(blob, p.name);
      setStatus(`${p.name} généré.`);
    } catch (err) {
      setStatus(`Erreur : ${err.message}`);
    }
  }

  function loadFile(file) {
    if (!file.type.startsWith('image/')) { setStatus('Fichier non supporté.'); return; }
    if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
    s.imgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (state !== s) return;
      // SVG sans dimensions : force une taille de rendu
      if (!img.naturalWidth || !img.naturalHeight) { setStatus("Dimensions de l'image illisibles."); return; }
      s.img = img;
      s.panel.hidden = s.grid.hidden = s.exp.hidden = s.code.hidden = false;
      setStatus(`${file.name} — ${img.naturalWidth}×${img.naturalHeight}px`);
      render();
    };
    img.onerror = () => setStatus("Impossible de lire l'image.");
    img.src = s.imgUrl;
  }

  function schedule() {
    clearTimeout(s.timer);
    s.timer = setTimeout(render, 100);
  }

  /** Aperçu dynamique : grille 16/32/48/180/512. */
  function render() {
    if (!s.img || state !== s) return;
    const o = opts();
    s.grid.querySelectorAll('canvas').forEach((c) => { c.width = c.height = 0; });
    s.grid.innerHTML = '';
    PREVIEW_SIZES.forEach((sz) => {
      const cell = document.createElement('div');
      cell.className = 'fav-cell';
      const cv = renderIcon(s.img, sz, o);
      cv.style.width = Math.min(sz, 160) + 'px';
      cv.style.height = Math.min(sz, 160) + 'px';
      const lb = document.createElement('span');
      lb.textContent = `${sz}×${sz}`;
      cell.append(cv, lb);
      s.grid.appendChild(cell);
    });
  }
}

export function unmount() {
  if (!state) return;
  clearTimeout(state.timer);
  clearTimeout(state.copyTimer);
  state.listeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
  state.grid.querySelectorAll('canvas').forEach((c) => { c.width = c.height = 0; });
  if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
  if (state.dlUrl) URL.revokeObjectURL(state.dlUrl);
  state.img = null;
  state.container.innerHTML = '';
  state = null;
}
