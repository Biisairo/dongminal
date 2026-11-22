/**
 * Remote Terminal — 탭 더하기 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * 탭 타입마다 여는 길과 창 타입의 불변식. `LayoutController` 의 부품 `.tabAdd` 다
 * (REFACTOR3_FE_APPCTL_SRS 9i-1, 옛 `app-layout.js` 의 가운데).
 */
/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-2 (FEC-22): 탭 타입 → 여는 길. `addTab` 은 창 해석과
 * 창 타입 불변식만 하고 나머지는 여기 이름 붙은 메서드가 한다.
 */
const TAB_OPENERS=Object.freeze({
  [TAB_TYPE_RUN]:(app,s,pn,rid,o)=>app.layout.tabAdd._addRunTab(s,pn,o),
  [TAB_TYPE_CHAT]:(app,s,pn,rid,o)=>app.chat._addChatTab(s,pn,o),
  [TAB_TYPE_GIT]:(app,s,pn,rid,o)=>app.layout.tabAdd._addGitTab(s,pn,o),
  [TAB_TYPE_EDITOR]:(app,s,pn,rid,o)=>app.layout.tabAdd._addEditorTab(s,pn,o),
  [TAB_TYPE_TERMINAL]:(app,s,pn,rid,o)=>app.layout.tabAdd._addTerminalTab(s,pn,rid,o),
});

class LayoutTabAdd extends Controller {
  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-31: **그 창 안에서** 같은 뷰의 탭을 찾는다.
   *
   * `_findEditorTab` 이 워크스페이스 전체를 훑는 것과 다르다 — 편집기 탭은 파일
   * 하나가 앱에 한 번 열리면 되지만, git 뷰는 **저장소마다** 자기 것이 있어야
   * 한다. 전체를 훑으면 다른 저장소의 History 로 끌려간다.
   */
  findGitViewTab(s, view) {
    return s ? findTabWhere([s], tab => tab.type === TAB_TYPE_GIT && tab.gitView === view) : null;
  }

  _findEditorTab(filePath) {
    // FR-DRV-10: **소스 탭만이다.** 렌더 탭이 이 판정에 걸리면 탐색기에서 연 파일이
    // 소스가 아니라 렌더로 열린다.
    return findTabWhere(this.app.ws.windows, tab => tab.type === TAB_TYPE_EDITOR && !tab.render && tab.filePath === filePath);
  }

  async addTab(rid, type = TAB_TYPE_TERMINAL, opts = {}) {
    // opts.windowId 지정 시 비활성 창의 pane 에도 추가 가능 (FR-RST-4).
    const s = opts.windowId ? this.app.ws.windows.find(x => x.id === opts.windowId) : this.app.aw();
    if (!s || !this._tabTypeFits(s, type)) return;
    const pn = findPane(s.layout, rid); if (!pn) return;
    // FR-OPT-11-2 (FEC-22): 타입별 여는 길은 `TAB_OPENERS` 표다. 모르는 타입은 종전대로
    // 터미널이다.
    const open = Object.hasOwn(TAB_OPENERS, type) ? TAB_OPENERS[type] : TAB_OPENERS[TAB_TYPE_TERMINAL];
    return open(this.app, s, pn, rid, opts);
  }

  // 창 타입의 불변식 — 이 창에 이 타입의 탭이 설 수 있는가.
  _tabTypeFits(s, type) {
    // FR-GIT-179: Git 창의 탭은 GIT_VIEWS 의 고정 탭뿐이다 — 더할 수 없다
    // (FR-GIT-28 개정으로 7개다. 숫자를 여기 적지 않는다 — 선언이 하나뿐이다).
    if (this.app.git.isGitWin(s)) return false;
    // FR-EDT-54 → REPO_TAB_UNIFY_SRS FR-RTU-16 으로 개정: Repo 창의 본문에는
    // **편집기 탭과 git 뷰 탭**이 산다. 터미널·run 탭은 여전히 만들 수 없다.
    //
    //   이전 동작: Editor 창에는 editor 탭만
    //   새  동작: editor 와 git 탭 (Diff·History·Branches·Stash·Console·Worktrees)
    //   이유:     diff·history 는 좁은 사이드가 아니라 본문에서 봐야 읽힌다.
    //             그리고 그 탭들은 편집기 탭과 같은 자격이어야 한다 (FR-RTU-33)
    if (this.app.isEditorWin(s) && type !== TAB_TYPE_EDITOR && type !== TAB_TYPE_GIT) return false;
    // CHAT_WINDOW_SRS FR-CW-10: 채팅 창에는 채팅 탭만, 채팅 탭은 채팅 창에만 선다.
    if (this.app.git.isChatWin(s) || type === TAB_TYPE_CHAT) return this.app.git.isChatWin(s) && type === TAB_TYPE_CHAT;
    // FR-EDT-94·106: 그 반대도 불변식이다 — 편집기 탭은 어떤 경로로도 일반
    // 창에 생기지 않는다. Editor 표면이 없는 환경(FR-EDT-120)에서는 갈 곳이
    // 없으므로 옛 경로가 그대로 남는다.
    if (type === TAB_TYPE_EDITOR && !this.app.isEditorWin(s) && this.app.edOn()) {
      console.warn('[addTab] editor tab belongs to an Editor window (FR-EDT-94)');
      return false;
    }
    return true;
  }

