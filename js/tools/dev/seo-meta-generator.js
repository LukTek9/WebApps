import { createWorkspace, setStats } from './tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field dev-tools__field--grow">Titre<input class="dev-tools__input" data-title maxlength="70" value="Ma page web"></label><label class="dev-tools__field dev-tools__field--grow">URL canonique<input class="dev-tools__input" data-url type="url" placeholder="https://exemple.fr/page"></label><label class="dev-tools__field dev-tools__field--grow">Image de partage<input class="dev-tools__input" data-image type="url" placeholder="https://exemple.fr/apercu.jpg"></label><label class="dev-tools__field">Langue<select class="dev-tools__select" data-locale><option value="fr_FR">Français</option><option value="en_US">Anglais</option><option value="es_ES">Espagnol</option></select></label><label class="dev-tools__field dev-tools__field--grow">Description<input class="dev-tools__input" data-description maxlength="160" value="Une description claire de votre page web."></label>';

function escapeAttribute(value) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function update() {
  const get = (name) => view.root.querySelector(`[data-${name}]`).value.trim();
  const title = get('title'), description = get('description'), url = get('url'), image = get('image'), locale = get('locale');
  const tags = [
    `<title>${escapeAttribute(title)}</title>`,
    `<meta name="description" content="${escapeAttribute(description)}">`,
    `<link rel="canonical" href="${escapeAttribute(url)}">`,
    '<meta name="robots" content="index, follow">',
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="${escapeAttribute(locale)}">`,
    `<meta property="og:title" content="${escapeAttribute(title)}">`,
    `<meta property="og:description" content="${escapeAttribute(description)}">`,
    ...(url ? [`<meta property="og:url" content="${escapeAttribute(url)}">`] : []),
    ...(image ? [`<meta property="og:image" content="${escapeAttribute(image)}">`] : []),
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeAttribute(title)}">`,
    `<meta name="twitter:description" content="${escapeAttribute(description)}">`,
    ...(image ? [`<meta name="twitter:image" content="${escapeAttribute(image)}">`] : []),
  ].join('\n');
  view.output.textContent = tags;
  const descriptionCount = description.length;
  view.status(url && !/^https?:\/\//i.test(url) ? 'L’URL canonique devrait commencer par https:// ou http://.' : 'Balises prêtes à intégrer dans <head>.', url && !/^https?:\/\//i.test(url) ? 'error' : 'success');
  setStats(view, [`Titre : ${title.length}/70`, `Description : ${descriptionCount}/160`, image ? 'Image sociale définie' : 'Sans image sociale']);
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Générateur de meta tags SEO', description: 'Composez des balises de référencement, canonical, Open Graph et Twitter avec aperçu du code généré.', sourceLabel: 'Informations de la page', outputLabel: 'Balises à placer dans <head>', sourcePlaceholder: 'Décrivez votre page dans les champs ci-dessus…', controls: CONTROLS });
  view.root.classList.add('dev-tools--single');
  view.source.hidden = true;
  view.source.closest('.dev-tools__panel').hidden = true;
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download') view.download(view.output.textContent, 'meta-seo.html', 'text/html;charset=utf-8');
  };
  view.root.addEventListener('input', view.onInput);
  view.root.addEventListener('change', view.onInput);
  view.root.addEventListener('click', view.onClick);
  update();
}

export function unmount() {
  if (!view) return;
  view.root.removeEventListener('input', view.onInput);
  view.root.removeEventListener('change', view.onInput);
  view.root.removeEventListener('click', view.onClick);
  view.dispose();
  view = null;
}
