/**
 * qr-generator.js — Générateur de QR codes 100 % client (aucune dépendance).
 *
 * Contrat : export mount(container, ctx) / export unmount().
 * Moteur : encodage QR (mode octets UTF-8, versions 1-40, correction L/M/Q/H,
 * Reed-Solomon GF(256), 8 masques + pénalités), rendu Canvas et SVG.
 */

/* ==========================================================================
   MOTEUR QR
   ========================================================================== */

const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT_BITS = [1, 0, 3, 2]; // L, M, Q, H

// Index = version (1..40). Ordre : L, M, Q, H.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function appendBits(bb, val, len) {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

function numRawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

const numDataCodewords = (ver, e) =>
  Math.floor(numRawModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];

/* --- Reed-Solomon sur GF(256 / 0x11D) --- */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const res = new Array(degree).fill(0);
  res[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      res[j] = gfMul(res[j], root);
      if (j + 1 < degree) res[j] ^= res[j + 1];
    }
    root = gfMul(root, 2);
  }
  return res;
}

function rsRemainder(data, divisor) {
  const res = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    divisor.forEach((c, i) => { res[i] ^= gfMul(c, factor); });
  }
  return res;
}

function addEccAndInterleave(data, ver, e) {
  const nBlocks = NUM_BLOCKS[e][ver];
  const eccLen = ECC_PER_BLOCK[e][ver];
  const rawCw = Math.floor(numRawModules(ver) / 8);
  const nShort = nBlocks - (rawCw % nBlocks);
  const shortLen = Math.floor(rawCw / nBlocks);
  const blocks = [];
  const div = rsDivisor(eccLen);
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => {
      if (i !== shortLen - eccLen || j >= nShort) out.push(blk[i]);
    });
  }
  return out;
}

/* --- Matrice --- */
function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const res = [6];
  for (let pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
  return res;
}

function penalty(m, size) {
  let r = 0;
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let dir = 0; dir < 2; dir++) {
    const get = dir ? (a, b) => m[b][a] : (a, b) => m[a][b];
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) r += run - 2; run = 1; }
      }
      if (run >= 5) r += run - 2;
      for (let b = 0; b <= size - 11; b++) {
        let okA = true, okB = true;
        for (let k = 0; k < 11 && (okA || okB); k++) {
          const v = get(a, b + k) ? 1 : 0;
          if (v !== A[k]) okA = false;
          if (v !== B[k]) okB = false;
        }
        if (okA || okB) r += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) r += 3;
    }
  }
  const total = size * size;
  r += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return r;
}

/**
 * Encode `text` (UTF-8, mode octets).
 * @returns {{size:number, modules:boolean[][], version:number}}
 */
export function encodeQr(text, eclName = 'M') {
  const e = ECL_INDEX[eclName] ?? 1;
  const bytes = Array.from(new TextEncoder().encode(text));

  // Choix de la plus petite version
  let ver = 0;
  for (let v = 1; v <= 40; v++) {
    const used = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bytes.length < (v < 10 ? 256 : 65536) && used <= numDataCodewords(v, e) * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('Contenu trop long pour un QR code. Réduisez le texte ou le niveau de correction.');

  // Flux de bits + remplissage
  const bb = [];
  appendBits(bb, 0x4, 4);
  appendBits(bb, bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => appendBits(bb, b, 8));
  const cap = numDataCodewords(ver, e) * 8;
  appendBits(bb, 0, Math.min(4, cap - bb.length));
  appendBits(bb, 0, (8 - (bb.length % 8)) % 8);
  for (let pad = 0xec; bb.length < cap; pad ^= 0xec ^ 0x11) appendBits(bb, pad, 8);
  const data = new Array(bb.length / 8).fill(0);
  bb.forEach((bit, i) => { data[i >>> 3] |= bit << (7 - (i & 7)); });

  const all = addEccAndInterleave(data, ver, e);

  // Matrice
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = alignPositions(ver);
  const na = ap.length;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  const drawFormat = (mask) => {
    const d = (ECL_FORMAT_BITS[e] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
    setFn(8, 7, getBit(bits, 6));
    setFn(8, 8, getBit(bits, 7));
    setFn(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);

  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, getBit(bits, i));
      setFn(b, a, getBit(bits, i));
    }
  }

  // Placement des données en zigzag
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < all.length * 8) {
          m[y][x] = getBit(all[bi >>> 3], 7 - (bi & 7));
          bi++;
        }
      }
    }
  }

  // Masques
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let inv;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!fn[y][x] && inv) m[y][x] = !m[y][x];
      }
    }
  };
  let best = 0, bestPen = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(m, size);
    if (p < bestPen) { bestPen = p; best = mask; }
    applyMask(mask); // annule
  }
  applyMask(best);
  drawFormat(best);

  return { size, modules: m, version: ver };
}

