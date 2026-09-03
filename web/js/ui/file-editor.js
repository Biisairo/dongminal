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
    // FR-SVS-50: 내용과 dirty 는 **문서**의 것이다. 아래 접근자가 `this._dirty` 를
    // 그대로 문서로 잇는다 — 이 뷰의 본문은 그 자리가 어디인지 알 필요가 없다.
    // 문서를 아직 못 얻었을 때(이진·이미지·로딩 실패)를 위한 폴백이 `__dirty` 다.
    this.__dirty = false;
    this._doc = (typeof app !== 'undefined' && app && app._edDoc) ? app._edDoc(filePath) : null;
    if (this._doc) this._doc.views.add(this);
    // EDITOR_GIT_UX_SRS FR-EGS-10: 검색 결과로 열린 경우 갈 자리. Monaco 가
    // 뜨기 전에 요청이 올 수 있으므로 여기 담아 두었다 생성 직후에 쓴다.
    this._pendingReveal = null;

    // Show loading indicator
    this.el.innerHTML = '<div class="fe-loading">Loading editor…</div>';

    this._init();
  }

  get _dirty() { return this._doc ? this._doc.dirty : this.__dirty }
  set _dirty(v) { if (this._doc) this._doc.dirty = v; else this.__dirty = v }

  // FR-SVS-54: dirty 는 문서의 것이므로 같은 파일을 보는 **모든 칸**의 탭이
  // 동시에, 같게 표시된다.
  _tabLabelAll() {
    if (!this._doc) { this._updateTabLabel(); return }
    for (const v of this._doc.views) v._updateTabLabel();
  }

  async _init() {
    try {
      // EDITOR_GIT_UX_SRS FR-EVW-3: **열기 전에 종류를 묻는다.** 이 물음이
      // 없던 동안 이진 파일은 대체 문자로 뒤덮인 채 Monaco 에 올라갔고, 그것을
      // 저장하면 원본이 파괴됐다 — 알림이 없는 것보다 나쁘다.
      const probe = await this._probeFile();
      this.kind = probe.kind;
      if (probe.kind === FILE_KIND_BINARY) { this._showUnsupported(probe); this._loading = false; return }
      if (probe.kind === FILE_KIND_IMAGE) { this._showImage(probe); this._loading = false; return }
      await this._loadMonaco();
      // FR-SVS-50: 다른 칸이 이미 이 파일을 열어 두었으면 그 문서를 그대로 쓴다 —
      // 내용을 다시 받지 않는다. 받아 오면 그 사이의 편집이 덮인다.
      const content = (this._doc && this._doc.model) ? null : await this._fetchFile();
      this._createEditor(content);
      this._loading = false;
    } catch (e) {
      console.error('[FileEditor] init error:', e);
      this.el.innerHTML =
        '<div class="fe-error">Failed to load editor' +
        '<div class="fe-error-path">' + escHtml(this.filePath) + '</div></div>';
      this._loading = false;
    }
  }

  /**
   * FR-EVW-1: 서버가 내용을 보고 판정한다 (FR-EVW-2) — 확장자는 근거가 아니다.
   *
   * FR-EVW-8: 종단이 없거나 실패하면 **텍스트로 가정한다.** 옛 서버에 붙은 새
   * 브라우저에서 편집기가 통째로 서지 않는 것보다, 지금까지의 동작을 유지하는
   * 편이 낫다.
   */
  async _probeFile() {
    try {
      const r = await fetch(FILE_PROBE_API + '?path=' + encodeURIComponent(this.filePath));
      if (!r.ok) return { kind: FILE_KIND_TEXT };
      const j = await r.json();
      return j && j.kind ? j : { kind: FILE_KIND_TEXT };
    } catch {
      return { kind: FILE_KIND_TEXT };
    }
  }

  // FR-EVW-3: 열지 않고 사유를 보인다. Monaco 를 세우지 않으므로 저장 경로
  // 자체가 생기지 않는다 (FR-EVW-7).
  _showUnsupported(probe) {
    this.el.innerHTML =
      '<div class="fe-unsupported">' +
        '<div class="fe-unsup-title">' + FILE_UNSUPPORTED_TITLE + '</div>' +
        '<div class="fe-unsup-path">' + escHtml(this.filePath) + '</div>' +
        '<div class="fe-unsup-meta">' +
          escHtml(probe.mime || '') + ' · ' + this._fmtBytes(probe.size) +
        '</div>' +
        '<div class="fe-unsup-hint">' + FILE_UNSUPPORTED_HINT + '</div>' +
      '</div>';
  }

  // FR-EVW-4: 원본 비율을 지키고 칸보다 크면 줄여 맞춘다. 바이트는
  // /api/file/raw 가 준다 — 이미지 MIME 만 인라인으로 나온다 (FR-EVW-5).
  _showImage(probe) {
    const src = FILE_RAW_API + '?path=' + encodeURIComponent(this.filePath);
    this.el.innerHTML =
      '<div class="fe-image">' +
        '<img class="fe-img" alt="' + escHtml(this.filePath) + '">' +
        '<div class="fe-img-meta"></div>' +
      '</div>';
    const img = this.el.querySelector('.fe-img');
    const meta = this.el.querySelector('.fe-img-meta');
    img.addEventListener('load', () => {
      meta.textContent = img.naturalWidth + '×' + img.naturalHeight +
        ' · ' + (probe.mime || '') + ' · ' + this._fmtBytes(probe.size);
    });
    img.addEventListener('error', () => {
      meta.textContent = FILE_IMAGE_FAIL;
    });
    img.src = src;
  }

  _fmtBytes(n) {
    const b = Number(n);
    if (!isFinite(b)) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  _loadMonaco() {
    return loadMonaco();
  }

  async _fetchFile() {
    const r = await fetch('/api/file/read?path=' + encodeURIComponent(this.filePath));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  /**
   * 이 파일의 Monaco 모델. 문서가 이미 들고 있으면 그것이고, 없으면 지금 만든다.
   *
   * URI 는 파일 경로에서 나온다 — Monaco 는 같은 URI 의 모델을 둘 만들지 않으므로
   * 그것이 "파일 하나에 문서 하나" (D-7) 를 한 겹 더 보장한다.
   */
  _model(content) {
    if (this._doc && this._doc.model) return this._doc.model;
    const uri = monaco.Uri.file(this.filePath);
    const model = monaco.editor.getModel(uri)
      || monaco.editor.createModel(content || '', monacoLang(this.filePath), uri);
    if (this._doc) this._doc.model = model;
    return model;
  }

  _createEditor(content) {
    this.el.innerHTML = '';

    // FR-SVS-51·52: 모델 하나를 여러 에디터에 붙인다 (D-6). Monaco 가 공식으로
    // 지원하는 형태이며, 그때 **커서·선택·스크롤·접힘은 에디터별로 남는다** —
    // 그것이 시선이고 칸마다 달라야 하는 것이다. 내용만 공유된다.
    this._editor = monaco.editor.create(this.el, {
      model: this._model(content),
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
      // NOTES_LIVE_EXPLORER_SRS FR-CUR-1: 캐럿은 **애니메이션 없이** 옮겨간다.
      // `'on'` 이면 커서가 이전 자리에서 새 자리로 미끄러지는데, 그것이 타이핑과
      // 이동에 지연으로 느껴진다. `'off'` 가 Monaco 의 기본값이자 VS Code 의
      // 기본값이다 — 끄는 것이 곧 "vsc 처럼" 이다.
      //
      // 깜빡임(cursorBlinking)은 그대로다 (FR-CUR-2). 움직임과 깜빡임은 다른
      // 것이고 접수한 말의 대상은 앞의 것이다.
      cursorSmoothCaretAnimation: 'off',
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
    // 모델이 공유되므로 이 이벤트는 같은 파일을 보는 에디터 **모두**에 온다.
    // dirty 설정은 멱등이고, 라벨은 칸마다 있으므로 전부 갱신한다 (FR-SVS-54).
    this._editor.onDidChangeModelContent(() => {
      if (!this._dirty) {
        this._dirty = true;
        this._tabLabelAll();
      }
    });

    // Keyboard interop: prevent terminal shortcuts from firing in editor
    this.el.addEventListener('keydown', (e) => {
      // FR-EKB-1·5: 편집기 검색 셋은 Monaco **안에서도** 떠야 한다. 판정은
      // app 이 한 벌로 갖는다 — 여기서 조합을 다시 적으면 설정에서 바꾼 키가
      // 안쪽에만 반영되지 않는다.
      if (window.app && window.app._edTrySearchKey(e)) return;
      // Let Monaco handle everything inside the editor
      e.stopPropagation();
    });

    // Focus handling — notify app when editor receives focus
    this.el.addEventListener('focusin', () => {
      if (this._editor) this._editor.focus();
    });

    // FR-EKB-5: `addCommand` 로 굳히지 않는다. 그것은 조합을 코드에 박는 일이고,
    // 박으면 설정에서 바꾼 키가 Monaco 안에서만 듣지 않는다 — 위의 keydown 이
    // 그 자리를 대신한다. 전역 keydown 은 편집기에 포커스가 있는 동안 한 줄도
    // 돌지 않으므로(input-binding.js 의 activeElement 게이트) 이 배선이 필요하다.

    if (this._pendingReveal) {
      const r = this._pendingReveal; this._pendingReveal = null;
      this.revealLine(r.line, r.col);
    }
  }

  /**
   * FR-EGS-10: 검색 결과가 가리키는 줄로 옮긴다. Monaco 가 아직 뜨지 않았으면
   * 담아 두었다 생성 직후에 쓴다 — 탭 생성과 Monaco 로드는 비동기이고, 부르는
   * 쪽이 그 순서를 알 이유가 없다.
   */
  revealLine(line, col) {
    const ln = Math.max(1, parseInt(line, 10) || 1);
    const cl = Math.max(1, parseInt(col, 10) || 1);
    if (!this._editor) { this._pendingReveal = { line: ln, col: cl }; return }
    this._editor.revealLineInCenter(ln);
    this._editor.setPosition({ lineNumber: ln, column: cl });
    this._editor.focus();
  }

  async save() {
    if (!this._editor || !this._dirty) return;
    // FR-SVS-53: 저장은 **문서 하나에 대한 한 번**이다. 두 칸이 같은 파일을 볼 때
    // 양쪽에서 Ctrl+S 가 겹치면 같은 내용을 두 번 쓰게 되고, 그 사이의 편집이
    // 어느 쪽 버퍼에 담겼는지에 따라 결과가 갈린다.
    if (this._doc && this._doc.saving) return;
    if (this._doc) this._doc.saving = true;
    const content = this._editor.getValue();
    try {
      const r = await fetch('/api/file/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.filePath, content }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      this._dirty = false;
      this._tabLabelAll();
      // 파일 저장은 즉시 신호다 (FR-GIT-18) — 작업 트리가 방금 바뀌었다.
      if (typeof app !== 'undefined' && app) app._gitSignal('write');
    } catch (e) {
      console.error('[FileEditor] save error:', e);
      // Visual feedback — flash the editor border red briefly
      this.el.style.boxShadow = 'inset 0 0 0 2px #f44';
      setTimeout(() => { this.el.style.boxShadow = ''; }, 500);
    } finally {
      if (this._doc) this._doc.saving = false;
    }
  }

  refresh() {
    if (this._loading) return;
    this._fetchFile().then(content => {
      if (this._editor) {
        // 모델이 공유되므로 이 한 번이 모든 칸의 내용을 되돌린다.
        this._editor.setValue(content);
        this._dirty = false;
        this._tabLabelAll();
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
    // Also update DOM immediately for instant feedback.
    // 같은 탭의 DOM 이 칸마다 있다 — 하나만 고치면 나머지 칸의 `● ` 가 낡는다.
    for (const tabEl of document.querySelectorAll(
      '.pn-tab[data-tab-id="' + this.id + '"] .pn-tab-label')) {
      tabEl.textContent = (this._dirty ? '● ' : '') + this.name;
    }
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
      // 모델은 **에디터의 것이 아니다** — `{model}` 로 준 것은 dispose 되지 않는다.
      // 문서의 수명은 `_edDocDrop` 이 정한다 (FR-SVS-55).
      this._editor.dispose();
      this._editor = null;
    }
    if (typeof app !== 'undefined' && app && app._edDocDrop) {
      app._edDocDrop(this.filePath, this);
    }
    this._doc = null;
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
