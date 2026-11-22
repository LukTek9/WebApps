import { bindDropzone, createDropzone, createSecurityUI } from '../shared/security-tool-ui.js';

let ui;
let cameraStream = null;
let scanInterval = null;
let previewUrl = null;
let detector = null;
let scanning = false;
let result = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      ${createDropzone({ id: 'image', title: 'Glissez-déposez une image QR ici', hint: 'ou cliquez pour parcourir · PNG, JPEG, WebP…', accept: 'image/*', label: 'Choisir une image QR' })}
      <div class="security-tools__actions"><button class="btn-primary" data-action="camera-start" type="button">Démarrer la caméra</button><button class="btn-secondary" data-action="camera-stop" type="button" disabled>Arrêter la caméra</button></div>
      <div class="utility-tools__scanner-stage"><img data-preview alt="Aperçu de l’image sélectionnée" hidden><video data-video playsinline muted hidden></video></div>
      <p class="security-tools__hint">Le décodage utilise l’API BarcodeDetector du navigateur. La caméra nécessite votre autorisation et une connexion sécurisée (HTTPS ou localhost).</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Contenu détecté</h3><p>Un QR peut contenir un lien, du texte ou d’autres données.</p></div></div>
      <pre class="security-tools__result" data-result aria-live="polite">Aucun QR code détecté.</pre>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier le résultat</button><button class="btn-secondary" data-action="download" type="button">Télécharger</button></div>
    </section>
  </div>`;

async function createDetector() {
  if (typeof window.BarcodeDetector !== 'function') {
    throw new Error('La détection QR n’est pas prise en charge par ce navigateur. Essayez un navigateur compatible avec BarcodeDetector.');
  }
  const supported = await window.BarcodeDetector.getSupportedFormats?.();
  if (supported && !supported.includes('qr_code')) throw new Error('Ce navigateur ne prend pas en charge le format QR code.');
  return new window.BarcodeDetector({ formats: ['qr_code'] });
}

function setResult(codes) {
  const text = codes.map((code) => code.rawValue).filter(Boolean).join('\n');
  result = text;
  ui.query('[data-result]').textContent = text || 'Aucun QR code détecté.';
  if (text) ui.setStatus(`${codes.length} QR code(s) détecté(s).`, 'success');
  else ui.setStatus('Aucun QR code détecté dans cette image.', 'muted');
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  const preview = ui.query('[data-preview]');
  preview.removeAttribute('src');
  preview.hidden = true;
}

function stopCamera() {
  if (ui && scanInterval !== null) ui.clearInterval(scanInterval);
  scanInterval = null;
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  scanning = false;
  if (ui) {
    const video = ui.query('[data-video]');
    video.pause();
    video.srcObject = null;
    video.hidden = true;
    ui.query('[data-action="camera-start"]').disabled = false;
    ui.query('[data-action="camera-stop"]').disabled = true;
  }
}

async function scanVideo() {
  if (!ui?.isActive() || scanning || !cameraStream || ui.query('[data-video]').readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const activeUi = ui;
  scanning = true;
  try {
    const codes = await detector.detect(activeUi.query('[data-video]'));
    if (codes.length) {
      const next = codes.map((code) => code.rawValue).filter(Boolean).join('\n');
      if (activeUi.isActive() && next !== result) setResult(codes);
    }
  } catch (error) {
    if (activeUi.isActive()) {
      stopCamera();
      activeUi.setStatus(`Lecture caméra impossible : ${error.message}`, 'error');
    }
  } finally {
    scanning = false;
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Lecteur / Scanneur QR',
    description: 'Lisez des QR codes depuis une image ou la caméra, directement dans le navigateur.',
    content: CONTENT,
  });
  detector = null;
  result = '';
  bindDropzone(ui, {
    id: 'image',
    onFiles: async ([file]) => {
      const activeUi = ui;
      stopCamera();
      clearPreview();
      result = '';
      ui.query('[data-result]').textContent = 'Analyse de l’image…';
      try {
        previewUrl = URL.createObjectURL(file);
        const preview = ui.query('[data-preview]');
        preview.src = previewUrl;
        preview.hidden = false;
        const fileDetector = detector || await createDetector();
        if (!activeUi.isActive()) return;
        detector = fileDetector;
        const image = await createImageBitmap(file);
        if (!activeUi.isActive()) { image.close(); return; }
        try {
          const codes = await fileDetector.detect(image);
          if (activeUi.isActive()) setResult(codes);
        }
        finally { image.close(); }
      } catch (error) {
        if (activeUi.isActive()) activeUi.setStatus(`Impossible de lire cette image : ${error.message}`, 'error');
      }
    },
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'camera-start') {
      const activeUi = ui;
      let requestedStream = null;
      try {
        ui.query('[data-action="camera-start"]').disabled = true;
        const cameraDetector = detector || await createDetector();
        if (!activeUi.isActive()) return;
        detector = cameraDetector;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('La caméra n’est pas disponible dans ce navigateur ou ce contexte.');
        stopCamera();
        activeUi.query('[data-action="camera-start"]').disabled = true;
        requestedStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!activeUi.isActive()) {
          requestedStream.getTracks().forEach((track) => track.stop());
          return;
        }
        cameraStream = requestedStream;
        const video = activeUi.query('[data-video]');
        video.srcObject = cameraStream;
        video.hidden = false;
        await video.play();
        if (!activeUi.isActive()) {
          requestedStream.getTracks().forEach((track) => track.stop());
          return;
        }
        clearPreview();
        result = '';
        activeUi.query('[data-result]').textContent = 'Aucun QR code détecté.';
        activeUi.query('[data-action="camera-stop"]').disabled = false;
        scanInterval = activeUi.setInterval(scanVideo, 400);
        activeUi.setStatus('Caméra active. Présentez un QR code devant l’objectif.', 'success');
      } catch (error) {
        requestedStream?.getTracks().forEach((track) => track.stop());
        if (activeUi.isActive()) {
          stopCamera();
          activeUi.setStatus(`Démarrage de la caméra impossible : ${error.message}`, 'error');
        }
      }
    }
    if (action === 'camera-stop') stopCamera();
    if (action === 'copy') {
      if (result) await ui.copy(result, 'Contenu QR copié.');
      else ui.setStatus('Aucun contenu à copier.', 'error');
    }
    if (action === 'download') {
      if (result) ui.download(`${result}\n`, 'contenu-qr.txt');
      else ui.setStatus('Aucun contenu à télécharger.', 'error');
    }
  });
}

export function unmount() {
  stopCamera();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  ui?.destroy();
  ui = null;
  detector = null;
  result = '';
}
