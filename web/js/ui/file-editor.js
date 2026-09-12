/**
 * Remote Terminal — file editor tab (Monaco Editor)
 */

// 편집기는 **바이너리 안에서** 온다 (MONACO_VENDORING_SRS FR-MVN-3).
//
// 종전에는 `cdn.jsdelivr.net` 에서 SRI 없이 받았다 — 그 호스트가 주는 것이 무엇이든
// 이 페이지에서 실행됐고, 이 페이지에는 셸과 파일 API 가 열려 있다. 그리고 인터넷이
// 없으면 편집기·Diff·LSP 뷰가 통째로 서지 않았다.
//
// 담긴 파일은 `.gz` 이고 서버가 그대로 흘린다 — raw 23.3MB 가 5.4MB 로 들어간 이유다.
const MONACO_BASE = '/vendor/monaco/vs';

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
      require.config({ paths: { vs: MONACO_BASE } });
      require(['vs/editor/editor.main'], () => resolve(), (err) => reject(err));
    };
    // loader.js 는 이미 붙어 있을 수 있다 — 앞선 시도가 모듈 단계에서 실패한
    // 경우다. 그때 script 를 다시 붙이면 loader 가 중복 정의된다.
    if (typeof require !== 'undefined' && require.config) { boot(); return }
    const script = document.createElement('script');
    script.src = MONACO_BASE + '/loader.js';
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
  const base = pathBase(path);
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
    // FR-EXC-11: 표식의 폴백. 자리는 `__dirty` 와 같다 — 문서를 못 얻은 뷰도
    // 저장은 할 수 있어야 한다.
    this.__stamp = '';
    this._doc = (typeof app !== 'undefined' && app && app.edDoc) ? app.edDoc(filePath) : null;
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

  // FR-EXC-11: 표식도 **문서**의 것이다 (FR-SVS-50 과 같은 근거). 두 칸이 같은
  // 파일을 볼 때 한쪽의 저장이 다른 칸의 표식을 낡은 채 두면, 그 칸의 다음
  // 저장이 **자기 편이 만든 변경**에 걸려 경합이 된다.
  get _stamp() { return this._doc ? this._doc.stamp : this.__stamp }
  set _stamp(v) { if (this._doc) this._doc.stamp = v; else this.__stamp = v }

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
      // FR-FAB-9: 상한을 넘으면 Monaco 를 세우지 않는다. 세우지 않으므로 저장
      // 경로 자체가 생기지 않는다 — 잘린 내용을 되쓸 길이 없다.
      if (this._overSizeLimit(probe)) { this._showTooLarge(probe); this._loading = false; return }
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
    const r = await apiGet(FILE_PROBE_API, { query: { path: this.filePath } });
    if (!r.ok) return { kind: FILE_KIND_TEXT };
    return r.data && r.data.kind ? r.data : { kind: FILE_KIND_TEXT };
  }

  /**
   * FR-FAB-9: 판정의 값은 **서버가 준 것**이다. `maxBytes` 가 없는 옛 서버에
   * 붙었으면 게이트를 걸지 않는다 — 옛 서버에서 편집기가 통째로 막히는 것보다
   * 지금까지의 동작을 유지하는 편이 낫다 (FR-EVW-8 과 같은 관대함이다).
   */
  _overSizeLimit(probe) {
    const max = Number(probe && probe.maxBytes);
    const size = Number(probe && probe.size);
    if (!isFinite(max) || max <= 0 || !isFinite(size)) return false;
    return size > max;
  }

  // FR-FAB-9: 사유와 함께 **나가는 길 둘**을 준다. 막기만 하면 사용자는 그
  // 파일을 어떻게 보는지 모른 채 남는다.
  _showTooLarge(probe) {
    const href = FILE_DOWNLOAD_API + '?path=' + encodeURIComponent(this.filePath);
    this.el.innerHTML =
      '<div class="fe-unsupported">' +
        '<div class="fe-unsup-title">' + FILE_TOO_LARGE_TITLE + '</div>' +
        '<div class="fe-unsup-path">' + escHtml(this.filePath) + '</div>' +
        '<div class="fe-unsup-meta">' +
          escHtml(this._fmtFileSize(probe.size)) + ' · 상한 ' + escHtml(this._fmtFileSize(probe.maxBytes)) +
        '</div>' +
        '<div class="fe-unsup-hint">' + FILE_TOO_LARGE_HINT + '</div>' +
        '<a class="fe-unsup-dl" download href="' + escHtml(href) + '">' + FILE_TOO_LARGE_DOWNLOAD + '</a>' +
      '</div>';
  }

  // FR-EVW-3: 열지 않고 사유를 보인다. Monaco 를 세우지 않으므로 저장 경로
  // 자체가 생기지 않는다 (FR-EVW-7).
  _showUnsupported(probe) {
    this.el.innerHTML =
      '<div class="fe-unsupported">' +
        '<div class="fe-unsup-title">' + FILE_UNSUPPORTED_TITLE + '</div>' +
        '<div class="fe-unsup-path">' + escHtml(this.filePath) + '</div>' +
        '<div class="fe-unsup-meta">' +
          escHtml(probe.mime || '') + ' · ' + escHtml(this._fmtFileSize(probe.size)) +
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
        ' · ' + (probe.mime || '') + ' · ' + this._fmtFileSize(probe.size);
    });
    img.addEventListener('error', () => {
      meta.textContent = FILE_IMAGE_FAIL;
    });
    img.src = src;
  }

  /**
   * **파일 크기**의 표기 (M6 `FE-22`).
   *
   * `app-statusbar` 의 `_fmtMemSize` 와 **합치지 마라.** 겉이 비슷하고 이름도
   * 같았지만(`_fmtBytes`) 두 함수는 다른 값을 위한 것이다:
   *
   *   여기      파일 크기. **B·KB 가 뜻을 갖는다** — 수십 바이트짜리 파일이
   *             실재하고, 그것을 `0.0MB` 로 적으면 사실을 지운다. 단위 앞에
   *             공백이 있다
   *   statusbar 시스템 메모리. 언제나 MB 이상이고 공백이 없다
   *
   * 이름이 같았던 것이 `FE-22` 가 "두 벌" 로 읽은 이유다. 합치면 두 화면 중
   * 하나의 표기가 조용히 바뀐다 — 그래서 합치는 대신 **이름을 갈랐다**.
   */
  _fmtFileSize(n) {
    const b = Number(n);
    if (!isFinite(b)) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  _loadMonaco() {
    return loadMonaco();
  }

  /**
   * 파일 원문 하나. **표식을 함께 거둔다** (FR-EXC-11).
   *
   * 원문을 그대로 받는다 — 이 종단은 JSON 이 아니라 파일 내용을 낸다 (FR-CAPI-11).
   * 그래서 표식이 실릴 자리는 헤더뿐이다. 값은 **불투명하다** — 여기서 뜻을 읽지
   * 않고 저장 때 그대로 되돌려 보낸다. 판정은 서버의 것이다 (FR-EXC-6).
   */
  async _fetchFile() {
    const r = await apiGet('/api/file/read', { query: { path: this.filePath }, parse: false });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    this._stamp = (r.headers && r.headers.get(FILE_STAMP_HEADER)) || '';
    return r.text;
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
      /**
       * UX_BATCH8_SRS FR-MMP-2: `size:'fill'` — **미리보기가 스크롤바와 같은
       * 좌표계에 선다. 늘려서라도.**
       *
       *   이전 동작: `'fit'` (FR-MMP-1). 줄이기만 하므로 **문서가 편집기보다
       *             짧으면 아무것도 하지 않는다** — 그때 미니맵은 자기 콘텐츠
       *             높이(줄수×2px)를 좌표계로 삼아 스크롤바와 갈라선다
       *   새  동작: 문서 길이와 무관하게 미니맵 높이가 편집기 높이다
       *   이유:     접수 — "minimap 과 스크롤이 동기화 되지 않음", "vsc 에서는
       *             미니맵을 늘려서라도 적용되게 하던데". 실측(400줄·높이 1180)
       *             45% 지점에서 `fit` 은 미니맵 `{top:311}` · 스크롤바
       *             `{top:454}`, `fill` 은 둘 다 `{top:454,h:171}`. 3000줄에서는
       *             둘 다 일치하므로 긴 문서의 결과는 바뀌지 않는다
       */
      minimap: { enabled: true, size: 'fill', scale: 1, showSlider: 'mouseover' },
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      // WORKBENCH_REVIEW_SRS FR-WBR-10: 설정이 정한다. 기본은 끔이다.
      wordWrap: editorWordWrap ? 'on' : 'off',
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
    TIMERS.frame(() => {
      if (this._editor) this._editor.layout();
    },{owner:this,label:'editor-frame'});
    this._findKillMonacoKeys();
    this._lspKillMonacoKeys();
    this._lspBindClick();
    // FR-LSP-39: 호버 provider 는 **언어마다 한 번**이다. 편집기를 여럿 세워도
    // 등록이 늘지 않아야 한다 — 늘면 같은 호버가 여러 번 뜬다. 그 판정은 app 이
    // 갖고 있으므로 여기서는 부르기만 한다.
    if (window.app && window.app.lspHoverRegister) window.app.lspHoverRegister();
    // FR-LSP-44: 이 파일의 언어 서버가 없으면 제안한다. 판정은 app 이 하며
    // 상태를 파일마다 다시 묻지 않는다.
    if (window.app && window.app.lspOfferFor) window.app.lspOfferFor(this);
    // DOC_RENDER_VIEW_SRS FR-DRV-2·3: 렌더할 수 있는 문서면 버튼을 세우고, 이
    // 파일의 렌더 뷰에 모델이 생겼음을 알린다. 판정과 버튼은 app 이 갖는다 —
    // 편집기는 자기가 무슨 문서인지 알 필요가 없다.
    if (window.app && window.app.docRenderMount) window.app.docRenderMount(this);

    // Track dirty state
    // 모델이 공유되므로 이 이벤트는 같은 파일을 보는 에디터 **모두**에 온다.
    // dirty 설정은 멱등이고, 라벨은 칸마다 있으므로 전부 갱신한다 (FR-SVS-54).
    this._editor.onDidChangeModelContent((e) => {
      if (!this._dirty) {
        this._dirty = true;
        this._tabLabelAll();
        // REPO_TAB_UNIFY_SRS FR-RTU-42: **편집을 시작하면 고정된다.** 고치던
        // 파일이 다음 클릭에 사라지면 그것은 미리보기가 아니라 사고다.
        //
        // **`setValue` 는 편집이 아니다.** `refresh()` 가 디스크의 내용을 다시
        // 넣을 때도 이 이벤트가 오는데(그 직후 dirty 를 되돌린다), 그것까지
        // 편집으로 세면 파일을 열자마자 미리보기가 고정된다(실측). Monaco 가
        // 그 구분을 `isFlush` 로 준다.
        if (!(e && e.isFlush)) this._pinIfPreview();
      }
      // FR-EFP-17: 편집하는 동안 낡은 하이라이트가 남으면 그것이 거짓말이 된다.
      if (this._findVis()) this._findRun(true);
      // FR-EDD-53: 변경 표시도 같은 계기다. 디바운스는 관리자가 갖는다 —
      // 모델이 공유되므로 이 이벤트는 칸마다 오고, 계산은 한 번이어야 한다.
      if (this._dd) this._dd.schedule();
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
     * `edTrySearchKey` 는 아무것도 하지 않으므로(FR-EFP-3) 편집기가 그대로 받는다 —
     * 여기서 전파를 멈추면 편집기가 글자를 하나도 받지 못한다.
     *
     * FR-EKB-1·5 는 그대로다: 판정은 app 이 한 벌로 갖는다. 여기서 조합을 다시
     * 적으면 설정에서 바꾼 키가 안쪽에만 반영되지 않는다.
     */
    this.el.addEventListener('keydown', (e) => {
      if (window.app && window.app.edTrySearchKey(e)) return;
      // UX_BATCH9_SRS FR-ESV-1·2: **이 편집기의** 액션. 여섯과 같은 자리에서
      // 판정하되 수행은 인스턴스가 한다 — 포커스가 있는 편집기가 곧 이 요소의
      // 임자이므로, "어느 편집기를 저장할 것인가" 를 따로 고르지 않는다.
      this._edViewKey(e);
    }, true);

    // FR-EDD-34: 팝업을 닫는 길 둘 중 하나. 찾기 패널이 포커스를 갖고 있으면
    // 그 패널의 핸들러가 먼저 먹고 전파를 멈추므로(`_findWire`) 이 자리는 돌지
    // 않는다 — 두 Escape 가 다투지 않는다.
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._ddZone) { e.preventDefault(); this._ddClose() }
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
    //
    // UX_BATCH9_SRS FR-ESV-2: **저장도 여기 합류했다.** 그것만 `addCommand` 로
    // 남아 있었고, 그 등록이 인스턴스가 아니라 전역이라 편집기를 둘 열면 `Cmd+S`
    // 가 마지막에 만든 편집기로 갔다 (SRS §2.1).

    // EDITOR_DIRTY_DIFF_SRS FR-EDD-15: 변경 표시는 **모델**의 것이다 — 이 칸은
    // 클릭과 팝업만 갖는다. `file-editor-diff.js` 가 없으면 편집기는 지금까지와
    // 똑같이 동작한다 (NFR-EDD-3).
    if (this._ddInit) this._ddInit();

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

  /**
   * WORKBENCH_REVIEW_SRS FR-WBR-11: 설정이 바뀌면 **이미 열려 있는** 편집기도
   * 곧바로 따라간다.
   *
   * `updateOptions` 는 옵션만 갈아끼운다 — 모델도 뷰 상태도 그대로이므로 편집
   * 중인 내용과 커서를 잃지 않는다 (NFR-WBR-1). 아직 Monaco 가 뜨지 않았으면
   * 할 일이 없다: 생성 인자가 같은 값을 읽는다.
   */
  applyWordWrap() {
    if (!this._editor) return;
    this._editor.updateOptions({ wordWrap: editorWordWrap ? 'on' : 'off' });
  }

  /**
   * FR-LSP-60·67 (U-1): **Cmd/Ctrl+클릭으로 정의로 간다.**
   *
   * 계기를 우리가 잡는 이유는 실측이다 — 이 판의 Monaco 는 링크 제스처 기여가
   * 서 있는데도(`getContribution('editor.contrib.gotodefinitionatposition')` 이
   * 참이다) 제스처에 **provider 를 묻지 않는다.** 수정 키가 DOM 이벤트에 실려
   * 오는 것까지 확인했고(`metaKey:true`), 그런데도 요청이 0건이었다.
   *
   * 그래서 클릭은 `F12` 와 **같은 경로**를 탄다 — 알림 줄의 사유, 여럿일 때의
   * 목록, 뒤로 가기 스택이 전부 그쪽에 있다. 계기가 둘이어도 동작이 하나여야
   * 사용자가 두 가지를 배우지 않는다.
   *
   * `Mod` 는 Ctrl 과 Meta 중 **정확히 하나**다 (`helpers.js` 의 규약) — 그래야
   * `Ctrl+Cmd+클릭` 을 따로 쓰는 사람의 조합을 가로채지 않는다.
   */
  _lspBindClick() {
    if (!this._editor) return;
    this._editor.onMouseUp((e) => {
      const ev = e && e.event;
      if (!ev || ev.altKey || ev.shiftKey) return;
      if (ev.ctrlKey === ev.metaKey) return;
      const pos = e.target && e.target.position;
      if (!pos) return;
      // 드래그로 끝난 클릭은 선택이다 — 그 자리를 고른 것이 아니다.
      const sel = this._editor.getSelection();
      if (sel && !sel.isEmpty()) return;
      if (window.app && window.app.lspClickDef) window.app.lspClickDef(this, pos);
    });
  }

  /**
   * FR-LSP-66 (U-1): Monaco 의 **정의 계열 키바인딩을 죽인다.**
   *
   * `registerDefinitionProvider` 를 걸면 Monaco 의 기본 키(`F12`·`Alt+F12`)도 함께
   * 살아난다. 그러면 **설정에서 키를 바꿔도 옛 키가 계속 듣는다** — `FR-LSP-40`
   * (키는 설정의 것)이 깨지는 자리이며, 기존 검사가 그것을 잡았다(실측).
   *
   * 계기를 가른다: **키는 우리 것**(`_edKeyGate` → `_lspJump`, 알림 줄·목록·뒤로
   * 가기가 거기 있다), **마우스 제스처는 Monaco 것**(Cmd/Ctrl+클릭의 링크 밑줄은
   * Monaco 만 그릴 수 있다 — D-8c). 제스처는 키바인딩이 아니므로 이 조치에 걸리지
   * 않는다.
   */
  _lspKillMonacoKeys() {
    if (!this._editor || typeof monaco === 'undefined') return;
    const M = monaco.KeyMod, K = monaco.KeyCode;
    const noop = () => {};
    for (const kb of [
      K.F12,                  // 정의로 이동
      M.Alt | K.F12,          // 정의 peek — 다른 파일에는 모델이 없어 빈 창이 된다
      M.Shift | K.F12,        // 참조 peek (우리 Shift+F12 가 그 자리다)
    ]) this._editor.addCommand(kb, noop);
  }

  /**
   * VIEW_SCROLL_RESTORE_SRS FR-VSR-1·2·5: 지금 보고 있던 자리를 적어 둔다.
   *
   * **떼기 전에** 불려야 한다. 계기는 `_keepScrollAll`(render 의 머리) 하나이며,
   * 그 뒤에 오는 `_hideOthers`·`_domGC`·`_place` 가 요소를 문서에서 떼어 간다
   * (D-2). Monaco 의 스크롤은 DOM `scrollTop` 이 아니라 인스턴스가 든 값이므로
   * `_keepScrollAll` 의 훑기로는 잡히지 않는다.
   *
   * 스크롤만 뽑지 않는다 — 커서·선택·접힘이 같은 이동으로 함께 사라진다.
   */
  keepView() {
    if (!this._editor || !this.el.isConnected || !this.el.classList.contains('vis')) return;
    const st = this._editor.saveViewState();
    if (st) this._viewState = st;
  }

  /**
   * FR-VSR-3·4: 적어 둔 자리를 되돌린다. **붙은 뒤에** 불린다.
   *
   * 적어 둔 것이 없으면 아무것도 하지 않는다 — 처음 열린 편집기의 자연스러운
   * 자리(`revealLine` 의 결과를 포함)를 덮지 않는다.
   */
  restoreView() {
    if (!this._editor || !this._viewState) return;
    this._editor.restoreViewState(this._viewState);
  }

  // FR-RTU-42: 이 편집기가 붙은 탭이 미리보기면 고정한다. 탭을 찾는 일은 App 이
  // 하고(레이아웃은 그쪽의 것이다) 여기서는 계기만 전한다.
  _pinIfPreview() {
    const app = window.app;
    if (!app || !app.pinPreviewTab) return;
    for (const s of app.ws.windows || []) {
      if (!s || !s.layout) continue;
      for (const pn of app.flattenPanes(s.layout)) {
        const tab = (pn.tabs || []).find((t) => t && t.id === this.id);
        if (tab) { app.pinPreviewTab(tab); return }
      }
    }
  }

  /**
   * UX_BATCH9_SRS FR-ESV-1·4: 이 편집기가 수행하는 액션의 판정.
   *
   * 잡았으면 브라우저 기본 동작을 막고 전파를 끊는다. **잡지 못했으면 삼키지
   * 않는다** — 삼키면 그 조합이 죽은 키가 된다 (FR-EKB-4 와 같은 규약).
   */
  _edViewKey(e) {
    for (const [action, fn] of Object.entries(ED_VIEW_ACTIONS)) {
      if (!matchShortcut(e, shortcuts[action])) continue;
      e.preventDefault();
      e.stopImmediatePropagation();
      this[fn]();
      return true;
    }
    return false;
  }

  /**
   * 저장 하나. **성공 여부를 돌려준다** (FR-EXC-12).
   *
   * 종전에는 아무것도 반환하지 않았고 실패를 `catch` 로 삼켰다. 탭 닫기의
   * "저장 후 닫기" 는 그것을 기다린 뒤 **무조건 닫았다** — 바로 위의 git diff
   * 경로가 `if(!await this._gitViewSave(...)) return` 으로 닫지 않는 것과 달랐다
   * (EDITOR_EXTERNAL_CHANGE_SRS §2.5).
   *
   *   이전 동작: 반환 없음. 실패해도 호출자가 알 길이 없다
   *   새  동작: 참/거짓. 경합에서 취소한 것도 거짓이다 (쓰이지 않았으므로)
   *   이유:     경합(FR-EXC-5)을 들이면서 그 가드가 없으면 **이 스펙 자체가**
   *             저장한 줄 알고 닫는 손실 경로를 만든다 (FR-RTU-103)
   */
  async save() {
    if (!this._editor || !this._dirty) return false;
    // FR-SVS-53: 저장은 **문서 하나에 대한 한 번**이다. 두 칸이 같은 파일을 볼 때
    // 양쪽에서 Ctrl+S 가 겹치면 같은 내용을 두 번 쓰게 되고, 그 사이의 편집이
    // 어느 쪽 버퍼에 담겼는지에 따라 결과가 갈린다.
    // WORKBENCH_REVIEW_SRS FR-WBR-90~92: 플래그의 임자는 **문서**이므로 여기서
    // 한 번 잡고 끝까지 그것으로 만진다.
    //
    //   이전 동작: `this._doc` 을 그때그때 거쳤다
    //   새  동작: 저장을 시작할 때 잡은 문서로 내린다
    //   이유:     `destroy()` 는 `this._doc = null` 로 끊는다. 저장이 날아가 있는
    //             동안 그 뷰가 파괴되면 `finally` 의 조건이 거짓이 되어 공유
    //             문서의 `saving` 을 못 내렸고, 다른 칸이 문서를 붙들고 있으면
    //             그 기록이 살아남아 **그 파일의 모든 저장이 조용히 건너뛰어졌다**
    const doc = this._doc;
    if (doc && doc.saving) return false;
    if (doc) doc.saving = true;
    const content = this._editor.getValue();
    /**
     * FR-EXC-14: **담아 간 내용의 판본을 적어 둔다.**
     *
     * 위의 `content` 는 지금 이 순간의 스냅샷이고, 아래의 `await` 는 망 왕복이다.
     * 그 사이의 타이핑은 이 저장에 담기지 않는다 — 그런데 성공 처리는 `dirty` 를
     * 무조건 내렸다.
     *
     *   이전 동작: 왕복 중의 편집이 있어도 `doc.dirty=false`
     *   새  동작: 판본이 달라졌으면 `dirty` 를 **유지한다**
     *   이유:     내린 순간 그 편집은 화면에서 저장된 것처럼 보이고(탭의 ● 가
     *             사라진다), 다음 `Ctrl/Cmd+S` 는 `save()` 의 첫 줄
     *             `if (!this._dirty) return false` 에 걸려 **아무 말 없이**
     *             되돌아간다. 사용자에게는 "한 번씩 저장이 안 되고, 닫았다 열면
     *             된다"(새 문서가 서면서 플래그가 리셋된다)로 보이지만, 실제로
     *             일어난 일은 **그 사이의 편집이 조용히 유실되는 것**이다.
     *             원격 접속처럼 왕복이 긴 자리에서 자주 겹친다
     *
     * `getAlternativeVersionId` 를 쓰는 이유는 되돌리기까지 셈에 넣기 때문이다 —
     * 쳤다가 `Cmd+Z` 로 되돌리면 값이 제자리로 오고, 그때는 담아 간 내용과 같으므로
     * dirty 를 내리는 것이 옳다.
     */
    const model = this._editor.getModel();
    const sentVer = model ? model.getAlternativeVersionId() : 0;
    try {
      let r = await this._write(content, this._stamp);
      // FR-EXC-5·7·9: 409 는 **우리가 읽은 뒤 디스크가 바뀌었다**는 뜻이다.
      // 사용자가 승인하면 표식 없이 한 번 더 보낸다 — 서버는 표식이 없는 요청을
      // 검사하지 않으므로(FR-EXC-6a) 그 한 번이 곧 덮어쓰기다.
      if (r.status === 409) {
        if (!await this._confirmConflict()) return false;
        r = await this._write(content, '');
      }
      if (!r.ok) {
        // 로드맵 `FUI-05` / M3: 저장 실패의 **사유가 화면에 닿는다.** 종전에는
        // 500ms 붉은 테두리 하나뿐이라, 서버가 본문에 실어 보낸 사유(경계 거부·
        // 디스크 오류)가 콘솔에만 남았다.
        this._noteSaveFailed(r);
        return false;
      }
      // FR-EXC-11: 새 표식을 거둔다. 거두지 않으면 다음 저장이 **자기 편이 방금
      // 만든 변경**에 걸려 경합이 된다 — 한 번 저장하면 그 뒤로 아무것도 저장되지
      // 않는다는 뜻이다.
      //
      // **처음 잡아 둔 `doc` 으로 내린다** — `set _stamp` 는 `this._doc` 을 보는데
      // `destroy()` 가 그것을 끊으므로, 저장이 날아가 있는 동안 이 칸이 파괴되면
      // 표식이 **죽은 필드**(`__stamp`)에 쓰인다. 그러면 문서의 표식은 낡은 채
      // 남고, 같은 파일을 보던 다른 칸의 다음 저장이 방금 우리가 만든 변경에
      // 걸려 409 가 된다 (TC-SVS-53 이 그것을 잡았다). `dirty`·`saving` 이 이미
      // 치른 값이다 (FR-WBR-90~92).
      const next = (r.data && r.data.stamp) || '';
      if (doc) doc.stamp = next; else this._stamp = next;
      // FR-WBR-91·92: dirty 와 탭 표시도 문서를 딛는다. `set _dirty` 는 `_doc` 이
      // 끊겨 있으면 **죽은 필드**(`__dirty`)에 쓰므로, 파괴된 뒤에는 쓰기가
      // 성공해도 문서가 dirty 로 남았다 — 남은 칸의 탭에 저장 안 됨 표시가 남고
      // 재조정이 그 창을 붙든다 (FR-WBR-40·41).
      // FR-EXC-14: 왕복 중에 편집이 있었으면 dirty 를 내리지 않는다. 라벨 갱신은
      // 양쪽 모두에서 한다 — ● 가 **남는 것**도 갱신의 결과다.
      const edited = !!(model && model.getAlternativeVersionId() !== sentVer);
      if (doc) { if (!edited) doc.dirty = false; for (const v of doc.views) v._updateTabLabel() }
      else { if (!edited) this._dirty = false; this._tabLabelAll() }
      // 파일 저장은 즉시 신호다 (FR-GIT-18) — 작업 트리가 방금 바뀌었다.
      if (typeof app !== 'undefined' && app) app.gitSignal('write');
      return true;
    } catch (e) {
      console.error('[FileEditor] save error:', e);
      this._noteSaveFailed(null);
      return false;
    } finally {
      if (doc) doc.saving = false;
    }
  }

  /**
   * 저장이 실패했음을 화면에 남긴다 (`FUI-05`).
   *
   * 붉은 테두리는 **무언가 잘못됐다**만 말한다. 사용자가 알아야 하는 것은 **무엇이**
   * 잘못됐는가이고, 서버는 그것을 본문에 실어 보낸다 — 경계 거부인지 디스크
   * 오류인지에 따라 할 일이 다르다.
   *
   * `r` 이 없으면(망 실패·예외) 사유를 모른다. 그때 지어내지 않는다.
   */
  _noteSaveFailed(r) {
    this.el.style.boxShadow = 'inset 0 0 0 2px #f44';
    TIMERS.after(500, () => { this.el.style.boxShadow = ''; }, {owner:this,label:'flash'});
    let why = '';
    if (r) why = (r.text || '').trim().split('\n')[0].slice(0, 200);
    this.note(why ? FILE_SAVE_FAIL + ': ' + why : FILE_SAVE_FAIL);
  }

  // 쓰기 한 번. 표식이 비면 필드를 싣지 않는다 — 서버의 관대함(FR-EXC-6a)을
  // 부르는 것이 곧 "검사하지 말라" 이므로, 그 뜻을 한 자리에 모아 둔다.
  _write(content, stamp) {
    const body = { path: this.filePath, content };
    if (stamp) body.stamp = stamp;
    return apiPost('/api/file/write', body);
  }

  /**
   * FR-EXC-9: 경합의 확인창. 참이면 덮어쓴다.
   *
   * **`디스크 것으로 덮기` 는 두지 않는다** (비목표 3) — 편집본을 확인 없이 버리는
   * 길을 한 걸음 확인창에 둘 수 없다 (FR-COS-1·FR-RTU-103). 취소하면 편집본은
   * 화면에 그대로 남으므로(FR-EXC-3) 사용자가 스스로 처리할 수 있다.
   *
   * 초기 포커스는 `덮어쓰기` 다 — 이 창이 뜬 까닭이 사용자가 누른 저장이므로
   * 그것이 목적 버튼이다 (FR-EXC-9a / FR-PDA-1). `UIKit.modal` 이 `kind` 를 보고
   * 스스로 정하므로 여기서 `focus()` 를 부르지 않는다 (FR-PDA-11).
   */
  _confirmConflict() {
    return new Promise(resolve => {
      let done = false;
      const settle = v => { if (!done) { done = true; resolve(v) } };
      const body = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'fe-conflict-path';
      name.textContent = this.name;
      name.title = this.filePath;
      const msg = document.createElement('div');
      msg.className = 'fe-conflict-msg';
      msg.textContent = FILE_CONFLICT_MSG;
      body.appendChild(name); body.appendChild(msg);
      const m = UIKit.modal({
        cls: 'fe-conflict',
        title: FILE_CONFLICT_TITLE,
        width: 'min(460px,90vw)',
        body,
        // **두 버튼 모두 `keepOpen` 이다.** `UIKit.modal` 의 기본은 `close()` 를
        // 먼저 부르고 그 다음 `onClick` 을 부르는 순서라(ui-kit.js), 답을
        // `onClose` 에서 받으면 **덮어쓰기를 눌러도 취소로 접수된다.** 그래서 답을
        // 먼저 정하고 닫는다.
        actions: [
          { label: FILE_CONFLICT_CANCEL, kind: 'ghost', cls: 'fe-conflict-cancel',
            keepOpen: true, onClick: () => { settle(false); m.close() } },
          { label: FILE_CONFLICT_GO, kind: 'danger', cls: 'fe-conflict-go',
            keepOpen: true, onClick: () => { settle(true); m.close() } },
        ],
        // `Esc` 와 바깥 클릭도 여기로 온다 — 답 없이 닫힌 것은 **쓰지 않은
        // 것**이다 (FR-PDA-3). 버튼으로 이미 답했으면 `settle` 이 무시한다.
        onClose: () => settle(false),
      });
      document.body.appendChild(m.el);
    });
  }

  /**
   * 디스크의 내용을 다시 읽어 화면에 반영한다 (FR-EXC-1).
   *
   * **dirty 면 아무것도 하지 않는다** (FR-EXC-3·4).
   *
   *   이전 동작: `_dirty` 를 보지 않고 읽어 와 달라졌으면 `setValue` 했다.
   *             그래서 편집 중인 파일의 탭을 **다시 열기만 해도** 편집본이
   *             디스크 것으로 덮였다
   *   새  동작: dirty 면 읽지도 않고 돌아간다
   *   이유:     `U-10`(FR-RTU-103) — 편집을 확인 없이 잃는 것이 이 제품에서
   *             가장 비싼 실패다. 덮어쓸지는 저장할 때 묻는다 (FR-EXC-9)
   *
   * 읽기에 실패해도(밖에서 지워졌다) 화면을 비우지 않는다 — 보던 내용이 사라지는
   * 것이 곧 손실이고, 저장하면 새로 만든다 (FR-EXC-10·10b).
   */
  refresh() {
    if (this._loading || this._dirty) return;
    this._fetchFile().then(content => {
      if (!this._editor) return;
      // EDITOR_LSP_SRS §2.11b / FR-LSP-26b: **내용이 같으면 넣지 않는다.**
      //
      // `setValue` 는 커서를 1,1 로 되돌리고 undo 스택을 버린다. 그런데 이 갱신은
      // 비동기이고, `edOpenFile` 은 탭을 활성화한 **직후에** 그 줄로 커서를
      // 옮긴다 (FR-EGS-10) — 그래서 늦게 도착한 이 `setValue` 가 방금 옮긴 커서를
      // 앗아갔다. 이미 열어 둔 파일을 검색 결과나 정의 이동으로 고르면 그 줄로
      // 가지 않는 결함이 그것이었다 (V-EGS-10 이 그것을 잡고 있었다).
      //
      // 같은 내용을 다시 넣는 일은 화면에 아무것도 바꾸지 않으면서 커서와 undo
      // 스택만 버린다. 디스크와 같아졌다는 사실(dirty 해제)만 반영한다.
      if (this._editor.getValue() === content) return;
      // 모델이 공유되므로 이 한 번이 모든 칸의 내용을 되돌린다.
      this._editor.setValue(content);
      this._dirty = false;
      this._tabLabelAll();
    }).catch(e => console.error('[FileEditor] refresh error:', e));
  }

  _updateTabLabel() {
    // Update the tab data model so dirty state survives re-renders
    const s = app.aw();
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
    TIMERS.cancel(this._noteT);
    // 스스로 사라진다 — 닫는 조작을 배워야 하는 알림은 알림이 아니라 창이다.
    this._noteT = TIMERS.after(ms || FE_NOTE_MS, () => {
      if (this._note) this._note.classList.remove('vis');
    }, {owner:this,label:'note-hide'});
  }

  /**
   * EDITOR_LSP_SRS FR-LSP-44·45: 언어 서버가 없을 때의 제안.
   *
   * 알림 줄(`note`)과 **다른 것이다** — 이것은 스스로 사라지지 않고 버튼을 갖는다.
   * 사용자가 무언가를 해야 하는 알림과 그냥 알리는 알림은 같은 모양일 수 없다.
   */
  offer(st) {
    if (!st || this._offerEl) return;
    const el = document.createElement('div');
    el.className = 'fe-offer';
    el.dataset.id = st.id;
    // 받을 수 없을 때의 사유는 **서버가 사람의 말로 적어 보낸다** (FR-EXT-29) —
    // 화면이 다시 쓰면 서버가 아는 사유와 사용자가 읽는 문장이 갈린다.
    const body = st.canInstall
      ? LSP_OFFER_BODY.replace('%s', st.id)
      : (st.note || LSP_OFFER_BLOCKED).replace('%s', st.id);
    // 마크업에 잇는 것은 **이름 붙인 값**이다 — 속성 접근이 마크업 안에 그대로
    // 들어가면 `check-html.sh` 가 그것을 값으로 보고 막는다 (FE-16·17 의 규칙).
    const actBtn = st.canInstall
      ? '<button type="button" class="fe-offer-go">' + LSP_OFFER_INSTALL + '</button>'
      : '<button type="button" class="fe-offer-set">' + LSP_OFFER_SETTINGS + '</button>';
    el.innerHTML =
      '<span class="fe-offer-msg"></span>' +
      actBtn +
      '<button type="button" class="fe-offer-no">' + LSP_OFFER_DISMISS + '</button>' +
      '<button type="button" class="ui-btn ui-btn-icon ui-btn-ghost fe-offer-x" title="' + ED_FIND_CLOSE_TITLE + '" aria-label="' + ED_FIND_CLOSE_TITLE + '">' + UIKit.iconHTML('x') + '</button>';
    // 사유는 텍스트 노드로 넣는다 — 서버가 보낸 이름이 그 자리에 닿는다.
    el.querySelector('.fe-offer-msg').textContent = body;
    this.el.appendChild(el);
    this._offerEl = el;
    // 종전에는 여기서 `fe-offered` 표식을 남겨 렌더 진입 손잡이를 아래로 내려
    // 앉혔다. **U-2 로 그 손잡이가 좌하단으로 내려가면서 자리를 다투지 않게 됐다** —
    // 표식이 가리키던 규칙이 사라졌으므로 표식도 함께 걷는다.
    //
    // 찾기 줄·알림 줄은 여전히 내려 앉는다. 그 둘은 형제 선택자(`.fe-offer ~ …`)로
    // 닿으므로 표식이 필요 없다.
    /**
     * EDITOR_LSP_SRS FR-LSP-44a (2026-09-08 접수): **띠의 높이는 고정이 아니다.**
     *
     *   이전 동작: 아래로 내려 앉는 값이 `38px` 로 박혀 있었다 — 띠가 한 줄이라는
     *              가정이다
     *   새  동작: 실제 높이를 재어 `--fe-offer-h` 로 넘긴다
     *   이유:     390px 폭에서 안내가 두세 줄로 접히면 띠가 38px 을 넘고, 그러면
     *              `◈ 미리보기` 손잡이를 **그대로 덮는다** — 눌러도 띠가 먹는다
     *              (CI ubuntu 실측: 그 러너에는 markdown 서버가 없어 띠가 늘 선다)
     *
     * 폭이 바뀌면 줄 수도 바뀌므로 한 번 재는 것으로는 모자라다. 관측을 띠와 같은
     * 수명으로 두고 `offerClose` 에서 함께 놓는다.
     */
    this._offerMeasure();
    if (typeof ResizeObserver === 'function') {
      this._offerRo = new ResizeObserver(() => this._offerMeasure());
      this._offerRo.observe(el);
    }

    const go = el.querySelector('.fe-offer-go');
    if (go) {
      go.addEventListener('click', () => {
        go.disabled = true;
        go.textContent = LSP_INSTALLING;
        // 조달의 단위는 **팩**이다 (FR-EXT-5·31) — 서버 id 로 부르면 다섯을 내는
        // 팩에서 아무것도 받지 못한다.
        if (window.app) window.app.lspOfferInstall(st.pack || st.id, this);
      });
    }
    const set = el.querySelector('.fe-offer-set');
    if (set) {
      set.addEventListener('click', () => {
        // 받을 수 없을 때의 다음 걸음은 설정창이다 — 거기에 무엇이 없는지와
        // 어디서 찾았는지가 다 있다.
        const b = document.getElementById('settings-btn');
        if (b) b.click();
        const tab = document.querySelector('button.mtab[data-tab="code"]');
        if (tab) tab.click();
        this.offerClose();
      });
    }
    // FR-LSP-45: `다시 보지 않기` 는 그 **언어**에 대한 것이다. 파일마다 뜨면
    // 그것이 곧 고장이므로 이 기억이 필요하다.
    el.querySelector('.fe-offer-no').addEventListener('click', () => {
      if (window.app) window.app.lspDismiss(st.id);
      this.offerClose();
    });
    // ✕ 는 이번만 닫는다 — 기억하지 않는다.
    el.querySelector('.fe-offer-x').addEventListener('click', () => this.offerClose());
  }

  // FR-LSP-44a: 띠가 지금 먹고 있는 높이. 이 값 하나로 손잡이·찾기 줄·알림 줄이
  // 다 같이 내려 앉는다 (`style-editor.css`·`style-docrender.css`).
  _offerMeasure() {
    if (!this._offerEl) return;
    this.el.style.setProperty('--fe-offer-h', this._offerEl.offsetHeight + 'px');
  }

  offerClose() {
    if (!this._offerEl) return;
    if (this._offerRo) { this._offerRo.disconnect(); this._offerRo = null }
    this._offerEl.remove();
    this._offerEl = null;
    this.el.style.removeProperty('--fe-offer-h');
  }

  destroy() {
    // FR-LSP-44a: 띠의 관측은 띠와 같은 수명이다. 닫히지 않은 채 뷰가 파괴되면
    // `offerClose` 를 지나지 않으므로 여기서도 놓는다.
    if (this._offerRo) { this._offerRo.disconnect(); this._offerRo = null }
    // 하이라이트는 에디터와 함께 사라지지만, 컬렉션을 명시적으로 걷는다 —
    // dispose 순서에 기대지 않는다.
    if (this._findDecos) { this._findDecos.clear(); this._findDecos = null }
    // EDITOR_LSP_SRS FR-LSP-35: 진단은 **모델의 것**이고 모델은 탭보다 오래 살
      // 수 있다 (`edDocDrop` 이 수명을 정한다). 걷지 않으면 다시 열었을 때 낡은
    // 밑줄이 먼저 보인다.
    if (this._editor && window.app && window.app.lspClearDiagnostics) {
      window.app.lspClearDiagnostics(this._editor.getModel());
    }
    if (this._editor) {
      // 모델은 **에디터의 것이 아니다** — `{model}` 로 준 것은 dispose 되지 않는다.
      // 문서의 수명은 `edDocDrop` 이 정한다 (FR-SVS-55).
      this._editor.dispose();
      this._editor = null;
    }
    // FR-EDD-16: 팝업과 등록을 먼저 걷는다 — 문서를 놓기 전이어야 관리자가
    // 살아 있는 동안 정리된다.
    if (this._ddDrop) this._ddDrop();
    if (typeof app !== 'undefined' && app && app.edDocDrop) {
      app.edDocDrop(this.filePath, this);
    }
    this._doc = null;
  }
}
