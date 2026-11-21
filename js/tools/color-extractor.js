/**
 * color-extractor.js — Pipette & extraction de palette dominante, 100 % local.
 * Pipette : API EyeDropper native (repli : survol/clic sur le canvas de l'image).
 * Palette : getImageData() → échantillonnage → k-means (init k-means++) dans l'espace RGB.
 * Contrat : mount(container, ctx) / unmount().
 */

const MAX_SIDE = 1024;       // côté max du canvas de travail
const MAX_SAMPLES = 12000;   // pixels échantillonnés pour k-means
const KMEANS_ITERS = 12;
const STYLE_ID = 'cex-style';

let state = null;

/* ------------------------------------------------------------------ */
/* Conversions de couleurs                                            */
/* ------------------------------------------------------------------ */

const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
const toHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

function parseHex(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [Math.round(h) % 360, Math.round(s * 100), Math.round(l * 100)];
}

function hslToRgb([h, s, l]) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToCmyk([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 100];
  const c = (1 - r - k) / (1 - k), m = (1 - g - k) / (1 - k), y = (1 - b - k) / (1 - k);
  return [c, m, y, k].map((v) => Math.round(v * 100));
}

/** Tous les formats d'une couleur. */
function formats(rgb) {
  const [r, g, b] = rgb;
  const [h, s, l] = rgbToHsl(rgb);
  const [c, m, y, k] = rgbToCmyk(rgb);
  return {
    hex: toHex(rgb),
    rgb: `rgb(${r}, ${g}, ${b})`,
    hsl: `hsl(${h}, ${s}%, ${l}%)`,
    cmjn: `cmjn(${c}%, ${m}%, ${y}%, ${k}%)`,
  };
}

/** Couleur de texte lisible sur un fond donné. */
const textOn = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff');

/* ------------------------------------------------------------------ */
/* K-means                                                            */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Extrait k couleurs dominantes d'un ImageData.
 * @returns {{rgb:number[], pct:number}[]} triées par part décroissante
 */
