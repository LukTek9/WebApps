/**
 * app.js — Pilotage UI : grille de cartes, filtres, workspace, lazy loading des outils.
 */
import { categories, relatedTools, tools } from './tools.config.js';
import {
  animateHeroAndGrid,
  animateHomeEnter,
  animateToolContent,
  animateWorkspaceEnter,
  initCategoryScrollBg,
  initMobileHeaderAutoHide,
} from './animations.js';

const $ = (id) => document.getElementById(id);
const els = {
  home: $('home-view'),
  grid: $('tools-grid'),
  filters: $('filters'),
  workspace: $('workspace'),
  title: $('workspace-title'),
  body: $('workspace-body'),
  back: $('workspace-back'),
  related: $('related-tools'),
  relatedList: $('related-tools-list'),
  brand: $('brand-home'),
  search: $('tool-search'),
  searchInput: $('tool-search-input'),
  searchClear: $('tool-search-clear'),
  resultsCount: $('results-count'),
  catalogTitle: $('catalog-title'),
  heroToolCount: $('hero-tool-count'),
  empty: $('tools-empty'),
  reset: $('tools-reset'),
};

const state = { category: 'all', query: '', activeModule: null, loaded: new Map() };
const toolMotions = ['tilt', 'bounce', 'spin', 'pulse', 'swing', 'flip'];

/** Rafraîchit les icônes Lucide (no-op si CDN indisponible). */
const refreshIcons = () => window.lucide?.createIcons();

/** Couleur d'une catégorie (fallback neutre). */
const catColor = (id) => categories.find((c) => c.id === id)?.color ?? 'var(--cat-default)';

function setActiveThemeColor(categoryId) {
  const color = categoryId === 'all'
    ? 'var(--color-primary)'
    : categories.find((category) => category.id === categoryId)?.color ?? 'var(--color-primary)';
  document.documentElement.style.setProperty('--theme-accent', color);
}

/* ---------- Filtres ---------- */
function renderFilters() {
  els.filters.innerHTML = '';
  for (const cat of categories) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-btn' + (cat.id === state.category ? ' is-active' : '');
    btn.style.setProperty('--filter-color', cat.id === 'all' ? 'var(--color-primary)' : cat.color);
    btn.setAttribute('aria-pressed', String(cat.id === state.category));
    const icon = document.createElement('i');
    icon.className = 'filter-btn__icon';
    icon.setAttribute('data-lucide', cat.icon ?? (cat.id === 'all' ? 'layers' : 'audio-lines'));
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'filter-btn__label';
    label.textContent = cat.label;
    const count = document.createElement('span');
    count.className = 'filter-btn__count';
    count.textContent = String(cat.id === 'all' ? tools.length : tools.filter((tool) => tool.category === cat.id).length);
    btn.append(icon, label, count);
    btn.addEventListener('click', () => {
      state.category = cat.id;
      setActiveThemeColor(state.category);
      renderFilters();
      renderGrid();
      window.scrollTo({
        top: 0,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    });
    els.filters.appendChild(btn);
  }
}

function motionForTool(id) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return toolMotions[hash % toolMotions.length];
}

function createToolCard(tool) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'tool-card';
  card.style.setProperty('--tool-color', catColor(tool.category));
  card.dataset.motion = motionForTool(tool.id);

  const icon = document.createElement('span');
  icon.className = 'tool-card__icon';
  const iconElement = document.createElement('i');
  iconElement.setAttribute('data-lucide', tool.icon);
  icon.appendChild(iconElement);

  const title = document.createElement('span');
  title.className = 'tool-card__title';
  title.textContent = tool.name;

  const desc = document.createElement('span');
  desc.className = 'tool-card__desc';
  desc.textContent = tool.description;

  card.append(icon, title, desc);
  card.addEventListener('click', () => openTool(tool.id));
  return card;
}

/* ---------- Recherche floue ---------- */
const STOP_WORDS = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'en', 'au', 'aux', 'vos', 'votre', 'pour', 'a', 'l', 'd']);

