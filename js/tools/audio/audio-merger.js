/**
 * audio-merger.js — Outil « Fusionneur Audio » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Fichiers audio multiples (glisser-déposer / sélecteur, ajout incrémental) → décodage AudioContext.decodeAudioData.
 *  2. Liste de pistes : réordonnable (glisser-déposer + boutons ↑/↓), suppression individuelle, durée / taille.
 *  3. Silence configurable (0–10 s) entre chaque piste.
 *  4. Export WAV PCM 16 bits natif (rapide) ou MP3 / OGG via FFmpeg.wasm (chargé à la demande, Worker).
 *  5. Aperçu <audio> + téléchargement ; objectURL révoqué à chaque modification / reset / unmount ;
 *     AudioContext fermé, Worker terminé au reset / unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'];
const MAX_TRACKS = 30;   // garde-fou mémoire (buffers décodés conservés)
const GAP_MAX = 10;      // silence max entre pistes (s)

/** Formats de sortie : codec FFmpeg (null = natif). */
const FORMATS = {
  wav: { ext: 'wav', mime: 'audio/wav',  codec: null,         lossy: false },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame', lossy: true },
  ogg: { ext: 'ogg', mime: 'audio/ogg',  codec: 'libvorbis',  lossy: true },
};

/* FFmpeg.wasm : mêmes versions / schéma de chargement que audio-converter. */
const FFMPEG_VERSION = '0.12.10';
const FFMPEG_CORE_VERSION = '0.12.6';
const FFMPEG_CDN = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;
const FFMPEG_CORE_CDN = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;
const FFMPEG_WORKER_FILE = '814.ffmpeg.js';

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (id) => s?.root.querySelector('#audmrg-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const yieldUi = () => new Promise((r) => setTimeout(r));
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

function fmtDuration(t) {
  const sec = Math.max(0, Number(t) || 0);
  const m = Math.floor(sec / 60);
  return `${m}:${(sec % 60).toFixed(2).padStart(5, '0')}`;
}

function isAudioFile(f) {
  return f.type.startsWith('audio/') || f.type === 'video/webm' || ACCEPT_EXT.includes(extOf(f.name));
}

const getGap = () => clamp(Number(q('gap')?.value) || 0, 0, GAP_MAX);
const totalDuration = () => s.tracks.reduce((a, t) => a + t.buffer.duration, 0) + getGap() * Math.max(0, s.tracks.length - 1);

/* ==========================================================================
   UI : statut / progression / occupation
   ========================================================================== */
/** kind : 'error' | 'ok' | undefined (neutre) — classes partagées .status-*. */
function setStatus(msg, kind) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', kind === 'error');
  el.classList.toggle('status-success', kind === 'ok');
  el.classList.toggle('status-muted', !kind);
}

/** p : 0..1 | null (indéterminé) | false (masquer). */
function setProgress(p) {
  const bar = q('bar'); if (!bar) return;
  bar.classList.toggle('is-on', p !== false);
  bar.classList.toggle('is-indeterminate', p === null);
  bar.firstElementChild.style.width = typeof p === 'number' ? Math.round(clamp(p, 0, 1) * 100) + '%' : '';
}

/** Verrouille / déverrouille les contrôles selon l'occupation (conversion ou décodage). */
function updateControls() {
  if (!s) return;
  const locked = s.busy || s.adding;
  s.root.querySelectorAll('.audmrg-panel select, .audmrg-panel input').forEach((el) => { el.disabled = locked; });
  if (!locked) syncOptions();
  q('list').classList.toggle('is-locked', locked);
  q('add').disabled = locked;
  q('reset').disabled = s.busy; // reset possible pendant un décodage (invalide le token)
  q('merge').disabled = locked || s.tracks.length < 2;
  q('cancel').hidden = !s.busy;
}

