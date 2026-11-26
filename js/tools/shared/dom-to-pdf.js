/**
 * dom-to-pdf.js — Rendu de pages HTML déjà mises en page vers PDF (100 % client).
 * Brique commune des convertisseurs « X vers PDF » : rendre le document en pages HTML
 * (une page = un élément dimensionné : largeur + min-height), puis appeler renderPagesToPdf().
 *
 * Deux modes :
 *  - 'vector' : PDF modifiable. Texte réel (sélectionnable, copiable, éditable dans un éditeur PDF),
 *               placé d'après la mise en page du navigateur ; fonds, bordures et images redessinés.
 *               Polices Unicode embarquées (Carlito ≈ Calibri, Tinos ≈ Times, Cousine ≈ Courier).
 *  - 'image'  : capture html2canvas de chaque page (fidélité visuelle maximale, texte non sélectionnable).
 */

/* ---------- Chargement de bibliothèques (script classique, fallback de sources) ---------- */

const scriptCache = new Map();

/** Charge une lib UMD ({ key, global, sources }) une seule fois par session. */
export function loadScriptLib({ key, global, sources }) {
  if (global()) return Promise.resolve(global());
  if (scriptCache.has(key)) return scriptCache.get(key);
  const p = (async () => {
    for (const src of sources) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = resolve;
          s.onerror = () => { s.remove(); reject(new Error('load')); };
          document.head.appendChild(s);
        });
        if (global()) return global();
      } catch (_) { /* source suivante */ }
    }
    scriptCache.delete(key);
    throw new Error(`Impossible de charger ${key} (réseau).`);
  })();
  scriptCache.set(key, p);
  return p;
}

export const JSPDF_LIB = {
  key: 'jspdf',
  global: () => window.jspdf?.jsPDF,
  sources: [
    'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
    'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js',
  ],
};
export const HTML2CANVAS_LIB = {
  key: 'html2canvas',
  global: () => window.html2canvas,
  sources: [
    'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
    'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
  ],
};

/* ---------- Polices Unicode (TTF Google Fonts, chargées à la demande) ---------- */

const FONT_BASES = [
  'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/',
  'https://raw.githubusercontent.com/google/fonts/main/ofl/',
];
/** Classe de police → famille TTF embarquée + police standard PDF de repli. */
const FONT_CLASSES = {
  sans: { family: 'Carlito', path: 'carlito/Carlito', fallback: 'helvetica' },
  serif: { family: 'Tinos', path: 'tinos/Tinos', fallback: 'times' },
  mono: { family: 'Cousine', path: 'cousine/Cousine', fallback: 'courier' },
};
const STYLE_SUFFIX = { normal: 'Regular', bold: 'Bold', italic: 'Italic', bolditalic: 'BoldItalic' };
/** `${classe}-${style}` → Promise<base64 | null> (cache session). */
const fontCache = new Map();

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fetchFont(cls, style) {
  const key = `${cls}-${style}`;
  if (!fontCache.has(key)) {
    fontCache.set(key, (async () => {
      for (const base of FONT_BASES) {
        try {
          const res = await fetch(`${base}${FONT_CLASSES[cls].path}-${STYLE_SUFFIX[style]}.ttf`);
          if (res.ok) return bufferToBase64(await res.arrayBuffer());
        } catch (_) { /* source suivante */ }
      }
      fontCache.delete(key);
      return null;
    })());
  }
  return fontCache.get(key);
}

/** Enregistre les polices utilisées dans le document jsPDF ; retourne `${classe}-${style}` → { name, style, unicode }. */
async function registerFonts(pdf, used) {
  const map = new Map();
  await Promise.all([...used].map(async (key) => {
    const [cls, style] = key.split('-');
    const b64 = await fetchFont(cls, style);
    const def = FONT_CLASSES[cls];
    if (b64) {
      const file = `${def.family}-${STYLE_SUFFIX[style]}.ttf`;
      pdf.addFileToVFS(file, b64);
      pdf.addFont(file, def.family, style);
      map.set(key, { name: def.family, style, unicode: true });
    } else {
      map.set(key, { name: def.fallback, style, unicode: false });
    }
  }));
  return map;
}

