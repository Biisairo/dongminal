/**
 * Remote Terminal — main application class
 */
class App {
  constructor(){
    this.tools=new Map();
    this.fileEditors=new Map();
    this.clientId=newUUID();
    this.ws={schemaVersion:2,windows:[],activeWindow:null};
    this.wsETag=null;
    this.focused=null;
    this._attn=new Map(); // toolId → {reason} 주의 상태 집합 (FR-PAN-9/16)
    this._attnNotifs={}; // toolId → Notification (재팝업 위해 직전 알림 보관)
    this._activity=new Map(); // toolId → {state,tool,detail} 활동 상태 (AGENT_ACTIVITY_PANEL_SRS)
    this._kb=false;
    this._windowFocused=typeof document!=='undefined'&&document.hasFocus?document.hasFocus():true;
    this._windowFocusOwner={}; // { windowId: clientId } — per-window focus ownership
    // WINDOW_SLOTS_SRS FR-WSL-2: 슬롯은 클라이언트의 것이다 — workspace 에
    // 새지 않는다. null 이면 단일 슬롯 모드이고 그때의 DOM 은 슬롯 도입 전과
    // 같다 (FR-WSL-4, D-4).
    this._slots=null;
    this._slotIds=[];          // 칸별 clientId. [0] 은 this.clientId 를 쓴다 (FR-WSL-10)
    this._slotSse=[];          // 칸 1.. 의 소유권을 살려 두는 구독들 (FR-WSL-11)
    this._drag=null;
    this._stats={};this._latency=null;
    this._mPaneIdx=0; // mobile current pane index (volatile)
    this._drawerOpen=false;
    this._bg=[]; // 백그라운드 도구 목록 (FR-BG-6)
    this._bgModalOpen=false;
    this._bgModalKey=null; // 모달 Esc 핸들러 (열려 있을 때만 부착)
    this._modKbd=null; // {ctrl:bool|'lock', alt:bool|'lock'}
    this._gitRepos=null; // GIT 섹션 목록 {follow,pinned} (FR-GIT-13)
    this._lastPlainWindow=null; // Open File 이 돌아갈 일반 창 (FR-GIT-185, O15)
    this._lastTermTool=null;    // follow 가 딛는 마지막 터미널 (FR-GIT-210)
    this._gitOff=false; // git 표면이 503 이면 섹션 전체를 숨긴다
    // Editor 탭 (EDITOR_TAB_SRS 묶음 T·E). 목록의 권위는 서버다 (FR-EDT-20).
    this._editors=null; // {home,list[]} — 첫 응답 전에는 null (FR-EDT-29)
    this._edOff=false;  // /api/editors 가 실패하면 탭 자체를 숨긴다 (FR-EDT-120)
    this._lastEditorWindow=null; // Editor 탭이 돌아갈 창 (FR-EDT-7)
    // 사이드바 탭 (GIT_SIDEBAR_TABS_SRS §3.9.2). 활성 탭은 클라이언트의 것이다 (D-1).
    this._sbTab=SidebarTabs.restore();
    this._sbBusy=false; // FR-SBT-14 ↔ 22 의 재진입 가드
    this.renderer=new Renderer(this);
    this.inputBinding=new InputBinding(this);
  }

  // ── Mobile mode ──

  // displayMode / mobileBreakpoint are per-tab (sessionStorage), NOT synced via workspace.
  get displayMode(){
    try{const v=sessionStorage.getItem('displayMode');if(v==='mobile'||v==='desktop'||v==='auto')return v}catch{}
    return 'auto';
  }
  set displayMode(v){
    if(v!=='mobile'&&v!=='desktop'&&v!=='auto') v='auto';
    try{sessionStorage.setItem('displayMode', v)}catch{}
  }
  get mobileBreakpoint(){
    try{const v=parseInt(sessionStorage.getItem('mobileBreakpoint'),10);if(v>=320&&v<=2000)return v}catch{}
    return 768;
  }
  set mobileBreakpoint(v){
    const n=parseInt(v,10);
    if(!(n>=320&&n<=2000)) return;
    try{sessionStorage.setItem('mobileBreakpoint', String(n))}catch{}
  }
  get isMobile(){
    const m=this.displayMode;
    if(m==='mobile') return true;
    if(m==='desktop') return false;
    return window.innerWidth < this.mobileBreakpoint;
  }