/** Débit masqué pour WAV (sans perte). */
function syncOptions() {
  q('kbps-wrap').hidden = !FORMATS[q('format').value].lossy;
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
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  q('result').hidden = false;
  setProgress(1);
  setStatus(`Fusion terminée : ${s.tracks.length} pistes, ${fmtDuration(totalDuration())}, ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Audio : contexte, ajout de pistes
   ========================================================================== */
function ensureAC() {
  if (!s.ac || s.ac.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('AudioContext non pris en charge par ce navigateur');
    s.ac = new AC();
  }
  return s.ac;
}

function closeAC() {
  if (!s) return;
  const ac = s.ac;
  s.ac = null;
  if (ac && ac.state !== 'closed') ac.close().catch(() => { /* déjà fermé */ });
}

/** Libère tout l'état (pistes, résultat, conversion, AudioContext) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.loading++;
  s.adding = false;
  s.abort?.abort(); s.abort = null;
  clearResult();
  closeAC();
  s.tracks = [];
  q('file').value = '';
  s.busy = false;
  render();
  setProgress(false);
}

async function addFiles(fileList) {
  if (!s || s.busy || s.adding) return;
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const st = s, token = ++s.loading;
  const valid = files.filter(isAudioFile);
  let skipped = files.length - valid.length, failed = 0, capped = 0;

  st.adding = true; updateControls();
  clearResult();
  let ac;
  try { ac = ensureAC(); } catch (e) { st.adding = false; updateControls(); setStatus(e.message, 'error'); return; }

  for (let i = 0; i < valid.length; i++) {
    if (st.tracks.length >= MAX_TRACKS) { capped = valid.length - i; break; }
    const f = valid[i];
    setStatus(`Décodage ${i + 1}/${valid.length} : « ${f.name} »…`); setProgress(null);
    try {
      const buffer = await ac.decodeAudioData(await f.arrayBuffer());
      if (s !== st || st.loading !== token) return; // reset / unmount entre-temps
      if (!(buffer.duration > 0)) throw new Error('durée nulle');
      st.tracks.push({ id: ++st.seq, name: f.name, size: f.size, buffer });
      render();
    } catch {
      if (s !== st || st.loading !== token) return;
      failed++;
    }
  }
  if (s !== st || st.loading !== token) return;
  st.adding = false;
  setProgress(false);
  render();

  const notes = [];
  if (skipped) notes.push(`${skipped} fichier(s) ignoré(s) (format non pris en charge)`);
  if (failed) notes.push(`${failed} non décodable(s)`);
  if (capped) notes.push(`${capped} ignoré(s) (limite de ${MAX_TRACKS} pistes)`);
  if (notes.length) setStatus(notes.join(' · ') + '.', 'error');
  else if (st.tracks.length < 2) setStatus('Ajoutez au moins une autre piste pour fusionner.');
  else setStatus(`${st.tracks.length} pistes prêtes. Réorganisez-les puis fusionnez.`);
}

/* ==========================================================================
   Liste de pistes : rendu, réorganisation, suppression
   ========================================================================== */
function trackItem(t, i, n) {
  const li = document.createElement('li');
  li.className = 'audmrg-track';
  li.draggable = true;
  li.dataset.i = String(i);

  const grip = document.createElement('span');
  grip.className = 'audmrg-grip'; grip.textContent = '⋮⋮'; grip.setAttribute('aria-hidden', 'true');
  const idx = document.createElement('span');
  idx.className = 'audmrg-idx'; idx.textContent = String(i + 1);

  const info = document.createElement('div');
  info.className = 'audmrg-info';
  const nm = document.createElement('span');
  nm.className = 'audmrg-tname'; nm.textContent = t.name; nm.title = t.name;
  const mt = document.createElement('small');
  mt.className = 'audmrg-tmeta';
  mt.textContent = `${fmtDuration(t.buffer.duration)} · ${fmtMB(t.size)}`;
  info.append(nm, mt);

  const btns = document.createElement('div');
  btns.className = 'audmrg-btns';
  const mk = (act, label, icon, disabled, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn ' + cls; b.dataset.act = act;
    b.setAttribute('aria-label', label); b.title = label; b.disabled = disabled;
    b.innerHTML = `<i data-lucide="${icon}"></i>`;
    return b;
  };
  btns.append(
    mk('up', 'Monter', 'arrow-up', i === 0),
    mk('down', 'Descendre', 'arrow-down', i === n - 1),
    mk('del', 'Retirer', 'x', false, 'is-danger'),
  );

  li.append(grip, idx, info, btns);
  return li;
}

function render() {
  if (!s) return;
  const n = s.tracks.length;
  q('drop').hidden = n > 0;
  q('editor').hidden = n === 0;
  const list = q('list');
  list.replaceChildren(...s.tracks.map((t, i) => trackItem(t, i, n)));
  q('count').textContent = `${n} piste${n > 1 ? 's' : ''}`;
  q('summary').textContent = n ? `Durée totale : ${fmtDuration(totalDuration())} (silences inclus)` : '';
  q('gap-val').textContent = getGap().toFixed(1) + ' s';
  updateControls();
  icons();
}

function onTracksChanged() {
  clearResult();
  render();
  if (s.tracks.length < 2) setStatus(s.tracks.length ? 'Ajoutez au moins une autre piste pour fusionner.' : 'Déposez des fichiers audio pour commencer.');
}

function moveTrack(from, to) {
  if (from === to || from < 0 || to < 0 || from >= s.tracks.length || to >= s.tracks.length) return;
  const [t] = s.tracks.splice(from, 1);
  s.tracks.splice(to, 0, t);
  onTracksChanged();
}

function removeTrack(i) {
  s.tracks.splice(i, 1);
  onTracksChanged();
}

function onListClick(e) {
  if (!s || s.busy || s.adding) return;
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const i = Number(btn.closest('.audmrg-track')?.dataset.i);
  if (!Number.isInteger(i)) return;
  if (btn.dataset.act === 'up') moveTrack(i, i - 1);
  else if (btn.dataset.act === 'down') moveTrack(i, i + 1);
  else if (btn.dataset.act === 'del') removeTrack(i);
}

/* ---------- Glisser-déposer interne (réordonnancement) ---------- */
function clearTargets() { q('list').querySelectorAll('.is-target').forEach((el) => el.classList.remove('is-target')); }

function onDragStart(e) {
  const li = e.target.closest?.('.audmrg-track');
  if (!li || s.busy || s.adding) { e.preventDefault(); return; }
  s.dragIdx = Number(li.dataset.i);
  li.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(s.dragIdx)); } catch { /* ignoré */ }
}

function onDragOver(e) {
  if (s.dragIdx == null) return; // glisser de fichiers : géré par la racine
  e.preventDefault();
  e.stopPropagation();
  clearTargets();
  e.target.closest?.('.audmrg-track')?.classList.add('is-target');
}

function onDrop(e) {
  if (s.dragIdx == null) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest?.('.audmrg-track');
  const from = s.dragIdx;
  endDrag();
  if (li) moveTrack(from, Number(li.dataset.i));
}

function endDrag() {
  if (!s) return;
  s.dragIdx = null;
  q('list').querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
  clearTargets();
}

/* ==========================================================================
   Fusion native : WAV PCM 16 bits (pistes + silences)
   ========================================================================== */
async function mergeWav(signal, onProgress) {
  const tracks = s.tracks;
  const rate = tracks[0].buffer.sampleRate;
  const ch = Math.max(...tracks.map((t) => t.buffer.numberOfChannels));
  const gapFrames = Math.round(getGap() * rate);
  const total = tracks.reduce((a, t) => a + t.buffer.length, 0) + gapFrames * (tracks.length - 1);
  const bytes = total * ch * 2;
  if (bytes > 0xFFFFFFFF - 36) throw new Error('fusion trop longue pour le format WAV (> 4 Go)');

  let dv;
  try { dv = new DataView(new ArrayBuffer(44 + bytes)); } // zéro-initialisé → silences gratuits
  catch { throw new Error('mémoire insuffisante pour cette fusion'); }
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, bytes, true);

  let o = 44, done = 0;
  for (let k = 0; k < tracks.length; k++) {
    const buf = tracks[k].buffer, tch = buf.numberOfChannels, n = buf.length;
    const data = Array.from({ length: tch }, (_, c) => buf.getChannelData(c));
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const x = clamp(data[Math.min(c, tch - 1)][i], -1, 1); // mono → duplique sur les canaux manquants
        dv.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
        o += 2;
      }
      if (++done % 262144 === 0) { // rend la main + annulation + progression
        if (signal.aborted) throw abortErr();
        onProgress(done / total);
        await yieldUi();
      }
    }
    o += gapFrames * ch * 2 * (k < tracks.length - 1 ? 1 : 0); // silence : octets déjà à zéro
    done += k < tracks.length - 1 ? gapFrames : 0;
  }
  return new Blob([dv], { type: FORMATS.wav.mime });
}

/* ==========================================================================
   FFmpeg.wasm (lazy) : WAV fusionné → MP3 / OGG
   ========================================================================== */
function wasmSupported() {
  try {
    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') return false;
    return new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)) instanceof WebAssembly.Module;
  } catch { return false; }
}

let ffmpegLibPromise = null;
/** Injecte le script UMD de FFmpeg une seule fois. */
function loadFfmpegLib() {
  if (window.FFmpegWASM?.FFmpeg) return Promise.resolve(window.FFmpegWASM.FFmpeg);
  ffmpegLibPromise ??= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = `${FFMPEG_CDN}/ffmpeg.js`;
    sc.async = true;
    sc.onload = () => (window.FFmpegWASM?.FFmpeg ? resolve(window.FFmpegWASM.FFmpeg) : reject(new Error('FFmpeg UMD introuvable')));
    sc.onerror = () => { ffmpegLibPromise = null; sc.remove(); reject(new Error('chargement CDN impossible')); };
    document.head.appendChild(sc);
  });
  return ffmpegLibPromise;
}

/** Ressource CDN → blob: URL (ajoutée à `bag` pour révocation). */
async function cdnBlobUrl(url, mime, signal, bag, onProgress) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url.split('/').pop()})`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress && total) onProgress(Math.min(1, got / total));
  }
  const u = URL.createObjectURL(new Blob(chunks, { type: mime }));
  bag.push(u);
  return u;
}

