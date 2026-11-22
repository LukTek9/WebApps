import { createSecurityUI, showError } from '../shared/security-tool-ui.js';

let ui;
let passwords = [];

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Paramètres</h3><p>Le générateur utilise l’aléatoire cryptographique du navigateur.</p></div></div>
      <div class="security-tools__controls">
        <label class="security-tools__field">Style<select data-mode><option value="random">Aléatoire</option><option value="pronounceable">Prononçable</option></select></label>
        <label class="security-tools__field">Longueur <output data-length>20</output><input data-size type="range" min="8" max="64" value="20"></label>
        <label class="security-tools__field">Nombre de résultats<input data-count type="number" min="1" max="20" value="1"></label>
      </div>
      <fieldset class="security-tools__options" data-character-options><legend>Caractères inclus</legend>
        <label><input data-set="upper" type="checkbox" checked> Majuscules</label>
        <label><input data-set="lower" type="checkbox" checked> Minuscules</label>
        <label><input data-set="digits" type="checkbox" checked> Chiffres</label>
        <label><input data-set="symbols" type="checkbox" checked> Symboles</label>
        <label><input data-ambiguous type="checkbox" checked> Exclure les caractères ambigus</label>
      </fieldset>
      <div class="security-tools__actions"><button class="btn-primary" data-action="generate" type="button">Générer</button><button class="btn-secondary" data-action="copy" type="button">Copier</button><button class="btn-secondary" data-action="download" type="button">Télécharger .txt</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Résultat</h3><p data-preview>20 caractères · 4 familles sélectionnées</p></div></div>
      <output class="security-tools__result" data-output aria-label="Mots de passe générés"></output>
      <label class="security-tools__field">Entropie théorique du premier résultat
        <meter data-entropy min="0" max="256" value="0"></meter>
      </label>
      <p class="security-tools__hint" data-hint>Choisissez au moins une famille de caractères.</p>
    </section>
  </div>`;

const SETS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
};
const AMBIGUOUS = /[Il1O0]/g;
const SYLLABLES = 'ba be bi bo bu da de di do du ka ke ki ko ku la le li lo lu ma me mi mo mu na ne ni no nu ra re ri ro ru sa se si so su ta te ti to tu'.split(' ');

function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return word[0] % max;
}

function selectedSets() {
  const chosen = [...ui.root.querySelectorAll('[data-set]:checked')].map((input) => SETS[input.dataset.set]);
  return ui.query('[data-ambiguous]').checked ? chosen.map((set) => set.replace(AMBIGUOUS, '')) : chosen;
}

function renderPreview() {
  const length = Number(ui.query('[data-size]').value);
  const sets = selectedSets();
  const pronounceable = ui.query('[data-mode]').value === 'pronounceable';
  ui.query('[data-character-options]').hidden = pronounceable;
  ui.query('[data-length]').value = length;
  ui.query('[data-preview]').textContent = pronounceable
    ? `${length} caractères · syllabes prononçables`
    : `${length} caractères · ${sets.length} famille(s) sélectionnée(s)`;
  const entropy = pronounceable
    ? Math.ceil(length / 2) * Math.log2(SYLLABLES.length)
    : sets.length ? length * Math.log2(sets.join('').length) : 0;
  ui.query('[data-entropy]').value = Math.min(256, entropy);
  ui.query('[data-hint]').textContent = pronounceable
    ? `Syllabes assemblées aléatoirement · environ ${entropy.toFixed(0)} bits théoriques.`
    : sets.length ? `Environ ${entropy.toFixed(0)} bits pour un résultat de cette longueur.`
      : 'Choisissez au moins une famille de caractères.';
}

function generate() {
  const mode = ui.query('[data-mode]').value;
  const sets = selectedSets();
  const length = Math.max(8, Math.min(64, Number(ui.query('[data-size]').value) || 20));
  const count = Math.max(1, Math.min(20, Number(ui.query('[data-count]').value) || 1));
  if (mode === 'random' && !sets.length) throw new Error('Choisissez au moins une famille de caractères.');
  const pool = sets.join('');
  passwords = Array.from({ length: count }, () => mode === 'pronounceable'
    ? Array.from({ length: Math.ceil(length / 2) }, () => SYLLABLES[randomInt(SYLLABLES.length)]).join('').slice(0, length)
    : Array.from({ length }, () => pool[randomInt(pool.length)]).join(''));
  ui.query('[data-output]').textContent = passwords.join('\n');
  renderPreview();
  ui.setStatus(`${count} mot(s) de passe généré(s) localement.`, 'success');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Générateur de mots de passe',
    description: 'Créez des mots de passe aléatoires et adaptez longueur, quantité et caractères.',
    content: CONTENT,
  });
  passwords = [];
  ui.on('input', (event) => {
    if (event.target.matches('[data-size], [data-count], [data-set], [data-ambiguous]')) renderPreview();
  });
  ui.on('change', (event) => {
    if (event.target.matches('[data-mode]')) renderPreview();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    try {
      if (action === 'generate') generate();
      if (action === 'copy') await ui.copy(passwords.join('\n'), 'Mot(s) de passe copié(s).');
      if (action === 'download' && passwords.length) ui.download(passwords.join('\n'), 'mots-de-passe.txt');
      else if (action === 'download') ui.setStatus('Générez un résultat avant le téléchargement.', 'error');
    } catch (error) { showError(ui, error); }
  });
  renderPreview();
  generate();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  passwords = [];
}
