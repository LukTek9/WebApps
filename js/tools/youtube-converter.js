/**
 * youtube-converter.js — Outil « Convertisseur YouTube » (100 % client).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Flux :
 *  1. Analyse  : cascade Cobalt → Piped → Invidious (bascule auto, 403 ignorés), métadonnées normalisées.
 *  2. Résolution : Cobalt (bascule auto) puis, en repli, flux Piped/Invidious.
 *  3. Téléchargement en Blob (progression) → transcodage local si besoin :
 *     FFmpeg.wasm (lazy, CDN épinglé, Worker) pour MP3 / WAV / M4A / fusion vidéo+audio ;
 *     repli WebAudio (WAV) ou téléchargement direct si WebAssembly indisponible.
 *  4. Lien objectURL, révoqué après clic / reset / unmount.
 */

/* ==========================================================================
   Instances de secours — À ADAPTER (les instances publiques changent souvent,
   beaucoup de Cobalt publics exigent une clé/Turnstile : privilégier une
   instance auto-hébergée avec CORS activé). Ordre = priorité.
   ========================================================================== */
export const COBALT_INSTANCES = [
  'https://c.blahaj.ca',
  'https://cobalt.api.timelessnesses.me',
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt-us.kwiatekmiki.com',
  'https://api.co.rooot.gay',
  'https://cobalt-backend.canine.tools',
  'https://dl.khyernet.xyz',
  'https://api.cobalt.tools',
  'https://co.wuk.sh',
  'https://cobalt-api.meowing.de',
  'https://nuko-c.meowing.de',
  'https://subito-c.meowing.de',
  'https://kityune.imput.net',
  'https://nachos.imput.net',
  'https://sunny.imput.net',
  'https://blossom.imput.net',
  'https://cobalt-api.ayo.tf',
  'https://api.dl.woof.monster',
  'https://cobalt.canine.tools',
];

/** Instances Piped (API /streams/:id, CORS ouvert en général). Ordre = priorité. */
export const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
];

/* Instance Cobalt personnelle (URL + clé API) saisie dans l'UI, mémorisée en localStorage.
   Les instances publiques exigent presque toutes clé API/Turnstile et YouTube les bloque. */
const LS_KEY = 'ytc-cobalt';
const custom = { url: '', key: '' };
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { return {}; } };
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* ignoré */ } };
const cobaltList = () => (custom.url ? [custom.url, ...COBALT_INSTANCES.filter((u) => u !== custom.url)] : COBALT_INSTANCES);

/** Proxies CORS de repli (API Piped / Invidious / oEmbed) : essayés dans l'ordre après échec/403 en appel direct. */
const CORS_PROXIES = ['https://corsproxy.io/?', 'https://api.allorigins.win/raw?url='];
const ANALYZE_ERROR = "Analyse impossible : aucun service (Cobalt, Piped, Invidious, oEmbed) n'a répondu pour cette vidéo. Vérifiez l'URL ou votre connexion, puis réessayez.";

export const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
  'https://invidious.privacyredirect.com',
];

const REQUEST_TIMEOUT_MS = 10000; // délai max par requête d'API (hors téléchargement)
const REVOKE_DELAY_MS = 2000;     // délai avant révocation de l'objectURL après clic

/* ---------- FFmpeg.wasm (chargé uniquement si un transcodage est requis) ----------
   Cœur MONO-thread (@ffmpeg/core) : pas de SharedArrayBuffer ni d'en-têtes COOP/COEP requis.
   Worker et cœur passés en blob: URL (un Worker cross-origin direct depuis CDN est bloqué).
   Si un nom de fichier change entre versions, ajuster ici. */
const FFMPEG_VERSION = '0.12.10';
const FFMPEG_CORE_VERSION = '0.12.6';
const FFMPEG_CDN = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;
const FFMPEG_CORE_CDN = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;
const FFMPEG_WORKER_FILE = '814.ffmpeg.js';
const FFMPEG_MAX_INPUT_BYTES = 800 * 1024 * 1024; // au-delà : mémoire wasm insuffisante → repli
const FFMPEG_JOBS = ['mp3', 'wav', 'm4a', 'merge'];

/* ---------- Catalogues format / qualité ---------- */
const FORMATS = [
  { group: 'Vidéo', items: [['video:mp4', 'MP4'], ['video:webm', 'WEBM']] },
  { group: 'Audio', items: [['audio:mp3', 'MP3'], ['audio:wav', 'WAV'], ['audio:m4a', 'M4A']] },
];
const QUALITIES = [
  [360, '360p'], [480, '480p'], [720, '720p HD'], [1080, '1080p Full HD'],
  [1440, '1440p 2K'], [2160, '2160p 4K'], [4320, '4320p 8K'],
];

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const isAbort = (e) => e?.name === 'AbortError';
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const sanitize = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
const fmtDur = (sec) => {
  sec = Number(sec) || 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
};

/** Extrait l'ID vidéo (11 car.) depuis les formes d'URL YouTube courantes. */
function parseVideoId(input) {
  try {
    const u = new URL(input.trim());
    const host = u.hostname.replace(/^www\.|^m\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'music.youtube.com') {
      id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
    }
    return /^[\w-]{11}$/.test(id ?? '') ? id : null;
  } catch { return null; }
}

/** fetch avec timeout, lié à un signal parent (annulation utilisateur). */
function fetchT(url, init = {}, parent) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  });
}

