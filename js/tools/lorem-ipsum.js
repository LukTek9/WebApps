let state;
const SENTENCES = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
  'Integer vitae justo nec neque pharetra tincidunt.',
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem.',
  'Curabitur blandit tempus porttitor et posuere.',
  'Nullam quis risus eget urna mollis ornare vel eu leo.',
  'Aenean lacinia bibendum nulla sed consectetur.',
  'Praesent commodo cursus magna, vel scelerisque nisl consectetur.',
  'Donec ullamcorper nulla non metus auctor fringilla.',
];
const TEMPLATE = `<section class="text-tools"><header class="text-tools__heading"><div><span class="text-tools__eyebrow">Contenu de démonstration</span><h2>Générateur de Lorem Ipsum</h2><p>Réglez la quantité et le format, l’aperçu suit instantanément.</p></div><div class="tool-copy-bar"><button class="btn-secondary" type="button" data-action="copy">Copier</button><button class="btn" type="button" data-action="download">Télécharger</button></div></header><div class="tool-panel"><div class="text-tools__controls"><label class="tool-field">Quantité <output data-quantity>3</output><input type="range" min="1" max="50" value="3" data-range><input type="number" min="1" max="50" value="3" data-number></label><label class="tool-field">Unité<select data-unit><option value="paragraphs">Paragraphes</option><option value="sentences">Phrases</option><option value="words">Mots</option></select></label><label class="tool-field">Format<select data-format><option value="plain">Texte brut</option><option value="paragraphs">Balises &lt;p&gt;</option><option value="list">Liste &lt;ul&gt;&lt;li&gt;</option></select></label></div><label class="text-tools__check"><input type="checkbox" data-start checked> Commencer par « Lorem ipsum dolor sit amet »</label></div><section class="tool-panel"><h3>Aperçu</h3><pre class="tool-preview-box text-tools__lorem" data-preview></pre></section><p class="text-tools__status" data-status role="status" aria-live="polite"></p></section>`;
const clamp = (n) => Math.min(50, Math.max(1, Number(n) || 1));
function sentence(index, begin) {
  if (begin && index === 0) return SENTENCES[0];
  return SENTENCES[(index + (begin ? 0 : 1)) % SENTENCES.length];
}
function generate() {
  const amount = clamp(state.root.querySelector('[data-number]').value);
  const unit = state.root.querySelector('[data-unit]').value;
  const begin = state.root.querySelector('[data-start]').checked;
  if (unit === 'words') {
    const words = (Array.from({ length: Math.ceil(amount / 8) }, (_, i) => sentence(i, begin)).join(' ').match(/[\p{L}\p{N}]+/gu) || []);
    return words.slice(0, amount).join(' ');
  }
  if (unit === 'sentences') return Array.from({ length: amount }, (_, i) => sentence(i, begin)).join(' ');
  return Array.from({ length: amount }, (_, i) => Array.from({ length: 3 + (i % 3) }, (_, j) => sentence(i * 3 + j, begin)).join(' '));
}
function render() {
  const amount = clamp(state.root.querySelector('[data-number]').value);
  state.root.querySelector('[data-number]').value = amount;
  state.root.querySelector('[data-range]').value = amount;
  state.root.querySelector('[data-quantity]').textContent = amount;
  const result = generate(), format = state.root.querySelector('[data-format]').value;
  const chunks = Array.isArray(result) ? result : [result];
  let output = chunks.join('\n\n');
  if (format === 'paragraphs') output = chunks.map((p) => `<p>${p}</p>`).join('\n');
  if (format === 'list') output = `<ul>\n${chunks.map((p) => `  <li>${p}</li>`).join('\n')}\n</ul>`;
  state.output = output;
  state.root.querySelector('[data-preview]').textContent = output;
}
function save() {
  const url = URL.createObjectURL(new Blob([state.output], { type: 'text/plain;charset=utf-8' }));
  state.urls.add(url); const a = document.createElement('a'); a.href = url; a.download = 'lorem-ipsum.txt'; document.body.append(a); a.click(); a.remove();
  const timer = setTimeout(() => { URL.revokeObjectURL(url); state?.urls.delete(url); state?.timers.delete(timer); }, 1000); state.timers.add(timer);
}
export function mount(container) {
  container.innerHTML = TEMPLATE; state = { root: container, output: '', urls: new Set(), timers: new Set() };
  state.onChange = (event) => {
    if (event.target.matches('[data-number], [data-range]')) {
      const value = clamp(event.target.value);
      state.root.querySelector('[data-number]').value = value;
      state.root.querySelector('[data-range]').value = value;
    }
    if (event.target.matches('[data-number], [data-range], [data-unit], [data-format], [data-start]')) render();
  };
  state.onClick = async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'download') save();
    if (action === 'copy') {
      try { await navigator.clipboard.writeText(state.output); state.root.querySelector('[data-status]').textContent = 'Lorem Ipsum copié.'; }
      catch { state.root.querySelector('[data-status]').textContent = 'Copie impossible dans ce navigateur.'; }
    }
  };
  container.addEventListener('input', state.onChange); container.addEventListener('change', state.onChange); container.addEventListener('click', state.onClick); render();
}
export function unmount() {
  if (!state) return;
  state.root.removeEventListener('input', state.onChange); state.root.removeEventListener('change', state.onChange); state.root.removeEventListener('click', state.onClick);
  state.timers.forEach(clearTimeout); state.urls.forEach(URL.revokeObjectURL); state.root.innerHTML = ''; state = null;
}
