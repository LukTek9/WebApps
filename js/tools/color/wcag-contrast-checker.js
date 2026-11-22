import { createSecurityUI } from '../shared/security-tool-ui.js';
import { contrastRatio, hexToRgb, themeColorHex } from '../shared/color-utils.js';

let ui;
let report = '';

const CONTENT = `
  <div class="security-tools__layout">
    <section class="security-tools__panel">
      <label class="security-tools__field">Couleur du texte<input data-foreground type="color"></label>
      <label class="security-tools__field">Couleur de l’arrière-plan<input data-background type="color"></label>
      <div class="security-tools__actions"><button class="btn-secondary" data-action="swap" type="button">Inverser les couleurs</button><button class="btn-secondary" data-action="copy" type="button">Copier le rapport</button><button class="btn-secondary" data-action="download" type="button">Télécharger le rapport</button></div>
    </section>
    <section class="security-tools__panel">
      <div class="security-tools__panel-heading"><div><h3>Prévisualisation WCAG</h3><p data-ratio></p></div></div>
      <div class="color-tools__contrast-preview" data-preview>
        <strong>Texte normal · 16 px</strong>
        <p>Un contraste lisible rend le contenu plus accessible à toutes et tous.</p>
        <span>Grand texte · 24 px</span>
      </div>
      <div class="color-tools__contrast-results" data-results></div>
    </section>
  </div>`;

function render() {
  const foregroundHex = ui.query('[data-foreground]').value;
  const backgroundHex = ui.query('[data-background]').value;
  const ratio = contrastRatio(hexToRgb(foregroundHex), hexToRgb(backgroundHex));
  const tests = [
    ['AA · texte normal', 4.5],
    ['AAA · texte normal', 7],
    ['AA · grand texte', 3],
    ['AAA · grand texte', 4.5],
  ];
  const results = tests.map(([label, threshold]) => [label, ratio >= threshold]);
  ui.query('[data-preview]').style.color = foregroundHex;
  ui.query('[data-preview]').style.backgroundColor = backgroundHex;
  ui.query('[data-ratio]').textContent = `Ratio de contraste : ${ratio.toFixed(2)}:1`;
  const list = ui.query('[data-results]');
  list.replaceChildren();
  for (const [label, passed] of results) {
    const row = document.createElement('div');
    row.className = 'color-tools__contrast-row';
    const name = document.createElement('strong');
    name.textContent = label;
    const value = document.createElement('span');
    value.textContent = passed ? 'Conforme' : 'À améliorer';
    value.dataset.state = passed ? 'success' : 'error';
    row.append(name, value);
    list.append(row);
  }
  report = [
    `Texte : ${foregroundHex.toUpperCase()}`,
    `Arrière-plan : ${backgroundHex.toUpperCase()}`,
    `Ratio : ${ratio.toFixed(2)}:1`,
    ...results.map(([label, passed]) => `${label} : ${passed ? 'Conforme' : 'À améliorer'}`),
  ].join('\n');
  ui.setStatus('Contraste recalculé.', 'success');
}

export function mount(container) {
  ui = createSecurityUI(container, {
    title: 'Vérificateur de contraste WCAG',
    description: 'Mesurez le contraste de deux couleurs et vérifiez les seuils WCAG AA et AAA.',
    content: CONTENT,
  });
  ui.query('[data-foreground]').value = themeColorHex('--color-text');
  ui.query('[data-background]').value = themeColorHex('--color-surface');
  ui.on('input', (event) => {
    if (event.target.matches('[data-foreground], [data-background]')) render();
  });
  ui.on('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'swap') {
      const foreground = ui.query('[data-foreground]');
      const background = ui.query('[data-background]');
      [foreground.value, background.value] = [background.value, foreground.value];
      render();
    }
    if (action === 'copy') await ui.copy(report, 'Rapport de contraste copié.');
    if (action === 'download') ui.download(`${report}\n`, 'rapport-contraste-wcag.txt');
  });
  render();
}

export function unmount() {
  ui?.destroy();
  ui = null;
  report = '';
}
