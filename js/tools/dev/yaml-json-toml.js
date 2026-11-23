import { createWorkspace, setStats } from '../shared/dev-tool-kit.js';

let view;

const NAMES = { yaml: 'YAML', json: 'JSON', toml: 'TOML' };
const EXT = { yaml: 'yml', json: 'json', toml: 'toml' };
const MIME = { yaml: 'application/x-yaml;charset=utf-8', json: 'application/json;charset=utf-8', toml: 'application/toml;charset=utf-8' };
const SAMPLES = {
  yaml: 'nom: Alice\nage: 30\nactif: true\ntags:\n  - dev\n  - web',
  json: '{"nom":"Alice","age":30,"actif":true,"tags":["dev","web"]}',
  toml: 'nom = "Alice"\nage = 30\nactif = true\ntags = ["dev", "web"]',
};
const formatOptions = (selected) => Object.entries(NAMES).map(([id, label]) => `<option value="${id}"${id === selected ? ' selected' : ''}>${label}</option>`).join('');
const CONTROLS = `<label class="dev-tools__field">Source<select class="dev-tools__select" data-from>${formatOptions('yaml')}</select></label><button class="btn-secondary" type="button" data-action="swap" aria-label="Inverser les formats">⇄ Inverser</button><label class="dev-tools__field">Cible<select class="dev-tools__select" data-to>${formatOptions('json')}</select></label><label class="dev-tools__field">Indentation<select class="dev-tools__select" data-indent><option value="2">2 espaces</option><option value="4">4 espaces</option></select></label>`;

