import { createSecurityUI } from './shared/security-tool-ui.js';

let ui;
let cards = [];
const STORAGE_KEY = 'webapps-kanban';
const COLUMNS = ['À faire', 'En cours', 'Terminé'];

const CONTENT = `
  <section class="security-tools__panel">
    <form class="security-tools__controls" data-add-form>
      <label class="security-tools__field">Nouvelle tâche<input data-new-task type="text" maxlength="240" required placeholder="Ex. Préparer la présentation"></label>
      <button class="btn-primary" type="submit">Ajouter à faire</button>
    </form>
    <div class="security-tools__actions"><button class="btn-secondary" data-action="copy-board" type="button">Copier le tableau</button><button class="btn-secondary" data-action="download-board" type="button">Télécharger le tableau</button></div>
    <p class="security-tools__hint">Les changements sont enregistrés dans le stockage local de ce navigateur.</p>
  </section>
  <div class="security-tools__layout security-tools__layout--three utility-tools__kanban" data-board></div>`;

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
    ui.setStatus(`${cards.length} tâche(s) enregistrée(s) localement.`, 'success');
  } catch (error) {
    ui.setStatus(`Enregistrement impossible : ${error.message}`, 'error');
  }
}

function render() {
  const board = ui.query('[data-board]');
  board.replaceChildren();
  for (const column of COLUMNS) {
    const section = document.createElement('section');
    section.className = 'security-tools__panel utility-tools__kanban-column';
    const heading = document.createElement('h3');
    heading.textContent = `${column} · ${cards.filter((card) => card.state === column).length}`;
    section.append(heading);
    for (const item of cards.filter((card) => card.state === column)) {
      const card = document.createElement('article');
      card.className = 'utility-tools__task';
      card.dataset.id = item.id;
      const title = document.createElement('label');
      title.className = 'security-tools__field';
      title.textContent = 'Tâche';
      const text = document.createElement('input');
      text.type = 'text';
      text.maxLength = 240;
      text.value = item.text;
      text.dataset.task = '';
      title.append(text);
      const state = document.createElement('label');
      state.className = 'security-tools__field';
      state.textContent = 'Colonne';
      const select = document.createElement('select');
      select.dataset.state = '';
      for (const name of COLUMNS) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.append(option);
      }
      select.value = item.state;
      state.append(select);
      const actions = document.createElement('div');
      actions.className = 'security-tools__actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn-secondary';
      save.dataset.action = 'save-card';
      save.textContent = 'Enregistrer';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary';
      remove.dataset.action = 'delete-card';
      remove.textContent = 'Supprimer';
      actions.append(save, remove);
      card.append(title, state, actions);
      section.append(card);
    }
    board.append(section);
  }
}

function boardText() {
  return COLUMNS.map((column) => `${column}\n${cards.filter((card) => card.state === column).map((card) => `- ${card.text}`).join('\n') || '—'}`).join('\n\n');
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(saved) || saved.some((item) => !item || typeof item.id !== 'string' || typeof item.text !== 'string' || !COLUMNS.includes(item.state))) {
      throw new Error('Les données enregistrées du tableau ne sont pas valides.');
    }
    cards = saved;
  } catch (error) {
    cards = [];
    ui.setStatus(`Chargement du tableau impossible : ${error.message}`, 'error');
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Tableau Kanban',
    description: 'Organisez les tâches dans trois colonnes et conservez le tableau localement.',
    content: CONTENT,
  });
  load();
  render();
  ui.on('submit', (event) => {
    if (!event.target.matches('[data-add-form]')) return;
    event.preventDefault();
    const text = ui.query('[data-new-task]').value.trim();
    if (!text) return;
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    cards.push({ id, text, state: COLUMNS[0] });
    ui.query('[data-new-task]').value = '';
    persist();
    render();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy-board') {
      await ui.copy(boardText(), 'Tableau copié.');
      return;
    }
    if (action === 'download-board') {
      ui.download(`${boardText()}\n`, 'tableau-kanban.txt');
      return;
    }
    if (!action) return;
    const cardElement = event.target.closest('[data-id]');
    const card = cards.find((item) => item.id === cardElement?.dataset.id);
    if (!card) return;
    if (action === 'delete-card') {
      cards = cards.filter((item) => item.id !== card.id);
    } else {
      const text = cardElement.querySelector('[data-task]').value.trim();
      if (!text) { ui.setStatus('Une tâche ne peut pas être vide.', 'error'); return; }
      card.text = text;
      card.state = cardElement.querySelector('[data-state]').value;
    }
    persist();
    render();
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
  cards = [];
}
