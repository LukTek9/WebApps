/**
 * sound-generator.js — Outil « Générateur de bruits & fréquences » (100 % client, Web Audio API, zéro bibliothèque).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Modes :
 *  1. Bruits ambiants : blanc, rose (filtre Paul Kellet raffiné), brun — boucle stéréo décorrélée (4 s, raccord
 *     par fondu enchaîné) ; volume lissé (setTargetAtTime) ; minuteur d'arrêt automatique.
 *  2. Fréquences : tonalité pure (sinus / carré / triangle / dent de scie, 20 Hz – 20 kHz, préréglages
 *     432 / 440 / 528 / 1000 Hz) ou battements binauraux (porteuse + écart ΔHz, oreille G / D séparées).
 *  3. Visualiseur Canvas temps réel (AnalyserNode, déclenchement sur passage à zéro) ; Lecture / Arrêt.
 *  4. Export WAV PCM 16 bits (10 s / 30 s) rendu via OfflineAudioContext (même graphe que la lecture).
 *  5. Nettoyage (arrêt / unmount) : nœuds stoppés + déconnectés, AudioContext.close(), cancelAnimationFrame,
 *     setTimeout, ResizeObserver, écouteurs retirés, URL.revokeObjectURL.
 */

/* ---------- Constantes ---------- */
const FFT_SIZE = 2048;            // fenêtre de l'AnalyserNode
const EXPORT_RATE = 44100;        // fréquence d'échantillonnage de l'export WAV
const LOOP_SECONDS = 4;           // durée de la boucle de bruit en lecture
const LOOP_FADE_S = 0.5;          // fondu enchaîné de raccord de boucle
const WARMUP = 4096;              // échantillons de chauffe des filtres (pink / brown)
const REVOKE_DELAY_MS = 2000;     // délai avant révocation de l'objectURL après clic de téléchargement
const TONE_FADE_S = 0.01;         // fondu d'entrée/sortie des exports de tonalités (anti-clic)
const FREQ_MIN = 20, FREQ_MAX = 20000;
const CARRIER_MIN = 100, CARRIER_MAX = 1000;
const BEAT_MIN = 0.5, BEAT_MAX = 50;
const SLIDER_STEPS = 1000;        // curseur de fréquence logarithmique : 0..1000

