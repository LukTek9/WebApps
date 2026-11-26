/**
 * pdf-to-word.js — Outil « PDF vers Word » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 * Moteur : pdf.js extrait texte (position, police, taille, couleur) et images de chaque page ;
 * les lignes sont regroupées en paragraphes (alignement, retraits, espacements), puis un .docx
 * modifiable est écrit directement en OOXML (JSZip). Libs chargées à la demande depuis CDN.
 */
import { bindDropzone, createDropzone, createSecurityUI, showError } from '../shared/security-tool-ui.js';
import { loadScriptLib } from '../shared/dom-to-pdf.js';

const PDFJS_VERSION = '3.11.174';
const PDFJS_LIB = {
  key: 'pdfjs',
  global: () => window.pdfjsLib,
  sources: [
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`,
    `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`,
  ],
};
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
const JSZIP_LIB = {
  key: 'jszip',
  global: () => window.JSZip,
  sources: [
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
  ],
};

const THUMB_WIDTH = 140;
const TWIP = 20; // 1 pt = 20 twips
const EMU = 12700; // 1 pt = 12700 EMU
const EMPTY_PREVIEW = '<div class="doc2pdf-empty">L\'aperçu des pages apparaîtra après conversion</div>';
const NOTE = 'Texte, styles (police, gras, italique, taille, couleur), alignements et images sont reconstruits en paragraphes modifiables. Les mises en page complexes (colonnes, tableaux) sont simplifiées : colonnes de tableau séparées par des tabulations. Un PDF scanné ne contient que des images : passez-le d\'abord dans l\'outil OCR.';

let state = null;

/* ---------- Utilitaires ---------- */

const fmtSize = (b) => {
  if (b < 1024) return `${b} o`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} Ko`;
  return `${(b / 1048576).toFixed(2)} Mo`;
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const xml = (s) => s
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** Nom de police PDF → nom de police Word (sous-ensemble, suffixes et variantes retirés). */
const KNOWN_FONTS = {
  timesnewroman: 'Times New Roman', times: 'Times New Roman', couriernew: 'Courier New', courier: 'Courier New',
  helvetica: 'Arial', arial: 'Arial', symbol: 'Symbol', zapfdingbats: 'Wingdings', calibri: 'Calibri', cambria: 'Cambria',
};
function wordFontName(raw) {
  let n = String(raw || '').replace(/^[A-Z]{6}\+/, '');
  n = n.split(/[-,]/)[0].replace(/(PSMT|PS|MT|Std|Pro|LT)$/g, '').replace(/(Bold|Italic|Oblique|Regular|Light|Medium|Semibold|Black|Heavy|Roman)+$/i, '') || n;
  const known = KNOWN_FONTS[n.toLowerCase().replace(/\s/g, '')];
  if (known) return known;
  return n.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || 'Calibri';
}

/** pdf.js renvoie la couleur de remplissage en [r,g,b] (3.x) ou '#rrggbb' (4.x). */
const fillHex = (args) => {
  if (typeof args?.[0] === 'string') return args[0].replace('#', '').toUpperCase();
  if (args?.length >= 3) return `${hex2(args[0])}${hex2(args[1])}${hex2(args[2])}`.toUpperCase();
  return '000000';
};

/* ---------- Images ---------- */

function getPdfObj(objs, id) {
  return new Promise((resolve) => {
    try { objs.get(id, resolve); } catch (_) { resolve(null); }
    setTimeout(() => resolve(null), 4000);
  });
}

/** Objet image pdf.js → Blob PNG/JPEG. */
async function imageToBlob(img) {
  if (!img) return null;
  const w = img.width || img.bitmap?.width, h = img.height || img.bitmap?.height;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  let opaque = false;
  if (img.bitmap) g.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const out = g.createImageData(w, h);
    const d = out.data, src = img.data;
    if (img.kind === 3) d.set(src.subarray(0, d.length));
    else if (img.kind === 2) {
      opaque = true;
      for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = src[i]; d[j + 1] = src[i + 1]; d[j + 2] = src[i + 2]; d[j + 3] = 255; }
    } else { // 1 bit par pixel, lignes alignées sur l'octet
      opaque = true;
      const rowBytes = (w + 7) >> 3;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const j = (y * w + x) * 4;
        d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
      }
    }
    g.putImageData(out, 0, 0);
  } else return null;
  const jpeg = opaque && w * h > 200000;
  const blob = await new Promise((r) => c.toBlob(r, jpeg ? 'image/jpeg' : 'image/png', 0.9));
  c.width = c.height = 0;
  return blob ? { blob, ext: jpeg ? 'jpeg' : 'png', w, h } : null;
}