/** Synonymes de catégories (sans accents, minuscules). */
const CATEGORY_SYNONYMS = {
  audio: 'son sons musique music sound mp3 voix micro wav',
  video: 'film clip mp4 movie webm',
  image: 'photo photos picture img png jpg jpeg webp illustration',
  pdf: 'document documents doc fichier papier',
  text: 'texte redaction ecriture mot mots writing article',
  dev: 'developpement developpeur code programmation web developer programming html css javascript',
  security: 'securite crypto chiffrement cryptage password protection confidentialite',
  utils: 'utilitaire utilitaires productivite outil tools productivity',
  color: 'couleur couleurs design palette graphisme',
  data: 'donnees fichiers base tableur csv json',
  calc: 'calcul calculs conversion conversions calculatrice math convertir',
};

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
const toWords = (value) => fold(value).split(/[^a-z0-9]+/).filter(Boolean);

/** Levenshtein borné : renvoie max + 1 dès que la distance dépasse `max`. */
function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

/** Score d'un token de requête contre un mot (0 = aucun match). */
function wordScore(token, word) {
  if (word === token) return 1;
  if (word.startsWith(token)) return 0.85;
  if (token.length >= 3 && word.includes(token)) return 0.6;
  if (token.length < 4) return 0;
  const max = token.length >= 8 ? 3 : token.length >= 5 ? 2 : 1;
  const dist = Math.min(levenshtein(token, word, max), levenshtein(token, word.slice(0, token.length), max));
  return dist <= max ? 0.55 - 0.1 * dist : 0;
}

const searchIndex = new Map();
function getSearchIndex(tool) {
  let idx = searchIndex.get(tool.id);
  if (idx) return idx;
  const category = categories.find((cat) => cat.id === tool.category);
  const catText = `${category?.label ?? ''} ${CATEGORY_SYNONYMS[tool.category] ?? ''}`;
  const keywords = Array.isArray(tool.keywords) ? tool.keywords.join(' ') : (tool.tags ?? tool.keywords ?? '');
  idx = {
    nameFold: fold(tool.name),
    hayFold: fold(`${tool.name} ${tool.description} ${category?.label ?? ''} ${keywords}`),
    fields: [
      [toWords(tool.name), 10],
      [toWords(`${tool.id} ${keywords}`), 6],
      [toWords(catText), 5],
      [toWords(tool.description), 2],
    ],
  };
  searchIndex.set(tool.id, idx);
  return idx;
}

/** Prépare la requête ; null si vide. */
function buildQuery(raw) {
  const folded = fold(raw).trim();
  if (!folded) return null;
  const all = toWords(folded);
  const tokens = all.filter((word) => !STOP_WORDS.has(word));
  return { fold: folded, tokens: tokens.length ? tokens : all };
}

/** Score de pertinence d'un outil (0 = exclu). Sous-chaîne exacte > préfixe/mot > fuzzy. */
function scoreTool(tool, q) {
  if (!q.tokens.length) return 0;
  const idx = getSearchIndex(tool);
  let total = 0;
  for (const token of q.tokens) {
    let best = 0;
    for (const [words, weight] of idx.fields) {
      for (const word of words) {
        const score = wordScore(token, word) * weight;
        if (score > best) best = score;
      }
    }
    if (!best) return 0;
    total += best;
  }
  if (idx.nameFold.includes(q.fold)) total += idx.nameFold.startsWith(q.fold) ? 120 : 100;
  else if (idx.hayFold.includes(q.fold)) total += 50;
  return total;
}