const mk = () => Object.create(null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isC = (v) => Array.isArray(v) || isObj(v);
const isEmptyC = (v) => (Array.isArray(v) ? !v.length : isObj(v) && !Object.keys(v).length);
const count = (v) => (Array.isArray(v) ? v.reduce((n, x) => n + count(x), 0) : isObj(v) ? Object.values(v).reduce((n, x) => n + 1 + count(x), 0) : 0);

/* ───────────── YAML : parseur ───────────── */

function readQuoted(s, start) {
  const q = s[start];
  let out = '';
  let i = start + 1;
  const simple = { n: '\n', t: '\t', r: '\r', 0: '\0', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', e: '\x1b', ' ': ' ' };
  while (i < s.length) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") { out += "'"; i += 2; continue; }
        return [out, i + 1];
      }
      out += c; i++; continue;
    }
    if (c === '"') return [out, i + 1];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'u' || n === 'x' || n === 'U') {
        const len = n === 'x' ? 2 : n === 'u' ? 4 : 8;
        const hex = s.slice(i + 2, i + 2 + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw new Error('Échappement Unicode invalide');
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + len;
        continue;
      }
      if (n !== undefined && Object.prototype.hasOwnProperty.call(simple, n)) { out += simple[n]; i += 2; continue; }
      throw new Error(`Échappement invalide « \\${n ?? ''} »`);
    }
    out += c; i++;
  }
  throw new Error('Guillemet non fermé');
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) { if (q === "'" && line[i + 1] === "'") i++; else q = null; }
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(line[i - 1]))) q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function yamlScalar(t) {
  if (t === '' || t === '~' || /^(null|Null|NULL)$/.test(t)) return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(?:0|[1-9][\d_]*)$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^0x[\da-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
  if (/[.eE]/.test(t) && /^[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^[-+]?\.(inf|Inf|INF)$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(t)) return NaN;
  return t;
}

function balanced(s) {
  let d = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (q === '"' && c === '\\') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d <= 0 && !q;
}

function parseFlow(s) {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = () => { throw new Error('Collection flow invalide'); };
  const str = () => { const [v, j] = readQuoted(s, i); i = j; return v; };
  const val = () => {
    ws();
    if (s[i] === '[') {
      i++;
      const a = [];
      for (;;) {
        ws();
        if (s[i] === ']') { i++; return a; }
        a.push(val());
        ws();
        if (s[i] === ',') i++; else if (s[i] !== ']') fail();
      }
    }
    if (s[i] === '{') {
      i++;
      const o = mk();
      for (;;) {
        ws();
        if (s[i] === '}') { i++; return o; }
        let k;
        if (s[i] === '"' || s[i] === "'") k = str();
        else { const st = i; while (i < s.length && !':,}'.includes(s[i])) i++; k = s.slice(st, i).trim(); }
        ws();
        let v = null;
        if (s[i] === ':') { i++; ws(); if (s[i] !== ',' && s[i] !== '}') v = val(); }
        o[k] = v;
        ws();
        if (s[i] === ',') i++; else if (s[i] !== '}') fail();
      }
    }
    if (s[i] === '"' || s[i] === "'") return str();
    const st = i;
    while (i < s.length && !',]}'.includes(s[i])) i++;
    return yamlScalar(s.slice(st, i).trim());
  };
  const out = val();
  ws();
  if (i < s.length) fail();
  return out;
}

function findKey(t) {
  if (!t || t[0] === '[' || t[0] === '{' || t[0] === '|' || t[0] === '>') return null;
  if (t[0] === '"' || t[0] === "'") {
    let k;
    let j;
    try { [k, j] = readQuoted(t, 0); } catch { return null; }
    const m = t.slice(j).match(/^\s*:(?:\s+(.*))?$/);
    return m ? { key: k, rest: (m[1] || '').trim() } : null;
  }
  const m = t.match(/^(.*?)\s*:(?:\s+(.*))?$/);
  return m && m[1] ? { key: m[1].trim(), rest: (m[2] || '').trim() } : null;
}

function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let pos = 0;
  const indentOf = (l) => {
    const n = l.length - l.trimStart().length;
    if (/\t/.test(l.slice(0, n))) throw new Error(`Tabulation interdite dans l’indentation (ligne ${pos + 1})`);
    return n;
  };
  const skip = () => { while (pos < lines.length && stripComment(lines[pos]).trim() === '') pos++; };
  const isDash = (t) => t === '-' || t.startsWith('- ');

  const block = (h, parent) => {
    const fold = h[0] === '>';
    const keep = h.includes('+');
    const strip = h.includes('-');
    const body = [];
    let bi = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.trim() === '') { body.push(''); pos++; continue; }
      const ind = indentOf(l);
      if (bi === null) { if (ind <= parent) break; bi = ind; }
      if (ind < bi) break;
      body.push(l.slice(bi));
      pos++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
    if (!body.length) return '';
    let out = '';
    if (!fold) out = body.join('\n');
    else {
      body.forEach((cur, k) => {
        if (k === 0) { out = cur; return; }
        const prev = body[k - 1];
        if (cur === '') out += '\n';
        else if (prev === '') out += cur;
        else if (/^\s/.test(cur) || /^\s/.test(prev)) out += `\n${cur}`;
        else out += ` ${cur}`;
      });
    }
    if (strip) return out;
    return keep ? `${out}\n${'\n'.repeat(trailing)}` : `${out}\n`;
  };

  const value = (rest, parent) => {
    if (/^[&*!]/.test(rest)) throw new Error(`Ancres, alias et tags YAML non supportés (ligne ${pos})`);
    if (/^[|>][+-]?\d*[+-]?$/.test(rest)) return block(rest, parent);
    if (rest[0] === '[' || rest[0] === '{') {
      let txt = rest;
      while (!balanced(txt) && pos < lines.length) txt += ` ${stripComment(lines[pos++]).trim()}`;
      return parseFlow(txt);
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const [s, j] = readQuoted(rest, 0);
      if (rest.slice(j).trim()) throw new Error(`Contenu inattendu après la chaîne (ligne ${pos})`);
      return s;
    }
    let txt = rest;
    while (pos < lines.length) {
      const t2 = stripComment(lines[pos]).trim();
      if (t2 === '' || indentOf(lines[pos]) <= parent) break;
      txt += ` ${t2}`;
      pos++;
    }
    return yamlScalar(txt);
  };

  const node = (min) => {
    skip();
    if (pos >= lines.length) return undefined;
    const line = lines[pos];
    const ind = indentOf(line);
    if (ind < min) return undefined;
    const t = stripComment(line).trim();
    if (isDash(t)) return seq(ind);
    if (findKey(t)) return map(ind);
    pos++;
    return value(t, ind - 1);
  };

  const seq = (ind) => {
    const arr = [];
    for (;;) {
      skip();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const li = indentOf(line);
      if (li < ind) break;
      if (li > ind) throw new Error(`Indentation incorrecte (ligne ${pos + 1})`);
      const t = stripComment(line).trim();
      if (!isDash(t)) break;
      const col = line.indexOf('-') + 1;
      const rest = t.slice(1).trim();
      if (rest === '') {
        pos++;
        const c = node(ind + 1);
        arr.push(c === undefined ? null : c);
      } else if (findKey(rest) || isDash(rest)) {
        const tail = line.slice(col);
        const off = col + (tail.length - tail.trimStart().length);
        lines[pos] = ' '.repeat(off) + line.slice(off);
        arr.push(node(ind + 1));
      } else {
        pos++;
        arr.push(value(rest, ind));
      }
    }
    return arr;
  };

  const map = (ind) => {
    const obj = mk();
    for (;;) {
      skip();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const li = indentOf(line);
      if (li < ind) break;
      if (li > ind) throw new Error(`Indentation incorrecte (ligne ${pos + 1})`);
      const t = stripComment(line).trim();
      const kv = findKey(t);
      if (!kv) {
        if (isDash(t) || t === '---' || t === '...') break;
        throw new Error(`Clé « clé: valeur » attendue (ligne ${pos + 1})`);
      }
      pos++;
      if (kv.key in obj) throw new Error(`Clé dupliquée « ${kv.key} » (ligne ${pos})`);
      let v = null;
      if (kv.rest === '') {
        skip();
        if (pos < lines.length) {
          const ni = indentOf(lines[pos]);
          if (ni > ind) v = node(ind + 1);
          else if (ni === ind && isDash(stripComment(lines[pos]).trim())) v = seq(ind);
          if (v === undefined) v = null;
        }
      } else v = value(kv.rest, ind);
      obj[kv.key] = v;
    }
    return obj;
  };

  skip();
  while (pos < lines.length && lines[pos].startsWith('%')) { pos++; skip(); }
  if (pos < lines.length && stripComment(lines[pos]).trim() === '---') pos++;
  const result = node(0);
  skip();
  if (pos < lines.length) throw new Error(`Contenu inattendu ligne ${pos + 1} (documents multiples non supportés)`);
  return result === undefined ? null : result;
}

