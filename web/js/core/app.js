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
    this.renderer=new Renderer(this);
    this.inputBinding=new InputBinding(this);
    this.gitPanel=new GitPanel(this);
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
    try{
      const stRes=await fetch('/api/state');
      this.wsETag=stRes.headers.get('ETag')||stRes.headers.get('Etag')||null;
      const st=await stRes.json();
      const sp=st.tools||[];
      const sv=st.workspace;
      const ok=new Set(sp.map(p=>p.id));
      for(const p of sp){const pane=this._mkTool(p.id,p.name);pane._reconnecting=true;pane.el.style.opacity='0'}
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
        this.ws.windows=this.ws.windows.filter(s=>s&&s.layout);
        // FR-GIT-186: 개정 이전에 Git 창 안에 들어간 탭을 일반 창으로 옮긴다.
        this._migrateGitWindow();
        if(!this.ws.windows.find(s=>s.id===this.ws.activeWindow))
          this.ws.activeWindow=this.ws.windows[0]?.id||null;
      }
      if(!this.ws.windows.length) await this._mkWindow();
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
  }

  _collectPanes(n, out){
    if(!n) return;
    if(n.type==='pane'){out.push(n);return}
    if(n.children) for(const c of n.children) this._collectPanes(c,out);
  }

  _mkTool(id,name){
    if(this.tools.has(id)) return this.tools.get(id);
    const p=new TerminalTool(id,name);
    document.getElementById('area').appendChild(p.el);
    p.connect();
    this.tools.set(id,p);
    this._applyFocusOverlay();
    return p;
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
      toggleSearch:()=>this.toggleSearch(),
    };
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

  // ── Render (위임) ──

  render(){ this.renderer.render(); this._agentsRender() }


  _bind(){ this.inputBinding.bind() }
}
