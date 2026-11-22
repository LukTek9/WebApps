import { createSecurityUI } from './shared/security-tool-ui.js';

let ui;

const PREFIX = 'webapps-note-';
const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Rechercher un titre<input data-search type="search" placeholder="Filtrer les notes"></label>
      <label class="security-tools__field">Notes enregistrées<select data-notes><option value="">Nouvelle note…</option></select></label>
      <label class="security-tools__field">Titre<input data-title type="text" maxlength="120" placeholder="Sans titre"></label>
      <div class="security-tools__actions"><button class="btn-primary" data-action="save" type="button">Enregistrer</button><button class="btn-secondary" data-action="new" type="button">Nouvelle note</button><button class="btn-secondary" data-action="delete" type="button">Supprimer</button></div>
      <p class="security-tools__hint">Les notes restent dans le stockage local de ce navigateur. Elles ne sont pas chiffrées.</p>
    </section>
    <section class="security-tools__panel">
      <label class="security-tools__field">Contenu<textarea class="security-tools__textarea" data-content rows="14" placeholder="Écrivez votre note…"></textarea></label>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="copy" type="button">Copier</button><button class="btn-secondary" data-action="download" type="button">Télécharger en .txt</button></div>
      <p class="security-tools__hint" data-count>0 caractère</p>
    </section>
  </div>`;

function currentTitle() {
  return ui.query('[data-title]').value.trim() || 'note';
}

function refreshList(selected = '') {
  const select = ui.query('[data-notes]');
  const titles = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(PREFIX)) titles.push(key.slice(PREFIX.length));
  }
  const filter = ui.query('[data-search]').value.trim().toLocaleLowerCase('fr');
  const visibleTitles = titles.filter((title) => title.toLocaleLowerCase('fr').includes(filter));
  select.replaceChildren(new Option('Nouvelle note…', ''), ...visibleTitles.sort((a, b) => a.localeCompare(b, 'fr')).map((title) => new Option(title, title)));
  select.value = selected;
}

function updateCount() {
  const count = ui.query('[data-content]').value.length;
  ui.query('[data-count]').textContent = `${count} caractère${count > 1 ? 's' : ''}`;
}

function load(title) {
  try {
    if (!title) {
      ui.query('[data-title]').value = '';
      ui.query('[data-content]').value = '';
      refreshList();
      updateCount();
      return;
    }
    ui.query('[data-title]').value = title;
    ui.query('[data-content]').value = localStorage.getItem(`${PREFIX}${title}`) || '';
    refreshList(title);
    updateCount();
    ui.setStatus('Note chargée depuis le stockage local.', 'success');
  } catch (error) {
    ui.setStatus(`Lecture du stockage local impossible : ${error.message}`, 'error');
  }
}

function save() {
  const title = currentTitle();
  const content = ui.query('[data-content]').value;
  try {
    localStorage.setItem(`${PREFIX}${title}`, content);
    ui.query('[data-title]').value = title;
    ui.query('[data-search]').value = '';
    refreshList(title);
    ui.setStatus('Note enregistrée localement.', 'success');
    return true;
  } catch (error) {
    ui.setStatus(`Enregistrement impossible : ${error.message}`, 'error');
    return false;
  }
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Bloc-notes local',
    description: 'Gérez et exportez vos notes conservées dans le stockage de votre navigateur.',
    content: CONTENT,
  });
  try {
    refreshList();
  } catch (error) {
    ui.setStatus(`Lecture du stockage local impossible : ${error.message}`, 'error');
  }
  ui.on('input', (event) => {
    if (event.target.matches('[data-content]')) updateCount();
    if (event.target.matches('[data-search]')) {
      try { refreshList(ui.query('[data-notes]').value); }
      catch (error) { ui.setStatus(`Lecture du stockage local impossible : ${error.message}`, 'error'); }
    }
  });
  ui.on('change', (event) => {
    if (!event.target.matches('[data-notes]')) return;
    try { load(event.target.value); } catch (error) { ui.setStatus(`Lecture impossible : ${error.message}`, 'error'); }
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'save') save();
    if (action === 'new') load('');
    if (action === 'delete') {
      try {
        const title = ui.query('[data-notes]').value || (localStorage.getItem(`${PREFIX}${currentTitle()}`) !== null ? currentTitle() : '');
        if (!title) { ui.setStatus('Sélectionnez une note enregistrée à supprimer.', 'error'); return; }
        localStorage.removeItem(`${PREFIX}${title}`);
        load('');
        ui.setStatus('Note supprimée du stockage local.', 'success');
      } catch (error) { ui.setStatus(`Suppression impossible : ${error.message}`, 'error'); }
    }
    if (action === 'copy') await ui.copy(ui.query('[data-content]').value, 'Contenu copié.');
    if (action === 'download') {
      const title = currentTitle().replace(/[\\/:*?"<>|]/g, '-');
      ui.download(ui.query('[data-content]').value, `${title}.txt`);
    }
  });
}

export function unmount() {
  ui?.destroy();
  ui = null;
}
