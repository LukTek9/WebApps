/**
 * image-redactor.js — Masquage / pixellisation / flou de zones, 100 % local (Canvas).
 * Contrat : mount(container, ctx) / unmount().
 */

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const OUT_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MODES = [
  { id: 'redact', label: 'Rectangle noir' },
  { id: 'pixelate', label: 'Pixellisation' },
  { id: 'blur', label: 'Flou' },
];

let state = null;

/**
 * Badge de valeur éditable : clic → <input type=number> (bornes/pas du curseur).
 * Enter/blur valide (slider.value + événement `input` → état + aperçu), Échap annule.
 */
function editable(badge, slider, fmt, cls) {
  if (!badge || !slider) return;
  badge.classList.add(cls);
  badge.tabIndex = 0;
  badge.setAttribute('role', 'button');
  badge.title = 'Cliquer pour saisir une valeur';
  const open = () => {
    if (badge.querySelector('input')) return;
    const min = parseFloat(slider.min), max = parseFloat(slider.max), step = parseFloat(slider.step) || 1;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = cls + '-input';
    inp.min = min; inp.max = max; inp.step = step; inp.value = slider.value;
    badge.textContent = '';
    badge.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const close = (commit, refocus) => {
      if (done) return;
      done = true;
      const raw = parseFloat(inp.value);
      inp.remove();
      if (commit && Number.isFinite(raw)) {
        slider.value = String(Math.min(Math.max(raw, min), max)); // le curseur applique le pas
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      badge.textContent = fmt(slider.value);
      if (refocus) badge.focus();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false, true); }
    });
    inp.addEventListener('blur', () => close(true, false));
  };
  badge.addEventListener('click', (e) => { if (e.target !== badge) return; e.preventDefault(); open(); }); // preventDefault : évite l'activation du <label>
  badge.addEventListener('keydown', (e) => { if (e.target === badge && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } });
}

