import { createSecurityUI } from './shared/security-tool-ui.js';

const MAX_SOURCE_LENGTH = 100000;
const RENDER_DELAY_MS = 350;
const MERMAID_SOURCES = [
  'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs',
  'https://unpkg.com/mermaid@11.4.1/dist/mermaid.esm.min.mjs',
  'https://esm.sh/mermaid@11.4.1',
];

const EXAMPLES = {
  flowchart: `flowchart TD
  A[Début] --> B{Fichier valide ?}
  B -- Oui --> C[Traiter localement]
  B -- Non --> D[Afficher l’erreur]
  C --> E[Télécharger le résultat]
  D --> B`,
  sequence: `sequenceDiagram
  participant U as Utilisateur
  participant N as Navigateur
  U->>N: Dépose un fichier
  N->>N: Traitement local
  N-->>U: Résultat à télécharger`,
  gantt: `gantt
  title Planning du projet
  dateFormat YYYY-MM-DD
  section Conception
  Maquettes :a1, 2026-01-05, 7d
  section Développement
  Modules :after a1, 14d`,
  pie: `pie title Répartition du temps
  "Développement" : 55
  "Tests" : 25
  "Documentation" : 20`,
  class: `classDiagram
  class Outil {
    +string id
    +mount(container)
    +unmount()
  }
  Outil <|-- Convertisseur`,
  state: `stateDiagram-v2
  [*] --> Attente
  Attente --> Traitement : fichier ajouté
  Traitement --> Termine : succès
  Traitement --> Erreur : échec
  Termine --> [*]`,
};

let mermaidPromise = null;
let ui;
let timer = null;
let renderToken = 0;
let currentSvg = '';
let objectUrls = new Set();
let renderCount = 0;
let mountId = 0;

const CONTENT = `
  <div class="security-tools__panel">
    <label class="security-tools__field">Importer un fichier (.mmd, .mermaid, .txt)<input data-file type="file" accept=".mmd,.mermaid,.txt,text/plain"></label>
    <div class="security-tools__controls">
      <label class="security-tools__field">Exemple
        <select data-example>
          <option value="">— Choisir un exemple —</option>
          <option value="flowchart">Organigramme</option>
          <option value="sequence">Séquence</option>
          <option value="gantt">Diagramme de Gantt</option>
          <option value="pie">Camembert</option>
          <option value="class">Diagramme de classes</option>
          <option value="state">Diagramme d’états</option>
        </select>
      </label>
      <label class="security-tools__field">Thème
        <select data-theme>
          <option value="site">Thème du site</option>
          <option value="default">Mermaid clair</option>
          <option value="neutral">Neutre</option>
          <option value="forest">Forêt</option>
          <option value="dark">Sombre</option>
        </select>
      </label>
      <label class="security-tools__field">Échelle PNG
        <select data-scale>
          <option value="1">× 1</option>
          <option value="2" selected>× 2</option>
          <option value="3">× 3</option>
          <option value="4">× 4</option>
        </select>
      </label>
    </div>
    <label class="security-tools__field">Code Mermaid<textarea class="security-tools__textarea" data-source rows="12" spellcheck="false" placeholder="flowchart TD&#10;  A --> B"></textarea></label>
    <div class="security-tools__actions">
      <button class="btn-secondary" data-action="copy-code" type="button" disabled>Copier le code</button>
      <button class="btn-secondary" data-action="download-svg" type="button" disabled>Télécharger en SVG</button>
      <button class="btn-secondary" data-action="download-png" type="button" disabled>Télécharger en PNG</button>
      <button class="btn-secondary" data-action="clear" type="button">Effacer</button>
    </div>
  </div>
  <section class="security-tools__panel">
    <div class="security-tools__panel-heading"><div><h3>Aperçu du diagramme</h3><p data-summary>Saisissez du code Mermaid ou choisissez un exemple.</p></div></div>
    <div class="data-tools__table-wrap" data-preview role="img" aria-label="Aperçu du diagramme Mermaid"></div>
    <p class="security-tools__hint" data-error hidden></p>
    <p class="security-tools__hint">La bibliothèque Mermaid est chargée à la demande depuis un CDN public (bascule automatique sur des sources de secours). Le code de votre diagramme n’est jamais envoyé.</p>
  </section>`;

function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = (async () => {
    let lastError = null;
    for (const source of MERMAID_SOURCES) {
      try {
        const module = await import(/* @vite-ignore */ source);
        const mermaid = module.default || module.mermaid || module;
        if (typeof mermaid?.render === 'function') return mermaid;
      } catch (error) {
        lastError = error;
      }
    }
    mermaidPromise = null;
    throw new Error(`Bibliothèque Mermaid indisponible (réseau ou CDN bloqué)${lastError ? ` : ${lastError.message}` : ''}.`);
  })();
  return mermaidPromise;
}

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeConfig(choice) {
  if (choice !== 'site') return { theme: choice };
  return {
    theme: 'base',
    themeVariables: {
      background: token('--color-surface'),
      primaryColor: token('--color-surface-alt'),
      primaryTextColor: token('--color-text'),
      primaryBorderColor: token('--color-primary'),
      secondaryColor: token('--color-primary-soft'),
      tertiaryColor: token('--color-surface'),
      lineColor: token('--color-text-muted'),
      textColor: token('--color-text'),
      fontFamily: token('--font-family'),
    },
  };
}