/* ==========================================================================
   RENDU
   ========================================================================== */

const QUIET = 4; // zone de silence (modules)

function drawCanvas(canvas, qr, px, fg, bg) {
  canvas.width = px;
  canvas.height = px;
  const c = canvas.getContext('2d');
  const total = qr.size + QUIET * 2;
  const cell = px / total;
  c.fillStyle = bg;
  c.fillRect(0, 0, px, px);
  c.fillStyle = fg;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      const x0 = Math.round((x + QUIET) * cell), x1 = Math.round((x + QUIET + 1) * cell);
      const y0 = Math.round((y + QUIET) * cell), y1 = Math.round((y + QUIET + 1) * cell);
      c.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

function buildSvg(qr, px, fg, bg) {
  const total = qr.size + QUIET * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) { x++; continue; }
      let len = 0;
      while (x + len < qr.size && qr.modules[y][x + len]) len++;
      d += `M${x + QUIET} ${y + QUIET}h${len}v1h-${len}z`;
      x += len;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
}

/* ==========================================================================
   UI
   ========================================================================== */

const STYLE_ID = 'qrg-style';
const REVOKE_DELAY_MS = 2000;

const CSS = `
.qrg { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--space-8); align-items: start; }
@media (max-width: 800px) { .qrg { grid-template-columns: 1fr; } }
.qrg__form, .qrg__preview { display: flex; flex-direction: column; gap: var(--space-4); }
.qrg__tabs { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.qrg__tab { padding: var(--space-2) var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-surface); color: var(--color-text-muted); font-weight: var(--font-weight-medium); transition: background var(--transition), color var(--transition); }
.qrg__tab:hover { color: var(--cat-utility); border-color: var(--cat-utility); }
.qrg__tab.is-active { background: var(--cat-utility); border-color: var(--cat-utility); color: var(--color-text-on-primary); }
.qrg__pane { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.qrg__pane--single { grid-template-columns: 1fr; }
.qrg__field { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); color: var(--color-text-muted); }
.qrg__field--full { grid-column: 1 / -1; }
.qrg__field--inline { flex-direction: row; align-items: center; gap: var(--space-2); }
.qrg input[type="text"], .qrg input[type="password"], .qrg input[type="email"], .qrg input[type="tel"], .qrg input[type="url"], .qrg textarea, .qrg select {
  width: 100%; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: var(--color-surface-alt); color: var(--color-text); font: inherit; font-weight: var(--font-weight-regular);
}
.qrg textarea { resize: vertical; min-height: 110px; }
.qrg input:focus-visible, .qrg textarea:focus-visible, .qrg select:focus-visible { outline: 2px solid var(--cat-utility); outline-offset: 1px; }
.qrg input[type="color"] { width: 100%; height: 40px; padding: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-alt); cursor: pointer; }
.qrg input[type="range"] { width: 100%; accent-color: var(--cat-utility); }
.qrg__opts { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.qrg__opts .qrg__field--full { grid-column: 1 / -1; }
.qrg__stage { display: grid; place-items: center; min-height: 280px; padding: var(--space-4); border: 1px dashed var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-alt); }
.qrg__canvas { display: block; width: 100%; max-width: 360px; height: auto; aspect-ratio: 1; border-radius: var(--radius-sm); box-shadow: var(--shadow-md); image-rendering: pixelated; }
.qrg__empty { margin: 0; color: var(--color-text-muted); text-align: center; font-size: var(--font-size-sm); }
.qrg__meta { margin: 0; text-align: center; color: var(--color-text-muted); font-size: var(--font-size-sm); min-height: 1.5em; }
.qrg__meta.is-error { color: var(--color-error); }
.qrg__meta.is-ok { color: var(--color-success); }
.qrg__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.qrg__actions .btn { flex: 1 1 140px; }
.qrg__btn-alt { background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-border); }
.qrg__btn-alt:hover { background: var(--color-primary-soft); color: var(--color-primary); }
`;

