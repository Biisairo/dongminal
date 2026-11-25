/**
 * Remote Terminal — main application class
 */
class App {
  constructor(){
    this.tools=new Map();
    // OPTIMIZE_REFACTOR_SRS FR-OPT-4-11 (D-OPT-2): 서버가 아는 살아 있는 도구 id.
    // `tools` 는 **그려진** 도구의 인스턴스(WS 하나씩)이고 숨은 도구는 거기 없다 —
    // 살아 있는가를 묻는 자리(clean·죽은 도구 청소·떠남 확인)는 이것을 본다.
    this.toolIds=new Set();
    // 부팅 스냅숏에 있던 도구 — 처음 그려질 때 재생이 끝날 때까지 가린다.
    this._toolsBoot=new Set();
    this.fileEditors=new Map();
    this.clientId=newUUID();
    /**
     * 시간과 전파의 소유자 (EVENT_TIMER_HUB_SRS §1.2 INV-1·2).
     *
     * **가장 먼저 선다.** 나머지 배선이 전부 이 둘을 딛기 때문이다.
     *
     * 버스는 시간 계층을 **모른다** (C-6 · D-2). 침묵 감시에 타이머가 필요하지만
     * 버스가 그것을 붙들면 순환이 생긴다 — 버스 → 시간 → (콜백) → 버스.
     * 그래서 여기서 **표면만 주입한다**: 버스는 자기가 받은 것이 무엇인지 모른다.
     */
    this.timers=TIMERS;
    this.bus=new EventBus(this,{
      every:(spec)=>this.timers.every(spec),
      after:(ms,fn,o)=>this.timers.after(ms,fn,o),
    });
    this.ws={schemaVersion:WS_SCHEMA_VERSION,windows:[],activeWindow:null};
    this.wsETag=null;
    // FR-WSC-12: **원격이 본 적 있는 창의 id.** 채택이 무엇을 지워도 되는지의
    // 유일한 근거다 (D-6) — 여기 없으면서 원격에도 없는 창은 원격이 한 번도 본
    // 적 없는 창이며, 원격이 지웠을 리 없다.
    this._wsSavedIds=new Set();
    // FR-OPL-2: 같은 판정의 탭 짝. 둘은 `_wsMarkSaved` 가 함께 적는다.
    this._wsSavedTabs=new Set();
    this.focused=null;
    this._attn=new Map(); // toolId → {reason} 주의 상태 집합 (FR-PAN-9/16)
    this._activity=new Map(); // toolId → {state,tool,detail} 활동 상태 (AGENT_ACTIVITY_PANEL_SRS)
    this.kb=false;
    this.windowFocused=typeof document!=='undefined'&&document.hasFocus?document.hasFocus():true;
    this._windowFocusOwner={}; // { windowId: clientId } — per-window focus ownership
    // WINDOW_SLOTS_SRS FR-WSL-2: 슬롯은 클라이언트의 것이다 — workspace 에
    // 새지 않는다. null 이면 단일 슬롯 모드이고 그때의 DOM 은 슬롯 도입 전과
    // 같다 (FR-WSL-4, D-4).
    this._slots=null;          // 칸별 신원·구독은 `SlotsController` 가 든다 (REFACTOR3_FE_APPCTL_SRS 9h)
    this.drag=null;
    this._stats={};this._latency=null;
    this.mPaneIdx=0; // mobile current pane index (volatile)
    this.drawerOpen=false;
    this._bg=[]; // 백그라운드 도구 목록 (FR-BG-6)
    this.modKbd=null; // {ctrl:bool|'lock', alt:bool|'lock'}
    this.gitRepos=null; // GIT 섹션 목록 {follow,pinned} (FR-GIT-13)
    this._lastPlainWindow=null; // Open File 이 돌아갈 일반 창 (FR-GIT-185, O15)
    this._lastTermTool=null;    // follow 가 딛는 마지막 터미널 (FR-GIT-210)
    this._gitOff=false; // git 표면이 503 이면 섹션 전체를 숨긴다
    // Editor 탭 (EDITOR_TAB_SRS 묶음 T·E). 목록의 권위는 서버다 (FR-EDT-20).
    this.editors=null; // {home,list[]} — 첫 응답 전에는 null (FR-EDT-29)
    this._edOff=false;  // /api/editors 가 실패하면 탭 자체를 숨긴다 (FR-EDT-120)
    this._lastEditorWindow=null; // Editor 탭이 돌아갈 창 (FR-EDT-7)
    // 사이드바 탭 (GIT_SIDEBAR_TABS_SRS §3.9.2). 활성 탭은 클라이언트의 것이다 (D-1).
    this.sbTab=SidebarTabs.restore();
    this.sbBusy=false; // FR-SBT-14 ↔ 22 의 재진입 가드
    // 주제별 조정자 (REFACTOR3_FE_APPCTL_SRS FR-FEA-1). 생성자에서 선다 — 부팅의 `_settingsApply`(`main.js`)는
    // 설정창(`initModal`)보다 먼저 올 수 있고(순서 무관, QUALITY_FIX_SRS FR-QFX-9), 간선·판 확인의 복원은 구독이 열리자마자 온다.
    this.settings=new SettingsController(this);
    this.edges=new EdgesController(this);
    this.update=new UpdateController(this);
    this.attn=new AttnController(this);
    this.claude=new ClaudeAccountsController(this);
    this.statusbar=new StatusBarController(this);
    this.chat=new ChatController(this);
    this.agents=new AgentsController(this);
    this.mobile=new MobileController(this);
    this.git=new GitController(this);
    this.wsSync=new WsSyncController(this);
    this.wsSave=new WsSaveController(this);
    this.focus=new FocusController(this);
    this.slot=new SlotsController(this);
    this.layout=new LayoutController(this);
    this.tool=new ToolController(this);
    this.editor=new EditorController(this);
    this.repoWin=new RepoWinController(this);
    this.renderer=new Renderer(this);
    this.inputBinding=new InputBinding(this);
  }