function setButtons(enabled) {
  ui.root.querySelectorAll('[data-action]').forEach((button) => {
    if (button.dataset.action !== 'clear') button.disabled = !enabled;
  });
}

async function renderDiagram() {
  const activeUi = ui;
  const myToken = ++renderToken;
  const source = ui.query('[data-source]').value.trim();
  const preview = ui.query('[data-preview]');
  const summary = ui.query('[data-summary]');
  const errorBox = ui.query('[data-error]');
  if (!source) {
    currentSvg = '';
    preview.innerHTML = '';
    errorBox.hidden = true;
    summary.textContent = 'Saisissez du code Mermaid ou choisissez un exemple.';
    setButtons(false);
    return;
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    errorBox.hidden = false;
    errorBox.textContent = 'Le code dépasse la limite de 100 000 caractères.';
    setButtons(false);
    return;
  }
  summary.textContent = 'Rendu en cours…';
  const id = `mmd-${mountId}-${renderCount += 1}`;
  try {
    const mermaid = await loadMermaid();
    if (!activeUi.isActive() || myToken !== renderToken) return;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      flowchart: { htmlLabels: false },
      ...themeConfig(ui.query('[data-theme]').value),
    });
    await mermaid.parse(source);
    const { svg } = await mermaid.render(id, source);
    if (!activeUi.isActive() || myToken !== renderToken) return;
    currentSvg = svg;
    preview.innerHTML = svg;
    errorBox.hidden = true;
    summary.textContent = 'Diagramme généré localement.';
    setButtons(true);
  } catch (error) {
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
    if (!activeUi.isActive() || myToken !== renderToken) return;
    currentSvg = '';
    preview.innerHTML = '';
    summary.textContent = 'Le diagramme ne peut pas être rendu.';
    errorBox.hidden = false;
    errorBox.textContent = String(error?.message || error).split('\n').slice(0, 6).join('\n');
    setButtons(false);
    ui.root.querySelector('[data-action="copy-code"]').disabled = false;
  }
}

function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; renderDiagram(); }, RENDER_DELAY_MS);
}

function svgSize(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const viewBox = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) return { width: viewBox[2], height: viewBox[3], svg };
  const width = Number.parseFloat(svg.getAttribute('width')) || 800;
  const height = Number.parseFloat(svg.getAttribute('height')) || 600;
  return { width, height, svg };
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }, 1500);
}

async function exportPng() {
  const activeUi = ui;
  const scale = Math.min(Math.max(Number(ui.query('[data-scale]').value) || 2, 1), 4);
  const { width, height, svg } = svgSize(currentSvg);
  const maxSide = 16000;
  const factor = Math.min(scale, maxSide / Math.max(width, height));
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.removeAttribute('style');
  const serialized = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  objectUrls.add(url);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Conversion PNG impossible pour ce diagramme (essayez le SVG).'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * factor);
    canvas.height = Math.round(height * factor);
    const context = canvas.getContext('2d');
    context.fillStyle = token('--color-surface');
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Export PNG impossible.'))), 'image/png'));
    if (!activeUi.isActive()) return;
    saveBlob(blob, 'diagramme-mermaid.png');
    activeUi.setStatus('PNG exporté localement.', 'success');
    canvas.width = 0;
    canvas.height = 0;
  } finally {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Éditeur de diagrammes Mermaid',
    description: 'Écrivez du code Mermaid (organigrammes, séquences, Gantt…) et obtenez un aperçu instantané exportable en SVG ou PNG.',
    content: CONTENT,
  });
  mountId += 1;
  renderToken = 0;
  currentSvg = '';
  objectUrls = new Set();
  const activeUi = ui;
  setButtons(false);
  ui.on('input', (event) => {
    if (event.target.matches('[data-source]')) scheduleRender();
  });
  ui.on('change', async (event) => {
    if (event.target.matches('[data-example]')) {
      const code = EXAMPLES[event.target.value];
      if (code) { ui.query('[data-source]').value = code; scheduleRender(); }
      return;
    }
    if (event.target.matches('[data-theme]')) { scheduleRender(); return; }
    if (!event.target.matches('[data-file]')) return;
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_SOURCE_LENGTH) throw new Error('Le fichier dépasse la limite de 100 Ko.');
      const text = await file.text();
      if (!activeUi.isActive()) return;
      activeUi.query('[data-source]').value = text;
      scheduleRender();
      activeUi.setStatus(`${file.name} importé localement.`, 'success');
    } catch (error) {
      activeUi.setStatus(`Lecture impossible : ${error.message}`, 'error');
    }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'clear') {
      ui.query('[data-source]').value = '';
      ui.query('[data-file]').value = '';
      ui.query('[data-example]').value = '';
      scheduleRender();
      return;
    }
    if (action === 'copy-code') await ui.copy(ui.query('[data-source]').value, 'Code Mermaid copié.');
    if (!currentSvg) return;
    if (action === 'download-svg') ui.download(currentSvg, 'diagramme-mermaid.svg', 'image/svg+xml;charset=utf-8');
    if (action === 'download-png') {
      try { await exportPng(); } catch (error) { if (activeUi.isActive()) activeUi.setStatus(error.message, 'error'); }
    }
  });
}

export function unmount() {
  clearTimeout(timer);
  timer = null;
  renderToken += 1;
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
  currentSvg = '';
  document.querySelectorAll('[id^="dmmd-"], [id^="mmd-"]').forEach((node) => node.remove());
  ui?.destroy();
  ui = null;
}