const fontClass = (family) => {
  const first = family.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  if (/mono|courier|consolas|menlo|lucida console/.test(first)) return 'mono';
  if (first === 'serif' || /times|cambria|georgia|garamond|antiqua|palatino|constantia|baskerville|didot|bodoni|caladea|tinos/.test(first)) return 'serif';
  return 'sans';
};
const fontStyle = (cs) => {
  const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
  const italic = /italic|oblique/.test(cs.fontStyle);
  return bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal';
};

/** Repli polices standard PDF (WinAnsi) : remplace les caractères non encodables. */
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const toWinAnsi = (s) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, (c) => (WINANSI_EXTRA.includes(c) ? c : '?'));
/** Puces Word des polices Symbol/Wingdings (zone privée Unicode) → puce standard. */
const mapPrivateUse = (s) => s.replace(/[-]/g, '•');

/* ---------- Matérialisation des pseudo-éléments (::before / ::after) ---------- */

const NO_PSEUDO = 'd2p-nopseudo';

const parseCounterOps = (value, def) => {
  if (!value || value === 'none') return [];
  const out = [];
  const tokens = value.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const n = Number(tokens[i + 1]);
    if (Number.isFinite(n) && tokens[i + 1] !== undefined) { out.push([tokens[i], n]); i++; } else out.push([tokens[i], def]);
  }
  return out;
};

const toAlpha = (n, upper) => {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return upper ? s.toUpperCase() : s;
};
const toRoman = (n, upper) => {
  if (n <= 0 || n >= 4000) return String(n);
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return upper ? s.toUpperCase() : s;
};
const formatCounter = (n, style = 'decimal') => {
  switch (style) {
    case 'none': return '';
    case 'disc': return '•';
    case 'circle': return '◦';
    case 'square': return '▪';
    case 'lower-alpha': case 'lower-latin': return toAlpha(n, false);
    case 'upper-alpha': case 'upper-latin': return toAlpha(n, true);
    case 'lower-roman': return toRoman(n, false);
    case 'upper-roman': return toRoman(n, true);
    case 'decimal-leading-zero': return String(n).padStart(2, '0');
    default: return String(n);
  }
};
const unescapeCss = (s) => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));

/** Évalue une valeur CSS `content` (chaînes + counter()/counters()). */
function evalContent(content, counters) {
  const re = /"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|counters?\(\s*([^,)\s]+)\s*(?:,\s*("(?:[^"\\]|\\[\s\S])*"|[^,)\s]+))?\s*(?:,\s*([^)\s]+))?\s*\)/g;
  let out = '';
  for (const m of content.matchAll(re)) {
    if (m[1] !== undefined || m[2] !== undefined) out += unescapeCss(m[1] ?? m[2]);
    else {
      const style = m[4] && !m[4].startsWith('"') ? m[4] : m[5];
      out += formatCounter(counters.get(m[3]) ?? 0, style);
    }
  }
  return out;
}

/**
 * Remplace les ::before / ::after générés (puces, numéros de liste…) par de vrais <span>
 * (styles calculés recopiés), pour qu'ils soient mesurables et exportés en texte.
 * Les compteurs CSS sont simulés dans l'ordre du document.
 */
export function materializePseudo(root) {
  if (root.dataset.d2pMaterialized) return;
  root.dataset.d2pMaterialized = '1';
  const style = document.createElement('style');
  style.textContent = `.${NO_PSEUDO}::before,.${NO_PSEUDO}::after{content:none!important}`;
  root.appendChild(style);
  const counters = new Map();
  const applyCounters = (cs) => {
    for (const [n, v] of parseCounterOps(cs.counterReset, 0)) counters.set(n, v);
    for (const [n, v] of parseCounterOps(cs.counterSet, 0)) counters.set(n, v);
    for (const [n, v] of parseCounterOps(cs.counterIncrement, 1)) counters.set(n, (counters.get(n) ?? 0) + v);
  };
  const jobs = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el; el = walker.nextNode()) {
    if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
    applyCounters(getComputedStyle(el));
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      const content = ps.content;
      if (!content || content === 'none' || content === 'normal') continue;
      applyCounters(ps);
      const css = [];
      for (let i = 0; i < ps.length; i++) {
        const prop = ps[i];
        if (/^(counter-|content$|quotes$)/.test(prop)) continue;
        css.push(`${prop}:${ps.getPropertyValue(prop)}`);
      }
      jobs.push({ el, before: pseudo === '::before', text: mapPrivateUse(evalContent(content, counters)), css: css.join(';') });
    }
  }
  for (const { el, before, text, css } of jobs) {
    const span = document.createElement('span');
    span.style.cssText = css;
    span.textContent = text;
    if (before) el.prepend(span); else el.append(span);
    el.classList.add(NO_PSEUDO);
  }
}

