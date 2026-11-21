/**
 * image-cropper.js — Rognage d'images 100 % local (Canvas + overlay interactif).
 * Contrat : mount(container, ctx) / unmount().
 */

const STYLE_ID = 'image-cropper-styles';
const CSS = `
.ic-root{display:flex;flex-direction:column;gap:1.25rem;font-family:var(--font-base,inherit);color:var(--color-text,inherit)}
.ic-drop{border:2px dashed var(--color-border,#cbd5e1);border-radius:var(--radius-lg,16px);padding:3rem 1.5rem;text-align:center;cursor:pointer;transition:background .2s,border-color .2s;background:var(--color-surface,transparent)}
.ic-drop:hover,.ic-drop.ic-over{border-color:var(--color-primary,#e5322d);background:var(--color-primary-soft,rgba(229,50,45,.06))}
.ic-drop i,.ic-drop svg{width:40px;height:40px;margin-bottom:.5rem}
.ic-drop p{margin:.25rem 0}.ic-hint{opacity:.65;font-size:.85rem}
.ic-hidden{display:none!important}
.ic-editor{display:flex;flex-direction:column;gap:1rem}
.ic-stage-wrap{display:flex;justify-content:center;padding:1rem;border:1px solid var(--color-border,#e2e8f0);border-radius:var(--radius-lg,16px);background:#0001}
.ic-stage{position:relative;display:inline-block;line-height:0;user-select:none;touch-action:none;overflow:hidden}
.ic-img{max-width:100%;max-height:60vh;display:block;pointer-events:none}
.ic-box{position:absolute;box-sizing:border-box;border:2px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.55);cursor:move;touch-action:none}
.ic-h{position:absolute;width:14px;height:14px;background:var(--color-primary,#e5322d);border:2px solid #fff;border-radius:50%;box-sizing:border-box;touch-action:none}
.ic-h[data-h=nw]{left:-8px;top:-8px;cursor:nwse-resize}.ic-h[data-h=ne]{right:-8px;top:-8px;cursor:nesw-resize}
.ic-h[data-h=sw]{left:-8px;bottom:-8px;cursor:nesw-resize}.ic-h[data-h=se]{right:-8px;bottom:-8px;cursor:nwse-resize}
.ic-h[data-h=n]{left:calc(50% - 7px);top:-8px;cursor:ns-resize}.ic-h[data-h=s]{left:calc(50% - 7px);bottom:-8px;cursor:ns-resize}
.ic-h[data-h=w]{left:-8px;top:calc(50% - 7px);cursor:ew-resize}.ic-h[data-h=e]{right:-8px;top:calc(50% - 7px);cursor:ew-resize}
.ic-panel{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;padding:1.25rem;border:1px solid var(--color-border,#e2e8f0);border-radius:var(--radius-lg,16px);background:var(--color-surface,transparent)}
.ic-field{display:flex;flex-direction:column;gap:.35rem;font-size:.9rem}
.ic-field select{padding:.55rem .7rem;border:1px solid var(--color-border,#cbd5e1);border-radius:var(--radius-md,10px);font:inherit;background:var(--color-bg,#fff);color:inherit}
.ic-ratios{display:flex;gap:.4rem;flex-wrap:wrap}
.ic-chip{padding:.4rem .8rem;border:1px solid var(--color-border,#cbd5e1);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:.85rem;cursor:pointer}
.ic-chip.on{background:var(--color-primary,#e5322d);border-color:var(--color-primary,#e5322d);color:#fff}
.ic-info{font-variant-numeric:tabular-nums;font-size:.9rem;line-height:1.6}
.ic-actions{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}
.ic-btn{padding:.65rem 1.2rem;border:0;border-radius:var(--radius-md,10px);font:inherit;font-weight:600;cursor:pointer;background:var(--color-primary,#e5322d);color:#fff;text-decoration:none;display:inline-block}
.ic-btn.ic-sec{background:transparent;color:inherit;border:1px solid var(--color-border,#cbd5e1)}
.ic-result{display:flex;gap:1rem;align-items:center;padding:1rem;border:1px solid var(--color-border,#e2e8f0);border-radius:var(--radius-lg,16px);flex-wrap:wrap}
.ic-result img{max-height:120px;max-width:200px;border-radius:8px;background:#0001}
.ic-status{font-size:.85rem;font-weight:600}.ic-status.err{color:#dc2626}
`;

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const OUT_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const RATIOS = [
  { id: 'free', label: 'Libre', v: null },
  { id: '1:1', label: '1:1', v: 1 },
  { id: '16:9', label: '16:9', v: 16 / 9 },
  { id: '4:3', label: '4:3', v: 4 / 3 },
  { id: '9:16', label: '9:16', v: 9 / 16 },
];
const MIN = 10; // taille min de sélection (px image)