const NOISES = {
  white: { label: 'Bruit blanc', desc: 'Spectre plat : masque les sons aigus et les distractions.', file: 'blanc' },
  pink:  { label: 'Bruit rose',  desc: 'Énergie décroissante (−3 dB/octave) : proche de la pluie, du vent.', file: 'rose' },
  brown: { label: 'Bruit brun',  desc: 'Graves dominants (−6 dB/octave) : proche d\'une cascade, d\'un grondement.', file: 'brun' },
};
const WAVES = {
  sine:     { label: 'Sinus',        gain: 1 },
  square:   { label: 'Carré',        gain: 0.35 },   // compensation de sonie
  triangle: { label: 'Triangle',     gain: 0.9 },
  sawtooth: { label: 'Dent de scie', gain: 0.4 },
};
const TONE_PRESETS = [432, 440, 528, 1000];
const BANDS = {
  delta: { label: 'Delta', beat: 2,  desc: '0,5–4 Hz · sommeil profond' },
  theta: { label: 'Thêta', beat: 6,  desc: '4–8 Hz · relaxation, méditation' },
  alpha: { label: 'Alpha', beat: 10, desc: '8–13 Hz · calme, détente' },
  beta:  { label: 'Bêta',  beat: 20, desc: '13–30 Hz · concentration' },
  gamma: { label: 'Gamma', beat: 40, desc: '30 Hz et + · attention soutenue' },
};
const TIMERS = [[0, 'Désactivé'], [5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h']];
const DURATIONS = [10, 30];
const LBL_PLAY = '▶ Lecture';
const LBL_STOP = '■ Arrêt';

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (id) => s?.root.querySelector('#sndgen-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' Mo';
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const yieldUi = () => new Promise((r) => setTimeout(r));
const AudioCtx = () => window.AudioContext || window.webkitAudioContext;
const nf = (n) => (Math.round(n * 10) / 10).toLocaleString('fr-FR');

const sliderToFreq = (p) => FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, p / SLIDER_STEPS);
const freqToSlider = (f) => Math.round((Math.log(f / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN)) * SLIDER_STEPS);

function bandOf(beat) {
  if (beat < 4) return 'delta';
  if (beat < 8) return 'theta';
  if (beat < 13) return 'alpha';
  if (beat < 30) return 'beta';
  return 'gamma';
}

/** Fréquences gauche / droite des battements binauraux. */
const binauralPair = (carrier, beat) => [Math.max(1, carrier - beat / 2), carrier + beat / 2];

/** Instantané des réglages (lecture ou export). */
function snapshot() {
  return {
    mode: s.mode, sub: s.sub, noise: s.noise, wave: s.wave,
    freq: s.freq, carrier: s.carrier, beat: s.beat, vol: s.vol,
  };
}

/** Gain maître : courbe quadratique (perception) × compensation de forme d'onde. */
function targetGain(c = snapshot()) {
  const curve = Math.pow(c.vol / 100, 2) * 0.8;
  return c.mode === 'tone' && c.sub === 'pure' ? curve * WAVES[c.wave].gain : curve;
}

/** Fréquence de référence pour le déclenchement du visualiseur (0 = bruit, fenêtre complète). */
function refFreq() {
  if (s.mode === 'noise') return 0;
  return s.sub === 'binaural' ? s.carrier : s.freq;
}

/* ==========================================================================
   Synthèse de bruit
   ========================================================================== */
/** Bruit brut de n échantillons (white / pink = Paul Kellet raffiné / brown = intégration à fuite). */
function genNoise(type, n) {
  const out = new Float32Array(n);
  if (type === 'white') {
    for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * 0.5;
  } else if (type === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      out[i] = clamp((b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11, -1, 1);
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      out[i] = clamp(last * 3.5, -1, 1);
    }
  }
  return out;
}

/** Canal de bruit bouclable : les `fade` derniers échantillons sont fondus (puissance égale) sur le début. */
function loopNoise(type, len, fade) {
  const raw = genNoise(type, WARMUP + len + fade);
  const out = raw.slice(WARMUP, WARMUP + len);
  for (let i = 0; i < fade; i++) {
    const t = (i / fade) * Math.PI / 2;
    out[i] = raw[WARMUP + i] * Math.sin(t) + raw[WARMUP + len + i] * Math.cos(t);
  }
  return out;
}

/** Bruit stéréo décorrélé { L, R }. */
function makeNoiseSet(type, rate, seconds) {
  const len = Math.round(seconds * rate);
  const fade = Math.min(Math.round(LOOP_FADE_S * rate), Math.floor(len / 2));
  return { L: loopNoise(type, len, fade), R: loopNoise(type, len, fade) };
}

/** Bruit de lecture en cache (par type + fréquence d'échantillonnage). */
function liveNoise(type, rate) {
  const key = type + ':' + rate;
  if (!s.noiseCache.has(key)) s.noiseCache.set(key, makeNoiseSet(type, rate, LOOP_SECONDS));
  return s.noiseCache.get(key);
}

/* ==========================================================================
   Graphe audio (partagé lecture temps réel / export hors ligne)
   ========================================================================== */
/** Construit sources → master → dest. Retourne { master, sources, osc, oscL, oscR }. */
function buildGraph(ac, dest, c, noise) {
  const master = ac.createGain();
  master.gain.value = 0;
  master.connect(dest);
  const g = { master, sources: [], osc: null, oscL: null, oscR: null };

  if (c.mode === 'noise') {
    const buf = ac.createBuffer(2, noise.L.length, ac.sampleRate);
    buf.copyToChannel(noise.L, 0);
    buf.copyToChannel(noise.R, 1);
    const src = ac.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(master); src.start();
    g.sources.push(src);
  } else if (c.sub === 'pure') {
    const osc = ac.createOscillator();
    osc.type = c.wave; osc.frequency.value = c.freq;
    osc.connect(master); osc.start();
    g.osc = osc; g.sources.push(osc);
  } else {
    // Binaural : un oscillateur par oreille (ChannelMerger : entrée 0 = gauche, 1 = droite)
    const [fl, fr] = binauralPair(c.carrier, c.beat);
    const merger = ac.createChannelMerger(2);
    const oscL = ac.createOscillator(), oscR = ac.createOscillator();
    oscL.type = 'sine'; oscR.type = 'sine';
    oscL.frequency.value = fl; oscR.frequency.value = fr;
    oscL.connect(merger, 0, 0); oscR.connect(merger, 0, 1);
    merger.connect(master);
    oscL.start(); oscR.start();
    g.oscL = oscL; g.oscR = oscR; g.sources.push(oscL, oscR, merger);
  }
  return g;
}

/** Arrêt en fondu puis déconnexion différée du graphe. */
function killGraph(g) {
  if (!g || !s) return;
  const ac = s.ac;
  try {
    const t = ac.currentTime;
    g.master.gain.cancelScheduledValues(t);
    g.master.gain.setTargetAtTime(0, t, 0.02);
    g.sources.forEach((n) => { try { n.stop?.(t + 0.15); } catch { /* déjà arrêté */ } });
  } catch { /* contexte fermé */ }
  const id = setTimeout(() => {
    s?.killTimers.delete(id);
    try { g.master.disconnect(); } catch { /* déjà déconnecté */ }
    g.sources.forEach((n) => { try { n.disconnect(); } catch { /* déjà déconnecté */ } });
  }, 250);
  s.killTimers.add(id);
}

/** Applique les réglages courants au graphe en cours (lissage anti-clic). */
function applyParams() {
  const g = s?.graph;
  if (!g || !s.playing) return;
  const now = s.ac.currentTime, c = snapshot();
  g.master.gain.cancelScheduledValues(now);
  g.master.gain.setTargetAtTime(targetGain(c), now, 0.03);
  if (g.osc) {
    g.osc.type = c.wave;
    g.osc.frequency.setTargetAtTime(c.freq, now, 0.02);
  }
  if (g.oscL) {
    const [fl, fr] = binauralPair(c.carrier, c.beat);
    g.oscL.frequency.setTargetAtTime(fl, now, 0.02);
    g.oscR.frequency.setTargetAtTime(fr, now, 0.02);
  }
}

/** (Re)crée le graphe courant avec fondu d'entrée. */
function spawn() {
  const c = snapshot();
  const noise = c.mode === 'noise' ? liveNoise(c.noise, s.ac.sampleRate) : null;
  s.graph = buildGraph(s.ac, s.an, c, noise);
  const now = s.ac.currentTime;
  s.graph.master.gain.setTargetAtTime(targetGain(c), now, 0.05);
}

/** Reconstruit le graphe si la lecture est active (changement de mode / type de bruit / sous-mode). */
function respawn() {
  if (!s?.playing) return;
  const old = s.graph;
  spawn();
  killGraph(old);
}

/* ==========================================================================
   UI : statut / barre / lien de téléchargement
   ========================================================================== */
/** kind : 'error' | 'ok' | undefined (neutre) — classes partagées .status-*. */
function setStatus(msg, kind) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', kind === 'error');
  el.classList.toggle('status-success', kind === 'ok');
  el.classList.toggle('status-muted', !kind);
}

function setBar(on) {
  const bar = q('bar'); if (!bar) return;
  bar.classList.toggle('is-on', on);
  bar.classList.toggle('is-indeterminate', on);
}

function releaseUrl() {
  if (!s) return;
  clearTimeout(s.revokeTimer);
  if (s.objectUrl) { URL.revokeObjectURL(s.objectUrl); s.objectUrl = null; }
}

function clearResult() {
  releaseUrl();
  const box = q('download'); if (!box) return;
  box.hidden = true;
  const link = q('link');
  link.removeAttribute('href'); link.removeAttribute('download');
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
      clearResult();
      setStatus('Téléchargement lancé — mémoire libérée. Relancez l\'export pour régénérer le fichier.');
    }, REVOKE_DELAY_MS);
  };
  q('download').hidden = false;
  setStatus('Prêt : cliquez sur le lien pour enregistrer le fichier.', 'ok');
}