  // FR-RVZ-7 · FR-EDT-101: 이미 열린 탭으로 옮긴다 — 창을 바꾸고 그 탭을 보이며 칸을 잡는다.
  _revealTab(found) {
    this.app._activateWindow(found.win.id, { rememberFocus: true });
    this.app.paneTabSet(found.pane, found.tab.id);
    this.app.setFocusState(found.pane.id, found.win);
    this.app._focusWindow(found.win.id);
  }

  // 새 탭 레코드를 칸에 넣고 보인다. `focus` 면 그 칸을 포커스한다 (FR-RTU-80).
  _pushTab(s, pn, tab, focus) {
    pn.tabs.push(tab);
    this.app.paneTabSet(pn, tab.id);
    if (focus) this.app.setFocusState(pn.id, s);
  }

  // FR-RVZ-6: 네 번째 탭 타입. editor 와 같은 비-PTY 경로다 — 도구를 만들지
  // 않고 탭 레코드만 넣는다. editor 가 filePath 를 요구하듯 run 은 opts.runId 를
  // 요구한다. _findRunTab 은 `app.js` 의 위임자다 (본체는 `RunsPanel`).
  _addRunTab(s, pn, opts) {
    if (!opts.runId) { console.warn('[addTab] run tab requires runId'); return }
    // FR-RVZ-7: 같은 Run 의 탭이 이미 있으면 새로 만들지 않고 그리로 옮긴다
    // (editor 의 중복 방지와 같은 규약).
    const existing = this.app._findRunTab(opts.runId);
    if (existing) {
      this.app._revealTab(existing);
      this.app.render();
      this.app.save();
      return;
    }
    // FR-RVZ-8: 이름은 `Run <short>` 다. 여기서 한 번만 정한다 — 사용자가
    // rename 하면 그것이 이기려면 이 값을 나중에 덮어쓰지 않아야 한다.
    // 짧은 id 는 서버가 보낸 `short` 다 — 없으면 `Run` 만 쓴다 (SERVER_DRIVEN_ACTIONS_SRS K-l).
    const id = newEntityId();
    const label = opts.short ? 'Run ' + opts.short : 'Run';
    this._pushTab(s, pn, { id, name: clampEntityName(opts.name || label), type: TAB_TYPE_RUN, runId: opts.runId }, false);
    this.app.render();
    this.app.save();
    return { uuid: id };
  }

  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-30·31: git 뷰 탭. editor·run 과 같은 비-PTY
   * 경로이며 도구를 만들지 않는다.
   *
   * **창에 하나씩만** 연다 — 같은 History 를 두 탭으로 여는 것은 뜻이 없고,
   * 뷰의 DOM 이 패널에 하나뿐이라 둘째 탭은 첫째에서 그것을 떼어 온다.
   * 중복 방지가 editor·run 과 다른 점은 **창 안에서만** 찾는다는 것이다:
   * 저장소마다 자기 History 가 있어야 한다.
   */
  _addGitTab(s, pn, opts) {
    const view = opts.gitView;
    const def = GIT_VIEWS.find(v => v.key === view);
    if (!def) { console.warn('[addTab] git tab requires a known gitView'); return }
    const existing = this.findGitViewTab(s, view);
    if (existing) {
      this.app.paneTabSet(existing.pane, existing.tab.id);
      this.app.setFocusState(existing.pane.id, s);
      this.app.render();
      this.app.save();
      return { uuid: existing.tab.id };
    }
    const id = newEntityId();
    // 새 탭도 **그 칸을 포커스**한다 — 위의 "이미 있으면" 분기가 이미 그렇게
    // 한다. 그러지 않으면 모바일에서 사이드 자리에 머물러 방금 연 탭이 보이지
    // 않는다 (FR-RTU-80).
    this._pushTab(s, pn, { id, name: def.name, type: TAB_TYPE_GIT, gitView: view }, true);
    this.app.render();
    // FR-RTU-62: git 뷰 탭이 생기는 것은 **그 창에 git 표면이 서는** 일이다 —
    // 사이드가 Explorer 여도 이제 관측을 쓰는 화면이 있다.
    this.app.git.surfaces._gitRescheduleAll();
    this.app.save();
    return { uuid: id };
  }

