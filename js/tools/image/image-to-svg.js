/**
 * image-to-svg.js — Vectorisation locale d'images (PNG/JPG/WEBP → SVG).
 * Pipeline : Canvas.getImageData → niveaux de gris → flou (lissage) → seuil binaire
 *            → extraction de contours (arêtes de pixels chaînées) → Douglas-Peucker → <path> SVG.
 * Contrat : mount(container, ctx) / unmount().
 */

const MAX_SIDE = 1024;      // côté max de travail (perf)
const MIN_AREA = 4;         // aire min (px²) d'un contour conservé (anti-bruit)

let state = null;           // état du module monté (null si démonté)

/**
 * Badge de valeur éditable : clic → <input type=number> (bornes/pas du curseur).
 * Enter/blur valide (slider.value + événement `input` → état + aperçu), Échap annule.
 */
function editable(badge, slider, fmt, cls) {
  if (!badge || !slider) return;
  badge.classList.add(cls);
  badge.tabIndex = 0;
  badge.setAttribute('role', 'button');
  badge.title = 'Cliquer pour saisir une valeur';
  const open = () => {
    if (badge.querySelector('input')) return;
    const min = parseFloat(slider.min), max = parseFloat(slider.max), step = parseFloat(slider.step) || 1;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = cls + '-input';
    inp.min = min; inp.max = max; inp.step = step; inp.value = slider.value;
    badge.textContent = '';
    badge.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const close = (commit, refocus) => {
      if (done) return;
      done = true;
      const raw = parseFloat(inp.value);
      inp.remove();
      if (commit && Number.isFinite(raw)) {
        slider.value = String(Math.min(Math.max(raw, min), max)); // le curseur applique le pas
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      badge.textContent = fmt(slider.value);
      if (refocus) badge.focus();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false, true); }
    });
    inp.addEventListener('blur', () => close(true, false));
  };
  badge.addEventListener('click', (e) => { if (e.target !== badge) return; e.preventDefault(); open(); }); // preventDefault : évite l'activation du <label>
  badge.addEventListener('keydown', (e) => { if (e.target === badge && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } });
}

/* ------------------------------------------------------------------ */
/* Moteur de vectorisation                                            */
/* ------------------------------------------------------------------ */

/** RGBA → niveaux de gris (alpha composité sur fond blanc). */
function toGray(data, n) {
  const g = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3] / 255;
    const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    g[i] = l * a + 255 * (1 - a);
  }
  return g;
}

/** Flou boîte séparable (rayon r) — lissage préalable du bruit. */
function boxBlur(src, w, h, r) {
  if (r < 1) return src;
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[row + Math.min(w - 1, Math.max(0, x + k))];
      tmp[row + x] = s / d;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = s / d;
    }
  }
  return out;
}

/**
 * Extraction de contours fermés d'un masque binaire.
 * Arêtes orientées (intérieur à droite) entre pixel plein / vide, chaînées en anneaux.
 * Retourne un tableau d'anneaux [[x,y,x,y,...], ...] (sommets aux changements de direction).
 */