/** Essaie chaque instance à tour de rôle ; relance si échec réseau/CORS/HTTP. */
async function tryInstances(list, fn, signal, onTry) {
  const errors = [];
  for (const inst of list) {
    if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
    try {
      onTry?.(inst);
      return await fn(inst);
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
      const host = new URL(inst).hostname;
      errors.push(`${host}: ${e.name === 'AbortError' ? 'timeout' : e.message || 'échec réseau/CORS'}`);
    }
  }
  throw new Error('Toutes les instances ont échoué → ' + errors.join(' | '));
}

/* ==========================================================================
   Accès API
   ========================================================================== */

/**
 * Format info normalisé (commun Cobalt / Piped / Invidious) :
 * { id, title, author, duration, via, formatStreams[], adaptiveFormats[] }
 * Flux : { url, type (mime), qualityLabel, bitrate, contentLength } — consommé par pickInvidious().
 */

/** GET JSON avec repli automatique via proxy CORS si 403 ou échec réseau/CORS en direct. */
async function fetchApi(url, init, signal) {
  try {
    const res = await fetchT(url, init, signal);
    if (res.status !== 403) return res;
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  let lastRes = null, lastErr = new Error('proxies CORS indisponibles');
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetchT(proxy + encodeURIComponent(url), init, signal);
      if (res.ok) return res;
      lastRes = res; // proxy suivant
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  if (lastRes) return lastRes;
  throw lastErr;
}

/** oEmbed YouTube : titre + auteur, indépendant des instances (null si indisponible). */
async function fetchOembed(id, signal) {
  try {
    const res = await fetchApi(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
      { headers: { Accept: 'application/json' } }, signal);
    if (!res.ok) return null;
    const d = await res.json();
    return d?.title ? { title: d.title, author: d.author_name ?? '' } : null;
  } catch {
    if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
    return null;
  }
}

/** Étape A — Cobalt v10 : pas de métadonnées natives → simple sonde de disponibilité (titre via oEmbed). */
async function infoFromCobalt(inst, id, signal) {
  await resolveCobalt(inst, `https://www.youtube.com/watch?v=${id}`, 'video', 'mp4', 1080, signal); // lève si 403/auth/erreur
  return { id, title: `YouTube ${id}`, author: '', duration: 0, via: 'cobalt', formatStreams: [], adaptiveFormats: [] };
}

/** googlevideo.com n'envoie pas d'en-têtes CORS : fetch() en Blob impossible → lien direct. */
const isGoogleVideo = (u) => { try { return new URL(u).hostname.endsWith('googlevideo.com'); } catch { return false; } };

/** Étape 0 — InnerTube (client ANDROID) : métadonnées + flux googlevideo natifs, normalisés (schéma Invidious). */
async function infoFromInnerTube(id, signal) {
  const res = await fetchApi('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      videoId: id,
      context: { client: { clientName: 'ANDROID', clientVersion: '19.11.38', hl: 'fr', gl: 'FR' } },
    }),
  }, signal);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const d = await res.json();
  const ps = d?.playabilityStatus;
  if (ps && ps.status !== 'OK') throw new Error(ps.reason ?? ps.status);
  const v = d?.videoDetails;
  if (!v?.title) throw new Error('réponse InnerTube invalide');
  const sd = d.streamingData ?? {};
  const ok = (f) => f?.url && f.mimeType; // signatureCipher (sans url) ignoré : non déchiffrable côté client
  const norm = (f) => ({
    url: f.url, type: f.mimeType,
    qualityLabel: f.qualityLabel ?? (f.height ? f.height + 'p' : undefined),
    bitrate: f.bitrate ?? f.averageBitrate, contentLength: f.contentLength,
  });
  const formatStreams = (sd.formats ?? []).filter(ok).map(norm);       // muxé (a+v)
  const adaptiveFormats = (sd.adaptiveFormats ?? []).filter(ok).map(norm); // vidéo seule + audio seul
  if (!formatStreams.length && !adaptiveFormats.length) throw new Error('aucun flux exploitable (chiffré/protégé)');
  const thumbs = v.thumbnail?.thumbnails ?? [];
  return {
    id, title: v.title, author: v.author, duration: Number(v.lengthSeconds) || 0,
    thumb: thumbs[thumbs.length - 1]?.url ?? null, via: 'innertube', formatStreams, adaptiveFormats,
  };
}

/** Étape B — Piped : /streams/:id → normalisation vers le schéma Invidious. */
async function infoFromPiped(inst, id, signal) {
  const base = inst.replace(/\/$/, '');
  const res = await fetchApi(`${base}/streams/${id}`, { headers: { Accept: 'application/json' } }, signal);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const d = await res.json();
  if (d?.error || !d?.title) throw new Error(d?.message ?? d?.error ?? 'réponse invalide');
  const norm = (f) => ({
    url: new URL(f.url, base).href, type: f.mimeType, qualityLabel: f.quality,
    bitrate: f.bitrate, contentLength: f.contentLength,
  });
  const ok = (f) => f?.url && f.mimeType;
  const vs = (d.videoStreams ?? []).filter(ok);
  return {
    id, title: d.title, author: d.uploader, duration: d.duration, via: 'piped',
    formatStreams: vs.filter((f) => !f.videoOnly).map(norm),                                   // muxé (a+v)
    adaptiveFormats: [...vs.filter((f) => f.videoOnly), ...(d.audioStreams ?? []).filter(ok)].map(norm), // vidéo seule + audio
  };
}