  // Flatten split tree → array of pane nodes (in-order: L→R, T→B)
  _flattenPanes(node, out){
    out = out || [];
    if(!node) return out;
    if(node.type==='pane') out.push(node);
    else if(node.type==='split' && node.children){
      for(const c of node.children) this._flattenPanes(c, out);
    }
    return out;
  }

  async init(){
    // OS focus listeners go up before any async work — a `focus` event during
    // init must still claim the active window.
    this._initFocusSync();
    // FR-EDT-120·43: Editor 표면을 **워크스페이스 처리보다 먼저** 확정한다.
    // 재조정과 편집기 탭 마이그레이션이 둘 다 `home` 을 알아야 돌 수 있고,
    // 모르면 둘 다 돌지 않는 것이 옳다 — 추측한 홈으로 만든 창은 나중에 서버가
    // 알려준 홈과 어긋난 채로 남는다.
    const edReady=this._edLoad();
    try{
      const stRes=await fetch('/api/state');
      this.wsETag=stRes.headers.get('ETag')||stRes.headers.get('Etag')||null;
      const st=await stRes.json();
      const sp=st.tools||[];
      const sv=st.workspace;
      const ok=new Set(sp.map(p=>p.id));
      for(const p of sp){const pane=this._mkTool(p.id,p.name);pane._reconnecting=true;pane.el.style.opacity='0'}
      await edReady;
      // **창이 없어도 서버가 소유한 키는 채택한다.**
      //
      // 아래 분기는 `sv.windows.length` 가 0 이면 서버 스냅샷을 통째로 버린다.
      // 그런데 `git.pinned`·`editors.list` 는 **창과 무관하게 서버가 권위**이고
      // (FR-EDT-20, FR-GIT-31), 창이 아직 없는 워크스페이스에도 들어 있다.
      // 버린 채로 `_mkWindow()`·재조정이 `_save()` 를 부르면 그 PUT 이 두 키를
      // **지운다** — 핀을 걸어 둔 채 브라우저를 처음 열면 핀이 사라졌다(실측).
      if(sv){
        if(sv.git) this.ws.git=sv.git;
        if(sv.editors) this.ws.editors=sv.editors;
      }
      if(sv&&sv.windows&&sv.windows.length){
        this.ws=sv;
        // Migration: displayMode/mobileBreakpoint were briefly stored in workspace.
        // Now per-device (localStorage); strip from synced state.
        if('displayMode' in this.ws) delete this.ws.displayMode;
        if('mobileBreakpoint' in this.ws) delete this.ws.mobileBreakpoint;
        if(this.ws.sidebarWidth){
          const w=Math.max(100,Math.min(400,this.ws.sidebarWidth));
          document.documentElement.style.setProperty('--sb-w',w+'px');
          try{localStorage.setItem('sidebarWidth',w)}catch{}
        }
        for(const s of this.ws.windows){
          if(!s||!s.id) continue;
          s.layout=clean(s.layout,ok);
          if(s.layout) normalizeLayout(s.layout);
        }
        // FR-EDT-49 / D-13: **layout 이 없는 Editor 창은 지워지지 않는다.**
        // 갓 만든 Editor 창은 pane 이 없고(FR-EDT-55) 그것이 정상이다 — 이
        // 예외가 없으면 다음 `workspace_changed` 한 번에 사라진다 (§2.4).
        this.ws.windows=this.ws.windows.filter(s=>s&&(s.layout||this._isEditorWin(s)));
        // FR-GIT-186: 개정 이전에 Git 창 안에 들어간 탭을 일반 창으로 옮긴다.
        this._migrateGitWindow();
        // FR-EDT-103·104 / D-19: 일반 창에 남은 편집기 탭을 걷어낸다. `clean()`
        // 이 아니라 여기다 — `clean` 은 편집기 탭을 보존하도록 만들어져 있고
        // 창 타입을 알지 못한다 (§2.9).
        if(this._migrateEditorTabs()){
          // FR-EDT-105: 탭이 0이 된 pane 은 붕괴하고, layout 이 빈 **일반** 창은
          // 사라진다. Editor 창은 위 필터와 같은 예외로 남는다.
          this.ws.windows=this.ws.windows.filter(s=>s&&(s.layout||this._isEditorWin(s)));
          this._save();
        }
        // FR-EDT-45 (FR-CLS-1 과 같은 근거): 활성 창의 폴백은 Editor 창이 아니다.
        // `_save()` 가 activeWindow 를 싣지 않으므로 다른 브라우저가 만든
        // 워크스페이스를 처음 읽을 때 이 자리가 늘 도는데, 배열의 첫 자리를
        // 그대로 쓰면 아무 조작도 하지 않은 사용자가 편집기 화면에 떨어진다.
        if(!this.ws.windows.find(s=>s.id===this.ws.activeWindow))
          this.ws.activeWindow=(this.ws.windows.find(s=>!this._isEditorWin(s))||this.ws.windows[0])?.id||null;
      }
      // 일반 창 하나는 늘 있어야 한다 — Editor 창만 남기고 사용자를 그 안에
      // 가두지 않는다 (FR-CLS-2 와 같은 근거). **재조정보다 먼저** 한다: 창
      // 목록의 순서가 곧 사이드바의 순서이고, 사용자가 만든 적 없는 Editor 창이
      // 그 앞자리를 차지할 이유가 없다.
      if(!this._plainWindows().length) await this._mkWindow();
      // FR-EDT-42·43: 재조정이 도는 첫 번째 자리. 워크스페이스가 비어 있어도
      // root 에디터 창은 있어야 한다 (FR-EDT-13).
      if(this._edReconcile()) this._save();
    }catch(e){
      console.error('[App] init error:',e);
      if(!this.ws.windows.length) await this._mkWindow();
    }
    // Restore per-window activeWindow from sessionStorage (survives refresh).
    // Only apply if the window still exists in the loaded workspace.
    try{
      const saved=sessionStorage.getItem('activeWindow');
      if(saved && this.ws.windows.some(s=>s.id===saved)){
        this.ws.activeWindow=saved;
      }
      // Restore per-window focusedPane for each window from sessionStorage.
      const savedFocus=sessionStorage.getItem('focusedPanes');
      if(savedFocus){
        const map=JSON.parse(savedFocus);
        for(const s of this.ws.windows){
          const rid=map[s.id];
          if(rid && s.layout && findPane(s.layout, rid)) s.focusedPane=rid;
        }
      }
    }catch{}
    // FR-WSL-2·7: 슬롯 복원은 activeWindow 복원 **뒤**다 — 포커스 슬롯의 창이
    // activeWindow 를 덮는다 (FR-WSL-3). 워크스페이스에 없는 창 id 는 그 슬롯만
    // 비운다.
    this._slotsRestore();
    this._pruneAgentOrder();
    const a=this._aw();
    if(a&&a.layout){const saved=a.focusedPane;const f=(saved&&findPane(a.layout,saved))?{id:saved}:firstPane(a.layout);if(f)this._setFocus(f.id, a)}
    this.render();
    this._bind();
    this._subscribeCommands();
    // Initial window claim: only if window has focus AND no other window
    // already owns this window (prevents init-time claim races).
    if(document.hasFocus&&document.hasFocus()){
      const sid=this.ws.activeWindow;
      if(sid && !this._windowFocusOwner[sid]){
        this._focusWindow(sid);
      }
    }
    this._applyFocusOverlay();
    this._initGitSection();
    this._initEditorSection();
    // FR-SRL-8·9: 내부 새로고침의 진입점 둘. 배선은 `_subscribeCommands` **뒤**
    // 여야 한다 — 그것이 `_sseKick` 을 세운다.
    this._initSoftReload();
    // FR-WSL-50·81: 슬롯 토글 버튼과 방향 설정. 다른 `_init*` 과 같은 자리다.
    this._initSlots();
  }