/* ---------- Extraction d'une page ---------- */

async function extractPage(pdfjs, page, withImages, imageCache) {
  const viewport = page.getViewport({ scale: 1 });
  const { Util, OPS } = pdfjs;
  const ops = await page.getOperatorList();

  // Parcours des opérateurs : couleur du texte (flux de caractères) + placement des images.
  let ctm = [1, 0, 0, 1, 0, 0];
  let fill = '000000';
  const stack = [];
  const colorStream = [];
  const imageRefs = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push([ctm, fill]); break;
      case OPS.restore: if (stack.length) [ctm, fill] = stack.pop(); break;
      case OPS.transform: ctm = Util.transform(ctm, args); break;
      case OPS.paintFormXObjectBegin: stack.push([ctm, fill]); if (args?.[0]) ctm = Util.transform(ctm, args[0]); break;
      case OPS.paintFormXObjectEnd: if (stack.length) [ctm, fill] = stack.pop(); break;
      case OPS.setFillRGBColor: fill = fillHex(args); break;
      case OPS.showText: case OPS.showSpacedText:
        for (const gl of args[0] || []) {
          if (gl && typeof gl === 'object' && gl.unicode) for (const ch of gl.unicode) if (/\S/.test(ch)) colorStream.push([ch, fill]);
        }
        break;
      case OPS.paintImageXObject: if (withImages) imageRefs.push({ id: args[0], ctm }); break;
      case OPS.paintInlineImageXObject: if (withImages) imageRefs.push({ inline: args[0], ctm }); break;
      default: break;
    }
  }

  // Texte : éléments positionnés (haut de page = 0, en points).
  const tc = await page.getTextContent();
  const fontInfo = (name) => {
    let f = null;
    try { if (page.commonObjs.has(name)) f = page.commonObjs.get(name); } catch (_) { /* police non résolue */ }
    const raw = f?.name || tc.styles[name]?.fontFamily || '';
    return {
      family: wordFontName(raw),
      bold: Boolean(f?.bold || f?.black) || /bold|black|heavy|semibold|demi/i.test(raw),
      italic: Boolean(f?.italic) || /italic|oblique/i.test(raw),
    };
  };
  const fontCache = new Map();
  let cursor = 0;
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = Util.transform(viewport.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    if (size < 1) continue;
    // Couleur : resynchronisation sur le premier caractère visible de l'élément.
    const first = it.str.match(/\S/)[0];
    let color = '000000';
    for (let k = cursor; k < Math.min(colorStream.length, cursor + 40); k++) {
      if (colorStream[k][0] === first) { color = colorStream[k][1]; cursor = k; break; }
    }
    cursor += it.str.replace(/\s/g, '').length;
    if (!fontCache.has(it.fontName)) fontCache.set(it.fontName, fontInfo(it.fontName));
    const width = it.width * viewport.scale;
    items.push({ str: it.str, x: tx[4], base: tx[5], size, w: width, color, ...fontCache.get(it.fontName) });
  }

  // Images : boîte englobante en coordonnées de page (haut = 0).
  const images = [];
  for (const ref of imageRefs) {
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => viewport.convertToViewportPoint(...Util.applyTransform([u, v], ref.ctm)));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const box = { x: Math.min(...xs), top: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    if (box.w < 6 || box.h < 6 || box.x > viewport.width || box.top > viewport.height) continue;
    let media = ref.id ? imageCache.get(ref.id) : null;
    if (!media) {
      const obj = ref.inline || await getPdfObj(page.objs, ref.id);
      media = await imageToBlob(obj);
      if (!media) continue;
      if (ref.id) imageCache.set(ref.id, media);
    }
    images.push({ ...box, media });
  }

  return { width: viewport.width, height: viewport.height, items, images };
}

/* ---------- Reconstruction lignes → paragraphes ---------- */

function buildLines(items) {
  const sorted = items.slice().sort((a, b) => a.base - b.base || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const ln = lines.find((l) => Math.abs(l.base - it.base) < Math.min(l.size, it.size) * 0.45);
    if (ln) { ln.items.push(it); ln.size = Math.max(ln.size, it.size); } else lines.push({ base: it.base, size: it.size, items: [it] });
  }
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    ln.left = ln.items[0].x;
    ln.right = Math.max(...ln.items.map((i) => i.x + i.w));
    ln.top = ln.base - ln.size;
  }
  return lines.sort((a, b) => a.base - b.base);
}