  // ── Mobile mode ──

  // displayMode / mobileBreakpoint are per-tab (sessionStorage), NOT synced via workspace.
  get displayMode(){
    const v=PrefStore.session.get(STORE_KEYS.displayMode);
    return (v==='mobile'||v==='desktop'||v==='auto')?v:'auto';
  }
  set displayMode(v){
    if(v!=='mobile'&&v!=='desktop'&&v!=='auto') v='auto';
    PrefStore.session.set(STORE_KEYS.displayMode,v);
  }
  get mobileBreakpoint(){
    const v=parseInt(PrefStore.session.get(STORE_KEYS.mobileBreakpoint),10);
    return (v>=320&&v<=2000)?v:768;
  }
  set mobileBreakpoint(v){
    const n=parseInt(v,10);
    if(!(n>=320&&n<=2000)) return;
    PrefStore.session.set(STORE_KEYS.mobileBreakpoint,n);
  }
  get isMobile(){
    const m=this.displayMode;
    if(m==='mobile') return true;
    if(m==='desktop') return false;
    if(window.innerWidth < this.mobileBreakpoint) return true;
    // MOBILE_UX_OVERHAUL_SRS FR-MUX-60: 가로로 돌린 휴대폰은 폭이 기준을 넘는다. 손가락으로 쓰는
    // 낮은 화면이면 폭과 무관하게 모바일이다 — 태블릿(높이가 넉넉하다)과 마우스 기기는 종전대로다.
    return window.innerHeight < MOBILE_LANDSCAPE_MAX_H
      && typeof matchMedia==='function' && matchMedia('(pointer:coarse)').matches;
  }

  // 분할 트리 → pane 배열 (L→R, T→B). 순회는 `panesOf` 한 벌이다 (FR-OPT-11-1 · FEC-21) —
  // 이 이름은 호출처와 e2e 계약(app.testing)을 위해 남는다.
  flattenPanes(node){ return panesOf(node) }
  // 화면 묶음을 싣는다 (PERF D-30). `app.testing.loadScreen(name)` — 화면을 열기 전에 그 전역을 부르는 e2e 가 먼저 기다린다.
  loadScreen(name){ return Screens.load(name) }

