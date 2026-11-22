/**
 * video-merger.js — Outil « Fusionneur de Vidéos » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Clips multiples (glisser-déposer / « Ajouter des vidéos », minimum 2) → liste ordonnée :
 *     durée, résolution, taille, réordonnancement (boutons ↑ ↓ + glisser), suppression, totaux.
 *  2. Options : résolution cible (Auto = 1er clip, 1080p / 720p / 480p 16:9, 720p 9:16) + format (MP4 H.264 / WEBM VP8).
 *  3. Fusion : FFmpeg.wasm chargé à la demande (Worker en blob: URL, repli cœur ESM Firefox).
 *     Chaque clip est normalisé (scale + letterbox pad, dimensions paires, setsar=1, 30 fps) ;
 *     un silence (anullsrc) est injecté pour les clips sans piste audio → le filtre concat ne échoue jamais.
 *  4. Progression temps réel, bouton Annuler (terminate du Worker), aperçu <video controls>,
 *     téléchargement fusion_video.<ext> ; Worker / objectURL libérés à chaque nouvelle fusion, reset et unmount.
 */

/* ---------- Constantes ---------- */
const ACCEPT_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const MAX_BYTES = 700 * 1048576;   // cumul prudent : tous les clips sont copiés dans la mémoire wasm
const MAX_CLIPS = 20;
const META_TIMEOUT_MS = 8000;
const LOAD_TIMEOUT_MS = 90000;     // Worker FFmpeg bloqué (Firefox) → échec explicite au lieu d'une attente infinie
const FPS = 30;
const SAMPLE_RATE = 44100;

/** Résolutions cibles [largeur, hauteur] (paires). `auto` = dimensions du 1er clip. */
const RESOLUTIONS = {
  auto: null,
  '1080': [1920, 1080],
  '720': [1280, 720],
  '480': [854, 480],
  '720v': [720, 1280],
};
const FALLBACK_SIZE = [1280, 720];

const FORMATS = {
  mp4: {
    ext: 'mp4', mime: 'video/mp4',
    vArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    aCodecs: ['aac', 'libmp3lame'],
  },
  webm: {
    ext: 'webm', mime: 'video/webm',
    vArgs: ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-crf', '20', '-b:v', '3M'],
    aCodecs: ['libvorbis', 'libopus'],
  },
};

/* FFmpeg.wasm : mêmes versions / schéma de chargement que video-converter. */
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
const q = (id) => s?.root.querySelector('#vidmrg-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAbort = (e) => e?.name === 'AbortError';
const abortErr = () => new DOMException('Annulé', 'AbortError');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

/** Message lisible pour tout rejet : Error, string, ErrorEvent / Event de Worker (sans .message), objet. */
function errMsg(e) {
  if (e == null) return 'erreur inconnue';
  if (typeof e === 'string') return e || 'erreur inconnue';
  if (e.message) return String(e.message);
  if (e.filename) return `erreur Worker (${String(e.filename).split('/').pop()}:${e.lineno || 0})`;
  if (e.type) return `événement « ${e.type} » (Worker bloqué ou script non chargé)`;
  try { const j = JSON.stringify(e); if (j && j !== '{}') return j; } catch { /* circulaire */ }
  return String(e) || 'erreur inconnue';
}

/** Course promesse / annulation / délai ; au délai ou à l'abandon, le Worker est terminé par l'appelant. */
function raceLoad(promise, signal, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => done(reject, new Error(`délai dépassé (${Math.round(ms / 1000)} s) au chargement de FFmpeg`)), ms);
    const onAbort = () => done(reject, abortErr());
    const done = (fn, v) => { clearTimeout(t); signal.removeEventListener('abort', onAbort); fn(v); };
    if (signal.aborted) return done(reject, abortErr());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => done(resolve, v), (e) => done(reject, e instanceof Error ? e : new Error(errMsg(e))));
  });
}

function fmtDuration(t) {
  const sec = Math.max(0, Number(t) || 0);
  const m = Math.floor(sec / 60);
  return `${m}:${(sec % 60).toFixed(2).padStart(5, '0')}`;
}

function isVideoFile(f) {
  return f.type.startsWith('video/') || ACCEPT_EXT.includes(extOf(f.name));
}

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