/** Synchronise panneaux, puces, valeurs et lecture d'état avec `s`. */
function syncUi() {
  if (!s) return;
  const r = s.root;
  r.dataset.mode = s.mode;
  r.dataset.sub = s.sub;
  r.querySelectorAll('[data-mode]').forEach((b) => {
    const on = b.dataset.mode === s.mode;
    b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on));
  });
  q('panel-noise').hidden = s.mode !== 'noise';
  q('panel-tone').hidden = s.mode !== 'tone';
  q('block-pure').hidden = s.sub !== 'pure';
  q('block-binaural').hidden = s.sub !== 'binaural';

  const press = (sel, test) => r.querySelectorAll(sel).forEach((b) => {
    const on = test(b); b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on));
  });
  press('[data-noise]', (b) => b.dataset.noise === s.noise);
  press('[data-sub]', (b) => b.dataset.sub === s.sub);
  press('[data-pf]', (b) => Number(b.dataset.pf) === Math.round(s.freq));
  press('[data-band]', (b) => b.dataset.band === bandOf(s.beat));

  q('noise-desc').textContent = NOISES[s.noise].desc;
  q('freq-val').textContent = nf(s.freq) + ' Hz';
  q('carrier-val').textContent = nf(s.carrier) + ' Hz';
  q('beat-val').textContent = 'Δ ' + nf(s.beat) + ' Hz';
  q('vol-val').textContent = s.vol + ' %';
  const [fl, fr] = binauralPair(s.carrier, s.beat);
  q('lr').textContent = `Gauche ${nf(fl)} Hz · Droite ${nf(fr)} Hz`;
  q('band-desc').textContent = `${BANDS[bandOf(s.beat)].label} — ${BANDS[bandOf(s.beat)].desc}`;

  let label;
  if (s.mode === 'noise') label = NOISES[s.noise].label;
  else if (s.sub === 'pure') label = `${WAVES[s.wave].label} ${nf(s.freq)} Hz`;
  else label = `Binaural ${nf(s.carrier)} Hz · Δ ${nf(s.beat)} Hz`;
  q('readout').textContent = label;

  r.dataset.state = s.playing ? 'playing' : 'idle';
  const play = q('play');
  play.textContent = s.playing ? LBL_STOP : LBL_PLAY;
  play.setAttribute('aria-pressed', String(s.playing));
  q('export').disabled = s.busy || !s.supported;
  q('dur').disabled = s.busy;
}

