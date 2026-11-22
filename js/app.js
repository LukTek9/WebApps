/**
 * app.js — Pilotage UI : grille de cartes, filtres, workspace, lazy loading des outils.
 */
import { categories, tools } from './tools.config.js';

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
};

const state = { category: 'all', activeModule: null, loaded: new Map() };

/** Rafraîchit les icônes Lucide (no-op si CDN indisponible). */
const refreshIcons = () => window.lucide?.createIcons();

/** Couleur d'une catégorie (fallback neutre). */
const catColor = (id) => categories.find((c) => c.id === id)?.color ?? 'var(--cat-default)';

/* ---------- Filtres ---------- */
function renderFilters() {
  els.filters.innerHTML = '';
  for (const cat of categories) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-btn' + (cat.id === state.category ? ' is-active' : '');
    btn.setAttribute('aria-pressed', String(cat.id === state.category));
    btn.textContent = cat.label;
    btn.addEventListener('click', () => {
      state.category = cat.id;
      renderFilters();
      renderGrid();
    });
    els.filters.appendChild(btn);
  }
}

/* ---------- Grille ---------- */
function renderGrid() {
  els.grid.innerHTML = '';
  // Tri stable par ordre des catégories (config) ; ordre relatif conservé dans chaque catégorie
  const catRank = (id) => {
    const idx = categories.findIndex((c) => c.id === id);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  const visible = tools
    .filter((t) => state.category === 'all' || t.category === state.category)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => catRank(a.t.category) - catRank(b.t.category) || a.i - b.i)
    .map(({ t }) => t);

  for (const tool of visible) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tool-card';
    card.style.setProperty('--tool-color', catColor(tool.category));

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
  refreshIcons();
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

  els.home.hidden = true;
  els.workspace.hidden = false;
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
  els.body.innerHTML = '';
  els.workspace.hidden = true;
  els.home.hidden = false;
  history.replaceState(null, '', location.pathname);
}

/* ---------- Init ---------- */
els.back.addEventListener('click', closeTool);
els.brand.addEventListener('click', closeTool);

renderFilters();
renderGrid();

// Deep link : index.html#<tool-id>
const hashId = location.hash.slice(1);
if (hashId) openTool(hashId);