function idleStatus() {
  const n = s.clips.length;
  if (n === 0) setStatus('Déposez au moins 2 vidéos pour commencer.');
  else if (n === 1) setStatus('Ajoutez au moins une autre vidéo (minimum 2 clips).');
  else setStatus(`${n} clips prêts. Choisissez les options puis fusionnez.`);
}

function updateButtons() {
  if (!s) return;
  const lock = s.busy || s.adding > 0;
  q('merge').disabled = lock || s.clips.length < 2;
  q('add').disabled = lock;
  q('reset').disabled = s.busy;
  q('cancel').hidden = !s.busy;
  s.root.querySelectorAll('.vidmrg-panel select').forEach((el) => { el.disabled = s.busy; });
}

function setBusy(busy) {
  if (!s) return;
  s.busy = busy;
  q('root').classList.toggle('is-busy', busy);
  q('list').querySelectorAll('.vidmrg-item').forEach((li) => { li.draggable = !busy; });
  updateButtons();
}

/* ==========================================================================
   Résultat / objectURL
   ========================================================================== */
function releaseUrl() {
  if (!s || !s.objectUrl) return;
  URL.revokeObjectURL(s.objectUrl);
  s.objectUrl = null;
}

/** Vide un élément <video> et libère sa ressource média. */
function resetVideoEl(v) {
  if (!v) return;
  v.pause();
  v.removeAttribute('src');
  v.load();
}

function clearResult() {
  releaseUrl();
  const box = q('result'); if (!box) return;
  box.hidden = true;
  resetVideoEl(q('out'));
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download'); link.textContent = '';
}

function showResult(blob, name) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  q('out').src = s.objectUrl;
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  q('result').hidden = false;
  setProgress(1);
  setStatus(`Fusion terminée : ${fmtMB(blob.size)}.`, 'ok');
}

/* ==========================================================================
   Liste des clips
   ========================================================================== */