  /**
   * TOOL_LIST_UNKNOWN_SRS FR-TLU-9: 첫 화면은 **도구를 아는 스냅숏**으로 세운다.
   *
   * 데몬에 다시 붙는 창에 걸리면 `/api/state` 는 도구를 모른다고 답한다. 뒤이은
   * 경로는 SSE 가 다음 `workspace_changed` 를 날라 스스로 회복하지만, 첫 화면에는
   * 그 보증이 없다 — 모른 채로 진행하면 사용자는 탭이 사라진 화면을 먼저 본다.
   *
   * 상한을 두는 이유는 데몬이 영영 돌아오지 않는 경우에도 화면은 서야 하기
   * 때문이다. 그때는 아는 것으로 진행하며, 그 뒤의 회복은 SSE 의 몫이다.
   */
  async _fetchStateKnown(){
    // 봉투는 본문을 이미 읽어 두었다 (FR-CAPI-4) — 종전의 `res.clone()` 이
    // 필요 없어졌다. `Response` 의 본문이 한 번뿐이라 복제하던 자리다.
    let res=await apiGet('/api/state');
    for(let i=0;i<STATE_UNKNOWN_RETRIES;i++){
      if(!res.ok||!res.data) return res;
      if(res.data.toolsKnown!==false) return res;
      await this.timers.sleep(STATE_UNKNOWN_RETRY_MS,{owner:'app',label:'state-retry'});
      res=await apiGet('/api/state');
    }
    return res;
  }

  async init(){
    // OS focus listeners go up before any async work — a `focus` event during
    // init must still claim the active window.
    this.focus._initFocusSync();
    // F-4: 서버 상수(이름 상한 등)를 받는다. 부팅을 기다리게 하지 않는다 — 받기 전에는
    // 자르지 않을 뿐이다.
    apiGet(META_API).then(r=>{if(r.ok) applyServerMeta(r.data)});
    // FR-EDT-120·43: Editor 표면을 **워크스페이스 처리보다 먼저** 확정한다.
    // 재조정과 편집기 탭 마이그레이션이 둘 다 `home` 을 알아야 돌 수 있고,
    // 모르면 둘 다 돌지 않는 것이 옳다 — 추측한 홈으로 만든 창은 나중에 서버가
    // 알려준 홈과 어긋난 채로 남는다.
    const edReady=this.editor.sync._edLoad();
    try{
      await this._initAdoptWorkspace(edReady);
    }catch(e){
      console.error('[App] init error:',e);
      // FR-SFD-22: 여기서 세우는 창은 **화면을 위한 것**이다. 이 판이 디스크로
      // 나가면 사용자의 창·탭이 그것으로 덮인다 (`FE-2`, P0).
      this._bootFailed=true;
      if(!this.ws.windows.length) await this.layout._mkWindow();
    }
    this._initRestoreSession();
    // FR-WSL-2·7: 슬롯 복원은 activeWindow 복원 **뒤**다 — 포커스 슬롯의 창이
    // activeWindow 를 덮는다 (FR-WSL-3). 워크스페이스에 없는 창 id 는 그 슬롯만
    // 비운다.
    this.slot._slotsRestore();
    this.agents._pruneAgentOrder();
    const a=this.tool.life.aw();
    if(a&&a.layout){const saved=a.focusedPane;const f=(saved&&findPane(a.layout,saved))?{id:saved}:firstPane(a.layout);if(f)this.focus.setFocusState(f.id, a)}
    this.render();
    this._bind();
    this.wsSync._subscribeCommands();
    // Initial window claim: only if window has focus AND no other window
    // already owns this window (prevents init-time claim races).
    if(document.hasFocus&&document.hasFocus()){
      const sid=this.ws.activeWindow;
      if(sid && !this._windowFocusOwner[sid]){
        this.focus.owner._focusWindow(sid);
      }
    }
    this.focus.owner.applyFocusOverlay();
    this.git._initGitSection();
    this.editor.section._initEditorSection();
    // FR-SRL-8·9: 내부 새로고침의 진입점 둘. 배선은 `_subscribeCommands` **뒤**
    // 여야 한다 — 그것이 채널(`app.channel`)을 세운다.
    this.wsSync.reload._initSoftReload();
    // FR-WSL-50: 슬롯 토글 버튼. 다른 `_init*` 과 같은 자리다 (방향 설정은 `DisplaySection`).
    this.slot.ops._initSlots();
  }

