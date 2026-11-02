/**
 * Remote Terminal — file editor tab (CodeMirror 6)
 *
 * CODEMIRROR_MIGRATION_SRS 단계 A: 편집기 칸은 CodeMirror 다(M3). 편집기 묶음은 바이너리 안에서 온다
 * (`web/vendor/codemirror`, 묶음 V) — 외부 호스트에서 받지 않는다.
 */

// CODEMIRROR_MIGRATION_SRS 묶음 V. 출력은 `scripts/build-codemirror.mjs` 가 만든다.
const CM_ENTRY = '/vendor/codemirror/cm.js';

let cmLoading = null;
// 브라우저는 실패한 모듈 URL 을 기억하고 다시 받지 않는다 — 다시 시도할 때마다
// 쿼리를 바꿔 새 URL 로 받는다.
let cmAttempt = 0;

/**
 * FR-CMR-6: 진입 모듈을 전역 `CM` 하나로 세운다. 대기 중인 호출자는 같은 Promise 를
 * 공유하고, 실패는 기억하지 않는다 — 네트워크가 돌아오면 다시 시도할 수 있어야 한다.
 */
function loadCodeMirror() {
  if (window.CM) return Promise.resolve();
  if (cmLoading) return cmLoading;
  const url = cmAttempt ? `${CM_ENTRY}?r=${cmAttempt}` : CM_ENTRY;
  cmAttempt++;
  cmLoading = import(url).then((m) => { window.CM = m });
  cmLoading.catch(() => { cmLoading = null });
  return cmLoading;
}