/* ==========================================================================
   Visualiseur Canvas
   ========================================================================== */
function layout() {
  const sc = q('scope'), c = q('canvas');
  if (!sc || !c) return;
  const w = Math.floor(sc.clientWidth), h = Math.floor(sc.clientHeight);
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  s.view = { w, h, dpr };
  const css = getComputedStyle(s.root);
  const col = (n) => css.getPropertyValue(n).trim() || 'currentColor';
  s.col = { bg: col('--color-surface-alt'), line: col('--color-border'), accent: col('--cat-audio') };
}

/** live=false → ligne de base ; live=true → forme d'onde (fenêtre déclenchée sur front montant). */
function draw(live) {
  if (!s?.view || !s.col) return;
  const { w, h, dpr } = s.view;
  const g = q('canvas').getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = s.col.bg; g.fillRect(0, 0, w, h);
  g.fillStyle = s.col.line; g.fillRect(0, h / 2 - 0.5, w, 1);
  if (!live || !s.data || !s.ac) return;

  const d = s.data, n = d.length, f = refFreq();
  let start = 0, span = n;
  if (f) {
    // ~3 périodes visibles, départ sur un passage à zéro montant (image stable)
    span = clamp(Math.round((s.ac.sampleRate / f) * 3), 64, n);
    for (let i = 1; i <= n - span; i++) if (d[i - 1] < 0 && d[i] >= 0) { start = i; break; }
  }
  let peak = 0;
  for (let i = start; i < start + span; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  s.peak = Math.max(peak, s.peak * 0.97);              // normalisation lissée (forme, pas niveau)
  const scale = s.peak > 1e-4 ? 0.9 / s.peak : 0;

  const mid = h / 2, amp = h / 2 - 4;
  g.strokeStyle = s.col.accent; g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const pos = (x * (span - 1)) / Math.max(1, w - 1);
    const i0 = start + Math.floor(pos), fr = pos - Math.floor(pos);
    const v = d[i0] * (1 - fr) + (d[Math.min(i0 + 1, n - 1)] * fr);
    const y = mid - clamp(v * scale, -1, 1) * amp;
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

const fmtCountdown = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function frame() {
  if (!s) return;
  if (s.an && s.data) { s.an.getFloatTimeDomainData(s.data); draw(true); }
  const t = s.endAt ? fmtCountdown(s.endAt - performance.now()) : '∞';
  const out = q('time');
  if (out && out.textContent !== t) out.textContent = t;
}

function startLoop() {
  stopLoop();
  const f = () => { if (!s) return; s.raf = requestAnimationFrame(f); frame(); };
  s.raf = requestAnimationFrame(f);
}

function stopLoop() {
  if (!s) return;
  cancelAnimationFrame(s.raf);
  s.raf = 0;
}

/* ==========================================================================
   Lecture / arrêt / minuteur
   ========================================================================== */
function clearTimer() {
  if (!s) return;
  clearTimeout(s.stopTimer);
  s.stopTimer = null; s.endAt = 0;
}

function armTimer() {
  clearTimer();
  if (!s?.playing || !s.timerMin) { if (s) { const o = q('time'); if (o) o.textContent = '∞'; } return; }
  const ms = s.timerMin * 60000;
  s.endAt = performance.now() + ms;
  s.stopTimer = setTimeout(() => stopPlay('Minuteur écoulé : lecture arrêtée.'), ms);
}

async function startPlay() {
  if (!s || s.playing || !s.supported) return;
  const st = s;
  try {
    clearTimeout(st.suspendTimer);
    if (!st.ac) {
      st.ac = new (AudioCtx())({ latencyHint: 'playback' });
      st.an = st.ac.createAnalyser();
      st.an.fftSize = FFT_SIZE;
      st.an.connect(st.ac.destination);
      st.data = new Float32Array(st.an.fftSize);
    }
    if (st.ac.state === 'suspended') await st.ac.resume();
    if (s !== st) return;                          // démonté pendant l'attente
    st.playing = true; st.peak = 0;
    spawn();
    armTimer();
    startLoop();
    syncUi();
    setStatus('Lecture en cours.', 'ok');
  } catch (e) {
    st.playing = false;
    setStatus(`Lecture impossible : ${e?.message || 'erreur audio inconnue'}.`, 'error');
    syncUi();
  }
}

function stopPlay(msg) {
  if (!s?.playing) return;
  s.playing = false;
  killGraph(s.graph); s.graph = null;
  clearTimer(); stopLoop();
  const st = s;
  st.suspendTimer = setTimeout(() => { st.ac?.suspend?.().catch(() => { /* ignoré */ }); }, 300);
  draw(false);
  const t = q('time'); if (t) t.textContent = '∞';
  syncUi();
  setStatus(msg || 'Arrêté.');
}

const togglePlay = () => (s?.playing ? stopPlay() : startPlay());

/* ==========================================================================
   Export WAV PCM 16 bits (OfflineAudioContext)
   ========================================================================== */
async function encodeWav(buf, st) {
  const ch = buf.numberOfChannels, n = buf.length, rate = buf.sampleRate;
  const bytes = n * ch * 2;
  const ab = new ArrayBuffer(44 + bytes);
  const v = new DataView(ab);
  const wr = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  wr(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  wr(36, 'data'); v.setUint32(40, bytes, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  const CHUNK = 1 << 17;
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = clamp(chans[c][i], -1, 1);
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
    if ((i & (CHUNK - 1)) === CHUNK - 1) { await yieldUi(); if (s !== st) throw new DOMException('Annulé', 'AbortError'); }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function exportName(c, dur) {
  if (c.mode === 'noise') return `bruit-${NOISES[c.noise].file}-${dur}s.wav`;
  if (c.sub === 'pure') return `${WAVES[c.wave].label.toLowerCase().replace(/\s+/g, '-')}-${Math.round(c.freq)}hz-${dur}s.wav`;
  return `binaural-${bandOf(c.beat)}-${Math.round(c.carrier)}hz-${nf(c.beat).replace(',', '.')}hz-${dur}s.wav`;
}

async function exportWav() {
  if (!s || s.busy || !s.supported) return;
  const st = s;
  if (!window.OfflineAudioContext) { setStatus('Export indisponible : OfflineAudioContext non pris en charge.', 'error'); return; }
  clearResult();
  st.busy = true; setBar(true); syncUi();
  try {
    const c = snapshot();
    const dur = Number(q('dur').value) || DURATIONS[0];
    const frames = dur * EXPORT_RATE;
    setStatus(`Synthèse de ${dur} s…`);
    await yieldUi();
    const oc = new OfflineAudioContext(2, frames, EXPORT_RATE);
    // Bruit : durée exacte + fondu enchaîné → fichier bouclable sans raccord audible
    const noise = c.mode === 'noise' ? makeNoiseSet(c.noise, EXPORT_RATE, dur) : null;
    const g = buildGraph(oc, oc.destination, c, noise);
    const tg = targetGain(c), gp = g.master.gain;
    if (c.mode === 'noise') gp.value = tg;
    else {                                          // fondus courts anti-clic aux extrémités
      gp.setValueAtTime(0, 0);
      gp.linearRampToValueAtTime(tg, TONE_FADE_S);
      gp.setValueAtTime(tg, dur - TONE_FADE_S);
      gp.linearRampToValueAtTime(0, dur);
    }
    const rendered = await oc.startRendering();
    if (s !== st) return;
    setStatus('Encodage WAV…');
    const blob = await encodeWav(rendered, st);
    if (s !== st) return;
    showBlobLink(blob, exportName(c, dur));
  } catch (e) {
    if (s === st && e?.name !== 'AbortError') setStatus(e?.message || 'Erreur d\'export inconnue.', 'error');
  } finally {
    if (s === st) { st.busy = false; setBar(false); syncUi(); }
  }
}

/* ==========================================================================
   Gestion des événements (délégation)
   ========================================================================== */
function setFreq(f, writeNum) {
  s.freq = clamp(f, FREQ_MIN, FREQ_MAX);
  q('freq').value = String(freqToSlider(s.freq));
  if (writeNum) q('freq-num').value = String(Math.round(s.freq * 10) / 10);
  clearResult(); applyParams(); syncUi();
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b || !s?.root.contains(b)) return;
  const d = b.dataset;
  if (d.mode) { s.mode = d.mode; clearResult(); respawn(); syncUi(); }
  else if (d.noise) { s.noise = d.noise; clearResult(); respawn(); syncUi(); }
  else if (d.sub) { s.sub = d.sub; clearResult(); respawn(); syncUi(); }
  else if (d.pf) setFreq(Number(d.pf), true);
  else if (d.band) {
    s.beat = BANDS[d.band].beat;
    q('beat').value = String(s.beat);
    clearResult(); applyParams(); syncUi();
  }
}

function onInput(e) {
  const id = e.target.id?.replace('sndgen-', '');
  if (!id || !s) return;
  if (id === 'freq') setFreq(sliderToFreq(Number(e.target.value)), true);
  else if (id === 'freq-num') {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) setFreq(v, false);       // le champ n'est réécrit qu'au « change »
  } else if (id === 'carrier') {
    s.carrier = clamp(Number(e.target.value), CARRIER_MIN, CARRIER_MAX); clearResult(); applyParams(); syncUi();
  } else if (id === 'beat') {
    s.beat = clamp(Number(e.target.value), BEAT_MIN, BEAT_MAX); clearResult(); applyParams(); syncUi();
  } else if (id === 'vol') {
    s.vol = clamp(Number(e.target.value), 0, 100); clearResult(); applyParams(); syncUi();
  }
}

function onChange(e) {
  const id = e.target.id?.replace('sndgen-', '');
  if (!id || !s) return;
  if (id === 'freq-num') setFreq(parseFloat(e.target.value) || s.freq, true);
  else if (id === 'wave') { s.wave = e.target.value; clearResult(); applyParams(); syncUi(); }
  else if (id === 'timer') { s.timerMin = Number(e.target.value); armTimer(); }
  else if (id === 'dur') clearResult();
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
function buildTemplate() {
  const noiseChips = Object.entries(NOISES)
    .map(([k, v]) => `<button type="button" class="sndgen-chip" data-noise="${k}" aria-pressed="false">${v.label}</button>`).join('');
  const toneChips = TONE_PRESETS
    .map((f) => `<button type="button" class="sndgen-chip" data-pf="${f}" aria-pressed="false">${f} Hz</button>`).join('');
  const bandChips = Object.entries(BANDS)
    .map(([k, v]) => `<button type="button" class="sndgen-chip" data-band="${k}" aria-pressed="false">${v.label}</button>`).join('');
  const waveOpts = Object.entries(WAVES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  const timerOpts = TIMERS.map(([m, l]) => `<option value="${m}">${l}</option>`).join('');
  const durOpts = DURATIONS.map((d) => `<option value="${d}">${d} secondes</option>`).join('');
  return `
<div class="sndgen" id="sndgen-root" data-state="idle" data-mode="noise" data-sub="pure">
  <div class="sndgen-tabs" role="tablist" aria-label="Mode du générateur">
    <button type="button" class="sndgen-tab is-active" role="tab" data-mode="noise" aria-selected="true"><i data-lucide="wind"></i> Bruits ambiants</button>
    <button type="button" class="sndgen-tab" role="tab" data-mode="tone" aria-selected="false"><i data-lucide="audio-waveform"></i> Fréquences &amp; Binaural</button>
  </div>

  <div class="sndgen-stage">
    <div class="sndgen-scope" id="sndgen-scope">
      <canvas class="sndgen-canvas" id="sndgen-canvas" role="img" aria-label="Forme d'onde du son généré en temps réel"></canvas>
    </div>
    <div class="sndgen-readrow">
      <span class="sndgen-readout" id="sndgen-readout" aria-live="polite"></span>
      <span class="sndgen-time" title="Temps restant avant l'arrêt automatique"><i data-lucide="timer"></i> <span id="sndgen-time">∞</span></span>
    </div>
    <div class="sndgen-controls">
      <button class="btn-primary sndgen-play" id="sndgen-play" type="button" aria-pressed="false">${LBL_PLAY}</button>
    </div>
  </div>

  <div class="sndgen-panel" id="sndgen-panel-noise">
    <div class="sndgen-chips" role="group" aria-label="Type de bruit">${noiseChips}</div>
    <p class="sndgen-hint" id="sndgen-noise-desc"></p>
  </div>

  <div class="sndgen-panel" id="sndgen-panel-tone" hidden>
    <div class="sndgen-chips" role="group" aria-label="Type de signal">
      <button type="button" class="sndgen-chip" data-sub="pure" aria-pressed="true">Tonalité pure</button>
      <button type="button" class="sndgen-chip" data-sub="binaural" aria-pressed="false">Battements binauraux</button>
    </div>

    <div class="sndgen-block" id="sndgen-block-pure">
      <div class="sndgen-grid">
        <label class="sndgen-field">Forme d'onde
          <select id="sndgen-wave" aria-label="Forme d'onde">${waveOpts}</select>
        </label>
        <label class="sndgen-field">Fréquence (Hz)
          <input type="number" id="sndgen-freq-num" min="${FREQ_MIN}" max="${FREQ_MAX}" step="1" value="440" inputmode="decimal">
        </label>
      </div>
      <label class="sndgen-field">Fréquence <span class="sndgen-val" id="sndgen-freq-val"></span>
        <input type="range" id="sndgen-freq" min="0" max="${SLIDER_STEPS}" step="1" value="${freqToSlider(440)}" aria-label="Fréquence, échelle logarithmique de 20 Hz à 20 000 Hz">
      </label>
      <div class="sndgen-chips" role="group" aria-label="Préréglages de fréquence">${toneChips}</div>
    </div>

    <div class="sndgen-block" id="sndgen-block-binaural" hidden>
      <label class="sndgen-field">Fréquence porteuse <span class="sndgen-val" id="sndgen-carrier-val"></span>
        <input type="range" id="sndgen-carrier" min="${CARRIER_MIN}" max="${CARRIER_MAX}" step="1" value="200" aria-label="Fréquence porteuse">
      </label>
      <label class="sndgen-field">Écart stéréo (battement) <span class="sndgen-val" id="sndgen-beat-val"></span>
        <input type="range" id="sndgen-beat" min="${BEAT_MIN}" max="${BEAT_MAX}" step="0.5" value="6" aria-label="Écart de fréquence entre les deux oreilles">
      </label>
      <div class="sndgen-chips" role="group" aria-label="Préréglages d'ondes cérébrales">${bandChips}</div>
      <p class="sndgen-hint" id="sndgen-band-desc"></p>
      <p class="sndgen-hint" id="sndgen-lr"></p>
      <p class="sndgen-note"><i data-lucide="headphones"></i> Casque stéréo obligatoire : chaque oreille doit recevoir sa propre fréquence, sinon l'effet disparaît. Usage de bien-être, sans effet thérapeutique garanti.</p>
    </div>
  </div>

  <div class="sndgen-panel sndgen-panel--row">
    <label class="sndgen-field">Volume <span class="sndgen-val" id="sndgen-vol-val"></span>
      <input type="range" id="sndgen-vol" min="0" max="100" step="1" value="40" aria-label="Volume">
    </label>
    <label class="sndgen-field">Arrêt automatique
      <select id="sndgen-timer" aria-label="Minuteur d'arrêt automatique">${timerOpts}</select>
    </label>
  </div>
  <p class="sndgen-note"><i data-lucide="triangle-alert"></i> Commencez à faible volume : les sons purs aigus ou intenses peuvent fatiguer l'audition.</p>

  <div class="sndgen-panel sndgen-panel--row">
    <label class="sndgen-field">Durée de l'échantillon
      <select id="sndgen-dur" aria-label="Durée de l'export WAV">${durOpts}</select>
    </label>
    <div class="sndgen-actions">
      <button class="btn-secondary" id="sndgen-export" type="button"><i data-lucide="download"></i> Exporter en WAV</button>
    </div>
  </div>
  <div class="sndgen-bar" id="sndgen-bar" aria-hidden="true"><i></i></div>
  <p class="sndgen-status status-muted" id="sndgen-status" role="status" aria-live="polite"></p>
  <div class="sndgen-result" id="sndgen-download" hidden>
    <a class="btn-primary sndgen-link" id="sndgen-link"></a>
  </div>
</div>`;
}

/* ==========================================================================
   API publique du module
   ========================================================================== */
export function mount(container, ctx) {
  unmount(); // sécurité : évite un double montage
  container.innerHTML = buildTemplate();

  s = {
    root: container, ctx,
    supported: Boolean(AudioCtx()),
    mode: 'noise', sub: 'pure', noise: 'pink', wave: 'sine',
    freq: 440, carrier: 200, beat: 6, vol: 40, timerMin: 0,
    playing: false, busy: false,
    ac: null, an: null, data: null, graph: null, noiseCache: new Map(),
    raf: 0, view: null, col: null, ro: null, peak: 0,
    stopTimer: null, endAt: 0, suspendTimer: null, killTimers: new Set(),
    objectUrl: null, revokeTimer: null,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };

  s.root.addEventListener('click', onClick, opt);
  s.root.addEventListener('input', onInput, opt);
  s.root.addEventListener('change', onChange, opt);
  q('play').addEventListener('click', togglePlay, opt);
  q('export').addEventListener('click', exportWav, opt);

  // Canvas responsive
  if (typeof ResizeObserver === 'function') {
    s.ro = new ResizeObserver(() => { layout(); draw(Boolean(s.playing)); });
    s.ro.observe(q('scope'));
  } else {
    window.addEventListener('resize', () => { layout(); draw(Boolean(s.playing)); }, opt);
  }

  q('wave').value = s.wave;
  q('timer').value = String(s.timerMin);
  q('freq-num').value = String(s.freq);
  layout(); draw(false);
  syncUi();
  if (s.supported) setStatus('Prêt. Choisissez un son puis cliquez sur Lecture.');
  else {
    setStatus('Web Audio API non prise en charge par ce navigateur.', 'error');
    q('play').disabled = true;
  }
  icons();
}

export function unmount() {
  if (!s) return;
  const st = s;
  st.playing = false;
  clearTimer();
  clearTimeout(st.suspendTimer);
  stopLoop();
  st.killTimers.forEach((id) => clearTimeout(id)); st.killTimers.clear();
  if (st.graph) {                                   // arrêt immédiat des sources
    st.graph.sources.forEach((n) => { try { n.stop?.(); } catch { /* déjà arrêté */ } try { n.disconnect(); } catch { /* ignoré */ } });
    try { st.graph.master.disconnect(); } catch { /* ignoré */ }
    st.graph = null;
  }
  if (st.ac && st.ac.state !== 'closed') st.ac.close().catch(() => { /* déjà fermé */ });
  st.ac = null; st.an = null; st.data = null;
  st.noiseCache.clear();
  clearResult();                                    // URL.revokeObjectURL + timer de révocation
  st.ro?.disconnect();
  st.listeners.abort();                             // retire tous les écouteurs
  st.root.innerHTML = '';
  s = null;
}