  _collectPanes(n, out){
    if(!n) return;
    if(n.type==='pane'){out.push(n);return}
    if(n.children) for(const c of n.children) this._collectPanes(c,out);
  }

  // FR-WSL-20: 슬롯을 명시하지 않으면 슬롯 0 이다 — 단일 슬롯 모드의 호출부가
  // 한 글자도 바뀌지 않아야 한다. 같은 도구를 두 슬롯에 그리면 인스턴스가 둘이고
  // WebSocket 도 둘이다 (§7 R-1, 회수는 _slotReap).
  _mkTool(id,name,slot){
    const key=this._slotKey(id,slot||0);
    if(this.tools.has(key)) return this.tools.get(key);
    const p=new TerminalTool(id,name);
    p._slot=slot||0;
    document.getElementById('area').appendChild(p.el);
    p.connect();
    this.tools.set(key,p);
    this._applyFocusOverlay();
    return p;
  }

  // 슬롯을 모르는 호출부의 조회. 포커스 슬롯을 먼저 보고, 없으면 다른 슬롯의
  // 인스턴스를 준다 — 슬롯 1 에만 있는 창의 도구도 검색·상태바에서 닿아야 한다.
  _toolAny(id){
    if(!id) return null;
    const f=this._slotFocused();
    return this.tools.get(this._slotKey(id,f))
      || this.tools.get(id)
      || this.tools.get(this._slotKey(id,1))
      || null;
  }