/* ───────────── YAML : sérialiseur ───────────── */

const YAML_SPECIAL = /^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|: |\s#|:$|^(?:---|\.\.\.)|^(?:y|yes|n|no|on|off)$|[\u0000-\u001f]/i;

function yamlInline(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isNaN(v) ? '.nan' : !Number.isFinite(v) ? (v > 0 ? '.inf' : '-.inf') : String(v);
  if (Array.isArray(v)) return '[]';
  if (isObj(v)) return '{}';
  const s = String(v);
  return typeof yamlScalar(s) !== 'string' || YAML_SPECIAL.test(s) ? JSON.stringify(s) : s;
}

const yamlKey = (k) => (/^[A-Za-z_][\w./-]*$/.test(k) && typeof yamlScalar(k) === 'string' && !YAML_SPECIAL.test(k) ? k : JSON.stringify(k));

function yamlDump(v, col, step) {
  const pad = ' '.repeat(col);
  if (Array.isArray(v)) {
    return v.map((it) => {
      if (isC(it) && !isEmptyC(it)) {
        if (Array.isArray(it)) return `${pad}-\n${yamlDump(it, col + step, step)}`;
        return `${pad}- ${yamlDump(it, col + 2, step).slice(col + 2)}`;
      }
      return `${pad}- ${yamlInline(it)}`;
    }).join('\n');
  }
  return Object.entries(v).map(([k, x]) => {
    const head = `${pad}${yamlKey(k)}:`;
    return isC(x) && !isEmptyC(x) ? `${head}\n${yamlDump(x, col + step, step)}` : `${head} ${yamlInline(x)}`;
  }).join('\n');
}

const yamlDoc = (d, step) => (isC(d) && !isEmptyC(d) ? yamlDump(d, 0, step) : yamlInline(d));

/* ───────────── TOML : parseur ───────────── */