function extractPalette(imageData, k) {
  const { data, width, height } = imageData;
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / MAX_SAMPLES));
  const px = [];
  for (let i = 0; i < total; i += stride) {
    const p = i * 4;
    if (data[p + 3] < 125) continue; // ignore le transparent
    px.push(data[p], data[p + 1], data[p + 2]);
  }
  const n = px.length / 3;
  if (n === 0) return [];
  k = Math.min(k, n);
  const rand = mulberry32(1234); // graine fixe → résultat stable

  // init k-means++
  const cent = new Float64Array(k * 3);
  let first = Math.floor(rand() * n);
  cent.set([px[first * 3], px[first * 3 + 1], px[first * 3 + 2]], 0);
  const dist = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dr = px[i * 3] - cent[(c - 1) * 3], dg = px[i * 3 + 1] - cent[(c - 1) * 3 + 1], db = px[i * 3 + 2] - cent[(c - 1) * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < dist[i]) dist[i] = d;
      sum += dist[i];
    }
    let target = rand() * sum, pick = n - 1;
    for (let i = 0; i < n; i++) { target -= dist[i]; if (target <= 0) { pick = i; break; } }
    cent.set([px[pick * 3], px[pick * 3 + 1], px[pick * 3 + 2]], c * 3);
  }

  const assign = new Int32Array(n);
  const counts = new Int32Array(k);
  for (let it = 0; it < KMEANS_ITERS; it++) {
    const sums = new Float64Array(k * 3);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - cent[c * 3], dg = g - cent[c * 3 + 1], db = b - cent[c * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
      counts[best]++;
      sums[best * 3] += r; sums[best * 3 + 1] += g; sums[best * 3 + 2] += b;
    }
    let moved = 0;
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {            // cluster vide → réinitialise sur un pixel
        const i = Math.floor(rand() * n);
        cent.set([px[i * 3], px[i * 3 + 1], px[i * 3 + 2]], c * 3);
        moved++;
        continue;
      }
      for (let j = 0; j < 3; j++) {
        const v = sums[c * 3 + j] / counts[c];
        if (Math.abs(v - cent[c * 3 + j]) > 0.5) moved++;
        cent[c * 3 + j] = v;
      }
    }
    if (moved === 0) break;
  }
  return Array.from({ length: k }, (_, c) => ({
    rgb: [Math.round(cent[c * 3]), Math.round(cent[c * 3 + 1]), Math.round(cent[c * 3 + 2])],
    pct: (counts[c] / n) * 100,
  }))
    .filter((c) => c.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

const CSS = `
.cex{display:flex;flex-direction:column;gap:1rem;font-family:var(--font-family,inherit);color:var(--color-text,#1f2937)}
.cex-drop{border:2px dashed var(--color-border,#cbd5e1);border-radius:var(--radius-lg,16px);padding:3rem 1rem;text-align:center;cursor:pointer;background:var(--color-surface,#f8fafc);transition:border-color .2s,background .2s}
.cex-drop:hover,.cex-drop.over{border-color:var(--color-primary,#4f46e5);background:var(--color-primary-soft,#eef2ff)}
.cex-drop strong{display:block;font-size:1.1rem;margin-bottom:.25rem}
.cex-info{font-size:.85rem;color:var(--color-muted,#64748b)}
.cex-main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem}
.cex-box{border:1px solid var(--color-border,#e2e8f0);border-radius:var(--radius-md,12px);padding:.75rem;background:var(--color-surface,#fff);display:flex;flex-direction:column;gap:.6rem}
.cex-box h4{margin:0;font-size:.8rem;color:var(--color-muted,#64748b);text-transform:uppercase;letter-spacing:.04em}
.cex-canvas{display:block;max-width:100%;height:auto;border-radius:8px;cursor:crosshair;touch-action:none;background:#fff}
.cex-btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.6rem 1.1rem;border:0;border-radius:var(--radius-md,12px);background:var(--color-primary,#4f46e5);color:#fff;font-weight:700;cursor:pointer}
.cex-btn.alt{background:var(--color-surface,#f1f5f9);color:var(--color-text,#1f2937);border:1px solid var(--color-border,#cbd5e1)}
.cex-btn.sm{padding:.3rem .65rem;font-size:.78rem}
.cex-btn:disabled{opacity:.45;cursor:not-allowed}
.cex-btn svg{width:15px;height:15px}
.cex-big{height:120px;border-radius:12px;border:1px solid var(--color-border,#e2e8f0);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.3rem;font-family:ui-monospace,monospace;background:#e5e7eb}
.cex-fmt{display:flex;align-items:center;gap:.5rem}
.cex-fmt span{flex:1;font-family:ui-monospace,monospace;font-size:.9rem;overflow:hidden;text-overflow:ellipsis}
.cex-fmt b{width:3.2rem;font-size:.75rem;color:var(--color-muted,#64748b)}
.cex-shades{display:flex;border-radius:8px;overflow:hidden;height:36px}
.cex-shades i{flex:1;cursor:pointer}
.cex-ctrl{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;font-size:.9rem}
.cex-ctrl select{padding:.4rem;border-radius:var(--radius-sm,8px);border:1px solid var(--color-border,#cbd5e1)}
.cex-pal{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:.75rem}
.cex-card{border:1px solid var(--color-border,#e2e8f0);border-radius:var(--radius-md,12px);overflow:hidden;background:var(--color-surface,#fff);display:flex;flex-direction:column}
.cex-card .sw{height:70px;cursor:pointer;display:flex;align-items:flex-end;padding:.3rem .5rem;font-size:.75rem;font-weight:700}
.cex-card .bd{padding:.4rem .5rem;display:flex;align-items:center;justify-content:space-between;gap:.3rem;font-family:ui-monospace,monospace;font-size:.8rem}
.cex [hidden]{display:none!important}
`;

export function mount(container, ctx) {
  unmount();

  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  container.innerHTML = `
    <div class="cex">
      <div class="cex-drop" tabindex="0">
        <strong>Déposez une image ici ou cliquez pour parcourir</strong>
        <span class="cex-info">PNG, JPG, WEBP — traitement 100 % local</span>
        <input type="file" accept="image/*" hidden>
      </div>
      <div class="cex-main" hidden>
        <div class="cex-box">
          <h4>Pipette</h4>
          <canvas class="cex-canvas"></canvas>
          <button class="cex-btn" data-eye><i data-lucide="pipette"></i><span>Activer la pipette</span></button>
          <span class="cex-info" data-eyeinfo></span>
        </div>
        <div class="cex-box">
          <h4>Couleur <span data-state></span></h4>
          <div class="cex-big" data-big>—</div>
          <div class="cex-fmt"><b>HEX</b><span data-f="hex">—</span><button class="cex-btn alt sm" data-copy="hex" disabled><i data-lucide="copy"></i></button></div>
          <div class="cex-fmt"><b>RGB</b><span data-f="rgb">—</span><button class="cex-btn alt sm" data-copy="rgb" disabled><i data-lucide="copy"></i></button></div>
          <div class="cex-fmt"><b>HSL</b><span data-f="hsl">—</span><button class="cex-btn alt sm" data-copy="hsl" disabled><i data-lucide="copy"></i></button></div>
          <div class="cex-fmt"><b>CMJN</b><span data-f="cmjn">—</span><button class="cex-btn alt sm" data-copy="cmjn" disabled><i data-lucide="copy"></i></button></div>
          <h4>Nuancier</h4>
          <div class="cex-shades" data-shades></div>
        </div>
      </div>
      <div class="cex-box" data-palbox hidden>
        <h4>Palette dominante</h4>
        <div class="cex-ctrl">
          <label>Couleurs : <b data-nv>6</b>
            <input type="range" data-n min="5" max="10" step="1" value="6">
          </label>
          <label>Export :
            <select data-fmt>
              <option value="json">JSON</option>
              <option value="css">Variables CSS</option>
            </select>
          </label>
          <button class="cex-btn" data-export disabled><i data-lucide="download"></i>Exporter la palette</button>
        </div>
        <div class="cex-pal" data-pal></div>
      </div>
      <div class="cex-info" data-status></div>
    </div>`;

  const $ = (sel) => container.querySelector(sel);
  const s = state = {
    container,
    drop: $('.cex-drop'),
    input: $('input[type=file]'),
    main: $('.cex-main'),
    palbox: $('[data-palbox]'),
    canvas: $('.cex-canvas'),
    big: $('[data-big]'),
    shades: $('[data-shades]'),
    pal: $('[data-pal]'),
    status: $('[data-status]'),
    stateLbl: $('[data-state]'),
    eyeInfo: $('[data-eyeinfo]'),
    imgUrl: null,
    dlUrl: null,
    imageData: null,
    selected: null,   // couleur verrouillée [r,g,b]
    hover: null,      // couleur survolée
    palette: [],
    baseName: 'palette',
    pickMode: false,
    timer: null,
    copyTimers: new Set(),
    listeners: [],
  };
  const refreshIcons = () => window.lucide?.createIcons();
  const on = (el, ev, fn) => { el.addEventListener(ev, fn); s.listeners.push([el, ev, fn]); };
  const setStatus = (m = '') => { s.status.textContent = m; };
  const hasEye = 'EyeDropper' in window;
  s.eyeInfo.textContent = hasEye
    ? 'Pipette native : prélève n\'importe quelle couleur à l\'écran. Survol/clic sur l\'image toujours actif.'
    : 'EyeDropper indisponible : survolez l\'image et cliquez pour prélever une couleur.';
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

  /* Pixel sous le curseur (coordonnées client → canvas) */
  function pixelAt(e) {
    if (!s.imageData) return null;
    const r = s.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) * s.canvas.width) / r.width);
    const y = Math.floor(((e.clientY - r.top) * s.canvas.height) / r.height);
    if (x < 0 || y < 0 || x >= s.canvas.width || y >= s.canvas.height) return null;
    const p = (y * s.canvas.width + x) * 4;
    const d = s.imageData.data;
    return [d[p], d[p + 1], d[p + 2]];
  }
  on(s.canvas, 'pointermove', (e) => { s.hover = pixelAt(e); showColor(); });
  on(s.canvas, 'pointerleave', () => { s.hover = null; showColor(); });
  on(s.canvas, 'click', (e) => {
    const c = pixelAt(e);
    if (c) { s.selected = c; showColor(); }
  });

  /* Pipette */
  on($('[data-eye]'), 'click', async () => {
    if (hasEye) {
      try {
        const res = await new window.EyeDropper().open();
        const c = parseHex(res.sRGBHex);
        if (c && state === s) { s.selected = c; showColor(); }
      } catch { /* annulé par l'utilisateur */ }
    } else {
      s.pickMode = !s.pickMode;
      $('[data-eye] span').textContent = s.pickMode ? 'Pipette active (cliquez sur l\'image)' : 'Activer la pipette';
      s.canvas.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  /* Délégation : copie, sélection depuis palette/nuancier */
  on(container, 'click', async (e) => {
    const copy = e.target.closest('[data-copyval]');
    if (copy) { await copyText(copy.dataset.copyval, copy); return; }
    const fmtBtn = e.target.closest('[data-copy]');
    if (fmtBtn) {
      const c = s.hover ?? s.selected;
      if (c) await copyText(formats(c)[fmtBtn.dataset.copy], fmtBtn);
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const c = parseHex(pick.dataset.pick);
      if (c) { s.selected = c; s.hover = null; showColor(); }
    }
  });

  async function copyText(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { /* ignoré */ }
      ta.remove();
    }
    setStatus(ok ? `Copié : ${text}` : 'Copie impossible.');
    if (btn) {
      const old = btn.title;
      btn.title = ok ? 'Copié !' : 'Échec';
      const t = setTimeout(() => { btn.title = old; s.copyTimers.delete(t); }, 1200);
      s.copyTimers.add(t);
    }
  }

  /* Affichage couleur courante (survol prioritaire sur sélection) */
  function showColor() {
    const c = s.hover ?? s.selected;
    s.stateLbl.textContent = s.hover ? '(survol)' : s.selected ? '(sélection)' : '';
    const keys = ['hex', 'rgb', 'hsl', 'cmjn'];
    if (!c) {
      s.big.style.background = '';
      s.big.style.color = '';
      s.big.textContent = '—';
      keys.forEach((k) => { $(`[data-f="${k}"]`).textContent = '—'; });
      container.querySelectorAll('[data-copy]').forEach((b) => { b.disabled = true; });
      s.shades.innerHTML = '';
      return;
    }
    const f = formats(c);
    s.big.style.background = f.hex;
    s.big.style.color = textOn(c);
    s.big.textContent = f.hex;
    keys.forEach((k) => { $(`[data-f="${k}"]`).textContent = f[k]; });
    container.querySelectorAll('[data-copy]').forEach((b) => { b.disabled = false; });
    // nuancier : 9 variations de luminosité
    const [h, sat] = rgbToHsl(c);
    s.shades.innerHTML = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((l) => {
      const hx = toHex(hslToRgb([h, sat, l]));
      return `<i data-pick="${hx}" style="background:${hx}" title="${hx}"></i>`;
    }).join('');
  }

  /* Chargement image → canvas + palette */
  function loadFile(file) {
    if (!file.type.startsWith('image/')) { setStatus('Fichier non supporté.'); return; }
    s.baseName = file.name.replace(/\.[^.]+$/, '') || 'palette';
    if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
    s.imgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (state !== s) return;
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      s.canvas.width = w; s.canvas.height = h;
      const c2d = s.canvas.getContext('2d', { willReadFrequently: true });
      c2d.clearRect(0, 0, w, h);
      c2d.drawImage(img, 0, 0, w, h);
      s.imageData = c2d.getImageData(0, 0, w, h);
      s.selected = s.hover = null;
      s.main.hidden = s.palbox.hidden = false;
      setStatus(`${file.name} — ${img.naturalWidth}×${img.naturalHeight}px`);
      showColor();
      buildPalette();
      refreshIcons();
    };
    img.onerror = () => setStatus("Impossible de lire l'image.");
    img.src = s.imgUrl;
  }

  /* Palette */
  const nInput = $('[data-n]');
  on(nInput, 'input', () => {
    $('[data-nv]').textContent = nInput.value;
    clearTimeout(s.timer);
    s.timer = setTimeout(buildPalette, 150);
  });

  function buildPalette() {
    if (!s.imageData || state !== s) return;
    s.palette = extractPalette(s.imageData, +nInput.value);
    $('[data-export]').disabled = s.palette.length === 0;
    s.pal.innerHTML = s.palette.map((p) => {
      const hx = toHex(p.rgb);
      return `<div class="cex-card">
        <div class="sw" data-pick="${hx}" style="background:${hx};color:${textOn(p.rgb)}">${p.pct.toFixed(1)} %</div>
        <div class="bd"><span>${hx}</span>
          <button class="cex-btn alt sm" data-copyval="${hx}" title="Copier"><i data-lucide="copy"></i></button></div>
      </div>`;
    }).join('');
    refreshIcons();
  }

  /* Export palette */
  on($('[data-export]'), 'click', () => {
    if (!s.palette.length) return;
    const fmt = $('[data-fmt]').value;
    let content, mime, ext;
    if (fmt === 'css') {
      content = ':root {\n' + s.palette.map((p, i) => `  --color-${i + 1}: ${toHex(p.rgb).toLowerCase()};`).join('\n') + '\n}\n';
      mime = 'text/css'; ext = 'css';
    } else {
      content = JSON.stringify({
        source: s.baseName,
        colors: s.palette.map((p) => ({ ...formats(p.rgb), percent: +p.pct.toFixed(2) })),
      }, null, 2);
      mime = 'application/json'; ext = 'json';
    }
    if (s.dlUrl) URL.revokeObjectURL(s.dlUrl);
    s.dlUrl = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = s.dlUrl;
    a.download = `${s.baseName}-palette.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { if (s.dlUrl) { URL.revokeObjectURL(s.dlUrl); s.dlUrl = null; } }, 1000);
    setStatus(`Palette exportée (${ext.toUpperCase()}).`);
  });
}

export function unmount() {
  if (!state) return;
  clearTimeout(state.timer);
  state.copyTimers.forEach(clearTimeout);
  state.listeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
  if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
  if (state.dlUrl) URL.revokeObjectURL(state.dlUrl);
  state.canvas.width = state.canvas.height = 0;
  state.imageData = null;
  state.container.innerHTML = '';
  const st = document.getElementById(STYLE_ID);
  if (st) st.remove();
  state = null;
}
