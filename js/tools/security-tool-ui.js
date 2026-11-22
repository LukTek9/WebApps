export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export function createSecurityUI(container, { title, description, content }) {
  container.innerHTML = `
    <section class="security-tools">
      <header class="security-tools__heading">
        <div><span class="security-tools__eyebrow">Traitement local · aucune donnée envoyée</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>
        <span class="security-tools__privacy">100 % dans votre navigateur</span>
      </header>
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
        field.select();
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

export function showError(ui, error, fallback = 'Une erreur est survenue.') {
  if (!ui?.isActive()) return;
  ui.setStatus(error instanceof Error ? error.message : fallback, 'error');
}
