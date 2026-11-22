/**
 * image-resizer.js — Redimensionneur d'images 100 % local (Canvas).
 * Contrat : mount(container, ctx) / unmount().
 */

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const OUT_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

let state = null; // { root, items, onDrop... } — remis à null à l'unmount

const fmtSize = (b) => b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(2)} Mo`;
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Image illisible'));
    img.src = url;
  });
}

/** Libère les URLs d'un item. */
function revokeItem(it) {
  if (it.srcUrl) URL.revokeObjectURL(it.srcUrl);
  if (it.outUrl) URL.revokeObjectURL(it.outUrl);
  it.srcUrl = it.outUrl = null;
}

export function mount(container, ctx) {
  unmount();

  container.innerHTML = `
  <div class="ir-root">
    <div class="ir-drop" data-ref="drop" tabindex="0">
      <i data-lucide="upload-cloud"></i>
      <p><strong>Glissez-déposez vos images ici</strong></p>
      <p class="ir-hint">ou cliquez pour sélectionner (multi-fichiers)</p>
      <input type="file" data-ref="file" accept="image/*" multiple hidden>
    </div>
    <div class="ir-panel">
      <label class="ir-field">Mode
        <select data-ref="mode">
          <option value="px">Pixels</option>
          <option value="pct">Pourcentage</option>
        </select>
      </label>
      <label class="ir-field"><span data-ref="wLabel">Largeur (px)</span>
        <input type="number" min="1" data-ref="w" placeholder="auto">
      </label>
      <label class="ir-field"><span data-ref="hLabel">Hauteur (px)</span>
        <input type="number" min="1" data-ref="h" placeholder="auto">
      </label>
      <label class="ir-field">Format de sortie
        <select data-ref="fmt">
          <option value="original">Format d'origine</option>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG</option>
          <option value="webp">WEBP</option>
        </select>
      </label>
      <label class="ir-field ir-check"><input type="checkbox" data-ref="ratio" checked> Conserver le ratio d'aspect</label>
    </div>
    <div class="ir-actions">
      <button class="ir-btn" data-ref="run" disabled>Redimensionner</button>
      <button class="ir-btn ir-sec" data-ref="clear" disabled>Tout supprimer</button>
    </div>
    <div class="resizer-preview-box" data-ref="pbox" hidden>
      <div class="ir-ptitle"><strong>Aperçu du résultat final</strong><span data-ref="pinfo"></span></div>
      <div class="ir-pstage checkerboard-bg"><canvas data-ref="pcv"></canvas></div>
    </div>
    <div class="ir-grid" data-ref="grid"></div>
  </div>`;

  const $ = (n) => container.querySelector(`[data-ref="${n}"]`);
  const el = {
    drop: $('drop'), file: $('file'), mode: $('mode'), w: $('w'), h: $('h'),
    wLabel: $('wLabel'), hLabel: $('hLabel'), fmt: $('fmt'), ratio: $('ratio'),
    run: $('run'), clear: $('clear'), grid: $('grid'),
    pbox: $('pbox'), pcv: $('pcv'), pinfo: $('pinfo'),
  };
  const items = [];
  let uid = 0;
  state = { container, items };

  const refreshBtns = () => {
    el.run.disabled = !items.length;
    el.clear.disabled = !items.length;
  };

  const renderCard = (it) => {
    const c = it.card;
    const dims = it.out
      ? `${it.w}×${it.h} → ${it.out.w}×${it.out.h}`
      : `${it.w}×${it.h}`;
    const size = it.out
      ? `${fmtSize(it.file.size)} → ${fmtSize(it.out.blob.size)}`
      : fmtSize(it.file.size);
    c.innerHTML = `
      <div class="ir-thumb" data-prev="${it.id}" title="Afficher l'aperçu" style="background-image:url('${it.srcUrl}')"></div>
      <div class="ir-body">
        <div class="ir-name" title="${esc(it.file.name)}">${esc(it.file.name)}</div>
        <div>${dims} px</div>
        <div>${size}</div>
        <div class="ir-status ${it.statusCls || ''}">${esc(it.status)}</div>
        <div class="ir-row">
          ${it.out ? `<a class="ir-btn" href="${it.outUrl}" download="${esc(it.out.name)}">Télécharger</a>` : ''}
          <button class="ir-btn ir-sec" data-del="${it.id}">Supprimer</button>
        </div>
      </div>`;
  };

  const addFiles = async (fileList) => {
    for (const file of fileList) {
      if (!file.type.startsWith('image/')) continue;
      const it = { id: ++uid, file, srcUrl: URL.createObjectURL(file), status: 'En attente', card: document.createElement('div') };
      it.card.className = 'ir-card';
      try {
        const img = await loadImage(it.srcUrl);
        it.img = img; it.w = img.naturalWidth; it.h = img.naturalHeight;
      } catch (e) {
        it.w = it.h = 0; it.status = 'Erreur : image illisible'; it.statusCls = 'err';
      }
      items.push(it);
      el.grid.appendChild(it.card);
      renderCard(it);
      if (activeId === null && it.img) activeId = it.id;
    }
    refreshBtns();
    schedulePreview();
  };

  /** Calcule les dimensions cibles selon les réglages. */
  const target = (it) => {
    const mode = el.mode.value, keep = el.ratio.checked;
    const wv = parseFloat(el.w.value), hv = parseFloat(el.h.value);
    let w, h;
    if (mode === 'pct') {
      const pw = wv > 0 ? wv : (hv > 0 && keep ? hv : 100);
      const ph = hv > 0 ? hv : (keep ? pw : 100);
      w = it.w * (keep ? pw : pw) / 100;
      h = it.h * (keep ? pw : ph) / 100;
    } else {
      if (wv > 0 && hv > 0) {
        if (keep) { const r = Math.min(wv / it.w, hv / it.h); w = it.w * r; h = it.h * r; }
        else { w = wv; h = hv; }
      } else if (wv > 0) { w = wv; h = keep ? it.h * wv / it.w : it.h; }
      else if (hv > 0) { h = hv; w = keep ? it.w * hv / it.h : it.w; }
      else { w = it.w; h = it.h; }
    }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  };

  /** Rééchantillonnage par paliers (÷2) pour limiter l'aliasing en réduction. */
  const resample = (img, tw, th) => {
    let cw = img.naturalWidth, ch = img.naturalHeight;
    let src = img;
    while (cw / 2 > tw && ch / 2 > th) {
      const nw = Math.max(tw, Math.floor(cw / 2)), nh = Math.max(th, Math.floor(ch / 2));
      const step = document.createElement('canvas');
      step.width = nw; step.height = nh;
      const sctx = step.getContext('2d');
      sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(src, 0, 0, nw, nh);
      src = step; cw = nw; ch = nh;
    }
    const cv = document.createElement('canvas');
    cv.width = tw; cv.height = th;
    const c2 = cv.getContext('2d');
    c2.imageSmoothingEnabled = true; c2.imageSmoothingQuality = 'high';
    c2.drawImage(src, 0, 0, tw, th);
    return cv;
  };

  const toBlob = (cv, mime) => new Promise((res) => cv.toBlob(res, mime, 0.92));

  /* ---- Aperçu dynamique : même rééchantillonnage + même format que l'export ---- */
  let activeId = null, pTimer = 0, pSeq = 0;
  const outMimeOf = (it) => {
    const m = el.fmt.value === 'original' ? it.file.type : OUT_MIME[el.fmt.value];
    return MIME_EXT[m] ? m : 'image/png';
  };
  const renderPreview = async () => {
    if (!state) return;
    items.forEach((x) => x.card.classList.toggle('ir-active', x.id === activeId));
    const it = items.find((x) => x.id === activeId && x.img);
    if (!it) { el.pbox.hidden = true; return; }
    const { w, h } = target(it);
    const mime = outMimeOf(it);
    const cv = resample(it.img, w, h);
    el.pcv.width = w; el.pcv.height = h;
    const g = el.pcv.getContext('2d');
    if (mime === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); } else g.clearRect(0, 0, w, h);
    g.drawImage(cv, 0, 0);
    cv.width = cv.height = 0; // libère le buffer temporaire
    el.pbox.hidden = false;
    const head = `${it.file.name} · ${it.w}×${it.h} → ${w}×${h} px · ${MIME_EXT[mime].toUpperCase()}`;
    el.pinfo.textContent = head;
    const seq = ++pSeq;
    const blob = await toBlob(el.pcv, mime);
    if (seq !== pSeq || !state || !blob) return;
    el.pinfo.textContent = `${head} · ≈ ${fmtSize(blob.size)} (original ${fmtSize(it.file.size)})`;
  };
  const schedulePreview = () => { clearTimeout(pTimer); pTimer = setTimeout(renderPreview, 80); };
  const pEvents = [[el.w, 'input'], [el.h, 'input'], [el.mode, 'change'], [el.fmt, 'change'], [el.ratio, 'change']];

  const processItem = async (it) => {
    if (!it.img) return;
    it.status = 'Traitement…'; it.statusCls = ''; renderCard(it);
    try {
      const { w, h } = target(it);
      let mime = el.fmt.value === 'original' ? it.file.type : OUT_MIME[el.fmt.value];
      if (!MIME_EXT[mime]) mime = 'image/png'; // formats non encodables (BMP, GIF…) → PNG
      const cv = resample(it.img, w, h);
      if (mime === 'image/jpeg') { // fond blanc pour la transparence
        const bg = document.createElement('canvas'); bg.width = w; bg.height = h;
        const b = bg.getContext('2d'); b.fillStyle = '#fff'; b.fillRect(0, 0, w, h); b.drawImage(cv, 0, 0);
        cv.width = w; cv.getContext('2d').drawImage(bg, 0, 0);
      }
      const blob = await toBlob(cv, mime);
      if (!blob) throw new Error('Encodage impossible');
      if (it.outUrl) URL.revokeObjectURL(it.outUrl);
      it.outUrl = URL.createObjectURL(blob);
      const base = it.file.name.replace(/\.[^.]+$/, '');
      it.out = { blob, w, h, name: `${base}_${w}x${h}.${MIME_EXT[mime]}` };
      it.status = 'Terminé'; it.statusCls = 'ok';
    } catch (e) {
      it.status = `Erreur : ${e.message}`; it.statusCls = 'err';
    }
    renderCard(it);
  };

  const onModeChange = () => {
    const pct = el.mode.value === 'pct';
    el.wLabel.textContent = pct ? 'Largeur (%)' : 'Largeur (px)';
    el.hLabel.textContent = pct ? 'Hauteur (%)' : 'Hauteur (px)';
    el.w.placeholder = pct ? '100' : 'auto';
    el.h.placeholder = pct ? '100' : 'auto';
  };

  const removeItem = (id) => {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return;
    revokeItem(items[i]);
    items[i].card.remove();
    items.splice(i, 1);
    if (activeId === id) activeId = items.find((x) => x.img)?.id ?? null;
    refreshBtns();
    schedulePreview();
  };

  const handlers = {
    dropClick: () => el.file.click(),
    dropKey: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); } },
    fileChange: () => { addFiles(Array.from(el.file.files)); el.file.value = ''; },
    over: (e) => { e.preventDefault(); el.drop.classList.add('ir-over'); },
    leave: () => el.drop.classList.remove('ir-over'),
    drop: (e) => { e.preventDefault(); el.drop.classList.remove('ir-over'); addFiles(Array.from(e.dataTransfer.files)); },
    run: async () => { el.run.disabled = true; for (const it of items) await processItem(it); refreshBtns(); },
    clear: () => { [...items].forEach((it) => removeItem(it.id)); },
    grid: (e) => {
      const b = e.target.closest('[data-del]');
      if (b) return removeItem(Number(b.dataset.del));
      const t = e.target.closest('[data-prev]');
      if (t) { activeId = Number(t.dataset.prev); schedulePreview(); }
    },
  };

  el.drop.addEventListener('click', handlers.dropClick);
  el.drop.addEventListener('keydown', handlers.dropKey);
  el.file.addEventListener('change', handlers.fileChange);
  el.drop.addEventListener('dragover', handlers.over);
  el.drop.addEventListener('dragleave', handlers.leave);
  el.drop.addEventListener('drop', handlers.drop);
  el.run.addEventListener('click', handlers.run);
  el.clear.addEventListener('click', handlers.clear);
  el.grid.addEventListener('click', handlers.grid);
  el.mode.addEventListener('change', onModeChange);
  pEvents.forEach(([n, ev]) => n.addEventListener(ev, schedulePreview));

  state.cleanup = () => {
    clearTimeout(pTimer); pSeq++;
    pEvents.forEach(([n, ev]) => n.removeEventListener(ev, schedulePreview));
    el.pcv.width = el.pcv.height = 0;
    el.drop.removeEventListener('click', handlers.dropClick);
    el.drop.removeEventListener('keydown', handlers.dropKey);
    el.file.removeEventListener('change', handlers.fileChange);
    el.drop.removeEventListener('dragover', handlers.over);
    el.drop.removeEventListener('dragleave', handlers.leave);
    el.drop.removeEventListener('drop', handlers.drop);
    el.run.removeEventListener('click', handlers.run);
    el.clear.removeEventListener('click', handlers.clear);
    el.grid.removeEventListener('click', handlers.grid);
    el.mode.removeEventListener('change', onModeChange);
  };

  if (window.lucide?.createIcons) window.lucide.createIcons();
}

export function unmount() {
  if (!state) return;
  state.cleanup?.();
  state.items.forEach(revokeItem);
  state.items.length = 0;
  state.container.innerHTML = '';
  state = null;
}
