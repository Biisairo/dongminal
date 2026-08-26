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

// Monaco 테마 이름. CSS 변수에서 파생하므로 테마가 바뀌면 이 이름의 정의가
// 갱신된다 — 에디터와 diff 뷰가 같은 이름을 쓰므로 함께 따라온다.
const MONACO_THEME = 'dongminal';
const MONACO_THEME_FALLBACK = 'vs-dark';

// diff 의 추가·삭제 색은 **현재 테마의 터미널 팔레트**(green·red)에서 파생한다 —
// 색을 하드코딩하지 않는다 (FR-GIT-119, V47). 여기 두는 것은 색이 아니라 배경과
// 섞는 비율이다: 줄 배경은 옅게, 낱말 배경은 그 위에서 구분되도록 진하게.
const MONACO_DIFF_LINE_MIX = 0.2;
const MONACO_DIFF_TEXT_MIX = 0.36;

// 진행 중인 로드 Promise. 대기 중인 호출자들이 이것을 공유한다.
let monacoLoading = null;

/**
 * Monaco 는 CDN 로드다. 한 번만 로드하고 대기 중인 호출자들이 같은 Promise 를
 * 공유한다. 실패는 캐시하지 않는다 — 네트워크가 돌아오면 다시 시도할 수 있어야
 * 한다.
 */
function loadMonaco() {
  if (typeof monaco !== 'undefined') return Promise.resolve();
  if (monacoLoading) return monacoLoading;
  monacoLoading = new Promise((resolve, reject) => {
    const boot = () => {
      require.config({ paths: { vs: MONACO_CDN } });
      require(['vs/editor/editor.main'], () => resolve(), (err) => reject(err));
    };
    // loader.js 는 이미 붙어 있을 수 있다 — 앞선 시도가 모듈 단계에서 실패한
    // 경우다. 그때 script 를 다시 붙이면 loader 가 중복 정의된다.
    if (typeof require !== 'undefined' && require.config) { boot(); return }
    const script = document.createElement('script');
    script.src = MONACO_CDN + '/loader.js';
    script.onload = boot;
    script.onerror = () => reject(new Error('Failed to load Monaco loader'));
    document.head.appendChild(script);
  });
  monacoLoading.catch(() => { monacoLoading = null });
  return monacoLoading;
}

// 테마는 CSS 변수에서 파생한다. 테마를 바꾸면 diff 색도 따라 바뀐다.
function monacoTheme() {
  if (typeof monaco === 'undefined') return MONACO_THEME_FALLBACK;
  try {
    const style = getComputedStyle(document.documentElement);
    const bg = style.getPropertyValue('--bg').trim();
    const fg = style.getPropertyValue('--text').trim();
    const accent = style.getPropertyValue('--accent').trim();
    if (!bg || !fg) return MONACO_THEME_FALLBACK;

    const [br, gr, bb] = monacoRGB(bg);
    const lum = (0.299 * br + 0.587 * gr + 0.114 * bb) / 255;

    // 팔레트를 얻지 못하면 전경색으로 물러선다 — 없는 색을 발명하지 않는다.
    const term = (typeof getCurrentTheme === 'function' && (getCurrentTheme() || {}).terminal) || {};
    const add = term.green || fg;
    const del = term.red || fg;

    monaco.editor.defineTheme(MONACO_THEME, {
      base: lum < 0.5 ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': bg,
        'editor.foreground': fg,
        'editorCursor.foreground': accent || fg,
        'editor.lineHighlightBackground': monacoMix(fg, bg, 0.08),
        'editor.selectionBackground': monacoMix(fg, bg, 0.15),
        'editorLineNumber.foreground': monacoMix(fg, bg, 0.4),
        'editorLineNumber.activeForeground': fg,
        // diffEditor.* 를 매핑하지 않으면 Monaco 의 기본 초록·빨강이 그대로 남아
        // 테마를 바꿔도 diff 색만 따라오지 않는다 (FR-GIT-119).
        'diffEditor.insertedLineBackground': monacoMix(add, bg, MONACO_DIFF_LINE_MIX),
        'diffEditor.removedLineBackground': monacoMix(del, bg, MONACO_DIFF_LINE_MIX),
        'diffEditor.insertedTextBackground': monacoMix(add, bg, MONACO_DIFF_TEXT_MIX),
        'diffEditor.removedTextBackground': monacoMix(del, bg, MONACO_DIFF_TEXT_MIX),
        'diffEditorGutter.insertedLineBackground': monacoMix(add, bg, MONACO_DIFF_LINE_MIX),
        'diffEditorGutter.removedLineBackground': monacoMix(del, bg, MONACO_DIFF_LINE_MIX),
        'diffEditorOverview.insertedForeground': add,
        'diffEditorOverview.removedForeground': del,
      },
    });
    return MONACO_THEME;
  } catch (e) {
    console.error('[Monaco] defineTheme error:', e);
    return MONACO_THEME_FALLBACK;
  }
}

// 파일 경로 → Monaco 언어 id. 확장자를 모르면 plaintext 다.
function monacoLang(path) {
  return LANG_MAP[monacoExt(path)] || 'plaintext';
}

function monacoRGB(color) {
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

function monacoMix(c1, c2, ratio) {
  const [r1, g1, b1] = monacoRGB(c1);
  const [r2, g2, b2] = monacoRGB(c2);
  return '#' + [r1, g1, b1].map((v, i) =>
    Math.round(v * ratio + [r2, g2, b2][i] * (1 - ratio)).toString(16).padStart(2, '0')
  ).join('');
}

function monacoExt(path) {
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
    return loadMonaco();
  }

  async _fetchFile() {
    const r = await fetch('/api/file/read?path=' + encodeURIComponent(this.filePath));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  _createEditor(content) {
    this.el.innerHTML = '';

    this._editor = monaco.editor.create(this.el, {
      value: content,
      language: monacoLang(this.filePath),
      theme: monacoTheme(),
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
      // 파일 저장은 즉시 신호다 (FR-GIT-18) — 작업 트리가 방금 바뀌었다.
      if (typeof app !== 'undefined' && app) app._gitSignal('write');
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

// 테마 전환 훅 (helpers.js applyThemeObj). 이름이 같은 테마를 다시 정의하고
// setTheme 을 부르면 살아 있는 에디터와 diff 뷰가 함께 따라온다 (FR-GIT-49).
FileEditor.applyTheme = function() {
  if (typeof monaco === 'undefined') return;
  const name = monacoTheme();
  if (name !== MONACO_THEME) return;
  monaco.editor.setTheme(name);
};