/** Étape C — Invidious (urls proxifiées local=true). */
async function infoFromInvidious(inst, id, signal) {
  const base = inst.replace(/\/$/, '');
  const res = await fetchApi(
    `${base}/api/v1/videos/${id}?local=true&fields=title,author,lengthSeconds,formatStreams,adaptiveFormats`,
    { headers: { Accept: 'application/json' } }, signal);
  if (!res.ok) throw new Error('HTTP ' + res.status); // 403 → instance suivante (tryInstances)
  const d = await res.json();
  if (!d?.title) throw new Error('réponse invalide');
  const abs = (f) => ({ ...f, url: new URL(f.url, base).href });
  return {
    id, title: d.title, author: d.author, duration: d.lengthSeconds, via: 'invidious',
    formatStreams: (d.formatStreams ?? []).map(abs),
    adaptiveFormats: (d.adaptiveFormats ?? []).map(abs),
  };
}

/**
 * Flux Piped → Invidious (normalisés). Chaque étape bascule d'instance en instance
 * (403/CORS/timeout ignorés, proxy CORS en repli via fetchApi), puis passe à la suivante.
 */
async function fetchStreams(id, signal, onTry) {
  const steps = [
    [PIPED_INSTANCES, infoFromPiped],
    [INVIDIOUS_INSTANCES, infoFromInvidious],
  ];
  for (const [list, fn] of steps) {
    try {
      return await tryInstances(list, (inst) => fn(inst, id, signal), signal, onTry);
    } catch (e) {
      if (isAbort(e) && signal?.aborted) throw e;
    }
  }
  throw new Error('Aucun flux Piped/Invidious disponible.');
}

/**
 * Analyse : oEmbed (titre/auteur) + sonde Cobalt → repli flux Piped/Invidious → repli oEmbed seul
 * (les flux sont alors résolus au lancement par run()).
 */
async function fetchInfo(id, signal, onTry) {
  const meta = await fetchOembed(id, signal);
  try { // priorité n°1 : InnerTube natif
    onTry?.('https://www.youtube.com');
    return await infoFromInnerTube(id, signal);
  } catch (e) {
    if (isAbort(e) && signal?.aborted) throw e;
  }
  try {
    const info = await tryInstances(cobaltList(), (inst) => infoFromCobalt(inst, id, signal), signal, onTry);
    if (meta) Object.assign(info, meta);
    return info;
  } catch (e) {
    if (isAbort(e) && signal?.aborted) throw e;
  }
  try {
    return await fetchStreams(id, signal, onTry);
  } catch (e) {
    if (isAbort(e) && signal?.aborted) throw e;
  }
  if (meta) return { id, ...meta, duration: 0, via: 'oembed', formatStreams: [], adaptiveFormats: [] };
  throw new Error(ANALYZE_ERROR);
}

/** Résolution via une instance Cobalt (POST JSON). */
async function resolveCobalt(inst, watchUrl, kind, fmt, quality, signal) {
  // v10 : body minimal { url, videoQuality } ; options ajoutées seulement pour audio / webm
  const body = { url: watchUrl, videoQuality: String(quality) };
  if (kind === 'audio') Object.assign(body, { downloadMode: 'audio', audioFormat: fmt === 'wav' ? 'wav' : 'mp3' });
  else if (fmt === 'webm') body.youtubeVideoCodec = 'vp9';
  const res = await fetchT(inst.replace(/\/$/, '') + '/', {
    method: 'POST',
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json',
      ...(inst === custom.url && custom.key ? { Authorization: 'Api-Key ' + custom.key } : {}),
    },
    body: JSON.stringify(body),
  }, signal);
  const ext = kind === 'audio' ? (fmt === 'wav' ? 'wav' : 'mp3') : (fmt === 'webm' ? 'webm' : 'mp4');
  const host = new URL(inst).hostname;
  const d = await res.json().catch(() => null);
  if (!d?.status) throw new Error('HTTP ' + res.status);
  switch (d.status) {
    case 'tunnel':   // flux proxifié par Cobalt
    case 'redirect': // lien direct vers la source
      if (!d.url) throw new Error('URL Cobalt absente');
      return { url: d.url, filename: d.filename ?? null, ext, transcode: null, via: 'cobalt', host };
    case 'picker': {
      // audio demandé → piste audio du picker si présente ; sinon 1er fichier vidéo ; sinon 1er élément
      const it = (kind === 'audio' && d.audio ? { url: d.audio } : null)
        ?? d.picker?.find((p) => p.type === 'video')
        ?? d.picker?.[0];
      if (!it?.url) throw new Error('picker vide');
      return { url: it.url, filename: d.audioFilename && kind === 'audio' ? d.audioFilename : null, ext, transcode: null, via: 'cobalt', host };
    }
    case 'local-processing':
      throw new Error('traitement local Cobalt non pris en charge');
    case 'error':
      throw new Error(d.error?.code ?? 'erreur Cobalt');
    default:
      throw new Error('réponse inattendue');
  }
}

/**
 * Repli : sélection de flux Invidious.
 *  - audio  : m4a natif sinon transcodage FFmpeg (mp3 / wav / m4a)
 *  - vidéo  : flux adaptatifs vidéo+audio fusionnés (FFmpeg) si qualité > muxé, sinon muxé ≤720p
 *  - muxedOnly : force le flux muxé (repli sans FFmpeg)
 */
