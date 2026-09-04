/**
 * Remote Terminal — App 창·탭·분할 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 21개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  /**
   * RELOAD_CONTINUITY_SRS FR-RLC-6·10: 사이드바 탭이 **돌아갈 창**을 적는다.
   *
   * 자리가 sessionStorage 인 이유는 이 값이 `activeWindow`·`focusedPanes`·`slots`
   * 와 같은 범주 — "이 브라우저 탭이 보던 것" — 이기 때문이다 (SRS §2.3).
   * localStorage 에 두면 두 탭이 같은 키를 번갈아 덮어 서로의 복귀 자리를 흔든다.
   *
   * 저장이 막힌 환경(사생활 모드)에서는 메모리에만 남는다 — 사이드바의 편의가
   * 화면을 세우지 못하게 해서는 안 된다.
   */
  _rememberReturn(kind,id){
    if(kind==='plain') this._lastPlainWindow=id; else this._lastEditorWindow=id;
    try{sessionStorage.setItem(RETURN_WINDOW_KEY[kind],id)}catch{}
  },

  /**
   * FR-RLC-8: 기억을 되살린다. `activeWindow`·`focusedPanes` 와 **같은 블록**에서
   * 불린다 (app.js) — 셋 다 같은 성질이고, 흩어 두면 하나만 고쳐진다.
   *
   * 지금 워크스페이스에 없는 창 id 는 버린다. 없는 창으로 돌아갈 수는 없으며,
   * 그때의 동작은 종전과 같은 폴백이다 (FR-RLC-9).
   */
  _restoreReturn(){
    const has=id=>!!id&&this.ws.windows.some(s=>s&&s.id===id);
    for(const kind of Object.keys(RETURN_WINDOW_KEY)){
      let id=null;
      try{id=sessionStorage.getItem(RETURN_WINDOW_KEY[kind])}catch{}
      if(!has(id)) continue;
      if(kind==='plain') this._lastPlainWindow=id; else this._lastEditorWindow=id;
    }
  },

  // 창 사이드바 드래그 재배치. drop(즉시) 1순위 + dragend 폴백, done 으로 중복 커밋 차단.
  // 식별자(id)로 원본/대상을 찾아 splice 후 인덱스 이동에 안전. 대상 미존재(끝 너머)면 맨 끝으로.
  // ── 탭 이름의 출처 (CONVENIENCE_SRS 묶음 N) ──

  // FR-TAN-2: 사용자·에이전트가 명시적으로 준 이름이다. 자동 갱신 대상에서
  // 빠진다 (FR-TAN-15).
  _tabToManual(tab){
    if(tab) tab.nameSource=NAME_SOURCE_MANUAL;
  },

  // FR-TAN-21/22: 자동으로 되돌린다. 이름도 기본값으로 함께 돌린다 — 되돌린
  // 탭에 전경 프로그램이 없으면 `Shell` 이어야 하고(FR-TAN-12), 예전 수동
  // 이름이 남아 있으면 그 상태를 표현할 방법이 없다.
  //
  // `nameSource` 키를 지우는 것은 저장을 줄이려는 것이 아니라, auto 가
  // "출처가 없다"는 뜻이기 때문이다 — `tabNameSource` 가 같은 값을 낸다.
  _tabToAuto(tab){
    if(!tab) return;
    delete tab.nameSource;
    tab.name=TAB_NAME_DEFAULT;
  },

  /**
   * 탭 이름 인라인 편집. 창 이름(`_rename`)과 갈라져 있는 이유는 **빈 문자열의
   * 뜻이 다르기** 때문이다 — 탭에서는 자동 복귀 명령이고(FR-TAN-21), 창에는
   * 그런 개념이 없어 지금처럼 취소로 남는다.
   */
  _renameTab(tab, el){
    const old=tab.name;
    const input=document.createElement('input');
    input.type='text'; input.value=old; input.className='rename-input';
    el.replaceWith(input); input.focus(); input.select();
    const done=()=>{
      const v=input.value.trim();
      // FR-TAN-21: 비워서 확정하면 자동으로 돌아간다. 지금까지 빈 이름은 그냥
      // 거부돼 동작이 비어 있었고, 여기에 뜻을 준다.
      if(!v){ this._tabToAuto(tab); this._save() }
      else if(v!==old){ tab.name=v; this._tabToManual(tab); this._save() }
      this.render();
    };
    input.addEventListener('blur', done, {once:true});
    input.addEventListener('keydown', e=>{
      if(e.key==='Enter'){e.preventDefault();input.blur()}
      if(e.key==='Escape'){input.value=old;input.blur()}
    });
  },

  /**
   * FR-CLS-1: 창을 닫은 뒤 갈 일반 창. `removedIdx` 는 방금 지운 자리이며 그
   * 자리에 가장 가까운 일반 창을 고른다 — 목록에서 눈이 있던 곳 근처다.
   * 일반 창이 없으면 null 이고, 그때의 처리는 호출자의 몫이다 (FR-CLS-2).
   */
  _nextActiveWindow(removedIdx){
    const arr=this.ws.windows;
    // FR-EDT-45: Editor 창도 대상이 아니다 — 창 하나 닫았을 뿐인데 편집기
    // 화면에 떨어지면 안 된다 (Git 창을 거르는 것과 같은 근거).
    const plain=s=>s&&!this._isGitWin(s)&&!this._isEditorWin(s);
    for(let d=0;d<arr.length;d++){
      const a=arr[removedIdx+d], b=arr[removedIdx-d];
      if(plain(a)) return a;
      if(plain(b)) return b;
    }
    return null;
  },

  /**
   * WORKBENCH_REVIEW_SRS FR-WBR-20 (UX_REVISION_SRS FR-CWD-1 폐기).
   *
   *   이전 동작: 새 창의 첫 도구가 **포커스 분할 칸의 cwd 를 승계**했다
   *   새  동작: 승계하지 않는다 — 호출자가 준 것이 없으면 **홈**이다
   *   이유:     사용자 지시("터미널은 홈에서 시작하는 것이 맞다"). 새 창은
   *             "새로 시작한다" 는 뜻이고, 지금 일하던 자리에서 하나 더 여는
   *             것은 새 탭·분할이다 — 그쪽의 승계는 그대로다 (FR-WBR-21)
   *
   * 명시적 지정은 그대로 이긴다 (FR-CWD-3) — `opts.cwd` 와 `opts.cwdTool` 이다.
   * `dmctl new-window --cwd` 가 그 길로 온다 (FR-WBR-23).
   */
  async _mkWindow(opts={}){
    const sandbox=(typeof opts.sandbox==='string'&&opts.sandbox)?opts.sandbox:'';
    // FR-SBX-40: 샌드박스 창은 **고른 폴더만** 쓴다.
    const cwd=opts.cwd||null;
    // FR-CWD-3: `cwdTool` 은 그 도구의 cwd 를 서버가 풀어 준다
    // (`/api/tools?cwdTool=`) — 브라우저는 경로를 모른 채 넘긴다.
    const refTool=sandbox?null:(opts.cwdTool||null);
    // FR-SBX-10: 창 id 를 도구보다 **먼저** 만든다. 순서가 반대면 첫 도구가
    // 자기 창을 모른 채 떠서, 샌드박스 창인데 첫 탭만 호스트에서 돈다.
    const wid=newEntityId();
    const p=await this._newTool(cwd, cwd?null:refTool, {id:wid,sandbox});
    const r=newEntityId(),t=newEntityId();
    const name=(typeof opts.name==='string'&&opts.name?opts.name:'Window').slice(0,64);
    const s={
      id:wid,name,
      // `opts.name` 은 **창** 이름이다 — 안의 탭은 이름을 받은 적이 없으므로
      // auto 로 태어난다 (FR-TAN-1). `nameSource` 를 적지 않는 것이 auto 다.
      layout:{type:'pane',id:r,tabs:[{id:t,name:TAB_NAME_DEFAULT,type:'terminal',toolId:p.id}],activeTab:t}
    };
    // FR-SBX-18: 선택 필드다. 일반 창에는 키 자체를 두지 않는다.
    if(sandbox) s.sandbox=sandbox;
    // SANDBOX_PICK_COPY_SRS FR-SPK-21·22: 이 창의 작업 폴더가 **복사본**이라는
    // 사실. 컨테이너 안의 변경이 호스트로 돌아오지 않는다는 것은 창을 여는
    // 순간에만 말하고 끝낼 성질이 아니다 — 사용자는 며칠 뒤에도 그 창에서
    // 일한다. 폴더를 실제로 받은 창에만 적는다 (복사한 것이 없으면 뜻이 없다).
    if(sandbox&&opts.sandboxWork===SANDBOX_WORK_COPY&&cwd) s.sandboxCopy=true;
    this.ws.windows.push(s);
    // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-2: keepFocus 면 창은 사이드바에만
    // 추가 — activeWindow/focused 무변화 (백그라운드 잡 컨테이너 패턴).
    if(!opts.keepFocus){
      this.ws.activeWindow=s.id;
      try{sessionStorage.setItem('activeWindow', s.id)}catch{}
      this._setFocus(r, s);
      this._focusWindow(s.id);
    }
    // Fire-and-forget save: keeps the UI snappy. Awaiting here would block
    // render on the PUT roundtrip (see split/addTab which already use
    // this pattern).
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-6/7: 생성한 엔터티 id 반환 (echo 용).
    return {win:s.id, pane:r, tab:{uuid:t, toolId:p.id}};
  },

  async addWindow(opts){await this._mkWindow(opts||{});this.render()},

  async delWindow(sid){
    const i=this.ws.windows.findIndex(s=>s.id===sid);
    if(i<0) return;
    // FR-WSL-6: 슬롯 정리는 창을 실제로 지우기 **전에** 예약해 두지 않는다 —
    // 아래 확인 대화에서 취소될 수 있기 때문이다. 지운 뒤에 부른다 (아래).

    const s=this.ws.windows[i];
    const pids=allPids(s.layout);
    const busyChecks=await Promise.all(pids.map(pid=>this._isToolBusy(pid)));
    // FR-BG-4/4a: 일괄 전환 대상은 busy 인 도구만이다. 확인창이 뜨는 사유가
    // "실행 중인 프로세스"이고, 한가하면 그냥 종료한다는 FR-BG-1 의 기본과
    // 일관되어야 한다 — 한가한 셸까지 보존하면 백그라운드가 쓰레기로 찬다.
    let keep=new Set();
    if(busyChecks.some(Boolean)){
      const r=await this._confirmClose('실행 중인 프로세스가 있습니다. 창을 닫으시겠습니까?',
        {bgBtn:true,bgLabel:'실행 중인 것만 백그라운드로'});
      if(!r) return;
      if(r==='background'){
        for(let i=0;i<pids.length;i++) if(busyChecks[i]) keep.add(pids[i]);
      }
    }
    for(const pid of keep) this._setToolBackground(pid,true);
    if(keep.size) this._bgRefresh();
    // FR-BG-4b: backgroundCapable 이 아닌 도구는 전환 대상이 아니라 종료된다.
    for(const pid of pids) if(!keep.has(pid)) this._kill(pid);
    this.ws.windows.splice(i,1);
    // FR-WSL-6: 실제로 지워진 뒤에 슬롯을 정리한다 — 위의 확인 대화에서
    // 취소되면 여기 도달하지 않는다.
    this._slotOnWindowGone(sid);
    if(!this.ws.windows.length){await this._mkWindow();this.render();return}
    if(this.ws.activeWindow===sid){
      // UX_REVISION_SRS FR-CLS-1: 다음 활성 창은 **일반 창**이다. 인덱스로만
      // 고르면 Git 창이 활성이 되고, 그러면 사이드바 탭이 Git 으로 따라간다
      // (FR-SBT-14) — 창 하나 닫았을 뿐인데 Git 화면에 떨어진다.
      //
      // Git 창 자신을 닫은 경우는 `_gitCloseWindow` 가 이미 복귀 대상으로
      // 옮겨 놓았다 (FR-CLS-3). 그 경로도 여기 규칙과 같은 곳으로 간다.
      const next=this._nextActiveWindow(i);
      if(next){
        this.ws.activeWindow=next.id;
        try{sessionStorage.setItem('activeWindow', this.ws.activeWindow)}catch{}
      }else{
        // FR-CLS-2: 일반 창이 남지 않았다. Git 창만 남기고 사용자를 그 안에
        // 가두지 않는다 — 새 창을 만들고 그리로 간다.
        await this._mkWindow();
        this.render(); this._save();
        return;
      }
    }
    const a=this._aw();
    if(a&&a.layout){
      const next=(a.focusedPane&&findPane(a.layout,a.focusedPane))?a.focusedPane:firstPane(a.layout)?.id||null;
      this._setFocus(next, a);
    } else this.focused=null;
    // Render first, save in background (matches split/addTab/closeTab).
    this._focusWindow(this.ws.activeWindow);
    this.render();
    this._save();
  },

  switchWindow(sid){
    if(this.ws.activeWindow===sid){
      if(this.isMobile && this._drawerOpen) this._toggleDrawer(false);
      return;
    }
    const cur=this._aw();if(cur)cur.focusedPane=this.focused;
    // FR-GIT-185: Open File 이 돌아갈 창을 기억한다 — 규칙이 하나여야 "어디에
    // 열렸는지 모르겠다"가 없다 (O15).
    // RELOAD_CONTINUITY_SRS FR-RLC-6·7: 그 기억은 새로고침을 건넌다. 사이드바
    // 탭 자체는 이미 건너는데(localStorage `sidebarTab`) 그 탭이 **돌아갈 자리**는
    // 건너지 못해, 새로고침 뒤 Windows 탭이 늘 첫 창으로 갔다 (SRS §2.2).
    // 적는 자리는 여기 하나다 — 두 벌로 만들면 한쪽만 갱신된다.
    if(cur&&!this._isGitWin(cur)&&!this._isEditorWin(cur)) this._rememberReturn('plain',cur.id);
    this.ws.activeWindow=sid;
    // WINDOW_SLOTS_SRS FR-WSL-54: 포커스 슬롯이 이 창을 받는다. 다른 슬롯은
    // 건드리지 않는다 — 그것이 두 칸을 나란히 두는 이유다.
    this._slotOnSwitch(sid);
    // FR-EDT-7: Editor 탭이 돌아갈 창을 같은 규약으로 기억한다 — 들어가는
    // 순간에 적는다. 나갈 때 적으면 한 번도 떠난 적 없는 창을 기억하지 못한다.
    if(this._isEditorWin(this._aw())) this._rememberReturn('editor',sid);
    // Persist per-window activeWindow to sessionStorage (survives refresh,
    // independent across windows).
    try{sessionStorage.setItem('activeWindow', sid)}catch{}
    // D-RTU-18: 루트도 함께 적는다 — 새로고침 뒤 id 는 바뀔 수 있고 루트는 아니다.
    try{
      const w=this._aw();
      if(this._isEditorWin(w)) sessionStorage.setItem(ACTIVE_EDITOR_ROOT_KEY,this._edRootOf(w));
      else sessionStorage.removeItem(ACTIVE_EDITOR_ROOT_KEY);
    }catch{}
    const a=this._aw();
    if(a&&a.layout){
      const next=(a.focusedPane&&findPane(a.layout,a.focusedPane))?a.focusedPane:firstPane(a.layout)?.id||null;
      this._setFocus(next, a);
    } else this.focused=null;
    this._mPaneIdx=0;
    if(this.isMobile && this._drawerOpen) this._toggleDrawer(false);
    this._focusWindow(sid);
    // FR-GIT-22 + FR-RTU-62: 창 전환은 폴링 조건의 재평가 시점이다. **모든
    // 패널**이 다시 본다 — 떠난 창의 패널이 타이머를 든 채 남으면 아무도 보지
    // 않는 저장소를 계속 폴링한다.
    this._gitRescheduleAll();
    this._save(); this.render();
  },

  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-40·43: 창의 **미리보기 탭**. 하나뿐이다.
   */
  _findPreviewTab(s){
    if(!s||!s.layout) return null;
    for(const pn of this._flattenPanes(s.layout)){
      const tab=(pn.tabs||[]).find(t=>t&&t.preview);
      if(tab) return {win:s,pane:pn,tab};
    }
    return null;
  },

  /**
   * FR-RTU-42: 미리보기를 고정한다. 계기는 셋이다 — 더블클릭 · 그 탭에서 편집
   * 시작 · 탭 이름 더블클릭. 어느 쪽이든 뜻은 같다: "이 탭은 남는다."
   */
  _pinPreviewTab(tab){
    if(!tab||!tab.preview) return false;
    delete tab.preview;
    this.render();
    this._save();
    return true;
  },

  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-31: **그 창 안에서** 같은 뷰의 탭을 찾는다.
   *
   * `_findEditorTab` 이 워크스페이스 전체를 훑는 것과 다르다 — 편집기 탭은 파일
   * 하나가 앱에 한 번 열리면 되지만, git 뷰는 **저장소마다** 자기 것이 있어야
   * 한다. 전체를 훑으면 다른 저장소의 History 로 끌려간다.
   */
  _findGitViewTab(s, view) {
    if (!s || !s.layout) return null;
    for (const pn of this._flattenPanes(s.layout)) {
      const tab = (pn.tabs || []).find(t => t && t.type === TAB_TYPE_GIT && t.gitView === view);
      if (tab) return { win: s, pane: pn, tab };
    }
    return null;
  },

  _findEditorTab(filePath) {
    for (const s of this.ws.windows) {
      if (!s || !s.layout) continue;
      let result = null;
      const walk = n => {
        if (!n || result) return;
        if (n.type === 'pane' && n.tabs) {
          for (const t of n.tabs) {
            if (t.type === 'editor' && t.filePath === filePath) {
              result = { tab: t, pane: n, win: s };
              return;
            }
          }
        }
        if (n.type === 'split' && n.children) {
          for (const c of n.children) walk(c);
        }
      };
      walk(s.layout);
      if (result) return result;
    }
    return null;
  },

  async addTab(rid, type = 'terminal', opts = {}) {
    // opts.windowId 지정 시 비활성 창의 pane 에도 추가 가능 (FR-RST-4).
    const s = opts.windowId ? this.ws.windows.find(x => x.id === opts.windowId) : this._aw();
    if (!s) return;
    // FR-GIT-179: Git 창의 탭은 GIT_VIEWS 의 고정 탭뿐이다 — 더할 수 없다
    // (FR-GIT-28 개정으로 7개다. 숫자를 여기 적지 않는다 — 선언이 하나뿐이다).
    if (this._isGitWin(s)) return;
    // FR-EDT-54 → REPO_TAB_UNIFY_SRS FR-RTU-16 으로 개정: Repo 창의 본문에는
    // **편집기 탭과 git 뷰 탭**이 산다. 터미널·run 탭은 여전히 만들 수 없다.
    //
    //   이전 동작: Editor 창에는 editor 탭만
    //   새  동작: editor 와 git 탭 (Diff·History·Branches·Stash·Console·Worktrees)
    //   이유:     diff·history 는 좁은 사이드가 아니라 본문에서 봐야 읽힌다.
    //             그리고 그 탭들은 편집기 탭과 같은 자격이어야 한다 (FR-RTU-33)
    if (this._isEditorWin(s) && type !== 'editor' && type !== TAB_TYPE_GIT) return;
    // FR-EDT-94·106: 그 반대도 불변식이다 — 편집기 탭은 어떤 경로로도 일반
    // 창에 생기지 않는다. Editor 표면이 없는 환경(FR-EDT-120)에서는 갈 곳이
    // 없으므로 옛 경로가 그대로 남는다.
    if (type === 'editor' && !this._isEditorWin(s) && this._edOn()) {
      console.warn('[addTab] editor tab belongs to an Editor window (FR-EDT-94)');
      return;
    }
    const pn = findPane(s.layout, rid); if (!pn) return;
    // FR-RVZ-6: 네 번째 탭 타입. editor 와 같은 비-PTY 경로다 — 도구를 만들지
    // 않고 탭 레코드만 넣는다. editor 가 filePath 를 요구하듯 run 은 opts.runId 를
    // 요구한다. _findRunTab 은 app-runs.js 에 있다 (그 파일이 이 파일 뒤에
    // 로드되므로 호출 시점에는 프로토타입에 있다).
    if (type === 'run') {
      if (!opts.runId) { console.warn('[addTab] run tab requires runId'); return }
      // FR-RVZ-7: 같은 Run 의 탭이 이미 있으면 새로 만들지 않고 그리로 옮긴다
      // (아래 editor 의 중복 방지와 같은 규약).
      const existing = this._findRunTab(opts.runId);
      if (existing) {
        const cur = this._aw(); if (cur) cur.focusedPane = this.focused;
        this.ws.activeWindow = existing.win.id;
        try{sessionStorage.setItem('activeWindow', existing.win.id)}catch{}
        this.paneTabSet(existing.pane, existing.tab.id);
        this._setFocus(existing.pane.id, existing.win);
        this._focusWindow(existing.win.id);
        this.render();
        this._save();
        return;
      }
      // FR-RVZ-8: 이름은 `Run <short>` 다. 여기서 한 번만 정한다 — 사용자가
      // rename 하면 그것이 이기려면 이 값을 나중에 덮어쓰지 않아야 한다.
      const short = opts.short || String(opts.runId).slice(0, 8);
      const t = newEntityId();
      pn.tabs.push({ id: t, name: (opts.name || 'Run ' + short).slice(0, 64), type: 'run', runId: opts.runId });
      this.paneTabSet(pn, t);
      this.render();
      this._save();
      return { uuid: t };
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
    if (type === TAB_TYPE_GIT) {
      const view = opts.gitView;
      const def = GIT_VIEWS.find(v => v.key === view);
      if (!def) { console.warn('[addTab] git tab requires a known gitView'); return }
      const existing = this._findGitViewTab(s, view);
      if (existing) {
        this.paneTabSet(existing.pane, existing.tab.id);
        this._setFocus(existing.pane.id, s);
        this.render();
        this._save();
        return { uuid: existing.tab.id };
      }
      const t = newEntityId();
      pn.tabs.push({ id: t, name: def.name, type: TAB_TYPE_GIT, gitView: view });
      this.paneTabSet(pn, t);
      // 새 탭도 **그 칸을 포커스**한다 — 위의 "이미 있으면" 분기가 이미 그렇게
      // 한다. 그러지 않으면 모바일에서 사이드 자리에 머물러 방금 연 탭이 보이지
      // 않는다 (FR-RTU-80).
      this._setFocus(pn.id, s);
      this.render();
      // FR-RTU-62: git 뷰 탭이 생기는 것은 **그 창에 git 표면이 서는** 일이다 —
      // 사이드가 Explorer 여도 이제 관측을 쓰는 화면이 있다.
      this._gitRescheduleAll();
      this._save();
      return { uuid: t };
    }
    if (type === 'editor') {
      if (!opts.filePath) { console.warn('[addTab] editor tab requires filePath'); return }
      const existing = this._findEditorTab(opts.filePath);
      // FR-RTU-45: 이미 **고정된** 탭이 있으면 미리보기를 만들지 않는다 —
      // 아래 기존 분기가 그 탭으로 옮긴다 (FR-EDT-101 을 미리보기까지 넓힌 것).
      // FR-RTU-40: 미리보기 요청이면 기존 미리보기 탭을 **대체한다.** 새 탭을
      // 만들지 않으므로 목록을 훑어도 탭이 쌓이지 않는다.
      if (!existing && opts.preview) {
        const prev = this._findPreviewTab(s);
        if (prev) {
          prev.tab.filePath = opts.filePath;
          prev.tab.name = (opts.name || opts.filePath.split('/').pop() || '').slice(0, 64);
          // 편집기 인스턴스는 탭 id 로 산다 — 대상이 바뀌었으므로 버린다.
          for (const [k, v] of [...this.fileEditors]) {
            if (this._slotBase(k) !== prev.tab.id) continue;
            try { v.destroy() } catch { /* 이미 파괴된 것은 오류가 아니다 */ }
            this.fileEditors.delete(k);
          }
          this.paneTabSet(prev.pane, prev.tab.id);
          this._setFocus(prev.pane.id, s);
          this.render();
          this._save();
          return { uuid: prev.tab.id };
        }
      }
      if (existing) {
        const cur = this._aw(); if (cur) cur.focusedPane = this.focused;
        this.ws.activeWindow = existing.win.id;
        try{sessionStorage.setItem('activeWindow', existing.win.id)}catch{}
        this.paneTabSet(existing.pane, existing.tab.id);
        this._setFocus(existing.pane.id, existing.win);
        this._focusWindow(existing.win.id);
        const editor = this.fileEditors.get(existing.tab.id);
        if (editor) editor.refresh();
        this.render();
        this._save();
        return;
      }
      const name = opts.name || opts.filePath.split('/').pop();
      const t = newEntityId();
      const tab = { id: t, name, type: 'editor', filePath: opts.filePath };
      // FR-RTU-40·44: 미리보기라는 사실은 **워크스페이스에 남는다.** 저장하지
      // 않으면 새로고침 뒤 모든 탭이 고정으로 되살아나 사용자가 정리해야 한다.
      if (opts.preview) tab.preview = true;
      pn.tabs.push(tab);
      this.paneTabSet(pn, t);
      // git 뷰 탭과 같은 근거 — 새 탭도 그 칸을 포커스한다 (FR-RTU-80).
      this._setFocus(pn.id, s);
      this.render();
      this._save();
      return { uuid: t };
    }
    const ref = this._paneNewToolRef(s, rid);
    // FR-GIT-244: 호출자가 cwd 를 주면 그것이 이긴다 — worktree 에서 터미널을 열 때
    // 기준은 pane 의 cwd 가 아니라 그 worktree 다. 주지 않으면 기존 동작 그대로다.
    const cwd = opts.cwd || ref.cwd || null;
    const p = await this._newTool(cwd, cwd ? null : (ref.cwdTool || null), s);
    const t = newEntityId();
    const given = typeof opts.name === 'string' && opts.name;
    const name = (given ? opts.name : TAB_NAME_DEFAULT).slice(0, 64);
    // FR-TAN-2: `dmctl new-tab --name` 으로 받은 이름은 manual 이다 — 워크플로우·
    // team 스킬의 역할명이 이 경로를 지나므로 그것만으로 만족된다.
    const tab = { id: t, name, type: 'terminal', toolId: p.id };
    if (given) tab.nameSource = NAME_SOURCE_MANUAL;
    pn.tabs.push(tab);
    // FR-RST-4: keepFocus 면 대상 pane 의 활성 탭도 바꾸지 않는다 (백그라운드 추가).
    if (!opts.keepFocus) this.paneTabSet(pn, t);
    this.render();
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 tab id+toolId 반환 (echo 용).
    return { uuid: t, toolId: p.id };
  },

  async closeTab(rid,tid,sid,opts={}){
    // sid 를 지정하면 해당 창의 탭을 닫는다 (비활성 창 대상도 지원).
    // 지정 안 하면 기존 동작: 활성 창에서 닫는다.
    const s = sid ? this.ws.windows.find(x=>x.id===sid) : this._aw();
    if(!s) return;
    const pn=findPane(s.layout,rid); if(!pn) return;
    const tab=pn.tabs.find(t=>t.id===tid); if(!tab) return;
    /**
     * REPO_TAB_UNIFY_SRS FR-RTU-33·34: **git 뷰 탭은 닫을 수 있다.**
     *
     *   이전 동작: `TAB_TYPE_GIT` 은 조기 반환 — 닫히지 않았다 (FR-GIT-28)
     *   새  동작: 편집기 탭과 같이 닫힌다. 확인은 없다 (잃는 편집이 없다)
     *   이유:     그 금지의 근거는 Git 창의 탭이 **고정 일곱**이라 자리가 늘
     *             같아야 한다는 것이었다. 뷰가 본문의 탭이 된 지금 자리를
     *             정하는 것은 사용자다 (FR-RTU-30·33)
     *
     * 뷰의 상태(스크롤·선택·diff 대상)는 **패널**이 들고 있으므로 다시 열면
     * 그대로다 (FR-RTU-34). 놓는 것은 그 뷰의 DOM 과 Monaco 뿐이며, 그것이
     * NFR-RTU-3 이 요구하는 것이다 — 탭이 없는 뷰는 인스턴스도 없다.
     */
    const gitTab=tab.type===TAB_TYPE_GIT;
    if(gitTab) this._gitDropView(this._edRootOf(s),tab.gitView);
    const isEditor=tab.type==='editor';
    if(isEditor){
      const editor=this.fileEditors.get(tab.id);
      // EDITOR_TAB_SRS FR-EDT-91: 파일이 삭제되어 닫는 경로는 확인을 건너뛴다 —
      // dirty 라는 사실은 삭제 확인창이 이미 밝혔고(FR-EDT-84), 여기서 취소해도
      // 파일은 이미 없다.
      if(editor && editor._dirty && !opts.force){
        const result=await this._confirmClose('저장되지 않은 변경사항이 있습니다.', { saveBtn: true });
        if(result==='save'){
          await editor.save();
        }else if(!result){
          return;
        }
      }
      if(editor){editor.destroy();this.fileEditors.delete(tab.id)}
    }else{
      // FR-BG-1: 한가하면 확인 없이 닫고 도구를 종료한다.
      // FR-BG-3: 실행 중이면 살려둘 선택지를 준다. 프로세스가 도는 탭에는
      // 셸 프롬프트가 없어 detach 를 입력할 수 없고, 바로 그 탭이 이 창을
      // 띄우는 탭이다.
      // run·editor 는 도구가 없다 — toolId 없이 busy 를 물으면
      // /api/tools/undefined/busy 404 가 콘솔에 남는다 (FR-RVZ-6).
      // editor 는 위 isEditor 게이트로 이 경로를 피하지만 run 은 그 게이트가 없다.
      if(tab.toolId && !opts.keepTool && await this._isToolBusy(tab.toolId)){
        const r=await this._confirmClose('실행 중인 프로세스가 있습니다. 탭을 닫으시겠습니까?',
          {bgBtn:toolBackgroundCapable(tab.type)});
        if(!r) return;
        if(r==='background') opts={...opts,keepTool:true};
      }
    }
    const toolId=tab.toolId;
    const closingIdx=pn.tabs.findIndex(t=>t.id===tid);
    pn.tabs=pn.tabs.filter(t=>t.id!==tid);
    // FR-RTU-62: 마지막 git 뷰 탭이 닫히면 그 창의 git 표면이 사라진다 —
    // 사이드가 Explorer 면 관측을 쓰는 화면이 없으므로 폴링도 멎어야 한다.
    if(gitTab) this._gitRescheduleAll();
    const prevClosestId=pn.tabs.length?pn.tabs[Math.min(closingIdx,pn.tabs.length-1)].id:null;
    const isActive = s.id === this.ws.activeWindow;
    if(pn.tabs.length===0){
      s.layout=doRemove(s.layout,rid);
      // FR-EDT-52·55·56: Editor 창은 pane 이 0이 되어도 남는다 — 창의 수명은
      // 행의 수명이다 (FR-EDT-42). 빈 pane 을 남기지 않는 것과 창을 지우는 것은
      // 다른 일이다.
      if(!s.layout&&this._isEditorWin(s)){
        if(isActive){this._setFocus(null,s);this._focusWindow(s.id)}
        this.render();
        this._save();
        return;
      }
      if(!s.layout){
        // FR-BG-6f: 마지막 탭이 닫혀 창까지 사라지는 경로. 아래 공통 처리에
        // 도달하지 못하고 조기 반환하므로 도구 처분을 여기서 마쳐야 한다.
        // keepTool 이면 백그라운드로 등록한다 — 등록을 빠뜨리면 종료되지도,
        // 목록에 오르지도 않아 어디서도 닿을 수 없는 도구가 된다.
        if(!isEditor&&toolId){
          if(opts.keepTool) await this._setToolBackground(toolId,true);
          else this._killTool(toolId);
        }
        await this.delWindow(s.id);
        if(!isEditor&&toolId&&opts.keepTool) this._bgRefresh();
        return;
      }
      if(isActive){
        const fallback=this.focused===rid?prevClosestId:this.focused;
        const next=fallback&&findPane(s.layout,fallback)?fallback:firstPane(s.layout)?.id||null;
        this._setFocus(next,s);
        this._focusWindow(s.id);
      }
    }else{
      const nextId=pn.tabs[Math.min(closingIdx,pn.tabs.length-1)].id;
      // FR-SVS-10: 닫은 칸의 시선이 이웃 탭으로 간다. 다른 칸은 자기 오버라이드가
      // 살아 있으면 움직이지 않고, 같은 탭을 보고 있었다면 FR-SVS-5 로 폴백한다.
      this.paneTabSet(pn,nextId,opts.slot);
      // 워크스페이스가 죽은 탭을 가리키지 않게 한다 — 비포커스 칸이 닫은
      // 경우에는 `paneTabSet` 이 `activeTab` 을 쓰지 않는다 (FR-SVS-14).
      if(pn.activeTab===tid) pn.activeTab=nextId;
      if(isActive){
        this._setFocus(rid,s);
        this._focusWindow(s.id);
      }
    }
    this.render();
    if(!isEditor&&toolId){
      if(opts.keepTool){
        // 탭만 제거한다 — 도구는 백그라운드에서 계속 실행된다 (FR-BG-2/3).
        this._setToolBackground(toolId,true).then(()=>this._bgRefresh());
      }else{
        this._killTool(toolId);
      }
    }
    this._save();
  },

  // FR-SVS-4: 탭을 고르는 **단일 통로**다. `slot` 을 주면 그 칸의 시선만 바뀌고,
  // 생략하면 포커스 칸이다. 사이드바·순회 키·클릭이 모두 여기를 지난다.
  switchTab(rid,tid,slot){
    const i=(slot==null)?this._slotFocused():slot;
    // 비포커스 칸의 창은 활성 창이 아닐 수 있다 — 그 칸의 창에서 pane 을 찾는다.
    const s=(slot==null)?this._aw():(this._slotWindow(i)||this._aw());
    if(!s) return;
    const pn=findPane(s.layout,rid); if(!pn) return;
    if(this.paneTab(pn,i)===tid && this.focused===rid){this._setFocus(rid, s); return}
    this.paneTabSet(pn,tid,i); this._setFocus(rid, s);
    this._save(); this.render();
  },

  // split is serialized through this._splitChain so that rapid successive
  // calls (e.g. holding the shortcut) don't race on this.focused: each call
  // waits for the previous to finish — including the _setFocus that updates
  // the new target — before reading focus or layout state.
  split(dir,opts={}){
    const prev=this._splitChain||Promise.resolve();
    const next=prev.then(()=>this._splitInner(dir,opts)).catch(err=>{console.error('[split] error',err)});
    this._splitChain=next.finally(()=>{ if(this._splitChain===next) this._splitChain=null; });
    return next;
  },

  async _splitInner(dir,opts={}){
    if(this.isMobile && !opts.force) return;
    const tgtWindowId=opts.targetWindow||this.ws.activeWindow;
    let s=this.ws.windows.find(x=>x.id===tgtWindowId);
    // FR-GIT-179: Git 창은 닫힌 창이다 — 분할 칸을 만들 수 없다.
    if(this._isGitWin(s)) return;
    // FR-EDT-50·51: Editor 창에서 분할이 생기는 유일한 길은 드래그드롭이다.
    // 단축키와 버튼은 이 자리에서 무시된다.
    if(this._isEditorWin(s)) return;
    const tgtPaneId=opts.targetPane||(tgtWindowId===this.ws.activeWindow?this.focused:null);
    if(!s||!tgtPaneId) return;
    let count=parseInt(opts.count,10); if(!Number.isFinite(count)||count<2) count=2;
    const keepFocus=!!opts.keepFocus;
    // SPLIT_KEEPFOCUS_FIX_SRS FR-SKF-1: keepFocus 면 호출 직전 사용자 포커스를 저장해 사후 복원.
    const savedWindow = keepFocus ? this.ws.activeWindow : null;
    const savedFocused = keepFocus ? this.focused : null;
    const ref=this._paneNewToolRef(s,tgtPaneId);
    const refPaneId=ref.cwd ? null : (ref.cwdTool || null);
    const newPanes=[]; let lastR=null;
    for(let i=0;i<count-1;i++){
      const p=await this._newTool(ref.cwd || null, refPaneId, s);
      const r=newEntityId(),t=newEntityId();
      newPanes.push({type:'pane',id:r,tabs:[{id:t,name:'Shell',type:'terminal',toolId:p.id}],activeTab:t});
      lastR=r;
    }
    // Re-fetch window after awaits: this.ws may have been replaced by an
    // SSE workspace_changed apply during the _newTool awaits, leaving our
    // earlier `s` reference stale (and invisible to render). Bail if the
    // target pane is gone — the created panes will be reaped on the next
    // workspace sync.
    s=this.ws.windows.find(x=>x.id===tgtWindowId);
    if(!s||!findPane(s.layout,tgtPaneId)) return;
    s.layout=doSplit(s.layout,tgtPaneId,newPanes,dir);
    if(keepFocus){
      // FR-SKF-1: 저장된 사용자 포커스를 그대로 복원. activeWindow / focused 모두.
      // FR-SKF-3: 저장된 pane 이 사후 layout 에서 사라졌으면 무동작 + 경고.
      if(this.ws.activeWindow!==savedWindow && this.ws.windows.some(x=>x.id===savedWindow)){
        this.ws.activeWindow=savedWindow;
        try{sessionStorage.setItem('activeWindow', savedWindow)}catch{}
      }
      const a=this._aw();
      if(a && savedFocused && findPane(a.layout,savedFocused)){
        this._setFocus(savedFocused, a);
      } else if(savedFocused){
        console.warn('[split] keepFocus: savedFocused pane gone after split, leaving focus as-is');
      }
    } else {
      if(this.ws.activeWindow!==tgtWindowId){
        const cur=this._aw(); if(cur) cur.focusedPane=this.focused;
        this.ws.activeWindow=tgtWindowId;
        try{sessionStorage.setItem('activeWindow', tgtWindowId)}catch{}
      }
      const next = lastR || tgtPaneId;
      this._setFocus(next, s);
      this._focusWindow(tgtWindowId);
    }
    this.render();
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 pane/tab id 반환 (echo 용).
    return {
      panes: newPanes.map(pn=>pn.id),
      tabs: newPanes.map(pn=>({uuid:pn.tabs[0].id, toolId:pn.tabs[0].toolId})),
    };
  },

  _paneNewToolRef(sess,rid){
    const pn=findPane(sess.layout,rid);if(!pn)return {};
    const tab=pn.tabs.find(t=>t.id===this.paneTab(pn));
    if(!tab) return {};
    if(tab.type==='editor' && typeof tab.filePath==='string' && tab.filePath.startsWith('/')){
      const i=tab.filePath.lastIndexOf('/');
      const dir = i>0 ? tab.filePath.substring(0,i) : '/';
      return {cwd: dir};
    }
    const toolId = tab.toolId;
    if (toolId) {
      const p = this.tools.get(toolId);
      if (p) return { cwdTool: toolId };
    }
    return {};
  },
  switchTabPrev(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    const i=pn.tabs.findIndex(t=>t.id===this.paneTab(pn));if(i<0)return;
    this.switchTab(pn.id,pn.tabs[(i-1+pn.tabs.length)%pn.tabs.length].id);
  },
  switchTabNext(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    const i=pn.tabs.findIndex(t=>t.id===this.paneTab(pn));if(i<0)return;
    this.switchTab(pn.id,pn.tabs[(i+1)%pn.tabs.length].id);
  },
  // 순회 키(Ctrl+Shift+[ ])의 **단일 디스패치 지점**이다.
  //
  // GIT_SIDEBAR_TABS_SRS FR-SBT-31/33: 이 키는 활성 사이드바 탭의 목록을 순회한다
  // — Windows 탭이면 창, Git 탭이면 리포. 새 키를 만들지 않고 대상만 바뀐다.
  // cycle 을 제공하지 않는 탭이 활성이면 아무 일도 하지 않는다 (FR-SBT-20).
  //
  _cycleActive(step){
    const d=this._sbTabs.find(t=>t.id===this._sbTab);
    if(!d) return;
    // UX_REVISION_SRS FR-BLP-15: 순회 규약은 블루프린트 한 자리에 있다. 탭마다
    // 자기 순회를 구현하던 때는 같은 규약이라고 적어 두고도 서로 달랐다.
    SidebarList.cycle(this,d,step);
  },
  switchWindowPrev(){this._cycleActive(-1)},
  switchWindowNext(){this._cycleActive(1)},
  //
  // WINDOW_SLOTS_SRS FR-WSL-40·41: 창 안에서 갈 pane 이 없으면 슬롯 경계를 넘는다.
  // **빠져나오는 자리가 셋이고 셋 모두**가 넘침으로 흘러야 한다 (§2.6) — 특히
  // `path.length<2` 는 분할이 없는 창(Git 창 포함)이 타는 자리다. 여기를 빠뜨리면
  // 터미널 창에서는 넘어가는데 Git 창에서는 안 넘어가는 비대칭이 생긴다.
  paneNavigate(dir){
    const s=this._aw();if(!s||!this.focused)return this.slotNavigate(dir);
    const path=s.layout?findPath(s.layout,this.focused):null;
    if(!path||path.length<2)return this.slotNavigate(dir);
    for(let i=path.length-2;i>=0;i--){
      const parent=path[i],child=path[i+1];
      if(parent.type!=='split')continue;
      const isH=parent.direction==='horizontal';
      const ci=parent.children.indexOf(child);
      let ti=-1;
      if(dir==='right'&&isH)ti=ci+1; if(dir==='left'&&isH)ti=ci-1;
      if(dir==='down'&&!isH)ti=ci+1; if(dir==='up'&&!isH)ti=ci-1;
      if(ti>=0&&ti<parent.children.length){
        const target=firstPane(parent.children[ti]);
        if(target){this._setFocus(target.id, s);this._save();this.render();return}
      }
    }
    return this.slotNavigate(dir);
  },
  addTabFocused(){if(this.focused)this.addTab(this.focused,'terminal')},
  closeTabFocused(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    this.closeTab(pn.id,this.paneTab(pn));
  },
  closeWindowActive(){this.delWindow(this.ws.activeWindow)},
});
