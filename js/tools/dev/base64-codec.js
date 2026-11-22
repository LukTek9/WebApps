import { createWorkspace, setStats } from '../shared/dev-tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field">Opération<select class="dev-tools__select" data-mode><option value="encode">Encoder en Base64</option><option value="decode">Décoder du Base64</option></select></label>';

function update() {
  const source = view.source.value;
  const mode = view.root.querySelector('[data-mode]').value;
  try {
    let output;
    if (mode === 'encode') {
      const bytes = new TextEncoder().encode(source);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      output = btoa(binary);
    } else {
      const binary = atob(source.replace(/\s/g, ''));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      output = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    view.output.textContent = output;
    view.status(mode === 'encode' ? 'Texte encodé en UTF-8 / Base64.' : 'Base64 décodé en UTF-8.', 'success');
    setStats(view, [`Entrée : ${source.length} caractères`, `Sortie : ${output.length} caractères`, mode === 'encode' ? 'UTF-8' : 'Décodage strict UTF-8']);
  } catch {
    view.output.textContent = '';
    view.status('Base64 ou texte UTF-8 invalide : vérifiez la valeur saisie.', 'error');
    setStats(view, ['Aucune sortie produite']);
  }
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Encodeur / Décodeur Base64', description: 'Encodez du texte en UTF-8 ou décodez une chaîne Base64 en local, avec résultat copiable et exportable.', sourceLabel: 'Texte ou Base64', outputLabel: 'Résultat', sourcePlaceholder: 'Saisissez votre texte ou votre chaîne Base64…', controls: CONTROLS });
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download' && view.output.textContent) view.download(view.output.textContent, 'resultat-base64.txt');
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
