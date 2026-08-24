/**
 * Remote Terminal — file editor tab (Monaco Editor)
 */

const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs';

// Language map: file extension → Monaco language id
const LANG_MAP = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.md': 'markdown', '.mdown': 'markdown', '.markdown': 'markdown',
  '.py': 'python', '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.xml': 'xml', '.svg': 'xml',
  '.sql': 'sql',
  '.toml': 'ini',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
  '.dockerfile': 'dockerfile',
  '.makefile': 'makefile', '.mk': 'makefile',
  '.bat': 'bat', '.cmd': 'bat',
  '.ps1': 'powershell',
  '.lua': 'lua',
  '.r': 'r',
  '.pl': 'perl', '.pm': 'perl',
  '.vim': 'viml',
};

class FileEditor {
  constructor(id, name, filePath) {
    this.id = id;
    this.name = name;
    this.filePath = filePath;
    this.el = document.createElement('div');
    this.el.className = 'file-editor';
    this.el.tabIndex = 0;
    this._editor = null;
    this._loading = true;
    this._dirty = false;

    // Show loading indicator
    this.el.innerHTML = '<div class="fe-loading">Loading editor…</div>';

    this._init();
  }

  async _init() {
    try {
      await this._loadMonaco();
      const content = await this._fetchFile();
      this._createEditor(content);
      this._loading = false;
    } catch (e) {
      console.error('[FileEditor] init error:', e);
      this.el.innerHTML =
        '<div class="fe-error">Failed to load editor' +
        '<div class="fe-error-path">' + this._esc(this.filePath) + '</div></div>';
      this._loading = false;
    }
  }

  _loadMonaco() {
    return new Promise((resolve, reject) => {
      // Already loaded by another editor instance
      if (typeof monaco !== 'undefined') {
        resolve();
        return;
      }
      // Already loading — wait for it
      if (FileEditor._monacoLoading) {
        const check = () => {
          if (typeof monaco !== 'undefined') resolve();
          else if (FileEditor._monacoError) reject(FileEditor._monacoError);
          else setTimeout(check, 50);
        };
        check();
        return;
      }
      FileEditor._monacoLoading = true;

      const script = document.createElement('script');
      script.src = MONACO_CDN + '/loader.js';
      script.onload = () => {
        require.config({ paths: { vs: MONACO_CDN } });
        require(['vs/editor/editor.main'], () => {
          FileEditor._monacoLoading = false;
          resolve();
        }, (err) => {
          FileEditor._monacoLoading = false;
          FileEditor._monacoError = err;
          reject(err);
        });
      };
      script.onerror = () => {
        FileEditor._monacoLoading = false;
        FileEditor._monacoError = new Error('Failed to load Monaco loader');
        reject(FileEditor._monacoError);
      };
      document.head.appendChild(script);
    });
  }

  async _fetchFile() {
    const r = await fetch('/api/file/read?path=' + encodeURIComponent(this.filePath));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  _createEditor(content) {
    this.el.innerHTML = '';

    const ext = this._ext(this.filePath);
    const lang = LANG_MAP[ext] || 'plaintext';

    this._editor = monaco.editor.create(this.el, {
      value: content,
      language: lang,
      theme: this._resolveTheme(),
      automaticLayout: true,
      minimap: { enabled: true, scale: 1, showSlider: 'mouseover' },
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 4,
      insertSpaces: true,
      fontSize: 13,
      fontFamily: "'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace",
      lineHeight: 1.5,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      smoothScrolling: true,
      cursorBlinking: 'blink',
      cursorSmoothCaretAnimation: 'on',
    });


    // Ensure Monaco fills the container after DOM insertion
    requestAnimationFrame(() => {
      if (this._editor) this._editor.layout();
    });
    // Save on Ctrl+S / Cmd+S
    this._editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => this.save()
    );

    // Track dirty state
    this._editor.onDidChangeModelContent(() => {
      if (!this._dirty) {
        this._dirty = true;
        this._updateTabLabel();
      }
    });

    // Keyboard interop: prevent terminal shortcuts from firing in editor
    this.el.addEventListener('keydown', (e) => {
      // Let Monaco handle everything inside the editor
      e.stopPropagation();
    });

    // Focus handling — notify app when editor receives focus
    this.el.addEventListener('focusin', () => {
      if (this._editor) this._editor.focus();
    });
  }