export function mount(container, ctx) {
  unmount();

  container.innerHTML = `
  <div class="ir2-root">
    <div class="ir2-drop" data-ref="drop" tabindex="0">
      <i data-lucide="shield-alert"></i>
      <p><strong>Glissez-déposez une image ici</strong></p>
      <p class="ir2-hint">ou cliquez pour sélectionner</p>
      <input type="file" data-ref="file" accept="image/*" hidden>
    </div>
    <div class="ir2-editor ir2-hidden" data-ref="editor">
      <div class="ir2-bar">
        <div class="ir2-field">Forme de sélection
          <div class="ir2-modes" data-ref="shapes">
            <button type="button" class="ir2-chip on" data-s="rect">Rectangle</button>
            <button type="button" class="ir2-chip" data-s="poly">Polygone (point par point)</button>
          </div>
        </div>
        <div class="ir2-field">Mode de masque
          <div class="ir2-modes" data-ref="modes">
            ${MODES.map((m, i) => `<button type="button" class="ir2-chip${i === 0 ? ' on' : ''}" data-m="${m.id}">${m.label}</button>`).join('')}
          </div>
        </div>
        <label class="ir2-field"><span>Intensité : <strong data-ref="intVal">20</strong></span>
          <input type="range" min="2" max="60" value="20" data-ref="intensity">
        </label>
        <button class="ir2-btn ir2-sec" data-ref="undo" disabled>Annuler la dernière zone</button>
        <button class="ir2-btn ir2-sec" data-ref="clear" disabled>Effacer toutes les zones</button>
        <button class="ir2-btn ir2-sec" data-ref="cancel" disabled>Annuler tracé</button>
      </div>
      <div class="ir2-stage"><canvas class="ir2-canvas" data-ref="cv"></canvas></div>
      <div class="ir2-bar">
        <label class="ir2-field">Format d'export
          <select data-ref="fmt">
            <option value="original">Format d'origine</option>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WEBP</option>
          </select>
        </label>
        <button class="ir2-btn" data-ref="dl">Télécharger</button>
        <button class="ir2-btn ir2-sec" data-ref="del">Supprimer l'image</button>
        <span class="ir2-status" data-ref="status"></span>
      </div>
    </div>
  </div>`;

  const $ = (n) => container.querySelector(`[data-ref="${n}"]`);
  const el = {
    drop: $('drop'), file: $('file'), editor: $('editor'), modes: $('modes'), intensity: $('intensity'),
    intVal: $('intVal'), undo: $('undo'), clear: $('clear'), cv: $('cv'), fmt: $('fmt'), dl: $('dl'),
    del: $('del'), status: $('status'), shapes: $('shapes'), cancel: $('cancel'),
  };
  const g = el.cv.getContext('2d');

  const S = {
    file: null, srcUrl: null, img: null, W: 0, H: 0,
    zones: [], mode: 'redact', shape: 'rect', poly: null, draft: null, drawing: null, timers: new Set(),
  };
  state = { container, S };

  const setStatus = (t, err) => { el.status.textContent = t || ''; el.status.classList.toggle('err', !!err); };
  const refreshBtns = () => { el.undo.disabled = !S.zones.length; el.clear.disabled = !S.zones.length; el.cancel.disabled = !S.poly; };

  /** Facteur d'échelle : l'intensité (px) s'adapte à la résolution de l'image. */
  const factor = () => Math.max(1, Math.max(S.W, S.H) / 1000);

  /** Construit le chemin de la zone (polygone si z.pts, sinon rectangle). */
  const zonePath = (c, z) => {
    c.beginPath();
    if (z.pts) {
      c.moveTo(z.pts[0].x, z.pts[0].y);
      for (let i = 1; i < z.pts.length; i++) c.lineTo(z.pts[i].x, z.pts[i].y);
      c.closePath();
    } else {
      c.rect(z.x, z.y, z.w, z.h);
    }
  };

  /** Applique une zone sur le contexte c (source = image originale). */
  const applyZone = (c, z) => {
    const { x, y, w, h } = z;
    if (z.mode === 'redact') {
      c.save();
      c.fillStyle = '#000';
      zonePath(c, z);
      c.fill();
      c.restore();
    } else if (z.mode === 'pixelate') {
      const size = Math.max(2, z.v);
      const sw = Math.max(1, Math.ceil(w / size)), sh = Math.max(1, Math.ceil(h / size));
      const t = document.createElement('canvas');
      t.width = sw; t.height = sh;
      const tc = t.getContext('2d');
      tc.imageSmoothingEnabled = true;
      tc.drawImage(S.img, x, y, w, h, 0, 0, sw, sh);
      c.save();
      zonePath(c, z); c.clip();
      c.imageSmoothingEnabled = false;
      c.drawImage(t, 0, 0, sw, sh, x, y, w, h);
      c.restore();
    } else if (z.mode === 'blur') {
      c.save();
      zonePath(c, z); c.clip();
      if ('filter' in c) {
        c.filter = `blur(${z.v}px)`;
        c.drawImage(S.img, 0, 0);
      } else { // fallback (Safari) : réduction/agrandissement lissés
        const k = Math.max(2, z.v);
        const sw = Math.max(1, Math.ceil(w / k)), sh = Math.max(1, Math.ceil(h / k));
        const t = document.createElement('canvas');
        t.width = sw; t.height = sh;
        const tc = t.getContext('2d');
        tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
        tc.drawImage(S.img, x, y, w, h, 0, 0, sw, sh);
        c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
        c.drawImage(t, 0, 0, sw, sh, x, y, w, h);
      }
      c.restore();
    }
  };

  /** Dessine image + zones (+ aperçu de la zone en cours si preview). */
  const paint = (c, { preview = false, whiteBg = false } = {}) => {
    if (whiteBg) { c.fillStyle = '#fff'; c.fillRect(0, 0, S.W, S.H); }
    c.drawImage(S.img, 0, 0);
    S.zones.forEach((z) => applyZone(c, z));
    if (preview && S.draft) {
      const d = S.draft;
      c.save();
      c.lineWidth = Math.max(2, factor() * 2);
      c.setLineDash([c.lineWidth * 3, c.lineWidth * 2]);
      c.strokeStyle = '#e5322d';
      c.fillStyle = 'rgba(229,50,45,.18)';
      c.fillRect(d.x, d.y, d.w, d.h);
      c.strokeRect(d.x, d.y, d.w, d.h);
      c.restore();
    }
    if (preview && S.poly && S.poly.pts.length) {
      const { pts, cur } = S.poly;
      const lw = Math.max(2, factor() * 2);
      c.save();
      c.lineWidth = lw; c.lineJoin = 'round';
      c.strokeStyle = '#e5322d';
      c.fillStyle = 'rgba(229,50,45,.18)';
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      if (cur) c.lineTo(cur.x, cur.y);
      c.fill();
      c.setLineDash([lw * 3, lw * 2]);
      c.stroke();
      c.setLineDash([]);
      pts.forEach((p, i) => {
        c.beginPath();
        c.arc(p.x, p.y, i === 0 ? lw * 3 : lw * 1.6, 0, Math.PI * 2);
        c.fillStyle = i === 0 ? '#e5322d' : '#fff';
        c.fill(); c.stroke();
      });
      c.restore();
    }
  };
  const render = () => { if (S.img) paint(g, { preview: true }); };

  /* ---- Tracé pointeur ---- */
  const pos = (e) => {
    const r = el.cv.getBoundingClientRect();
    return {
      x: Math.min(Math.max((e.clientX - r.left) * (S.W / r.width), 0), S.W),
      y: Math.min(Math.max((e.clientY - r.top) * (S.H / r.height), 0), S.H),
    };
  };
  const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  /* ---- Polygone point par point ---- */
  /** Rayon de fermeture (≈10 px écran) converti en px image. */
  const closeR = () => 10 * (S.W / (el.cv.getBoundingClientRect().width || S.W));
  const polyHint = () => setStatus(`Polygone : ${S.poly.pts.length} sommet(s) — double-clic ou clic sur le 1er point pour fermer, Échap pour annuler`);
  const cancelPoly = (msg) => {
    if (!S.poly) return;
    S.poly = null; refreshBtns(); setStatus(msg ?? 'Tracé annulé'); render();
  };
  const closePoly = () => {
    const p = S.poly;
    if (!p || p.pts.length < 3) return;
    const pts = p.pts.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    S.poly = null;
    const min = 4 * factor();
    if (w >= min && h >= min) {
      S.zones.push({ x, y, w, h, pts, mode: S.mode, v: Math.round(Number(el.intensity.value) * factor()) });
      setStatus(`${S.zones.length} zone(s)`);
    } else setStatus('Polygone trop petit', true);
    refreshBtns(); render();
  };
  const addVertex = (p) => {
    if (!S.poly) S.poly = { pts: [], cur: null };
    const { pts } = S.poly, r = closeR();
    if (pts.length >= 3 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= r) { closePoly(); return; }
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > r / 2) pts.push(p); // anti-doublon (double-clic)
    S.poly.cur = p;
    refreshBtns(); polyHint(); render();
  };
  const onDbl = (e) => { if (S.shape === 'poly' && S.poly) { e.preventDefault(); closePoly(); } };
  const onKey = (e) => { if (e.key === 'Escape' && S.poly) { e.preventDefault(); cancelPoly(); } };

  const onDown = (e) => {
    if (!S.img) return;
    e.preventDefault();
    if (S.shape === 'poly') { addVertex(pos(e)); return; }
    el.cv.setPointerCapture?.(e.pointerId);
    S.drawing = pos(e);
    S.draft = null;
  };
  const onMove = (e) => {
    if (S.shape === 'poly') {
      if (S.poly) { S.poly.cur = pos(e); render(); }
      return;
    }
    if (!S.drawing) return;
    S.draft = rectOf(S.drawing, pos(e));
    render();
  };
  const onUp = (e) => {
    if (!S.drawing) return;
    const d = rectOf(S.drawing, pos(e));
    S.drawing = null; S.draft = null;
    const min = 4 * factor();
    if (d.w >= min && d.h >= min) {
      S.zones.push({
        x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), h: Math.round(d.h),
        mode: S.mode, v: Math.round(Number(el.intensity.value) * factor()),
      });
      setStatus(`${S.zones.length} zone(s)`);
    }
    refreshBtns(); render();
  };

  /* ---- Chargement / suppression ---- */
  const showDrop = () => { el.editor.classList.add('ir2-hidden'); el.drop.classList.remove('ir2-hidden'); };

  const releaseImage = () => {
    if (S.img) { S.img.onload = S.img.onerror = null; S.img.removeAttribute('src'); }
    if (S.srcUrl) { URL.revokeObjectURL(S.srcUrl); S.srcUrl = null; }
    S.img = null; S.file = null; S.zones = []; S.draft = S.drawing = S.poly = null;
    el.cv.width = el.cv.height = 0; // libère le buffer canvas
  };

  const removeImage = () => {
    releaseImage();
    refreshBtns(); setStatus('');
    showDrop();
  };

  const loadFile = (file) => {
    if (!file || !file.type.startsWith('image/')) { setStatus('Fichier non supporté', true); return; }
    releaseImage();
    S.file = file;
    S.srcUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      S.img = img; S.W = img.naturalWidth; S.H = img.naturalHeight;
      el.cv.width = S.W; el.cv.height = S.H;
      el.drop.classList.add('ir2-hidden');
      el.editor.classList.remove('ir2-hidden');
      refreshBtns(); setStatus('Tracez des zones sur l\'image');
      render();
    };
    img.onerror = () => { removeImage(); setStatus('Image illisible', true); };
    img.src = S.srcUrl;
  };

  /* ---- Export ---- */
  const download = async () => {
    if (!S.img) return;
    try {
      let mime = el.fmt.value === 'original' ? S.file.type : OUT_MIME[el.fmt.value];
      if (!MIME_EXT[mime]) mime = 'image/png'; // BMP/GIF… → PNG
      const off = document.createElement('canvas');
      off.width = S.W; off.height = S.H;
      paint(off.getContext('2d'), { whiteBg: mime === 'image/jpeg' });
      const blob = await new Promise((res) => off.toBlob(res, mime, 0.92));
      off.width = off.height = 0;
      if (!blob) throw new Error('Encodage impossible');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${S.file.name.replace(/\.[^.]+$/, '')}_masque.${MIME_EXT[mime]}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      const t = setTimeout(() => { URL.revokeObjectURL(url); S.timers.delete(t); }, 10000);
      S.timers.add(t);
      setStatus('Téléchargé');
    } catch (e) {
      setStatus(`Erreur : ${e.message}`, true);
    }
  };

  /* ---- Événements ---- */
  const H = {
    dropClick: () => el.file.click(),
    dropKey: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); } },
    fileChange: () => { loadFile(el.file.files[0]); el.file.value = ''; },
    over: (e) => { e.preventDefault(); el.drop.classList.add('ir2-over'); },
    leave: () => el.drop.classList.remove('ir2-over'),
    drop: (e) => { e.preventDefault(); el.drop.classList.remove('ir2-over'); loadFile(e.dataTransfer.files[0]); },
    mode: (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      S.mode = b.dataset.m;
      el.modes.querySelectorAll('.ir2-chip').forEach((c) => c.classList.toggle('on', c === b));
    },
    intensity: () => { el.intVal.textContent = el.intensity.value; },
    shape: (e) => {
      const b = e.target.closest('[data-s]');
      if (!b || b.dataset.s === S.shape) return;
      cancelPoly('');
      S.shape = b.dataset.s;
      el.shapes.querySelectorAll('.ir2-chip').forEach((c) => c.classList.toggle('on', c === b));
    },
    cancel: () => cancelPoly(),
    undo: () => { S.zones.pop(); refreshBtns(); setStatus(`${S.zones.length} zone(s)`); render(); },
    clear: () => { S.zones = []; refreshBtns(); setStatus(''); render(); },
  };
  el.drop.addEventListener('click', H.dropClick);
  el.drop.addEventListener('keydown', H.dropKey);
  el.file.addEventListener('change', H.fileChange);
  el.drop.addEventListener('dragover', H.over);
  el.drop.addEventListener('dragleave', H.leave);
  el.drop.addEventListener('drop', H.drop);
  el.modes.addEventListener('click', H.mode);
  el.shapes.addEventListener('click', H.shape);
  el.cancel.addEventListener('click', H.cancel);
  el.cv.addEventListener('dblclick', onDbl);
  document.addEventListener('keydown', onKey);
  el.intensity.addEventListener('input', H.intensity);
  editable(el.intVal, el.intensity, (v) => v, 'ir2-ev');
  el.undo.addEventListener('click', H.undo);
  el.clear.addEventListener('click', H.clear);
  el.dl.addEventListener('click', download);
  el.del.addEventListener('click', removeImage);
  el.cv.addEventListener('pointerdown', onDown);
  el.cv.addEventListener('pointermove', onMove);
  el.cv.addEventListener('pointerup', onUp);
  el.cv.addEventListener('pointercancel', onUp);

  state.cleanup = () => {
    el.drop.removeEventListener('click', H.dropClick);
    el.drop.removeEventListener('keydown', H.dropKey);
    el.file.removeEventListener('change', H.fileChange);
    el.drop.removeEventListener('dragover', H.over);
    el.drop.removeEventListener('dragleave', H.leave);
    el.drop.removeEventListener('drop', H.drop);
    el.modes.removeEventListener('click', H.mode);
    el.shapes.removeEventListener('click', H.shape);
    el.cancel.removeEventListener('click', H.cancel);
    el.cv.removeEventListener('dblclick', onDbl);
    document.removeEventListener('keydown', onKey);
    el.intensity.removeEventListener('input', H.intensity);
    el.undo.removeEventListener('click', H.undo);
    el.clear.removeEventListener('click', H.clear);
    el.dl.removeEventListener('click', download);
    el.del.removeEventListener('click', removeImage);
    el.cv.removeEventListener('pointerdown', onDown);
    el.cv.removeEventListener('pointermove', onMove);
    el.cv.removeEventListener('pointerup', onUp);
    el.cv.removeEventListener('pointercancel', onUp);
    S.timers.forEach(clearTimeout);
    S.timers.clear();
    releaseImage();
  };

  if (window.lucide?.createIcons) window.lucide.createIcons();
}

export function unmount() {
  if (!state) return;
  state.cleanup?.();
  state.container.innerHTML = '';
  state = null;
}