function pickInvidious(info, kind, fmt, quality, { muxedOnly = false } = {}) {
  const bitrate = (f) => parseInt(f.bitrate) || 0;
  if (kind === 'audio') {
    const audios = info.adaptiveFormats.filter((f) => f.type?.startsWith('audio/')).sort((a, b) => bitrate(b) - bitrate(a));
    if (!audios.length) throw new Error('aucun flux audio');
    const m4a = audios.find((f) => f.type.includes('audio/mp4'));
    if (fmt === 'm4a' && m4a) return { url: m4a.url, ext: 'm4a', transcode: null, via: 'invidious' };
    const best = audios[0];
    const nativeExt = best.type.includes('webm') ? 'webm' : 'm4a';
    return { url: best.url, inExt: nativeExt, nativeExt, ext: fmt, transcode: fmt, via: 'invidious' };
  }
  const mime = fmt === 'webm' ? 'video/webm' : 'video/mp4';
  const h = (f) => parseInt(f.qualityLabel) || 0;
  const muxed = info.formatStreams.filter((f) => f.type?.includes(mime));
  const bestMuxed = muxed.filter((f) => h(f) <= quality).sort((a, b) => h(b) - h(a))[0]
    ?? [...muxed].sort((a, b) => h(a) - h(b))[0];

  if (!muxedOnly) {
    const isAvc = (f) => (f.type.includes('avc1') ? 1 : 0);
    const v = info.adaptiveFormats
      .filter((f) => f.type?.includes(mime) && h(f) > 0 && h(f) <= quality)
      .sort((a, b) => h(b) - h(a) || isAvc(b) - isAvc(a))[0];
    const a = info.adaptiveFormats
      .filter((f) => f.type?.startsWith(fmt === 'webm' ? 'audio/webm' : 'audio/mp4'))
      .sort((x, y) => bitrate(y) - bitrate(x))[0];
    if (v && a && h(v) > (bestMuxed ? h(bestMuxed) : 0)) {
      return {
        url: v.url, audioUrl: a.url, inExt: fmt, inExtA: fmt === 'webm' ? 'webm' : 'm4a',
        ext: fmt, transcode: 'merge', via: 'invidious',
        size: (Number(v.contentLength) || 0) + (Number(a.contentLength) || 0),
        note: h(v) < quality ? `Qualité limitée à ${h(v)}p (repli Invidious)` : '',
      };
    }
  }
  if (!bestMuxed) throw new Error(`aucun flux ${fmt.toUpperCase()} disponible`);
  return {
    url: bestMuxed.url, ext: fmt, transcode: null, via: 'invidious',
    note: h(bestMuxed) < quality ? `Qualité limitée à ${h(bestMuxed)}p (repli Invidious)` : '',
  };
}

/** Extension du fichier final selon le job. */
const outExt = (src) => ({ mp3: 'mp3', wav: 'wav', 'wav-webaudio': 'wav', m4a: 'm4a' }[src.transcode] ?? src.ext);

/** Bascule quand FFmpeg est indisponible/échoue : renvoie une source sans FFmpeg. */
function degrade(src, info, kind, fmt, quality, err) {
  const why = `FFmpeg indisponible (${err.message})`;
  if (src.transcode === 'merge') {
    try {
      const m = pickInvidious(info, 'video', fmt, quality, { muxedOnly: true });
      return { ...m, note: `${why} → flux muxé. ${m.note ?? ''}` };
    } catch {
      return { url: src.url, ext: fmt, transcode: null, via: src.via, note: `${why} → flux vidéo seul (sans audio)` };
    }
  }
  if (src.transcode === 'wav') return { ...src, transcode: 'wav-webaudio', note: `${why} → transcodage WebAudio` };
  return { url: src.url, ext: src.nativeExt ?? src.ext, transcode: null, via: src.via, note: `${why} → format natif .${src.nativeExt ?? src.ext}` };
}

/* ==========================================================================
   Téléchargement & transcodage local
   ========================================================================== */

/** Télécharge en Blob avec progression (p = 0..1 ou null si taille inconnue). */
async function downloadBlob(url, signal, onProgress) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(total ? got / total : null, got, total);
  }
  return new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' });
}

/** Décodage WebAudio + encodage WAV PCM 16 bits (transcodage 100 % local). */
async function toWav(blob, signal, onProgress) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { ctx.close?.(); }

  const ch = buf.numberOfChannels, len = buf.length, rate = buf.sampleRate;
  const dv = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, len * ch * 2, true);

  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, data[c][i]));
      dv.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
    if (i % 500000 === 0) { // rend la main + annulation + progression
      if (signal.aborted) throw new DOMException('Annulé', 'AbortError');
      onProgress(i / len);
      await new Promise((r) => setTimeout(r));
    }
  }
  return new Blob([dv], { type: 'audio/wav' });
}

/* ==========================================================================
   FFmpeg.wasm — chargement paresseux + exécution en Worker
   ========================================================================== */

/** WebAssembly + Worker disponibles ? */
function wasmSupported() {
  try {
    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') return false;
    return new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)) instanceof WebAssembly.Module;
  } catch { return false; }
}

