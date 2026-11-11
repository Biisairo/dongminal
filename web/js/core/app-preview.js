/**
 * Dongminal — Repo 창의 **미리보기 탭** (UX_BATCH12_SRS §3.5f FR-RTB, REPO_TAB_UNIFY_SRS FR-RTU-40~45).
 *
 * 미리보기는 칸마다 하나이고, 지금 칸의 것만 갈아 끼운다. 탭을 만드는 자리
 * (`_addEditorTab`)는 `app-layout.js` 에 있고, 여기는 찾기·대체·고정이다.
 */
Object.assign(App.prototype, {
  /**
   * UX_BATCH12_SRS FR-RTB-1 (FR-RTU-43 개정): **칸의** 미리보기 탭. 칸마다 하나다.
   */
  _findPreviewTab(s, pn){
    const tab=pn&&(pn.tabs||[]).find(x=>x.preview);
    return tab?{win:s,pane:pn,tab}:null;
  },

  /**
   * FR-RTB-14: 갈아 끼울 수 있는 미리보기 탭. 저장하지 않은 수정이 있으면 **고정하고**
   * null 이다 — 대체가 수정을 버리지 않는다. 수정 시작이 보통 이미 고정했지만, 같은
   * 파일의 다른 탭에서 친 수정은 이 탭의 고정 계기가 아니므로 여기서 막는다.
   */
  _previewToReplace(s, pn){
    const prev=this._findPreviewTab(s, pn);
    if(!prev||!this.tabDirty(s,prev.tab)) return prev;
    delete prev.tab.preview;
    return null;
  },

  /**
   * FR-RTB-6 (FR-RTU-42 개정): 미리보기를 고정한다. 계기는 다섯이다 — 탭 더블클릭 ·
   * Explorer 행 더블클릭 · Changes 행 더블클릭 · 수정 시작 · 저장. 어느 쪽이든 뜻은
   * 같다: "이 탭은 남는다."
   */
  pinPreviewTab(tab){
    if(!tab||!tab.preview) return false;
    delete tab.preview;
    // FR-EXR-59: 고정은 "이 파일에서 일하겠다" 다 — 탐색기가 쥔 포커스를 넘긴다
    // (FR-EXR-58 의 예외). 표명은 아래 render 가 소비한다.
    this.focusHandoff=true;
    this.render();
    this.save();
    return true;
  },

  // FR-RTB-4: 그 칸 안에서만 찾는다 — 같은 파일이 칸마다 따로 열릴 수 있다.
  _findEditorTabIn(s, pn, filePath) {
    const tab = pn && (pn.tabs || []).find(x => x.type === TAB_TYPE_EDITOR && !x.render && x.filePath === filePath);
    return tab ? { win: s, pane: pn, tab } : null;
  },

  // FR-RTU-40·FR-RTB-2: 미리보기 요청이면 **그 칸의** 미리보기 탭을 대체한다. 새 탭을
  // 만들지 않으므로 목록을 훑어도 탭이 쌓이지 않는다. 대체할 탭이 없으면 null.
  _retargetPreview(s, pn, opts) {
    const prev = this._previewToReplace(s, pn);
    if (!prev) return null;
    // FR-RTB-1: 그 칸의 미리보기가 Diff 면 편집기 탭으로 바꿔 쓴다.
    if (prev.tab.type === TAB_TYPE_GIT) this._diffTabToEditor(prev.tab);
    prev.tab.filePath = opts.filePath;
    prev.tab.name = clampEntityName(opts.name || pathBase(opts.filePath) || '');
    // 편집기 인스턴스는 탭 id 로 산다 — 대상이 바뀌었으므로 버린다.
    for (const [k, v] of [...this.fileEditors]) {
      if (this.slotBase(k) !== prev.tab.id) continue;
      try { v.destroy() } catch { /* 이미 파괴된 것은 오류가 아니다 */ }
      this.fileEditors.delete(k);
    }
    this.paneTabSet(prev.pane, prev.tab.id);
    this.setFocusState(prev.pane.id, s);
    this.render();
    this.save();
    return { uuid: prev.tab.id };
  },
});