  // 부팅의 워크스페이스 채택 — 서버 스냅숏을 받아 정규화하고, 창이 없으면 세운다.
  async _initAdoptWorkspace(edReady){
    const stRes=await this._fetchStateKnown();
    this.wsETag=this.wsSave._etagOf(stRes);
    const st=stRes.data||{};
    const sp=st.tools||[];
    const sv=st.workspace;
    const ok=new Set(sp.map(p=>p.id));
    // FR-OPT-4-11 (D-OPT-2): 여기서는 id 만 적는다. 인스턴스와 WS 는 처음 그려질 때
    // 선다(`mkTool`, renderer-pane) — 숨은 도구는 붙지 않는다.
    for(const p of sp){this.toolIds.add(p.id);this._toolsBoot.add(p.id)}
    // OPTIMIZE_REFACTOR_SRS FR-OPT-4-5: 첫 화면의 전경 이름은 이 목록에서 온다 — 첫
    // 구독이 같은 목록을 다시 받지 않는다. 모르는 목록으로는 얹지 않는다 (FR-TLU-7).
    if(st.toolsKnown!==false) this.wsSync._fgApply(sp);
    await edReady;
    // **창이 없어도 서버가 소유한 키는 채택한다.**
    //
    // 아래 분기는 `sv.windows.length` 가 0 이면 서버 스냅샷을 통째로 버린다.
    // 그런데 `git.pinned`·`editors.list` 는 **창과 무관하게 서버가 권위**이고
    // (FR-EDT-20, FR-GIT-31), 창이 아직 없는 워크스페이스에도 들어 있다.
    // 버린 채로 `_mkWindow()`·재조정이 `save()` 를 부르면 그 PUT 이 두 키를
    // **지운다** — 핀을 걸어 둔 채 브라우저를 처음 열면 핀이 사라졌다(실측).
    if(sv){
      if(sv.git) this.ws.git=sv.git;
      if(sv.editors) this.ws.editors=sv.editors;
      // FR-WSC-12: 첫 로드도 원격이 아는 창을 알려 주는 자리다. 비어 있으면
      // 비어 있는 것이 사실이며, 그 뒤 우리가 만드는 창은 전부 "원격이 본 적
      // 없는 창" 이다.
      this.wsSave._wsMarkSaved(sv.windows);
    }
    // REPO_SIDE_WIDTH_SRS FR-RSW-5: 마이그레이션이 무언가 옮겼는지. 저장은 아래
    // 재조정의 `save()` 와 겹치므로 여기서는 표시만 든다.
    let sideWidthMoved=false;
    if(sv&&sv.windows&&sv.windows.length){
      this.ws=sv;
      // FR-UXB-8: 폭은 걷어내기만 한다 — 치수는 창의 것이다 (D-UXB-1). 화면에
      // 세우는 일은 하지 않는다: 첫 페인트 스크립트가 이 창의 값으로 이미 세웠고,
      // 서버의 값이 그것을 덮으면 다른 기기에서 끈 폭이 이 화면에 강제된다.
      sideWidthMoved=this.layout.winState._stripDeviceKeys();
      // FR-OPT-11-1 (FEC-17): 원격 채택과 같은 한 벌이다.
      if(this.layout.winState._normalizeIncomingWorkspace(this.ws,ok)) this.wsSave.save();
      this.layout.winState._fallbackActiveWindow(this.ws);
    }
    // 일반 창 하나는 늘 있어야 한다 — Editor 창만 남기고 사용자를 그 안에
    // 가두지 않는다 (FR-CLS-2 와 같은 근거). **재조정보다 먼저** 한다: 창
    // 목록의 순서가 곧 사이드바의 순서이고, 사용자가 만든 적 없는 Editor 창이
    // 그 앞자리를 차지할 이유가 없다.
    if(!this.git.plainWindows().length) await this.layout._mkWindow();
    // FR-EDT-42·43: 재조정이 도는 첫 번째 자리. 워크스페이스가 비어 있어도
    // root 에디터 창은 있어야 한다 (FR-EDT-13).
    if(this.editor.sync._edReconcile()||sideWidthMoved) this.wsSave.save();
  }

