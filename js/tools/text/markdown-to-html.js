let state;
const TEMPLATE = `<section class="text-tools"><header class="text-tools__heading"><div><span class="text-tools__eyebrow">Éditeur Markdown</span><h2>Convertisseur Markdown vers HTML</h2><p>Écrivez en Markdown et prévisualisez le HTML généré.</p></div><div class="tool-copy-bar"><button class="btn-secondary" type="button" data-action="copy">Copier HTML</button><button class="btn" type="button" data-action="download">Télécharger .html</button></div></header><nav class="text-tools__toolbar" aria-label="Mise en forme"><button class="btn-secondary" type="button" data-insert="h1">H1</button><button class="btn-secondary" type="button" data-insert="h2">H2</button><button class="btn-secondary" type="button" data-insert="bold">Gras</button><button class="btn-secondary" type="button" data-insert="italic">Italique</button><button class="btn-secondary" type="button" data-insert="list">Liste</button><button class="btn-secondary" type="button" data-insert="link">Lien</button><button class="btn-secondary" type="button" data-insert="code">Code</button><button class="btn-secondary" type="button" data-insert="quote">Citation</button></nav><div class="tool-split"><label class="tool-field">Markdown<textarea class="tool-textarea" data-markdown rows="18" placeholder="# Votre titre&#10;&#10;Écrivez votre contenu…"></textarea></label><section class="tool-field"><div class="text-tools__tabs" role="tablist"><button class="btn-secondary is-active" type="button" data-tab="preview" role="tab">Aperçu</button><button class="btn-secondary" type="button" data-tab="source" role="tab">Code HTML</button></div><div class="tool-preview-box text-tools__rendered" data-preview></div><pre class="tool-code text-tools__raw" data-source hidden></pre></section></div><p class="text-tools__status" data-status role="status" aria-live="polite"></p></section>`;
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function safeUrl(url) { return /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i.test(url) ? url : '#'; }
function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/_(.+?)_/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `<a href="${escapeHtml(safeUrl(url))}" rel="noopener noreferrer">${label}</a>`);
  return s;
}
function convert(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const quote = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`); continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line), items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''))}</li>`);
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*(?:[-*+]|\d+\.)\s+)/.test(lines[i])) paragraph.push(lines[i++]);
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}
function render() {
  const html = convert(state.root.querySelector('[data-markdown]').value);
  state.html = html;
  state.root.querySelector('[data-preview]').innerHTML = html || '<p class="text-tools__empty">L’aperçu apparaîtra ici.</p>';
  state.root.querySelector('[data-source]').textContent = html;
}
function insert(kind) {
  const input = state.root.querySelector('[data-markdown]');
  const start = input.selectionStart, end = input.selectionEnd, selected = input.value.slice(start, end) || 'texte';
  const wrapped = { h1: `# ${selected}`, h2: `## ${selected}`, bold: `**${selected}**`, italic: `*${selected}*`, list: `- ${selected}`, link: `[${selected}](https://)`, code: `\`${selected}\``, quote: `> ${selected}` }[kind];
  input.setRangeText(wrapped, start, end, 'select'); input.focus(); render();
}
function save() {
  const documentHtml = `<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Document converti</title>\n</head>\n<body>\n${state.html}\n</body>\n</html>`;
  const url = URL.createObjectURL(new Blob([documentHtml], { type: 'text/html;charset=utf-8' }));
  state.urls.add(url); const a = document.createElement('a'); a.href = url; a.download = 'document.html'; document.body.append(a); a.click(); a.remove();
  const timer = setTimeout(() => { URL.revokeObjectURL(url); state?.urls.delete(url); state?.timers.delete(timer); }, 1000); state.timers.add(timer);
}
export function mount(container) {
  container.innerHTML = TEMPLATE; state = { root: container, html: '', urls: new Set(), timers: new Set() };
  state.onInput = (event) => { if (event.target.matches('[data-markdown]')) render(); };
  state.onClick = async (event) => {
    const insertButton = event.target.closest('[data-insert]');
    if (insertButton) { insert(insertButton.dataset.insert); return; }
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      const preview = tab.dataset.tab === 'preview';
      state.root.querySelector('[data-preview]').hidden = !preview;
      state.root.querySelector('[data-source]').hidden = preview;
      state.root.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('is-active', el === tab));
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'download') save();
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(state.html);
        state.root.querySelector('[data-status]').textContent = 'Code HTML copié.';
      }
      catch {
        state.root.querySelector('[data-source]').hidden = false;
        state.root.querySelector('[data-preview]').hidden = true;
        state.root.querySelector('[data-tab="source"]').classList.add('is-active');
        state.root.querySelector('[data-tab="preview"]').classList.remove('is-active');
        state.root.querySelector('[data-status]').textContent = 'Copie impossible dans ce navigateur. Le code HTML est affiché pour une copie manuelle.';
      }
    }
  };
  container.addEventListener('input', state.onInput); container.addEventListener('click', state.onClick); render();
}
export function unmount() {
  if (!state) return;
  state.root.removeEventListener('input', state.onInput); state.root.removeEventListener('click', state.onClick);
  state.timers.forEach(clearTimeout); state.urls.forEach(URL.revokeObjectURL); state.root.innerHTML = ''; state = null;
}