const LIST_START = /^\s*([•●▪◦■\-–*]|\d{1,3}[.)]|[a-z][.)])\s/i;

function buildBlocks(page) {
  const lines = buildLines(page.items);
  const colLeft = lines.length ? Math.min(...lines.map((l) => l.left)) : 0;
  const colRight = lines.length ? Math.max(...lines.map((l) => l.right)) : page.width;
  const colWidth = Math.max(1, colRight - colLeft);
  const paras = [];
  let cur = null;
  for (const ln of lines) {
    let split = !cur;
    if (cur) {
      const prev = cur.lines[cur.lines.length - 1];
      const gap = ln.base - prev.base;
      const spacing = cur.lines.length >= 2 ? cur.spacing : Math.max(prev.size, ln.size) * 1.25;
      const refLeft = cur.lines.length >= 2 ? cur.lines[1].left : null;
      split = gap > spacing * 1.3 + 1
        || Math.abs(ln.size - prev.size) > 1.5
        || prev.right < colRight - colWidth * 0.2 // ligne précédente courte : fin de paragraphe
        || LIST_START.test(ln.items[0].str)
        || (refLeft !== null ? Math.abs(ln.left - refLeft) > ln.size : ln.left > prev.left + ln.size * 0.5);
    }
    if (split) {
      cur = { lines: [ln], spacing: 0 };
      paras.push(cur);
    } else {
      cur.lines.push(ln);
      const n = cur.lines.length;
      cur.spacing = (cur.lines[n - 1].base - cur.lines[0].base) / (n - 1);
    }
  }
  for (const p of paras) {
    const first = p.lines[0], last = p.lines[p.lines.length - 1];
    p.top = first.top;
    p.bottom = last.base;
    p.size = first.size;
    p.left = p.lines.length > 1 ? Math.min(...p.lines.slice(1).map((l) => l.left)) : first.left;
    p.firstIndent = first.left - p.left;
    const lMargin = Math.min(...p.lines.map((l) => l.left)) - colLeft;
    const rMargin = colRight - Math.max(...p.lines.map((l) => l.right));
    const centered = p.lines.every((l) => Math.abs((l.left - colLeft) - (colRight - l.right)) < Math.max(6, first.size)) && lMargin > first.size;
    if (centered) p.align = 'center';
    else if (rMargin < first.size && lMargin > colWidth * 0.3) p.align = 'right';
    else if (p.lines.length > 2 && p.lines.slice(0, -1).every((l) => colRight - l.right < first.size * 0.6)) p.align = 'both';
    else p.align = 'left';
  }
  return { paras, colLeft, colRight };
}

/* ---------- Écriture OOXML ---------- */

function runXml(it, text) {
  const sz = Math.max(2, Math.round(it.size * 2));
  const f = xml(it.family);
  return `<w:r><w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/>${it.bold ? '<w:b/>' : ''}${it.italic ? '<w:i/>' : ''}${it.color !== '000000' ? `<w:color w:val="${it.color}"/>` : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>${text}</w:r>`;
}
const textXml = (s) => `<w:t xml:space="preserve">${xml(s)}</w:t>`;
const styleKey = (it) => `${it.family}|${it.bold}|${it.italic}|${Math.round(it.size * 2)}|${it.color}`;