  // Restore per-window activeWindow from sessionStorage (survives refresh).
  // Only apply if the window still exists in the loaded workspace.
  _initRestoreSession(){
    const saved=PrefStore.session.get(STORE_KEYS.activeWindow);
    if(saved && this.ws.windows.some(s=>s.id===saved)){
      this.layout.winState._activateWindow(saved);
    }else{
      /**
       * REPO_TAB_UNIFY_SRS D-RTU-18: **Repo 창의 신원은 id 가 아니라 루트다.**
       *
       * 그 창은 `editors.list` 에서 **재조정이 만든다** (FR-EDT-42) — 저장이
       * 아직 서버에 닿지 않았거나 다른 브라우저가 쓴 워크스페이스를 처음 읽으면
       * 같은 루트의 창이 **새 id 로** 선다. 그때 id 만 보면 사용자가 보던 창을
       * 찾지 못하고 폴백이 엉뚱한 일반 창을 고른다 (실측: 새로고침 뒤 Repo 탭이
       * `Windows` 로 돌아갔다, V-SBT-4).
       *
       * 그래서 루트로 한 번 더 찾는다. 사용자에게 같은 저장소의 창은 같은 창이다.
       */
      const root=PrefStore.session.get(ACTIVE_EDITOR_ROOT_KEY);
      const w=root?this.editor.edWindowFor(root):null;
      if(w) this.layout.winState._activateWindow(w.id);
    }
    // FR-RLC-8: 사이드바 탭이 돌아갈 창의 기억도 같은 성질이다 — 같은 블록에서
    // 되살린다.
    this.layout._restoreReturn();
    // Restore per-window focusedPane for each window from sessionStorage.
    const map=PrefStore.session.json(STORE_KEYS.focusedPanes,null);
    if(map&&typeof map==='object'){
      for(const s of this.ws.windows){
        const rid=map[s.id];
        if(rid && s.layout && findPane(s.layout, rid)) s.focusedPane=rid;
      }
    }
  }

  // e2e 계약(app.testing)에 남은 옛 이름. 제품 코드는 `panesOf` 를 쓴다.
  _collectPanes(n, out){ out.push(...panesOf(n)) }

  // FR-WSL-20: 슬롯을 명시하지 않으면 슬롯 0 이다 — 단일 슬롯 모드의 호출부가
  // 한 글자도 바뀌지 않아야 한다. 같은 도구를 두 슬롯에 그리면 인스턴스가 둘이고
  // 붙음도 둘이다 (§7 R-1, 회수는 _slotReap). PERF D-16: 여기서 붙지 않는다 — 처음 보일 때
  // 렌더러가 `wake()` 를 부른다.
  mkTool(id,name,slot){
    const key=this.slot.slotKey(id,slot||0);
    if(this.tools.has(key)) return this.tools.get(key);
    const p=new TerminalTool(id,name);
    p._slot=slot||0;
    this.toolIds.add(id);
    if(this._toolsBoot.delete(id)){p._reconnecting=true;p.el.style.opacity='0'}
    document.getElementById('area').appendChild(p.el);
    this.tools.set(key,p);
    this.focus.owner.applyFocusOverlay();
    return p;
  }

