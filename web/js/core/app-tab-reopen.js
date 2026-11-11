/**
 * Dongminal — 닫은 탭 다시 열기 (UX_BATCH12_SRS §3.5g FR-RTR-1~7).
 *
 * Repo 창의 탭(편집기·Diff·git 뷰)을 닫으면 그 자리·레코드·커서·스크롤을 목록에 적는다.
 * 목록은 브라우저 메모리에만 있다 (FR-RTR-2). 뒤로·앞으로가 닫힌 자리를 만나면 이 목록으로
 * 다시 연다 (FR-RTR-7, `app-focus.js` 의 `_navGo`).
 */
Object.assign(App.prototype, {
  // FR-RTR-1·2: 닫히는 탭을 적는다. `closeTab` 이 확인을 지난 뒤, 인스턴스를 놓기 전에 부른다.
  _tabReopenNote(s, pn, tab) {
    if (!this.isEditorWin(s) || (tab.type !== TAB_TYPE_EDITOR && tab.type !== TAB_TYPE_GIT)) return;
    const rec = { ...tab };
    delete rec.id;
    delete rec.preview;
    const list = this._tabClosed || (this._tabClosed = []);
    list.push({ win: s.id, pane: pn.id, idx: pn.tabs.indexOf(tab), tabId: tab.id, rec, view: this._tabViewState(tab) });
    while (list.length > TAB_REOPEN_MAX) list.shift();
  },

  _tabViewState(tab) {
    if (tab.type === TAB_TYPE_EDITOR) {
      const ed = this.editorAny(tab.id);
      return ed && ed.viewState ? ed.viewState() : null;
    }
    const p = tab.gitView === 'diff' && this._gitDiffPanelAny(tab.id);
    return p ? p.diffTabViewState() : null;
  },

  _tabViewApply(tab, vs) {
    if (tab.type === TAB_TYPE_EDITOR) {
      const ed = this.editorAny(tab.id);
      if (ed && ed.viewApply) ed.viewApply(vs);
      return;
    }
    const p = tab.gitView === 'diff' && this._gitDiffPanelAny(tab.id);
    if (p) p.diffTabViewApply(vs);
  },

  _gitDiffPanelAny(tabId) {
    const own = this._gitDiffPanelOf(tabId, this.slotFocused());
    if (own || !this.gitPanels) return own;
    for (const p of this.gitPanels.values()) if (p.diffTabId === tabId) return p;
    return null;
  },

  // FR-RTR-3·4: 맨 위부터 다시 연다. 열 수 없는 항목(창이 사라짐)은 버리고 다음으로 간다.
  tabReopen() {
    const list = this._tabClosed || [];
    while (list.length) if (this._tabReopenEntry(list.pop())) return true;
    return false;
  },

  _tabReopenIndex(p) {
    if (!p || !p.tab) return -1;
    const list = this._tabClosed || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].tabId !== p.tab || list[i].win !== p.win) continue;
      return this._tabReopenWin(list[i]) ? i : -1;
    }
    return -1;
  },

  // FR-RTR-7·14: 기록의 자리 p 를 닫은 탭 목록으로 다시 열 수 있는가.
  tabReopenCan(p) { return this._tabReopenIndex(p) >= 0 },

  // FR-RTR-7: 기록의 자리 p 의 탭을 다시 열고 연 자리를 준다. 목록에서는 뺀다.
  tabReopenAt(p) {
    const i = this._tabReopenIndex(p);
    return i < 0 ? null : this._tabReopenEntry(this._tabClosed.splice(i, 1)[0]);
  },

  _tabReopenWin(e) {
    const w = this.ws.windows.find(x => x && x.id === e.win);
    return w && this.isEditorWin(w) ? w : null;
  },

  /**
   * FR-RTR-4~6: 항목 하나를 다시 연다. 연 자리 {win,pane,tab} 를 주고, 열 수 없으면 null 이다.
   *
   * 칸이 사라졌으면(마지막 탭을 닫으면 칸도 지워진다) 그 창의 지금 칸에 연다. 위치는 어느
   * 쪽이든 닫을 때의 index 다 — 칸 하나에서 탭을 모두 닫고 차례로 다시 열면 원래 순서가 된다.
   * 다시 연 탭은 새 id 를 받으므로 기록의 옛 id 를 새 id 로 바꾼다.
   */
  _tabReopenEntry(e) {
    const w = this._tabReopenWin(e);
    if (!w) return null;
    const rid = (w.layout && findPane(w.layout, e.pane)) ? e.pane : this.edEnsurePane(w);
    const pn = rid && findPane(w.layout, rid);
    if (!pn) return null;
    let found = this._tabReopenExisting(w, pn, e.rec);
    const fresh = !found;
    if (fresh) {
      const tab = { ...e.rec, id: newEntityId() };
      pn.tabs.splice(Math.min(Math.max(0, e.idx), pn.tabs.length), 0, tab);
      found = { win: w, pane: pn, tab };
    }
    this._navRetab(e.tabId, found.tab.id);
    this._revealTab(found);
    this.render();
    if (fresh && e.view) this._tabViewApply(found.tab, e.view);
    if (found.tab.type === TAB_TYPE_GIT) this._gitRescheduleAll();
    this.save();
    return { win: w.id, pane: found.pane.id, tab: found.tab.id };
  },

  // FR-RTR-5: 같은 대상의 탭이 그 칸에 있으면 그 탭이다. git 뷰는 창에 하나다 (FR-RTB-11).
  _tabReopenExisting(w, pn, rec) {
    const inPane = (pred) => {
      const tab = (pn.tabs || []).find(pred);
      return tab ? { win: w, pane: pn, tab } : null;
    };
    if (rec.type === TAB_TYPE_EDITOR) {
      return inPane(x => x.type === TAB_TYPE_EDITOR && !!x.render === !!rec.render && x.filePath === rec.filePath);
    }
    if (rec.gitView === 'diff') {
      const key = this.diffTabKey(rec.diffTarget);
      return key ? inPane(x => x.type === TAB_TYPE_GIT && x.gitView === 'diff' && this.diffTabKey(x.diffTarget) === key) : null;
    }
    return this.findGitViewTab(w, rec.gitView);
  },
});