  // ── Tool Attention Notify (PANE_ATTENTION_NOTIFY_SRS) ──

  // 설정 영속화는 localStorage(per-device), 기존 /api/settings 스키마 무변경 (FR-PAN-14)
  // 데스크톱 알림은 기본 ON(권한 허용 시 동작) — '0' 으로 명시 비활성만 끈다 (FR-PAN-13a)
  get attnDesktop(){try{return localStorage.getItem('attnDesktop')!=='0'}catch{return true}}
  set attnDesktop(v){try{localStorage.setItem('attnDesktop',v?'1':'0')}catch{}}
  get attnSound(){try{return localStorage.getItem('attnSound')==='1'}catch{return false}}
  set attnSound(v){try{localStorage.setItem('attnSound',v?'1':'0')}catch{}}
  get agentsPollMs(){try{const v=parseInt(localStorage.getItem('agentsPollMs'));return v>=1000?v:AGENTS_POLL_DEFAULT}catch{return AGENTS_POLL_DEFAULT}}
  set agentsPollMs(v){try{localStorage.setItem('agentsPollMs',String(v))}catch{}}

  executeAction(action){
    const map={
      windowNext:()=>this.switchWindowNext(),windowPrev:()=>this.switchWindowPrev(),
      tabNext:()=>this.switchTabNext(),tabPrev:()=>this.switchTabPrev(),
      paneUp:()=>this.paneNavigate('up'),paneDown:()=>this.paneNavigate('down'),
      paneLeft:()=>this.paneNavigate('left'),paneRight:()=>this.paneNavigate('right'),
      splitH:()=>this.split('horizontal'),splitV:()=>this.split('vertical'),
      newWindow:()=>this.addWindow(),newTab:()=>this.addTabFocused(),
      closeWindow:()=>this.closeWindowActive(),closeTab:()=>this.closeTabFocused(),
      agentsToggle:()=>this._agentsToggle(),
      // FR-WSL-51·74: 버튼과 **같은 함수**를 부른다. 여는 길이 둘로 갈리면
      // 한쪽만 고쳐진다.
      slotAdd:()=>this.slotAdd(),
      slotRemove:()=>this.slotRemove(),
      // FR-PSC-3: 버튼 클릭과 **같은 함수**를 부른다. 여는 길이 둘로 갈리면
      // 한쪽만 고쳐진다.
      bgToggle:()=>this._bgModalToggle(),
      runsToggle:()=>this._runsModalToggle(),
      // FR-SRL-9: 다른 앱 단축키와 **같은 길**을 탄다 — 설정에서 바꿀 수 있고,
      // 터미널보다 앞서는 우선순위도 그 체계가 준다 (shortcuts.md).
      softReload:()=>this.softReload(),
      toggleSearch:()=>this.toggleSearch(),
      // FR-EKB-5: 키 배선과 **같은 함수**를 부른다. 셋 다 Editor 창이 아니면
      // 스스로 아무 일도 하지 않으므로 여기에 가드를 겹치지 않는다.
      edFindInFile:()=>this._edFindInFile(),
      edQuickOpen:()=>this._edQuickOpen(),
      edGrep:()=>this._edSearchOpen(),
    };
    // FR-SBT-21·26: 직행 키는 서술자 배열에서 파생한다 — 탭이 늘어도 이 맵을
    // 손으로 늘리지 않는다.
    for(let i=0;i<SB_TAB_DEFS.length&&i<9;i++) map[sbTabAction(i)]=()=>this._sbJumpTo(i+1);
    return map[action]?.();
  }

