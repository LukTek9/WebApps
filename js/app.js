/**
 * app.js — Pilotage UI : grille de cartes, filtres, workspace, lazy loading des outils.
 */
import { categories, tools } from './tools.config.js';
import { animateHeroAndGrid, animateHomeEnter, animateWorkspaceEnter } from './animations.js';

const $ = (id) => document.getElementById(id);
const els = {
  home: $('home-view'),
  grid: $('tools-grid'),
  filters: $('filters'),
  filtersToggle: $('filters-toggle'),
  filtersToggleLabel: $('filters-toggle-label'),
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
  els.filtersToggleLabel.textContent = categories.find((category) => category.id === state.category)?.label ?? 'Tout';
  for (const cat of categories) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-btn' + (cat.id === state.category ? ' is-active' : '');
    btn.setAttribute('aria-pressed', String(cat.id === state.category));
    const label = document.createElement('span');
    label.className = 'filter-btn__label';
    label.textContent = cat.label;
    const count = document.createElement('span');
    count.className = 'filter-btn__count';
    count.textContent = String(cat.id === 'all' ? tools.length : tools.filter((tool) => tool.category === cat.id).length);
    btn.append(label, count);
    btn.addEventListener('click', () => {
      state.category = cat.id;
      setActiveThemeColor(state.category);
      closeFilters(true);
      renderFilters();
      renderGrid();
      window.scrollTo({
        top: 0,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    });
    els.filters.appendChild(btn);
  }
  requestAnimationFrame(updateFilterOverflow);
}

function closeFilters(returnFocus = false) {
  els.filters.classList.remove('is-open');
  els.filtersToggle.setAttribute('aria-expanded', 'false');
  if (returnFocus && getComputedStyle(els.filtersToggle).display !== 'none') {
    els.filtersToggle.focus({ preventScroll: true });
  }
}

function updateFilterOverflow() {
  if (els.filters.classList.contains('is-open')) return;
  const wasCollapsed = els.filters.classList.contains('has-overflow');
  if (wasCollapsed) els.filters.style.display = 'flex';
  const hasOverflow = els.filters.scrollWidth > els.filters.clientWidth;
  els.filters.style.removeProperty('display');
  els.filters.classList.toggle('has-overflow', hasOverflow);
  els.filtersToggle.hidden = !hasOverflow;
  if (!hasOverflow) closeFilters();
}

function motionForTool(id) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return toolMotions[hash % toolMotions.length];
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

  for (const tool of visible) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tool-card';
    card.style.setProperty('--tool-color', catColor(tool.category));
    card.dataset.motion = motionForTool(tool.id);

    // textContent : pas d'injection HTML depuis la config
    const icon = document.createElement('span');
    icon.className = 'tool-card__icon';
    const i = document.createElement('i');
    i.setAttribute('data-lucide', tool.icon);
    icon.appendChild(i);

    const title = document.createElement('span');
    title.className = 'tool-card__title';
    title.textContent = tool.name;

    const desc = document.createElement('span');
    desc.className = 'tool-card__desc';
    desc.textContent = tool.description;

    card.append(icon, title, desc);
    card.addEventListener('click', () => openTool(tool.id));
    els.grid.appendChild(card);
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
  history.replaceState(null, '', location.pathname);
}

/* ---------- Init ---------- */
setActiveThemeColor(state.category);
window.addEventListener('resize', updateFilterOverflow);
els.filtersToggle.addEventListener('click', () => {
  const isOpen = els.filters.classList.toggle('is-open');
  els.filtersToggle.setAttribute('aria-expanded', String(isOpen));
});
document.addEventListener('click', (event) => {
  if (!els.filters.contains(event.target) && !els.filtersToggle.contains(event.target)) closeFilters();
});
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
  if (event.key === 'Escape' && els.filters.classList.contains('is-open')) {
    closeFilters(true);
    return;
  }
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

// Deep link : index.html#<tool-id>
const hashId = location.hash.slice(1);
if (hashId) openTool(hashId);
