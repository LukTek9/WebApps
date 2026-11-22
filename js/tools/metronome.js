/**
 * metronome.js — Outil « Métronome numérique » (100 % client, Web Audio API, zéro bibliothèque).
 * Contrat : export mount(container, ctx) / unmount().
 *
 * Principe :
 *  1. Planificateur à anticipation (« lookahead ») : un setTimeout court (25 ms) programme les clics
 *     des ~120 ms à venir directement sur l'horloge audio (OscillatorNode / AudioBufferSourceNode démarrés
 *     à un instant AudioContext.currentTime précis) → précision à l'échantillon, indépendante de la gigue JS.
 *     Anticipation allongée quand l'onglet est masqué (timers ralentis).
 *  2. Tempo 30–300 BPM (curseur, champ, boutons −5/−1/+1/+5, Tap Tempo moyenné) ; BPM = noires par minute.
 *     Mesures 2/4, 3/4, 4/4, 5/4, 6/8, 7/8 (temps = noire ou croche), subdivisions ×1 / ×2 / ×3 / ×4 par temps.
 *  3. LED de temps interactives : clic = Accent → Normal → Muet. Voyants synchronisés sur l'instant réellement
 *     audible (file d'événements + rAF, compensation de latence de sortie).
 *  4. Timbres synthétisés : Bois (woodblock), Bip numérique, Percussion. Volume maître lissé.
 *  5. Barre d'espace = Démarrer / Arrêter (hors champs de saisie).
 *  6. Nettoyage (arrêt / unmount) : timers, rAF, nœuds déconnectés, AudioContext.close(), écouteurs retirés.
 */

/* ---------- Constantes ---------- */
const BPM_MIN = 30, BPM_MAX = 300, BPM_DEFAULT = 100;
const SCHEDULER_MS = 25;          // période du planificateur JS
const AHEAD_VISIBLE_S = 0.12;     // anticipation onglet visible
const AHEAD_HIDDEN_S = 1.0;       // anticipation onglet masqué (timers ralentis par le navigateur)
const START_DELAY_S = 0.06;       // délai avant le premier clic
const TAP_RESET_MS = 2000;        // pause max entre deux taps
const TAP_KEEP = 8;               // nombre de taps conservés pour la moyenne
const QUEUE_MAX = 512;            // file d'événements visuels (garde-fou)
const KILL_DELAY_MS = 120;        // déconnexion différée du bus à l'arrêt

const SIGNATURES = {
  '2/4': { beats: 2, unit: 4 }, '3/4': { beats: 3, unit: 4 }, '4/4': { beats: 4, unit: 4 },
  '5/4': { beats: 5, unit: 4 }, '6/8': { beats: 6, unit: 8 }, '7/8': { beats: 7, unit: 8 },
};
const SUBDIVISIONS = [
  { v: 1, label: 'Noires (×1)' }, { v: 2, label: 'Croches (×2)' },
  { v: 3, label: 'Triolets (×3)' }, { v: 4, label: 'Doubles-croches (×4)' },
];
const TIMBRES = { wood: 'Bois (woodblock)', beep: 'Bip numérique', perc: 'Percussion' };
const LEVELS = { accent: 1, normal: 0.7, sub: 0.38 };
const NEXT_STATE = { accent: 'normal', normal: 'mute', mute: 'accent' };
const STATE_LABEL = { accent: 'accent', normal: 'normal', mute: 'muet' };
const MARKINGS = [
  [40, 'Grave'], [60, 'Largo'], [66, 'Larghetto'], [76, 'Adagio'], [108, 'Andante'],
  [120, 'Moderato'], [156, 'Allegro'], [176, 'Vivace'], [200, 'Presto'], [Infinity, 'Prestissimo'],
];
const LBL_PLAY = '▶ Démarrer';
const LBL_STOP = '■ Arrêter';

/* ---------- État du module (null quand démonté) ---------- */
let s = null;

/* ==========================================================================
   Utilitaires
   ========================================================================== */
