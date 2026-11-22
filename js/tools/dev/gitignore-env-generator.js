import { createWorkspace, setStats } from './tool-kit.js';

let view;
const CONTROLS = '<label class="dev-tools__field">Fichier à générer<select class="dev-tools__select" data-kind><option value="gitignore">.gitignore</option><option value="env">.env.example</option></select></label><label class="dev-tools__check"><input type="checkbox" data-node checked> Node.js</label><label class="dev-tools__check"><input type="checkbox" data-python> Python</label><label class="dev-tools__check"><input type="checkbox" data-macos checked> macOS</label><label class="dev-tools__check"><input type="checkbox" data-vscode> VS Code</label><label class="dev-tools__field">Nom de l’application<input class="dev-tools__input" data-app value="mon-application"></label><label class="dev-tools__field">Port<input class="dev-tools__input" data-port type="number" min="1" max="65535" value="3000"></label><label class="dev-tools__field">URL d’API<input class="dev-tools__input" data-api value="http://localhost:3000/api"></label>';

const IGNORE = {
  node: 'node_modules/\ndist/\nbuild/\ncoverage/\n.env\n.env.*\n!.env.example\nnpm-debug.log*\n',
  python: '__pycache__/\n*.py[cod]\n.venv/\nvenv/\ndist/\nbuild/\n*.egg-info/\n',
  macos: '.DS_Store\n.AppleDouble\n.LSOverride\n',
  vscode: '.vscode/*\n!.vscode/extensions.json\n!.vscode/settings.json\n',
};

function update() {
  const kind = view.root.querySelector('[data-kind]').value;
  let result;
  if (kind === 'gitignore') {
    result = '# Fichiers générés automatiquement\n';
    for (const [key, selector] of [['node', 'node'], ['python', 'python'], ['macos', 'macos'], ['vscode', 'vscode']]) {
      if (view.root.querySelector(`[data-${selector}]`).checked) result += `\n# ${key === 'macos' ? 'macOS' : key === 'vscode' ? 'VS Code' : key[0].toUpperCase() + key.slice(1)}\n${IGNORE[key]}`;
    }
  } else {
    const app = view.root.querySelector('[data-app]').value.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_') || 'APPLICATION';
    const port = Number(view.root.querySelector('[data-port]').value);
    const api = view.root.querySelector('[data-api]').value.trim();
    result = `# Configuration locale — ${app}\\nPORT=${Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3000}\\nAPI_URL=${api}\\n`;
  }
  view.output.textContent = result;
  setStats(view, [`${view.output.textContent.split('\n').length - 1} lignes`, kind === 'gitignore' ? 'Règles de fichiers' : 'Variables d’environnement', 'Modifiable avant export']);
  view.status('Fichier de départ généré. Vérifiez les règles selon votre projet.', 'success');
}

export function mount(container) {
  view = createWorkspace(container, { title: 'Générateur .gitignore / .env', description: 'Assemblez des fichiers de départ adaptés à votre pile et personnalisez les valeurs avant export.', sourceLabel: 'Options de génération', outputLabel: 'Fichier généré', controls: CONTROLS });
  view.root.classList.add('dev-tools--single');
  view.source.hidden = true;
  view.source.closest('.dev-tools__panel').hidden = true;
  view.onInput = update;
  view.onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const kind = view.root.querySelector('[data-kind]').value;
    if (action === 'copy') view.copy(view.output.textContent);
    if (action === 'download') view.download(view.output.textContent, kind === 'gitignore' ? '.gitignore' : '.env.example');
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
