let state;
const TEMPLATE = `<section class="text-tools"><header class="text-tools__heading"><div><span class="text-tools__eyebrow">Conversion locale</span><h2>Convertisseur HTML vers Markdown</h2><p>Collez du HTML ou importez un fichier .html.</p></div><div class="tool-copy-bar"><button class="btn-secondary" type="button" data-action="copy">Copier Markdown</button><button class="btn" type="button" data-action="download">Télécharger .md</button></div></header><label class="tool-dropzone text-tools__file">Importer un fichier HTML<input type="file" accept=".html,.htm,text/html" data-file></label><div class="tool-split"><label class="tool-field">HTML<textarea class="tool-textarea" data-html rows="18" placeholder="Collez votre code HTML…"></textarea></label><label class="tool-field">Markdown<textarea class="tool-textarea" data-markdown rows="18" readonly></textarea></label></div><p class="text-tools__status" data-status role="status" aria-live="polite"></p></section>`;
const text = (node) => Array.from(node.childNodes).map((child) => {
  if (child.nodeType === Node.TEXT_NODE) return child.nodeValue;
  if (child.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = child.tagName.toLowerCase(), inner = text(child);
  if (tag === 'strong' || tag === 'b') return `**${inner}**`;
  if (tag === 'em' || tag === 'i') return `*${inner}*`;
  if (tag === 'code') return `\`${inner}\``;
  if (tag === 'a') return `[${inner}](${child.getAttribute('href') || ''})`;
  if (tag === 'img') return `![${child.getAttribute('alt') || ''}](${child.getAttribute('src') || ''})`;
  if (tag === 'br') return '  \n';
  return inner;
}).join('');

function listMarkdown(list, depth = 0) {
  const ordered = list.tagName.toLowerCase() === 'ol';
  let index = Number(list.getAttribute('start')) || 1;
  return Array.from(list.children).filter((li) => li.tagName.toLowerCase() === 'li').map((li) => {
    const marker = ordered ? `${index++}.` : '-';
    const nested = Array.from(li.children).filter((child) => ['ul', 'ol'].includes(child.tagName.toLowerCase()));
    const content = Array.from(li.childNodes).filter((child) => child.nodeType !== Node.ELEMENT_NODE || !['ul', 'ol'].includes(child.tagName.toLowerCase())).map((child) => child.nodeType === Node.TEXT_NODE ? child.nodeValue : text(child)).join('').trim();
    return `${'  '.repeat(depth)}${marker} ${content}${nested.length ? `\n${nested.map((child) => listMarkdown(child, depth + 1)).join('\n')}` : ''}`;
  }).join('\n');
}

function tableMarkdown(table) {
  const rows = Array.from(table.querySelectorAll('tr')).map((row) => Array.from(row.children).map((cell) => text(cell).trim().replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const cells = (row) => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
  return [cells(rows[0]), cells(Array(width).fill('---')), ...rows.slice(1).map(cells)].join('\n');
}

function blocks(root) {
  const result = [];
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue.trim()) result.push(node.nodeValue.trim());
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) result.push(`${'#'.repeat(Number(tag[1]))} ${text(node).trim()}`);
    else if (tag === 'pre') result.push(`\`\`\`\n${node.textContent.replace(/\n$/, '')}\n\`\`\``);
    else if (tag === 'ul' || tag === 'ol') result.push(listMarkdown(node));
    else if (tag === 'blockquote') result.push(blocks(node).map((line) => line.split('\n').map((part) => `> ${part}`).join('\n')).join('\n'));
    else if (tag === 'table') result.push(tableMarkdown(node));
    else if (tag === 'hr') result.push('---');
    else if (['p', 'div', 'section', 'article', 'main', 'header', 'footer'].includes(tag)) {
      const nested = blocks(node);
      if (nested.length) result.push(nested.join('\n\n'));
      else if (text(node).trim()) result.push(text(node).trim());
    } else {
      const content = text(node).trim();
      if (content) result.push(content);
    }
  }
  return result.filter(Boolean).join('\n\n');
}

function convert(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return blocks(doc.body);
}
function save() {
  const url = URL.createObjectURL(new Blob([state.root.querySelector('[data-markdown]').value], { type: 'text/markdown;charset=utf-8' }));
  state.urls.add(url); const a = document.createElement('a'); a.href = url; a.download = 'document.md'; document.body.append(a); a.click(); a.remove();
  const timer = setTimeout(() => { URL.revokeObjectURL(url); state?.urls.delete(url); state?.timers.delete(timer); }, 1000); state.timers.add(timer);
}
export function mount(container) {
  container.innerHTML = TEMPLATE; state = { root: container, urls: new Set(), timers: new Set() };
  state.render = () => { state.root.querySelector('[data-markdown]').value = convert(state.root.querySelector('[data-html]').value); };
  state.onInput = (event) => { if (event.target.matches('[data-html]')) state.render(); };
  state.onChange = async (event) => {
    if (!event.target.matches('[data-file]') || !event.target.files?.[0]) return;
    const file = event.target.files[0];
    if (!/\.html?$/i.test(file.name)) { state.root.querySelector('[data-status]').textContent = 'Choisissez un fichier .html ou .htm.'; return; }
    try {
      const html = await file.text();
      if (!state) return;
      state.root.querySelector('[data-html]').value = html; state.render();
    } catch {
      if (state) state.root.querySelector('[data-status]').textContent = 'Lecture du fichier impossible.';
    }
  };
  state.onClick = async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'download') save();
    if (action === 'copy') {
      try { await navigator.clipboard.writeText(state.root.querySelector('[data-markdown]').value); state.root.querySelector('[data-status]').textContent = 'Markdown copié.'; }
      catch { state.root.querySelector('[data-status]').textContent = 'Copie impossible dans ce navigateur.'; }
    }
  };
  container.addEventListener('input', state.onInput); container.addEventListener('change', state.onChange); container.addEventListener('click', state.onClick); state.render();
}
export function unmount() {
  if (!state) return;
  state.root.removeEventListener('input', state.onInput); state.root.removeEventListener('change', state.onChange); state.root.removeEventListener('click', state.onClick);
  state.timers.forEach(clearTimeout); state.urls.forEach(URL.revokeObjectURL); state.root.innerHTML = ''; state = null;
}
