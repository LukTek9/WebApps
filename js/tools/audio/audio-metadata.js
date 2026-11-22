/**
 * audio-metadata.js — Outil « Éditeur de métadonnées ID3 » (100 % client, sans ré-encodage).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichier MP3 (glisser-déposer / sélecteur) → lecture binaire partielle (File.slice) :
 *     tag(s) ID3v2.2 / 2.3 / 2.4 en tête + ID3v1 en queue. Champs : titre, artiste, album, année,
 *     piste, genre, artiste de l'album, commentaire + pochette (APIC / PIC). ID3v2 prioritaire, ID3v1 en secours.
 *  2. Formulaire d'édition + aperçu / remplacement (JPEG, PNG) / suppression de la pochette.
 *  3. Écriture : nouveau tag ID3v2.3 (texte UTF-16) construit à la main, puis assemblé en Blob avec les
 *     trames MPEG d'origine (File.slice : ni copie, ni ré-encodage). Ancien ID3v2 et ID3v1 de queue retirés.
 *  4. Lien de téléchargement <nom>_tags.mp3 ; objectURL (résultat + pochette) révoqué à chaque
 *     régénération / reset / unmount.
 */

/* ---------- Constantes ---------- */
const MAX_COVER = 16 * 1048576; // 16 Mo
const SYNC_SCAN = 65536;        // fenêtre de recherche d'une synchro MPEG après le tag

/** Genres ID3v1 standard (0–79). */
const GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

/** Champs du formulaire. */
const FIELDS = ['title', 'artist', 'album', 'albumartist', 'year', 'track', 'genre', 'comment'];

/** Trames ID3v2 → champ (v2.3/2.4 puis équivalents v2.2). */
const FRAME_MAP = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TALB: 'album', TAL: 'album',
  TPE2: 'albumartist', TP2: 'albumartist',
  TYER: 'year', TYE: 'year', TDRC: 'year',
  TRCK: 'track', TRK: 'track',
  TCON: 'genre', TCO: 'genre',
};

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (id) => s?.root.querySelector('#audtag-' + id);
const fmtKB = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'audio';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const yieldUi = () => new Promise((r) => setTimeout(r));
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function isMp3(f) { return f.type === 'audio/mpeg' || f.type === 'audio/mp3' || extOf(f.name) === 'mp3'; }

async function readRange(file, a, b) {
  return new Uint8Array(await file.slice(a, b).arrayBuffer());
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ==========================================================================
   UI : statut / occupation
   ========================================================================== */
/** kind : 'error' | 'ok' | undefined (neutre) — classes partagées .status-*. */
function setStatus(msg, kind) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', kind === 'error');
  el.classList.toggle('status-success', kind === 'ok');
  el.classList.toggle('status-muted', !kind);
}

/** p : true (indéterminé) | false (masquer). */
function setProgress(on) {
  const bar = q('bar'); if (!bar) return;
  bar.classList.toggle('is-on', on);
  bar.classList.toggle('is-indeterminate', on);
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  q('save').disabled = busy || !s.file;
  q('reset').disabled = busy;
}

/* ==========================================================================
   Résultat / objectURL
   ========================================================================== */
function releaseUrl() {
  if (!s || !s.objectUrl) return;
  URL.revokeObjectURL(s.objectUrl);
  s.objectUrl = null;
}

function clearResult() {
  releaseUrl();
  const box = q('result'); if (!box) return;
  box.hidden = true;
  const audio = q('audio');
  audio.pause();
  audio.removeAttribute('src');
  audio.load(); // libère la ressource média
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download'); link.textContent = '';
}