function parseToml(input) {
  const s = input.replace(/\r\n?/g, '\n');
  const root = mk();
  let i = 0;
  const err = (m) => { throw new Error(`${m} (ligne ${s.slice(0, i).split('\n').length})`); };
  const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  const comment = () => { if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++; };
  const all = () => { for (;;) { ws(); if (s[i] === '\n') i++; else if (s[i] === '#') comment(); else return; } };
  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  const unescape = (b) => b.replace(/\\(?:([btnfr"\\])|u([\da-fA-F]{4})|U([\da-fA-F]{8})|[ \t]*\n\s*)/g, (m, c, u, U) => (c ? ESC[c] : u ? String.fromCodePoint(parseInt(u, 16)) : U ? String.fromCodePoint(parseInt(U, 16)) : ''));

  const quoted = (d) => {
    const st = ++i;
    while (i < s.length && s[i] !== '\n') {
      if (d === '"' && s[i] === '\\') i += 2;
      else if (s[i] === d) { const b = s.slice(st, i); i++; return d === '"' ? unescape(b) : b; }
      else i++;
    }
    return err('Chaîne non fermée');
  };
  const multi = (d) => {
    i += 3;
    if (s[i] === '\n') i++;
    const st = i;
    for (;;) {
      if (i >= s.length) err('Chaîne multiligne non fermée');
      if (d === '"' && s[i] === '\\') { i += 2; continue; }
      if (s.startsWith(d.repeat(3), i)) {
        let n = 3;
        while (s[i + n] === d && n < 5) n++;
        const b = s.slice(st, i + n - 3);
        i += n;
        return d === '"' ? unescape(b) : b;
      }
      i++;
    }
  };

  const keyPath = () => {
    const parts = [];
    for (;;) {
      ws();
      if (s[i] === '"' || s[i] === "'") parts.push(quoted(s[i]));
      else {
        const m = /[A-Za-z0-9_-]+/y;
        m.lastIndex = i;
        const r = m.exec(s);
        if (!r) err('Clé attendue');
        parts.push(r[0]);
        i += r[0].length;
      }
      ws();
      if (s[i] === '.') i++; else return parts;
    }
  };

  const put = (o, p, v) => {
    let cur = o;
    for (const k of p.slice(0, -1)) {
      if (!(k in cur)) cur[k] = mk();
      cur = cur[k];
      if (!isObj(cur)) err(`Clé « ${k} » redéfinie`);
    }
    const last = p[p.length - 1];
    if (last in cur) err(`Clé dupliquée « ${last} »`);
    cur[last] = v;
  };

  const bare = (t) => {
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^[+-]?inf$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(t)) return NaN;
    if (/^\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:[Zz]|[+-]\d\d:\d\d)?)?$|^\d\d:\d\d:\d\d(?:\.\d+)?$/.test(t)) return t;
    if (/^[+-]?(?:0|[1-9](?:_?\d)*)$/.test(t)) return Number(t.replace(/_/g, ''));
    if (/^0x[\da-f_]+$/i.test(t)) return parseInt(t.slice(2).replace(/_/g, ''), 16);
    if (/^0o[0-7_]+$/.test(t)) return parseInt(t.slice(2).replace(/_/g, ''), 8);
    if (/^0b[01_]+$/.test(t)) return parseInt(t.slice(2).replace(/_/g, ''), 2);
    if (/^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/.test(t)) return Number(t.replace(/_/g, ''));
    return err(`Valeur invalide « ${t} »`);
  };

  const value = () => {
    const c = s[i];
    if (c === '"') return s.startsWith('"""', i) ? multi('"') : quoted('"');
    if (c === "'") return s.startsWith("'''", i) ? multi("'") : quoted("'");
    if (c === '[') {
      i++;
      const a = [];
      for (;;) {
        all();
        if (s[i] === ']') { i++; return a; }
        a.push(value());
        all();
        if (s[i] === ',') i++; else if (s[i] !== ']') err('«,» ou «]» attendu');
      }
    }
    if (c === '{') {
      i++;
      const o = mk();
      for (;;) {
        all();
        if (s[i] === '}') { i++; return o; }
        const p = keyPath();
        ws();
        if (s[i] !== '=') err('«=» attendu');
        i++;
        ws();
        put(o, p, value());
        all();
        if (s[i] === ',') i++; else if (s[i] !== '}') err('«,» ou «}» attendu');
      }
    }
    const st = i;
    while (i < s.length && !',]}#\n'.includes(s[i])) i++;
    return bare(s.slice(st, i).trim());
  };

  const table = (path, aot) => {
    let o = root;
    path.forEach((k, n) => {
      if (aot && n === path.length - 1) {
        if (!(k in o)) o[k] = [];
        if (!Array.isArray(o[k])) err(`Clé « ${k} » redéfinie`);
        const t = mk();
        o[k].push(t);
        o = t;
        return;
      }
      if (!(k in o)) o[k] = mk();
      let nx = o[k];
      if (Array.isArray(nx)) nx = nx[nx.length - 1];
      if (!isObj(nx)) err(`Clé « ${k} » redéfinie`);
      o = nx;
    });
    return o;
  };

  const eol = () => { ws(); comment(); if (i < s.length && s[i] !== '\n') err('Caractère inattendu'); };

  let cur = root;
  for (;;) {
    all();
    if (i >= s.length) break;
    if (s[i] === '[') {
      const aot = s[i + 1] === '[';
      i += aot ? 2 : 1;
      const path = keyPath();
      ws();
      if (aot) { if (s.slice(i, i + 2) !== ']]') err('«]]» attendu'); i += 2; }
      else { if (s[i] !== ']') err('«]» attendu'); i++; }
      cur = table(path, aot);
    } else {
      const path = keyPath();
      ws();
      if (s[i] !== '=') err('«=» attendu');
      i++;
      ws();
      put(cur, path, value());
    }
    eol();
  }
  return root;
}

/* ───────────── TOML : sérialiseur ───────────── */

function tomlDump(root) {
  if (!isObj(root)) throw new Error('TOML exige un objet à la racine.');
  let skipped = 0;
  const key = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
  const inline = (v) => {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : !Number.isFinite(v) ? (v > 0 ? 'inf' : '-inf') : String(v);
    const items = [];
    if (Array.isArray(v)) {
      for (const x of v) { if (x === null || x === undefined) skipped++; else items.push(inline(x)); }
      return `[${items.join(', ')}]`;
    }
    for (const [k, x] of Object.entries(v)) { if (x === null || x === undefined) skipped++; else items.push(`${key(k)} = ${inline(x)}`); }
    return items.length ? `{ ${items.join(', ')} }` : '{}';
  };
  const out = [];
  const emit = (obj, path, header) => {
    const simple = [];
    const subs = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) { skipped++; continue; }
      if (isObj(v) || (Array.isArray(v) && v.length && v.every(isObj))) subs.push([k, v]);
      else simple.push(`${key(k)} = ${inline(v)}`);
    }
    if (header) { if (out.length) out.push(''); out.push(header); }
    out.push(...simple);
    for (const [k, v] of subs) {
      const p = [...path, key(k)];
      if (Array.isArray(v)) v.forEach((el) => emit(el, p, `[[${p.join('.')}]]`));
      else emit(v, p, `[${p.join('.')}]`);
    }
  };
  emit(root, [], '');
  return { text: `${out.join('\n')}\n`, warn: skipped ? `${skipped} valeur(s) null ignorée(s) (non supportées par TOML).` : '' };
}