  // 슬롯을 모르는 호출부의 조회. 포커스 슬롯을 먼저 보고, 없으면 다른 슬롯의
  // 인스턴스를 준다 — 슬롯 1 에만 있는 창의 도구도 검색·상태바에서 닿아야 한다.
  // FR-SAF-17·18: 순서는 **포커스 칸 → 칸 0 → 나머지 오름차순**이다 (지금의
  // 의도 그대로). 종전에는 마지막 갈래가 `slotKey(id,1)` 하나뿐이라, 슬롯 2·3
  // 에만 있는 도구가 상태바 `termsize`·검색·전경 이름 갱신에서 조용히 null 이
  // 됐다.
  toolAny(id){
    if(!id) return null;
    const f=this.slot.slotFocused();
    const first=this.tools.get(this.slot.slotKey(id,f));
    if(first) return first;
    for(const k of this.slot.slotKeysOf(id)){
      const p=this.tools.get(k);
      if(p) return p;
    }
    return null;
  }

  // ── Tool Attention Notify (PANE_ATTENTION_NOTIFY_SRS) ──

  // 설정 영속화는 localStorage(per-device), 기존 /api/settings 스키마 무변경 (FR-PAN-14)
  // 데스크톱 알림은 기본 ON(권한 허용 시 동작) — '0' 으로 명시 비활성만 끈다 (FR-PAN-13a)
  get attnDesktop(){return PrefStore.local.bool(STORE_KEYS.attnDesktop,true)}
  set attnDesktop(v){PrefStore.local.setBool(STORE_KEYS.attnDesktop,v)}
  /**
   * 알림음 (`TLS-1`, PRODUCTION_ROADMAP §M5).
   *
   * **기본값이 환경에 따라 갈린다.** 평문 HTTP 로 접속하면
   * `window.isSecureContext` 가 거짓이고, 그때 브라우저는 `Notification` 을
   * 통째로 막는다 — 데스크톱 알림이 **조용히** 죽어 있다는 뜻이다. 사용자는
   * 토글을 켜 두고도 아무 알림을 받지 못한다.
   *
   * 이 제품은 **TLS 를 제공하지 않는다**(로드맵 결정 9 — 기밀성은 오버레이 망에
   * 위임한다). 그러므로 "HTTPS 로 접속하세요" 는 제시할 수 없는 길이다. 남는
   * 조치는 **표시와 대체 수단**뿐이고, 그 대체 수단의 하나가 이것이다.
   *
   * **사용자가 끄면 그 선택이 우선이다.** 저장된 값이 있으면 그것을 따르고,
   * 갈리는 것은 "정한 적 없음" 의 해석뿐이다 — `attnDesktop` 이 `'0'` 명시만
   * 끄는 것과 같은 규약이다.
   */
  get attnSound(){
    const v=PrefStore.local.get(STORE_KEYS.attnSound);
    if(v!==null) return v==='1';
    return !window.isSecureContext;
  }
  set attnSound(v){PrefStore.local.setBool(STORE_KEYS.attnSound,v)}
  /**
   * 데스크톱 알림이 이 환경에서 **동작할 수 있는가** (`TLS-1`).
   *
   * 둘을 가른다: 권한을 받지 못한 것(사용자가 고칠 수 있다)과 브라우저가 아예
   * 막은 것(사용자가 고칠 수 없다). 뒤의 것에 "권한을 허용하세요" 를 안내하면
   * 사용자는 없는 설정을 찾아 헤맨다.
   */
  get attnDesktopBlocked(){
    return !window.isSecureContext||typeof Notification==='undefined';
  }
  /**
   * 앱 action 을 실행한다. 표는 처음 부를 때 한 번 세운다 (FR-OPT-11-7 · FEC-36) — 종전에는
   * 키 입력마다 클로저 30여 개짜리 맵을 새로 만들었다.
   */
  executeAction(action){
    const map=this._actionMap||(this._actionMap=this._buildActionMap());
    return Object.hasOwn(map,action)?map[action]():undefined;
  }

