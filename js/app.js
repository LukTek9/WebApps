/**
 * app.js — Pilotage UI : grille de cartes, filtres, workspace, lazy loading des outils.
 */
import { categories, tools } from './tools.config.js';
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

/* ---------- Grille ---------- */
function renderGrid() {
  els.grid.innerHTML = '';
  const activeCategory = categories.find((cat) => cat.id === state.category);
  els.home.classList.toggle('is-category-view', state.category !== 'all');
  els.catalogTitle.textContent = state.category === 'all'
    ? 'Explorez les outils'
    : `Outils ${activeCategory?.label ?? ''}`.trim();
  const normalize = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
  const query = normalize(state.query.trim());
  // Tri stable par ordre des catégories (config) ; ordre relatif conservé dans chaque catégorie
  const catRank = (id) => {
    const idx = categories.findIndex((c) => c.id === id);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  const visible = tools
    .filter((tool) => {
      const inCategory = state.category === 'all' || tool.category === state.category;
      const category = categories.find((cat) => cat.id === tool.category)?.label ?? '';
      const matchesQuery = !query || normalize(`${tool.name} ${tool.description} ${category}`).includes(query);
      return inCategory && matchesQuery;
    })
    .map((t, i) => ({ t, i }))
    .sort((a, b) => catRank(a.t.category) - catRank(b.t.category) || a.i - b.i)
    .map(({ t }) => t);

  if (state.category === 'all') {
    for (const category of categories.filter(({ id }) => id !== 'all')) {
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
  els.heroToolCount.textContent = state.category === 'all' && !query
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

async function openTool(id) {
  const tool = tools.find((t) => t.id === id);
  if (!tool) return;

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

// Deep link : index.html#<tool-id>
const hashId = location.hash.slice(1);
if (hashId) openTool(hashId);