const q = (id) => s?.root.querySelector('#metro-' + id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const icons = () => { try { window.lucide?.createIcons?.(); } catch { /* ignoré */ } };
const AudioCtx = () => window.AudioContext || window.webkitAudioContext;
const markingOf = (bpm) => MARKINGS.find(([max]) => bpm < max)[1];

/** Durée (s) d'un temps : BPM = noires/min ; en x/8 le temps est une croche. */
const beatSeconds = () => (60 / s.bpm) * (4 / SIGNATURES[s.sig].unit);

/** Gain maître : courbe quadratique (perception du volume). */
const masterGain = () => Math.pow(s.vol / 100, 2) * 0.9;

function defaultPattern(n) {
  return Array.from({ length: n }, (_, i) => (i === 0 ? 'accent' : 'normal'));
}

/* ==========================================================================
   Synthèse des clics (nœuds jetables, déconnectés à la fin)
   ========================================================================== */
function noiseBuffer(ac) {
  if (!s.noiseBuf || s.noiseBuf.sampleRate !== ac.sampleRate) {
    const len = Math.round(ac.sampleRate * 0.2);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    s.noiseBuf = buf;
  }
  return s.noiseBuf;
}

/** Enveloppe : attaque quasi instantanée puis décroissance exponentielle. */
function envelope(g, t, peak, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

/** Libère un groupe de nœuds quand la source a terminé. */
function autoRelease(src, nodes) {
  src.onended = () => nodes.forEach((n) => { try { n.disconnect(); } catch { /* déjà déconnecté */ } });
}

function oscClick(ac, dest, t, type, f0, f1, peak, dur, overtone) {
  const g = ac.createGain();
  g.connect(dest);
  envelope(g, t, peak, dur);
  const nodes = [g];
  const mk = (mult, amp) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0 * mult, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1 * mult, t + dur * 0.6);
    if (amp === 1) o.connect(g);
    else { const a = ac.createGain(); a.gain.value = amp; o.connect(a); a.connect(g); nodes.push(a); }
    o.start(t); o.stop(t + dur + 0.02);
    nodes.push(o);
    return o;
  };
  const main = mk(1, 1);
  if (overtone) mk(overtone, 0.3);
  autoRelease(main, nodes);
}

function noiseClick(ac, dest, t, hp, peak, dur) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac);
  const f = ac.createBiquadFilter();
  f.type = 'highpass'; f.frequency.value = hp;
  const g = ac.createGain();
  src.connect(f); f.connect(g); g.connect(dest);
  envelope(g, t, peak, dur);
  src.start(t); src.stop(t + dur + 0.02);
  autoRelease(src, [src, f, g]);
}

/** kind : 'accent' | 'normal' | 'sub' — joué exactement à l'instant audio `t`. */
function synth(ac, dest, t, kind) {
  const peak = LEVELS[kind];
  switch (s.timbre) {
    case 'beep': {
      const f = { accent: 1200, normal: 880, sub: 660 }[kind];
      oscClick(ac, dest, t, 'sine', f, f, peak * 0.9, 0.07, 0);
      break;
    }
    case 'perc':
      if (kind === 'accent') oscClick(ac, dest, t, 'sine', 190, 50, peak, 0.16, 0);          // fût grave
      else if (kind === 'normal') noiseClick(ac, dest, t, 6000, peak * 0.8, 0.06);            // charleston
      else noiseClick(ac, dest, t, 8500, peak * 0.8, 0.035);
      break;
    default: { // wood
      const f = { accent: 1900, normal: 1350, sub: 1050 }[kind];
      oscClick(ac, dest, t, 'sine', f, f * 0.86, peak, 0.08, 2.4);
    }
  }
}

/* ==========================================================================
   Planificateur à anticipation
   ========================================================================== */
function scheduleTick(t) {
  const level = s.pattern[s.beat] || 'normal';
  s.queue.push({ t, beat: s.beat, sub: s.sub });
  if (s.queue.length > QUEUE_MAX) s.queue.splice(0, s.queue.length - QUEUE_MAX);
  if (level === 'mute') return; // temps muet : silence complet (subdivisions incluses)
  synth(s.ac, s.bus, t, s.sub === 0 ? level : 'sub');
}

function advance() {
  const subs = s.subdiv;
  s.next += beatSeconds() / subs; // tempo relu à chaque pas → changements de BPM sans à-coup
  if (++s.sub >= subs) {
    s.sub = 0;
    s.beat = (s.beat + 1) % SIGNATURES[s.sig].beats;
  }
}

function scheduler() {
  if (!s?.playing) return;
  const ahead = document.hidden ? AHEAD_HIDDEN_S : AHEAD_VISIBLE_S;
  while (s.next < s.ac.currentTime + ahead) {
    scheduleTick(s.next);
    advance();
  }
  s.timer = setTimeout(scheduler, SCHEDULER_MS);
}

/* ==========================================================================
   Voyants synchronisés sur le son (file d'événements + rAF)
   ========================================================================== */
