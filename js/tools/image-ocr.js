/**
 * image-ocr.js — Extraction de texte (OCR) 100 % client via Tesseract.js (chargé à la demande).
 * Contrat : export mount(container, ctx) / unmount().
 */

const TESSERACT_SOURCES = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
];
const LANGS = [
  { value: 'fra+eng', label: 'Français + Anglais (défaut)' },
  { value: 'fra', label: 'Français' },
  { value: 'eng', label: 'Anglais' },
  { value: 'spa', label: 'Espagnol' },
  { value: 'deu', label: 'Allemand' },
];
const DEFAULT_LANG = 'fra+eng';
const STATUS_FR = {
  'loading tesseract core': 'Chargement du moteur OCR',
  'initializing tesseract': 'Initialisation du moteur',
  'loading language traineddata': 'Téléchargement des données de langue',
  'initializing api': 'Initialisation de l’API',
  'recognizing text': 'Reconnaissance du texte',
};

let s = null; // état du module (null = démonté)
let tessPromise = null; // chargement paresseux du script (mis en cache)

const q = (id) => s?.root.querySelector('#ocr-' + id);
const refreshIcons = () => window.lucide?.createIcons();
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'texte';

function setStatus(msg = '', isError = false) {
  const el = q('status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#dc2626' : 'inherit';
}

function setProgress(p, label = '') {
  const bar = q('progress');
  if (!bar) return;
  bar.hidden = false;
  bar.value = Math.max(0, Math.min(1, p));
  q('progress-label').textContent = `${label} ${Math.round(bar.value * 100)} %`;
}

function hideProgress() {
  if (!q('progress')) return;
  q('progress').hidden = true;
  q('progress-label').textContent = '';
}

/** Charge Tesseract.js uniquement à la demande, avec bascule entre CDN. */
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tessPromise) return tessPromise;
  tessPromise = (async () => {
    let lastErr;
    for (const src of TESSERACT_SOURCES) {
      try {
        await new Promise((resolve, reject) => {
          const el = document.createElement('script');
          el.src = src;
          el.async = true;
          el.onload = resolve;
          el.onerror = () => { el.remove(); reject(new Error('CDN inaccessible : ' + src)); };
          document.head.appendChild(el);
        });
        if (window.Tesseract) return window.Tesseract;
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('Tesseract.js introuvable.');
  })().catch((e) => { tessPromise = null; throw e; }); // permet une nouvelle tentative
  return tessPromise;
}

async function killWorker() {
  const w = s?.worker;
  if (!w) return;
  s.worker = null;
  try { await w.terminate(); } catch { /* ignoré */ }
}

function setBusy(busy) {
  s.busy = busy;
  q('run').disabled = busy || !s.file;
  q('lang').disabled = busy;
  q('cancel').hidden = !busy;
}

async function run() {
  if (!s?.file || s.busy) return;
  const lang = LANGS.some((l) => l.value === q('lang').value) ? q('lang').value : DEFAULT_LANG;
  const token = ++s.runId;
  setBusy(true);
  setStatus('');
  setProgress(0, 'Chargement de Tesseract.js');
  try {
    const T = await loadTesseract();
    if (!s || token !== s.runId) return;
    const worker = await T.createWorker(lang, 1, {
      logger: (m) => {
        if (!s || token !== s.runId) return;
        setProgress(m.progress ?? 0, STATUS_FR[m.status] ?? m.status);
      },
    });
    if (!s || token !== s.runId) { await worker.terminate(); return; }
    s.worker = worker;
    const { data } = await worker.recognize(s.file);
    if (!s || token !== s.runId) return;
    q('text').value = data.text.trim();
    q('result').hidden = false;
    setStatus(data.text.trim()
      ? `Terminé — confiance moyenne : ${Math.round(data.confidence)} %`
      : 'Aucun texte détecté.');
    syncResultButtons();
  } catch (e) {
    if (s && token === s.runId) setStatus('Échec OCR : ' + (e?.message ?? e), true);
  } finally {
    if (s && token === s.runId) {
      await killWorker();
      hideProgress();
      setBusy(false);
    }
  }
}

function cancel() {
  if (!s?.busy) return;
  s.runId++; // invalide l'exécution en cours
  killWorker();
  hideProgress();
  setBusy(false);
  setStatus('Analyse annulée.');
}

function syncResultButtons() {
  const txt = q('text').value;
  const has = txt.length > 0;
  q('copy').disabled = !has;
  q('download').disabled = !has;
  q('download-md').disabled = !has;
  const words = txt.trim() ? txt.trim().split(/\s+/).length : 0;
  q('stats').textContent = `${words} mot${words > 1 ? 's' : ''} · ${txt.length} caractère${txt.length > 1 ? 's' : ''}`;
}

async function copyText() {
  const txt = q('text').value;
  try {
    await navigator.clipboard.writeText(txt);
  } catch {
    q('text').select(); // repli
    document.execCommand('copy');
  }
  setStatus('Texte copié.');
}

function revokeDownload() {
  if (s?.dlUrl) { URL.revokeObjectURL(s.dlUrl); s.dlUrl = null; }
}

function downloadText(ext = 'txt') {
  revokeDownload();
  const mime = ext === 'md' ? 'text/markdown' : 'text/plain';
  s.dlUrl = URL.createObjectURL(new Blob([q('text').value], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = s.dlUrl;
  a.download = `${baseName(s.file.name)}-ocr.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(revokeDownload, 10000);
}

function removeImage() {
  cancel();
  if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
  s.imgUrl = null; s.file = null;
  q('preview').removeAttribute('src');
  q('text').value = '';
  q('workarea').hidden = true;
  q('result').hidden = true;
  q('drop').hidden = false;
  q('input').value = '';
  setStatus('');
}

function onFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { setStatus('Fichier non image.', true); return; }
  cancel();
  if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
  s.file = file;
  s.imgUrl = URL.createObjectURL(file);
  q('preview').src = s.imgUrl;
  q('file-name').textContent = file.name;
  q('text').value = '';
  q('result').hidden = true;
  q('drop').hidden = true;
  q('workarea').hidden = false;
  setBusy(false);
  setStatus('');
}

export function mount(container, ctx) {
  s = { root: container, ctx, file: null, imgUrl: null, worker: null, runId: 0, busy: false, dlUrl: null, cleanups: [] };

  container.innerHTML = `
  <style>
    .ocr{display:grid;gap:1rem;font-family:var(--font-family,inherit)}
    .ocr-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;min-height:220px;
      border:2px dashed rgba(128,128,128,.5);border-radius:var(--radius,12px);cursor:pointer;text-align:center;padding:1rem}
    .ocr-drop.ocr-over{border-color:var(--primary,#4f46e5);background:rgba(79,70,229,.08)}
    .ocr-drop input{display:none}
    .ocr-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
    .ocr-bar select{padding:.5rem;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit}
    .ocr-btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.55rem .9rem;border:1px solid rgba(128,128,128,.5);
      border-radius:var(--radius,12px);background:transparent;color:inherit;font-weight:600;cursor:pointer}
    .ocr-btn.ocr-primary{background:var(--primary,#4f46e5);border-color:var(--primary,#4f46e5);color:#fff}
    .ocr-btn:disabled{opacity:.5;cursor:not-allowed}
    .ocr-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;align-items:start}
    @media(max-width:820px){.ocr-cols{grid-template-columns:1fr}}
    .ocr-box{border:1px solid rgba(128,128,128,.35);border-radius:var(--radius,12px);padding:.5rem}
    .ocr-box img{max-width:100%;max-height:60vh;display:block;margin:0 auto}
    .ocr-box textarea{width:100%;min-height:50vh;box-sizing:border-box;resize:vertical;padding:.5rem;border:0;outline:0;
      background:transparent;color:inherit;font:inherit}
    .ocr-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem}
    #ocr-progress{width:100%}
  </style>
  <div class="ocr">
    <label class="ocr-drop" id="ocr-drop">
      <i data-lucide="scan-text"></i>
      <strong>Glissez une image ici ou cliquez pour parcourir</strong>
      <input type="file" id="ocr-input" accept="image/*">
    </label>

    <div id="ocr-workarea" hidden style="display:grid;gap:1rem">
      <div class="ocr-bar">
        <span id="ocr-file-name"></span>
        <label>Langue
          <select id="ocr-lang">${LANGS.map((l) => `<option value="${l.value}"${l.value === DEFAULT_LANG ? ' selected' : ''}>${l.label}</option>`).join('')}</select>
        </label>
        <button class="ocr-btn ocr-primary" id="ocr-run" type="button"><i data-lucide="scan-text"></i>Lancer l'OCR</button>
        <button class="ocr-btn" id="ocr-cancel" type="button" hidden><i data-lucide="x"></i>Annuler</button>
        <button class="ocr-btn" id="ocr-remove" type="button"><i data-lucide="trash-2"></i>Supprimer</button>
      </div>
      <div><progress id="ocr-progress" max="1" value="0" hidden></progress><div id="ocr-progress-label"></div></div>

      <div class="ocr-cols">
        <div class="ocr-box"><img id="ocr-preview" alt="Image source"></div>
        <div id="ocr-result" hidden>
          <div class="ocr-box"><textarea id="ocr-text" spellcheck="false" aria-label="Texte extrait (éditable)"></textarea></div>
          <div id="ocr-stats" style="font-size:.85rem;opacity:.7;margin-top:.25rem"></div>
          <div class="ocr-actions">
            <button class="ocr-btn" id="ocr-copy" type="button"><i data-lucide="copy"></i>Copier</button>
            <button class="ocr-btn ocr-primary" id="ocr-download" type="button"><i data-lucide="download"></i>Télécharger (.txt)</button>
            <button class="ocr-btn ocr-primary" id="ocr-download-md" type="button"><i data-lucide="file-text"></i>Télécharger (.md)</button>
          </div>
        </div>
      </div>
    </div>
    <p id="ocr-status" role="status"></p>
  </div>`;

  const on = (el, ev, fn) => { el.addEventListener(ev, fn); s.cleanups.push(() => el.removeEventListener(ev, fn)); };

  const zone = q('drop'), input = q('input');
  on(input, 'change', () => onFile(input.files[0]));
  on(zone, 'dragover', (e) => { e.preventDefault(); zone.classList.add('ocr-over'); });
  on(zone, 'dragleave', () => zone.classList.remove('ocr-over'));
  on(zone, 'drop', (e) => { e.preventDefault(); zone.classList.remove('ocr-over'); onFile(e.dataTransfer.files[0]); });

  on(q('run'), 'click', run);
  on(q('cancel'), 'click', cancel);
  on(q('remove'), 'click', removeImage);
  on(q('copy'), 'click', copyText);
  on(q('download'), 'click', () => downloadText('txt'));
  on(q('download-md'), 'click', () => downloadText('md'));
  on(q('text'), 'input', syncResultButtons);

  refreshIcons();
}

export function unmount() {
  if (!s) return;
  s.runId++;
  killWorker();
  s.cleanups.forEach((fn) => fn());
  if (s.imgUrl) URL.revokeObjectURL(s.imgUrl);
  revokeDownload();
  s.root.innerHTML = '';
  s = null;
}
