const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function parseSvg(source) {
  if (!String(source).trim()) throw new Error('Collez ou importez un fichier SVG.');
  const documentNode = new DOMParser().parseFromString(source, 'image/svg+xml');
  const parserError = documentNode.querySelector('parsererror');
  if (parserError) throw new Error(`SVG XML invalide : ${parserError.textContent.trim()}`);
  const root = documentNode.documentElement;
  if (root.localName?.toLowerCase() !== 'svg') throw new Error('Le document doit avoir un élément racine <svg>.');
  if (root.namespaceURI && root.namespaceURI !== SVG_NAMESPACE) throw new Error('L’espace de noms du document n’est pas SVG.');
  if (!root.hasAttribute('xmlns')) root.setAttribute('xmlns', SVG_NAMESPACE);
  return documentNode;
}

function isLocalReference(value) {
  const reference = value.trim();
  return reference.startsWith('#') || /^data:image\/(?:png|jpeg|webp|gif|avif);/i.test(reference);
}

function sanitizeReferenceFunctions(value) {
  return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (match, doubleQuoted, singleQuoted, plain) => {
    const target = doubleQuoted ?? singleQuoted ?? plain ?? '';
    return isLocalReference(target) ? match : 'none';
  });
}

export function sanitizeSvg(source) {
  const documentNode = parseSvg(source);
  documentNode.doctype?.remove();
  for (const element of [...documentNode.querySelectorAll('*')]) {
    if (['script', 'foreignobject', 'iframe', 'object', 'embed', 'link'].includes(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
      } else if (attribute.localName.toLowerCase() === 'href' && !isLocalReference(value)) {
        element.removeAttribute(attribute.name);
      } else if (name === 'style' && /@import/i.test(value)) {
        element.removeAttribute(attribute.name);
      } else if (/\burl\s*\(/i.test(value)) {
        element.setAttribute(attribute.name, sanitizeReferenceFunctions(value));
      }
    }
  }
  for (const style of [...documentNode.querySelectorAll('style')]) {
    if (/@import/i.test(style.textContent)) {
      style.remove();
    } else {
      style.textContent = sanitizeReferenceFunctions(style.textContent);
    }
  }
  return documentNode;
}

export function svgDimensions(root) {
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[,\s]+/).map(Number);
  const viewWidth = viewBox?.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : 0;
  const viewHeight = viewBox?.length === 4 && Number.isFinite(viewBox[3]) ? viewBox[3] : 0;
  const readAbsolute = (value) => {
    const match = value?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
    return match ? Number(match[1]) : 0;
  };
  const width = readAbsolute(root.getAttribute('width')) || viewWidth || 512;
  const height = readAbsolute(root.getAttribute('height')) || viewHeight || 512;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('La largeur et la hauteur du SVG doivent être positives.');
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

export function serializeSvg(documentNode) {
  return new XMLSerializer().serializeToString(documentNode);
}