function setCurrent(i) {
  const box = q('beats'); if (!box) return;
  box.querySelectorAll('.metro-beat.is-current').forEach((b) => b.classList.remove('is-current'));
  if (i >= 0) box.children[i]?.classList.add('is-current');
  s.current = i;
}

function loop() {
  if (!s?.playing) return;
  s.raf = requestAnimationFrame(loop);
  const ac = s.ac;
  const now = ac.currentTime - (ac.outputLatency || ac.baseLatency || 0); // instant réellement audible
  let beat = -1;
  while (s.queue.length && s.queue[0].t <= now) {
    const ev = s.queue.shift();
    if (ev.sub === 0) beat = ev.beat;
  }
  if (beat >= 0 && beat !== s.current) setCurrent(beat);
  else if (beat >= 0) { // même LED (mesure d'un seul temps) : relance l'animation
    const el = q('beats').children[beat];
    el?.classList.remove('is-current'); void el?.offsetWidth; el?.classList.add('is-current');
  }
}

/* ==========================================================================
   Démarrage / arrêt
   ========================================================================== */
async function start() {
  if (!s || s.playing || !s.supported) return;
  const st = s;
  try {
    if (!st.ac || st.ac.state === 'closed') {
      st.ac = new (AudioCtx())({ latencyHint: 'interactive' });
      st.master = st.ac.createGain();
      st.master.gain.value = masterGain();
      st.master.connect(st.ac.destination);
    }
    if (st.ac.state === 'suspended') await st.ac.resume();
    if (s !== st) return; // démonté pendant l'attente

    st.bus = st.ac.createGain();       // bus de la session : permet de couper net les clics déjà programmés
    st.bus.connect(st.master);
    st.queue = []; st.beat = 0; st.sub = 0;
    st.next = st.ac.currentTime + START_DELAY_S;
    st.playing = true;
    scheduler();
    st.raf = requestAnimationFrame(loop);
    syncUi();
    setStatus('Métronome en marche.', 'ok');
  } catch (e) {
    st.playing = false;
    setStatus(`Démarrage impossible : ${e?.message || 'erreur audio inconnue'}.`, 'error');
    syncUi();
  }
}

function killBus(bus) {
  if (!bus || !s) return;
  const ac = s.ac;
  try {
    const t = ac.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setTargetAtTime(0, t, 0.005);
  } catch { /* contexte fermé */ }
  const id = setTimeout(() => {
    s?.killTimers.delete(id);
    try { bus.disconnect(); } catch { /* déjà déconnecté */ }
  }, KILL_DELAY_MS);
  s.killTimers.add(id);
}

function stop(msg) {
  if (!s?.playing) return;
  s.playing = false;
  clearTimeout(s.timer); s.timer = null;
  cancelAnimationFrame(s.raf); s.raf = 0;
  killBus(s.bus); s.bus = null;
  s.queue = [];
  setCurrent(-1);
  syncUi();
  setStatus(msg || 'Arrêté.');
}

const toggle = () => (s?.playing ? stop() : start());

/* ==========================================================================
   Réglages
   ========================================================================== */
function setBpm(v) {
  s.bpm = clamp(Math.round(Number(v) || BPM_DEFAULT), BPM_MIN, BPM_MAX);
  syncUi();
}

function setSignature(sig) {
  s.sig = sig;
  s.pattern = defaultPattern(SIGNATURES[sig].beats);
  s.beat = 0; s.sub = 0; // repart du temps 1 au prochain clic (le tempo reste continu)
  renderBeats();
  syncUi();
}

function cycleBeat(i) {
  s.pattern[i] = NEXT_STATE[s.pattern[i]];
  paintBeat(i);
}

/** Tap Tempo : moyenne des intervalles des derniers taps (remise à zéro après une pause). */
function tap() {
  const now = performance.now();
  if (s.taps.length && now - s.taps[s.taps.length - 1] > TAP_RESET_MS) s.taps = [];
  s.taps.push(now);
  if (s.taps.length > TAP_KEEP) s.taps.shift();
  clearTimeout(s.tapTimer);
  s.tapTimer = setTimeout(() => { if (s) { s.taps = []; q('tap-count').textContent = ''; } }, TAP_RESET_MS);
  if (s.taps.length >= 2) {
    const avg = (s.taps[s.taps.length - 1] - s.taps[0]) / (s.taps.length - 1);
    setBpm(60000 / avg);
  }
  q('tap-count').textContent = s.taps.length > 1 ? `${s.taps.length} taps` : '';
}