const TEMPLATE = `
<div class="qrg">
  <div class="qrg__form">
    <div class="qrg__tabs" role="tablist">
      <button type="button" class="qrg__tab is-active" data-mode="text" role="tab">Texte / URL</button>
      <button type="button" class="qrg__tab" data-mode="wifi" role="tab">Wi-Fi</button>
      <button type="button" class="qrg__tab" data-mode="vcard" role="tab">vCard</button>
    </div>

    <div class="qrg__pane qrg__pane--single" data-pane="text">
      <label class="qrg__field">Texte ou URL
        <textarea id="qrg-text" placeholder="https://exemple.com"></textarea>
      </label>
    </div>

    <div class="qrg__pane" data-pane="wifi" hidden>
      <label class="qrg__field qrg__field--full">Nom du réseau (SSID)
        <input type="text" id="qrg-ssid" autocomplete="off">
      </label>
      <label class="qrg__field">Mot de passe
        <input type="text" id="qrg-wpass" autocomplete="off">
      </label>
      <label class="qrg__field">Sécurité
        <select id="qrg-wenc">
          <option value="WPA">WPA/WPA2/WPA3</option>
          <option value="WEP">WEP</option>
          <option value="nopass">Aucune</option>
        </select>
      </label>
      <label class="qrg__field qrg__field--inline qrg__field--full">
        <input type="checkbox" id="qrg-whidden"> Réseau masqué
      </label>
    </div>

    <div class="qrg__pane" data-pane="vcard" hidden>
      <label class="qrg__field">Prénom<input type="text" id="qrg-vfirst" autocomplete="off"></label>
      <label class="qrg__field">Nom<input type="text" id="qrg-vlast" autocomplete="off"></label>
      <label class="qrg__field qrg__field--full">Organisation<input type="text" id="qrg-vorg" autocomplete="off"></label>
      <label class="qrg__field">Téléphone<input type="tel" id="qrg-vtel" autocomplete="off"></label>
      <label class="qrg__field">E-mail<input type="email" id="qrg-vmail" autocomplete="off"></label>
      <label class="qrg__field qrg__field--full">Site web<input type="url" id="qrg-vurl" autocomplete="off"></label>
    </div>

    <div class="qrg__opts">
      <label class="qrg__field">Couleur du premier plan
        <input type="color" id="qrg-fg" value="#000000">
      </label>
      <label class="qrg__field">Couleur d'arrière-plan
        <input type="color" id="qrg-bg" value="#ffffff">
      </label>
      <label class="qrg__field qrg__field--full">Taille : <output id="qrg-size-out">512 px</output>
        <input type="range" id="qrg-size" min="128" max="1024" step="32" value="512">
      </label>
      <label class="qrg__field qrg__field--full">Correction d'erreur
        <select id="qrg-ecl">
          <option value="L">L — 7 %</option>
          <option value="M" selected>M — 15 %</option>
          <option value="Q">Q — 25 %</option>
          <option value="H">H — 30 %</option>
        </select>
      </label>
    </div>
  </div>

  <div class="qrg__preview">
    <div class="qrg__stage">
      <canvas id="qrg-canvas" class="qrg__canvas" hidden></canvas>
      <p id="qrg-empty" class="qrg__empty">Saisissez du contenu pour générer le QR code.</p>
    </div>
    <p id="qrg-status" class="qrg__meta" role="status" aria-live="polite"></p>
    <div class="qrg__actions">
      <button type="button" class="btn" id="qrg-png" disabled><i data-lucide="download"></i> Télécharger PNG</button>
      <button type="button" class="btn" id="qrg-svg" disabled><i data-lucide="download"></i> Télécharger SVG</button>
      <button type="button" class="btn qrg__btn-alt" id="qrg-copy" disabled><i data-lucide="copy"></i> Copier l'image</button>
    </div>
  </div>
</div>
`;

let s = null;

const q = (id) => s?.root.querySelector('#qrg-' + id);
const refreshIcons = () => window.lucide?.createIcons();

function setStatus(msg = '', kind = '') {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'qrg__meta' + (kind ? ' is-' + kind : '');
}