/* ---------- Extraction vectorielle (liste d'opérations de dessin) ---------- */

const parseColor = (str) => {
  const m = /rgba?\(([^)]+)\)/.exec(str || '');
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (a < 0.05) return null;
  // Composition sur fond blanc (pas de transparence dans le PDF).
  const mix = (c) => Math.round(c * a + 255 * (1 - a));
  return [mix(r), mix(g), mix(b)];
};
const isWhite = (c) => c && c[0] > 250 && c[1] > 250 && c[2] > 250;
const DASHES = { dashed: [3, 2], dotted: [1, 1.5] };

/** Décalage haut de boîte → ligne de base, mesuré une fois par police. */
function baselineOffset(cs, cache) {
  const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.fontStyle}`;
  if (cache.has(key)) return cache.get(key);
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;line-height:normal;visibility:hidden;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle}`;
  const text = document.createElement('span');
  text.textContent = 'Hg';
  const mark = document.createElement('span');
  mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  probe.append(text, mark);
  document.body.appendChild(probe);
  const offset = mark.getBoundingClientRect().top - text.getBoundingClientRect().top;
  probe.remove();
  cache.set(key, offset);
  return offset;
}

function transformText(s, cs) {
  if (cs.textTransform === 'uppercase') return s.toUpperCase();
  if (cs.textTransform === 'lowercase') return s.toLowerCase();
  if (cs.textTransform === 'capitalize') return s.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
  return s;
}

const decorationOf = (el) => {
  const deco = { underline: false, strike: false };
  for (let n = el, depth = 0; n && depth < 4; n = n.parentElement, depth++) {
    const cs = getComputedStyle(n);
    const line = cs.textDecorationLine || cs.textDecoration || '';
    if (line.includes('underline')) deco.underline = true;
    if (line.includes('line-through')) deco.strike = true;
    if (cs.display !== 'inline') break; // la décoration se propage depuis le bloc conteneur au plus
  }
  return deco;
};

async function rasterToDataUrl(source, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  c.width = c.height = 0;
  return url;
}

async function imageFromUrl(src) {
  const im = new Image();
  im.src = src;
  await im.decode();
  return im;
}