/** Lit durée / résolution via <video> détaché (null si le navigateur ne sait pas décoder le conteneur). */
function probeMeta(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let t = 0;
    const done = (m) => {
      clearTimeout(t);
      v.onloadedmetadata = v.onerror = null;
      v.removeAttribute('src'); v.load();
      URL.revokeObjectURL(url);
      resolve(m);
    };
    t = setTimeout(() => done(null), META_TIMEOUT_MS);
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => done(v.videoWidth > 0
      ? { duration: Number.isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight }
      : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}

function clipItem(c, i, n) {
  const li = document.createElement('li');
  li.className = 'vidmrg-item';
  li.dataset.id = String(c.id);
  li.draggable = !s.busy;
  li.innerHTML = `
    <span class="vidmrg-grip" aria-hidden="true"><i data-lucide="grip-vertical"></i></span>
    <span class="vidmrg-idx">${i + 1}</span>
    <div class="vidmrg-clip"><b class="vidmrg-clip-name"></b><small class="vidmrg-clip-meta"></small></div>
    <div class="vidmrg-btns">
      <button class="icon-btn" type="button" data-act="up" aria-label="Monter" ${i === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i></button>
      <button class="icon-btn" type="button" data-act="down" aria-label="Descendre" ${i === n - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i></button>
      <button class="icon-btn vidmrg-del" type="button" data-act="del" aria-label="Retirer ce clip"><i data-lucide="x"></i></button>
    </div>`;
  li.querySelector('.vidmrg-clip-name').textContent = c.file.name;
  const m = c.meta;
  li.querySelector('.vidmrg-clip-meta').textContent =
    `${m ? fmtDuration(m.duration) : '—'} · ${m ? `${m.width} × ${m.height}` : 'résolution inconnue'} · ${fmtMB(c.file.size)}`;
  return li;
}

function render() {
  if (!s) return;
  const n = s.clips.length;
  q('editor').hidden = n === 0;
  q('drop').hidden = n > 0;
  q('list').replaceChildren(...s.clips.map((c, i) => clipItem(c, i, n)));
  q('count').textContent = `${n} clip${n > 1 ? 's' : ''}`;
  q('st-count').textContent = String(n);
  const dur = s.clips.reduce((a, c) => a + (c.meta?.duration || 0), 0);
  q('st-dur').textContent = n && dur > 0 ? fmtDuration(dur) : '—';
  q('st-size').textContent = fmtMB(s.clips.reduce((a, c) => a + c.file.size, 0));
  updateButtons();
  icons();
}

/** Toute modification de la liste invalide le résultat précédent. */
function changed() {
  clearResult();
  setProgress(false);
  render();
  idleStatus();
}

function indexOfId(id) { return s.clips.findIndex((c) => c.id === id); }

function moveBy(id, delta) {
  const i = indexOfId(id), j = i + delta;
  if (i < 0 || j < 0 || j >= s.clips.length) return;
  [s.clips[i], s.clips[j]] = [s.clips[j], s.clips[i]];
  changed();
}

/** Déplace `id` juste avant / après `targetId` (glisser-déposer). */
function moveNear(id, targetId, after) {
  if (id === targetId) return;
  const i = indexOfId(id); if (i < 0) return;
  const [clip] = s.clips.splice(i, 1);
  const t = indexOfId(targetId);
  if (t < 0) { s.clips.splice(i, 0, clip); return; }
  s.clips.splice(after ? t + 1 : t, 0, clip);
  changed();
}

function removeClip(id) {
  const i = indexOfId(id); if (i < 0) return;
  s.clips.splice(i, 1);
  changed();
}

async function addFiles(fileList) {
  if (!s || s.busy) return;
  const st = s;
  const files = [...fileList];
  if (!files.length) return;
  clearResult();
  const rejected = [];
  let total = st.clips.reduce((a, c) => a + c.file.size, 0);
  st.adding++; updateButtons();
  try {
    for (const f of files) {
      if (s !== st) return; // unmount entre-temps
      if (!isVideoFile(f)) { rejected.push(`${f.name} (format non pris en charge)`); continue; }
      if (st.clips.length >= MAX_CLIPS) { rejected.push(`${f.name} (maximum ${MAX_CLIPS} clips)`); continue; }
      if (total + f.size > MAX_BYTES) { rejected.push(`${f.name} (cumul limité à ${fmtMB(MAX_BYTES)})`); continue; }
      setStatus(`Lecture de « ${f.name} »…`); setProgress(null);
      const meta = await probeMeta(f);
      if (s !== st) return;
      st.clips.push({ id: ++st.nextId, file: f, meta });
      total += f.size;
      render();
    }
  } finally {
    if (s === st) {
      st.adding--;
      setProgress(false);
      updateButtons();
    }
  }
  if (s !== st) return;
  render();
  if (rejected.length) setStatus(`Ignoré : ${rejected.join(', ')}. Formats : MP4, WEBM, MOV, AVI, MKV.`, 'error');
  else idleStatus();
}

/** Libère tout l'état (fusion, résultat) et revient à la zone de dépôt. */
function discard() {
  if (!s) return;
  s.abort?.abort(); s.abort = null;
  clearResult();
  s.clips = [];
  q('file').value = '';
  setBusy(false);
  setProgress(false);
  render();
}

/* ==========================================================================
   Fusion FFmpeg.wasm (lazy)
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

/**
 * Variante ESM du cœur FFmpeg (Firefox) : le Worker module ne peut pas faire importScripts() ;
 * il importe donc le cœur UMD via import() et attend un `export default`.
 */
async function cdnEsmCoreUrl(signal, bag) {
  const res = await fetch(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} (ffmpeg-core.js)`);
  const src = await res.text();
  const u = URL.createObjectURL(new Blob([src, '\nexport default createFFmpegCore;\n'], { type: 'text/javascript' }));
  bag.push(u);
  return u;
}

/** Dimensions cibles (paires) : preset, ou 1er clip pour « Auto » (repli 1280×720 si métadonnées inconnues). */
function targetSize(key, firstClip) {
  const preset = RESOLUTIONS[key];
  if (preset) return preset;
  const m = firstClip?.meta;
  return m ? [even(m.width), even(m.height)] : FALLBACK_SIZE;
}

/** Graphe filter_complex : normalise chaque clip puis concatène (audio réel ou silence). */
function buildFilter(infos, [w, h]) {
  const parts = [];
  infos.forEach((c, i) => {
    parts.push(
      `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p[v${i}]`);
    if (c.hasAudio) {
      parts.push(`[${i}:a:0]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      parts.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${c.duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  const pads = infos.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${pads}concat=n=${infos.length}:v=1:a=1[v][a]`);
  return parts.join(';');
}

/** Progression : 0–0.2 chargement FFmpeg, 0.2–0.25 analyse des clips, 0.25–1 fusion. */
async function mergeFfmpeg(clips, size, fmt, signal) {
  if (!wasmSupported()) throw new Error('WebAssembly / Worker non pris en charge par ce navigateur');
  setStatus('Chargement de FFmpeg.wasm…'); setProgress(0.02);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const inNames = [];
  const outName = 'out.' + fmt.ext;
  let ffmpeg = null, onAbort = null;
  const logs = [];        // tampon roulant des logs FFmpeg
  let probe = null;       // tampon complet pendant l'analyse d'un clip
  const pushLog = (m) => { logs.push(String(m)); if (logs.length > 25) logs.shift(); probe?.push(String(m)); };
  const tail = () => (logs.length ? ' — ' + logs.slice(-6).join(' | ') : '');
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(0.02 + p * 0.18); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

    onAbort = () => { try { ffmpeg?.terminate(); } catch { /* déjà fermé */ } };
    signal.addEventListener('abort', onAbort, { once: true });

    // Tentative 1 : cœur UMD ; tentative 2 : cœur enveloppé en ESM (Worker module Firefox)
    let loaded = false, loadErr = null;
    for (const esm of [false, true]) {
      if (ffmpeg) { try { ffmpeg.terminate(); } catch { /* déjà fermé */ } ffmpeg = null; }
      try {
        const core = esm ? await cdnEsmCoreUrl(signal, blobUrls) : coreURL;
        ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => pushLog(message));
        await raceLoad(ffmpeg.load({ coreURL: core, wasmURL, classWorkerURL: workerURL }), signal, LOAD_TIMEOUT_MS);
        loaded = true;
        break;
      } catch (e) {
        if (signal.aborted) throw abortErr();
        loadErr = e;
      }
    }
    if (!loaded) throw new Error(`initialisation de FFmpeg impossible : ${errMsg(loadErr)}${tail()}`);

    // Écriture + analyse (piste audio ? durée ?) de chaque clip
    const infos = [];
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const name = `in${i}.` + (extOf(c.file.name).replace(/[^a-z0-9]/g, '') || 'bin');
      setStatus(`Analyse du clip ${i + 1}/${clips.length}…`); setProgress(0.2 + 0.05 * (i / clips.length));
      await ffmpeg.writeFile(name, new Uint8Array(await c.file.arrayBuffer()));
      inNames.push(name);
      if (signal.aborted) throw abortErr();
      probe = [];
      try { await ffmpeg.exec(['-hide_banner', '-i', name]); } catch (e) { if (signal.aborted) throw abortErr(); /* code 1 attendu (pas de sortie) */ }
      if (signal.aborted) throw abortErr();
      const txt = probe.join('\n'); probe = null;
      const hasAudio = /Stream #\d+:\d+[^\n]*: Audio:/.test(txt);
      const dm = txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const probed = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0;
      const duration = probed > 0 ? probed : (c.meta?.duration || 0);
      if (!hasAudio && !(duration > 0)) throw new Error(`durée introuvable pour « ${c.file.name} » (nécessaire pour générer le silence)`);
      infos.push({ hasAudio, duration });
    }
    const totalDur = infos.reduce((a, c) => a + c.duration, 0);

    ffmpeg.on('progress', ({ progress, time }) => {
      const byTime = totalDur > 0 && Number.isFinite(time) && time > 0 ? time / 1e6 / totalDur : NaN;
      const p = clamp(Number.isFinite(byTime) ? byTime : (Number(progress) || 0), 0, 0.99);
      setProgress(0.25 + 0.75 * p);
      setStatus(`Fusion ${fmt.ext.toUpperCase()} (FFmpeg)… ${Math.round(p * 100)} %`);
    });
    setStatus(`Fusion ${fmt.ext.toUpperCase()} (FFmpeg)…`); setProgress(0.25);

    const graph = buildFilter(infos, size);
    const base = [];
    inNames.forEach((n) => base.push('-i', n));
    base.push('-filter_complex', graph, '-map', '[v]', '-map', '[a]', ...fmt.vArgs);

    // Codecs audio testés dans l'ordre (repli automatique)
    let code = -1;
    for (const ac of fmt.aCodecs) {
      logs.length = 0;
      code = await ffmpeg.exec([...base, '-c:a', ac, '-b:a', '128k', '-ac', '2', '-ar', String(SAMPLE_RATE), outName]);
      if (signal.aborted) throw abortErr();
      if (code === 0) break;
    }
    if (code !== 0) throw new Error(`FFmpeg code ${code}${tail()}`);
    const data = await ffmpeg.readFile(outName);
    if (!data?.length) throw new Error('fichier de sortie vide');
    return new Blob([data], { type: fmt.mime });
  } catch (e) {
    if (signal.aborted) throw abortErr();
    throw e instanceof Error ? e : new Error(errMsg(e));
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (ffmpeg) {
      if (!signal.aborted) for (const f of [...inNames, outName]) { try { await ffmpeg.deleteFile(f); } catch { /* absent */ } }
      try { ffmpeg.terminate(); } catch { /* déjà fermé */ } // ferme Worker + libère la mémoire wasm
    }
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function merge() {
  if (!s || s.busy || s.adding > 0 || s.clips.length < 2) return;
  const st = s;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  const fmt = FORMATS[q('format').value];
  const clips = st.clips.slice();
  const size = targetSize(q('res').value, clips[0]);
  setBusy(true); setProgress(0);

  try {
    const blob = await mergeFfmpeg(clips, size, fmt, signal);
    if (s !== st) return;
    showResult(blob, `fusion_video.${fmt.ext}`);
  } catch (e) {
    if (s !== st) return;
    setProgress(false);
    if (isAbort(e)) setStatus('Fusion annulée.');
    else setStatus(`Fusion ${fmt.ext.toUpperCase()} impossible (${errMsg(e)}).`, 'error');
  } finally {
    if (s === st) { st.abort = null; setBusy(false); }
  }
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
const TEMPLATE = `
<div class="vidmrg" id="vidmrg-root">
  <div class="vidmrg-drop" id="vidmrg-drop" tabindex="0" role="button" aria-label="Choisir ou déposer des fichiers vidéo">
    <i data-lucide="combine" class="icon-xl"></i>
    <strong>Glissez vos vidéos ici</strong>
    <small>ou cliquez pour parcourir — MP4, WEBM, MOV, AVI, MKV (minimum 2 clips)</small>
  </div>
  <input type="file" id="vidmrg-file" accept="video/*,.mp4,.webm,.mov,.avi,.mkv" multiple hidden>

  <div class="vidmrg-editor" id="vidmrg-editor" hidden>
    <div class="vidmrg-head">
      <b class="vidmrg-count" id="vidmrg-count"></b>
      <div class="vidmrg-head-btns">
        <button class="btn-secondary" id="vidmrg-add" type="button"><i data-lucide="plus"></i> Ajouter des vidéos</button>
        <button class="btn-remove-file" id="vidmrg-reset" type="button"><i data-lucide="x"></i> Tout effacer</button>
      </div>
    </div>

    <ol class="vidmrg-list" id="vidmrg-list"></ol>

    <div class="vidmrg-info">
      <div class="vidmrg-stat"><small>Clips</small><b id="vidmrg-st-count">0</b></div>
      <div class="vidmrg-stat"><small>Durée totale</small><b id="vidmrg-st-dur">—</b></div>
      <div class="vidmrg-stat"><small>Taille totale</small><b id="vidmrg-st-size">—</b></div>
    </div>

    <div class="vidmrg-panel">
      <label class="vidmrg-field">Résolution cible
        <select id="vidmrg-res">
          <option value="auto" selected>Auto (1er clip)</option>
          <option value="1080">1080p 16:9 (1920 × 1080)</option>
          <option value="720">720p 16:9 (1280 × 720)</option>
          <option value="480">480p 16:9 (854 × 480)</option>
          <option value="720v">720p 9:16 vertical (720 × 1280)</option>
        </select>
      </label>
      <label class="vidmrg-field">Format de sortie
        <select id="vidmrg-format">
          <option value="mp4" selected>MP4 (H.264 + AAC)</option>
          <option value="webm">WEBM (VP8 + Vorbis)</option>
        </select>
      </label>
    </div>
  </div>

  <div>
    <div class="vidmrg-bar" id="vidmrg-bar"><i></i></div>
    <p class="vidmrg-status status-muted" id="vidmrg-status">Déposez au moins 2 vidéos pour commencer.</p>
  </div>

  <div class="vidmrg-actions">
    <button class="btn-primary" id="vidmrg-merge" type="button"><i data-lucide="combine"></i> Fusionner</button>
    <button class="btn-secondary" id="vidmrg-cancel" type="button" hidden>Annuler</button>
  </div>

  <div class="vidmrg-result" id="vidmrg-result" hidden>
    <video class="vidmrg-out" id="vidmrg-out" controls preload="metadata" playsinline></video>
    <a class="btn-primary vidmrg-link" id="vidmrg-link"></a>
  </div>
</div>`;

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = TEMPLATE;

  s = {
    root: container, ctx, clips: [], nextId: 0,
    objectUrl: null, abort: null, busy: false, adding: 0, dragId: null,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };
  const root = q('root'), drop = q('drop'), file = q('file'), list = q('list');
  const isFileDrag = (e) => !s.dragId && e.dataTransfer?.types?.includes('Files');

  // Zone de dépôt + « Ajouter des vidéos » + sélecteur
  drop.addEventListener('click', () => file.click(), opt);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } }, opt);
  q('add').addEventListener('click', () => file.click(), opt);
  file.addEventListener('change', () => { addFiles(file.files || []); file.value = ''; }, opt);

  // Dépôt de fichiers n'importe où dans l'outil (évite la navigation du navigateur vers le fichier)
  root.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); drop.classList.add('is-over'); root.classList.add('is-over');
  }, opt);
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) { drop.classList.remove('is-over'); root.classList.remove('is-over'); }
  }, opt);
  root.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); drop.classList.remove('is-over'); root.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  }, opt);

  // Liste : boutons monter / descendre / retirer (délégation)
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || !s || s.busy) return;
    const id = Number(btn.closest('.vidmrg-item')?.dataset.id);
    if (btn.dataset.act === 'up') moveBy(id, -1);
    else if (btn.dataset.act === 'down') moveBy(id, 1);
    else if (btn.dataset.act === 'del') removeClip(id);
  }, opt);

  // Liste : glisser pour réordonner
  const clearTargets = () => list.querySelectorAll('.is-target-before, .is-target-after, .is-dragging')
    .forEach((el) => el.classList.remove('is-target-before', 'is-target-after', 'is-dragging'));
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('.vidmrg-item');
    if (!li || s.busy) { e.preventDefault(); return; }
    s.dragId = Number(li.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(s.dragId)); } catch { /* ignoré */ }
    li.classList.add('is-dragging');
  }, opt);
  list.addEventListener('dragover', (e) => {
    if (s.dragId == null) return;
    const li = e.target.closest('.vidmrg-item'); if (!li) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    list.querySelectorAll('.is-target-before, .is-target-after').forEach((el) => el.classList.remove('is-target-before', 'is-target-after'));
    if (Number(li.dataset.id) !== s.dragId) li.classList.add(after ? 'is-target-after' : 'is-target-before');
  }, opt);
  list.addEventListener('drop', (e) => {
    if (s.dragId == null) return;
    e.preventDefault(); e.stopPropagation();
    const li = e.target.closest('.vidmrg-item');
    const id = s.dragId;
    s.dragId = null; clearTargets();
    if (!li || s.busy) return;
    const r = li.getBoundingClientRect();
    moveNear(id, Number(li.dataset.id), e.clientY > r.top + r.height / 2);
  }, opt);
  list.addEventListener('dragend', () => { s.dragId = null; clearTargets(); }, opt);

  // Options : tout changement invalide le résultat précédent
  ['res', 'format'].forEach((id) => q(id).addEventListener('change', clearResult, opt));

  // Fusion / annulation / reset
  q('merge').addEventListener('click', merge, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => { discard(); idleStatus(); }, opt);

  render();
}

export function unmount() {
  if (!s) return;
  s.abort?.abort();            // stoppe fusion / chargement FFmpeg (terminate Worker)
  clearResult();               // pause <video> résultat + URL.revokeObjectURL
  s.listeners.abort();         // retire tous les écouteurs
  s.root.innerHTML = '';
  s = null;
}