function paragraphXml(p, ctxDoc, { pageBreak, before }) {
  const runs = [];
  const tabs = new Set();
  let pending = null; // { it, text }
  const flush = () => { if (pending) { runs.push(runXml(pending.it, textXml(pending.text))); pending = null; } };
  const push = (it, text) => {
    if (pending && styleKey(pending.it) === styleKey(it)) pending.text += text;
    else { flush(); pending = { it, text }; }
  };
  p.lines.forEach((ln, li) => {
    if (li > 0 && pending && !/[\s-]$/.test(pending.text)) pending.text += ' ';
    let prevEnd = null;
    for (const it of ln.items) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        if (gap > it.size * 2) { // colonnes (tableaux) : tabulation + taquet à la position d'origine
          flush();
          runs.push(runXml(it, '<w:tab/>'));
          tabs.add(Math.round(Math.max(0, it.x - ctxDoc.marginLeft) * TWIP));
        }
        else if (gap > it.size * 0.2 && pending && !/\s$/.test(pending.text) && !/^\s/.test(it.str)) push(it, ' ');
      }
      push(it, it.str);
      prevEnd = it.x + it.w;
    }
  });
  flush();
  const left = Math.max(0, p.left - ctxDoc.marginLeft);
  const lineRatio = p.spacing ? clamp(p.spacing / (p.size * 1.2), 1, 3) : 1;
  // Ordre des éléments de <w:pPr> imposé par le schéma OOXML (pageBreakBefore, tabs, spacing, ind, jc).
  const ppr = [
    pageBreak ? '<w:pageBreakBefore/>' : '',
    tabs.size ? `<w:tabs>${[...tabs].sort((a, b) => a - b).map((pos) => `<w:tab w:val="left" w:pos="${pos}"/>`).join('')}</w:tabs>` : '',
    `<w:spacing w:before="${Math.round(clamp(before, 0, 200) * TWIP)}" w:after="0" w:line="${Math.round(240 * lineRatio)}" w:lineRule="auto"/>`,
    p.align !== 'center' && p.align !== 'right' && (left > 1 || Math.abs(p.firstIndent) > 1)
      ? `<w:ind w:left="${Math.round(left * TWIP)}" ${p.firstIndent >= 0 ? `w:firstLine="${Math.round(p.firstIndent * TWIP)}"` : `w:hanging="${Math.round(-p.firstIndent * TWIP)}"`}/>` : '',
    p.align !== 'left' ? `<w:jc w:val="${p.align}"/>` : '',
  ].join('');
  return `<w:p><w:pPr>${ppr}</w:pPr>${runs.join('')}</w:p>`;
}

function imageXml(img, rId, id, ctxDoc, { pageBreak, before }) {
  const maxW = ctxDoc.textWidth;
  const scale = img.w > maxW ? maxW / img.w : 1;
  const cx = Math.round(img.w * scale * EMU), cy = Math.round(img.h * scale * EMU);
  const center = Math.abs((img.x - ctxDoc.marginLeft) - (ctxDoc.pageWidth - ctxDoc.marginRight - (img.x + img.w))) < 12;
  const left = center ? 0 : Math.max(0, img.x - ctxDoc.marginLeft);
  return `<w:p><w:pPr>${pageBreak ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="${Math.round(clamp(before, 0, 200) * TWIP)}" w:after="0"/>${center ? '<w:jc w:val="center"/>' : left > 1 ? `<w:ind w:left="${Math.round(Math.min(left, maxW - img.w * scale) * TWIP)}"/>` : ''}</w:pPr>`
    + `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Image ${id}"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

async function buildDocx(JSZip, pages, { pageBreaks, title }) {
  // Marges communes : plus petits retraits de contenu observés (bornés 0,25"–1,5").
  const bounds = pages.map((pg) => {
    const xs = [...pg.items.map((i) => i.x), ...pg.images.map((i) => i.x)];
    const rs = [...pg.items.map((i) => i.x + i.w), ...pg.images.map((i) => i.x + i.w)];
    const ts = [...pg.items.map((i) => i.base - i.size), ...pg.images.map((i) => i.top)];
    const bs = [...pg.items.map((i) => i.base), ...pg.images.map((i) => i.top + i.h)];
    return xs.length ? { l: Math.min(...xs), r: pg.width - Math.max(...rs), t: Math.min(...ts), b: pg.height - Math.max(...bs) } : null;
  }).filter(Boolean);
  const pick = (k) => (bounds.length ? clamp(Math.min(...bounds.map((b) => b[k])), 18, 108) : 72);
  const first = pages[0];
  const ctxDoc = { pageWidth: first.width, marginLeft: pick('l'), marginRight: pick('r'), marginTop: pick('t'), marginBottom: clamp(pick('b'), 18, 72) };
  ctxDoc.textWidth = Math.max(72, first.width - ctxDoc.marginLeft - ctxDoc.marginRight);

  // Police / taille dominantes → style Normal.
  const freq = new Map();
  pages.forEach((pg) => pg.items.forEach((i) => { const k = `${i.family}|${Math.round(i.size * 2)}`; freq.set(k, (freq.get(k) || 0) + i.str.length); }));
  const [baseFamily = 'Calibri', baseSz = '22'] = ([...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '').split('|').filter(Boolean);

  const zip = new JSZip();
  const rels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'];
  const mediaIds = new Map();
  let imgId = 0;
  const body = [];
  let paraCount = 0;

  pages.forEach((pg, pi) => {
    const { paras } = buildBlocks(pg);
    const blocks = [
      ...paras.map((p) => ({ kind: 'p', top: p.top, bottom: p.bottom, p })),
      ...pg.images.map((img) => ({ kind: 'img', top: img.top, bottom: img.top + img.h, img })),
    ].sort((a, b) => a.top - b.top);
    let prevBottom = ctxDoc.marginTop;
    blocks.forEach((b, bi) => {
      const pageBreak = pageBreaks && pi > 0 && bi === 0;
      const before = bi === 0 ? b.top - ctxDoc.marginTop : b.top - prevBottom - (b.kind === 'p' ? b.p.size * 0.25 : 0);
      if (b.kind === 'p') {
        body.push(paragraphXml(b.p, ctxDoc, { pageBreak, before: Math.max(0, before) }));
        paraCount++;
      } else {
        const m = b.img.media;
        if (!mediaIds.has(m)) {
          const n = mediaIds.size + 1;
          const rId = `rIdImg${n}`;
          zip.file(`word/media/image${n}.${m.ext}`, m.blob);
          rels.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${n}.${m.ext}"/>`);
          mediaIds.set(m, rId);
        }
        body.push(imageXml(b.img, mediaIds.get(m), ++imgId, ctxDoc, { pageBreak, before: Math.max(0, before) }));
      }
      prevBottom = b.bottom;
    });
    if (!blocks.length && pageBreaks && pi > 0) body.push('<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>');
  });
  if (!body.length) body.push('<w:p/>');

  const sect = `<w:sectPr><w:pgSz w:w="${Math.round(first.width * TWIP)}" w:h="${Math.round(first.height * TWIP)}"${first.width > first.height ? ' w:orient="landscape"' : ''}/>`
    + `<w:pgMar w:top="${Math.round(ctxDoc.marginTop * TWIP)}" w:right="${Math.round(ctxDoc.marginRight * TWIP)}" w:bottom="${Math.round(ctxDoc.marginBottom * TWIP)}" w:left="${Math.round(ctxDoc.marginLeft * TWIP)}" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>`;

  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  zip.file('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${xml(title)}</dc:title><dc:creator>WebApp Tools</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  const bf = xml(baseFamily);
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${bf}" w:hAnsi="${bf}" w:cs="${bf}" w:eastAsia="${bf}"/><w:sz w:val="${baseSz}"/><w:szCs w:val="${baseSz}"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
    + `<w:body>${body.join('')}${sect}</w:body></w:document>`);

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
  return { blob, paraCount, imageCount: imgId };
}