/* ==========================================================================
   UI
   ========================================================================== */
/** kind : 'error' | 'ok' | undefined (neutre) — classes partagées .status-*. */
function setStatus(msg, kind) {
  const el = q('status'); if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-error', kind === 'error');
  el.classList.toggle('status-success', kind === 'ok');
  el.classList.toggle('status-muted', !kind);
}

function paintBeat(i) {
  const b = q('beats')?.children[i]; if (!b) return;
  const st = s.pattern[i];
  b.classList.remove('is-accent', 'is-normal', 'is-mute');
  b.classList.add('is-' + st);
  b.setAttribute('aria-label', `Temps ${i + 1} : ${STATE_LABEL[st]} (cliquer pour changer)`);
}

function renderBeats() {
  const box = q('beats');
  const n = SIGNATURES[s.sig].beats;
  box.innerHTML = Array.from({ length: n }, (_, i) =>
    `<button type="button" class="metro-beat" data-beat="${i}"><span>${i + 1}</span></button>`).join('');
  for (let i = 0; i < n; i++) paintBeat(i);
  s.current = -1;
}

function syncUi() {
  if (!s) return;
  q('bpm-big').textContent = String(s.bpm);
  q('mark').textContent = markingOf(s.bpm);
  q('bpm').value = String(s.bpm);
  const num = q('bpm-num');
  if (document.activeElement !== num) num.value = String(s.bpm);
  s.root.querySelectorAll('[data-step]').forEach((b) => {
    const d = Number(b.dataset.step);
    b.disabled = (d < 0 && s.bpm <= BPM_MIN) || (d > 0 && s.bpm >= BPM_MAX);
  });
  q('vol-val').textContent = s.vol + ' %';
  s.root.dataset.state = s.playing ? 'playing' : 'idle';
  const play = q('play');
  play.innerHTML = s.playing ? LBL_STOP : LBL_PLAY;
  play.setAttribute('aria-pressed', String(s.playing));
}

/* ==========================================================================
   Événements
   ========================================================================== */
function onClick(e) {
  const b = e.target.closest('button');
  if (!b || !s?.root.contains(b)) return;
  if (b.dataset.step) setBpm(s.bpm + Number(b.dataset.step));
  else if (b.dataset.beat !== undefined) cycleBeat(Number(b.dataset.beat));
  else if (b.id === 'metro-tap') tap();
  else if (b.id === 'metro-play') toggle();
}

function onInput(e) {
  const id = e.target.id;
  if (id === 'metro-bpm') setBpm(e.target.value);
  else if (id === 'metro-bpm-num') {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v >= BPM_MIN && v <= BPM_MAX) setBpm(v); // valeur hors plage : corrigée au « change »
  } else if (id === 'metro-vol') {
    s.vol = clamp(Number(e.target.value), 0, 100);
    if (s.master) s.master.gain.setTargetAtTime(masterGain(), s.ac.currentTime, 0.02);
    syncUi();
  }
}

function onChange(e) {
  const id = e.target.id;
  if (id === 'metro-bpm-num') { setBpm(parseFloat(e.target.value) || s.bpm); e.target.value = String(s.bpm); }
  else if (id === 'metro-sig') setSignature(e.target.value);
  else if (id === 'metro-subdiv') s.subdiv = Number(e.target.value);
  else if (id === 'metro-timbre') s.timbre = e.target.value;
}

/** Espace = Démarrer / Arrêter, sauf pendant une saisie (champ texte, liste, zone de texte). */
function isTyping(t) {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes(t.type);
  return false;
}

function onKeyDown(e) {
  if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
  e.preventDefault(); // pas de défilement de page ni de clic natif sur un bouton ciblé
  if (e.repeat) return;
  s.spaceDown = true;
  toggle();
}

function onKeyUp(e) {
  if (e.code === 'Space' && s?.spaceDown) { s.spaceDown = false; e.preventDefault(); } // annule le clic natif (keyup)
}

/* ==========================================================================
   Gabarit
   ========================================================================== */
