/**
 * image-rotator.js — Rotation (rapide / angle libre) et miroirs H/V, 100 % local via Canvas.
 * Contrat : export mount(container, ctx) / unmount().
 */

const EXPORT_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

let s = null; // état du module (null = démonté)

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

const q = (id) => s?.root.querySelector('#rot-' + id);
const refreshIcons = () => window.lucide?.createIcons();
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'image';

function setStatus(msg = '', isError = false) {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#dc2626' : 'inherit';
}

/** Ramène un angle dans ]-180, 180]. */
function normalize(a) {
  let r = ((((a + 180) % 360) + 360) % 360) - 180;
  if (r === -180) r = 180;
  return r;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible : ' + file.name)); };
    img.src = url;
  });
}

/** Moteur : dessine l'image transformée (flip → rotation) sur `canvas`. */
function composite(canvas, flatten = false) {
  const w = s.img.naturalWidth, h = s.img.naturalHeight;
  const rad = (s.angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));

  let cw = w, ch = h;
  if (s.expand) {
    // Bounding box de l'image pivotée ; arrondi anti-bruit flottant avant ceil.
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    cw = Math.ceil(r6(w * cos + h * sin));
    ch = Math.ceil(r6(w * sin + h * cos));
  }
  canvas.width = cw;
  canvas.height = ch;

  const g = canvas.getContext('2d');
  if (flatten) { g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch); }
  g.imageSmoothingQuality = 'high';
  g.translate(cw / 2, ch / 2);
  g.rotate(rad);
  g.scale(s.flipH ? -1 : 1, s.flipV ? -1 : 1);
  g.drawImage(s.img, -w / 2, -h / 2, w, h);
}

function renderPreview() {
  if (!s?.img) return;
  composite(q('canvas'));
  q('dims').textContent = `${q('canvas').width} × ${q('canvas').height} px`;
}

const schedule = () => {
  if (!s || s.raf) return;
  s.raf = requestAnimationFrame(() => { if (s) { s.raf = 0; renderPreview(); } });
};

/** Format d'affichage : +90°, -45°, 0°. */
const fmtAngle = (a) => `${a > 0 ? '+' : ''}${a}°`;