function createExtractor(page) {
  const pr = page.getBoundingClientRect();
  const k = PX_TO_PT;
  const X = (px) => (px - pr.left) * k;
  const Y = (px) => (px - pr.top) * k;
  const ops = [];
  const fonts = new Set();
  const baselineCache = new Map();
  const range = document.createRange();

  const pushRect = (r, color) => {
    if (r.width < 0.5 || r.height < 0.5) return;
    ops.push({ t: 'rect', x: X(r.left), y: Y(r.top), w: r.width * k, h: r.height * k, color });
  };

  const pushImage = async (src, r) => {
    if (r.width < 1 || r.height < 1) return;
    try {
      let data = src, fmt = 'PNG';
      if (/^data:image\/jpe?g/i.test(src)) fmt = 'JPEG';
      else if (!/^data:image\/png/i.test(src)) {
        const im = await imageFromUrl(src);
        const ratio = Math.min(3, Math.max(1, im.naturalWidth / r.width));
        data = await rasterToDataUrl(im, r.width * ratio, r.height * ratio);
      }
      ops.push({ t: 'image', data, fmt, x: X(r.left), y: Y(r.top), w: r.width * k, h: r.height * k });
    } catch (_) { /* image illisible : ignorée */ }
  };

  const box = async (el, cs, r) => {
    const bg = parseColor(cs.backgroundColor);
    const inline = cs.display === 'inline';
    if (bg && !(el === page && isWhite(bg))) {
      if (inline) [...el.getClientRects()].forEach((q) => pushRect(q, bg));
      else pushRect(r, bg);
    }
    const bgImg = /url\(["']?(data:image\/[^"')]+)["']?\)/.exec(cs.backgroundImage || '');
    if (bgImg && !inline) await pushImage(bgImg[1], r);
    if (inline) return;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const w = parseFloat(cs[`border${side}Width`]);
      const st = cs[`border${side}Style`];
      const color = parseColor(cs[`border${side}Color`]);
      if (!w || !color || st === 'none' || st === 'hidden') continue;
      const h = w / 2;
      const [x1, y1, x2, y2] = side === 'Top' ? [r.left, r.top + h, r.right, r.top + h]
        : side === 'Bottom' ? [r.left, r.bottom - h, r.right, r.bottom - h]
          : side === 'Left' ? [r.left + h, r.top, r.left + h, r.bottom]
            : [r.right - h, r.top, r.right - h, r.bottom];
      ops.push({ t: 'line', x1: X(x1), y1: Y(y1), x2: X(x2), y2: Y(y2), w: w * k, color, dash: DASHES[st] || null });
    }
  };

  const text = (node, cs) => {
    const data = node.data;
    if (!/\S/.test(data)) return;
    const color = parseColor(cs.color);
    if (!color) return;
    const pre = /^pre|break-spaces/.test(cs.whiteSpace);
    const lines = [];
    let cur = null;
    const add = (start, end, q) => {
      if (cur && Math.abs(q.top - cur.top) < q.height * 0.5 && q.left >= cur.right - 1) {
        cur.end = end; cur.right = q.right; cur.words.push({ start, end, left: q.left, right: q.right });
      } else {
        cur = { start, end, top: q.top, left: q.left, right: q.right, words: [{ start, end, left: q.left, right: q.right }] };
        lines.push(cur);
      }
    };
    for (const m of data.matchAll(/\S+/g)) {
      const end = m.index + m[0].length;
      range.setStart(node, m.index);
      range.setEnd(node, end);
      const rects = [...range.getClientRects()].filter((q) => q.width > 0);
      if (rects.length === 1) add(m.index, end, rects[0]);
      else if (rects.length > 1) {
        for (let i = m.index; i < end; i++) { // mot coupé sur plusieurs lignes
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const q = range.getClientRects()[0];
          if (q && q.width > 0) add(i, i + 1, q);
        }
      }
    }
    if (!lines.length) return;
    const font = `${fontClass(cs.fontFamily)}-${fontStyle(cs)}`;
    fonts.add(font);
    const size = parseFloat(cs.fontSize) * k;
    const base = baselineOffset(cs, baselineCache);
    const justify = cs.textAlign === 'justify';
    const deco = decorationOf(node.parentElement);
    const clean = (s) => mapPrivateUse(transformText(pre ? s : s.replace(/\s+/g, ' '), cs));
    for (const ln of lines) {
      ops.push({
        t: 'text', font, size, color, deco,
        y: Y(ln.top + base), x: X(ln.left), w: (ln.right - ln.left) * k,
        text: clean(data.slice(ln.start, ln.end)),
        words: justify && ln.words.length > 1
          ? ln.words.map((wd) => ({ text: clean(data.slice(wd.start, wd.end)), x: X(wd.left), w: (wd.right - wd.left) * k }))
          : null,
      });
    }
  };

  const walk = async (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const hidden = cs.visibility !== 'visible' || Number(cs.opacity) === 0;
    if (!hidden) {
      const r = el.getBoundingClientRect();
      await box(el, cs, r);
      if (el.tagName === 'IMG') { await pushImage(el.currentSrc || el.src, r); return; }
      if (el.tagName === 'CANVAS') {
        try { ops.push({ t: 'image', data: el.toDataURL('image/png'), fmt: 'PNG', x: X(r.left), y: Y(r.top), w: r.width * k, h: r.height * k }); } catch (_) { /* canvas protégé */ }
        return;
      }
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && el.tagName.toLowerCase() === 'svg') {
        const xml = new XMLSerializer().serializeToString(el);
        await pushImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, r);
        return;
      }
    }
    for (const child of el.childNodes) {
      if (child.nodeType === 1) await walk(child);
      else if (child.nodeType === 3 && !hidden) text(child, cs);
    }
  };

  return { run: async () => { await walk(page); return { ops, fonts }; } };
}

/* ---------- Dessin ---------- */

