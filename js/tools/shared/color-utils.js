export function hexToRgb(value) {
  const clean = String(value).trim().replace(/^#/, '');
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(clean)) throw new Error('Couleur HEX invalide.');
  const full = clean.length === 3 ? [...clean].map((channel) => channel + channel).join('') : clean;
  return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16));
}

export function rgbToHex(rgb) {
  if (rgb.length < 3 || rgb.slice(0, 3).some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    throw new Error('Valeurs RGB hors limites.');
  }
  return `#${rgb.slice(0, 3).map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function hueToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const f = (offset) => {
    const k = (offset + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

export function rgbToHsl([red, green, blue]) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  const lightness = (max + min) / 2;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  hue = (hue * 60 + 360) % 360;
  const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
  return [Math.round(hue), Math.round(saturation * 100), Math.round(lightness * 100)];
}

export function rgbToHsv([red, green, blue]) {
  const [r, g, b] = [red, green, blue].map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return [(hue + 360) % 360, max ? delta / max * 100 : 0, max * 100].map((value) => Math.round(value));
}

export function rgbToCmyk([red, green, blue]) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const black = 1 - Math.max(r, g, b);
  if (black >= 1) return [0, 0, 0, 100];
  return [
    (1 - r - black) / (1 - black) * 100,
    (1 - g - black) / (1 - black) * 100,
    (1 - b - black) / (1 - black) * 100,
    black * 100,
  ].map(Math.round);
}

function parseParts(body) {
  const parts = body.trim().split(/[,\s/]+/).filter(Boolean);
  if (!parts.length) throw new Error('Couleur vide ou invalide.');
  return parts;
}

function validateAlpha(part) {
  const alpha = Number(part.endsWith('%') ? part.slice(0, -1) / 100 : part);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error('L’alpha doit être compris entre 0 et 1.');
}

function componentValue(token, scale, label) {
  const percent = token.endsWith('%');
  const value = Number(percent ? token.slice(0, -1) : token);
  if (!Number.isFinite(value)) throw new Error(`${label} n’est pas un nombre valide.`);
  const result = percent ? value / 100 * scale : value;
  if (result < 0 || result > scale) throw new Error(`${label} doit être compris entre 0 et ${scale}${percent ? ' %' : ''}.`);
  return result;
}

export function parseColor(value) {
  const source = String(value).trim();
  if (source.startsWith('#')) return hexToRgb(source);
  const match = source.match(/^(rgb|rgba|hsl|hsla|hsv|hsb|cmyk)\s*\((.*)\)$/i);
  if (!match) throw new Error('Utilisez une couleur HEX, rgb(), hsl(), hsv() ou cmyk().');
  const format = match[1].toLowerCase().replace(/a$/, '');
  const parts = parseParts(match[2]);
  if (format === 'rgb') {
    if (parts.length !== 3 && parts.length !== 4) throw new Error('RGB nécessite trois composantes.');
    if (parts.length === 4) validateAlpha(parts[3]);
    const rgb = parts.slice(0, 3).map((part) => componentValue(part, part.endsWith('%') ? 100 : 255, 'Chaque composante RGB'));
    return rgb.map((channel, index) => parts[index].endsWith('%') ? channel / 100 * 255 : channel);
  }
  if (format === 'hsl') {
    if (parts.length < 3) throw new Error('HSL nécessite une teinte, une saturation et une luminosité.');
    if (parts.length === 4) validateAlpha(parts[3]);
    const hue = Number(parts[0].replace(/deg$/i, ''));
    const saturation = componentValue(parts[1], 100, 'La saturation');
    const lightness = componentValue(parts[2], 100, 'La luminosité');
    if (!Number.isFinite(hue)) throw new Error('La teinte HSL est invalide.');
    return hueToRgb(hue, saturation, lightness);
  }
  if (format === 'hsv' || format === 'hsb') {
    if (parts.length < 3) throw new Error('HSV nécessite une teinte, une saturation et une valeur.');
    if (parts.length === 4) validateAlpha(parts[3]);
    const hue = Number(parts[0].replace(/deg$/i, ''));
    const saturation = componentValue(parts[1], 100, 'La saturation');
    const brightness = componentValue(parts[2], 100, 'La valeur');
    if (!Number.isFinite(hue)) throw new Error('La teinte HSV est invalide.');
    const h = ((hue % 360) + 360) % 360 / 60;
    const s = saturation / 100;
    const v = brightness / 100;
    const chroma = v * s;
    const x = chroma * (1 - Math.abs(h % 2 - 1));
    const m = v - chroma;
    const values = h < 1 ? [chroma, x, 0] : h < 2 ? [x, chroma, 0] : h < 3 ? [0, chroma, x] : h < 4 ? [0, x, chroma] : h < 5 ? [x, 0, chroma] : [chroma, 0, x];
    return values.map((channel) => (channel + m) * 255);
  }
  if (parts.length < 4) throw new Error('CMYK nécessite quatre composantes.');
  let values = parts.slice(0, 4).map((part) => Number(part.replace('%', '')));
  if (values.some((valuePart) => !Number.isFinite(valuePart))) throw new Error('Les composantes CMYK sont invalides.');
  if (parts.slice(0, 4).some((part) => part.endsWith('%')) || values.some((valuePart) => valuePart > 1)) {
    values = values.map((valuePart) => valuePart / 100);
  }
  if (values.some((valuePart) => valuePart < 0 || valuePart > 1)) throw new Error('Chaque composante CMYK doit être comprise entre 0 et 100 %.');
  const [cyan, magenta, yellow, black] = values;
  return [(1 - cyan) * (1 - black) * 255, (1 - magenta) * (1 - black) * 255, (1 - yellow) * (1 - black) * 255];
}

export function themeColorHex(token) {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const computedColor = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error(`Impossible de résoudre le jeton ${token}.`);
  context.fillStyle = computedColor;
  context.fillRect(0, 0, 1, 1);
  const pixel = context.getImageData(0, 0, 1, 1).data;
  return rgbToHex([pixel[0], pixel[1], pixel[2]]);
}

export function contrastRatio(first, second) {
  const luminance = (rgb) => rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function rotateHsl(rgb, hueOffset = 0, lightnessOffset = 0) {
  const [hue, saturation, lightness] = rgbToHsl(rgb);
  return hueToRgb(hue + hueOffset, saturation, Math.min(95, Math.max(5, lightness + lightnessOffset)));
}