let state = null;

const fmtSize = (b) => b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(2)} Mo`;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

export function mount(container, ctx) {
  unmount();
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  container.innerHTML = `
  <div class="ic-root">
    <div class="ic-drop" data-ref="drop" tabindex="0">
      <i data-lucide="crop"></i>
      <p><strong>Glissez-déposez une image ici</strong></p>
      <p class="ic-hint">ou cliquez pour sélectionner</p>
      <input type="file" data-ref="file" accept="image/*" hidden>
    </div>
    <div class="ic-editor ic-hidden" data-ref="editor">
      <div class="ic-stage-wrap">
        <div class="ic-stage" data-ref="stage">
          <img class="ic-img" data-ref="img" alt="">
          <div class="ic-box" data-ref="box">
            <i class="ic-h" data-h="nw"></i><i class="ic-h" data-h="n"></i><i class="ic-h" data-h="ne"></i>
            <i class="ic-h" data-h="w"></i><i class="ic-h" data-h="e"></i>
            <i class="ic-h" data-h="sw"></i><i class="ic-h" data-h="s"></i><i class="ic-h" data-h="se"></i>
          </div>
        </div>
      </div>
      <div class="ic-panel">
        <div class="ic-field">Ratio
          <div class="ic-ratios" data-ref="ratios">
            ${RATIOS.map((r) => `<button type="button" class="ic-chip${r.id === 'free' ? ' on' : ''}" data-r="${r.id}">${r.label}</button>`).join('')}
          </div>
        </div>
        <div class="ic-field">Sélection
          <div class="ic-info" data-ref="info"></div>
        </div>
        <label class="ic-field">Format d'export
          <select data-ref="fmt">
            <option value="original">Format d'origine</option>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WEBP</option>
          </select>
        </label>
      </div>
      <div class="ic-actions">
        <button class="ic-btn" data-ref="crop">Rogner</button>
        <button class="ic-btn ic-sec" data-ref="reset">Réinitialiser</button>
        <button class="ic-btn ic-sec" data-ref="del">Supprimer</button>
        <span class="ic-status" data-ref="status"></span>
      </div>
      <div class="ic-result ic-hidden" data-ref="result"></div>
    </div>
  </div>`;

  const $ = (n) => container.querySelector(`[data-ref="${n}"]`);
  const el = {
    drop: $('drop'), file: $('file'), editor: $('editor'), stage: $('stage'), img: $('img'), box: $('box'),
    ratios: $('ratios'), info: $('info'), fmt: $('fmt'), crop: $('crop'), reset: $('reset'), del: $('del'),
    status: $('status'), result: $('result'),
  };

  const S = {
    file: null, srcUrl: null, outUrl: null,
    W: 0, H: 0, // dimensions naturelles
    sel: { x: 0, y: 0, w: 0, h: 0 }, // en px image
    ratio: null,
    drag: null,
  };
  state = { container, S };

  const setStatus = (t, err) => { el.status.textContent = t || ''; el.status.classList.toggle('err', !!err); };

  const revokeOut = () => {
    if (S.outUrl) { URL.revokeObjectURL(S.outUrl); S.outUrl = null; }
    el.result.classList.add('ic-hidden');
    el.result.innerHTML = '';
  };
  const revokeAll = () => {
    revokeOut();
    if (S.srcUrl) { URL.revokeObjectURL(S.srcUrl); S.srcUrl = null; }
  };

  /** Échelle affichage / image naturelle. */
  const scale = () => (S.W ? el.img.clientWidth / S.W : 1);

  const render = () => {
    const k = scale(), s = S.sel;
    el.box.style.left = `${s.x * k}px`;
    el.box.style.top = `${s.y * k}px`;
    el.box.style.width = `${s.w * k}px`;
    el.box.style.height = `${s.h * k}px`;
    el.info.innerHTML = `X : ${Math.round(s.x)} px · Y : ${Math.round(s.y)} px<br>Taille : <strong>${Math.round(s.w)} × ${Math.round(s.h)} px</strong>`;
  };

  /** Plus grande sélection de ratio donné, centrée sur la sélection courante, dans l'image. */
  const fitRatio = () => {
    const r = S.ratio, s = S.sel;
    if (!r) return;
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    let w = s.w, h = w / r;
    if (h > s.h) { h = s.h; w = h * r; }
    w = Math.min(w, S.W); h = w / r;
    if (h > S.H) { h = S.H; w = h * r; }
    s.w = w; s.h = h;
    s.x = clamp(cx - w / 2, 0, S.W - w);
    s.y = clamp(cy - h / 2, 0, S.H - h);
  };

  const defaultSel = () => {
    const w = S.W * 0.8, h = S.H * 0.8;
    S.sel = { x: (S.W - w) / 2, y: (S.H - h) / 2, w, h };
    fitRatio();
  };

  /** Redimensionnement via poignée (coordonnées image). */
  const resize = (hd, st, dx, dy) => {
    const { W, H } = S, r = S.ratio;
    let l = st.x, t = st.y, rt = st.x + st.w, b = st.y + st.h;
    if (hd.includes('w')) l += dx;
    if (hd.includes('e')) rt += dx;
    if (hd.includes('n')) t += dy;
    if (hd.includes('s')) b += dy;
    if (!r) {
      l = clamp(l, 0, W); rt = clamp(rt, 0, W); t = clamp(t, 0, H); b = clamp(b, 0, H);
      if (rt - l < MIN) { if (hd.includes('w')) l = rt - MIN; else rt = l + MIN; }
      if (b - t < MIN) { if (hd.includes('n')) t = b - MIN; else b = t + MIN; }
      l = clamp(l, 0, W - MIN); rt = clamp(rt, MIN, W); t = clamp(t, 0, H - MIN); b = clamp(b, MIN, H);
      return { x: l, y: t, w: rt - l, h: b - t };
    }
    const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
    let w, h, x, y;
    if (hd.length === 2) { // coin : ancre = coin opposé
      const ax = hd.includes('w') ? st.x + st.w : st.x;
      const ay = hd.includes('n') ? st.y + st.h : st.y;
      const maxW = hd.includes('w') ? ax : W - ax;
      const maxH = hd.includes('n') ? ay : H - ay;
      w = Math.max(rt - l, MIN * r);
      w = Math.min(w, maxW, maxH * r);
      h = w / r;
      x = hd.includes('w') ? ax - w : ax;
      y = hd.includes('n') ? ay - h : ay;
    } else if (hd === 'e' || hd === 'w') {
      const ax = hd === 'w' ? st.x + st.w : st.x;
      const maxW = Math.min(hd === 'w' ? ax : W - ax, 2 * Math.min(cy, H - cy) * r);
      w = Math.min(Math.max(rt - l, MIN * r), maxW);
      h = w / r;
      x = hd === 'w' ? ax - w : ax;
      y = cy - h / 2;
    } else { // n / s
      const ay = hd === 'n' ? st.y + st.h : st.y;
      const maxH = Math.min(hd === 'n' ? ay : H - ay, (2 * Math.min(cx, W - cx)) / r);
      h = Math.min(Math.max(b - t, MIN), maxH);
      w = h * r;
      y = hd === 'n' ? ay - h : ay;
      x = cx - w / 2;
    }
    return { x, y, w, h };
  };

  /* ---- Interactions pointeur ---- */
  const onDown = (e) => {
    const hd = e.target.dataset?.h || (e.target === el.box ? 'move' : null);
    if (!hd) return;
    e.preventDefault();
    S.drag = { hd, px: e.clientX, py: e.clientY, st: { ...S.sel } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  const onMove = (e) => {
    const d = S.drag;
    if (!d) return;
    const k = scale() || 1;
    const dx = (e.clientX - d.px) / k, dy = (e.clientY - d.py) / k;
    if (d.hd === 'move') {
      S.sel = { ...d.st, x: clamp(d.st.x + dx, 0, S.W - d.st.w), y: clamp(d.st.y + dy, 0, S.H - d.st.h) };
    } else {
      S.sel = resize(d.hd, d.st, dx, dy);
    }
    render();
  };
  const onUp = () => {
    S.drag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  /* ---- Chargement / reset ---- */
  const showDrop = () => { el.editor.classList.add('ic-hidden'); el.drop.classList.remove('ic-hidden'); };

  const clearAll = () => {
    onUp();
    revokeAll();
    el.img.removeAttribute('src');
    S.file = null; S.W = S.H = 0;
    setStatus('');
    showDrop();
  };

  const loadFile = (file) => {
    if (!file || !file.type.startsWith('image/')) { setStatus('Fichier non supporté', true); return; }
    revokeAll(); // libère l'image précédente
    S.file = file;
    S.srcUrl = URL.createObjectURL(file);
    el.img.onload = () => {
      S.W = el.img.naturalWidth; S.H = el.img.naturalHeight;
      el.drop.classList.add('ic-hidden');
      el.editor.classList.remove('ic-hidden');
      defaultSel();
      render();
      setStatus('');
    };
    el.img.onerror = () => { clearAll(); setStatus('Image illisible', true); showDrop(); };
    el.img.src = S.srcUrl;
  };

  const resetSel = () => {
    revokeOut();
    S.ratio = null;
    el.ratios.querySelectorAll('.ic-chip').forEach((c) => c.classList.toggle('on', c.dataset.r === 'free'));
    el.fmt.value = 'original';
    defaultSel(); render(); setStatus('');
  };

  /* ---- Extraction Canvas ---- */
  const doCrop = async () => {
    if (!S.file) return;
    try {
      const x = Math.round(S.sel.x), y = Math.round(S.sel.y);
      const w = Math.max(1, Math.min(Math.round(S.sel.w), S.W - x));
      const h = Math.max(1, Math.min(Math.round(S.sel.h), S.H - y));
      let mime = el.fmt.value === 'original' ? S.file.type : OUT_MIME[el.fmt.value];
      if (!MIME_EXT[mime]) mime = 'image/png'; // BMP/GIF… → PNG
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c = cv.getContext('2d');
      if (mime === 'image/jpeg') { c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); }
      c.drawImage(el.img, x, y, w, h, 0, 0, w, h);
      const blob = await new Promise((res) => cv.toBlob(res, mime, 0.92));
      if (!blob) throw new Error('Encodage impossible');
      revokeOut();
      S.outUrl = URL.createObjectURL(blob);
      const name = `${S.file.name.replace(/\.[^.]+$/, '')}_crop_${w}x${h}.${MIME_EXT[mime]}`;
      el.result.innerHTML = `
        <img src="${S.outUrl}" alt="Résultat">
        <div class="ic-info">${w} × ${h} px · ${fmtSize(blob.size)}</div>
        <a class="ic-btn" href="${S.outUrl}" download="${name.replace(/"/g, '')}">Télécharger</a>`;
      el.result.classList.remove('ic-hidden');
      setStatus('Terminé');
    } catch (e) {
      setStatus(`Erreur : ${e.message}`, true);
    }
  };

  /* ---- Événements ---- */
  const H = {
    dropClick: () => el.file.click(),
    dropKey: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); } },
    fileChange: () => { loadFile(el.file.files[0]); el.file.value = ''; },
    over: (e) => { e.preventDefault(); el.drop.classList.add('ic-over'); },
    leave: () => el.drop.classList.remove('ic-over'),
    drop: (e) => { e.preventDefault(); el.drop.classList.remove('ic-over'); loadFile(e.dataTransfer.files[0]); },
    ratio: (e) => {
      const b = e.target.closest('[data-r]');
      if (!b || !S.file) return;
      S.ratio = RATIOS.find((r) => r.id === b.dataset.r).v;
      el.ratios.querySelectorAll('.ic-chip').forEach((c) => c.classList.toggle('on', c === b));
      fitRatio(); render(); revokeOut(); setStatus('');
    },
    resize: () => render(),
    fmtChange: () => revokeOut(),
  };
  el.drop.addEventListener('click', H.dropClick);
  el.drop.addEventListener('keydown', H.dropKey);
  el.file.addEventListener('change', H.fileChange);
  el.drop.addEventListener('dragover', H.over);
  el.drop.addEventListener('dragleave', H.leave);
  el.drop.addEventListener('drop', H.drop);
  el.ratios.addEventListener('click', H.ratio);
  el.box.addEventListener('pointerdown', onDown);
  el.crop.addEventListener('click', doCrop);
  el.reset.addEventListener('click', resetSel);
  el.del.addEventListener('click', clearAll);
  el.fmt.addEventListener('change', H.fmtChange);
  window.addEventListener('resize', H.resize);

  state.cleanup = () => {
    onUp();
    el.drop.removeEventListener('click', H.dropClick);
    el.drop.removeEventListener('keydown', H.dropKey);
    el.file.removeEventListener('change', H.fileChange);
    el.drop.removeEventListener('dragover', H.over);
    el.drop.removeEventListener('dragleave', H.leave);
    el.drop.removeEventListener('drop', H.drop);
    el.ratios.removeEventListener('click', H.ratio);
    el.box.removeEventListener('pointerdown', onDown);
    el.crop.removeEventListener('click', doCrop);
    el.reset.removeEventListener('click', resetSel);
    el.del.removeEventListener('click', clearAll);
    el.fmt.removeEventListener('change', H.fmtChange);
    window.removeEventListener('resize', H.resize);
    el.img.onload = el.img.onerror = null;
    revokeAll();
  };

  if (window.lucide?.createIcons) window.lucide.createIcons();
}

export function unmount() {
  if (!state) return;
  state.cleanup?.();
  state.container.innerHTML = '';
  state = null;
}
