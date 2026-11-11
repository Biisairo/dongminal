/**
 * Dongminal — Repo 창의 **Diff 탭** (UX_BATCH12_SRS §3.5f FR-RTB-7~9·13).
 *
 * Diff 탭은 창에 여럿이고 탭마다 대상(저장소 루트, 경로, 축)을 든다. 대상은 탭
 * 레코드(`tab.diffTarget`)에 실어 워크스페이스에 남긴다.
 *
 * 탭마다 **전용 GitPanel** 을 둔다. 관측은 저장소의 관측기 하나를 함께 쓰므로
 * 요청은 늘지 않고, hunk·blame·편집·저장은 패널의 것을 그대로 쓴다. 칸 둘이
 * 동시에 서로 다른 Diff 를 보일 수 있는 것도 이 때문이다.
 */
Object.assign(App.prototype, {
  // 탭 레코드에 싣는 대상. 커밋 축이면 `commit` 이 참이다. 저장소는 창의 루트이므로 싣지 않는다.
  _diffTabTarget(f, commit) {
    const out = { group: f.group || '', axis: f.axis || '', path: f.path || '', origPath: f.origPath || '' };
    for (const k of ['untracked', 'dir']) if (f[k]) out[k] = true;
    for (const k of ['sub', 'oid', 'parentOid', 'revLabel']) if (f[k]) out[k] = f[k];
    if (commit) out.commit = true;
    return out;
  },

  // FR-RTB-7: "같은 대상" 은 (경로, 축)이 같은 것이다. 커밋 축은 리비전까지 같아야 한다.
  diffTabKey(dt) {
    return dt ? [dt.axis, dt.path, dt.origPath || '', dt.oid || '', dt.parentOid || ''].join(RPT_SEP) : '';
  },

  _diffTabIn(pn, key) {
    return (pn.tabs || []).find(x => x.type === TAB_TYPE_GIT && x.gitView === 'diff'
      && this.diffTabKey(x.diffTarget) === key) || null;
  },

  /**
   * FR-RTB-2·4·7: 그 대상의 Diff 를 **칸 하나**에 연다. 칸은 `opts.paneId` 이고 없으면
   * 그 창의 지금 칸이다. 같은 대상의 탭이 그 칸에 있으면 그 탭으로 가고, 미리보기
   * 요청이면 그 칸의 미리보기 탭(종류 무관, FR-RTB-1)을 갈아 끼우며, 없으면 새 탭이다.
   */
  gitDiffOpen(root, f, opts = {}) {
    const w = root && this.edWindowFor(root);
    if (!w || !f) return null;
    const rid = (opts.paneId && w.layout && findPane(w.layout, opts.paneId)) ? opts.paneId : this.edEnsurePane(w);
    const pn = rid && findPane(w.layout, rid);
    if (!pn) return null;
    const target = this._diffTabTarget(f, opts.commit);
    let tab = this._diffTabIn(pn, this.diffTabKey(target));
    if (!tab && opts.preview) {
      const prev = this._previewToReplace(w, pn);
      if (prev) { tab = prev.tab; this._diffTabRetarget(tab, target) }
    }
    // 대상 없는 Diff 탭(진입점 아이콘으로 연 것 · R19 이전 워크스페이스)은 이 대상을 받는다.
    if (!tab) {
      tab = (pn.tabs || []).find(x => x.type === TAB_TYPE_GIT && x.gitView === 'diff' && !x.diffTarget) || null;
      if (tab) {
        this._diffTabRetarget(tab, target);
        if (opts.preview && !this._findPreviewTab(w, pn)) tab.preview = true;
      }
    }
    if (!tab) {
      tab = { id: newEntityId(), name: '', type: TAB_TYPE_GIT, gitView: 'diff' };
      this._diffTabRetarget(tab, target);
      if (opts.preview) tab.preview = true;
      pn.tabs.push(tab);
    }
    this.paneTabSet(pn, tab.id);
    this.setFocusState(pn.id, w);
    this.render();
    // FR-GIT-276: Blame 진입점은 그 탭의 패널을 blame 모드로 연다 — 모드는 패널의 상태다.
    const bp = opts.blame && this._gitDiffPanelOf(tab.id, this.slotFocused());
    if (bp) { bp._blameOn = true; bp._paint() }
    // FR-RTU-62: git 뷰 탭이 서는 것은 그 창에 git 표면이 서는 일이다.
    this._gitRescheduleAll();
    this.save();
    // FR-RTU-83: 모바일이 사이드에 서 있으면 본문의 칸을 가리켜야 탭이 보인다.
    this.mobileShowPane(rid, { render: true });
    return { uuid: tab.id };
  },

  // FR-RTB-9: Diff 탭의 ‹ › — 그 탭이 있는 칸에 미리보기로 연다. 그 탭이 미리보기면
  // 그 칸의 미리보기가 곧 그 탭이므로 대상만 바뀌고, 고정이면 미리보기가 따로 선다.
  gitDiffStep(panel, f) {
    const found = panel && findTabWhere(this.ws.windows, x => x.id === panel.diffTabId);
    if (!found) return null;
    return this.gitDiffOpen(panel.root, f, { preview: true, paneId: found.pane.id });
  },

  // FR-RTB-6 ③: 지금 칸의 그 대상 Diff 탭을 고정한다. 여는 일은 앞선 클릭이 했다.
  gitDiffPin(root, f, commit) {
    const w = root && f && this.edWindowFor(root);
    const rid = w && w.layout && this.edEnsurePane(w);
    const pn = rid && findPane(w.layout, rid);
    const tab = pn && this._diffTabIn(pn, this.diffTabKey(this._diffTabTarget(f, commit)));
    if (tab) this.pinPreviewTab(tab);
  },

  // Diff 탭 패널이 자기 탭을 고정한다 (FR-RTB-6 ④⑤).
  gitDiffTabPin(tabId) {
    const found = tabId && findTabWhere(this.ws.windows, x => x.id === tabId);
    if (found) this.pinPreviewTab(found.tab);
  },

  // 탭을 그 대상의 Diff 탭으로 만든다. 편집기 미리보기였으면 그 인스턴스를 놓는다 (FR-RTB-1).
  _diffTabRetarget(tab, target) {
    if (tab.type === TAB_TYPE_EDITOR) {
      this.editorsDrop(tab.id);
      delete tab.filePath;
      delete tab.render;
    }
    tab.type = TAB_TYPE_GIT;
    tab.gitView = 'diff';
    tab.diffTarget = target;
    // FR-RTB-8: 이름은 대상 파일명이다.
    tab.name = clampEntityName(pathBase(target.path) || target.path);
  },

  // 편집기 미리보기로 바뀌는 Diff 탭 — 그 탭의 패널을 거둔다 (FR-RTB-1).
  _diffTabToEditor(tab) {
    this._gitDiffPanelsDrop(tab.id);
    delete tab.gitView;
    delete tab.diffTarget;
    tab.type = TAB_TYPE_EDITOR;
  },

  /**
   * 그 Diff 탭의 패널. 키는 (루트, 탭, 칸)이다 — 같은 탭을 두 슬롯이 보이면 편집기
   * 탭처럼 슬롯마다 인스턴스가 선다 (FR-WSL-20).
   */
  gitDiffPanelFor(root, slot, tab) {
    if (!this.gitPanels) this.gitPanels = new Map();
    const key = this.slotKey('git:' + (root || '') + GIT_DIFF_TAB_SEP + tab.id, slot || 0);
    let p = this.gitPanels.get(key);
    if (!p) {
      p = new GitPanel(this, root || '');
      p.diffTabId = tab.id;
      this.gitPanels.set(key, p);
      p._reschedule();
    }
    p.diffTabApply(tab.diffTarget || null);
    return p;
  },

  _gitDiffPanelOf(tabId, slot) {
    if (!this.gitPanels) return null;
    for (const [key, p] of this.gitPanels) if (p.diffTabId === tabId && this._slotOf(key) === (slot || 0)) return p;
    return null;
  },

  // 포커스 칸에서 보고 있는 Diff 탭의 패널. Diff 탭이 아니면 null 이다.
  gitDiffPanelActive() {
    const s = this.aw();
    if (!s || !s.layout || !this.isEditorWin(s)) return null;
    const pn = findPane(s.layout, this.focused);
    const tab = pn && (pn.tabs || []).find(x => x.id === this.paneTab(pn));
    if (!tab || tab.type !== TAB_TYPE_GIT || tab.gitView !== 'diff') return null;
    return this._gitDiffPanelOf(tab.id, this.slotFocused());
  },

  _gitDiffPanelsDrop(tabId) {
    if (!this.gitPanels) return;
    for (const [key, p] of this.gitPanels) {
      if (p.diffTabId !== tabId) continue;
      p.destroy();
      this.gitPanels.delete(key);
    }
  },

  // 레이아웃에 남아 있는 Diff 탭의 id (`_gitPanelReap`).
  _gitDiffTabIds() {
    const out = new Set();
    for (const s of this.ws.windows) {
      if (!s || !s.layout) continue;
      for (const pn of this.flattenPanes(s.layout))
        for (const x of pn.tabs || []) if (x.type === TAB_TYPE_GIT && x.gitView === 'diff') out.add(x.id);
    }
    return out;
  },
});