const escWifi = (v) => v.replace(/([\\;,:"])/g, '\\$1');
const escVcard = (v) => v.replace(/([\\,;])/g, '\\$1').replace(/\r?\n/g, '\\n');

/** Construit la chaîne à encoder selon l'onglet actif ('' si vide). */
function getPayload() {
  const val = (id) => (q(id)?.value ?? '').trim();
  switch (s.mode) {
    case 'wifi': {
      const ssid = val('ssid');
      if (!ssid) return '';
      const enc = q('wenc').value;
      let out = `WIFI:T:${enc};S:${escWifi(ssid)};`;
      if (enc !== 'nopass') out += `P:${escWifi(q('wpass').value)};`;
      if (q('whidden').checked) out += 'H:true;';
      return out + ';';
    }
    case 'vcard': {
      const first = val('vfirst'), last = val('vlast'), org = val('vorg');
      const tel = val('vtel'), mail = val('vmail'), url = val('vurl');
      if (!first && !last && !org && !tel && !mail && !url) return '';
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${escVcard(last)};${escVcard(first)};;;`, `FN:${escVcard([first, last].filter(Boolean).join(' ') || org)}`];
      if (org) lines.push(`ORG:${escVcard(org)}`);
      if (tel) lines.push(`TEL:${escVcard(tel)}`);
      if (mail) lines.push(`EMAIL:${escVcard(mail)}`);
      if (url) lines.push(`URL:${escVcard(url)}`);
      lines.push('END:VCARD');
      return lines.join('\n');
    }
    default:
      return q('text').value.trim() ? q('text').value : '';
  }
}

function setButtons(enabled) {
  ['png', 'svg', 'copy'].forEach((id) => { const b = q(id); if (b) b.disabled = !enabled; });
}

function render() {
  if (!s) return;
  const canvas = q('canvas');
  const payload = getPayload();
  const px = Number(q('size').value);
  q('size-out').textContent = px + ' px';
  s.qr = null;

  if (!payload) {
    canvas.hidden = true;
    q('empty').hidden = false;
    setButtons(false);
    setStatus('');
    return;
  }
  try {
    s.qr = encodeQr(payload, q('ecl').value);
    drawCanvas(canvas, s.qr, px, q('fg').value, q('bg').value);
    canvas.hidden = false;
    q('empty').hidden = true;
    setButtons(true);
    setStatus(`Version ${s.qr.version} · ${s.qr.size}×${s.qr.size} modules · ${px}×${px} px`);
  } catch (err) {
    canvas.hidden = true;
    q('empty').hidden = false;
    setButtons(false);
    setStatus(err.message || 'Génération impossible.', 'error');
  }
}

const scheduleRender = () => {
  clearTimeout(s.timer);
  s.timer = setTimeout(render, 120);
};

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  s.urls.add(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); s?.urls.delete(url); }, REVOKE_DELAY_MS);
}

const canvasBlob = () => new Promise((res, rej) => q('canvas').toBlob((b) => (b ? res(b) : rej(new Error('Export PNG impossible.'))), 'image/png'));

async function onPng() {
  if (!s.qr) return;
  try { download(await canvasBlob(), 'qrcode.png'); setStatus('PNG téléchargé.', 'ok'); }
  catch (err) { setStatus(err.message, 'error'); }
}

function onSvg() {
  if (!s.qr) return;
  const svg = buildSvg(s.qr, Number(q('size').value), q('fg').value, q('bg').value);
  download(new Blob([svg], { type: 'image/svg+xml' }), 'qrcode.svg');
  setStatus('SVG téléchargé.', 'ok');
}

async function onCopy() {
  if (!s.qr) return;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Copie d\'image non supportée par ce navigateur.');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob() })]);
    setStatus('Image copiée dans le presse-papiers.', 'ok');
  } catch (err) {
    setStatus(err.message || 'Copie impossible (autorisation refusée ?).', 'error');
  }
}

function setMode(mode) {
  s.mode = mode;
  s.root.querySelectorAll('.qrg__tab').forEach((t) => {
    const on = t.dataset.mode === mode;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  s.root.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== mode; });
  render();
}

export function mount(container, ctx) {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  container.innerHTML = TEMPLATE;
  s = { root: container, ctx, mode: 'text', qr: null, timer: null, urls: new Set() };

  s.onInput = () => scheduleRender();
  s.onClick = (e) => {
    const tab = e.target.closest('.qrg__tab');
    if (tab) return setMode(tab.dataset.mode);
    const btn = e.target.closest('button[id]');
    if (!btn) return;
    if (btn.id === 'qrg-png') onPng();
    else if (btn.id === 'qrg-svg') onSvg();
    else if (btn.id === 'qrg-copy') onCopy();
  };
  container.addEventListener('input', s.onInput);
  container.addEventListener('change', s.onInput);
  container.addEventListener('click', s.onClick);

  refreshIcons();
  render();
}

export function unmount() {
  if (!s) return;
  clearTimeout(s.timer);
  s.root.removeEventListener('input', s.onInput);
  s.root.removeEventListener('change', s.onInput);
  s.root.removeEventListener('click', s.onClick);
  s.urls.forEach((u) => URL.revokeObjectURL(u));
  s.root.innerHTML = '';
  s = null;
}