function traceContours(mask, w, h) {
  const W = w + 1;
  const sx = [], sy = [], dir = [];
  const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  // dir : 0 → droite, 1 ↓ bas, 2 ← gauche, 3 ↑ haut
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!filled(x, y - 1)) { sx.push(x);     sy.push(y);     dir.push(0); }
      if (!filled(x + 1, y)) { sx.push(x + 1); sy.push(y);     dir.push(1); }
      if (!filled(x, y + 1)) { sx.push(x + 1); sy.push(y + 1); dir.push(2); }
      if (!filled(x - 1, y)) { sx.push(x);     sy.push(y + 1); dir.push(3); }
    }
  }
  const E = sx.length;
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  // index des arêtes sortantes par sommet (max 2)
  const out = new Int32Array((W * (h + 1)) * 2).fill(-1);
  for (let e = 0; e < E; e++) {
    const v = (sy[e] * W + sx[e]) * 2;
    if (out[v] < 0) out[v] = e; else out[v + 1] = e;
  }
  const used = new Uint8Array(E);
  const rings = [];
  for (let e0 = 0; e0 < E; e0++) {
    if (used[e0]) continue;
    const ring = [];
    let e = e0;
    while (e >= 0 && !used[e]) {
      used[e] = 1;
      const d = dir[e];
      const ex = sx[e] + DX[d], ey = sy[e] + DY[d];
      // sommet de départ ajouté seulement si changement de direction
      const prevDir = ring.length ? ring.dirLast : dir[e0];
      if (ring.length === 0 || prevDir !== d) ring.push(sx[e], sy[e]);
      ring.dirLast = d;
      // arête suivante : priorité virage à droite, puis tout droit, puis gauche
      const v = (ey * W + ex) * 2;
      let next = -1;
      const c0 = out[v], c1 = out[v + 1];
      if (c0 >= 0 && !used[c0] && (c1 < 0 || used[c1])) next = c0;
      else if (c1 >= 0 && !used[c1] && (c0 < 0 || used[c0])) next = c1;
      else if (c0 >= 0 && c1 >= 0 && !used[c0] && !used[c1]) {
        const r = (d + 1) % 4;
        next = dir[c0] === r ? c0 : c1;
      }
      e = next;
    }
    if (ring.length >= 6) rings.push(ring);
  }
  return rings;
}