  _buildActionMap(){
    const map={
      // FR-M9-24·25 · UX_BATCH12_SRS FR-RTR-13a: 뒤로·앞으로 버튼과 **같은 함수**를 부른다.
      focusBack:()=>this.focus.navBack(),focusForward:()=>this.focus.navForward(),
      tabReopen:()=>this.layout.reopen.tabReopen(),
      windowNext:()=>this.layout.tabOps.switchWindowNext(),windowPrev:()=>this.layout.tabOps.switchWindowPrev(),
      tabNext:()=>this.layout.tabOps.switchTabNext(),tabPrev:()=>this.layout.tabOps.switchTabPrev(),
      paneUp:()=>this.layout.tabOps.paneNavigate('up'),paneDown:()=>this.layout.tabOps.paneNavigate('down'),
      paneLeft:()=>this.layout.tabOps.paneNavigate('left'),paneRight:()=>this.layout.tabOps.paneNavigate('right'),
      splitH:()=>this.layout.tabOps.split('horizontal'),splitV:()=>this.layout.tabOps.split('vertical'),
      newWindow:()=>this.layout.addWindow().catch(err=>this.tool._notify(errText(t('core.open_window_fail'),err))),
      newTab:()=>this.layout.tabOps.addTabFocused(),
      closeWindow:()=>this.layout.tabOps.closeWindowActive(),closeTab:()=>this.layout.tabOps.closeTabFocused(),
      // FR-PSC-3 · FR-CHR-15 (D-7): 버튼과 **같은 함수**다.
      agentsToggle:()=>this.agents.list.actPanelOpen(),
      // FR-WSL-51·74: 버튼과 **같은 함수**를 부른다. 여는 길이 둘로 갈리면
      // 한쪽만 고쳐진다.
      slotAdd:()=>this.slot.ops.slotAdd(),
      slotRemove:()=>this.slot.ops.slotRemove(),
      // FR-WSL-56: 손잡이 클릭과 같은 길이다 (`slotFocusTo`).
      slotPrev:()=>this.slot.ops.slotNav(-1),
      slotNext:()=>this.slot.ops.slotNav(1),
      // FR-PSC-3: 버튼 클릭과 **같은 함수**를 부른다. 여는 길이 둘로 갈리면
      // 한쪽만 고쳐진다.
      bgToggle:()=>this.statusbar._bgPanelOpen(),
      runsToggle:()=>this.runsPanel()._runsModalToggle(),
      // FR-SBC-7a: 손잡이 드래그와 같은 함수다 (input-binding).
      sidebarToggle:()=>this.layout.tabOps._toggleSidebar(),
      // FR-SRL-9: 다른 앱 단축키와 **같은 길**을 탄다 — 설정에서 바꿀 수 있고,
      // 터미널보다 앞서는 우선순위도 그 체계가 준다 (shortcuts.md).
      softReload:()=>this.wsSync.reload.softReload(),
      // UX-22: 설정 버튼과 **같은 길**로 열고 Shortcuts 탭으로 간다.
      shortcutsHelp:()=>this.settings._openSettings('shortcuts'),
      toggleSearch:()=>this.tool.search.toggleSearch(),
      // FR-EKB-5: 키 배선과 **같은 함수**를 부른다. 둘 다 Editor 창이 아니면
      // 스스로 아무 일도 하지 않으므로 여기에 가드를 겹치지 않는다.
      edGotoDef:()=>this.lspClient()?._lspGotoDef(),
      edFindRefs:()=>this.lspClient()?._lspFindRefs(),
      edFindInFile:()=>this.editor.search._edFindInFile(),
      edGotoLine:()=>this.editor.search._edGotoLine(),
      edQuickOpen:()=>this.editor.search._edQuickOpen(),
      edGrep:()=>this.editor.search._edSearchOpen(),
    };
    // FR-SBT-21·26: 직행 키는 서술자 배열에서 파생한다 — 탭이 늘어도 이 맵을
    // 손으로 늘리지 않는다.
    for(let i=0;i<SB_TAB_DEFS.length&&i<SB_JUMP_MAX;i++) map[sbTabAction(i)]=()=>this._sbJumpTo(i+1);
    return map;
  }