/** Source unique de vérité de l'angle : normalise dans ]-180, 180], synchronise curseur + libellé, relance l'aperçu. */
function setAngle(a) {
  const n = Number(a);
  let v = normalize(Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
  if (Object.is(v, -0)) v = 0;
  s.angle = v;
  // Écriture programmatique : aucun événement natif émis ; le drapeau protège de toute boucle.
  s.syncing = true;
  q('angle').value = s.angle;
  q('angle-v').textContent = fmtAngle(s.angle);
  s.syncing = false;
  schedule();
}

function resetAll() {
  s.flipH = false; s.flipV = false;
  setAngle(0);
  syncFlipButtons();
}

function syncFlipButtons() {
  q('fliph').setAttribute('aria-pressed', String(s.flipH));
  q('flipv').setAttribute('aria-pressed', String(s.flipV));
}

function exportMime() {
  const f = q('format').value;
  if (f === 'original') return EXT[s.imgMime] ? s.imgMime : 'image/png';
  return EXPORT_MIME[f];
}

function revokeDownload() {
  if (s?.dlUrl) { URL.revokeObjectURL(s.dlUrl); s.dlUrl = null; }
}

function download() {
  if (!s?.img) return;
  const mime = exportMime();
  const out = document.createElement('canvas');
  composite(out, mime === 'image/jpeg');
  out.toBlob((blob) => {
    if (!s) return;
    if (!blob) { setStatus('Export impossible dans ce format.', true); return; }
    revokeDownload();
    s.dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = s.dlUrl;
    a.download = `${baseName(s.imgName)}-rotated.${EXT[mime]}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('Téléchargement lancé.');
    setTimeout(revokeDownload, 10000);
  }, mime, 0.92);
}

function removeImage() {
  if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
  s.img = null; s.imgUrl = null; s.imgName = ''; s.imgMime = '';
  q('workarea').hidden = true;
  q('drop').hidden = false;
  q('input').value = '';
  setStatus('');
}

async function onFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { setStatus('Fichier non image.', true); return; }
  try {
    const { img, url } = await loadImage(file);
    if (!s) { URL.revokeObjectURL(url); return; }
    if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
    s.img = img; s.imgUrl = url; s.imgName = file.name; s.imgMime = file.type;
    q('file-name').textContent = file.name;
    q('drop').hidden = true;
    q('workarea').hidden = false;
    resetAll();
    setStatus('');
  } catch (e) { setStatus(e.message, true); }
}

export function mount(container, ctx) {
  s = { root: container, ctx, img: null, imgUrl: null, imgName: '', imgMime: '',
        angle: 0, flipH: false, flipV: false, expand: true, raf: 0, syncing: false, dlUrl: null, cleanups: [] };

  container.innerHTML = `
  <style>
    .rot{display:grid;gap:1rem;font-family:var(--font-family,inherit)}
    .rot-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;min-height:220px;
      border:2px dashed rgba(128,128,128,.5);border-radius:var(--radius,12px);cursor:pointer;text-align:center;padding:1rem}
    .rot-drop.rot-over{border-color:var(--primary,#4f46e5);background:rgba(79,70,229,.08)}
    .rot-drop input{display:none}
    .rot-main{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:1rem;align-items:start}
    @media(max-width:820px){.rot-main{grid-template-columns:1fr}}
    .rot-preview{display:grid;gap:.4rem;min-width:0;text-align:center}
    /* Cadre d'affichage stable : dimensions fixes, indépendantes de la taille interne du canvas (bounding box). */
    .rot-preview-box{box-sizing:border-box;width:100%;height:420px;flex:none;display:flex;align-items:center;justify-content:center;
      overflow:hidden;contain:size layout paint;background:var(--bg-preview,#1e1e2e);border-radius:var(--radius,12px)}
    .rot-preview-box canvas{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;margin:auto;display:block}
    .rot-panel{display:grid;gap:.75rem;border:1px solid rgba(128,128,128,.35);border-radius:var(--radius,12px);padding:1rem}
    .rot-panel fieldset{border:0;padding:0;margin:0;display:grid;gap:.5rem}
    .rot-row{display:grid;gap:.25rem;font-size:.9rem}
    .rot-row select{padding:.4rem;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit}
    .rot-btns{display:flex;flex-wrap:wrap;gap:.5rem}
    .rot-btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.55rem .8rem;border:1px solid rgba(128,128,128,.5);
      border-radius:var(--radius,12px);background:transparent;color:inherit;font-weight:600;cursor:pointer}
    .rot-btn[aria-pressed=true]{background:var(--primary,#4f46e5);border-color:var(--primary,#4f46e5);color:#fff}
    .rot-btn.rot-primary{background:var(--primary,#4f46e5);border-color:var(--primary,#4f46e5);color:#fff}
    .rot-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
    .rot-ev{cursor:pointer;border-bottom:1px dashed currentColor;border-radius:3px;padding:0 .2em;transition:background .15s}
    .rot-ev:hover,.rot-ev:focus-visible{background:rgba(128,128,128,.18);border-bottom-style:solid;outline:0}
    .rot-ev-input{width:4.5em;padding:0 .25em;font:inherit;color:inherit;background:transparent;border:1px solid var(--primary,#4f46e5);border-radius:4px}
  </style>
  <div class="rot">
    <label class="rot-drop" id="rot-drop">
      <i data-lucide="image-plus"></i>
      <strong>Glissez une image ici ou cliquez pour parcourir</strong>
      <input type="file" id="rot-input" accept="image/*">
    </label>

    <div id="rot-workarea" hidden>
      <div class="rot-head">
        <span id="rot-file-name"></span>
        <button class="rot-btn" id="rot-remove" type="button"><i data-lucide="trash-2"></i>Supprimer</button>
      </div>
      <div class="rot-main">
        <div class="rot-preview">
          <div class="rot-preview-box"><canvas id="rot-canvas"></canvas></div>
          <div id="rot-dims" style="font-size:.8rem;opacity:.7"></div>
        </div>

        <div class="rot-panel">
          <fieldset>
            <legend>Rotation rapide</legend>
            <div class="rot-btns">
              <button class="rot-btn" type="button" data-rot="90"><i data-lucide="rotate-cw"></i>+90°</button>
              <button class="rot-btn" type="button" data-rot="-90"><i data-lucide="rotate-ccw"></i>-90°</button>
              <button class="rot-btn" type="button" data-rot="180"><i data-lucide="refresh-cw"></i>180°</button>
            </div>
          </fieldset>

          <fieldset>
            <label class="rot-row">Angle précis <output id="rot-angle-v">0°</output>
              <input type="range" id="rot-angle" min="-180" max="180" step="1" value="0">
            </label>
            <button class="rot-btn" id="rot-zero" type="button"><i data-lucide="undo-2"></i>Réinitialiser à 0°</button>
          </fieldset>

          <fieldset>
            <legend>Miroir</legend>
            <div class="rot-btns">
              <button class="rot-btn" id="rot-fliph" type="button" aria-pressed="false"><i data-lucide="flip-horizontal"></i>Flip H</button>
              <button class="rot-btn" id="rot-flipv" type="button" aria-pressed="false"><i data-lucide="flip-vertical"></i>Flip V</button>
            </div>
          </fieldset>

          <fieldset>
            <legend>Ajustement</legend>
            <label><input type="radio" name="rot-fit" value="expand" checked> Agrandir le canvas pour tout afficher</label>
            <label><input type="radio" name="rot-fit" value="keep"> Conserver les dimensions d'origine</label>
          </fieldset>

          <fieldset>
            <label class="rot-row">Format d'export
              <select id="rot-format">
                <option value="original">Format d'origine</option>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WEBP</option>
              </select>
            </label>
            <button class="rot-btn rot-primary" id="rot-download" type="button"><i data-lucide="download"></i>Télécharger</button>
          </fieldset>
        </div>
      </div>
    </div>
    <p id="rot-status" role="status"></p>
  </div>`;

  const on = (el, ev, fn) => { el.addEventListener(ev, fn); s.cleanups.push(() => el.removeEventListener(ev, fn)); };

  // Dépôt
  const zone = q('drop'), input = q('input');
  on(input, 'change', () => onFile(input.files[0]));
  on(zone, 'dragover', (e) => { e.preventDefault(); zone.classList.add('rot-over'); });
  on(zone, 'dragleave', () => zone.classList.remove('rot-over'));
  on(zone, 'drop', (e) => { e.preventDefault(); zone.classList.remove('rot-over'); onFile(e.dataTransfer.files[0]); });

  // Commandes
  container.querySelectorAll('[data-rot]').forEach((b) => on(b, 'click', () => setAngle(s.angle + Number(b.dataset.rot))));
  // Curseur : `input` (glissement fluide) + `change` (relâchement / clavier) ; ignorés pendant une MAJ programmatique.
  const onSlider = () => { if (!s.syncing) setAngle(q('angle').value); };
  on(q('angle'), 'input', onSlider);
  on(q('angle'), 'change', onSlider);
  editable(q('angle-v'), q('angle'), (v) => fmtAngle(Number(v)), 'rot-ev');
  on(q('zero'), 'click', () => setAngle(0));
  on(q('fliph'), 'click', () => { s.flipH = !s.flipH; syncFlipButtons(); schedule(); });
  on(q('flipv'), 'click', () => { s.flipV = !s.flipV; syncFlipButtons(); schedule(); });
  container.querySelectorAll('[name="rot-fit"]').forEach((r) =>
    on(r, 'change', () => { s.expand = r.value === 'expand'; schedule(); }));
  on(q('remove'), 'click', removeImage);
  on(q('download'), 'click', download);

  refreshIcons();
}

export function unmount() {
  if (!s) return;
  if (s.raf) cancelAnimationFrame(s.raf);
  s.cleanups.forEach((fn) => fn());
  if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
  revokeDownload();
  s.root.innerHTML = '';
  s = null;
}
