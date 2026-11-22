export function createWorkspace(container, { title, description, sourceLabel, outputLabel = 'Résultat', sourcePlaceholder = '', controls = '' }) {
  container.innerHTML = `
    <section class="dev-tools">
      <header class="dev-tools__heading">
        <div><span class="dev-tools__eyebrow">Traitement local · en direct</span><h2>${title}</h2><p>${description}</p></div>
      </header>
      <div class="dev-tools__controls">${controls}</div>
      <div class="dev-tools__workspace">
        <section class="dev-tools__panel">
          <div class="dev-tools__panel-head"><strong>${sourceLabel}</strong><span data-source-count></span></div>
          <textarea class="dev-tools__input dev-tools__source" data-source spellcheck="false" placeholder="${sourcePlaceholder}"></textarea>
        </section>
        <section class="dev-tools__panel">
          <div class="dev-tools__panel-head"><strong>${outputLabel}</strong><span data-output-count></span></div>
          <pre class="dev-tools__output" data-output aria-live="polite"></pre>
          <div class="dev-tools__actions">
            <button class="btn-secondary" type="button" data-action="copy">Copier</button>
            <button class="btn-primary" type="button" data-action="download">Télécharger</button>
          </div>
        </section>
      </div>
      <div class="dev-tools__stats" data-stats></div>
      <p class="dev-tools__status" data-status role="status" aria-live="polite"></p>
    </section>`;

  const root = container.firstElementChild;
  const urls = new Set();
  const timers = new Set();
  let disposed = false;
  const status = root.querySelector('[data-status]');

  return {
    root,
    root,
    source: root.querySelector('[data-source]'),
    output: root.querySelector('[data-output]'),
    stats: root.querySelector('[data-stats]'),
    status(message, kind = '') {
      status.textContent = message;
      status.className = `dev-tools__status${kind ? ` is-${kind}` : ''}`;
    },
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        if (!disposed) this.status('Résultat copié.', 'success');
      } catch {
        if (!disposed) this.status('La copie est indisponible dans ce navigateur.', 'error');
      }
    },
    download(text, filename, type = 'text/plain;charset=utf-8') {
      const url = URL.createObjectURL(new Blob([text], { type }));
      urls.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.delete(url);
        timers.delete(timer);
      }, 1000);
      timers.add(timer);
    },
    dispose() {
      disposed = true;
      timers.forEach(clearTimeout);
      urls.forEach(URL.revokeObjectURL);
      timers.clear();
      urls.clear();
      container.innerHTML = '';
    },
  };
}

export function setStats(view, values) {
  view.root.querySelector('[data-source-count]').textContent = `${view.source.value.length} caractères`;
  view.root.querySelector('[data-output-count]').textContent = `${view.output.textContent.length} caractères`;
  view.stats.replaceChildren(...values.map((value) => {
    const item = document.createElement('span');
    item.className = 'dev-tools__stat';
    item.textContent = value;
    return item;
  }));
}