function buildTemplate() {
  const sigOpts = Object.keys(SIGNATURES).map((k) => `<option value="${k}"${k === '4/4' ? ' selected' : ''}>${k}</option>`).join('');
  const subOpts = SUBDIVISIONS.map((d) => `<option value="${d.v}">${d.label}</option>`).join('');
  const timbreOpts = Object.entries(TIMBRES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  return `
<div class="metro" id="metro-root" data-state="idle">
  <div class="metro-display">
    <div class="metro-readout" aria-live="off">
      <output class="metro-bpm-big" id="metro-bpm-big">${BPM_DEFAULT}</output>
      <span class="metro-unit">BPM</span>
    </div>
    <div class="metro-mark" id="metro-mark"></div>
    <div class="metro-beats" id="metro-beats" role="group" aria-label="Temps de la mesure : cliquez pour alterner accent, normal, muet"></div>
    <p class="metro-hint">Cliquez sur un temps : accent → normal → muet</p>
  </div>

  <div class="metro-panel">
    <div class="metro-bpm-row">
      <button type="button" class="icon-btn metro-step" data-step="-5" aria-label="Moins 5 BPM">−5</button>
      <button type="button" class="icon-btn metro-step" data-step="-1" aria-label="Moins 1 BPM">−1</button>
      <input type="number" class="metro-num" id="metro-bpm-num" min="${BPM_MIN}" max="${BPM_MAX}" step="1" value="${BPM_DEFAULT}" inputmode="numeric" aria-label="Tempo en BPM">
      <button type="button" class="icon-btn metro-step" data-step="1" aria-label="Plus 1 BPM">+1</button>
      <button type="button" class="icon-btn metro-step" data-step="5" aria-label="Plus 5 BPM">+5</button>
    </div>
    <input type="range" class="metro-range" id="metro-bpm" min="${BPM_MIN}" max="${BPM_MAX}" step="1" value="${BPM_DEFAULT}" aria-label="Tempo (curseur)">
    <div class="metro-tap-row">
      <button type="button" class="btn-secondary metro-tap" id="metro-tap"><i data-lucide="pointer"></i> Tap Tempo</button>
      <span class="metro-tap-count" id="metro-tap-count" aria-live="polite"></span>
    </div>
  </div>

  <div class="metro-panel metro-grid">
    <label class="metro-field">Signature rythmique
      <select id="metro-sig">${sigOpts}</select>
    </label>
    <label class="metro-field">Subdivision (par temps)
      <select id="metro-subdiv">${subOpts}</select>
    </label>
    <label class="metro-field">Timbre
      <select id="metro-timbre">${timbreOpts}</select>
    </label>
    <label class="metro-field">Volume <span class="metro-val" id="metro-vol-val"></span>
      <input type="range" id="metro-vol" min="0" max="100" step="1" value="70" aria-label="Volume">
    </label>
  </div>

  <div class="metro-controls">
    <button class="btn-primary metro-play" id="metro-play" type="button" aria-pressed="false">${LBL_PLAY}</button>
    <span class="metro-key"><kbd>Espace</kbd> pour démarrer / arrêter</span>
  </div>
  <p class="metro-status status-muted" id="metro-status" role="status" aria-live="polite"></p>
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
    bpm: BPM_DEFAULT, sig: '4/4', subdiv: 1, timbre: 'wood', vol: 70,
    pattern: defaultPattern(4),
    playing: false, ac: null, master: null, bus: null, noiseBuf: null,
    next: 0, beat: 0, sub: 0, queue: [], current: -1,
    timer: null, raf: 0, killTimers: new Set(),
    taps: [], tapTimer: null, spaceDown: false,
    listeners: new AbortController(),
  };
  const opt = { signal: s.listeners.signal };

  s.root.addEventListener('click', onClick, opt);
  s.root.addEventListener('input', onInput, opt);
  s.root.addEventListener('change', onChange, opt);
  window.addEventListener('keydown', onKeyDown, opt);
  window.addEventListener('keyup', onKeyUp, opt);

  renderBeats();
  syncUi();
  if (s.supported) setStatus('Prêt. Cliquez sur Démarrer ou appuyez sur Espace.');
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
  clearTimeout(st.timer);
  clearTimeout(st.tapTimer);
  cancelAnimationFrame(st.raf);
  st.killTimers.forEach((id) => clearTimeout(id)); st.killTimers.clear();
  try { st.bus?.disconnect(); } catch { /* ignoré */ }
  try { st.master?.disconnect(); } catch { /* ignoré */ }
  st.bus = null; st.master = null;
  if (st.ac && st.ac.state !== 'closed') st.ac.close().catch(() => { /* déjà fermé */ });
  st.ac = null; st.noiseBuf = null; st.queue = [];
  st.listeners.abort();            // retire tous les écouteurs (root + window)
  st.root.innerHTML = '';
  s = null;
}
