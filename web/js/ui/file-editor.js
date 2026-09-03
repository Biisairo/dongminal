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
    this._findKillMonacoKeys();
    // FR-LSP-39: 호버 provider 는 **언어마다 한 번**이다. 편집기를 여럿 세워도
    // 등록이 늘지 않아야 한다 — 늘면 같은 호버가 여러 번 뜬다. 그 판정은 app 이
    // 갖고 있으므로 여기서는 부르기만 한다.
    if (window.app && window.app._lspHoverRegister) window.app._lspHoverRegister();

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
      // FR-EFP-17: 편집하는 동안 낡은 하이라이트가 남으면 그것이 거짓말이 된다.
      if (this._findVis()) this._findRun(true);
    });

    /**
     * EDITOR_FIND_PANEL_SRS FR-EFP-1·2·3: 검색 키 판정은 **capture** 단계다.
     *
     * 종전에는 bubble 이었다. 키의 실제 대상은 Monaco 안쪽 요소이고 Monaco 의 키
     * 처리도 그 안에 붙어 있으므로, **Monaco 가 먼저 봤다** — 자기 find 위젯을 열고
     * find 입력칸에 포커스를 줬다. 그 뒤 우리 `_edFindInFile` 이 `ed.focus()` 로
     * 포커스를 본문으로 되돌렸고, 그래서 위젯은 떠 있는데 글자를 못 받았다.
     * **타이핑한 글자가 전부 문서에 삽입됐다** (그 SRS §2.2~2.4).
     *
     * capture 로 먼저 보면 매칭된 키는 Monaco 에 닿지 않는다. 매칭되지 않으면
     * `_edTrySearchKey` 는 아무것도 하지 않으므로(FR-EFP-3) 편집기가 그대로 받는다 —
     * 여기서 전파를 멈추면 편집기가 글자를 하나도 받지 못한다.
     *
     * FR-EKB-1·5 는 그대로다: 판정은 app 이 한 벌로 갖는다. 여기서 조합을 다시
     * 적으면 설정에서 바꾼 키가 안쪽에만 반영되지 않는다.
     */
    this.el.addEventListener('keydown', (e) => {
      if (window.app) window.app._edTrySearchKey(e);
    }, true);

    // Keyboard interop: prevent terminal shortcuts from firing in editor
    this.el.addEventListener('keydown', (e) => {
      // 검색 키는 위의 capture 리스너가 이미 판정했다 — 여기서 다시 묻지 않는다.
      // Let Monaco handle everything inside the editor
      e.stopPropagation();
    });

    // Focus handling — notify app when editor receives focus
    this.el.addEventListener('focusin', (e) => {
      // FR-EFP-5: 찾기 패널은 **자기 포커스를 갖는다.** 여기서 되돌리면 질의 칸이
      // 글자를 하나도 받지 못한다 — `ed.focus()` 가 위젯의 포커스를 훔쳤던 것과
      // 같은 종류의 결함이며(그 SRS §2.3), 자리만 다르다.
      if (e.target && e.target.closest && e.target.closest('.fe-find')) return;
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
      if (!this._editor) return;
      // EDITOR_LSP_SRS §2.11b / FR-LSP-26b: **내용이 같으면 넣지 않는다.**
      //
      // `setValue` 는 커서를 1,1 로 되돌리고 undo 스택을 버린다. 그런데 이 갱신은
      // 비동기이고, `_edOpenFile` 은 탭을 활성화한 **직후에** 그 줄로 커서를
      // 옮긴다 (FR-EGS-10) — 그래서 늦게 도착한 이 `setValue` 가 방금 옮긴 커서를
      // 앗아갔다. 이미 열어 둔 파일을 검색 결과나 정의 이동으로 고르면 그 줄로
      // 가지 않는 결함이 그것이었다 (V-EGS-10 이 그것을 잡고 있었다).
      //
      // 같은 내용을 다시 넣는 일은 화면에 아무것도 바꾸지 않으면서 커서와 undo
      // 스택만 버린다. 디스크와 같아졌다는 사실(dirty 해제)만 반영한다.
      if (this._editor.getValue() === content) {
        if (this._dirty) {
          this._dirty = false;
          this._tabLabelAll();
        }
        return;
      }
      // 모델이 공유되므로 이 한 번이 모든 칸의 내용을 되돌린다.
      this._editor.setValue(content);
      this._dirty = false;
      this._tabLabelAll();
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

  /**
   * EDITOR_LSP_SRS FR-LSP-28 / D-9: **침묵은 고장과 구별되지 않는다.**
   *
   * 코드 탐색은 안 되는 경우가 많다 — 서버 없음, 툴체인 없음, 기동 실패, 시간
   * 초과, 결과 없음. 그 다섯이 모두 "아무 일도 일어나지 않음" 으로 보이면 사용자는
   * 전부 우리 버그로 읽는다. 짧은 알림 줄 하나가 그것을 가른다.
   *
   * 자리는 찾기 패널과 같은 규약이다 (편집기 우상단) — 새 개념을 만들지 않는다.
   */
  note(text, ms) {
    if (!text) return;
    if (!this._note) {
      const el = document.createElement('div');
      el.className = 'fe-note';
      this.el.appendChild(el);
      this._note = el;
    }
    this._note.textContent = text;
    this._note.classList.add('vis');
    clearTimeout(this._noteT);
    // 스스로 사라진다 — 닫는 조작을 배워야 하는 알림은 알림이 아니라 창이다.
    this._noteT = setTimeout(() => {
      if (this._note) this._note.classList.remove('vis');
    }, ms || FE_NOTE_MS);
  }

  // ── 파일 내 찾기 패널 (EDITOR_FIND_PANEL_SRS 묶음 B·C·D) ──
  //
  // Monaco 의 find 위젯을 쓰지 않는다 (FR-EFP-25 가 FR-EKB-3 을 개정했다).
  // **검색기는 여전히 Monaco 모델의 것이다** (D-2) — `findMatches` 가 정규식·
  // 대소문자·단어 단위를 이미 전부 받으므로 우리가 만드는 것은 껍데기뿐이다.

  /**
   * FR-EFP-4: Monaco 의 find 위젯을 **여는 모든 키를 닫는다.**
   *
   * `Mod+F` 만 막아도 위젯은 여전히 열린다 (SRS §2.6) — `Mod+H`(바꾸기)·
   * `Mod+E`(선택으로 찾기)·`F3`·`Mod+G`(다음 일치)가 각자 그것을 세운다. 길을
   * 하나만 닫으면 나머지로 들어오고, 그러면 §2.4 의 결함이 그 키들에 남는다.
   *
   * **인스턴스별로 건다** (`monaco.editor.addKeybindingRules` 가 아니다). 그 전역
   * 규칙은 Git 의 diff 뷰에도 걸리는데, 그 뷰에는 우리 패널이 없다 — 거기서
   * 되던 것을 아무것도 되지 않게 만든다 (SRS §2.12 / D-5b). 우리가 닫으려는
   * 것은 **이 편집기의** 위젯이다.
   *
   * 이것은 D-5 의 이중 안전장치다. 첫 겹은 `el` 의 capture 리스너이며 사용자가
   * 배정한 조합을 잡는다. 이 겹이 맡는 것은 **아무 동작에도 배정되지 않은** 조합이다.
   */
  _findKillMonacoKeys() {
    if (!this._editor || typeof monaco === 'undefined') return;
    const M = monaco.KeyMod, K = monaco.KeyCode;
    const noop = () => {};
    const kill = [
      M.CtrlCmd | K.KeyF,               // 찾기
      M.CtrlCmd | K.KeyH,               // 바꾸기 (Windows·Linux)
      M.CtrlCmd | M.Alt | K.KeyF,       // 바꾸기 (macOS)
      M.CtrlCmd | K.KeyE,               // 선택으로 찾기 (macOS)
      M.CtrlCmd | K.F3,                 // 선택으로 찾기 (Windows·Linux)
      K.F3,                             // 다음 일치
      M.Shift | K.F3,                   // 이전 일치
      M.CtrlCmd | K.KeyG,               // 다음 일치 (macOS)
      M.CtrlCmd | M.Shift | K.KeyG,     // 이전 일치 (macOS)
    ];
    for (const kb of kill) this._editor.addCommand(kb, noop);
  }

  _findVis() { return !!(this._find && this._find.classList.contains('vis')) }

  /**
   * FR-EFP-8 / D-3: 패널은 **이 인스턴스의 것**이며 이 인스턴스의 `el` 안에 산다.
   * 앱이 하나를 갖고 돌려 쓰면 두 칸이 같은 질의를 공유하는데, 칸마다 다른 자리를
   * 보고 있으므로 "현재 일치" 가 어느 칸의 것인지 정해지지 않는다.
   *
   * `.file-editor` 는 이미 `position:absolute` 이므로(SRS §2.8) 오버레이가 이 칸의
   * 편집기에만 얹힌다 — 새 좌표계를 만들 필요가 없다.
   */
  _findEnsure() {
    if (this._find) return this._find;
    const opt = (k, label, title) =>
      '<button type="button" class="fe-find-opt" data-opt="' + k + '" title="' + title + '">'
      + label + '</button>';
    const p = document.createElement('div');
    p.className = 'fe-find';
    p.innerHTML =
      '<input class="fe-find-q" type="text" spellcheck="false" autocomplete="off"'
      + ' placeholder="' + ED_FIND_IN_PLACEHOLDER + '">'
      + '<span class="fe-find-count"></span>'
      + opt('case', ED_FIND_OPT_CASE, ED_FIND_OPT_CASE_TITLE)
      + opt('regex', ED_FIND_OPT_REGEX, ED_FIND_OPT_REGEX_TITLE)
      + opt('word', ED_FIND_OPT_WORD, ED_FIND_OPT_WORD_TITLE)
      + '<button type="button" class="fe-find-prev" title="' + ED_FIND_PREV_TITLE + '">↑</button>'
      + '<button type="button" class="fe-find-next" title="' + ED_FIND_NEXT_TITLE + '">↓</button>'
      + '<button type="button" class="fe-find-close" title="' + ED_FIND_CLOSE_TITLE + '">✕</button>';
    this.el.appendChild(p);
    this._find = p;
    this._findOpts = edFindOptsLoad();
    this._findHits = [];
    this._findCur = 0;
    this._findWire(p);
    this._findPaintOpts();
    return p;
  }

  _findWire(p) {
    const q = p.querySelector('.fe-find-q');
    q.addEventListener('input', () => { this._findCur = 0; this._findRun() });
    q.addEventListener('keydown', (e) => {
      // FR-EFP-11: 패널 안에서 누른 키는 밖으로 나가지 않는다 — 앱 단축키가
      // 끼어들면 타이핑 중에 창이 바뀐다. (검색 키 자신은 `el` 의 capture
      // 리스너가 이미 지나갔으므로 FR-EFP-12 의 다시 열기는 여전히 듣는다.)
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.findClose(); return }
      if (e.key === 'Enter') { e.preventDefault(); this._findMove(e.shiftKey ? -1 : 1) }
    });
    for (const b of p.querySelectorAll('.fe-find-opt')) {
      b.addEventListener('click', () => {
        const k = b.dataset.opt;
        this._findOpts[k] = !this._findOpts[k];
        edFindOptsSave(this._findOpts);
        this._findPaintOpts();
        // FR-EFP-22: 옵션을 바꾸면 즉시 다시 검색한다. 처음 일치로 돌아가는
        // 이유는 옵션이 바뀌면 일치의 집합 자체가 달라지기 때문이다.
        this._findCur = 0;
        this._findRun();
        q.focus();
      });
    }
    p.querySelector('.fe-find-prev').addEventListener('click', () => { this._findMove(-1); q.focus() });
    p.querySelector('.fe-find-next').addEventListener('click', () => { this._findMove(1); q.focus() });
    p.querySelector('.fe-find-close').addEventListener('click', () => this.findClose());
  }

  _findPaintOpts() {
    for (const b of this._find.querySelectorAll('.fe-find-opt')) {
      b.classList.toggle('on', !!this._findOpts[b.dataset.opt]);
    }
  }

  /**
   * FR-EFP-13: 편집기가 없는 탭(이진 파일·이미지·로딩 중)에서는 열지 않는다.
   * **거짓을 돌려주는 것이 계약이다** — 부르는 쪽이 그것을 보고 키를 삼키지 않는다.
   *
   * FR-EFP-5: 여기서 `ed.focus()` 를 부르지 않는다. 그것이 §2.3 의 결함이었다.
   * 패널을 여는 일은 **패널에** 포커스를 주는 일이다.
   *
   * FR-EFP-12: 이미 열려 있을 때 다시 불러도 닫지 않는다 — 질의 칸을 다시 고른다.
   */
  findOpen() {
    if (!this._editor) return false;
    const p = this._findEnsure();
    const q = p.querySelector('.fe-find-q');
    // FR-EFP-9: 한 줄 안의 선택 영역은 질의로 싣는다. 여러 줄은 싣지 않는다 —
    // 줄바꿈이 든 질의는 이 패널이 찾을 수 있는 것이 아니다.
    const sel = this._editor.getSelection();
    if (sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) {
      q.value = this._editor.getModel().getValueInRange(sel);
      this._findCur = 0;
    }
    p.classList.add('vis');
    q.focus();
    // 전체 선택해 둔다 — 한 번의 타이핑으로 다른 말로 갈아 칠 수 있어야 한다.
    q.select();
    this._findRun();
    return true;
  }

  findClose() {
    const p = this._find;
    if (!p) return;
    p.classList.remove('vis');
    p.classList.remove('bad-re');
    this._findHits = [];
    this._findCur = 0;
    this._findPaint();  // FR-EFP-18: 하이라이트를 걷는다
    // FR-EFP-10: 사용자가 방금까지 보고 있던 자리로 포커스를 돌린다.
    if (this._editor) this._editor.focus();
  }

  /**
   * 질의를 지금 문서에 대고 일치를 다시 센다.
   *
   * `keep` 은 문서가 바뀌어 다시 세는 경우다 (FR-EFP-17) — 그때 현재 자리를 0 으로
   * 되돌리면 편집할 때마다 시선이 문서 처음으로 튄다. 일치 수가 줄었을 수 있으므로
   * 범위 안으로 접어 넣는다.
   */
  _findRun(keep) {
    const p = this._find;
    if (!p || !this._editor) return;
    const model = this._editor.getModel();
    const query = p.querySelector('.fe-find-q').value;
    const o = this._findOpts;
    p.classList.remove('bad-re');

    if (!query || !model) {
      this._findHits = [];
      this._findCur = 0;
      this._findPaint();
      this._findCount('');
      return;
    }
    // FR-EFP-24: 잘못된 정규식을 조용히 0건으로 보이면 사용자가 없는 줄로 읽는다.
    if (o.regex && !edFindReOk(query)) {
      this._findHits = [];
      this._findCur = 0;
      p.classList.add('bad-re');
      this._findPaint();
      this._findCount(ED_FIND_BAD_RE);
      return;
    }
    // FR-EFP-21 / D-2: 세 옵션이 이 호출의 인자로 그대로 간다. 단어 단위를 끈
    // 상태는 구분자를 **보지 않는 것**이므로 `null` 이다.
    const found = model.findMatches(
      query, false, !!o.regex, !!o.case,
      o.word ? ED_FIND_WORD_SEPARATORS : null,
      false, ED_FIND_MAX_HITS);
    this._findHits = found.map(m => m.range);
    const n = this._findHits.length;
    this._findCur = n ? (keep ? Math.min(this._findCur, n - 1) : this._findCur) : 0;
    this._findPaint();
    this._findCount(n ? (this._findCur + 1) + '/' + n : ED_FIND_NONE);
  }

  // FR-EFP-16: 질의가 비면 수를 말하지 않는다 — 아직 묻지 않은 것이다.
  _findCount(text) {
    const el = this._find && this._find.querySelector('.fe-find-count');
    if (el) el.textContent = text;
  }

  /**
   * FR-EFP-14: 모든 일치를 하이라이트하고 현재 일치는 **그 위에 한 겹 더** 얹는다.
   * 둘이 같은 표시를 받으면 이전/다음이 무엇을 옮겼는지 보이지 않는다.
   */
  _findPaint() {
    if (!this._editor) return;
    if (!this._findDecos) this._findDecos = this._editor.createDecorationsCollection([]);
    this._findDecos.set((this._findHits || []).map((range, i) => ({
      range,
      options: {
        className: i === this._findCur
          ? ED_FIND_HIT_CLASS + ' ' + ED_FIND_HIT_CUR_CLASS
          : ED_FIND_HIT_CLASS,
      },
    })));
  }

  // FR-EFP-19: 끝에서 돌아 감는다 — 마지막 다음은 처음이다.
  _findMove(d) {
    const n = (this._findHits || []).length;
    if (!n) return;
    this._findCur = (this._findCur + d + n) % n;
    // FR-EFP-15: 화면 밖이면 그 자리로 스크롤한다. 포커스는 옮기지 않는다 —
    // 사용자는 여전히 질의 칸에서 타이핑하고 있다 (FR-EFP-5).
    this._editor.revealRangeInCenterIfOutsideViewport(this._findHits[this._findCur]);
    this._findPaint();
    this._findCount((this._findCur + 1) + '/' + n);
  }

  destroy() {
    // 하이라이트는 에디터와 함께 사라지지만, 컬렉션을 명시적으로 걷는다 —
    // dispose 순서에 기대지 않는다.
    if (this._findDecos) { this._findDecos.clear(); this._findDecos = null }
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

/**
 * FR-EFP-23 / D-4: 찾기 옵션은 **기기별**이다 (`localStorage`).
 *
 * 설정 블롭에 사는 값들(`blockBrowserKeys` 등)은 "이 서버가 무엇인가" 를 말한다.
 * 검색 옵션은 그런 값이 아니라 지금 이 손의 버릇이며, 서버에 두면 다른 기계에서
 * 켜 둔 정규식 모드가 따라와 놀라게 된다.
 */
const ED_FIND_OPT_KEYS = ['case', 'regex', 'word'];

function edFindOptsLoad() {
  const o = { case: false, regex: false, word: false };
  let raw = null;
  try { raw = localStorage.getItem(ED_FIND_OPTS_KEY) } catch { raw = null }
  if (!raw) return o;
  let saved = null;
  try { saved = JSON.parse(raw) } catch { saved = null }
  if (!saved || typeof saved !== 'object') return o;
  for (const k of ED_FIND_OPT_KEYS) o[k] = !!saved[k];
  return o;
}

function edFindOptsSave(o) {
  const out = {};
  for (const k of ED_FIND_OPT_KEYS) out[k] = !!o[k];
  try { localStorage.setItem(ED_FIND_OPTS_KEY, JSON.stringify(out)) } catch { /* 사생활 모드 */ }
}

/**
 * FR-EFP-24: 정규식이 쓸 수 있는 것인가.
 *
 * JS 에서 이것을 묻는 길은 생성해 보는 것뿐이다 — 그래서 `try` 가 여기 하나 있고,
 * **이 함수 밖으로 나가지 않는다.** 흐름 제어가 아니라 판정이다.
 */
function edFindReOk(src) {
  try { new RegExp(src); return true } catch { return false }
}

// 테마 전환 훅 (helpers.js applyThemeObj). 이름이 같은 테마를 다시 정의하고
// setTheme 을 부르면 살아 있는 에디터와 diff 뷰가 함께 따라온다 (FR-GIT-49).
FileEditor.applyTheme = function() {
  if (typeof monaco === 'undefined') return;
  const name = monacoTheme();
  if (name !== MONACO_THEME) return;
  monaco.editor.setTheme(name);
};