/** Progression : 0.2–0.35 chargement FFmpeg, 0.35–1 encodage. */
async function encodeFfmpeg(wav, fmt, kbps, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.2);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const outName = 'out.' + fmt.ext;
  let ffmpeg = null, onAbort = null, lastLog = '';
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(0.2 + p * 0.15); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

    ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => { lastLog = message; });
    onAbort = () => { try { ffmpeg.terminate(); } catch { /* déjà fermé */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL: workerURL });
    if (signal.aborted) throw abortErr();

    await ffmpeg.writeFile('in.wav', new Uint8Array(await wav.arrayBuffer()));
    ffmpeg.on('progress', ({ progress }) => setProgress(0.35 + 0.65 * clamp(Number(progress) || 0, 0, 1)));
    setStatus(`Encodage ${fmt.ext.toUpperCase()} ${kbps} kbit/s (FFmpeg)…`); setProgress(0.35);
    const code = await ffmpeg.exec(['-i', 'in.wav', '-vn', '-c:a', fmt.codec, '-b:a', `${kbps}k`, outName]);
    if (code !== 0) throw new Error(`FFmpeg code ${code}${lastLog ? ' — ' + lastLog : ''}`);
    return new Blob([await ffmpeg.readFile(outName)], { type: fmt.mime });
  } catch (e) {
    if (signal.aborted) throw abortErr();
    throw e;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (ffmpeg) {
      if (!signal.aborted) for (const f of ['in.wav', outName]) { try { await ffmpeg.deleteFile(f); } catch { /* absent */ } }
      try { ffmpeg.terminate(); } catch { /* déjà fermé */ } // ferme Worker + libère la mémoire wasm
    }
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function merge() {
  if (!s || s.busy || s.adding || s.tracks.length < 2) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value];
  const kbps = Number(q('kbps').value) || 192;
  st.busy = true; updateControls(); setProgress(0);

  try {
    setStatus('Assemblage des pistes…');
    const wav = await mergeWav(signal, (p) => setProgress(p * (fmt.codec ? 0.2 : 1)));
    if (s !== st) return;
    let blob = wav;
    if (fmt.codec) {
      try { blob = await encodeFfmpeg(wav, fmt, kbps, signal); }
      catch (e) {
        if (isAbort(e)) throw e;
        throw new Error(`Export ${fmt.ext.toUpperCase()} impossible (${e.message}). L'export WAV reste disponible (natif, sans FFmpeg).`);
      }
    }
    if (s !== st) return;
    showResult(blob, `fusion_audio.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Fusion annulée.');
    else setStatus(e.message || 'Erreur inconnue', 'error');
  } finally {
    if (s === st) { st.abort = null; st.busy = false; updateControls(); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="audmrg" id="audmrg-root">
  <div class="audmrg-drop" id="audmrg-drop" tabindex="0" role="button" aria-label="Choisir ou déposer des fichiers audio">
    <i data-lucide="merge" class="icon-xl"></i>
    <strong>Glissez vos fichiers audio ici</strong>
    <small>ou cliquez pour parcourir — MP3, WAV, OGG, M4A, AAC, FLAC, WEBM (plusieurs fichiers)</small>
  </div>
  <input type="file" id="audmrg-file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm" multiple hidden>

  <div class="audmrg-editor" id="audmrg-editor" hidden>
    <div class="audmrg-head">
      <span class="audmrg-count" id="audmrg-count"></span>
      <div class="audmrg-actions">
        <button class="btn-secondary" id="audmrg-add" type="button"><i data-lucide="plus"></i> Ajouter des pistes</button>
        <button class="btn-remove-file" id="audmrg-reset" type="button"><i data-lucide="x"></i> Tout effacer</button>
      </div>
    </div>

    <ul class="audmrg-list" id="audmrg-list" aria-label="Pistes à fusionner (glissez pour réordonner)"></ul>
    <small class="audmrg-summary" id="audmrg-summary"></small>

    <div class="audmrg-panel">
      <label class="audmrg-field">Silence entre les pistes <span class="audmrg-val" id="audmrg-gap-val">0.0 s</span>
        <input type="range" id="audmrg-gap" min="0" max="${GAP_MAX}" step="0.1" value="0">
      </label>
      <label class="audmrg-field">Format de sortie
        <select id="audmrg-format">
          <option value="wav" selected>WAV (PCM 16 bits — natif, rapide)</option>
          <option value="mp3">MP3 (FFmpeg.wasm)</option>
          <option value="ogg">OGG Vorbis (FFmpeg.wasm)</option>
        </select>
      </label>
      <label class="audmrg-field" id="audmrg-kbps-wrap" hidden>Débit
        <select id="audmrg-kbps">
          <option value="128">128 kbit/s</option>
          <option value="192" selected>192 kbit/s</option>
          <option value="256">256 kbit/s</option>
          <option value="320">320 kbit/s</option>
        </select>
      </label>
    </div>
  </div>

  <div>
    <div class="audmrg-bar" id="audmrg-bar"><i></i></div>
    <p class="audmrg-status status-muted" id="audmrg-status">Déposez des fichiers audio pour commencer.</p>
  </div>

  <div class="audmrg-actions">
    <button class="btn-primary" id="audmrg-merge" type="button"><i data-lucide="merge"></i> Fusionner</button>
    <button class="btn-secondary" id="audmrg-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="audmrg-result" id="audmrg-result" hidden>
    <audio class="audmrg-audio" id="audmrg-audio" controls preload="metadata"></audio>
    <a class="btn-primary audmrg-link" id="audmrg-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, ac: null, tracks: [], seq: 0, dragIdx: null,
    objectUrl: null, abort: null, busy: false, adding: false, loading: 0,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root'), drop = q('drop'), file = q('file'), list = q('list'), editor = q('editor');

  // Zone de dépôt + sélecteur (ajout incrémental)
  const pick = () => { if (!s.busy && !s.adding) file.click(); };
  drop.addEventListener('click', pick, opt);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }, opt);
  q('add').addEventListener('click', pick, opt);
  file.addEventListener('change', () => { addFiles(file.files); file.value = ''; }, opt);

  // Dépôt de fichiers n'importe où (les glissers internes sont ignorés : types ≠ Files)
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  root.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); drop.classList.add('is-over'); editor.classList.add('is-over');
  }, opt);
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) { drop.classList.remove('is-over'); editor.classList.remove('is-over'); }
  }, opt);
  root.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); drop.classList.remove('is-over'); editor.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  }, opt);

  // Liste : boutons + réordonnancement par glisser-déposer
  list.addEventListener('click', onListClick, opt);
  list.addEventListener('dragstart', onDragStart, opt);
  list.addEventListener('dragover', onDragOver, opt);
  list.addEventListener('drop', onDrop, opt);
  list.addEventListener('dragend', endDrag, opt);

  // Options : tout changement invalide le résultat précédent
  q('gap').addEventListener('input', () => { clearResult(); q('gap-val').textContent = getGap().toFixed(1) + ' s'; render(); }, opt);
  q('format').addEventListener('change', () => { syncOptions(); clearResult(); }, opt);
  q('kbps').addEventListener('change', clearResult, opt);

  // Fusion / annulation / reset
  q('merge').addEventListener('click', merge, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => {
    discard();
    setStatus('Déposez des fichiers audio pour commencer.');
  }, opt);

  render();
}

export function unmount() {
  if (!s) return;
  s.loading++;                 // invalide un décodage en cours
  s.abort?.abort();            // stoppe fusion / chargement FFmpeg (terminate Worker)
  clearResult();               // pause <audio> + URL.revokeObjectURL
  closeAC();                   // ferme l'AudioContext
  s.tracks = [];               // libère les AudioBuffer décodés
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