  _save(){
    this._savePending=true;
    if(this._saveChain) return this._saveChain;
    this._saveInflight=true;
    const run=async()=>{
      while(this._savePending){
        this._savePending=false;
        try{
          const headers={'Content-Type':'application/json'};
          if(this.wsETag) headers['If-Match']=this.wsETag;
          // activeWindow and focusedPane are per-window; strip them so
          // remote windows aren't forced to switch views (multi-window sync).
          const wsBody=JSON.parse(JSON.stringify(this.ws,(k,v)=>{
            if(k==='activeWindow'||k==='focusedPane') return undefined;
            return v;
          }));
          // 서버는 schemaVersion 미달 저장을 거부한다 (FR-EM-2a). 어떤 경로로
          // this.ws 가 만들어졌든 PUT 은 항상 현재 버전을 실어 보낸다.
          wsBody.schemaVersion=2;
          const res=await fetch('/api/workspace',{method:'PUT',headers,body:JSON.stringify(wsBody)});
          if(res.status===409){
            try{
              const gr=await fetch('/api/workspace');
              if(gr.ok){
                this.wsETag=gr.headers.get('ETag')||gr.headers.get('Etag')||null;
                // git.pinned 는 서버가 권위로 쓴다 (FR-GIT-11). 409 재시도가 우리
                // 본문으로 덮으면 핀이 사라진다 — 서버의 git 을 채택한다.
                //
                // 단, git.drafts 와 git.favorites 는 클라이언트가 주인이다
                // (O6·O13) — 통째로 채택하면 방금 입력한 커밋 메시지와 방금 고정한
                // 즐겨찾기가 재시도에서 사라진다 (FR-GIT-75·149).
                const rem=await gr.json();
                if(rem&&rem.git){
                  const mine=this.ws.git||{};
                  this.ws.git=rem.git;
                  for(const k of ['drafts','favorites'])
                    if(mine[k]) this.ws.git[k]=Object.assign({},rem.git[k]||{},mine[k]);
                }
                // FR-EDT-21: `editors` 도 서버가 권위다. `git` 과 달리
                // **클라이언트가 소유하는 하위 키가 없으므로** 병합 없이 서버
                // 값을 통째로 쓴다. 목록이 바뀌었으면 창도 따라와야 한다.
                if(rem&&rem.editors&&this._edOn()){
                  this.ws.editors=rem.editors;
                  this._edApply({home:this._editors.home,list:rem.editors.list});
                  this._edReconcile();
                }
              }
            }catch{}
            this._savePending=true;
            continue;
          }
          if(res.ok){
            const et=res.headers.get('ETag')||res.headers.get('Etag');
            if(et) this.wsETag=et;
          }
        }catch(err){console.warn('[save] PUT failed',err)}
      }
      this._saveChain=null;
      this._saveInflight=false;
      // Deferred workspace_changed events from during the save were almost
      // certainly echoes of our own PUT (now reflected in the updated
      // wsETag). Drop them — any genuinely newer external change will land
      // as a future SSE event with rev > our new wsETag and be applied
      // through the normal rev check.
      this._wsApplyPending=false;
    };
    this._saveChain=run();
    return this._saveChain;
  }

  _rename(obj, el){
    const old = obj.name;
    const input = document.createElement('input');
    input.type = 'text'; input.value = old; input.className = 'rename-input';
    el.replaceWith(input); input.focus(); input.select();
    const done = () => {
      const v = input.value.trim();
      if(v && v !== old) { obj.name = v; this._save(); }
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
  _sbSyncTabToWindow(){ SidebarTabs.syncToWindow(this) }
  _sbUpdateBadges(){ SidebarTabs.updateBadges(this) }
  _sbJumpTo(n){ SidebarTabs.jumpTo(this,n) }

  // ── Render (위임) ──

  // FR-SVS-61: 미뤄 둔 그리기가 있으면 이 그리기가 그것을 대신한다 — 지연은
  // "클릭을 삼키지 않기" 위한 것이지 그리기를 빼먹기 위한 것이 아니다.
  render(){ this._slotRenderPending=false; this.renderer.render(); this._agentsRender() }


  _bind(){ this.inputBinding.bind() }
}
