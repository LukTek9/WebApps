import { bindDropzone, createDropzone, createSecurityUI, escapeHtml } from './security-tool-ui.js';
import { readJpegExif } from './exif-utils.js';

let ui;
let report = '';
let fileName = 'metadonnees.json';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      ${createDropzone({ id: 'image', title: 'Glissez-déposez une image JPEG ici', hint: 'ou cliquez pour parcourir · .jpg, .jpeg', accept: '.jpg,.jpeg,image/jpeg', label: 'Choisir une image JPEG' })}
      <p class="security-tools__hint">Seuls les fichiers JPEG sont pris en charge. La lecture se fait sur cet appareil; les données de localisation restent visibles dans les résultats.</p>
      <div class="security-tools__actions">
        <button class="btn-secondary" data-action="copy" type="button" disabled>Copier les métadonnées JSON</button>
        <button class="btn-secondary" data-action="download" type="button" disabled>Télécharger les métadonnées</button>
      </div>
      <div class="security-tools__stats" data-summary></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Métadonnées trouvées</h3><p data-caption>Choisissez une image pour commencer.</p></div></div>
      <div class="data-tools__table-wrap">
        <table class="data-tools__table" data-table hidden>
          <thead><tr><th scope="col">Groupe</th><th scope="col">Champ</th><th scope="col">Valeur</th></tr></thead>
          <tbody data-rows></tbody>
        </table>
      </div>
      <pre class="security-tools__result" data-output hidden></pre>
    </section>
  </div>`;

function showResult(file, parsed) {
  const { metadata, location } = parsed;
  const payload = {
    fichier: file.name,
    taille: file.size,
    metadonnees: metadata,
    ...(location ? { localisation: location } : {}),
  };
  report = JSON.stringify(payload, null, 2);
  const rows = [...metadata];
  if (location) {
    rows.push({ group: 'GPS', label: 'Latitude', value: location.latitude });
    rows.push({ group: 'GPS', label: 'Longitude', value: location.longitude });
    if (location.altitude !== null) rows.push({ group: 'GPS', label: 'Altitude (m)', value: location.altitude });
  }
  ui.query('[data-summary]').innerHTML = [
    ['Fichier', file.name],
    ['Taille', `${(file.size / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Ko`],
    ['Champs EXIF', metadata.length],
    ['GPS', location ? 'Présent' : 'Absent'],
  ].map(([label, value]) => `<article class="security-tools__stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
  ui.query('[data-rows]').innerHTML = rows.length
    ? rows.map((item) => `<tr><td>${escapeHtml(item.group)}</td><th scope="row">${escapeHtml(item.label)}</th><td>${escapeHtml(item.value)}</td></tr>`).join('')
    : '<tr><td colspan="3">Aucune balise EXIF reconnue dans ce fichier.</td></tr>';
  ui.query('[data-table]').hidden = false;
  ui.query('[data-output]').textContent = report;
  ui.query('[data-output]').hidden = false;
  ui.query('[data-caption]').textContent = location ? 'Des coordonnées GPS sont présentes dans ce fichier.' : 'Les métadonnées sont affichées et exportables en JSON.';
  ui.query('[data-action="copy"]').disabled = false;
  ui.query('[data-action="download"]').disabled = false;
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Lecteur de métadonnées EXIF',
    description: 'Consultez les informations techniques et de localisation intégrées aux images JPEG.',
    content: CONTENT,
  });
  report = '';
  fileName = 'metadonnees.json';
  bindDropzone(ui, {
    id: 'image',
    onFiles: async ([file]) => {
      const activeUi = ui;
      report = '';
      activeUi.query('[data-action="copy"]').disabled = true;
      activeUi.query('[data-action="download"]').disabled = true;
      activeUi.query('[data-table]').hidden = true;
      activeUi.query('[data-output]').hidden = true;
      try {
        if (file.size > 50000000) throw new Error('Le fichier dépasse la limite de 50 Mo.');
        if (file.type && file.type !== 'image/jpeg' && !/\.jpe?g$/i.test(file.name)) {
          throw new Error('Choisissez un fichier JPEG valide.');
        }
        const parsed = readJpegExif(await file.arrayBuffer());
        if (!activeUi.isActive()) return;
        fileName = `${file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-') || 'image'}-metadonnees.json`;
        showResult(file, parsed);
        activeUi.setStatus(`${parsed.metadata.length} champ(s) EXIF lu(s) localement.`, 'success');
      } catch (error) {
        if (activeUi.isActive()) activeUi.setStatus(error.message, 'error');
      }
    },
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy' && report) await ui.copy(report, 'Métadonnées copiées.');
    if (action === 'download' && report) ui.download(report, fileName, 'application/json;charset=utf-8');
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
  fileName = 'metadonnees.json';
}