  async save() {
    if (!this._editor || !this._dirty) return;
    const content = this._editor.getValue();
    try {
      const r = await fetch('/api/file/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.filePath, content }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      this._dirty = false;
      this._updateTabLabel();
    } catch (e) {
      console.error('[FileEditor] save error:', e);
      // Visual feedback — flash the editor border red briefly
      this.el.style.boxShadow = 'inset 0 0 0 2px #f44';
      setTimeout(() => { this.el.style.boxShadow = ''; }, 500);
    }
  }

  refresh() {
    if (this._loading) return;
    this._fetchFile().then(content => {
      if (this._editor) {
        this._editor.setValue(content);
        this._dirty = false;
        this._updateTabLabel();
      }
    }).catch(e => console.error('[FileEditor] refresh error:', e));
  }

  _updateTabLabel() {
    // Update the tab data model so dirty state survives re-renders
    const s = app._aw();
    if (s) {
      for (const n of (s.layout ? [s.layout] : [])) {
        const walk = n => {
          if (!n) return;
          if (n.type === 'pane' && n.tabs) {
            const tab = n.tabs.find(t => t.id === this.id);
            if (tab) tab.dirty = this._dirty;
          }
          if (n.type === 'split' && n.children) n.children.forEach(walk);
        };
        walk(n);
      }
    }
    // Also update DOM immediately for instant feedback
    const tabEl = document.querySelector('.pn-tab[data-tab-id="' + this.id + '"] .pn-tab-label');
    if (tabEl) {
      tabEl.textContent = (this._dirty ? '● ' : '') + this.name;
    }
  }
  _resolveTheme() {
    try {
      const style = getComputedStyle(document.documentElement);
      const bg = style.getPropertyValue('--bg').trim();
      const fg = style.getPropertyValue('--text').trim();
      const accent = style.getPropertyValue('--accent').trim();
      if (!bg || !fg) return 'vs-dark';

      const [br, gr, bb] = this._parseRGB(bg);
      const lum = (0.299 * br + 0.587 * gr + 0.114 * bb) / 255;
      const base = lum < 0.5 ? 'vs-dark' : 'vs';

      monaco.editor.defineTheme('dongminal', {
        base: base,
        inherit: true,
        rules: [],
        colors: {
          'editor.background': bg,
          'editor.foreground': fg,
          'editorCursor.foreground': accent || fg,
          'editor.lineHighlightBackground': this._mix(fg, bg, 0.08),
          'editor.selectionBackground': this._mix(fg, bg, 0.15),
          'editorLineNumber.foreground': this._mix(fg, bg, 0.4),
          'editorLineNumber.activeForeground': fg,
        },
      });
      return 'dongminal';
    } catch (e) {
      console.error('[FileEditor] defineTheme error:', e);
      return 'vs-dark';
    }
  }


  _parseRGB(color) {
    if (!color) return [0, 0, 0];
    if (color.startsWith('#')) {
      const h = color.replace('#', '');
      return [
        parseInt(h.substring(0, 2), 16),
        parseInt(h.substring(2, 4), 16),
        parseInt(h.substring(4, 6), 16),
      ];
    }
    const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
    return [0, 0, 0];
  }

  _mix(c1, c2, ratio) {
    const [r1, g1, b1] = this._parseRGB(c1);
    const [r2, g2, b2] = this._parseRGB(c2);
    return '#' + [r1, g1, b1].map((v, i) =>
      Math.round(v * ratio + [r2, g2, b2][i] * (1 - ratio)).toString(16).padStart(2, '0')
    ).join('');
  }


  _ext(path) {
    const base = path.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot >= 0) {
      const ext = base.substring(dot).toLowerCase();
      if (LANG_MAP[ext]) return ext;
    }
    if (dot >= 0) {
      const prev = base.lastIndexOf('.', dot - 1);
      if (prev >= 0) {
        const doubleExt = base.substring(prev).toLowerCase();
        if (LANG_MAP[doubleExt]) return doubleExt;
      }
    }
    const lower = base.toLowerCase();
    if (lower === 'dockerfile') return '.dockerfile';
    if (lower === 'makefile' || lower === 'gnumakefile') return '.makefile';
    return '';
  }
  _esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  focus() {
    if (this._editor) {
      this._editor.focus();
    } else {
      this.el.focus();
    }
  }

  destroy() {
    if (this._editor) {
      this._editor.dispose();
      this._editor = null;
    }
  }
}

// Re-define Monaco theme from current CSS variables and update all live editors.
FileEditor.applyTheme = function() {
  if (typeof monaco === 'undefined') return;
  try {
    const style = getComputedStyle(document.documentElement);
    const bg = style.getPropertyValue('--bg').trim();
    const fg = style.getPropertyValue('--text').trim();
    const accent = style.getPropertyValue('--accent').trim();
    const dim = style.getPropertyValue('--text-dim').trim();
    if (!bg || !fg) return;

    const p = (c) => {
      if (!c) return [0,0,0];
      if (c.startsWith('#')) { const h=c.replace('#',''); return [parseInt(h.substring(0,2),16),parseInt(h.substring(2,4),16),parseInt(h.substring(4,6),16)] }
      const m=c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/); if(m) return [parseInt(m[1]),parseInt(m[2]),parseInt(m[3])];
    };
    const toHex = (r,g,b) => '#'+[r,g,b].map(c=>Math.round(c).toString(16).padStart(2,'0')).join('');
    const mix = (c1, c2, r) => { const [r1,g1,b1]=p(c1); const [r2,g2,b2]=p(c2); return toHex(r1*r+r2*(1-r), g1*r+g2*(1-r), b1*r+b2*(1-r)) };

    const [br, gr, bb] = p(bg);
    const lum = (0.299*br + 0.587*gr + 0.114*bb)/255;
    const base = lum < 0.5 ? 'vs-dark' : 'vs';

    monaco.editor.defineTheme('dongminal', {
      base, inherit: true, rules: [],
      colors: {
        'editor.background': bg,
        'editor.foreground': fg,
        'editorCursor.foreground': accent || fg,
        'editor.lineHighlightBackground': mix(fg, bg, 0.08),
        'editor.selectionBackground': mix(fg, bg, 0.15),
        'editorLineNumber.foreground': mix(fg, bg, 0.4),
        'editorLineNumber.activeForeground': fg,
      },
    });

    if (typeof app !== 'undefined' && app.fileEditors) {
      for (const e of app.fileEditors.values()) {
        if (e._editor) monaco.editor.setTheme('dongminal');
      }
    }
  } catch (e) { console.error('[FileEditor] applyTheme error:', e); }
};
