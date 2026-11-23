export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export function createSecurityUI(container, { content }) {
  container.innerHTML = `
    <section class="security-tools">
      ${content}
      <p class="security-tools__status" data-status role="status" aria-live="polite"></p>
    </section>`;

  const root = container.querySelector('.security-tools');
  const status = root.querySelector('[data-status]');
  const controller = new AbortController();
  const urls = new Set();
  const timers = new Set();
  const intervals = new Set();
  let active = true;

  return {
    root,
    signal: controller.signal,
    query: (selector) => root.querySelector(selector),
    on(type, handler) {
      root.addEventListener(type, handler, { signal: controller.signal });
    },
    isActive: () => active,
    setStatus(message, type = 'muted') {
      if (!active) return;
      status.textContent = message;
      status.dataset.state = type;
    },
    async copy(value, success = 'Résultat copié.') {
      let copied = false;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API indisponible');
        await navigator.clipboard.writeText(String(value));
        copied = true;
      } catch {
        if (!active) return false;
      }
      if (active && !copied) {
        const field = document.createElement('textarea');
        field.value = String(value);
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        root.append(field);
        try { field.focus({ preventScroll: true }); } catch { /* ignoré */ }
        field.select();
        field.setSelectionRange?.(0, field.value.length);
        try { copied = document.execCommand('copy'); } catch { copied = false; } finally { field.remove(); }
      }
      if (active && copied) this.setStatus(success, 'success');
      else if (active) this.setStatus('Copie impossible : autorisez le presse-papiers dans ce navigateur.', 'error');
      return copied;
    },
    download(value, filename, mime = 'text/plain;charset=utf-8') {
      let url;
      let link;
      try {
        url = URL.createObjectURL(new Blob([value], { type: mime }));
        urls.add(url);
        link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        this.setStatus(`${filename} prêt au téléchargement.`, 'success');
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          urls.delete(url);
          timers.delete(timer);
        }, 1000);
        timers.add(timer);
      } catch (error) {
        if (url) {
          URL.revokeObjectURL(url);
          urls.delete(url);
        }
        this.setStatus(error instanceof Error ? `Téléchargement impossible : ${error.message}` : 'Téléchargement impossible.', 'error');
      } finally {
        link?.remove();
      }
    },
    setInterval(callback, delay) {
      const timer = window.setInterval(callback, delay);
      intervals.add(timer);
      return timer;
    },
    clearInterval(timer) {
      window.clearInterval(timer);
      intervals.delete(timer);
    },
    destroy() {
      if (!active) return;
      active = false;
      controller.abort();
      intervals.forEach(window.clearInterval);
      timers.forEach(window.clearTimeout);
      urls.forEach(URL.revokeObjectURL);
      intervals.clear();
      timers.clear();
      urls.clear();
      container.innerHTML = '';
    },
  };
}

/** Markup dropzone unifiée (DA pdf-merger). Appeler bindDropzone(ui, ...) après insertion. */
export function createDropzone({
  id = 'dropzone',
  title = 'Glissez-déposez vos fichiers ici',
  hint = 'ou cliquez pour parcourir',
  accept = '',
  multiple = false,
  label = 'Ajouter des fichiers',
} = {}) {
  return `
    <div class="dropzone" data-dropzone="${escapeHtml(id)}" tabindex="0" role="button" aria-label="${escapeHtml(label)}">
      <i data-lucide="cloud-upload"></i>
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(hint)}</small>
      <input type="file" ${accept ? `accept="${escapeHtml(accept)}"` : ''} ${multiple ? 'multiple' : ''} hidden />
    </div>`;
}

const matchesAccept = (file, accept) => {
  const rules = accept.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return rules.some((r) => r.startsWith('.') ? name.endsWith(r) : r.endsWith('/*') ? type.startsWith(r.slice(0, -1)) : type === r);
};

/**
 * Branche click/clavier/input/drag&drop. Listeners liés à ui.signal (nettoyés par ui.destroy()).
 * onFiles(File[]) reçoit uniquement les fichiers conformes à `accept`. Retourne { setDisabled }.
 */
export function bindDropzone(ui, { id = 'dropzone', onFiles, accept, multiple } = {}) {
  const zone = ui.root.querySelector(`[data-dropzone="${id}"]`);
  const input = zone?.querySelector('input[type="file"]');
  if (!zone || !input) return { setDisabled() {} };
  const rules = accept ?? input.getAttribute('accept') ?? '';
  const many = multiple ?? input.multiple;
  const opts = { signal: ui.signal };
  let disabled = false;
  const handle = (list) => {
    const all = [...list];
    const files = all.filter((f) => matchesAccept(f, rules));
    if (all.length > files.length) ui.setStatus(`${all.length - files.length} fichier(s) ignoré(s) (format non accepté).`, 'error');
    if (files.length && !disabled) onFiles?.(many ? files : files.slice(0, 1));
  };
  zone.addEventListener('click', () => !disabled && input.click(), opts);
  zone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !disabled) { e.preventDefault(); input.click(); }
  }, opts);
  input.addEventListener('click', (e) => e.stopPropagation(), opts);
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    handle(files);
  }, opts);
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); if (!disabled) zone.classList.add('is-over'); }, opts));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('is-over'); }, opts));
  zone.addEventListener('drop', (e) => handle(e.dataTransfer?.files ?? []), opts);
  window.lucide?.createIcons();
  return {
    setDisabled(value) {
      disabled = Boolean(value);
      zone.classList.toggle('is-disabled', disabled);
      zone.setAttribute('aria-disabled', String(disabled));
    },
  };
}

export function showError(ui, error, fallback = 'Une erreur est survenue.') {
  if (!ui?.isActive()) return;
  ui.setStatus(error instanceof Error ? error.message : fallback, 'error');
}