let ffmpegLibPromise = null;
/** Injecte le script UMD de FFmpeg une seule fois (à la 1re demande). */
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

/** Récupère une ressource CDN → blob: URL (enregistrée dans `bag` pour révocation). */
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
 * Exécute un job FFmpeg (mp3 | wav | m4a | merge) dans un Worker.
 * Progression globale : 0–40 % téléchargement des entrées, 40–100 % transcodage.
 * Nettoyage garanti (finally) : fichiers virtuels supprimés (deleteFile = FS unlink),
 * instance terminée (terminate), blob: URL du cœur/worker révoquées.
 */
async function runFfmpegJob(src, signal) {
  const job = src.transcode;
  if (src.size && src.size > FFMPEG_MAX_INPUT_BYTES) {
    throw new Error(`flux trop volumineux (${fmtMB(src.size)})`);
  }

  setStatus('Chargement de FFmpeg.wasm…'); setProgress(null);
  const FFmpeg = await loadFfmpegLib();

  const blobUrls = [];
  const files = [];
  let ffmpeg = null;
  let onAbort = null;
  let lastLog = '';
  try {
    const workerURL = await cdnBlobUrl(`${FFMPEG_CDN}/${FFMPEG_WORKER_FILE}`, 'text/javascript', signal, blobUrls);
    const coreURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript', signal, blobUrls);
    const wasmURL = await cdnBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm', signal, blobUrls,
      (p) => { setProgress(p * 0.1); setStatus(`Chargement de FFmpeg.wasm… ${Math.round(p * 100)} %`); });

    ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => { lastLog = message; });
    onAbort = () => { try { ffmpeg.terminate(); } catch { /* déjà fermé */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL: workerURL });
    if (signal.aborted) throw new DOMException('Annulé', 'AbortError');

    // --- Entrées : téléchargement → mémoire virtuelle FFmpeg ---
    const inputs = [{ url: src.url, name: `in0.${src.inExt ?? 'bin'}` }];
    if (job === 'merge') inputs.push({ url: src.audioUrl, name: `in1.${src.inExtA ?? 'm4a'}` });
    for (const [i, inp] of inputs.entries()) {
      const blob = await downloadBlob(inp.url, signal, (p, got, total) => {
        setProgress(p == null ? null : 0.1 + ((i + p) / inputs.length) * 0.3);
        setStatus(`Téléchargement ${i + 1}/${inputs.length}… ${fmtMB(got)}${total ? ' / ' + fmtMB(total) : ''}`);
      });
      await ffmpeg.writeFile(inp.name, new Uint8Array(await blob.arrayBuffer()));
      files.push(inp.name); // la référence au Blob sort de portée ici
    }

    // --- Transcodage (Worker : l'UI reste fluide) ---
    const out = `out.${outExt(src)}`;
    files.push(out);
    const args = {
      mp3: ['-i', 'in0.' + src.inExt, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', out],
      wav: ['-i', 'in0.' + src.inExt, '-vn', '-c:a', 'pcm_s16le', out],
      m4a: ['-i', 'in0.' + src.inExt, '-vn', '-c:a', 'aac', '-b:a', '192k', out],
      merge: ['-i', inputs[0].name, '-i', inputs[1]?.name, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', out],
    }[job];
    ffmpeg.on('progress', ({ progress }) => {
      setProgress(0.4 + 0.6 * Math.min(1, Math.max(0, Number(progress) || 0)));
    });
    setStatus(job === 'merge' ? 'Fusion vidéo + audio (FFmpeg)…' : `Encodage ${out.split('.')[1].toUpperCase()} (FFmpeg)…`);
    setProgress(0.4);
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error(`FFmpeg code ${code}${lastLog ? ' — ' + lastLog : ''}`);

    const data = await ffmpeg.readFile(out);
    const mime = job === 'merge' ? (src.ext === 'webm' ? 'video/webm' : 'video/mp4')
      : { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }[job];
    return new Blob([data], { type: mime });
  } catch (e) {
    if (signal.aborted) throw new DOMException('Annulé', 'AbortError');
    throw e;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (ffmpeg) {
      if (!signal.aborted) { // instance encore vivante : purge explicite du FS virtuel
        for (const f of files) { try { await ffmpeg.deleteFile(f); } catch { /* absent */ } }
      }
      try { ffmpeg.terminate(); } catch { /* déjà fermé */ } // ferme Worker + libère la mémoire wasm
    }
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

/* ==========================================================================
   UI
   ========================================================================== */
const STYLE_ID = 'ytc-style';
const CSS = `
.ytc{display:flex;flex-direction:column;gap:var(--space-6);max-width:760px;margin-inline:auto}
.ytc-row{display:flex;gap:var(--space-3);flex-wrap:wrap}
.ytc-input,.ytc-select{flex:1;min-width:0;padding:var(--space-3) var(--space-4);border:1px solid var(--color-border);
 border-radius:var(--radius-md);background:var(--color-surface-alt);color:var(--color-text);font:inherit}
.ytc-input:focus,.ytc-select:focus{outline:2px solid var(--color-primary);outline-offset:1px}
.ytc-select:disabled{opacity:.5}
.ytc-label{display:flex;flex-direction:column;gap:var(--space-1);flex:1;min-width:180px;font-size:var(--font-size-sm);color:var(--color-text-muted)}
.ytc-btn-ghost{padding:var(--space-3) var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-md);
 background:var(--color-surface);color:var(--color-text);font-weight:var(--font-weight-medium)}
.ytc-btn-ghost:hover{border-color:var(--color-primary);color:var(--color-primary)}
.ytc-info{display:flex;gap:var(--space-4);align-items:center;padding:var(--space-4);border:1px solid var(--color-border);
 border-radius:var(--radius-md);background:var(--color-surface-alt)}
.ytc-info img{width:128px;aspect-ratio:16/9;object-fit:cover;border-radius:var(--radius-sm)}
.ytc-info b{display:block}.ytc-info small{color:var(--color-text-muted)}
.ytc-bar{height:10px;border-radius:var(--radius-pill);background:var(--color-border);overflow:hidden}
.ytc-bar>i{display:block;height:100%;width:0;background:var(--color-primary);transition:width var(--transition)}
.ytc-bar.is-indeterminate>i{width:40%;animation:ytc-slide 1.1s infinite ease-in-out}
@keyframes ytc-slide{0%{margin-left:-40%}100%{margin-left:100%}}
.ytc-status{margin:var(--space-2) 0 0;font-size:var(--font-size-sm);color:var(--color-text-muted)}
.ytc-status.is-error{color:var(--color-error)}
.ytc-result{padding:var(--space-4);border:1px dashed var(--color-success);border-radius:var(--radius-md);text-align:center}
.ytc-result a{color:var(--color-success);font-weight:var(--font-weight-bold)}
.ytc-actions{display:flex;gap:var(--space-3);flex-wrap:wrap}
.ytc-actions .btn{flex:1}
.ytc-adv{padding:var(--space-3) var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-md);display:flex;flex-direction:column;gap:var(--space-3)}
.ytc-adv summary{cursor:pointer;font-weight:var(--font-weight-medium)}
.ytc-adv small{display:block;margin-top:var(--space-2);color:var(--color-text-muted)}
@media (max-width:520px){.ytc-info{flex-direction:column;align-items:flex-start}}
`;

const TEMPLATE = `
<div class="ytc">
  <div class="ytc-row">
    <input class="ytc-input" id="ytc-url" type="url" placeholder="Collez un lien YouTube (watch, youtu.be, shorts…)" autocomplete="off">
    <button class="btn" id="ytc-analyze" type="button"><i data-lucide="search"></i> Analyser</button>
  </div>

  <div class="ytc-info" id="ytc-info" hidden>
    <img id="ytc-thumb" alt="">
    <div><b id="ytc-title"></b><small id="ytc-meta"></small></div>
  </div>

  <div class="ytc-row">
    <label class="ytc-label">Format
      <select class="ytc-select" id="ytc-format">__FORMATS__</select>
    </label>
    <label class="ytc-label">Qualité
      <select class="ytc-select" id="ytc-quality">__QUALITIES__</select>
    </label>
  </div>

  <details class="ytc-adv">
    <summary>Instance Cobalt personnelle (si les téléchargements échouent)</summary>
    <div class="ytc-row">
      <input class="ytc-input" id="ytc-cobalt-url" type="url" placeholder="https://mon-cobalt.exemple.com" autocomplete="off">
      <input class="ytc-input" id="ytc-cobalt-key" type="password" placeholder="Clé API (optionnelle)" autocomplete="off">
    </div>
    <small>Instances publiques : clé/Turnstile requis, YouTube les bloque souvent. Saisissez votre instance (CORS activé) : mémorisée dans ce navigateur.</small>
  </details>

  <div>
    <div class="ytc-bar" id="ytc-bar"><i></i></div>
    <p class="ytc-status" id="ytc-status">Collez un lien puis cliquez sur Analyser.</p>
  </div>

  <div class="ytc-actions">
    <button class="btn" id="ytc-go" type="button" disabled><i data-lucide="download"></i> Convertir et télécharger</button>
    <button class="ytc-btn-ghost" id="ytc-cancel" type="button" hidden>Annuler</button>
    <button class="ytc-btn-ghost" id="ytc-reset" type="button">Réinitialiser</button>
  </div>

  <div class="ytc-result" id="ytc-result" hidden><a id="ytc-link"></a></div>
</div>`;

const q = (id) => s?.root.querySelector('#ytc-' + id);

function setStatus(msg, isError = false) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', isError);
}

/** p : 0..1 | null (indéterminé) | undefined (masquer = 0). */
function setProgress(p) {
  const bar = q('bar'); if (!bar) return;
  bar.classList.toggle('is-indeterminate', p === null);
  bar.firstElementChild.style.width = p == null ? '' : Math.round(p * 100) + '%';
}

function setBusy(busy) {
  if (!s) return;
  s.running = busy;
  q('analyze').disabled = busy;
  q('go').disabled = busy || !s.info;
  q('cancel').hidden = !busy;
  q('url').disabled = busy;
}

/** Libère explicitement l'objectURL (mémoire navigateur). */
function releaseUrl() {
  if (!s) return;
  clearTimeout(s.revokeTimer);
  if (s.objectUrl) { URL.revokeObjectURL(s.objectUrl); s.objectUrl = null; }
}

function clearResult() {
  releaseUrl();
  const box = q('result'); if (!box) return;
  box.hidden = true;
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download'); link.removeAttribute('target');
  link.removeAttribute('rel'); link.classList.remove('btn');
  link.onclick = null; link.textContent = '';
}

function showBlobLink(blob, name) {
  releaseUrl();
  s.objectUrl = URL.createObjectURL(blob);
  const link = q('link');
  link.href = s.objectUrl;
  link.download = name;
  link.textContent = `⬇ ${name} (${fmtMB(blob.size)})`;
  link.onclick = () => {
    // Révocation après démarrage du téléchargement → mémoire libérée
    s.revokeTimer = setTimeout(() => {
      releaseUrl();
      clearResult();
      setProgress(0);
      setStatus('Téléchargement lancé — mémoire libérée. Relancez pour régénérer le fichier.');
    }, REVOKE_DELAY_MS);
  };
  q('result').hidden = false;
  setProgress(1);
  setStatus('Prêt : cliquez sur le lien pour enregistrer le fichier.');
}

/** Repli CORS : lien direct (le navigateur télécharge sans passer par fetch). `auto` : tente de déclencher le clic. */
function showDirectLink(url, name, auto = false, reason = 'restriction CORS') {
  const link = q('link');
  const isAudio = /\.(mp3|wav|m4a|ogg|opus)$/i.test(name);
  link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.setAttribute('download', name);
  link.classList.add('btn');
  link.onclick = null;
  link.textContent = isAudio ? "⬇ Télécharger directement l'audio" : '⬇ Télécharger directement la vidéo';
  q('result').hidden = false;
  setProgress(1);
  setStatus(`Flux média trouvé, récupération locale impossible (${reason}). Téléchargement direct lancé dans un nouvel onglet — sinon cliquez sur le bouton.`);
  if (auto) {
    try { link.click(); } // ouvre/télécharge via le navigateur (target=_blank + download)
    catch { setStatus(`Flux média trouvé (${reason}). Cliquez sur le bouton pour télécharger ${name}.`); }
  }
}

/* ---------- Actions ---------- */
async function analyze() {
  const id = parseVideoId(q('url').value);
  if (!id) { setStatus('URL invalide : collez un lien YouTube (watch, youtu.be, shorts, embed).', true); return; }

  reset({ keepUrl: true });
  s.abort = new AbortController();
  setBusy(true); setProgress(null);
  try {
    s.info = await fetchInfo(id, s.abort.signal, (i) => setStatus(`Analyse via ${new URL(i).hostname}…`));
    if (!s) return;
    q('thumb').src = s.info.thumb ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    q('title').textContent = s.info.title;
    q('meta').textContent = [s.info.author, s.info.duration ? fmtDur(s.info.duration) : ''].filter(Boolean).join(' · ');
    q('info').hidden = false;
    setProgress(0);
    setStatus('Analyse OK. Choisissez format/qualité puis lancez la conversion.');
  } catch (e) {
    if (!s) return;
    setProgress(0);
    if (isAbort(e)) setStatus('Analyse annulée.');
    else setStatus(ANALYZE_ERROR, true);
  } finally {
    setBusy(false);
  }
}

async function run() {
  if (!s?.info || s.running) return;
  const st = s;
  let info = s.info;
  clearResult();
  st.abort = new AbortController();
  const { signal } = st.abort;
  setBusy(true); setProgress(null);

  const [kind, fmt] = q('format').value.split(':');
  const quality = Number(q('quality').value);
  const watchUrl = `https://www.youtube.com/watch?v=${info.id}`;

  /** Flux Piped/Invidious préchargés ? (info oEmbed/Cobalt = non). */
  const hasStreams = () => info.formatStreams.length > 0 || info.adaptiveFormats.length > 0;
  /** Sinon : récupère les flux à la demande (Piped → Invidious). */
  const withStreams = async () => {
    if (hasStreams()) return info;
    setStatus('Récupération des flux (Piped/Invidious)…');
    info = st.info = await fetchStreams(info.id, signal, (i) => setStatus(`Flux : ${new URL(i).hostname}…`));
    return info;
  };
  const target = kind === 'audio' ? fmt.toUpperCase() : `${fmt.toUpperCase()} ${quality}p`;

  try {
    // Cobalt prioritaire si analyse oEmbed/Cobalt ou aucun flux préchargé ; M4A : flux natifs uniquement (Cobalt v10 sans m4a)
    const cobaltFirst = fmt !== 'm4a' && (info.via === 'oembed' || info.via === 'cobalt' || !hasStreams());
    const order = fmt === 'm4a' ? ['invidious'] : cobaltFirst ? ['cobalt', 'invidious'] : ['invidious', 'cobalt'];
    const errors = [];
    let src = null;
    for (const via of order) {
      try {
        setStatus(via === 'cobalt' ? `Résolution Cobalt (${target})…` : 'Sélection des flux (InnerTube/Piped/Invidious)…');
        src = via === 'cobalt'
          ? await tryInstances(cobaltList(), (i) => resolveCobalt(i, watchUrl, kind, fmt, quality, signal),
              signal, (i) => setStatus(`Cobalt ${new URL(i).hostname} : génération du lien ${target}…`))
          : pickInvidious(await withStreams(), kind, fmt, quality);
        break;
      } catch (e) {
        if (isAbort(e)) throw e;
        errors.push(`${via}: ${e.message}`);
      }
    }
    if (!src) {
      console.warn('[youtube-converter] sources échouées :', errors);
      const authBlock = errors.some((m) => /auth|jwt|turnstile|key|youtube/i.test(m));
      throw new Error(authBlock
        ? "Flux média bloqué : les instances Cobalt publiques exigent une clé API/Turnstile ou YouTube les bloque. Renseignez votre propre instance Cobalt (section ci-dessus)."
        : "Flux média indisponible : aucune source (Cobalt, Piped, Invidious) n'a répondu. L'URL est valide, le blocage vient des services : réessayez plus tard ou utilisez votre instance Cobalt.");
    }

    let blob = null;
    if (src.via === 'cobalt') setStatus(`Lien Cobalt obtenu (${src.host}) — téléchargement…`);

    // googlevideo sans CORS : FFmpeg ne pourrait pas récupérer les entrées → repli immédiat (flux natif/muxé)
    if (FFMPEG_JOBS.includes(src.transcode) && isGoogleVideo(src.url)) {
      src = degrade(src, info, kind, fmt, quality, new Error('googlevideo sans CORS'));
    }

    // Transcodage local FFmpeg.wasm (chargé à la demande) ; bascule propre si indisponible
    if (FFMPEG_JOBS.includes(src.transcode)) {
      try {
        setStatus(`Transcodage local requis (${src.transcode.toUpperCase()}) — préparation…`);
        if (!wasmSupported()) throw new Error('WebAssembly non pris en charge');
        blob = await runFfmpegJob(src, signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        src = degrade(src, info, kind, fmt, quality, e);
      }
    }

    const name = sanitize(src.filename ?? `${info.title}.${outExt(src)}`);

    if (!blob) {
      try {
        blob = await downloadBlob(src.url, signal, (p, got, total) => {
          setProgress(p);
          setStatus(`Téléchargement ${src.via === 'cobalt' ? 'Cobalt' : 'du flux'}… ${fmtMB(got)}${total ? ' / ' + fmtMB(total) : ''}`);
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        if (s === st) {
          const why = e instanceof TypeError ? 'blocage CORS/réseau du flux média' : (e.message || 'échec de récupération');
          showDirectLink(src.url, name, true, why);
        }
        return;
      }
      if (src.transcode === 'wav-webaudio') {
        setStatus('Transcodage WAV local (WebAudio)…'); setProgress(0);
        blob = await toWav(blob, signal, setProgress);
      }
    }
    if (s !== st) return;
    showBlobLink(blob, name);
    if (src.note) setStatus(`Prêt. ${src.note}`);
  } catch (e) {
    if (s !== st) return;
    if (isAbort(e)) { setProgress(0); setStatus('Opération annulée.'); }
    else { setProgress(0); setStatus(e.message || 'Erreur inconnue', true); }
  } finally {
    if (s === st) setBusy(false);
  }
}

/** Réinitialise l'état proprement (abort + objectURL + UI). */
function reset({ keepUrl = false } = {}) {
  if (!s) return;
  s.abort?.abort(); s.abort = null;
  clearResult();
  s.info = null;
  q('info').hidden = true;
  if (!keepUrl) q('url').value = '';
  setProgress(0);
  setBusy(false);
  q('go').disabled = true;
  setStatus('Collez un lien puis cliquez sur Analyser.');
}

function syncQuality() {
  q('quality').disabled = q('format').value.startsWith('audio:');
}

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage

  // Styles scopés (injectés une seule fois, retirés au démontage)
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }

  const fmtHtml = FORMATS.map((g) =>
    `<optgroup label="${g.group}">${g.items.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</optgroup>`).join('');
  const qHtml = QUALITIES.map(([v, l]) => `<option value="${v}"${v === 1080 ? ' selected' : ''}>${l}</option>`).join('');
  container.innerHTML = TEMPLATE.replace('__FORMATS__', fmtHtml).replace('__QUALITIES__', qHtml);

  s = { root: container, ctx, info: null, abort: null, objectUrl: null, revokeTimer: null, running: false,
        listeners: new AbortController() };
  const opt = { signal: s.listeners.signal };

  q('analyze').addEventListener('click', analyze, opt);
  q('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); }, opt);
  q('go').addEventListener('click', run, opt);
  q('cancel').addEventListener('click', () => s?.abort?.abort(), opt);
  q('reset').addEventListener('click', () => reset(), opt);
  q('format').addEventListener('change', syncQuality, opt);
  syncQuality();

  // Instance Cobalt personnelle : restauration + sauvegarde
  const saved = lsGet();
  custom.url = saved.url ?? ''; custom.key = saved.key ?? '';
  q('cobalt-url').value = custom.url; q('cobalt-key').value = custom.key;
  if (custom.url) q('cobalt-url').closest('details').open = true;
  const saveCustom = () => {
    let u = q('cobalt-url').value.trim().replace(/\/+$/, '');
    try { new URL(u); } catch { u = ''; }
    custom.url = u; custom.key = q('cobalt-key').value.trim();
    lsSet({ url: custom.url, key: custom.key });
  };
  q('cobalt-url').addEventListener('change', saveCustom, opt);
  q('cobalt-key').addEventListener('change', saveCustom, opt);
}

export function unmount() {
  if (!s) return;
  s.abort?.abort();          // stoppe requêtes / téléchargement / transcodage
  releaseUrl();              // URL.revokeObjectURL
  s.listeners.abort();       // retire tous les écouteurs
  s.root.innerHTML = '';
  document.getElementById(STYLE_ID)?.remove();
  s = null;
}
