/**
 * Remote Terminal — markdown viewer tab
 */

class MdViewer {
  constructor(id, name, filePath) {
    this.id = id;
    this.name = name;
    this.filePath = filePath;
    this.el = document.createElement('div');
    this.el.className = 'md-viewer';
    this.el.tabIndex = 0;
    this._loading = false;
    this._loaded = false;
    this._restored = false;
    this._suppressScroll = 0;
    this._scrollTimer = null;
    this.el.addEventListener('scroll', () => this._onScroll());
    this.fetchAndRender();
  }

  async fetchAndRender() {
    this._loading = true;
    this._loaded = false;
    this._restored = false;
    try {
      const r = await fetch('/api/md-file?path=' + encodeURIComponent(this.filePath));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const md = await r.text();
      this.el.innerHTML = marked.parse(md, { gfm: true, breaks: true });
      this._interceptLinks();
      this._loaded = true;
      this._tryRestore();
    } catch (e) {
      this.el.innerHTML =
        '<div class="md-error">파일을 불러올 수 없습니다' +
        '<div class="md-error-path">' + this._esc(this.filePath) + '</div></div>';
    }
    this._loading = false;
  }

  refresh() { this.fetchAndRender() }

  _tryRestore() {
    if (this._restored || !this._loaded) return;
    if (!this.el.classList.contains('vis')) return;
    if (typeof app === 'undefined' || !app) return;
    const entry = app.mdScrolls && app.mdScrolls.get(this.id);
    if (!entry) { this._restored = true; return; }
    this._applyScroll(entry);
    this._restored = true;
  }

  _applyScroll(entry) {
    if (!entry) return;
    const max = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    let target = entry.top;
    if (target > max + 4 || target < 0) {
      target = Math.round((entry.ratio || 0) * max);
    }
    this._suppressScroll++;
    this.el.scrollTop = target;
    setTimeout(() => { this._suppressScroll = Math.max(0, this._suppressScroll - 1); }, 80);
  }

  _onScroll() {
    if (this._suppressScroll > 0) return;
    if (!this._loaded) return;
    if (typeof app === 'undefined' || !app) return;
    // 50ms throttle: leading edge fires immediately, subsequent events within
    // the window are coalesced into a single trailing flush. Keeps remote
    // viewers visibly in sync during continuous scrolling without flooding the
    // server with PUTs.
    const now = Date.now();
    const last = this._scrollLastSent || 0;
    const since = now - last;
    const fire = () => {
      this._scrollLastSent = Date.now();
      const top = this.el.scrollTop;
      const max = Math.max(1, this.el.scrollHeight - this.el.clientHeight);
      app.saveMdScroll(this.id, top, top / max);
    };
    if (since >= 50) {
      if (this._scrollTimer) { clearTimeout(this._scrollTimer); this._scrollTimer = null; }
      fire();
      return;
    }
    if (this._scrollTimer) return;
    this._scrollTimer = setTimeout(() => {
      this._scrollTimer = null;
      fire();
    }, 50 - since);
  }

  _interceptLinks() {
    this.el.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', e => {
        let href = a.getAttribute('href');
        if (!href || href === '#' || href.startsWith('#')) return;
        e.preventDefault();
        e.stopPropagation();
        try { href = decodeURIComponent(href) } catch {}
        // External URLs → new window
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
          window.open(href, '_blank');
          return;
        }
        // Strip anchor fragment, keep clean path
        const hashIdx = href.indexOf('#');
        const linkHref = hashIdx >= 0 ? href.substring(0, hashIdx) : href;
        // .md links → open as new markdown tab
        if (MD_EXTENSIONS.test(linkHref)) {
          const baseDir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
          const absPath = this._resolve(baseDir, linkHref);
          const name = linkHref.split('/').pop().replace(MD_EXTENSIONS, '');
          const rid = app ? app.focused : null;
          if (rid) app.addTab(rid, 'markdown', { name, filePath: absPath });
          return;
        }
        // Other relative/absolute links → download via API
        const isRel = linkHref.startsWith('./') || linkHref.startsWith('../') ||
          (!linkHref.startsWith('/') && linkHref.includes('/'));
        if (linkHref.startsWith('/') || isRel) {
          const baseDir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
          const absPath = this._resolve(baseDir, linkHref);
          const dl = document.createElement('a');
          dl.href = '/api/md-file?path=' + encodeURIComponent(absPath);
          dl.download = '';
          document.body.appendChild(dl);
          dl.click();
          dl.remove();
        }
      });
    });
  }

  _resolve(base, rel) {
    if (rel.startsWith('/')) return rel;
    const combined = base + '/' + rel;
    const parts = combined.split('/');
    const stack = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') { if (stack.length) stack.pop(); continue; }
      stack.push(p);
    }
    return '/' + stack.join('/');
  }

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  destroy() {
    if (this._scrollTimer) { clearTimeout(this._scrollTimer); this._scrollTimer = null; }
    this.el.remove();
  }
}
