/**
 * FileEditorKeys — 편집기 칸의 키·포커스 배선 (EDITOR_FIND_PANEL_SRS FR-EFP-1~5 · UX_BATCH9_SRS FR-ESV · FR-EDD-34).
 *
 * `FileEditor` 의 부품이다 (REFACTOR3_FE_REST5_SRS FR-FR5-21). 편집기가 선 뒤 칸이 `wireKeys`·`wireFocus` 를 한 번 부른다.
 * 판정의 몸(`_edViewKey`·찾기 패널·변경 표시 팝업)은 칸과 그 부품의 것이다 — 여기는 수신기를 걸고 순서를 지킨다.
 */
class FileEditorKeys {
  constructor(ed) {
    this.ed = ed;
  }

  wireKeys() {
    /**
     * EDITOR_FIND_PANEL_SRS FR-EFP-1·2·3: 검색 키 판정은 **capture** 단계다.
     *
     * 종전에는 bubble 이었다. 키의 실제 대상은 옛 엔진의 안쪽 요소이고 그 키
     * 처리도 그 안에 붙어 있으므로, **엔진이 먼저 봤다** — 자기 find 위젯을 열고
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
    this.ed.el.addEventListener('keydown', (e) => this.onKeyCapture(e), true);

    // Keyboard interop: prevent terminal shortcuts from firing in editor
    this.ed.el.addEventListener('keydown', (e) => {
      // 검색 키는 위의 capture 리스너가 이미 판정했다 — 여기서 다시 묻지 않는다.
      // 편집기 안의 키는 편집기가 다 받는다.
      // ISSUE_TREE_OPS_SRS FR-ITE-1: CodeMirror 가 쓰지 않은 수식키 조합만 브라우저 기본을 막는다.
      if (window.app) window.app.inputBinding.blockBrowserDefault(e);
      e.stopPropagation();
    });
  }

  /**
   * capture keydown 한 벌 (FEU-27). 종전에는 같은 요소에 capture 리스너가 둘이었다 — 검색·뷰
   * 키가 먼저, dirty-diff 팝업의 Esc 가 다음. 앞의 둘은 키를 잡으면 `stopImmediatePropagation`
   * 하므로 잡힌 키는 뒤로 가지 않았다. 그 순서를 그대로 적는다.
   */
  onKeyCapture(e) {
    if (window.app && window.app.editor.search.edTrySearchKey(e)) return;
    // UX_BATCH9_SRS FR-ESV-1·2: **이 편집기의** 액션. 여섯과 같은 자리에서
    // 판정하되 수행은 인스턴스가 한다 — 포커스가 있는 편집기가 곧 이 요소의
    // 임자이므로, "어느 편집기를 저장할 것인가" 를 따로 고르지 않는다.
    if (this.ed._edViewKey(e)) return;
    if (e.key !== 'Escape' || !this.ed.peek.node) return;
    if (this.ed._find && this.ed._find.contains(/** @type {Node} */ (e.target))) return;
    if (this.ed._goto && this.ed._goto.contains(/** @type {Node} */ (e.target))) return;   // UX_BATCH13_SRS FR-EGL-8
    e.preventDefault(); this.ed.peek.close();
  }

  wireFocus() {
    /**
     * UX_BATCH12_SRS FR-RTR-8: 참조 목록에서 고르기는 큰 점프다. 고르는 처리는 라이브러리의
     * 패널(`@codemirror/lsp-client`)이 하고 부를 자리가 없으므로, 그 패널보다 **먼저**(capture)
     * 고르기 전의 자리를 뒤로·앞으로 기록에 넣는다.
     */
    const pick = (e) => {
      if (!e.target.closest || !e.target.closest('.cm-lsp-reference-panel')) return;
      if (e.type === 'keydown' && e.key !== 'Enter') return;
      if (e.type === 'click' && !e.target.closest('.cm-lsp-reference')) return;
      const app = window.app;
      if (app && app.focus?.navJump) app.focus.navJump();
    };
    this.ed.el.addEventListener('click', pick, true);
    this.ed.el.addEventListener('keydown', pick, true);
    // Focus handling — notify app when editor receives focus
    this.ed.el.addEventListener('focusin', (e) => {
      // FR-EFP-5: 찾기 패널은 **자기 포커스를 갖는다.** 여기서 되돌리면 질의 칸이
      // 글자를 하나도 받지 못한다 — `ed.focus()` 가 위젯의 포커스를 훔쳤던 것과
      // 같은 종류의 결함이며(그 SRS §2.3), 자리만 다르다.
      if (e.target && e.target.closest && e.target.closest('.fe-find, .fe-goto')) return;   // UX_BATCH13_SRS FR-EGL-4
      if (this.ed._view) this.ed._view.focus();
    });
  }
}
