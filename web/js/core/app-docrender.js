/**
 * 문서 렌더 뷰의 배선 (DOC_RENDER_VIEW_SRS 묶음 A·B).
 *
 * 뷰 자체는 `ui/doc-render.js` 에 있고 여기 있는 것은 **어디에 서는가**다 —
 * 버튼이 어느 편집기에 붙는지, 렌더 탭이 어느 칸에 열리는지.
 *
 * 분할과 이동을 **새로 쓰지 않는다** (FR-DRV-8). `_moveTabToPane`·
 * `_splitPaneWithTab` 이 이미 그 규칙을 갖고 있으며, 두 벌이 되면 한쪽만 고쳐진다.
 */
Object.assign(App.prototype, {

  // FR-DRV-1: 확장자가 정한다. 표는 `constants-docrender.js` 한 자리다.
  _docRenderKind(path) {
    const m = String(path || '').toLowerCase().match(/(\.[^./\\]+)$/);
    return (m && DOC_RENDER_EXTS[m[1]]) || '';
  },

  /**
   * `FileEditor` 가 편집기를 세운 직후에 불린다. 하는 일은 둘이다.
   *
   * ① 이 파일의 렌더 뷰들에게 **모델이 생겼음을 알린다.** 렌더 탭을 먼저 열고 소스
   *    탭을 나중에 열 수 있으므로, 이 통지가 없으면 그 렌더 뷰는 디스크의 내용에
   *    머문다.
   * ② 렌더할 수 있는 문서면 **버튼을 세운다** (FR-DRV-2·3). 그렇지 않으면 자리를
   *    만들지 않는다 — 눌리지만 아무 일도 하지 않는 버튼은 고장으로 읽힌다.
   */
  _docRenderMount(view) {
    if (!view || !view.el || !view.filePath) return;
    const model = view._editor && view._editor.getModel();
    if (model) this._docRenderNotifyModel(view.filePath, model);
    this._docRenderBindScroll(view);
    if (!this._docRenderKind(view.filePath)) return;
    if (view.el.querySelector('.fe-render')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fe-render';
    b.textContent = DOC_RENDER_BTN;
    b.title = DOC_RENDER_BTN_TITLE;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this._docRenderOpen(view.filePath, view.name);
    });
    view.el.appendChild(b);
  },

  /**
   * FR-DRV-44: 소스를 스크롤하면 렌더가 따라간다.
   *
   * 구독을 **편집기마다 한 번만** 건다. Monaco 의 스크롤 이벤트는 자주 오므로
   * 프레임마다 한 번으로 묶는다 — 묶지 않으면 스크롤 한 번에 DOM 질의가 수십 번
   * 돌고, 그 비용이 스크롤의 지연으로 느껴진다.
   *
   * **소스 → 렌더 한 방향뿐이다.** 양쪽이 서로를 밀면 두 뷰가 마주 보고 튄다.
   */
  _docRenderBindScroll(view) {
    if (!view._editor || view._docRenderScroll) return;
    if (!this._docRenderKind(view.filePath)) return;
    // 구독을 따로 걷지 않는 것은 편집기가 `dispose()` 될 때 그 emitter 가 함께
    // 끊기기 때문이다. 프레임 예약이 남아 뒤늦게 돌 수는 있는데, 그때는
    // `_docRenderSync` 의 첫 줄이 편집기가 없음을 보고 물러선다.
    view._docRenderScroll = view._editor.onDidScrollChange(() => {
      // 프레임당 한 번으로 접는다. 종전에는 `_docRenderRaf` 를 손으로 붙들고
      // `if(...) return` 으로 걸렀다 — 그 관용구가 `coalesce` 다 (FR-SCH-15).
      TIMERS.frame(() => this._docRenderSync(view), {owner:view, coalesce:'doc-scroll'});
    });
  },

  _docRenderSync(view) {
    const ed = view._editor;
    if (!ed || !ed.getVisibleRanges) return;
    const vis = ed.getVisibleRanges()[0];
    const line = vis ? vis.startLineNumber : 1;
    /**
     * VIEW_SCROLL_RESTORE_SRS R-VSR-6: 추종은 **소스가 움직였을 때만** 돈다.
     *
     *   이전 동작: 스크롤 이벤트마다 같은 줄이라도 렌더 뷰를 밀었다
     *   새  동작: 마지막으로 민 줄과 같으면 물러선다
     *   이유:     탭·창이 다시 붙은 뒤의 레이아웃도 스크롤 이벤트를 낸다. 그
     *             이벤트로 같은 줄을 다시 밀면 **렌더 뷰가 스스로 되돌린 자리를
     *             잃는다** (실측: 600 으로 되돌린 9ms 뒤 0 이 됐다). 같은 줄을
     *             다시 미는 것은 새로 알리는 바가 없으므로 잃을 것도 없다
     */
    if (view._docRenderLine === line) return;
    view._docRenderLine = line;
    for (const v of this.fileEditors.values()) {
      if (v && v.render && v.filePath === view.filePath && v.syncToLine) v.syncToLine(line);
    }
  },

  /**
   * 이 경로를 품은 Editor 루트. 루트가 겹쳐 있을 때 **가장 긴 것**이 답이다 —
   * 짧은 쪽을 고르면 `/` 로 시작하는 참조가 엉뚱한 저장소를 가리킨다.
   *
   * `app-lsp.js` 의 `_lspRootOfPath` 와 같은 계산이다. 지금 한 벌로 접지 않는 것은
   * 그 파일이 다른 작업의 손에 있기 때문이며, 자리가 안정되면 `app-editor.js` 로
   * 함께 옮기는 것이 옳다.
   */
  _docRenderRootOf(path) {
    let best = '';
    for (const w of this._edWindows()) {
      const r = w.editor && w.editor.root;
      if (!r) continue;
      // 구분자를 `/` 로 굳히지 않는다 — Windows 에서는 어떤 루트도 걸리지 않아
      // 이 함수가 빈 값을 내고, 그러면 루트 기준 참조(`/img/a.png`)가 풀리지
      // 않으며 루트 밖 판정도 서지 않는다.
      if (pathUnder(r, path) && r.length > best.length) best = r;
    }
    return best;
  },

  _docRenderNotifyModel(path, model) {
    if (!this.fileEditors) return;
    for (const v of this.fileEditors.values()) {
      if (v && v.render && v.filePath === path && v.onDocModel) v.onDocModel(model);
    }
  },

  /**
   * FR-DRV-5·7·8: 렌더 탭을 **옆 칸**에 연다.
   *
   * 이미 있으면 새로 만들지 않고 그 탭으로 옮긴다. 없으면 지금 칸에 만든 뒤 옆
   * 칸으로 보낸다 — 형제 칸이 있으면 그리로, 없으면 나눠서. 탭을 **먼저 만들고
   * 옮기는** 순서인 것은 두 이동 함수가 "이미 있는 탭" 을 대상으로 삼기 때문이다.
   */
  _docRenderOpen(filePath, name) {
    const s = this._aw();
    if (!s || !s.layout || !filePath) return;
    const ex = this._findRenderTab(filePath);
    if (ex) {
      this.paneTabSet(ex.pane, ex.tab.id);
      this._setFocus(ex.pane.id, s);
      // FR-RTU-83: 모바일 순회가 그 칸을 가리켜야 렌더 탭이 화면에 온다.
      this._mobileShowPane(ex.pane.id);
      this.render();
      this._save();
      return;
    }
    const src = findPane(s.layout, this.focused) || this._flattenPanes(s.layout)[0];
    if (!src) return;
    const id = newEntityId();
    // FR-DRV-9 / D-1: **새 탭 타입을 만들지 않는다.** `render` 하나가 갈림길이며,
    // 그래서 저장·복원·회수·창 가드가 이미 이 탭을 안다.
    src.tabs.push({
      id, type: 'editor', render: true, filePath,
      name: name || pathBase(filePath) || '',
    });
    const sib = this._paneSiblingOf(src.id);
    // 두 함수가 각자 `_save`·`render` 를 한다 — 여기서 다시 부르지 않는다.
    if (sib) this._moveTabToPane(src.id, id, sib.id, null, false);
    else this._splitPaneWithTab(src.id, id, src.id, 'right');
    // FR-RTU-83: **옆 칸은 모바일 화면에 없다.** 나눈 뒤의 칸 id 는 여기서 만든
    // 것이 아니므로 탭을 다시 찾아 그 자리를 가리킨다 — 순회에서 `옆 칸` 은 다음
    // 자리이고, 그리로 가지 않으면 미리보기는 열리고도 보이지 않는다.
    const put = this._findRenderTab(filePath);
    if (put) this._mobileShowPane(put.pane.id, {render:true});
  },

  /**
   * FR-DRV-6: 렌더 탭에서 소스로 돌아간다. **렌더 탭을 닫지 않는다** — 사용자가
   * 고른 것은 "소스를 보겠다" 이지 "렌더를 버리겠다" 가 아니다.
   */
  _docRenderToSource(view) {
    if (!view || !view.filePath) return;
    // `_findEditorTab` 은 소스 탭만 찾는다 (FR-DRV-10).
    const ex = this._findEditorTab(view.filePath);
    if (ex) {
      this.ws.activeWindow = ex.win.id;
      try { sessionStorage.setItem('activeWindow', ex.win.id) } catch { /* 사생활 모드 */ }
      this.paneTabSet(ex.pane, ex.tab.id);
      this._setFocus(ex.pane.id, ex.win);
      this.render();
      this._save();
      return;
    }
    this._edOpenFile(view.filePath, {});
  },

  // 렌더 탭 찾기. `_findEditorTab` 과 **갈라져 있는 것이 요점이다** (FR-DRV-10) —
  // 한 함수가 둘 다 찾으면 탐색기에서 연 파일이 렌더로 열린다.
  _findRenderTab(filePath) {
    for (const s of this.ws.windows) {
      if (!s || !s.layout) continue;
      for (const pn of this._flattenPanes(s.layout)) {
        const tab = (pn.tabs || []).find(t => t && t.render && t.filePath === filePath);
        if (tab) return { win: s, pane: pn, tab };
      }
    }
    return null;
  },

  /**
   * 이 칸의 옆 칸. 같은 분할 안의 **다음** 형제이고, 없으면 이전 형제다.
   *
   * 형제가 다시 분할이면 그 안의 첫 칸을 고른다 — 사용자가 "옆" 이라고 부르는 것은
   * 화면에서 바로 옆에 보이는 칸이고, `_flattenPanes` 의 순서가 그 순서다.
   */
  _paneSiblingOf(rid) {
    const s = this._aw();
    if (!s || !s.layout) return null;
    const path = findPath(s.layout, rid);
    if (!path || path.length < 2) return null;
    const parent = path[path.length - 2];
    const self = path[path.length - 1];
    const kids = parent.children || [];
    const i = kids.indexOf(self);
    if (i < 0) return null;
    const next = kids[i + 1] || kids[i - 1];
    if (!next) return null;
    return this._flattenPanes(next)[0] || null;
  },
});