function showResult(blob, name) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  q('audio').src = s.objectUrl;
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtKB(blob.size)})`;
  q('result').hidden = false;
  setStatus(`Tags écrits : ${fmtKB(blob.size)}. Audio inchangé (aucun ré-encodage).`, 'ok');
}

/* ==========================================================================
   Lecture ID3 : décodage de texte
   ========================================================================== */
/** enc : 0 = ISO-8859-1, 1 = UTF-16 (BOM), 2 = UTF-16BE, 3 = UTF-8. */
function decodeText(bytes, enc) {
  let label = 'iso-8859-1';
  if (enc === 3) label = 'utf-8';
  else if (enc === 1 || enc === 2) {
    label = enc === 2 ? 'utf-16be' : 'utf-16le';
    if (bytes.length >= 2) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) { label = 'utf-16le'; bytes = bytes.subarray(2); }
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) { label = 'utf-16be'; bytes = bytes.subarray(2); }
    }
  }
  return new TextDecoder(label).decode(bytes);
}

/** Texte sans nuls terminaux ; valeurs multiples (séparées par \0) jointes par « / ». */
function cleanText(t) {
  return t.replace(/\0+$/, '').split('\0').map((x) => x.trim()).filter(Boolean).join(' / ');
}

/** Fin d'une chaîne terminée par un nul (1 octet pour enc 0/3, 2 octets alignés pour UTF-16). */
function findTerm(b, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return { end: i, next: i + 2 };
  } else {
    for (let i = start; i < b.length; i++) if (b[i] === 0) return { end: i, next: i + 1 };
  }
  return { end: b.length, next: b.length };
}

/** Annule l'unsynchronisation (FF 00 → FF). */
function deUnsync(b) {
  const out = new Uint8Array(b.length);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    out[o++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, o);
}

function normGenre(t) {
  const m = /^\((\d{1,3})\)(.*)$/.exec(t);
  if (m) return m[2].trim() || GENRES[Number(m[1])] || t;
  if (/^\d{1,3}$/.test(t)) return GENRES[Number(t)] || t;
  return t;
}

function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}

/** Image d'une trame APIC / PIC. */
function parsePicture(d, ver) {
  if (d.length < 5) return null;
  const enc = d[0];
  let i = 1, mime;
  if (ver === 2) {
    const f = ascii(d, 1, 3).toUpperCase();
    mime = f === 'PNG' ? 'image/png' : f === 'JPG' ? 'image/jpeg' : '';
    i = 4;
  } else {
    const t = findTerm(d, 1, 0);
    mime = ascii(d, 1, t.end - 1).toLowerCase();
    i = t.next;
  }
  const type = d[i++];
  const desc = findTerm(d, i, enc);
  const bytes = d.slice(desc.next);
  if (!bytes.length) return null;
  const sniffed = sniffImage(bytes);
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (!/^image\/(jpeg|png|gif|webp|bmp)$/.test(mime)) mime = sniffed || 'image/jpeg';
  return { bytes, mime, type };
}

/* ==========================================================================
   Lecture ID3 : ID3v2 (2.2 / 2.3 / 2.4)
   ========================================================================== */
function parseV2({ ver, flags, body }) {
  const out = { fields: {}, cover: null, lang: 'eng' };
  if (flags & 0x80) body = deUnsync(body); // unsynchronisation globale
  let pos = 0;
  if ((flags & 0x40) && ver >= 3 && body.length >= 4) { // en-tête étendu
    pos = ver === 4 ? syncsafe(body, 0) : u32(body, 0) + 4;
  }
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  let bestPic = null;

  while (pos + hdr <= body.length) {
    if (body[pos] === 0) break; // padding
    const id = ascii(body, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let size, fl0 = 0, fl1 = 0;
    if (ver === 2) size = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
    else {
      size = ver === 4 ? syncsafe(body, pos + 4) : u32(body, pos + 4);
      fl0 = body[pos + 8]; fl1 = body[pos + 9];
    }
    const start = pos + hdr, end = start + size;
    if (size <= 0 || end > body.length) break;
    pos = end;

    let d = body.subarray(start, end);
    if (ver === 3) {
      if (fl1 & 0xc0) continue; // compressée / chiffrée : ignorée
      if (fl1 & 0x20) d = d.subarray(1); // groupement
    } else if (ver === 4) {
      if (fl1 & 0x0c) continue; // compressée / chiffrée : ignorée
      let off = 0;
      if (fl1 & 0x40) off += 1;
      if (fl1 & 0x01) off += 4;
      d = d.subarray(off);
      if (fl1 & 0x02) d = deUnsync(d);
    }
    if (!d.length) continue;

    const key = FRAME_MAP[id];
    if (key && id[0] === 'T') {
      if (out.fields[key] !== undefined) continue; // première occurrence gagnante
      let t = cleanText(decodeText(d.subarray(1), d[0]));
      if (key === 'year') { const m = /^\d{4}/.exec(t); if (m) t = m[0]; }
      if (key === 'genre') t = normGenre(t);
      out.fields[key] = t;
    } else if ((id === 'COMM' || id === 'COM') && out.fields.comment === undefined) {
      if (d.length < 5) continue;
      const enc = d[0];
      const lang = ascii(d, 1, 3);
      const desc = findTerm(d, 4, enc);
      out.fields.comment = cleanText(decodeText(d.subarray(desc.next), enc));
      if (/^[a-z]{3}$/i.test(lang)) out.lang = lang.toLowerCase();
    } else if (id === 'APIC' || id === 'PIC') {
      const pic = parsePicture(d, ver);
      if (pic && (!bestPic || (pic.type === 3 && bestPic.type !== 3))) bestPic = pic; // préfère la pochette avant
    }
  }
  if (bestPic) out.cover = { bytes: bestPic.bytes, mime: bestPic.mime };
  return out;
}

/* ==========================================================================
   Lecture ID3 : ID3v1
   ========================================================================== */
function parseV1(b) {
  const t = (o, n) => cleanText(new TextDecoder('iso-8859-1').decode(b.subarray(o, o + n)).replace(/\0.*$/s, ''));
  const f = {
    title: t(3, 30), artist: t(33, 30), album: t(63, 30), year: t(93, 4),
    comment: '', track: '', genre: GENRES[b[127]] || '',
  };
  if (b[125] === 0 && b[126] !== 0) { f.comment = t(97, 28); f.track = String(b[126]); }
  else f.comment = t(97, 30);
  return f;
}

/* ==========================================================================
   Lecture fichier : localisation des tags + de l'audio
   ========================================================================== */
async function parseFile(file) {
  let pos = 0, v2 = null;
  while (pos + 10 <= file.size) { // peut y avoir plusieurs ID3v2 empilés : tous retirés, le premier lu
    const h = await readRange(file, pos, pos + 10);
    if (!(h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33)) break;
    const ver = h[3], flags = h[5];
    if (ver < 2 || ver > 4 || ((h[6] | h[7] | h[8] | h[9]) & 0x80)) break;
    const size = syncsafe(h, 6);
    const total = 10 + size + (ver === 4 && (flags & 0x10) ? 10 : 0);
    if (pos + total > file.size) throw new Error('tag ID3v2 tronqué');
    if (!v2) v2 = { ver, flags, body: await readRange(file, pos + 10, pos + 10 + size) };
    pos += total;
  }
  const audioStart = pos;

  let audioEnd = file.size, v1 = null;
  if (file.size - audioStart >= 128) {
    const t = await readRange(file, file.size - 128, file.size);
    if (t[0] === 0x54 && t[1] === 0x41 && t[2] === 0x47) { v1 = parseV1(t); audioEnd = file.size - 128; }
  }
  if (audioEnd - audioStart < 4) throw new Error('aucune donnée audio');

  // Contrôle léger : une synchro MPEG doit exister au début de l'audio
  const head = await readRange(file, audioStart, Math.min(audioEnd, audioStart + SYNC_SCAN));
  let sync = false;
  for (let i = 0; i + 1 < head.length; i++) if (head[i] === 0xff && (head[i + 1] & 0xe0) === 0xe0) { sync = true; break; }
  if (!sync) throw new Error('trames MPEG introuvables : fichier MP3 invalide');

  const parsed = v2 ? parseV2(v2) : { fields: {}, cover: null, lang: 'eng' };
  const fields = {};
  for (const k of FIELDS) fields[k] = parsed.fields[k] || (v1 ? v1[k] : '') || '';
  return { fields, cover: parsed.cover, lang: parsed.lang, audioStart, audioEnd, hadV2: !!v2, hadV1: !!v1, ver: v2?.ver };
}

/* ==========================================================================
   Écriture ID3v2.3 (UTF-16 avec BOM)
   ========================================================================== */
function utf16(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8;
  }
  return out;
}
const asciiBytes = (t) => Uint8Array.from(t, (c) => c.charCodeAt(0) & 0x7f);
const BOM = Uint8Array.of(0xff, 0xfe);

function frame(id, payload) {
  const h = new Uint8Array(10);
  h.set(asciiBytes(id), 0);
  new DataView(h.buffer).setUint32(4, payload.length); // v2.3 : taille entière classique
  return concat([h, payload]);
}

function textFrame(id, text) {
  return text ? frame(id, concat([Uint8Array.of(1), BOM, utf16(text)])) : null;
}

function buildTag(fields, cover, lang) {
  const frames = [
    textFrame('TIT2', fields.title), textFrame('TPE1', fields.artist), textFrame('TALB', fields.album),
    textFrame('TPE2', fields.albumartist), textFrame('TYER', fields.year), textFrame('TRCK', fields.track),
    textFrame('TCON', fields.genre),
  ];
  if (fields.comment) {
    frames.push(frame('COMM', concat([
      Uint8Array.of(1), asciiBytes(/^[a-z]{3}$/.test(lang) ? lang : 'eng'),
      BOM, Uint8Array.of(0, 0),          // description vide (UTF-16, terminée)
      BOM, utf16(fields.comment),
    ])));
  }
  if (cover) {
    frames.push(frame('APIC', concat([
      Uint8Array.of(0), asciiBytes(cover.mime), Uint8Array.of(0), // encodage Latin-1 + MIME
      Uint8Array.of(3), Uint8Array.of(0),                          // type « pochette avant » + description vide
      cover.bytes,
    ])));
  }
  const body = concat(frames.filter(Boolean));
  if (body.length > 0x0fffffff) throw new Error('tag trop volumineux');
  const hdr = Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0,
    (body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f, (body.length >> 7) & 0x7f, body.length & 0x7f);
  return concat([hdr, body]);
}

/* ==========================================================================
   UI : formulaire / pochette
   ========================================================================== */
function readForm() {
  const f = {};
  for (const k of FIELDS) f[k] = q(k).value.trim();
  f.year = f.year.replace(/\D/g, '').slice(0, 4);
  return f;
}

function fillForm(f) {
  for (const k of FIELDS) q(k).value = f[k] || '';
}

function releaseCoverUrl() {
  if (s?.coverUrl) { URL.revokeObjectURL(s.coverUrl); s.coverUrl = null; }
}

/** cover : { bytes, mime } | null — met à jour l'aperçu (objectURL précédent révoqué). */
function setCover(cover) {
  if (!s) return;
  releaseCoverUrl();
  s.cover = cover;
  const img = q('cover-img'), empty = q('cover-empty');
  if (cover) {
    s.coverUrl = URL.createObjectURL(new Blob([cover.bytes], { type: cover.mime }));
    img.src = s.coverUrl;
    q('cover-info').textContent = `${cover.mime.replace('image/', '').toUpperCase()} · ${fmtKB(cover.bytes.length)}`;
  } else {
    img.removeAttribute('src');
    q('cover-info').textContent = 'Aucune pochette';
  }
  img.hidden = !cover;
  empty.hidden = !!cover;
  q('cover-remove').disabled = !cover;
}

async function replaceCover(file) {
  if (!s || !file) return;
  if (file.size > MAX_COVER) { setStatus('Image trop volumineuse (max 16 Mo).', 'error'); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImage(bytes);
  if (!s) return; // unmount pendant la lecture
  if (!mime) { setStatus('Format d\'image non pris en charge : utilisez JPEG ou PNG.', 'error'); return; }
  setCover({ bytes, mime });
  clearResult();
  setStatus('Pochette remplacée. Enregistrez pour écrire les tags.');
}

/* ==========================================================================
   Chargement / enregistrement / reset
   ========================================================================== */
/** Libère tout l'état (résultat, pochette, fichier) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  clearResult();
  setCover(null);
  s.file = null; s.info = null;
  q('editor').hidden = true;
  q('drop').hidden = false;
  q('file').value = '';
  fillForm({});
  setBusy(false);
  setProgress(false);
}

async function loadFile(file) {
  if (!s || !file || s.busy) return;
  if (!isMp3(file)) {
    setStatus('Format non pris en charge : seuls les fichiers MP3 sont acceptés.', 'error');
    return;
  }
  discard();
  const token = ++s.loading;
  setStatus(`Lecture des tags de « ${file.name} »…`); setProgress(true);
  let info;
  try { info = await parseFile(file); }
  catch (e) {
    if (!s || s.loading !== token) return;
    setProgress(false);
    setStatus(`Lecture impossible : ${e.message}.`, 'error');
    return;
  }
  if (!s || s.loading !== token) return; // reset / nouveau fichier / unmount entre-temps

  s.file = file; s.info = info;
  q('drop').hidden = true;
  q('editor').hidden = false;
  q('name').textContent = file.name;
  const tags = [info.hadV2 ? `ID3v2.${info.ver}` : null, info.hadV1 ? 'ID3v1' : null].filter(Boolean).join(' + ') || 'aucun tag';
  q('meta').textContent = `MP3 · ${fmtKB(file.size)} · ${tags}`;
  fillForm(info.fields);
  setCover(info.cover);
  setBusy(false);
  setProgress(false);
  setStatus(info.hadV2 || info.hadV1 ? 'Tags chargés. Modifiez les champs puis enregistrez.' : 'Aucun tag existant : renseignez les champs puis enregistrez.');
  icons();
}

async function save() {
  if (!s?.file || s.busy) return;
  const st = s;
  clearResult();
  setBusy(true); setProgress(true);
  setStatus('Écriture du tag ID3v2.3…');
  try {
    await yieldUi();
    const fields = readForm();
    q('year').value = fields.year;
    const tag = buildTag(fields, st.cover, st.info.lang);
    // Audio : tranche du fichier d'origine (aucune copie en mémoire, aucun ré-encodage)
    const blob = new Blob([tag, st.file.slice(st.info.audioStart, st.info.audioEnd)], { type: 'audio/mpeg' });
    if (s !== st) return;
    showResult(blob, `${sanitize(st.file.name.replace(/\.[^.]+$/, ''))}_tags.mp3`);
  } catch (e) {
    if (s !== st) return;
    setStatus(e.message || 'Erreur inconnue', 'error');
  } finally {
    if (s === st) { setProgress(false); setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const fieldHtml = (id, label, extra = '', full = false) => `
        <label class="audtag-field${full ? ' audtag-field--full' : ''}">${label}
          <input type="text" id="audtag-${id}" autocomplete="off" ${extra}>
        </label>`;

const TEMPLATE = `
<div class="audtag" id="audtag-root">
  <div class="audtag-drop" id="audtag-drop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier MP3">
    <i data-lucide="tags" class="icon-xl"></i>
    <strong>Glissez un fichier MP3 ici</strong>
    <small>ou cliquez pour parcourir — tags ID3v1, ID3v2.2 / 2.3 / 2.4</small>
    <input type="file" id="audtag-file" accept="audio/mpeg,.mp3" hidden>
  </div>

  <div class="audtag-editor" id="audtag-editor" hidden>
    <div class="audtag-head">
      <div class="audtag-file"><b class="audtag-name" id="audtag-name"></b><small class="audtag-meta" id="audtag-meta"></small></div>
      <button class="btn-remove-file" id="audtag-reset" type="button"><i data-lucide="x"></i> Changer de fichier</button>
    </div>

    <div class="audtag-layout">
      <div class="audtag-cover">
        <div class="audtag-cover-box checkerboard-bg">
          <img class="audtag-cover-img" id="audtag-cover-img" alt="Pochette de l'album" hidden>
          <div class="audtag-cover-empty" id="audtag-cover-empty"><i data-lucide="image" class="icon-lg"></i><span>Pas de pochette</span></div>
        </div>
        <small class="audtag-cover-info" id="audtag-cover-info">Aucune pochette</small>
        <div class="audtag-cover-actions">
          <button class="btn-secondary" id="audtag-cover-replace" type="button"><i data-lucide="image-up"></i> Remplacer</button>
          <button class="btn-secondary" id="audtag-cover-remove" type="button" disabled><i data-lucide="trash-2"></i> Retirer</button>
        </div>
        <input type="file" id="audtag-cover-file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" hidden>
      </div>

      <div class="audtag-form">${fieldHtml('title', 'Titre', '', true)}${fieldHtml('artist', 'Artiste')}${fieldHtml('albumartist', "Artiste de l'album")}${fieldHtml('album', 'Album')}${fieldHtml('year', 'Année', 'inputmode="numeric" maxlength="4"')}${fieldHtml('track', 'Piste (ex. 3/12)')}${fieldHtml('genre', 'Genre', 'list="audtag-genres"')}${fieldHtml('comment', 'Commentaire', '', true)}
        <datalist id="audtag-genres">${GENRES.map((g) => `<option value="${g}">`).join('')}</datalist>
      </div>
    </div>
    <p class="audtag-note"><i data-lucide="info"></i> Écriture en ID3v2.3 : seuls ces champs sont conservés (les autres trames, ex. paroles, sont retirées). L'audio n'est ni ré-encodé ni modifié.</p>
  </div>

  <div>
    <div class="audtag-bar" id="audtag-bar"><i></i></div>
    <p class="audtag-status status-muted" id="audtag-status">Déposez un fichier MP3 pour commencer.</p>
  </div>

  <div class="audtag-actions">
    <button class="btn-primary" id="audtag-save" type="button" disabled><i data-lucide="save"></i> Enregistrer les tags</button>
  </div>

  <div class="audtag-result" id="audtag-result" hidden>
    <audio class="audtag-audio" id="audtag-audio" controls preload="metadata"></audio>
    <a class="btn-primary audtag-link" id="audtag-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, file: null, info: null, cover: null, coverUrl: null,
    objectUrl: null, busy: false, loading: 0,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root');
  const drop = q('drop'), file = q('file');

  // Zone de dépôt + sélecteur
  drop.addEventListener('click', () => file.click(), opt);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } }, opt);
  file.addEventListener('change', () => { const f = file.files?.[0]; if (f) loadFile(f); }, opt);
  // Dépôt n'importe où dans l'outil (évite la navigation du navigateur vers le fichier)
  root.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); }, opt);
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) drop.classList.remove('is-over'); }, opt);
  root.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f);
  }, opt);

  // Tout changement de champ invalide le résultat précédent
  FIELDS.forEach((k) => q(k).addEventListener('input', clearResult, opt));

  // Pochette
  const cfile = q('cover-file');
  q('cover-replace').addEventListener('click', () => cfile.click(), opt);
  cfile.addEventListener('change', () => { const f = cfile.files?.[0]; cfile.value = ''; if (f) replaceCover(f); }, opt);
  q('cover-remove').addEventListener('click', () => {
    setCover(null); clearResult();
    setStatus('Pochette retirée. Enregistrez pour écrire les tags.');
  }, opt);

  // Enregistrement / reset
  q('save').addEventListener('click', save, opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez un fichier MP3 pour commencer.');
  }, opt);

  icons();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide une lecture en cours
  clearResult();               // pause <audio> + URL.revokeObjectURL (résultat)
  releaseCoverUrl();           // URL.revokeObjectURL (aperçu pochette)
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