/* ---------- Grille ---------- */
function renderGrid() {
  els.grid.innerHTML = '';
  const activeCategory = categories.find((cat) => cat.id === state.category);
  els.home.classList.toggle('is-category-view', state.category !== 'all');
  els.catalogTitle.textContent = state.category === 'all'
    ? 'Explorez les outils'
    : `Outils ${activeCategory?.label ?? ''}`.trim();
  const q = buildQuery(state.query);
  const scores = new Map();
  // Tri stable par ordre des catégories (config) ; ordre relatif conservé dans chaque catégorie
  const catRank = (id) => {
    const idx = categories.findIndex((c) => c.id === id);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  const visible = tools
    .map((t, i) => ({ t, i, s: q ? scoreTool(t, q) : 1 }))
    .filter(({ t, s }) => (state.category === 'all' || t.category === state.category) && s > 0)
    .sort(q
      ? (a, b) => b.s - a.s || a.i - b.i
      : (a, b) => catRank(a.t.category) - catRank(b.t.category) || a.i - b.i)
    .map(({ t, s }) => { scores.set(t.id, s); return t; });
  // Sections triées par meilleur score quand une requête est active (tri stable sinon)
  const orderedCats = categories.filter(({ id }) => id !== 'all');
  if (q) {
    const bestByCat = new Map();
    for (const tool of visible) bestByCat.set(tool.category, Math.max(bestByCat.get(tool.category) ?? 0, scores.get(tool.id)));
    orderedCats.sort((a, b) => (bestByCat.get(b.id) ?? 0) - (bestByCat.get(a.id) ?? 0));
  }

  if (state.category === 'all') {
    for (const category of orderedCats) {
      const categoryTools = visible.filter((tool) => tool.category === category.id);
      if (!categoryTools.length) continue;

      const section = document.createElement('section');
      section.className = 'category-section';
      section.dataset.category = category.id;
      section.style.setProperty('--category-color', category.color);

      const heading = document.createElement('div');
      heading.className = 'category-section__heading';
      const title = document.createElement('h3');
      title.className = 'category-section__title';
      title.textContent = category.label;
      const count = document.createElement('span');
      count.className = 'category-section__count';
      count.textContent = `${categoryTools.length} ${categoryTools.length === 1 ? 'outil' : 'outils'}`;
      heading.append(title, count);

      const grid = document.createElement('div');
      grid.className = 'tools-grid';
      categoryTools.forEach((tool) => grid.appendChild(createToolCard(tool)));
      section.append(heading, grid);
      els.grid.appendChild(section);
    }
  } else {
    const grid = document.createElement('div');
    grid.className = 'tools-grid';
    visible.forEach((tool) => grid.appendChild(createToolCard(tool)));
    els.grid.appendChild(grid);
  }
  const resultLabel = visible.length === 1 ? 'outil' : 'outils';
  els.resultsCount.textContent = `${visible.length} ${resultLabel}`;
  els.heroToolCount.textContent = state.category === 'all' && !q
    ? `${tools.length} outils gratuits`
    : `${visible.length} ${resultLabel} ${state.category === 'all' ? 'trouvés' : 'dans cette catégorie'}`;
  els.empty.hidden = visible.length > 0;
  els.grid.hidden = visible.length === 0;
  refreshIcons();
  animateHeroAndGrid(els.home);
  initCategoryScrollBg(state.category === 'all' ? els.home : null);
}

/* ---------- Workspace ---------- */
function showStatus(message, isError = false) {
  els.body.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'workspace__status' + (isError ? ' is-error' : '');
  p.textContent = message;
  els.body.appendChild(p);
}

/* ---------- Outils associés (panneau droit, version PC) ---------- */
const RELATED_MAX = 6;
/** Relations curées rendues symétriques : A → B implique B → A. */
const relatedMap = (() => {
  const map = new Map(tools.map((t) => [t.id, []]));
  const link = (a, b) => { if (map.has(a) && map.has(b) && a !== b && !map.get(a).includes(b)) map.get(a).push(b); };
  Object.entries(relatedTools).forEach(([id, list]) => list.forEach((other) => link(id, other)));
  Object.entries(relatedTools).forEach(([id, list]) => list.forEach((other) => link(other, id)));
  return map;
})();

function getRelated(tool) {
  const ids = [...(relatedMap.get(tool.id) || [])];
  for (const t of tools) { // complément : même catégorie
    if (ids.length >= RELATED_MAX) break;
    if (t.category === tool.category && t.id !== tool.id && !ids.includes(t.id)) ids.push(t.id);
  }
  return ids.slice(0, RELATED_MAX).map((rid) => tools.find((t) => t.id === rid)).filter(Boolean);
}

function renderRelated(tool) {
  const list = getRelated(tool);
  els.relatedList.replaceChildren(...list.map((t) => {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'related-tools__link';
    link.href = `#${t.id}`;
    link.dataset.toolId = t.id;
    link.style.setProperty('--tool-color', catColor(t.category));
    const icon = document.createElement('span');
    icon.className = 'related-tools__icon';
    icon.setAttribute('aria-hidden', 'true');
    const i = document.createElement('i');
    i.setAttribute('data-lucide', t.icon);
    icon.appendChild(i);
    const label = document.createElement('span');
    label.className = 'related-tools__label';
    label.textContent = t.name;
    link.setAttribute('aria-label', t.name);
    link.append(icon, label);
    li.appendChild(link);
    return li;
  }));
  els.related.hidden = !list.length;
}

els.relatedList.addEventListener('click', (event) => {
  const link = event.target.closest('[data-tool-id]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return; // nouvel onglet : comportement natif
  event.preventDefault();
  if (link.dataset.toolId === state.activeToolId) return;
  try { state.activeModule?.unmount?.(); } catch (err) { console.error(err); }
  state.activeModule = null;
  openTool(link.dataset.toolId);
});

async function openTool(id) {
  const tool = tools.find((t) => t.id === id);
  if (!tool) return;

  state.activeToolId = id;
  renderRelated(tool);
  setActiveThemeColor(tool.category);
  els.home.hidden = true;
  els.workspace.hidden = false;
  initCategoryScrollBg(null);
  animateWorkspaceEnter(els.workspace);
  els.title.textContent = tool.name;
  showStatus('Chargement…');
  window.scrollTo({ top: 0 });
  history.replaceState(null, '', `#${id}`);

  try {
    // Lazy loading : import dynamique, mis en cache après le 1er chargement
    if (!state.loaded.has(id)) state.loaded.set(id, await tool.module());
    const mod = state.loaded.get(id);
    els.body.innerHTML = '';
    await mod.mount(els.body, { tool });
    state.activeModule = mod;
    refreshIcons();
    animateToolContent(els.body);
  } catch (err) {
    console.error(`[tool:${id}]`, err);
    state.loaded.delete(id);
    showStatus(`Impossible de charger l'outil « ${tool.name} ». ${err.message ?? ''}`, true);
  }
}

function closeTool() {
  try { state.activeModule?.unmount?.(); } catch (err) { console.error(err); }
  state.activeModule = null;
  state.activeToolId = null;
  els.related.hidden = true;
  setActiveThemeColor(state.category);
  els.body.innerHTML = '';
  els.workspace.hidden = true;
  els.home.hidden = false;
  animateHomeEnter(els.home);
  initCategoryScrollBg(state.category === 'all' ? els.home : null);
  history.replaceState(null, '', location.pathname);
}

/* ---------- Init ---------- */
setActiveThemeColor(state.category);
els.back.addEventListener('click', closeTool);
els.brand.addEventListener('click', closeTool);
els.search.addEventListener('submit', (event) => event.preventDefault());
els.searchInput.addEventListener('input', () => {
  state.query = els.searchInput.value;
  els.searchClear.hidden = !state.query;
  renderGrid();
});
els.searchClear.addEventListener('click', () => {
  els.searchInput.value = '';
  state.query = '';
  els.searchClear.hidden = true;
  renderGrid();
  els.searchInput.focus();
});
els.reset.addEventListener('click', () => {
  state.category = 'all';
  setActiveThemeColor(state.category);
  state.query = '';
  els.searchInput.value = '';
  els.searchClear.hidden = true;
  renderFilters();
  renderGrid();
  els.searchInput.focus();
});
document.addEventListener('keydown', (event) => {
  const target = event.target;
  const isTyping = target instanceof HTMLElement
    && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (event.key === '/' && !isTyping && !els.home.hidden) {
    event.preventDefault();
    els.searchInput.focus();
  }
  if (event.key === 'Escape' && document.activeElement === els.searchInput) {
    els.searchClear.click();
  }
});

renderFilters();
renderGrid();
initMobileHeaderAutoHide(document.querySelector('.site-header'));

/* Hauteur du header sticky → --site-header-h (position sticky du panneau « Outils associés »). */
{
  const siteHeader = document.querySelector('.site-header');
  const syncHeaderHeight = () => document.documentElement.style.setProperty('--site-header-h', `${siteHeader.offsetHeight}px`);
  if (siteHeader) {
    syncHeaderHeight();
    new ResizeObserver(syncHeaderHeight).observe(siteHeader);
  }
}

// Deep link : index.html#<tool-id>
const hashId = location.hash.slice(1);
if (hashId) openTool(hashId);