  _addEditorTab(s, pn, opts) {
    if (!opts.filePath) { console.warn('[addTab] editor tab requires filePath'); return }
    // UX_BATCH12_SRS FR-RTB-2·4 (FR-RTU-45 개정): 미리보기는 **그 칸**의 일이다. 같은
    // 파일이 그 칸에 있으면 그 탭으로 가고, 다른 칸에만 있으면 이 칸에 미리보기로 연다.
    const existing = opts.preview ? this.app._findEditorTabIn(s, pn, opts.filePath) : this.app._findEditorTab(opts.filePath);
    if (!existing && opts.preview) {
      const r = this.app._retargetPreview(s, pn, opts);
      if (r) return r;
    }
    if (existing) {
      this.app._revealTab(existing);
      const editor = this.app.editorAny(existing.tab.id);
      if (editor) editor.refresh();
      this.app.render();
      this.app.save();
      return;
    }
    const id = newEntityId();
    const tab = { id, name: opts.name || pathBase(opts.filePath), type: TAB_TYPE_EDITOR, filePath: opts.filePath };
    // FR-RTU-40·44: 미리보기라는 사실은 **워크스페이스에 남는다.** 저장하지
    // 않으면 새로고침 뒤 모든 탭이 고정으로 되살아나 사용자가 정리해야 한다.
    if (opts.preview) tab.preview = true;
    // git 뷰 탭과 같은 근거 — 새 탭도 그 칸을 포커스한다 (FR-RTU-80).
    this._pushTab(s, pn, tab, true);
    this.app.render();
    this.app.save();
    return { uuid: id };
  }

  async _addTerminalTab(s, pn, rid, opts) {
    const ref = this.app.layout.tabOps._paneNewToolRef(s, rid);
    // FR-GIT-244: 호출자가 cwd 를 주면 그것이 이긴다 — worktree 에서 터미널을 열 때
    // 기준은 pane 의 cwd 가 아니라 그 worktree 다. 주지 않으면 기존 동작 그대로다.
    const cwd = opts.cwd || ref.cwd || null;
    const p = await this.app._newTool(cwd, cwd ? null : (ref.cwdTool || null), s);
    const id = newEntityId();
    const given = typeof opts.name === 'string' && opts.name;
    const name = clampEntityName(given ? opts.name : TAB_NAME_DEFAULT);
    // FR-TAN-2: `dmctl new-tab --name` 으로 받은 이름은 manual 이다 — 워크플로우·
    // team 스킬의 역할명이 이 경로를 지나므로 그것만으로 만족된다.
    const tab = { id, name, type: TAB_TYPE_TERMINAL, toolId: p.id };
    if (given) tab.nameSource = NAME_SOURCE_MANUAL;
    pn.tabs.push(tab);
    // FR-RST-4: keepFocus 면 대상 pane 의 활성 탭도 바꾸지 않는다 (백그라운드 추가).
    if (!opts.keepFocus) this.app.paneTabSet(pn, id);
    this.app.render();
    this.app.save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 tab id+toolId 반환 (echo 용).
    return { uuid: id, toolId: p.id };
  }
}

// 바깥이 부르는 이름 — `tool-cmd.js`·`layout-tab-reopen.js`·채팅·편집기·`git/`·계약.
Controller.delegate(App,'layout.tabAdd',['findGitViewTab','_findEditorTab','addTab','_revealTab','_pushTab']);