function drawOps(pdf, ops, fontMap) {
  for (const op of ops) {
    if (op.t === 'rect') {
      pdf.setFillColor(...op.color);
      pdf.rect(op.x, op.y, op.w, op.h, 'F');
    } else if (op.t === 'line') {
      pdf.setDrawColor(...op.color);
      pdf.setLineWidth(op.w);
      pdf.setLineDashPattern(op.dash ? op.dash.map((d) => d * op.w) : [], 0);
      pdf.line(op.x1, op.y1, op.x2, op.y2);
      pdf.setLineDashPattern([], 0);
    } else if (op.t === 'image') {
      try { pdf.addImage(op.data, op.fmt, op.x, op.y, op.w, op.h, undefined, 'FAST'); } catch (_) { /* format non supporté */ }
    } else if (op.t === 'text') {
      const f = fontMap.get(op.font);
      pdf.setFont(f.name, f.style);
      pdf.setFontSize(op.size);
      pdf.setTextColor(...op.color);
      const put = (str, x, w) => {
        const s = f.unicode ? str : toWinAnsi(str);
        if (!s.trim()) return;
        const tw = pdf.getTextWidth(s);
        const hs = tw > 0 ? Math.min(2, Math.max(0.5, w / tw)) : 1;
        pdf.text(s, x, op.y, { baseline: 'alphabetic', horizontalScale: hs });
      };
      if (op.words) op.words.forEach((wd) => put(wd.text, wd.x, wd.w));
      else put(op.text, op.x, op.w);
      if (op.deco.underline || op.deco.strike) {
        pdf.setDrawColor(...op.color);
        pdf.setLineWidth(Math.max(0.4, op.size * 0.06));
        if (op.deco.underline) pdf.line(op.x, op.y + op.size * 0.12, op.x + op.w, op.y + op.size * 0.12);
        if (op.deco.strike) pdf.line(op.x, op.y - op.size * 0.28, op.x + op.w, op.y - op.size * 0.28);
      }
    }
  }
  pdf.setTextColor(0, 0, 0);
}

/* ---------- Mode image ---------- */

const PAPER = '#ffffff';

/** Découpe un canvas de page trop haut en plusieurs pages de hauteur `pageH` (px canvas). */
function sliceCanvas(canvas, pageH) {
  if (canvas.height <= pageH * 1.02) return [canvas];
  const out = [];
  for (let y = 0; y < canvas.height - pageH * 0.02; y += pageH) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = pageH;
    const g = c.getContext('2d');
    g.fillStyle = PAPER;
    g.fillRect(0, 0, c.width, c.height);
    const h = Math.min(pageH, canvas.height - y);
    g.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    out.push(c);
  }
  return out;
}

function thumbFromCanvas(canvas, width) {
  const t = document.createElement('canvas');
  t.width = width;
  t.height = Math.round(canvas.height * (width / canvas.width));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  const url = t.toDataURL('image/jpeg', 0.8);
  t.width = t.height = 0;
  return url;
}

/* ---------- Pagination & API publique ---------- */

const PX_TO_PT = 0.75;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * Scinde une page HTML qui dépasse sa hauteur (min-height) en pages clones : les blocs de fin
 * du conteneur `contentSelector` passent sur la page suivante ; les autres enfants (en-tête/pied) sont dupliqués.
 */
export function paginateOverflow(page, contentSelector = ':scope > article') {
  const limit = parseFloat(getComputedStyle(page).minHeight);
  if (!limit) return;
  let cur = page;
  while (cur.offsetHeight > limit + 1) {
    const content = cur.querySelector(contentSelector);
    if (!content || content.children.length < 2) return; // bloc unique trop haut : page agrandie / découpée
    const next = cur.cloneNode(false);
    let nextContent = null;
    for (const child of cur.children) {
      if (child === content) { nextContent = content.cloneNode(false); next.appendChild(nextContent); } else next.appendChild(child.cloneNode(true));
    }
    cur.after(next);
    while (cur.offsetHeight > limit + 1 && content.children.length > 1) nextContent.prepend(content.lastElementChild);
    cur = next;
  }
}

