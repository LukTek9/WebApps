import { bindDropzone, createDropzone, createSecurityUI } from '../shared/security-tool-ui.js';
import { sanitizeSvg, serializeSvg } from '../shared/svg-utils.js';

let ui;
let output = '';
let fileName = 'image.svg';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      ${createDropzone({ id: 'svg', title: 'Glissez-déposez un SVG ici', hint: 'ou cliquez pour parcourir · fichier .svg', accept: '.svg,image/svg+xml', label: 'Importer un SVG' })}
      <label class="security-tools__field">Code SVG<textarea class="security-tools__textarea color-tools__svg-source" data-source rows="13" spellcheck="false" placeholder="Collez votre balisage <svg>…"></textarea></label>
      <div class="security-tools__actions"><button class="btn-primary" data-action="optimize" type="button">Optimiser le SVG</button><button class="btn-secondary" data-action="copy" type="button">Copier le SVG</button><button class="btn-secondary" data-action="download" type="button">Télécharger le SVG</button></div>
      <p class="security-tools__hint" data-size>Les éléments actifs et références externes sont retirés avec les commentaires et métadonnées.</p>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Résultat optimisé</h3><p>Éléments actifs, commentaires et métadonnées retirés, nombres géométriques arrondis à deux décimales.</p></div></div>
      <pre class="security-tools__result color-tools__svg-output" data-output></pre>
    </section>
  </div>`;

function roundGeometry(value) {
  return value.replace(/-?\d+\.\d{3,}/g, (number) => String(Number(Number(number).toFixed(2))));
}

function optimizeSvg(source) {
  const documentNode = sanitizeSvg(source);
  const walker = documentNode.createTreeWalker(documentNode, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((comment) => comment.remove());
  documentNode.querySelectorAll('metadata').forEach((element) => element.remove());
  const root = documentNode.documentElement;
  const textContainers = new Set(['text', 'tspan', 'textpath']);
  const pruneWhitespace = (node, insideText = false) => {
    const preserve = insideText || textContainers.has(node.localName?.toLowerCase());
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE && !preserve && !child.textContent.trim()) child.remove();
      else if (child.nodeType === Node.ELEMENT_NODE) pruneWhitespace(child, preserve);
    }
  };
  pruneWhitespace(root);
  const geometryAttributes = new Set(['d', 'points', 'viewbox', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'stroke-width', 'stroke-dasharray', 'transform']);
  root.querySelectorAll('*').forEach((element) => {
    if (element.localName.toLowerCase() === 'g' && !element.children.length && !element.textContent.trim()) {
      element.remove();
      return;
    }
    for (const attribute of [...element.attributes]) {
      if (geometryAttributes.has(attribute.name.toLowerCase())) attribute.value = roundGeometry(attribute.value);
    }
  });
  return serializeSvg(documentNode);
}

function render() {
  try {
    const source = ui.query('[data-source]').value;
    if (!source.trim()) throw new Error('Collez ou importez un SVG avant de lancer l’optimisation.');
    output = optimizeSvg(source);
    ui.query('[data-output]').textContent = output;
    const before = new TextEncoder().encode(source).length;
    const after = new TextEncoder().encode(output).length;
    const delta = before ? Math.round((1 - after / before) * 100) : 0;
    ui.query('[data-size]').textContent = `${before} → ${after} octets · ${delta >= 0 ? `${delta} % plus léger` : `${Math.abs(delta)} % plus volumineux`}`;
    ui.setStatus('SVG optimisé localement.', 'success');
  } catch (error) {
    output = '';
    ui.query('[data-output]').textContent = '';
    ui.setStatus(error.message, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Optimiseur SVG',
    description: 'Optimisez un SVG localement en retirant les éléments actifs, références externes, commentaires et métadonnées.',
    content: CONTENT,
  });
  fileName = 'image.svg';
  output = '';
  bindDropzone(ui, {
    id: 'svg',
    onFiles: async ([file]) => {
      const activeUi = ui;
      try {
        const source = await file.text();
        if (!activeUi.isActive()) return;
        fileName = file.name.replace(/[\\/:*?"<>|]/g, '-') || 'image.svg';
        activeUi.query('[data-source]').value = source;
        render();
      } catch (error) {
        if (activeUi.isActive()) activeUi.setStatus(`Lecture du fichier impossible : ${error.message}`, 'error');
      }
    },
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'optimize') render();
    if (action === 'copy') {
      if (output) await ui.copy(output, 'SVG optimisé copié.');
      else ui.setStatus('Optimisez un SVG valide avant de le copier.', 'error');
    }
    if (action === 'download') {
      if (output) ui.download(`${output}\n`, fileName, 'image/svg+xml;charset=utf-8');
      else ui.setStatus('Optimisez un SVG valide avant le téléchargement.', 'error');
    }
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  output = '';
  fileName = 'image.svg';
}