/** Aire absolue (formule du lacet) d'un anneau plat. */
function ringArea(p) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** Douglas-Peucker itératif sur polyligne ouverte [i0..i1] d'un tableau de points {x,y}. */
function dpOpen(pts, eps) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const e2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const ax = pts[a].x, ay = pts[a].y, bx = pts[b].x, by = pts[b].y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let d2;
      if (len2 === 0) {
        d2 = (pts[i].x - ax) ** 2 + (pts[i].y - ay) ** 2;
      } else {
        let t = ((pts[i].x - ax) * dx + (pts[i].y - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d2 = (pts[i].x - (ax + t * dx)) ** 2 + (pts[i].y - (ay + t * dy)) ** 2;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (idx > 0 && maxD > e2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplification d'un anneau fermé : coupe au point le plus éloigné du premier. */
function simplifyRing(flat, eps) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  if (eps <= 0 || pts.length < 5) return pts;
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const A = dpOpen(pts.slice(0, far + 1), eps);
  const B = dpOpen(pts.slice(far).concat([pts[0]]), eps);
  return A.slice(0, -1).concat(B.slice(0, -1));
}

const f = (v) => Math.round(v * 10) / 10;

/** Anneau simplifié → commande de chemin SVG (courbes quadratiques si `curved`). */
function ringToPath(pts, curved) {
  const n = pts.length;
  if (n < 3) return '';
  if (!curved) {
    let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
    for (let i = 1; i < n; i++) d += `L${f(pts[i].x)} ${f(pts[i].y)}`;
    return d + 'Z';
  }
  const mid = (a, b) => `${f((a.x + b.x) / 2)} ${f((a.y + b.y) / 2)}`;
  let d = `M${mid(pts[n - 1], pts[0])}`;
  for (let i = 0; i < n; i++) d += `Q${f(pts[i].x)} ${f(pts[i].y)} ${mid(pts[i], pts[(i + 1) % n])}`;
  return d + 'Z';
}

/**
 * Vectorise des pixels RGBA.
 * @param {{mode:'bw'|'outline'|'threshold', threshold:number, smooth:number}} o
 * @returns {{svg:string, paths:number}}
 */
function vectorize(imageData, o) {
  const { width: w, height: h, data } = imageData;
  let gray = toGray(data, w * h);
  gray = boxBlur(gray, w, h, Math.round(o.smooth / 3));       // lissage
  const invert = o.mode === 'threshold';                       // Seuil : zones claires remplies
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    const dark = gray[i] < o.threshold;
    mask[i] = (invert ? !dark : dark) ? 1 : 0;
  }
  const rings = traceContours(mask, w, h);
  const eps = o.smooth * 0.35;                                 // simplification
  const curved = o.smooth >= 4;
  let d = '', count = 0;
  for (const ring of rings) {
    if (ringArea(ring) < MIN_AREA) continue;
    const s = ringToPath(simplifyRing(ring, eps), curved);
    if (s) { d += s; count++; }
  }
  const attrs = o.mode === 'outline'
    ? 'fill="none" stroke="#000" stroke-width="1" stroke-linejoin="round"'
    : 'fill="#000" fill-rule="evenodd"';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<path d="${d}" ${attrs}/></svg>`;
  return { svg, paths: count };
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

export function mount(container, ctx) {
  unmount(); // sécurité : un seul montage actif

  container.innerHTML = `
    <div class="i2s">
      <div class="i2s-drop" tabindex="0">
        <strong>Déposez une image ici ou cliquez pour parcourir</strong>
        <span class="i2s-info">PNG, JPG, WEBP — traitement 100 % local</span>
        <input type="file" accept="image/*" hidden>
      </div>
      <div class="i2s-panel" hidden>
        <label>Mode de vectorisation
          <select data-k="mode">
            <option value="bw">Noir &amp; Blanc (zones sombres remplies)</option>
            <option value="outline">Contours (traits seuls)</option>
            <option value="threshold">Seuil (zones claires remplies)</option>
          </select>
        </label>
        <label>Seuil de luminance <span class="i2s-val" data-v="threshold">128</span>
          <input type="range" data-k="threshold" min="0" max="255" value="128">
        </label>
        <label>Lissage / simplification <span class="i2s-val" data-v="smooth">2</span>
          <input type="range" data-k="smooth" min="0" max="10" step="1" value="2">
        </label>
      </div>
      <div class="i2s-bar" hidden><i></i></div>
      <div class="i2s-view" hidden>
        <div class="i2s-box"><h4>Original</h4><div class="i2s-img" data-orig></div></div>
        <div class="i2s-box"><h4>SVG</h4><div class="i2s-img" data-out></div></div>
      </div>
      <div class="i2s-actions" hidden>
        <button class="i2s-btn" data-dl disabled>Télécharger le SVG</button>
        <span class="i2s-info" data-info></span>
      </div>
    </div>`;

  const $ = (s) => container.querySelector(s);
  const s = state = {
    container,
    drop: $('.i2s-drop'),
    input: $('input[type=file]'),
    panel: $('.i2s-panel'),
    bar: $('.i2s-bar'),
    barFill: $('.i2s-bar > i'),
    view: $('.i2s-view'),
    actions: $('.i2s-actions'),
    orig: $('[data-orig]'),
    out: $('[data-out]'),
    dl: $('[data-dl]'),
    info: $('[data-info]'),
    imgUrl: null,       // objectURL image source
    dlUrl: null,        // objectURL SVG téléchargé
    imageData: null,
    svg: '',
    fileName: 'image',
    timer: null,
    listeners: [],
    gen: 0,
  };

  const on = (el, ev, fn) => { el.addEventListener(ev, fn); s.listeners.push([el, ev, fn]); };

  /* Dépôt / sélection de fichier */
  on(s.drop, 'click', () => s.input.click());
  on(s.drop, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.input.click(); } });
  on(s.drop, 'dragover', (e) => { e.preventDefault(); s.drop.classList.add('over'); });
  on(s.drop, 'dragleave', () => s.drop.classList.remove('over'));
  on(s.drop, 'drop', (e) => {
    e.preventDefault();
    s.drop.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });
  on(s.input, 'change', () => { if (s.input.files[0]) loadFile(s.input.files[0]); });

  /* Réglages → re-vectorisation (debounce) */
  container.querySelectorAll('[data-k]').forEach((el) => {
    on(el, 'input', () => {
      const v = container.querySelector(`[data-v="${el.dataset.k}"]`);
      if (v) v.textContent = el.value;
      schedule();
    });
  });
  container.querySelectorAll('input[type=range][data-k]').forEach((el) =>
    editable(container.querySelector(`[data-v="${el.dataset.k}"]`), el, (v) => v, 'i2s-ev'));

  /* Téléchargement */
  on(s.dl, 'click', () => {
    if (!s.svg) return;
    if (s.dlUrl) URL.revokeObjectURL(s.dlUrl);
    s.dlUrl = URL.createObjectURL(new Blob([s.svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = s.dlUrl;
    a.download = `${s.fileName}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { if (s.dlUrl) { URL.revokeObjectURL(s.dlUrl); s.dlUrl = null; } }, 1000);
  });

  function setProgress(p) {
    s.bar.hidden = p == null;
    if (p != null) s.barFill.style.width = `${p}%`;
  }

  /** Charge l'image, la réduit à MAX_SIDE et extrait ses pixels via getImageData(). */
  function loadFile(file) {
    if (!file.type.startsWith('image/')) {
      s.info.textContent = 'Fichier non supporté.';
      s.actions.hidden = false;
      return;
    }
    s.fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
    if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
    s.imgUrl = URL.createObjectURL(file);
    setProgress(10);
    const img = new Image();
    img.onload = () => {
      if (state !== s) return;
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c2d = cv.getContext('2d', { willReadFrequently: true });
      c2d.fillStyle = '#fff';
      c2d.fillRect(0, 0, w, h);
      c2d.drawImage(img, 0, 0, w, h);
      s.imageData = c2d.getImageData(0, 0, w, h);
      cv.width = cv.height = 0; // libère le canvas
      s.orig.innerHTML = '';
      const preview = document.createElement('img');
      preview.src = s.imgUrl;
      preview.alt = 'Original';
      s.orig.appendChild(preview);
      s.panel.hidden = s.view.hidden = s.actions.hidden = false;
      setProgress(30);
      run();
    };
    img.onerror = () => {
      setProgress(null);
      s.actions.hidden = false;
      s.info.textContent = "Impossible de lire l'image.";
    };
    img.src = s.imgUrl;
  }

  function schedule() {
    clearTimeout(s.timer);
    s.timer = setTimeout(run, 150);
  }

  function opts() {
    const v = (k) => container.querySelector(`[data-k="${k}"]`).value;
    return { mode: v('mode'), threshold: +v('threshold'), smooth: +v('smooth') };
  }

  function run() {
    if (!s.imageData || state !== s) return;
    const gen = ++s.gen;
    s.dl.disabled = true;
    setProgress(60);
    // laisse le navigateur peindre la barre avant le calcul synchrone
    setTimeout(() => {
      if (state !== s || gen !== s.gen) return;
      try {
        const t0 = performance.now();
        const { svg, paths } = vectorize(s.imageData, opts());
        s.svg = svg;
        s.out.innerHTML = svg;
        s.dl.disabled = false;
        const kb = (new Blob([svg]).size / 1024).toFixed(1);
        s.info.textContent = `${paths} tracé(s) • ${kb} Ko • ${Math.round(performance.now() - t0)} ms`;
      } catch (err) {
        s.info.textContent = `Erreur de vectorisation : ${err.message}`;
      }
      setProgress(100);
      setTimeout(() => state === s && setProgress(null), 400);
    }, 20);
  }
}

export function unmount() {
  if (!state) return;
  clearTimeout(state.timer);
  state.gen++;
  state.listeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
  if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
  if (state.dlUrl) URL.revokeObjectURL(state.dlUrl);
  state.container.innerHTML = '';
  state = null;
}