/* ---------- Outil ---------- */

export function mount(container, ctx) {
  const ui = createSecurityUI(container, {
    content: `
      <div class="doc2pdf">
        ${createDropzone({ id: 'pdf', title: 'Glissez-déposez un PDF ici', hint: 'ou cliquez pour parcourir · fichier .pdf', accept: '.pdf,application/pdf', label: 'Importer un PDF' })}
        <div class="doc2pdf-file" data-role="file" hidden>
          <i data-lucide="file-text"></i>
          <div class="doc2pdf-file-info">
            <span class="doc2pdf-file-name" data-role="name"></span>
            <span class="doc2pdf-file-sub" data-role="sub"></span>
          </div>
          <button type="button" class="btn-remove-file" data-role="clear"><i data-lucide="trash-2"></i> Retirer</button>
        </div>
        <div class="doc2pdf-options">
          <label class="tool-field">Images
            <select data-role="images">
              <option value="1" selected>Inclure</option>
              <option value="0">Ignorer (texte seul)</option>
            </select>
          </label>
          <label class="tool-field">Sauts de page
            <select data-role="breaks">
              <option value="1" selected>Conserver les pages du PDF</option>
              <option value="0">Texte continu</option>
            </select>
          </label>
        </div>
        <button type="button" class="btn-primary doc2pdf-convert" data-role="convert" disabled>
          <i data-lucide="download"></i><span>Convertir et télécharger le .docx</span>
        </button>
        <div class="doc2pdf-preview" data-role="preview">${EMPTY_PREVIEW}</div>
        <p class="doc2pdf-note status-muted">${NOTE}</p>
      </div>`,
  });

  state = { ui, file: null, busy: false, mounted: true, doc: null };
  const $ = (r) => ui.query(`[data-role="${r}"]`);
  const fileBox = $('file'), convertBtn = $('convert'), clearBtn = $('clear'), preview = $('preview');
  let dz = null;

  const render = () => {
    const has = Boolean(state.file);
    fileBox.hidden = !has;
    if (has) {
      $('name').textContent = state.file.name;
      $('sub').textContent = fmtSize(state.file.size);
    }
    convertBtn.disabled = !has || state.busy;
    clearBtn.disabled = state.busy;
    $('images').disabled = state.busy;
    $('breaks').disabled = state.busy;
    dz?.setDisabled(state.busy);
  };
  const reset = () => { ui.setStatus(''); preview.innerHTML = EMPTY_PREVIEW; };

  dz = bindDropzone(ui, {
    id: 'pdf',
    multiple: false,
    onFiles: ([file]) => { state.file = file; reset(); render(); },
  });
  clearBtn.addEventListener('click', () => { state.file = null; reset(); render(); }, { signal: ui.signal });

  convertBtn.addEventListener('click', async () => {
    if (state.busy || !state.file) return;
    state.busy = true;
    render();
    const label = convertBtn.querySelector('span');
    const original = label.textContent;
    const file = state.file;
    const withImages = $('images').value === '1';
    const pageBreaks = $('breaks').value === '1';
    let doc = null;
    try {
      label.textContent = 'Chargement des moteurs…';
      const [pdfjs, JSZip] = await Promise.all([loadScriptLib(PDFJS_LIB), loadScriptLib(JSZIP_LIB)]);
      if (!state?.mounted) return;
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

      label.textContent = 'Lecture du PDF…';
      try {
        doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isOffscreenCanvasSupported: false }).promise;
      } catch (e) {
        if (e?.name === 'PasswordException') throw new Error('PDF protégé par mot de passe : retirez-le d\'abord avec « Suppresseur de mots de passe PDF ».');
        throw e;
      }
      state.doc = doc;

      const pages = [];
      const thumbs = [];
      const imageCache = new Map();
      for (let i = 1; i <= doc.numPages; i++) {
        label.textContent = `Analyse de la page ${i}/${doc.numPages}…`;
        const page = await doc.getPage(i);
        pages.push(await extractPage(pdfjs, page, withImages, imageCache));
        const vp = page.getViewport({ scale: THUMB_WIDTH / page.getViewport({ scale: 1 }).width });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        thumbs.push(c.toDataURL('image/jpeg', 0.8));
        c.width = c.height = 0;
        page.cleanup();
        if (!state?.mounted) return;
        await nextFrame();
      }
      if (!pages.some((p) => p.items.length)) {
        ui.setStatus('Aucun texte détecté : PDF scanné ? Utilisez d\'abord l\'outil OCR. Le .docx contiendra uniquement les images.', 'error');
      }

      label.textContent = 'Génération du document Word…';
      const baseName = file.name.replace(/\.pdf$/i, '') || 'document';
      const { blob, paraCount, imageCount } = await buildDocx(JSZip, pages, { pageBreaks, title: baseName });
      if (!state?.mounted) return;
      const outName = `${baseName}.docx`;
      ui.download(blob, outName, blob.type);
      preview.innerHTML = `<div class="doc2pdf-grid">${thumbs.map((src, i) => `
        <figure class="doc2pdf-page"><img src="${src}" alt="Page ${i + 1}"><figcaption>${i + 1}</figcaption></figure>`).join('')}</div>`;
      if (pages.some((p) => p.items.length)) {
        ui.setStatus(`${outName} : ${pages.length} page${pages.length > 1 ? 's' : ''} · ${paraCount} paragraphe${paraCount > 1 ? 's' : ''} · ${imageCount} image${imageCount > 1 ? 's' : ''} · ${fmtSize(blob.size)}.`, 'success');
      }
      ctx?.toast?.('Document Word généré.');
    } catch (err) {
      showError(ui, err instanceof Error ? new Error(`Erreur : ${err.message}`) : err, 'Conversion impossible.');
    } finally {
      try { await doc?.destroy(); } catch (_) { /* déjà libéré */ }
      if (state) state.doc = null;
      if (state?.mounted) {
        label.textContent = original;
        state.busy = false;
        render();
      }
    }
  }, { signal: ui.signal });

  render();
  try { window.lucide?.createIcons({ root: container }); } catch (_) { /* icônes optionnelles */ }
}

export function unmount() {
  if (!state) return;
  state.mounted = false;
  try { state.doc?.destroy(); } catch (_) { /* déjà libéré */ }
  state.ui.destroy();
  state = null;
}