/* ───────────── Conversion & UI ───────────── */

const PARSE = { yaml: parseYaml, json: (t) => JSON.parse(t), toml: parseToml };
const DUMP = {
  yaml: (d, n) => ({ text: `${yamlDoc(d, n)}\n`, warn: '' }),
  json: (d, n) => ({ text: JSON.stringify(d, null, n), warn: '' }),
  toml: (d) => tomlDump(d),
};

const $ = (name) => view.root.querySelector(`[data-${name}]`);

function update() {
  const from = $('from').value;
  const to = $('to').value;
  const step = Number($('indent').value);
  const route = `${NAMES[from]} → ${NAMES[to]}`;
  const heads = view.root.querySelectorAll('.dev-tools__panel-head strong');
  heads[0].textContent = `Source ${NAMES[from]}`;
  heads[1].textContent = `Résultat ${NAMES[to]}`;
  view.source.placeholder = SAMPLES[from];
  if (!view.source.value.trim()) {
    view.output.textContent = '';
    view.status('En attente de données…');
    setStats(view, [route]);
    return;
  }
  try {
    const data = PARSE[from](view.source.value);
    const { text, warn } = DUMP[to](data, step);
    view.output.textContent = text;
    view.status(`Conversion ${route} réussie.${warn ? ` ${warn}` : ''}`, 'success');
    setStats(view, [route, `${text.trimEnd().split('\n').length} lignes`, `${count(data)} clés`]);
  } catch (error) {
    view.output.textContent = '';
    view.status(`Conversion impossible : ${error.message}`, 'error');
    setStats(view, [`${NAMES[from]} invalide`]);
  }
}

export function mount(container) {
  view = createWorkspace(container, {
    title: 'Convertisseur YAML / JSON / TOML',
    description: 'Convertissez entre YAML, JSON et TOML avec validation en direct.',
    sourceLabel: 'Source',
    outputLabel: 'Résultat',
    sourcePlaceholder: SAMPLES.yaml,
    controls: CONTROLS,
  });
  view.root.querySelector('.dev-tools__heading')?.remove();
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'swap') {
      const f = $('from');
      const t = $('to');
      const out = view.output.textContent;
      [f.value, t.value] = [t.value, f.value];
      if (out) view.source.value = out;
      update();
    }
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, `donnees.${EXT[$('to').value]}`, MIME[$('to').value]);
  };
  view.root.addEventListener('input', view.onInput);
  view.root.addEventListener('change', view.onInput);
  view.root.addEventListener('click', view.onClick);
  update();
}

export function unmount() {
  if (!view) return;
  view.root.removeEventListener('input', view.onInput);
  view.root.removeEventListener('change', view.onInput);
  view.root.removeEventListener('click', view.onClick);
  view.dispose();
  view = null;
}