class FileEditor {
  constructor(id, name, filePath) {
    this.id = id;
    this.name = name;
    this.filePath = filePath;
    this.el = document.createElement('div');
    this.el.className = 'file-editor';
    this.el.tabIndex = 0;
    // CodeMirror 의 `EditorView` 와 그것이 붙은 문서 버퍼(`EdBuffer`). `_cmp` 는 설정으로
    // 갈아 끼우는 Compartment 들이다 (`cm-setup.js`).
    this._view = null;
    this._buf = null;
    this._cmp = null;
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
    // EDITOR_GIT_UX_SRS FR-EGS-10: 검색 결과로 열린 경우 갈 자리. 편집기가
    // 뜨기 전에 요청이 올 수 있으므로 여기 담아 두었다 생성 직후에 쓴다.
    this._pendingReveal = null;
    // CODEMIRROR_MIGRATION_SRS §11.6 L1: 편집기가 서면(또는 서지 못하면) 풀린다 — `whenView`.
    this._viewReady = new Promise((r) => { this._viewReadyResolve = r });

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
      // 없던 동안 이진 파일은 대체 문자로 뒤덮인 채 편집기에 올라갔고, 그것을
      // 저장하면 원본이 파괴됐다 — 알림이 없는 것보다 나쁘다.
      const probe = await this._probeFile();
      this.kind = probe.kind;
      if (probe.kind === FILE_KIND_BINARY) { this._showUnsupported(probe); this._loading = false; return }
      // FR-FAB-9: 상한을 넘으면 편집기를 세우지 않는다. 세우지 않으므로 저장
      // 경로 자체가 생기지 않는다 — 잘린 내용을 되쓸 길이 없다.
      if (this._overSizeLimit(probe)) { this._showTooLarge(probe); this._loading = false; return }
      if (probe.kind === FILE_KIND_IMAGE) { this._showImage(probe); this._loading = false; return }
      await loadCodeMirror();
      // FR-SVS-50: 다른 칸이 이미 이 파일을 열어 두었으면 그 문서를 그대로 쓴다.
      // REPO_FIX 03 §3A-5: 버퍼는 **문서가** 만든다(`edDocLoad` — 판별·변환 읽기).
      // 기다리는 사이 이 뷰가 파괴됐으면 편집기를 세우지 않는다 — 문서 뷰가 0 이면
      // `edDocDrop` 이 이미 해제했다 (#9).
      const buf = await app.edDocLoad(this.filePath);
      if (this._destroyed) return;
      if (!buf) throw new Error('document not loaded');
      this._createEditor(buf);
      this._loading = false;
    } catch (e) {
      console.error('[FileEditor] init error:', e);
      this.el.innerHTML =
        '<div class="fe-error">Failed to load editor' +
        '<div class="fe-error-path">' + escHtml(this.filePath) + '</div></div>';
      this._loading = false;
    } finally {
      // 이진·대용량·이미지·파괴로 일찍 끝나도 기다리는 쪽이 풀린다.
      this._viewReadyResolve(this._view);
    }
  }

  /** 편집기 뷰가 서면 그 뷰, 서지 못하면 null (LSP `Workspace.displayFile` 이 기다린다). */
  whenView() {
    return this._view ? Promise.resolve(this._view) : this._viewReady;
  }

  // CODEMIRROR_MIGRATION_SRS §11.6 L1: 이 파일의 LSP 확장을 넣는다 (경로가 바뀌면 다시).
  _lspAttach() {
    const view = this._view, path = this.filePath;
    edCmLspAttach(view, this._cmp, path, () => this._view === view && this.filePath === path);
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
          escHtml(t('editor.size_with_limit',{size:this._fmtFileSize(probe.size),max:this._fmtFileSize(probe.maxBytes)})) +
        '</div>' +
        '<div class="fe-unsup-hint">' + FILE_TOO_LARGE_HINT + '</div>' +
        '<a class="fe-unsup-dl" download href="' + escHtml(href) + '">' + FILE_TOO_LARGE_DOWNLOAD + '</a>' +
      '</div>';
  }

  // FR-EVW-3: 열지 않고 사유를 보인다. 편집기를 세우지 않으므로 저장 경로
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
      '<div class="fe-image ui-scroll">' +
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

  _createEditor(buf) {
    this.el.innerHTML = '';
    this._mountView(buf);
    this._lspAttach();
    this._notifyIntegrations();
    this._wireKeys();
    this._wireFocus();
    // FR-EKB-5: 단축키는 편집기 `keymap` 에 굳히지 않는다. 굳히면 설정에서 바꾼 키가
    // 편집기 안에서만 듣지 않는다 — `_wireKeys` 의 keydown 이 그 자리를 맡는다. 전역
    // keydown 은 편집기에 포커스가 있는 동안 한 줄도 돌지 않으므로(input-binding.js 의
    // activeElement 게이트) 이 배선이 필요하다. 저장도 여기 합류했다 (UX_BATCH9_SRS FR-ESV-2).

    // EDITOR_DIRTY_DIFF_SRS FR-EDD-15: 변경 표시는 **문서**의 것이다 — 이 칸은
    // 클릭과 팝업만 갖는다. `file-editor-diff.js` 가 없으면 편집기는 지금까지와
    // 똑같이 동작한다 (NFR-EDD-3).
    if (this._ddInit) this._ddInit();

    if (this._pendingReveal) {
      const r = this._pendingReveal; this._pendingReveal = null;
      this.revealLine(r.line, r.col);
    }
  }

  /**
   * FR-SVS-51·52 · CODEMIRROR_MIGRATION_SRS FR-CMR-20·21: 칸마다 `EditorView` 하나가 문서
   * 버퍼에 붙는다. 내용은 버퍼가 칸 사이에 전달하고, 커서·선택·스크롤·접힘·실행 취소는
   * 칸마다 남는다.
   *
   * 본문을 그리는 규약(줄바꿈·글자 크기·글꼴·탭·괄호·가이드·커서)은 `edCmExtensions` 한
   * 덩이다 (UX_BATCH10_SRS FR-UXB-41 의 한 덩이 규약을 잇는다).
   */
  _mountView(buf) {
    const { extensions, cmp } = edCmExtensions({
      // REPO_FIX 03 §3A-1: 어느 인코딩으로도 풀리지 않은 문서는 읽기 전용이다 —
      // 치환 문자로 된 내용을 되쓰면 원본이 파괴된다.
      readOnly: !!(this._doc && this._doc.decodable === false),
      wordWrap: editorWordWrap,
      fontSize: edFontSize(),
      minimap: editorMinimap,
    });
    this._cmp = cmp;
    this._buf = buf;
    const view = new CM.EditorView({
      state: CM.EditorState.create({
        doc: buf.doc,
        extensions: [...extensions, CM.EditorView.updateListener.of((u) => this._onUpdate(u))],
      }),
      parent: this.el,
      dispatchTransactions: (trs, v) => { v.update(trs); buf.fromSink(v, trs) },
    });
    this._view = view;
    buf.attach(view);
    this._langLoad();
  }

  // FR-CMR-13: 언어는 쓸 때 받는다. 받는 동안은 일반 텍스트로 보이고, 받으면 강조가 붙는다.
  _langLoad() {
    const view = this._view, cmp = this._cmp;
    if (!view) return;
    edCmLangLoad(this.filePath).then((lang) => {
      if (this._view !== view) return;
      view.dispatch({ effects: cmp.lang.reconfigure(lang || []) });
    }, (e) => console.error('[FileEditor] language load failed:', e));
  }

  _notifyIntegrations() {
    if (this._doc && this._doc.decodable === false) this.note(FILE_UNDECODABLE_NOTE);
    // FR-LSP-44: 이 파일의 언어 서버가 없으면 제안한다. 판정은 app 이 하며
    // 상태를 파일마다 다시 묻지 않는다.
    if (window.app && window.app.lspOfferFor) window.app.lspOfferFor(this);
    // DOC_RENDER_VIEW_SRS FR-DRV-2·3: 렌더할 수 있는 문서면 버튼을 세우고, 이
    // 파일의 렌더 뷰에 버퍼가 생겼음을 알린다. 판정과 버튼은 app 이 갖는다 —
    // 편집기는 자기가 무슨 문서인지 알 필요가 없다.
    if (window.app && window.app.docRenderMount) window.app.docRenderMount(this);
  }

  /**
   * 내용이 바뀌었다 — 이 칸의 편집이든 다른 칸에서 전달된 것이든 디스크 판이든.
   * 버퍼가 칸마다 전달하므로 이 갱신은 같은 파일을 보는 칸 **모두**에서 돈다. dirty 설정은
   * 멱등이고 라벨은 칸마다 있으므로 전부 갱신한다 (FR-SVS-54).
   */
  _onUpdate(u) {
    if (!u.docChanged) return;
    const flush = u.transactions.some((tr) => tr.annotation(EdBuffer.FLUSH));
    // REPO_FIX 03 §3A-7: dirty 는 내용 비교다 — undo 로 되돌리면 풀린다.
    const was = this._dirty;
    // 문서는 버퍼를 스스로 구독한다(`_edDocWatch`) — 여기서도 부르는 것은 이 뷰가
    // 아래 판정(was→now)을 같은 틱에 보기 위해서다. 멱등이다.
    if (this._doc) app.edDocDirtySync(this._doc);
    else this.__dirty = true;
    if (!was && this._dirty) {
      this._tabLabelAll();
      // REPO_TAB_UNIFY_SRS FR-RTU-42: **편집을 시작하면 고정된다.** 고치던 파일이
      // 다음 클릭에 사라지면 그것은 미리보기가 아니라 사고다. 디스크 판으로 갈아
      // 끼운 것(FLUSH)은 편집이 아니다 — 그것까지 세면 파일을 열자마자 고정된다.
      if (!flush) this._pinIfPreview();
    }
    // FR-EFP-17: 편집하는 동안 낡은 하이라이트가 남으면 그것이 거짓말이 된다.
    if (this._findVis()) this._findRun(true);
    // FR-EDD-53: 변경 표시도 같은 계기다. 디바운스는 관리자가 갖는다 — 계산은 한
    // 번이어야 한다.
    if (this._dd) this._dd.schedule();
  }

  _wireKeys() {
    /**
     * EDITOR_FIND_PANEL_SRS FR-EFP-1·2·3: 검색 키 판정은 **capture** 단계다.
     *
     * 종전에는 bubble 이었다. 키의 실제 대상은 Monaco 안쪽 요소이고 Monaco 의 키
     * 처리도 그 안에 붙어 있으므로, **Monaco 가 먼저 봤다** — 자기 find 위젯을 열고
     * find 입력칸에 포커스를 줬다. 그 뒤 우리 `_edFindInFile` 이 `ed.focus()` 로
     * 포커스를 본문으로 되돌렸고, 그래서 위젯은 떠 있는데 글자를 못 받았다.
     * **타이핑한 글자가 전부 문서에 삽입됐다** (그 SRS §2.2~2.4).
     *
     * capture 로 먼저 보면 매칭된 키는 편집기에 닿지 않는다. 매칭되지 않으면
     * `edTrySearchKey` 는 아무것도 하지 않으므로(FR-EFP-3) 편집기가 그대로 받는다 —
     * 여기서 전파를 멈추면 편집기가 글자를 하나도 받지 못한다.
     *
     * FR-EKB-1·5 는 그대로다: 판정은 app 이 한 벌로 갖는다. 여기서 조합을 다시
     * 적으면 설정에서 바꾼 키가 안쪽에만 반영되지 않는다.
     */
    // FR-EDD-34 (`_onKeyCapture` 의 뒷부분): 팝업을 닫는 길 둘 중 하나. 찾기 패널이 포커스를 갖고 있으면
    // 그 패널의 핸들러가 먼저 먹고 전파를 멈추므로(`_findWire`) 이 자리는 돌지
    // 않는다 — 두 Escape 가 다투지 않는다.
    // REPO_FIX 03 E-9.2: capture 는 조상이 먼저 받으므로 찾기 입력의 Esc 도 여기 먼저
    // 온다 — 찾기 패널 안에서 누른 Esc 는 찾기 패널의 것이다(팝업은 두고 그 패널만
    // 닫는다). 이전: 팝업과 찾기 패널이 함께 닫혔다.
    this.el.addEventListener('keydown', (e) => this._onKeyCapture(e), true);

    // Keyboard interop: prevent terminal shortcuts from firing in editor
    this.el.addEventListener('keydown', (e) => {
      // 검색 키는 위의 capture 리스너가 이미 판정했다 — 여기서 다시 묻지 않는다.
      // 편집기 안의 키는 편집기가 다 받는다.
      e.stopPropagation();
    });
  }

  /**
   * capture keydown 한 벌 (FEU-27). 종전에는 같은 요소에 capture 리스너가 둘이었다 — 검색·뷰
   * 키가 먼저, dirty-diff 팝업의 Esc 가 다음. 앞의 둘은 키를 잡으면 `stopImmediatePropagation`
   * 하므로 잡힌 키는 뒤로 가지 않았다. 그 순서를 그대로 적는다.
   */
  _onKeyCapture(e) {
    if (window.app && window.app.edTrySearchKey(e)) return;
    // UX_BATCH9_SRS FR-ESV-1·2: **이 편집기의** 액션. 여섯과 같은 자리에서
    // 판정하되 수행은 인스턴스가 한다 — 포커스가 있는 편집기가 곧 이 요소의
    // 임자이므로, "어느 편집기를 저장할 것인가" 를 따로 고르지 않는다.
    if (this._edViewKey(e)) return;
    if (e.key !== 'Escape' || !this._ddNode) return;
    if (this._find && this._find.contains(/** @type {Node} */ (e.target))) return;
    e.preventDefault(); this._ddClose();
  }

  _wireFocus() {
    // Focus handling — notify app when editor receives focus
    this.el.addEventListener('focusin', (e) => {
      // FR-EFP-5: 찾기 패널은 **자기 포커스를 갖는다.** 여기서 되돌리면 질의 칸이
      // 글자를 하나도 받지 못한다 — `ed.focus()` 가 위젯의 포커스를 훔쳤던 것과
      // 같은 종류의 결함이며(그 SRS §2.3), 자리만 다르다.
      if (e.target && e.target.closest && e.target.closest('.fe-find')) return;
      if (this._view) this._view.focus();
    });
  }

  /**
   * FR-EGS-10: 검색 결과가 가리키는 줄로 옮긴다. 편집기가 아직 뜨지 않았으면
   * 담아 두었다 생성 직후에 쓴다 — 탭 생성과 편집기 로드는 비동기이고, 부르는
   * 쪽이 그 순서를 알 이유가 없다.
   */
  revealLine(line, col) {
    const ln = Math.max(1, parseInt(line, 10) || 1);
    const cl = Math.max(1, parseInt(col, 10) || 1);
    if (!this._view) { this._pendingReveal = { line: ln, col: cl }; return }
    const pos = edCmPos(this._view.state.doc, ln, cl);
    this._view.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) });
    this._view.focus();
  }

  /**
   * WORKBENCH_REVIEW_SRS FR-WBR-11: 설정이 바뀌면 **이미 열려 있는** 편집기도
   * 곧바로 따라간다.
   *
   * Compartment 만 갈아끼운다 — 문서도 뷰 상태도 그대로이므로 편집 중인 내용과
   * 커서를 잃지 않는다 (NFR-WBR-1). 아직 편집기가 뜨지 않았으면 할 일이 없다:
   * 생성 인자가 같은 값을 읽는다.
   */
  applyWordWrap() {
    if (!this._view) return;
    this._view.dispatch({ effects: this._cmp.wrap.reconfigure(editorWordWrap ? CM.EditorView.lineWrapping : []) });
  }

  /**
   * EDITOR_MINIMAP_TOGGLE_SRS FR-MMT-4: 미니맵도 **이미 열려 있는** 편집기가
   * 곧바로 따라간다 — `applyWordWrap` 과 같은 규약이다 (FR-WBR-11).
   */
  applyMinimap() {
    if (!this._view) return;
    this._view.dispatch({ effects: this._cmp.minimap.reconfigure(edCmMinimap(editorMinimap)) });
  }

  /**
   * FR-FSS-9: 배율을 바꾸면 **이미 열려 있는** 편집기도 따라온다.
   *
   * Compartment 이므로 문서·커서·편집 중인 내용을 잃지 않는다 — 재생성이면
   * 저장하지 않은 편집이 사라진다 (FR-MMT-4·FR-WBR-11 과 같은 근거).
   */
  applyFontSize() {
    if (!this._view) return;
    this._view.dispatch({ effects: this._cmp.font.reconfigure(edCmFontTheme(edFontSize())) });
  }

  // REPO_FIX 03 §3A-2: 다시 연 인코딩으로 풀리지 않으면 읽기 전용이다 (`edDocReopen`).
  onDocReadOnly(ro) {
    if (!this._view) return;
    this._view.dispatch({ effects: this._cmp.ro.reconfigure(CM.EditorState.readOnly.of(!!ro)) });
  }

  // REPO_FIX 03 §3A-5: 문서가 새 경로로 옮겨졌다 — 버퍼는 그대로이고 언어만 다시 정한다.
  onDocMoved() { this._langLoad(); this._lspAttach() }

  /**
   * VIEW_SCROLL_RESTORE_SRS FR-VSR-1·2·5: 지금 보고 있던 자리를 적어 둔다.
   *
   * **떼기 전에** 불려야 한다. 계기는 `_keepScrollAll`(render 의 머리) 하나이며,
   * 그 뒤에 오는 `_hideOthers`·`_domGC`·`_place` 가 요소를 문서에서 떼어 간다
   * (D-2). 편집기의 스크롤은 편집기가 든 높이 계산 위에 서므로 `_keepScrollAll` 의
   * 훑기로는 되돌릴 수 없다 — 편집기에게 스냅숏을 받는다.
   *
   * 커서·선택·접힘은 `EditorState` 에 남아 떼였다 붙어도 잃지 않는다. 잃는 것은 스크롤이다.
   */
  keepView() {
    if (!this._view || !this.el.isConnected || !this.el.classList.contains('vis')) return;
    this._viewState = this._view.scrollSnapshot();
  }

  /**
   * FR-VSR-3·4: 적어 둔 자리를 되돌린다. **붙은 뒤에** 불린다.
   *
   * 적어 둔 것이 없으면 아무것도 하지 않는다 — 처음 열린 편집기의 자연스러운
   * 자리(`revealLine` 의 결과를 포함)를 덮지 않는다.
   */
  restoreView() {
    if (!this._view || !this._viewState) return;
    this._view.dispatch({ effects: this._viewState });
  }

  // FR-RTU-42: 이 편집기가 붙은 탭이 미리보기면 고정한다. 탭을 찾는 일은 App 이
  // 하고(레이아웃은 그쪽의 것이다) 여기서는 계기만 전한다.
  _pinIfPreview() {
    const app = window.app;
    if (!app || !app.pinPreviewTab) return;
    for (const s of app.ws.windows || []) {
      if (!s || !s.layout) continue;
      for (const pn of app.flattenPanes(s.layout)) {
        const tab = (pn.tabs || []).find((x) => x && x.id === this.id);
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
  /**
   * REPO_FIX 03 §3A-8 (E-9.3): 저장 진행 중의 저장 요청은 **무음으로 버리지 않는다** —
   * 진행 중 저장이 끝나기를 기다린 뒤 그때 dirty 면 한 번 더 저장한다. 여러 번 눌러도
   * 대기는 1건이다. 대기는 문서 단위다(같은 파일을 보는 칸들이 공유한다).
   *
   *   이전 동작: `saving` 중이면 false — "저장 후 닫기" 가 닫지 못하고 조용히 끝났다
   *   새  동작: 기다렸다가 필요하면 다시 저장, 결과를 돌려준다
   */
  save() {
    // REPO_FIX 05 §3A-3: 문서가 있으면 저장은 문서의 것이다 — git Diff 뷰와 같은 길이다.
    if (this._doc) return app.edDocSave(this.filePath, this);
    return this._saveOnce();
  }

  // 문서를 못 얻은 뷰(이진·이미지·로딩 실패)의 저장이다. 문서가 있으면 `edDocSave`.
  async _saveOnce() {
    if (!this._view || !this._dirty) return false;
    const sentDoc = this._view.state.doc;
    const content = this._buf ? this._buf.text(sentDoc) : sentDoc.toString();
    try {
      let r = await this._write(content, this._stamp, null);
      if (r.status === 409) {
        if (!await this._confirmConflict()) return false;
        r = await this._write(content, '', null);
      }
      if (!r.ok) {
        this._noteSaveFailed(r);
        return false;
      }
      this._stamp = (r.data && r.data.stamp) || '';
      if (this._view && this._view.state.doc.eq(sentDoc)) this.__dirty = false;
      this._tabLabelAll();
      if (typeof app !== 'undefined' && app) app.gitSignal('write');
      return true;
    } catch (e) {
      console.error('[FileEditor] save error:', e);
      this._noteSaveFailed(null);
      return false;
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
    // 색은 JS 가 들지 않는다 — 클래스만 토글하고 값은 CSS 가 갖는다 (FR-WRD-14).
    this.el.classList.add('fe-save-failed');
    TIMERS.after(500, () => { this.el.classList.remove('fe-save-failed'); }, {owner:this,label:'flash'});
    let why = '';
    if (r) why = (r.text || '').trim().split('\n')[0].slice(0, 200);
    this.note(why ? FILE_SAVE_FAIL + ': ' + why : FILE_SAVE_FAIL);
  }

  /**
   * REPO_FIX 03 §3A-2: 문서 인코딩으로 쓸 수 없는 글자가 있어 서버가 거절했다 — 파일은
   * 그대로다. 그 자리로 커서를 옮기고, 사유와 "UTF-8 로 변환해 저장" 을 함께 보인다.
   */
  _noteUnmappable(u, doc) {
    const line = Number(u.line) || 1, col = Number(u.col) || 1;
    if (this._view) {
      const pos = edCmPos(this._view.state.doc, line, col);
      this._view.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) });
    }
    const enc = doc && doc.encoding ? (ENC_LABEL[doc.encoding] || doc.encoding) : '';
    this.note(t('editor.enc_unmappable', { line, col, char: u.char || '', enc }), FE_NOTE_ACTION_MS,
      { label: ENC_CONVERT, run: () => app.edDocConvertUtf8(this.filePath) });
  }

  _write(content, stamp, doc) { return app.edDocWrite(this.filePath, content, stamp, doc) }

  // FR-EXC-9: 경합의 확인창 — 문서 저장과 같은 것을 쓴다 (`app.edConfirmConflict`).
  _confirmConflict() { return app.edConfirmConflict(this.name, this.filePath) }

  /**
   * 디스크의 내용을 다시 읽어 화면에 반영한다 (FR-EXC-1). REPO_FIX 03 E-7.1: 일은
   * **문서**가 한다(`edDocRefresh`) — dirty 면 읽지 않고, 응답이 올 때 그 사이 편집이
   * 있었으면 적용하지 않으며, 모든 뷰에 알린다.
   */
  refresh() {
    if (this._loading || !this._doc) return;
    app.edDocRefresh(this.filePath);
  }

  _updateTabLabel() {
    // REPO_FIX 03 §3A-7: 탭 레코드에 dirty 를 쓰지 않는다 — 라벨은 렌더가 문서에서
    // 파생한다(`app.tabDirty`). 여기서는 그려져 있는 라벨만 곧바로 고친다.
    // 같은 탭의 DOM 이 칸마다 있다 — 하나만 고치면 나머지 칸의 `● ` 가 낡는다.
    for (const tabEl of document.querySelectorAll(
      '.pn-tab[data-tab-id="' + this.id + '"] .pn-tab-label')) {
      tabEl.textContent = (this._dirty ? '● ' : '') + this.name;
    }
  }
  focus() {
    if (this._view) {
      this._view.focus();
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
  // `action` 이 있으면 버튼 하나를 함께 둔다(`{label, run}`) — 그 알림은 눌러야 하므로
  // 더 오래 남는다.
  note(text, ms, action) {
    if (!text) return;
    if (!this._note) {
      const el = document.createElement('div');
      el.className = 'fe-note';
      this.el.appendChild(el);
      this._note = el;
    }
    this._note.textContent = text;
    this._note.classList.toggle('fe-note-act', !!action);
    if (action) {
      this._note.appendChild(UIKit.button({ label: action.label, size: 'sm', cls: 'fe-note-btn',
        onClick: () => { this._note.classList.remove('vis'); action.run() } }));
    }
    // FR-TOK-22: 같은 층에서 겹치는 순서는 DOM 이 정한다 — 보일 때 맨 뒤로
    // 옮긴다 (`file-editor-find.js` 의 `findOpen` 이 같은 규약이다).
    this.el.appendChild(this._note);
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
    el.className = 'ui-notice fe-offer';
    el.dataset.id = st.id;
    // 받을 수 없을 때의 사유는 **서버가 사람의 말로 적어 보낸다** (FR-EXT-29) —
    // 화면이 다시 쓰면 서버가 아는 사유와 사용자가 읽는 문장이 갈린다.
    const body = st.canInstall
      ? josa(LSP_OFFER_BODY.replace('%s', st.id))
      : josa((st.note || LSP_OFFER_BLOCKED).replace('%s', st.id));
    // 마크업에 잇는 것은 **이름 붙인 값**이다 — 속성 접근이 마크업 안에 그대로
    // 들어가면 `check-html.sh` 가 그것을 값으로 보고 막는다 (FE-16·17 의 규칙).
    const actBtn = st.canInstall
      ? '<button type="button" class="ui-btn ui-btn-sm ui-btn-primary fe-offer-go">' + LSP_OFFER_INSTALL + '</button>'
      : '<button type="button" class="ui-btn ui-btn-sm fe-offer-set">' + LSP_OFFER_SETTINGS + '</button>';
    el.innerHTML =
      '<span class="fe-offer-msg"></span>' +
      actBtn +
      '<button type="button" class="ui-btn ui-btn-sm fe-offer-no">' + LSP_OFFER_DISMISS + '</button>' +
      '<button type="button" class="ui-btn ui-btn-icon ui-btn-ghost ui-btn-sm fe-offer-x" title="' + ED_FIND_CLOSE_TITLE + '" aria-label="' + ED_FIND_CLOSE_TITLE + '">' + UIKit.iconHTML('x') + '</button>';
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
    this._destroyed = true;
    if (this._view) {
      // 버퍼는 **편집기의 것이 아니다** — 떼기만 한다. 문서의 수명은 `edDocDrop` 이
      // 정한다 (FR-SVS-55).
      if (this._buf) this._buf.detach(this._view);
      this._view.destroy();
      this._view = null;
    }
    this._viewReadyResolve(null);
    this._buf = null;
    // FR-EDD-16: 팝업과 등록을 먼저 걷는다 — 문서를 놓기 전이어야 관리자가
    // 살아 있는 동안 정리된다.
    if (this._ddDrop) this._ddDrop();
    if (typeof app !== 'undefined' && app && app.edDocDrop) {
      app.edDocDrop(this.filePath, this);
    }
    this._doc = null;
  }
}