/**
 * Convertit des pages HTML rendues (dans le DOM, non display:none) en PDF.
 * @param {HTMLElement[]} pages  une page PDF par élément (taille = offsetWidth × min-height)
 * @param {object} o
 * @param {'vector'|'image'} [o.mode='vector']
 * @param {HTMLElement} [o.root]  racine commune (compteurs CSS des listes) ; défaut : parent de la 1re page
 * @param {number} [o.scale=2]  échelle html2canvas (mode image)
 * @param {'jpeg'|'png'} [o.imageFormat='jpeg']  compression des pages (mode image)
 * @param {(msg:string)=>void} [o.onProgress]
 * @param {()=>boolean} [o.isActive]  false → abandon (outil démonté)
 * @returns {Promise<{blob:Blob, pageCount:number, thumbs:string[]}|null>}
 */
export async function renderPagesToPdf(pages, {
  mode = 'vector', root, scale = 2, imageFormat = 'jpeg', onProgress = () => {}, isActive = () => true, thumbWidth = 140,
} = {}) {
  const [jsPDF, html2canvas] = await Promise.all([loadScriptLib(JSPDF_LIB), loadScriptLib(HTML2CANVAS_LIB)]);
  if (!isActive()) return null;
  let pdf = null;
  const addPage = (wPt, hPt) => {
    const orientation = wPt > hPt ? 'l' : 'p';
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [wPt, hPt], orientation, compress: true });
    else pdf.addPage([wPt, hPt], orientation);
  };
  const thumbs = [];
  let count = 0;

  if (mode === 'vector') {
    materializePseudo(root || pages[0].parentElement);
    await nextFrame();
    const extracted = [];
    const used = new Set();
    for (let i = 0; i < pages.length; i++) {
      onProgress(`Analyse de la page ${i + 1}/${pages.length}…`);
      const page = pages[i];
      const wPx = page.offsetWidth;
      const hPx = Math.max(parseFloat(getComputedStyle(page).minHeight) || 0, page.offsetHeight);
      const { ops, fonts } = await createExtractor(page).run();
      fonts.forEach((f) => used.add(f));
      const shot = await html2canvas(page, { scale: thumbWidth / wPx, backgroundColor: PAPER, logging: false });
      thumbs.push(thumbFromCanvas(shot, thumbWidth));
      shot.width = shot.height = 0;
      extracted.push({ ops, wPt: wPx * PX_TO_PT, hPt: hPx * PX_TO_PT });
      if (!isActive()) return null;
      await nextFrame();
    }
    onProgress('Chargement des polices…');
    // Document créé avant l'enregistrement des polices (VFS propre à chaque document jsPDF).
    addPage(extracted[0].wPt, extracted[0].hPt);
    const fontMap = await registerFonts(pdf, used);
    if (!isActive()) return null;
    extracted.forEach((pg, i) => {
      onProgress(`Écriture de la page ${i + 1}/${extracted.length}…`);
      if (i > 0) addPage(pg.wPt, pg.hPt);
      drawOps(pdf, pg.ops, fontMap);
      count++;
    });
  } else {
    const usePng = imageFormat === 'png';
    for (let i = 0; i < pages.length; i++) {
      onProgress(`Rendu de la page ${i + 1}/${pages.length}…`);
      const page = pages[i];
      const wPx = page.offsetWidth;
      const hPx = parseFloat(getComputedStyle(page).minHeight) || page.offsetHeight;
      const canvas = await html2canvas(page, { scale, backgroundColor: PAPER, useCORS: true, logging: false });
      if (!isActive()) return null;
      const wPt = wPx * PX_TO_PT, hPt = hPx * PX_TO_PT;
      for (const slice of sliceCanvas(canvas, Math.round(hPx * (canvas.width / wPx)))) {
        addPage(wPt, hPt);
        const data = usePng ? slice.toDataURL('image/png') : slice.toDataURL('image/jpeg', 0.92);
        pdf.addImage(data, usePng ? 'PNG' : 'JPEG', 0, 0, wPt, hPt, undefined, 'FAST');
        thumbs.push(thumbFromCanvas(slice, thumbWidth));
        count++;
        if (slice !== canvas) slice.width = slice.height = 0;
      }
      canvas.width = canvas.height = 0;
      await nextFrame();
    }
  }

  onProgress('Génération du PDF…');
  return { blob: pdf.output('blob'), pageCount: count, thumbs };
}