  rename(obj, el){
    const old = obj.name;
    const input = document.createElement('input');
    input.type = 'text'; input.value = old; input.className = 'rename-input';
    el.replaceWith(input); input.focus(); input.select();
    const done = () => {
      const v = input.value.trim();
      // FUI-18: 창 이름도 만들 때와 같은 상한을 지난다.
      if(v && v !== old) { obj.name = clampEntityName(v); this.wsSave.save(); }
      // 이름 요소를 되돌린다. 이름이 그대로면 행의 서명도 그대로라 다시 그리기가 행을
      // 새로 만들지 않는다 — 되돌리지 않으면 편집칸이 남는다.
      input.replaceWith(el);
      this.render();
    };
    input.addEventListener('blur', done, {once:true});
    input.addEventListener('keydown', e => {
      if(e.key==='Enter'){e.preventDefault();input.blur()}
      if(e.key==='Escape'){input.value=old;input.blur()}
    });
  }

  // ── 사이드바 탭 (GIT_SIDEBAR_TABS_SRS §3.9.2, 위임) ──

  // 지금 보이는 탭들. 배열 순서가 표시 순서다 (FR-SBT-18).
  get _sbTabs(){ return SidebarTabs.visible(this) }
  _sbSetTab(id){ SidebarTabs.setTab(this,id) }
  sbSyncTabToWindow(){ SidebarTabs.syncToWindow(this) }
  _sbUpdateBadges(){ SidebarTabs.updateBadges(this) }
  _sbJumpTo(n){ SidebarTabs.jumpTo(this,n) }

  // ── Render (위임) ──

  // FR-SVS-61: 미뤄 둔 그리기가 있으면 이 그리기가 그것을 대신한다 — 지연은
  // "클릭을 삼키지 않기" 위한 것이지 그리기를 빼먹기 위한 것이 아니다.
  // EDITOR_LIVE_RELOAD_SRS FR-ELR-66: 창·탭·사이드가 바뀌면 감시 집합도 바뀐다.
  render(){ this._slotRenderPending=false; this.renderer.render(); this.agents.agentsRender(); this.editor.watch.edWatchSync(); this.focus.hl.focusHighlightSync(); this.focus.hl.attnFocusSync() }


  _bind(){ this.inputBinding.bind() }

  // ── 코드 탐색·Run 시각화 (위임) — 본체는 `lsp-client.js`·`lsp-paths.js` 의 `LspClient` 와 `ui/runs-panel.js` 의
  // `RunsPanel` 이다 (APP_STATE_EXTRACT_SRS FR-ASE-7·묶음 A, REFACTOR3_FE_APPCTL_SRS 9a 에서 옛 `app-lsp.js`·`app-runs.js`).

  // 코드 탐색을 한 번도 쓰지 않은 브라우저는 만들지 않는다 (`runsPanel` 과 같은 규약). 본체는 cm 묶음이라 실리기 전에는
  // null 이다 (PERF 3.4.12.7). 편집기·Diff 는 cm 이 선 뒤에만 서므로 그 안의 호출은 늘 본체를 받는다.
  lspClient(){
    if(!this._lsp){
      if(!Screens.ready('cm')) return null;
      this._lsp=new LspClient(this);
    }
    return this._lsp;
  }

  // Run 을 한 번도 열지 않은 브라우저는 만들지 않는다 (`gitObs` 와 같은 규약).
  runsPanel(){
    if(!this._runs) this._runs=new RunsPanel(this);
    return this._runs;
  }

  // 상태 등록부 `run.list` 의 복원 (ACTIVITY_RUNS_REFRESH_SRS FR-ARR-3).
  _runsListRestore(){ return this.runsPanel()._runsRefresh() }
  // 채널 `runs` 토픽의 목록 (PERF M1 C3). Run 을 한 번도 열지 않은 브라우저에는 `RunsPanel` 을
  // 만들지 않는다 — 열 때 목록을 받는다.
  _runsListApply(list){ if(this._runs) this._runs._runsApplyList(list) }
  // 상태 등록부 `run.views` 의 복원 (RUN_VIEW_LIVE_SRS FR-RLV-7).
  _runViewsRestore(){ if(this._runs) this._runs._runViewsRefresh() }
  _onRunMemberActivity(args){ if(this._runs) this._runs._onMemberActivity(args) }
}
