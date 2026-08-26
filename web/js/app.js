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
  _applyMobileMode(){
    const mob=this.isMobile;
    document.body.classList.toggle('mobile', mob);
    if(!mob && this._drawerOpen){this._drawerOpen=false;document.body.classList.remove('drawer-open')}
    if(!mob){document.body.classList.remove('keyboard-up')}
  }
  _toggleDrawer(open){
    if(!this.isMobile){this._drawerOpen=false;document.body.classList.remove('drawer-open');return}
    this._drawerOpen = (open===undefined) ? !this._drawerOpen : !!open;
    document.body.classList.toggle('drawer-open', this._drawerOpen);
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
  _mobileCurrentPane(){
    const s=this._aw(); if(!s||!s.layout) return null;
    const regs=this._flattenPanes(s.layout);
    if(!regs.length) return null;
    if(this._mPaneIdx>=regs.length) this._mPaneIdx=regs.length-1;
    if(this._mPaneIdx<0) this._mPaneIdx=0;
    return regs[this._mPaneIdx];
  }
  _mobilePaneCount(){
    const s=this._aw(); if(!s||!s.layout) return 0;
    return this._flattenPanes(s.layout).length;
  }
  navMobilePane(delta){
    const n=this._mobilePaneCount(); if(n<=1) return;
    this._mPaneIdx = (this._mPaneIdx + delta + n) % n;
    const pn=this._mobileCurrentPane();
    if(pn){
      this._setFocus(pn.id);
      this._save();
    }
    this.render();
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


  // 외부 CLI(dmctl) → 서버 → SSE 브로드캐스트 수신 → executeAction 재사용
  _subscribeCommands(){
    let retry=1000, retryCount=0, maxRetries=20;
    const connect=()=>{
      try{
        // FR-XDF-8: clientId 를 실어 서버가 구독↔Client 를 결선한다. 이 결선이
        // 구독 해제 시 소유권 해제(FR-XDF-9)의 선행 조건이다.
        const es=new EventSource('/api/commands/sse?clientId='+encodeURIComponent(this.clientId));
        es.onopen=()=>{retry=1000;retryCount=0;this._attnRestore();this._activityRestore();this._bgRefresh();this._focusRestore()};
        es.onmessage=(e)=>{
          try{
            const m=JSON.parse(e.data);
            if(m.action==='workspace_changed'){
              this._onWorkspaceChanged(m.args&&m.args.rev);
              return;
            }
            if(m.action==='tool_attention'){
              this._onToolAttention(m.args||{});
              return;
            }
            if(m.action==='tool_attention_clear'){
              this._onToolAttentionClear(m.args||{});
              return;
            }
            if(m.action==='tool_activity'){
              this._onToolActivity(m.args||{});
              return;
            }
            // FR-XDF-6: 전체 소유권 맵이 온다. 증분이 아니므로 통째로 갈아치우면
            // 되고, 자기 에코 필터가 필요 없다 (FR-XDF-14 — 멱등).
            if(m.action==='window_focus'){
              this._windowFocusOwner=(m.args&&m.args.owners)||{};
              this._applyFocusOverlay();
              return;
            }
            // FR-SXE-3: 서버가 실행자를 지명한 명령은 그 클라이언트만 수행한다.
            // 어떤 action 을 게이팅할지는 서버만 정하므로 여기서 종류를 보지
            // 않는다. 지명이 없으면(구독자에 clientId 가 없는 경우) 게이팅하지
            // 않는다 — FR-SXE-5 의 열화 경로다.
            if(m.execClientId&&m.execClientId!==this.clientId) return;
            // REMOTE_COMMAND_RESULT_SRS: reqId 는 broadcast payload 의 top-level
            // 이므로 args 에 합쳐 _execRemote 로 전달 (echo correlation).
            const args=m.args||{};
            if(m.reqId) args.reqId=m.reqId;
            this._execRemote(m.action, args);
          }catch(err){console.error('[cmd] parse',err)}
        };
        es.onerror=()=>{
          try{es.close()}catch{}
          if(++retryCount>maxRetries){console.error("[cmd] SSE max retries, giving up");return}
          setTimeout(connect, retry);
          retry=Math.min(retry*2, 30000);
        };
        this._cmdES=es;
      }catch(e){console.error('[cmd] connect',e); setTimeout(connect, retry)}
    };
    connect();
  }

  async _onWorkspaceChanged(rev){
    // While a local save is in flight, the SSE we just received is almost
    // certainly an echo of our own PUT (the PUT response with the new ETag
    // hasn't returned yet, so wsETag is still stale and would erroneously
    // pass the rev check). Defer until save settles.
    if(this._saveInflight){ this._wsApplyPending=true; return }
    if(this._wsApplyInflight){ this._wsApplyPending=true; return }
    const cur=this.wsETag?parseInt(this.wsETag,10):-1;
    if(typeof rev==='number' && rev<=cur) return;
    this._wsApplyInflight=true;
    try{
      do{
        this._wsApplyPending=false;
        const r=await fetch('/api/state');
        if(!r.ok) break;
        const et=r.headers.get('ETag')||r.headers.get('Etag');
        const st=await r.json();
        const sv=st&&st.workspace;
        const sp=(st&&st.tools)||[];
        if(!sv||!sv.windows) break;
        this._applyRemoteWorkspace(sv, sp);
        if(et) this.wsETag=et;
      }while(this._wsApplyPending);
    }catch(err){console.error('[ws] sync',err)}
    finally{this._wsApplyInflight=false}
  }

  _applyRemoteWorkspace(sv, serverPanes){
    const ok=new Set((serverPanes||[]).map(p=>p.id));
    const nameOf=new Map((serverPanes||[]).map(p=>[p.id,p.name]));
    for(const id of ok){
      if(!this.tools.has(id)) this._mkTool(id, nameOf.get(id)||id);
    }
    for(const [id,p] of Array.from(this.tools.entries())){
      if(!ok.has(id)){ try{p.destroy()}catch{} this.tools.delete(id) }
    }
    for(const s of sv.windows){
      if(!s||!s.id) continue;
      s.layout=clean(s.layout, ok);
      if(s.layout) normalizeLayout(s.layout);
    }
    sv.windows=sv.windows.filter(s=>s&&s.layout);
    // FR-GIT-186: 다른 브라우저 창이 개정 이전 모양을 보내올 수 있다.
    this._migrateGitWindow(sv.windows);
    if(!sv.windows.find(s=>s.id===sv.activeWindow))
      sv.activeWindow=sv.windows[0]?.id||null;
    // Preserve per-window viewport state: activeWindow and each window's
    // focusedPane. Remote structural changes (splits/tabs) are applied
    // but this window stays on its own window/pane.
    const localActive=this.ws.activeWindow;
    const localFocus=new Map();
    for(const s of this.ws.windows){
      if(s.focusedPane) localFocus.set(s.id, s.focusedPane);
    }
    this.ws=sv;
    if(localActive && this.ws.windows.some(s=>s.id===localActive)){
      this.ws.activeWindow=localActive;
    }
    // Restore each window's focusedPane if the pane still exists.
    for(const s of this.ws.windows){
      const rid=localFocus.get(s.id);
      if(rid && s.layout && findPane(s.layout, rid)) s.focusedPane=rid;
    }
    if('displayMode' in this.ws) delete this.ws.displayMode;
    if('mobileBreakpoint' in this.ws) delete this.ws.mobileBreakpoint;
    if(this.ws.sidebarWidth){
      const w=Math.max(100,Math.min(400,this.ws.sidebarWidth));
      document.documentElement.style.setProperty('--sb-w',w+'px');
      try{localStorage.setItem('sidebarWidth',w)}catch{}
    }
    const a=this._aw();
    if(a&&a.layout){
      const saved=a.focusedPane;
      const f=(saved&&findPane(a.layout,saved))?{id:saved}:firstPane(a.layout);
      if(f) this._setFocus(f.id, a);
    }
    this.render();
  }

  // REMOTE_COMMAND_RESULT_SRS FR-RCR-6: 생성 명령의 새 엔터티 id 를 reqId 와 묶어
  // 서버에 echo. best-effort — 실패해도 서버 timeout 이 백스톱 (DC-RCR-3).
  _echoResult(reqId, result){
    fetch('/api/command-result',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        reqId,
        newWindows:result.newWindows||[],
        newPanes:result.newPanes||[],
        newTabs:result.newTabs||[],
      }),
    }).catch(()=>{});
  }

  _execRemote(action, args){
    args=args||{};
    if(action==='focus'){
      // Multi-window: only apply focus if the source pane is in this window's
      // *active* window. If the pane belongs to a window that another
      // window is viewing, this window stays put.
      if(args.sourcePane && !this._isToolInActiveWindow(args.sourcePane)){
        return;
      }
      this._focusLocation(args.location); return
    }
    if(action==='openEditorTab'){
      const{name,filePath,location}=args;
      if(!filePath){console.warn('[cmd] openEditorTab: filePath required');return}
      if(location) this._focusLocation(location);
      const rid=this.focused;
      if(rid) this.addTab(rid,'editor',{name:name||filePath.split('/').pop(),filePath});
      return;
    }
    // RENAME_TAB_SESSION_SRS FR-RNS-1/2: 순수 데이터 변경 — 포커스 무영향.
    if(action==='renameTab'||action==='renameWindow'){
      if(!args.location||!args.name){console.warn('[cmd] '+action+': location/name 필수');return}
      const tgt=this._resolveLocation(args.location);
      if(!tgt){console.warn('[cmd] '+action+': 대상 없음',args.location);return}
      const name=String(args.name).slice(0,64);
      if(action==='renameTab') tgt.tab.name=name;
      else tgt.win.name=name;
      this._save(); this.render();
      return;
    }
    // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-5: newWindow/newTab 은 name/keepFocus
    // 를 전달하기 위해 명시 분기. 의미는 _mkWindow/addTab 내부에서 보장.
    if(action==='newWindow'){
      this._mkWindow({name:args.name,keepFocus:!!args.keepFocus}).then((c)=>{
        this.render();
        if(args.reqId&&c) this._echoResult(args.reqId,{newWindows:[c.win],newPanes:[c.pane],newTabs:[c.tab]});
      });
      return;
    }
    if(action==='newTab'){
      const opts={name:args.name,keepFocus:!!args.keepFocus};
      let rid=null;
      if(args.location){
        const tgt=this._resolveLocation(args.location);
        if(!tgt) return;
        if(opts.keepFocus){
          opts.windowId=tgt.windowId;
          rid=tgt.paneId;
        }else{
          this._focusLocation(args.location);
          rid=this.focused;
        }
      }else{
        rid=this.focused;
      }
      if(rid) this.addTab(rid,'terminal',opts).then((tab)=>{
        if(args.reqId&&tab) this._echoResult(args.reqId,{newTabs:[tab]});
      });
      return;
    }
    const isSplit=(action==='splitH'||action==='splitV');
    if(isSplit){
      const opts={count:args.count,keepFocus:!!args.keepFocus};
      if(args.location){
        const tgt=this._resolveLocation(args.location);
        if(!tgt) return;
        opts.targetWindow=tgt.windowId;
        opts.targetPane=tgt.paneId;
      }
      const dir=action==='splitH'?'horizontal':'vertical';
      this.split(dir,opts).then((c)=>{
        if(args.reqId&&c) this._echoResult(args.reqId,{newPanes:c.panes,newTabs:c.tabs});
      });
      return;
    }
    const keepFocus=!!args.keepFocus;
    // location 지정 closeTab 은 활성/비활성 창 구분 없이 포커스를 건드리지 않고 직접 close.
    // keepFocus 인자는 호환을 위해 받지만, location 이 있으면 항상 포커스 유지로 취급한다.
    // FR-BG-2: detach 명령 — 도구를 백그라운드로 보내고 탭을 닫는다.
    if(action==='detachTab'){
      const loc=this._findToolLocation(args.toolId);
      if(!loc){console.warn('[cmd] detachTab: 도구 위치 없음',args.toolId);return}
      if(!toolBackgroundCapable(loc.tab.type)){
        console.warn('[cmd] detachTab: 백그라운드 미지원 도구',loc.tab.type);return;
      }
      this.closeTab(loc.pane.id,loc.tab.id,loc.win.id,{keepTool:true});
      return;
    }
    if(action==='restoreTool'){
      // FR-BGR-2: location 은 탭 uuid → 서버가 좌표로 변환한 값이다. 복귀는
      // Pane 단위이므로 T 성분은 쓰지 않는다 (newTab/splitH 와 같은 해석).
      const opts={};
      if(args.location){
        const tgt=this._resolveLocation(args.location);
        if(!tgt){console.warn('[cmd] restoreTool: 대상 없음',args.location);return}
        opts.windowId=tgt.windowId; opts.paneId=tgt.paneId;
      }
      this._restoreTool(args.toolId,opts);
      return;
    }
    if(action==='closeTab' && args.location){
      const tgt=this._resolveLocation(args.location);
      if(tgt && tgt.paneId && tgt.tabId){
        this.closeTab(tgt.paneId, tgt.tabId, tgt.windowId);
        return;
      }
    }
    let savedWindow=null, savedFocused=null;
    if(args.location && keepFocus){
      savedWindow=this.ws.activeWindow;
      savedFocused=this.focused;
    }
    if(args.location) this._focusLocation(args.location);
    const result=this.executeAction(action);
    Promise.resolve(result).then(()=>{
      if(savedWindow==null) return;
      if(this.ws.activeWindow!==savedWindow && this.ws.windows.some(x=>x.id===savedWindow)){
        const cur=this._aw(); if(cur) cur.focusedPane=this.focused;
        this.ws.activeWindow=savedWindow;
        try{sessionStorage.setItem('activeWindow', savedWindow)}catch{}
        this._focusWindow(savedWindow);
      }
      const a=this._aw();
      if(a&&savedFocused&&findPane(a.layout,savedFocused)){
        this._setFocus(savedFocused, a);
      }
      this._save(); this.render();
    });
  }

  _resolveLocation(loc){
    if(!loc) return null;
    const m=String(loc).toUpperCase().trim().match(/^W?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m) return null;
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.windows[si]; if(!sess) return null;
    const panes=[]; this._collectPanes(sess.layout,panes);
    const pn=panes[pi]; if(!pn) return null;
    const tab=pn.tabs[ti]; if(!tab) return null;
    return {windowId:sess.id,paneId:pn.id,tabId:tab.id,win:sess,pane:pn,tab:tab};
  }

  // "4.1.1", "W4.P1.T1", "4", "4.2" 등을 지원. 1-base positional (window.pane.tab).
  _focusLocation(loc){
    if(!loc){console.warn('[cmd] focus: location 누락');return}
    const m=String(loc).toUpperCase().trim().match(/^W?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m){console.warn('[cmd] focus: 형식 오류',loc);return}
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.windows[si];
    if(!sess){console.warn('[cmd] focus: window #'+(si+1)+' 없음');return}
    const panes=[]; this._collectPanes(sess.layout, panes);
    const pn=panes[pi];
    if(!pn){console.warn('[cmd] focus: pane #'+(pi+1)+' 없음');return}
    const tab=pn.tabs[ti];
    if(!tab){console.warn('[cmd] focus: tab #'+(ti+1)+' 없음');return}
    if(this.ws.activeWindow!==sess.id){
      const cur=this._aw(); if(cur) cur.focusedPane=this.focused;
      this.ws.activeWindow=sess.id;
      try{sessionStorage.setItem('activeWindow', sess.id)}catch{}
    }
    pn.activeTab=tab.id;
    this._setFocus(pn.id, sess);
    this._focusWindow(sess.id);
    this._save(); this.render();
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

  async _isToolBusy(toolId){
    try{const r=await fetch(`/api/tools/${toolId}/busy`);const d=await r.json();return d.busy}catch{return false}
  }

  _confirmClose(msg, opts = {}){
    return new Promise(resolve=>{
      const ov=document.createElement('div');ov.className='confirm-overlay';
      let btns = '<button class="confirm-ok">닫기</button><button class="confirm-cancel">취소</button>';
      if (opts.saveBtn) {
        btns = '<button class="confirm-save">저장 후 닫기</button>' + btns;
      }
      // FR-BG-3/4: 실행 중인 도구를 살려두고 닫는 선택지.
      if (opts.bgBtn) {
        btns = `<button class="confirm-bg">${opts.bgLabel||'백그라운드로'}</button>` + btns;
      }
      ov.innerHTML=`<div class="confirm-box"><div class="confirm-msg">${msg}</div><div class="confirm-btns">${btns}</div></div>`;
      document.body.appendChild(ov);
      const saveBtn = ov.querySelector('.confirm-save');
      const bgBtn = ov.querySelector('.confirm-bg');
      if (saveBtn) saveBtn.focus(); else if (bgBtn) bgBtn.focus(); else ov.querySelector('.confirm-ok').focus();
      const cleanup=v=>{ov.remove();document.removeEventListener('keydown',onKey);resolve(v)};
      const onKey=e=>{if(e.key==='Enter'){e.preventDefault();cleanup(saveBtn?'save':(bgBtn?'background':true))}else if(e.key==='Escape'){e.preventDefault();cleanup(false)}};
      document.addEventListener('keydown',onKey);
      if (saveBtn) saveBtn.addEventListener('click',()=>cleanup('save'));
      if (bgBtn) bgBtn.addEventListener('click',()=>cleanup('background'));
      ov.querySelector('.confirm-ok').addEventListener('click',()=>cleanup(true));
      ov.querySelector('.confirm-cancel').addEventListener('click',()=>cleanup(false));
      ov.addEventListener('click',e=>{if(e.target===ov)cleanup(false)});
    });
  }

  // ── 백그라운드 도구 (FR-BG) ──

  // _setToolBackground는 도구를 백그라운드로 보내거나 되돌린다. 실패해도
  // 호출자의 흐름을 막지 않는다 — 탭 닫기가 알림 실패로 멈추면 더 나쁘다.
  async _setToolBackground(toolId,bg){
    if(!toolId) return false;
    try{
      const r=await fetch('/api/tools/background/set',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({toolId,background:!!bg})});
      return r.ok;
    }catch{return false}
  }

  async _bgRefresh(){
    try{
      const r=await fetch('/api/tools/background');
      if(!r.ok) return;
      const j=await r.json();
      this._bg=Array.isArray(j.background)?j.background:[];
    }catch{return}
    this._updateStatusBar();
    if(this._bgModalOpen) this._bgModalRender();
  }

  // FR-BGR-7: 복귀 대상 Pane 을 고른다.
  //
  // 명시 대상(opts.paneId)은 폴백하지 않는다 — 지목한 곳이 사라졌으면 실패가
  // 옳고, 그때 도구는 백그라운드 목록에 남아 여전히 닿을 수 있다 (TC-BGR-6b).
  // location 미지정은 "대상을 정하지 않았다"는 뜻이므로 폴백이 정당하다.
  async _restorePane(opts){
    if(opts.paneId){
      const win=this.ws.windows.find(s=>s.id===opts.windowId)||null;
      return win&&win.layout?findPane(win.layout,opts.paneId):null;
    }
    for(let i=0;i<RESTORE_PANE_WAIT_TRIES;i++){
      const a=this._aw();
      const pn=(this.focused&&a&&a.layout?findPane(a.layout,this.focused):null)
        ||(a&&a.layout?firstPane(a.layout):null)
        ||this.ws.windows.map(s=>firstPane(s.layout)).find(Boolean)
        ||null;
      if(pn) return pn;
      // 창이 하나도 없는 것은 delWindow 가 _mkWindow 를 끝내기 전의 과도
      // 상태뿐이다. 조용히 무효가 되지 않도록 그 왕복만큼 기다린다.
      await new Promise(r=>setTimeout(r,RESTORE_PANE_WAIT_MS));
    }
    return null;
  }

  // FR-BG-7 / FR-BGR-1: 백그라운드 도구를 지정 분할 칸(opts.paneId, 미지정 시
  // 현재 포커스)의 새 탭으로 되돌린다.
  async _restoreTool(toolId,opts={}){
    if(!toolId) return;
    // FR-BGR-5: 대상을 먼저 확정한다. 백그라운드 해제를 앞세우면 대상이 없을 때
    // 도구가 목록에도 탭에도 없는 — 어디서도 닿을 수 없는 상태가 된다.
    const pn=await this._restorePane(opts);
    if(!pn){console.warn('[bg] 복귀할 분할 칸 없음',opts.paneId||this.focused);return}
    if(!await this._setToolBackground(toolId,false)) return;
    if(!this.tools.has(toolId)) this._mkTool(toolId,DEFAULT_TOOL_NAME);
    const t=newEntityId();
    pn.tabs.push({id:t,name:'Shell',type:'terminal',toolId});
    pn.activeTab=t;
    this.render();
    this._save();
    this._bgRefresh();
  }

  async _newTool(cwd,cwdTool){
    let q='';
    if(cwd) q='&cwd='+encodeURIComponent(cwd);
    else if(cwdTool) q='&cwdTool='+encodeURIComponent(cwdTool);
    const r=await fetch('/api/tools?cols=120&rows=40'+q,{method:'POST'});
    if(!r.ok) throw new Error('create pane failed');
    const {id,name}=await r.json();
    return this._mkTool(id,name);
  }

  async _focusedCwd(){
    const p=this._focusedTerminal();
    if(!p) return null;
    try{const r=await fetch('/api/cwd?tool='+p.id);const d=await r.json();return d.cwd||null}catch{return null}
  }

  async _kill(pid){
    const p=this.tools.get(pid);
    if(p){p.destroy();this.tools.delete(pid)}
    try{await fetch(`/api/tools/${pid}`,{method:'DELETE'})}catch{}
  }
  _killTool(pid){
    const p=this.tools.get(pid);
    if(p){p.destroy();this.tools.delete(pid)}
    fetch(`/api/tools/${pid}`,{method:'DELETE'}).catch(()=>{});
  }

  _aw(){return this.ws.windows.find(s=>s.id===this.ws.activeWindow)||null}

  // _isToolInActiveWindow reports whether a pane (by id) is present in the
  // currently active window's layout. Used to route focus commands only to
  // the window that is actually viewing the source pane (multi-window).
  _isToolInActiveWindow(toolId){
    if(!toolId) return false;
    const s=this._aw();
    if(!s||!s.layout) return false;
    let found=false;
    const walk=n=>{
      if(!n||found) return;
      if(n.type==='pane'&&n.tabs){
        for(const t of n.tabs) if(t.toolId===toolId){found=true;return}
      }
      if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
    };
    walk(s.layout);
    return found;
  }

  // _setFocus is the single entry point for the focus invariant
  // (this.focused === active window.focusedPane). It accepts an optional
  // window reference; when omitted, the active window is used. When the
  // mutated window is not the active one, only its focusedPane is updated
  // (this.focused unchanged). REG-2~8 회귀 클래스 차단용 단일 진입점.
  _setFocus(rid, sess){
    const target = sess || this._aw();
    if(target) target.focusedPane = rid;
    if(!sess || (target && target.id === this.ws.activeWindow)){
      this.focused = rid;
      // FR-PAN-11: 포커스된 활성 탭 pane 의 주의 상태 해제(로컬+엔드포인트)
      if(this.focused===rid) this._attnClearFocused();
    }
    this._agentsRender(); // 외부 포커스 변경도 카드 .focused 에 즉시 반영(render 미경유 경로 포함)
    this._persistFocusedPanes();
  }

  // Persist per-window focusedPane map to sessionStorage so a refresh
  // restores the same view (multi-window: each window owns its viewport).
  _persistFocusedPanes(){
    try{
      const map={};
      for(const s of this.ws.windows){
        if(s.focusedPane) map[s.id]=s.focusedPane;
      }
      sessionStorage.setItem('focusedPanes', JSON.stringify(map));
    }catch{}
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

  _attnHas(toolId){return this._attn.has(toolId)}

  // 활성 창의 포커스 pane 의 activeTab toolId === toolId 인지 (FR-PAN-9)
  _isToolFocusedActive(toolId){
    if(!toolId) return false;
    const s=this._aw(); if(!s||!s.layout) return false;
    const pn=findPane(s.layout,this.focused); if(!pn) return false;
    const at=(pn.tabs||[]).find(t=>t.id===pn.activeTab);
    return !!at&&at.toolId===toolId;
  }

  _onToolAttention({toolId,reason}={}){
    if(!toolId) return;
    // 억제(즉시 해제)는 "정말로 보고 있을 때"만 — 브라우저 창이 OS 포커스를 가졌고(다른 앱이
    // 위에 있지 않음) 그 pane 에 포커스가 있을 때. 다른 프로그램을 보고 있으면(document.hasFocus()
    // false) 포커스여도 알람을 살린다 (FR-PAN-9/13/요구2).
    const browserFocused=(typeof document!=='undefined'&&typeof document.hasFocus==='function')?document.hasFocus():true;
    if(browserFocused&&this._isToolFocusedActive(toolId)){this._attnClear(toolId);return}
    this._attn.set(toolId,{reason});
    this._attnRefresh();
    this._attnDesktopNotify(reason,toolId); // FR-PAN-13a
    this._attnBeep(); // FR-PAN-13c
  }

  _onToolAttentionClear({toolId}={}){
    if(!toolId) return;
    this._attnCloseNotif(toolId);
    if(!this._attn.delete(toolId)) return;
    this._attnRefresh();
  }

  // FR-PAN-12: 합류/재연결 시 현재 주의 집합 복원(기존 것 병합)
  _attnRestore(){
    fetch('/api/tools/attention').then(r=>r.ok?r.json():null).then(j=>{
      if(!j||!Array.isArray(j.toolIds)) return;
      for(const pid of j.toolIds){if(!this._attn.has(pid))this._attn.set(pid,{reason:'signaled'})}
      this._attnRefresh();
    }).catch(()=>{});
  }

  // FR-PAN-11: 로컬 즉시 제거 + 백엔드 해제(다른 브라우저로 전파)
  _attnClear(toolId){
    if(!toolId) return;
    this._attnCloseNotif(toolId);
    this._attn.delete(toolId);
    fetch('/api/tools/attention/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({toolId})}).catch(()=>{});
    this._attnRefresh();
  }

  // FR-PAN-17: 모든 알람 일괄 해제
  _attnClearAll(){
    fetch('/api/tools/attention/clear-all',{method:'POST'}).catch(()=>{});
    Object.keys(this._attnNotifs||{}).forEach(k=>this._attnCloseNotif(k));
    this._attn.clear();
    this._attnCenterClose();
    this._attnRefresh();
  }

  // FR-PAN-16: 창 layout 안에 주의 상태 pane 이 있는지
  _windowHasAttn(s){
    if(!s||!s.layout||!this._attn.size) return false;
    const walk=(node)=>{
      if(!node) return false;
      if(node.type==='pane') return (node.tabs||[]).some(t=>t.toolId&&this._attn.has(t.toolId));
      if(node.children) return node.children.some(walk);
      return false;
    };
    return walk(s.layout);
  }

  // 포커스된 활성 탭이 주의 상태면 해제. 그 탭은 어차피 강조 안 되므로 full render 불필요
  _attnClearFocused(){
    if(!this._attn.size) return;
    const s=this._aw(); if(!s||!s.layout) return;
    const pn=findPane(s.layout,this.focused); if(!pn) return;
    const at=(pn.tabs||[]).find(t=>t.id===pn.activeTab);
    if(at&&at.toolId&&this._attn.has(at.toolId)) this._attnClear(at.toolId);
  }

  // 모든 창 layout 트리를 walk 해 toolId 를 가진 tab 위치 반환 (FR-PAN-16)
  _findToolLocation(toolId){
    if(!toolId) return null;
    const walk=(node,win)=>{
      if(!node) return null;
      if(node.type==='pane'){
        const tab=(node.tabs||[]).find(t=>t.toolId===toolId);
        return tab?{win,pane:node,tab}:null;
      }
      if(node.children) for(const c of node.children){const f=walk(c,win);if(f)return f}
      return null;
    };
    for(const s of this.ws.windows){const f=walk(s.layout,s);if(f)return f}
    return null;
  }

  // FR-PAN-16: 해당 pane 으로 포커스 이동(_setFocus 가 _attnClearFocused 로 해제)
  _jumpToTool(toolId){
    const loc=this._findToolLocation(toolId);
    if(!loc) return;
    this.ws.activeWindow=loc.win.id;
    try{sessionStorage.setItem('activeWindow', loc.win.id)}catch{}
    loc.pane.activeTab=loc.tab.id;
    this._setFocus(loc.pane.id, loc.win);
    this._focusWindow(loc.win.id);
    this.render();
  }

  // FR-AAP-15: SSE tool_activity 수신 → 최신 상태로 덮어쓰고 카드 타깃 갱신
  _onToolActivity({toolId,state,tool,detail}={}){
    if(!toolId||!state) return;
    if(state==='ended'){ // 종료 → 카드 제거
      if(this._activity.delete(toolId)) this._agentsRender();
      return;
    }
    // FR-AAP-13/21: 기존 항목은 제자리 갱신(순서 불변), 신규는 Map 끝(=최하단)에 추가
    this._activity.set(toolId,{state,tool:tool||'',detail:detail||''});
    this._agentsRender();
  }

  // FR-AAP-15: 합류/재연결 시 현재 활동 스냅샷 복원
  _activityRestore(){
    fetch('/api/tools/activity').then(r=>r.ok?r.json():null).then(j=>{
      this._activity.clear();
      if(j&&Array.isArray(j.activities)){
        j.activities.sort((a,b)=>(a.updatedAt||0)-(b.updatedAt||0)); // 오래된→최신: 끝이 가장 최근
        for(const a of j.activities) this._activity.set(a.toolId,{state:a.state,tool:a.tool||'',detail:a.detail||''});
      }
      this._agentsRender();
    }).catch(()=>{});
  }

  // FR-AAP-11/12: 우측 활동 패널 토글(열림 상태 영속)
  _agentsToggle(){
    const panel=document.getElementById('agents-panel'),handle=document.getElementById('agents-handle');
    if(!panel) return;
    const open=!panel.classList.contains('open');
    panel.classList.toggle('open',open);
    handle.classList.toggle('open',open);
    const btn=document.getElementById('agents-toggle');if(btn)btn.classList.toggle('open',open);
    try{localStorage.setItem('agentsPanelOpen',open?'1':'0')}catch{}
    for(const p of this.tools.values()) if(p.el.classList.contains('vis')) p.doFit();
    if(open){this._agentsRender();this._agentsStartPoll()}else{this._agentsStopPoll()}
    // agents 패널이 열리거나 닫힐 때 attn center 위치도 같이 조정
    const ac=document.getElementById('attn-center');
    if(ac&&ac.classList.contains('open')) requestAnimationFrame(()=>this._positionAttnCenter());
  }

  // FR-AAP-19: 패널 열림 동안 주기적으로 서버 스냅샷과 동기화(자동 새로고침)
  _agentsStartPoll(){
    this._agentsStopPoll();
    this._agentsTimer=setInterval(()=>this._activityRestore(),this.agentsPollMs);
  }
  _agentsStopPoll(){
    if(this._agentsTimer){clearInterval(this._agentsTimer);this._agentsTimer=null}
  }

  // 창 사이드바 드래그 재배치. drop(즉시) 1순위 + dragend 폴백, done 으로 중복 커밋 차단.
  // 식별자(id)로 원본/대상을 찾아 splice 후 인덱스 이동에 안전. 대상 미존재(끝 너머)면 맨 끝으로.
  _reorderWindows(dr){
    if(!dr||dr.done||!dr.srcId||dr.targetId==null||dr.srcId===dr.targetId) return;
    dr.done=true;
    const arr=this.ws.windows;
    const si=arr.findIndex(x=>x.id===dr.srcId);
    if(si<0) return;
    const[moved]=arr.splice(si,1);
    let ti=arr.findIndex(x=>x.id===dr.targetId);
    if(ti<0){arr.push(moved)}else{if(!dr.before)ti++;arr.splice(ti,0,moved)}
    this._save();this.render();
  }

  // FR-AAP-21: 활동 카드 드래그 재배치. drop(즉시) 1순위 + dragend 폴백, done 으로 중복 차단.
  _reorderAgents(dr){
    if(!dr||dr.done||!dr.pid||!dr.targetPid||dr.pid===dr.targetPid) return;
    dr.done=true;
    const ord=this.ws.agentsOrder;
    if(!Array.isArray(ord)) return;
    const si=ord.indexOf(dr.pid);
    if(si<0) return;
    ord.splice(si,1);
    let ti=ord.indexOf(dr.targetPid);
    if(ti<0){ord.push(dr.pid)}else{if(!dr.before)ti++;ord.splice(ti,0,dr.pid)}
    this._save();this._agentsRender();
  }

  // FR-AAP-21: ws.agentsOrder(workspace 영속·동기화)를 현재 활동 집합과 정합한다.
  // 사라진 toolId 는 제외, 배열에 없던 새 toolId 는 신호 도착 순서대로 최하단에 추가.
  // reconcile 은 결정적이라 _save() 를 유발하지 않는다(드래그 시에만 저장).
  // FR-EM-16: 부팅 시 workspace 트리에 없는 도구 id 를 agentsOrder 에서
  // 제거한다. _agentOrderSync 는 활동 보고가 있는 도구만 남기므로 부팅
  // 직후(활동 0건)에 쓰면 순서가 전부 날아간다 — 여기서는 레이아웃 참조를
  // 기준으로만 정리한다.
  _pruneAgentOrder(){
    if(!Array.isArray(this.ws.agentsOrder)||!this.ws.agentsOrder.length) return;
    const present=new Set();
    for(const w of this.ws.windows||[]){
      const panes=[]; this._collectPanes(w.layout,panes);
      for(const pn of panes) for(const t of (pn.tabs||[])) if(t.toolId) present.add(t.toolId);
    }
    const kept=this.ws.agentsOrder.filter(id=>present.has(id));
    if(kept.length!==this.ws.agentsOrder.length) this.ws.agentsOrder=kept;
  }

  _agentOrderSync(){
    if(!Array.isArray(this.ws.agentsOrder)) this.ws.agentsOrder=[];
    const present=new Set(this._activity.keys());
    const order=this.ws.agentsOrder.filter(pid=>present.has(pid));
    const seen=new Set(order);
    for(const pid of this._activity.keys()) if(!seen.has(pid)) order.push(pid);
    this.ws.agentsOrder=order;
    return order;
  }

  // FR-AAP-13/14/16/18/21: 활동 중인 pane 카드 렌더. _findToolLocation 실패(종료/없음)
  // pane 은 제외, attention 있으면 .attn 합성, 클릭 시 점프+알람 해제. 카드 순서는
  // ws.agentsOrder(드래그로 조절·영속) 를 따른다.
  _agentsRender(){
    const panel=document.getElementById('agents-panel');
    if(!panel||!panel.classList.contains('open')) return;
    panel.innerHTML='';
    const head=document.createElement('div');
    head.className='ag-head';
    head.innerHTML=`<span class="ag-title">Agents</span><button class="ag-refresh" title="새로고침">↻</button><button class="ag-close" title="닫기">✕</button>`;
    head.querySelector('.ag-refresh').addEventListener('click',e=>{e.stopPropagation();this._activityRestore()});
    head.querySelector('.ag-close').addEventListener('click',e=>{e.stopPropagation();this._agentsToggle()});
    panel.appendChild(head);
    let n=0;
    for(const toolId of this._agentOrderSync()){ // ws.agentsOrder 순서(신규=최하단)
      const info=this._activity.get(toolId);
      const loc=this._findToolLocation(toolId);
      if(!loc) continue;
      n++;
      const card=document.createElement('div');
      card.className='ag-card'+(this._attnHas(toolId)?' attn':'')+(this._isToolFocusedActive(toolId)?' focused':'');
      card.dataset.toolid=toolId;
      const locDiv=document.createElement('div');locDiv.className='ag-loc';locDiv.textContent=(loc.win.name||'')+' · '+(loc.tab.name||toolId);
      const st=document.createElement('div');st.className='ag-state';
      st.classList.add(info.state); // 상태별 색(.ag-state.working 등)
      st.textContent=(AGENT_STATE_ICON[info.state]||'●')+' '+info.state+(info.tool?' · '+info.tool:'');
      const dt=document.createElement('div');dt.className='ag-detail';
      if(info.detail){dt.textContent=info.detail;card.appendChild(dt);}
      card.appendChild(locDiv);
      card.appendChild(st);
      card.addEventListener('click',()=>{this._jumpToTool(toolId);if(this._attnHas(toolId))this._attnClear(toolId)});
      // FR-AAP-21: 창 사이드바와 동일한 native DnD. drop(즉시) 1순위, dragend 폴백.
      card.draggable=true;
      card.addEventListener('dragstart',e=>{this._drag={type:'agent',pid:toolId,targetPid:null,before:false,done:false};e.dataTransfer.effectAllowed='move';setTimeout(()=>card.classList.add('dragging'),0)});
      card.addEventListener('dragover',e=>{const dr=this._drag;if(!dr||dr.type!=='agent')return;e.preventDefault();panel.querySelectorAll('.ag-card').forEach(c=>c.classList.remove('drag-above','drag-below'));const rect=card.getBoundingClientRect();const before=e.clientY<rect.top+rect.height/2;card.classList.add(before?'drag-above':'drag-below');dr.targetPid=toolId;dr.before=before});
      card.addEventListener('drop',e=>{const dr=this._drag;if(!dr||dr.type!=='agent')return;e.preventDefault();e.stopPropagation();this._reorderAgents(dr)});
      // dragend 는 시각 정리만 — 패널 밖 release 는 취소(순서 불변, snap-back 깜빡임 방지).
      card.addEventListener('dragend',()=>{this._drag=null;card.classList.remove('dragging');panel.querySelectorAll('.ag-card').forEach(c=>c.classList.remove('drag-above','drag-below'))});
      panel.appendChild(card);
    }
    if(!n){
      const empty=document.createElement('div');
      empty.className='ag-empty';
      empty.textContent='활동 중인 에이전트 없음';
      panel.appendChild(empty);
    }
  }

  // FR-PAN-16: 제목 배지 + notification center 배지/팝오버 갱신
  _attnRefresh(){
    const n=this._attn.size;
    document.title=(n?'('+n+') ':'')+'Dongminal'; // FR-PAN-13b
    // 사이드바 창 알람 표시 갱신 (전체 재렌더 없이)
    document.querySelectorAll('#windows .si').forEach(el=>{
      const s=this.ws.windows.find(x=>x.id===el.dataset.sid);
      el.classList.toggle('attn', !!(s&&this._windowHasAttn(s)));
    });
    // 탭/리전 강조도 타깃 토글 — 전체 render() 를 피해 포커스 플리커(xterm blur/refocus)를 막는다.
    document.querySelectorAll('#area .pn-tab[data-toolid]').forEach(t=>{
      const pn=t.closest('.pn');
      const focusedPane=!!(pn&&pn.classList.contains('focused'));
      const active=t.classList.contains('active');
      t.classList.toggle('attn', this._attnHas(t.dataset.toolid)&&!(focusedPane&&active));
    });
    document.querySelectorAll('#area .pn[data-paneid]').forEach(pn=>{
      const at=pn.querySelector('.pn-tab.active[data-toolid]');
      const pid=at?at.dataset.toolid:null;
      pn.classList.toggle('attn', !!(pid&&this._attnHas(pid)&&!pn.classList.contains('focused')));
    });
    const badge=document.getElementById('attn-badge');
    if(badge){
      const cnt=badge.querySelector('.attn-count');
      if(cnt) cnt.textContent=String(n);
      badge.style.display=n?'':'none';
      if(!n) this._attnCenterClose();
    }
    const center=document.getElementById('attn-center');
    if(center&&center.classList.contains('open')) this._attnCenterRender();
    this._agentsRender(); // FR-AAP-18: 활동 카드의 alarm 표시도 함께 갱신
  }

  _positionAttnCenter(){
    const badge=document.getElementById('attn-badge');
    const center=document.getElementById('attn-center');
    if(!badge||!center) return;
    const r=badge.getBoundingClientRect();
    center.style.top=(r.bottom+4)+'px';
    center.style.left='';
    center.style.right=(window.innerWidth-r.right)+'px';
  }

  _attnCenterToggle(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    if(center.classList.contains('open')) this._attnCenterClose();
    else{this._positionAttnCenter();center.classList.add('open');this._attnCenterRender()}
  }

  _attnCenterClose(){
    const center=document.getElementById('attn-center');
    if(center) center.classList.remove('open');
  }

  _attnCenterRender(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    center.innerHTML='';
    if(!this._attn.size){this._attnCenterClose();return}
    const head=document.createElement('div');
    head.className='attn-head';
    head.innerHTML=`<span class="attn-title">주의 알림 ${this._attn.size}</span><button class="attn-clear-all">모두 제거</button>`;
    head.querySelector('.attn-clear-all').addEventListener('click',e=>{e.stopPropagation();this._attnClearAll()});
    center.appendChild(head);
    for(const [toolId,info] of this._attn){
      const loc=this._findToolLocation(toolId);
      const name=loc?loc.tab.name:toolId;
      const reason=info&&info.reason==='idle'?'작업 멈춤':'알림 신호';
      const item=document.createElement('div');
      item.className='attn-item';
      const nameSpan=document.createElement('span');nameSpan.className='attn-name';nameSpan.textContent=name;
      const reasonSpan=document.createElement('span');reasonSpan.className='attn-reason';reasonSpan.textContent=reason;
      item.appendChild(nameSpan);
      item.appendChild(reasonSpan);
      item.addEventListener('click',()=>{this._jumpToTool(toolId);this._attnCenterClose()});
      center.appendChild(item);
    }
  }

  // FR-PAN-13a: 데스크톱 알림(권한 granted + 설정 on). pane 별 직전 알림을 닫고 새로 띄운다.
  _attnDesktopNotify(reason,toolId){
    if(!this.attnDesktop) return;
    if(typeof Notification==='undefined'||Notification.permission!=='granted') return;
    const loc=this._findToolLocation(toolId);
    const where=loc?[loc.win&&loc.win.name,loc.tab&&loc.tab.name].filter(Boolean).join(' · '):('pane '+toolId);
    const head=reason==='done'?'✅ 작업 완료':reason==='waiting'?'⌨️ 입력 대기 중':reason==='idle'?'⏸️ 작업이 멈췄습니다':'🔔 주의가 필요합니다';
    // 같은 pane 의 이전 알림을 닫고 새로 띄운다 — tag+renotify 는 (특히 macOS 에서)
    // 조용히 갱신만 되어 재팝업이 안 되므로, close→재생성으로 매번 확실히 다시 띄운다.
    this._attnNotifs=this._attnNotifs||{};
    this._attnCloseNotif(toolId);
    try{this._attnNotifs[toolId]=new Notification(head,{body:where||('pane '+toolId)})}catch{}
  }

  // 저장해 둔 데스크톱 알림 객체를 닫는다(있으면).
  _attnCloseNotif(toolId){
    if(this._attnNotifs&&this._attnNotifs[toolId]){
      try{this._attnNotifs[toolId].close()}catch{}
      delete this._attnNotifs[toolId];
    }
  }

  // FR-PAN-13c: WebAudio 짧은 비프(외부 파일 없음). 설정 on 일 때만
  _attnBeep(){
    if(!this.attnSound) return;
    const Ctx=window.AudioContext||window['webkitAudioContext'];
    if(!Ctx) return;
    if(!this._audioCtx) this._audioCtx=new Ctx();
    const ctx=this._audioCtx;
    const osc=ctx.createOscillator();
    const gain=ctx.createGain();
    osc.type='sine';
    osc.frequency.value=880;
    gain.gain.value=.05;
    osc.connect(gain);gain.connect(ctx.destination);
    const t=ctx.currentTime;
    osc.start(t);
    gain.gain.setValueAtTime(.05,t);
    gain.gain.exponentialRampToValueAtTime(.0001,t+.18);
    osc.stop(t+.2);
  }

  // notification center 배지/팝오버 이벤트 바인딩 + 설정 토글 (FR-PAN-14/16)
  _initAttn(){
    const badge=document.getElementById('attn-badge');
    if(badge&&!badge._bound){
      badge._bound=true;
      badge.addEventListener('click',e=>{e.stopPropagation();this._attnCenterToggle()});
    }
    document.addEventListener('click',e=>{
      const center=document.getElementById('attn-center');
      if(!center||!center.classList.contains('open')) return;
      if(center.contains(e.target)||(badge&&badge.contains(e.target))) return;
      this._attnCenterClose();
    });
    const dt=document.getElementById('attn-desktop');
    if(dt){
      dt.checked=this.attnDesktop;
      dt.addEventListener('change',()=>{
        if(dt.checked&&typeof Notification!=='undefined'&&Notification.permission==='default'){
          Notification.requestPermission().then(p=>{if(p!=='granted'){dt.checked=false;this.attnDesktop=false}});
        }
        this.attnDesktop=dt.checked;
      });
    }
    const sd=document.getElementById('attn-sound');
    if(sd){
      sd.checked=this.attnSound;
      sd.addEventListener('change',()=>{this.attnSound=sd.checked});
    }
    const ap=document.getElementById('agents-poll');
    if(ap){
      ap.value=String(this.agentsPollMs);
      ap.addEventListener('change',()=>{
        this.agentsPollMs=parseInt(ap.value);
        if(this._agentsTimer) this._agentsStartPoll(); // 폴링 중이면 새 주기로 재시작
      });
    }
    // 데스크톱 알림 권한은 사용자 제스처가 필요하므로, 켜져 있고 아직 미결정이면
    // 첫 상호작용에서 한 번 요청한다 (브라우저 정책 충족) — FR-PAN-13a.
    // capture 단계로 들어야 xterm 이 pointer/key 이벤트를 먼저 소비해도 누락되지 않는다.
    if(typeof Notification!=='undefined'&&Notification.permission==='default'&&this.attnDesktop&&!this._attnPermAsked){
      this._attnPermAsked=true;
      let asked=false;
      const ask=()=>{if(asked)return;asked=true;try{const r=Notification.requestPermission();if(r&&r.then)r.then(()=>this._initAttn&&this._attnRefresh())}catch{}};
      document.addEventListener('pointerdown',ask,{once:true,capture:true});
      document.addEventListener('keydown',ask,{once:true,capture:true});
    }
    // 브라우저로 돌아오면(다른 앱→복귀) 지금 보고 있는 pane 의 알람은 해제 (요구2 보완).
    if(!this._attnFocusBound){
      this._attnFocusBound=true;
      window.addEventListener('focus',()=>this._attnClearFocused());
    }
    this._attnRefresh();
  }

  async _mkWindow(opts={}){
    const p=await this._newTool();
    const r=newEntityId(),t=newEntityId();
    const name=(typeof opts.name==='string'&&opts.name?opts.name:'Window').slice(0,64);
    const s={
      id:newEntityId(),name,
      layout:{type:'pane',id:r,tabs:[{id:t,name:'Shell',type:'terminal',toolId:p.id}],activeTab:t}
    };
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
  }

  async addWindow(){await this._mkWindow();this.render()}

  // _gitWindow 는 워크스페이스의 Git 창이다. 없으면 null (FR-GIT-26).
  _gitWindow(){return this.ws.windows.find(s=>s&&s.type===WINDOW_TYPE_GIT)||null}

  // FR-GIT-179·182: Git 창은 닫힌 창이고 창 목록·순환의 대상이 아니다. 판정은
  // 이 두 곳에만 둔다 — 조건이 흩어지면 한 곳이 빠져도 조용히 지나간다.
  _isGitWin(s){return !!(s&&s.type===WINDOW_TYPE_GIT)}
  _plainWindows(){return this.ws.windows.filter(s=>!this._isGitWin(s))}

  // FR-GIT-183: Git 창을 닫는다. 다시 열면 새로 만들어진다 (FR-GIT-26 유지).
  _gitCloseWindow(){
    const w=this._gitWindow(); if(!w) return;
    this.delWindow(w.id);
  }

  // FR-GIT-186: 개정 이전 워크스페이스의 Git 창 안 탭을 일반 창으로 옮긴다.
  // 판정과 이동은 helpers 의 순수 함수가 한다 — 로드 경로가 둘이라 여기서 두 벌로
  // 만들면 한쪽만 고쳐진다.
  _migrateGitWindow(list){
    const ws=list||this.ws.windows;
    const n=migrateGitWindows(ws,()=>{
      // 받을 일반 창이 없으면 껍데기 창을 만든다 (O19). PTY 는 붙이지 않는다 —
      // 옮겨 온 탭이 이미 자기 실체를 들고 온다.
      const w={id:newEntityId(),name:'Window',
        layout:{type:'pane',id:newEntityId(),tabs:[],activeTab:null}};
      ws.push(w);
      return w;
    });
    if(n) this._save();
  }

  // openGitWindow 는 Git 창을 활성화한다. 없으면 만든다 — 두 번 불러도 창은
  // 하나다 (FR-GIT-26). repo 를 주면 활성 리포까지 전환한다 (FR-GIT-15).
  async openGitWindow(repo){
    const win=this._gitWindow()||this._mkGitWindow(repo||null);
    if(repo) this.gitPanel.setRepo(repo);
    this.switchWindow(win.id);
    return win.id;
  }

  // _mkGitWindow 는 고정 탭 6개를 갖춘 Git 창을 만든다. _mkWindow 와 달리
  // _newTool 을 부르지 않는다 — Git 창의 초기 상태에는 PTY 가 필요 없다.
  _mkGitWindow(repo){
    const r=newEntityId();
    const tabs=GIT_VIEWS.map(v=>({id:newEntityId(),name:v.name,type:TAB_TYPE_GIT,gitView:v.key}));
    const s={
      id:newEntityId(),name:GIT_WINDOW_NAME,type:WINDOW_TYPE_GIT,
      // 활성 리포는 창에 붙는다 — 창이 곧 Git 표면이므로 (FR-GIT-29).
      git:{repo:repo||null},
      layout:{type:'pane',id:r,tabs,activeTab:tabs[0].id}
    };
    this.ws.windows.push(s);
    return s;
  }

  // ── 좌측 GIT 섹션 (FR-GIT-9~17) ──

  // GIT 섹션 배선. 진입점은 정적 요소이므로 리스너는 여기서 한 번만 붙인다.
  _initGitSection(){
    const add=document.getElementById('git-add-repo');
    if(add) add.addEventListener('click',()=>this._gitAddRepo());
    this._startGitReposPoll();
    this.gitPanel.init();
  }

  // _gitSignal 은 즉시 신호의 단일 진입점이다 (FR-GIT-18). 어디서 왔는지는 라벨로만
  // 남기고 처리는 GitPanel 이 한다 — 디바운스와 게이팅이 한 곳에 있어야 한다.
  _gitSignal(kind){ if(this.gitPanel) this.gitPanel.signal(kind) }

  /**
   * FR-GIT-41·185 의 Open File. addTab 의 editor 분기를 그대로 쓴다 — 이미 열려
   * 있으면 그 탭으로 이동한다.
   *
   * **Git 창에는 열지 않는다** (FR-GIT-179). 대상은 직전에 활성이었던 일반 창이고,
   * 없으면 만든다 (O15). 연 뒤 그 창을 활성화한다 — 열었는데 보이지 않으면
   * 사용자는 실패로 읽는다.
   */
  async _gitOpenFile(filePath){
    if(!filePath) return;
    const plain=this._plainWindows();
    let w=plain.find(s=>s.id===this._lastPlainWindow)||plain[0];
    if(!w) w=await this._mkWindow();
    if(!w||!w.layout) return;
    this.switchWindow(w.id);
    const rid=(w.focusedPane&&findPane(w.layout,w.focusedPane))?w.focusedPane:firstPane(w.layout)?.id;
    if(rid) await this.addTab(rid,'editor',{filePath,windowId:w.id});
  }

  // 목록은 주기적으로 갱신하되 탭이 숨겨졌으면 건너뛴다 — 보이지 않는 섹션을
  // 위해 요청을 살 이유가 없다 (_startStatsPoll 의 선례, FR-STAT-17).
  _startGitReposPoll(){
    if(this._gitReposInterval)clearInterval(this._gitReposInterval);
    if(!this._gitReposVisHook){
      this._gitReposVisHook=true;
      document.addEventListener('visibilitychange',()=>{
        if(!document.hidden)this._gitReposRefresh();
      });
    }
    this._gitReposInterval=setInterval(()=>{
      if(document.hidden)return;
      this._gitReposRefresh();
    },GIT_REPOS_POLL_MS);
    this._gitReposRefresh();
  }

  /**
   * _gitFocusToolId 는 follow 가 딛는 도구다 (FR-GIT-9).
   *
   * 포커스가 터미널이 아닐 때(Git 창·편집기 탭) **마지막 터미널을 유지한다.**
   * 빈 값을 보내면 서버가 자기 cwd 로 답하는데, 그것은 사용자가 가 본 적 없는
   * 리포다 — Git 창에 들어간 순간 follow 가 dongminal 로 바뀌는 결함이 그것이었다.
   * follow 는 "포커스된 터미널의 cwd" 이고, 터미널을 떠났다고 다른 리포를
   * 가리켜서는 안 된다 (FR-GIT-10 의 "임의로 유지하지 않는다"와 같은 뜻이다).
   */
  _gitFocusToolId(){
    const p=this._focusedTerminal();
    if(p){this._lastTermTool=p.id; return p.id}
    // 사라진 도구를 가리키면 서버가 다시 자기 cwd 로 답한다 — 살아 있는 것만 쓴다.
    if(this._lastTermTool&&this.tools.has(this._lastTermTool)) return this._lastTermTool;
    this._lastTermTool=null;
    return '';
  }

  // _gitReposRefresh 는 GIT 섹션의 목록을 갱신한다. 실패하면 이전 목록을 유지한다 —
  // 네트워크가 한 번 튀었다고 섹션이 비면 안 된다.
  async _gitReposRefresh(){
    let r;
    try{r=await fetch('/api/git/repos?tool='+encodeURIComponent(this._gitFocusToolId()))}catch{return}
    if(r.status===503){
      // git 이 없거나 서비스가 구성되지 않은 환경이다. 섹션 전체를 숨긴다.
      this._gitOff=true;this.renderer._rGitSection();return;
    }
    if(!r.ok) return;
    let d;
    try{d=await r.json()}catch{return}
    this._gitOff=false;this._gitRepos=d;
    // 전체 render() 를 부르지 않는다 — 터미널 재부착 비용이 크다.
    this.renderer._rGitSection();
  }

  // FR-GIT-12: 경로를 물어 핀한다. M1 에는 공통 다이얼로그가 없으므로 prompt 를
  // 쓴다 (다이얼로그 규약은 M5 묶음 P).
  _gitAddRepo(){
    const v=window.prompt(GIT_ADD_REPO_PROMPT,this._cwd||'');
    if(v===null) return;
    const path=v.trim(); if(!path) return;
    this._gitPin(path);
  }

  /**
   * FR-GIT-223: 핀 순서 재배치. 창 순서와 달리 **서버가 권위**이므로(O1) 여기서
   * 배열을 고치지 않고 서버가 준 목록을 받는다.
   *
   * 목록 전체가 아니라 (src, target, before) 를 보낸다 — 그 사이에 다른 창이 핀을
   * 더했을 때 전체를 보내면 그것을 조용히 지운다.
   */
  async _gitReorder(dr){
    if(!dr||dr.done||!dr.src||!dr.target||dr.src===dr.target) return;
    dr.done=true;
    let r=null,d=null;
    try{
      r=await fetch('/api/git/repos/reorder',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({src:dr.src,target:dr.target,before:!!dr.before})});
    }catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(!r||!r.ok||!d) return;
    this._gitPinsApply(d.pinned);
  }

  // _gitPin 은 경로를 검증해 핀한다. 저장소가 아니면 사유를 보인다 (FR-GIT-12) —
  // 조용히 실패하지 않는다.
  async _gitPin(path){
    if(!path) return false;
    let r,d;
    try{
      r=await fetch('/api/git/repos/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
      d=await r.json();
    }catch(err){window.alert(GIT_PIN_FAIL_LABEL+': '+err);return false}
    if(!r.ok){window.alert(GIT_PIN_FAIL_LABEL+' ('+(d&&d.error)+'): '+(d&&d.message));return false}
    this._gitPinsApply(d.pinned);
    await this._gitReposRefresh();
    return true;
  }

  async _gitUnpin(path){
    if(!path) return false;
    let r,d;
    try{
      r=await fetch('/api/git/repos/unpin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
      d=await r.json();
    }catch{return false}
    if(!r.ok) return false;
    this._gitPinsApply(d.pinned);
    await this._gitReposRefresh();
    return true;
  }

  // 핀은 workspace.json 최상위 git.pinned 에 산다 (O1). 서버가 고친 값을 로컬
  // 사본에도 반영해 둔다 — 다음 _save() 의 PUT 이 방금 만든 핀을 지우지 않게.
  _gitPinsApply(pinned){
    if(!Array.isArray(pinned)) return;
    if(!this.ws.git) this.ws.git={};
    this.ws.git.pinned=pinned;
  }

  async delWindow(sid){
    const i=this.ws.windows.findIndex(s=>s.id===sid);
    if(i<0) return;
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
    if(!this.ws.windows.length){await this._mkWindow();this.render();return}
    if(this.ws.activeWindow===sid){
      this.ws.activeWindow=this.ws.windows[Math.min(i,this.ws.windows.length-1)].id;
      try{sessionStorage.setItem('activeWindow', this.ws.activeWindow)}catch{}
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
  }

  switchWindow(sid){
    if(this.ws.activeWindow===sid){
      if(this.isMobile && this._drawerOpen) this._toggleDrawer(false);
      return;
    }
    const cur=this._aw();if(cur)cur.focusedPane=this.focused;
    // FR-GIT-185: Open File 이 돌아갈 창을 기억한다 — 규칙이 하나여야 "어디에
    // 열렸는지 모르겠다"가 없다 (O15).
    if(cur&&!this._isGitWin(cur)) this._lastPlainWindow=cur.id;
    this.ws.activeWindow=sid;
    // Persist per-window activeWindow to sessionStorage (survives refresh,
    // independent across windows).
    try{sessionStorage.setItem('activeWindow', sid)}catch{}
    const a=this._aw();
    if(a&&a.layout){
      const next=(a.focusedPane&&findPane(a.layout,a.focusedPane))?a.focusedPane:firstPane(a.layout)?.id||null;
      this._setFocus(next, a);
    } else this.focused=null;
    this._mPaneIdx=0;
    if(this.isMobile && this._drawerOpen) this._toggleDrawer(false);
    this._focusWindow(sid);
    // FR-GIT-22: Git 창이 활성인지가 폴링 게이팅의 조건 하나다 — 창 전환은 재평가 시점이다.
    this.gitPanel._reschedule();
    this._save(); this.render();
  }

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
  }

  async addTab(rid, type = 'terminal', opts = {}) {
    // opts.windowId 지정 시 비활성 창의 pane 에도 추가 가능 (FR-RST-4).
    const s = opts.windowId ? this.ws.windows.find(x => x.id === opts.windowId) : this._aw();
    if (!s) return;
    // FR-GIT-179: Git 창의 탭은 고정 6개뿐이다 — 더할 수 없다.
    if (this._isGitWin(s)) return;
    const pn = findPane(s.layout, rid); if (!pn) return;
    if (type === 'editor') {
      if (!opts.filePath) { console.warn('[addTab] editor tab requires filePath'); return }
      const existing = this._findEditorTab(opts.filePath);
      if (existing) {
        const cur = this._aw(); if (cur) cur.focusedPane = this.focused;
        this.ws.activeWindow = existing.win.id;
        try{sessionStorage.setItem('activeWindow', existing.win.id)}catch{}
        existing.pane.activeTab = existing.tab.id;
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
      pn.tabs.push({ id: t, name, type: 'editor', filePath: opts.filePath });
      pn.activeTab = t;
      this.render();
      this._save();
      return;
    }
    const ref = this._paneNewToolRef(s, rid);
    const p = await this._newTool(ref.cwd || null, ref.cwd ? null : (ref.cwdTool || null));
    const t = newEntityId();
    const name = (typeof opts.name === 'string' && opts.name ? opts.name : 'Shell').slice(0, 64);
    pn.tabs.push({ id: t, name, type: 'terminal', toolId: p.id });
    // FR-RST-4: keepFocus 면 대상 pane 의 활성 탭도 바꾸지 않는다 (백그라운드 추가).
    if (!opts.keepFocus) pn.activeTab = t;
    this.render();
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 tab id+toolId 반환 (echo 용).
    return { uuid: t, toolId: p.id };
  }

  async closeTab(rid,tid,sid,opts={}){
    // sid 를 지정하면 해당 창의 탭을 닫는다 (비활성 창 대상도 지원).
    // 지정 안 하면 기존 동작: 활성 창에서 닫는다.
    const s = sid ? this.ws.windows.find(x=>x.id===sid) : this._aw();
    if(!s) return;
    const pn=findPane(s.layout,rid); if(!pn) return;
    const tab=pn.tabs.find(t=>t.id===tid); if(!tab) return;
    // FR-GIT-28: Git 창의 고정 탭은 생성·삭제되지 않는다.
    if(tab.type===TAB_TYPE_GIT) return;
    const isEditor=tab.type==='editor';
    if(isEditor){
      const editor=this.fileEditors.get(tab.id);
      if(editor && editor._dirty){
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
      if(!opts.keepTool && await this._isToolBusy(tab.toolId)){
        const r=await this._confirmClose('실행 중인 프로세스가 있습니다. 탭을 닫으시겠습니까?',
          {bgBtn:toolBackgroundCapable(tab.type)});
        if(!r) return;
        if(r==='background') opts={...opts,keepTool:true};
      }
    }
    const toolId=tab.toolId;
    const closingIdx=pn.tabs.findIndex(t=>t.id===tid);
    pn.tabs=pn.tabs.filter(t=>t.id!==tid);
    const prevClosestId=pn.tabs.length?pn.tabs[Math.min(closingIdx,pn.tabs.length-1)].id:null;
    const isActive = s.id === this.ws.activeWindow;
    if(pn.tabs.length===0){
      s.layout=doRemove(s.layout,rid);
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
      pn.activeTab=pn.tabs[Math.min(closingIdx,pn.tabs.length-1)].id;
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
  }

  switchTab(rid,tid){
    const s=this._aw(); if(!s) return;
    const pn=findPane(s.layout,rid); if(!pn) return;
    if(pn.activeTab===tid && this.focused===rid){this._setFocus(rid, s); return}
    pn.activeTab=tid; this._setFocus(rid, s);
    this._save(); this.render();
  }

  // split is serialized through this._splitChain so that rapid successive
  // calls (e.g. holding the shortcut) don't race on this.focused: each call
  // waits for the previous to finish — including the _setFocus that updates
  // the new target — before reading focus or layout state.
  split(dir,opts={}){
    const prev=this._splitChain||Promise.resolve();
    const next=prev.then(()=>this._splitInner(dir,opts)).catch(err=>{console.error('[split] error',err)});
    this._splitChain=next.finally(()=>{ if(this._splitChain===next) this._splitChain=null; });
    return next;
  }

  async _splitInner(dir,opts={}){
    if(this.isMobile && !opts.force) return;
    const tgtWindowId=opts.targetWindow||this.ws.activeWindow;
    let s=this.ws.windows.find(x=>x.id===tgtWindowId);
    // FR-GIT-179: Git 창은 닫힌 창이다 — 분할 칸을 만들 수 없다.
    if(this._isGitWin(s)) return;
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
      const p=await this._newTool(ref.cwd || null, refPaneId);
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
  }

  _paneNewToolRef(sess,rid){
    const pn=findPane(sess.layout,rid);if(!pn)return {};
    const tab=pn.tabs.find(t=>t.id===pn.activeTab);
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
  }
  switchTabPrev(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    const i=pn.tabs.findIndex(t=>t.id===pn.activeTab);if(i<0)return;
    this.switchTab(pn.id,pn.tabs[(i-1+pn.tabs.length)%pn.tabs.length].id);
  }
  switchTabNext(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    const i=pn.tabs.findIndex(t=>t.id===pn.activeTab);if(i<0)return;
    this.switchTab(pn.id,pn.tabs[(i+1)%pn.tabs.length].id);
  }
  // FR-GIT-182: 순환은 일반 창만 돈다. Git 창에 있으면 순환의 첫 창으로 **나간다**
  // — 단축키가 막다른 길이 되면 사용자는 고장으로 읽는다 (FR-GIT-184).
  _cycleWindow(step){
    const arr=this._plainWindows(); if(!arr.length) return;
    const i=arr.findIndex(s=>s.id===this.ws.activeWindow);
    if(i<0){this.switchWindow(arr[0].id);return}
    if(arr.length<2) return;
    this.switchWindow(arr[(i+step+arr.length)%arr.length].id);
  }
  switchWindowPrev(){this._cycleWindow(-1)}
  switchWindowNext(){this._cycleWindow(1)}
  paneNavigate(dir){
    const s=this._aw();if(!s||!this.focused)return;
    const path=findPath(s.layout,this.focused);if(!path||path.length<2)return;
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
  }
  addTabFocused(){if(this.focused)this.addTab(this.focused,'terminal')}
  closeTabFocused(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    this.closeTab(pn.id,pn.activeTab);
  }
  closeWindowActive(){this.delWindow(this.ws.activeWindow)}

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

  // ── Search ──
  toggleSearch(){
    const bar=document.getElementById('search-bar');
    if(!bar.classList.contains('hidden')){this.closeSearch();return}
    bar.classList.remove('hidden');
    document.getElementById('search-input').focus();
    for(const pane of this.tools.values())if(pane.el.classList.contains('vis'))pane.doFit();
  }
  closeSearch(){
    const bar=document.getElementById('search-bar');
    bar.classList.add('hidden');
    document.getElementById('search-input').value='';
    document.getElementById('search-count').textContent='';
    this._clearAllSearchDecorations();
    this._focusedTerminal()?.focus();
    for(const pane of this.tools.values())if(pane.el.classList.contains('vis'))pane.doFit();
  }
  _clearAllSearchDecorations(){
    for(const p of this.tools.values())if(p.search)p.search.clearDecorations();
  }
  _searchOpen(){return !document.getElementById('search-bar').classList.contains('hidden')}
  _researchIfOpen(){
    if(!this._searchOpen())return;
    setTimeout(()=>this._doSearch('next'),50);
  }
  _focusedTerminal(){
    if(!this.focused)return null;
    const s=this._aw();if(!s)return null;
    const pn=findPane(s.layout,this.focused);if(!pn)return null;
    const tab=pn.tabs.find(t=>t.id===pn.activeTab);
    if(!tab||tab.type!=='terminal')return null;
    return this.tools.get(tab.toolId);
  }
  _doSearch(dir){
    const p=this._focusedTerminal();if(!p||!p.search)return;
    const q=document.getElementById('search-input').value;
    const cs=document.getElementById('search-case').classList.contains('active');
    if(!q){document.getElementById('search-count').textContent='';return}
    const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const ab=getComputedStyle(document.documentElement).getPropertyValue('--accent-border').trim();
    const danger=getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const opts={regex:false,wholeWord:false,caseSensitive:cs,incremental:true,
      decorations:{matchBackground:hexToRgba(accent,.4),matchBorder:ab,
        activeMatchBackground:hexToRgba(danger,.5),activeMatchBorder:danger}};
    const found=dir==='prev'?p.search.findPrevious(q,opts):p.search.findNext(q,opts);
    document.getElementById('search-count').textContent=found!==undefined?(found?'':'없음'):'';
  }

  setFocus(rid){
    // Claim window ownership on every click — even if focus doesn't change,
    // the user is asserting "I want this window" (multi-window).
    this._focusWindow(this.ws.activeWindow);
    if(this.focused===rid) return;
    this._clearAllSearchDecorations();
    this._setFocus(rid);
    this._prevFocus=rid;
    document.querySelectorAll('.pn').forEach(el=>{
      el.classList.toggle('focused',el.dataset.paneid===rid);
    });
    this._researchIfOpen();
    this._updateCwd();
    // 칸 포커스가 바뀌면 follow 대상도 바뀔 수 있다 (FR-GIT-9).
    this._gitReposRefresh();
    this._updateStatusBar();
    this._save();
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

  // ═══════════════════════════════════════════════════════════════════════
  //  Window Focus Ownership (multi-window)
  // ═══════════════════════════════════════════════════════════════════════
  //
  //  Rules:
  //    • Each window has ONE focus owner — the last window that focused on it.
  //    • The owner controls PTY size for that window's panes.
  //    • All other windows see that window dimmed (pn-dimmed overlay).
  //    • If no window owns a window, all windows see it bright.
  //
  //  State:
  //    _windowFocusOwner : { windowId → clientId } — server-authoritative
  //    _windowFocused      : boolean (OS focus on this client)
  //
  //  Transport (FR-XDF-5/6): the server owns the map. Claims go out as
  //  POST /api/focus/claim; every change comes back over the existing command
  //  SSE as a `window_focus` event carrying the FULL map. The previous
  //  BroadcastChannel('dongminal-focus') path is gone — it was same-browser
  //  same-origin only, so it never reached another device, and under --expose
  //  even localhost:PORT and <host-ip>:PORT were isolated (SRS §2.7).
  //
  //  Release (FR-XDF-9): the server releases when the SSE subscription drops.
  //  There is no `beforeunload` handler — it does not fire on a remote device's
  //  force-quit or network loss, which left ownership stuck forever.
  //
  //  Single entry point:
  //    _focusWindow(sid)  — claim ownership, POST, resize, overlay.
  //    Called from: setFocus, switchWindow, _focusLocation, _jumpToTool,
  //                 _mkWindow, addTab(existing), window.focus, split.
  // ═══════════════════════════════════════════════════════════════════════

  // _initFocusSync wires the OS focus listeners. Ownership transport lives in
  // _focusClaim (out) and the `window_focus` SSE branch (in).
  _initFocusSync(){
    window.addEventListener('focus',()=>{
      this._windowFocused=true;
      if(this.ws.activeWindow) this._focusWindow(this.ws.activeWindow);
    });
    window.addEventListener('blur',()=>{this._windowFocused=false});
  }

  // _focusWindow is the SINGLE entry point for claiming window ownership.
  // Applies the claim locally, posts it to the server (which broadcasts the
  // full map to every client), sends resize, and updates the overlay.
  _focusWindow(windowId){
    if(!windowId) return;
    let changed=false;
    // Release other windows this client owns (one client → one window).
    for(const sid of Object.keys(this._windowFocusOwner)){
      if(sid!==windowId&&this._windowFocusOwner[sid]===this.clientId){
        delete this._windowFocusOwner[sid];
        changed=true;
      }
    }
    if(this._windowFocusOwner[windowId]!==this.clientId){
      this._windowFocusOwner[windowId]=this.clientId;
      changed=true;
    }
    // Only post if ownership actually changes — otherwise every click on an
    // already-owned window would hit the server.
    if(changed) this._focusClaim(windowId);
    // Send resize immediately (before render) so PTY matches this window's
    // size by the time the user sees the panes. Only if OS-focused.
    if(this._windowFocused) this._resendWindowSizes(windowId);
    this._applyFocusOverlay();
  }

  // _focusClaim posts ownership to the server (FR-XDF-7). The server answers by
  // broadcasting the full owner map, which is what actually converges every
  // client — this POST is fire-and-forget.
  _focusClaim(windowId){
    fetch('/api/focus/claim',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({clientId:this.clientId,windowId})}).catch(()=>{});
  }

  // _focusRestore aligns local state with the server on SSE connect
  // (FR-XDF-11), then RE-CLAIMS if this client holds OS focus (FR-XDF-12).
  //
  // The re-claim is not optional. The server releases ownership the moment the
  // subscription drops (FR-XDF-9), so after a reconnect nobody owns the window
  // — and without re-claiming, _focusWindow's "only if ownership changes" guard
  // would never fire again for a client that still remembers owning it.
  // Re-claiming only when OS-focused keeps a backgrounded device from stealing
  // the PTY size back from the active one (FR-XDF-13).
  _focusRestore(){
    fetch('/api/focus').then(r=>r.ok?r.json():null).then(j=>{
      if(!j) return;
      this._windowFocusOwner=j.owners||{};
      this._applyFocusOverlay();
      if(this._windowFocused&&this.ws.activeWindow) this._focusWindow(this.ws.activeWindow);
    }).catch(()=>{});
  }

  // _resizeCheck returns true if this window is allowed to send resize for
  // a given pane (has OS focus + owns the pane's window or it's unowned).
  _resizeCheck(toolId){
    if(!this._windowFocused) return false;
    const sid=this._toolWindowId(toolId);
    if(!sid) return true; // pane not in any window yet → allow
    const owner=this._windowFocusOwner[sid];
    return !owner||owner===this.clientId;
  }

  // _applyFocusOverlay syncs the DOM: panes whose window is owned by
  // another window get the dimmed overlay (pn-dimmed class).
  _applyFocusOverlay(){
    const otherOwned=new Set();
    for(const[sid,owner] of Object.entries(this._windowFocusOwner)){
      if(owner&&owner!==this.clientId) otherOwned.add(sid);
    }
    for(const pn of document.querySelectorAll('.pn')){
      let dim=false;
      for(const t of pn.querySelectorAll('.pn-tab[data-toolid]')){
        const sid=this._toolWindowId(t.dataset.toolid);
        if(sid&&otherOwned.has(sid)){dim=true;break}
      }
      pn.classList.toggle('pn-dimmed',dim);
    }
  }

  // _toolWindowId returns the window id containing a pane (by walking the
  // workspace layout tree). Returns null if the pane is not in any window.
  _toolWindowId(toolId){
    if(!toolId) return null;
    for(const s of this.ws.windows){
      if(!s||!s.layout) continue;
      let found=null;
      const walk=n=>{
        if(!n||found) return;
        if(n.type==='pane'&&n.tabs){
          for(const t of n.tabs) if(t.toolId===toolId){found=s.id;return}
        }
        if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
      };
      walk(s.layout);
      if(found) return found;
    }
    return null;
  }

  // _resendWindowSizes sends resize for every pane in a window.
  // Sends even for hidden panes (they retain last-visible dimensions) so the
  // PTY is sized correctly BEFORE render, avoiding a one-frame glitch.
  _resendWindowSizes(windowId){
    if(!windowId) return;
    // Don't send resize if another window owns this window.
    const owner=this._windowFocusOwner[windowId];
    if(owner&&owner!==this.clientId) return;
    const s=this.ws.windows.find(x=>x.id===windowId);
    if(!s||!s.layout) return;
    const toolIds=new Set();
    const walk=n=>{
      if(!n) return;
      if(n.type==='pane'&&n.tabs){
        for(const t of n.tabs) if(t.toolId) toolIds.add(t.toolId);
      }
      if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
    };
    walk(s.layout);
    for(const pid of toolIds){
      const p=this.tools.get(pid);
      // Send resize even if pane is hidden — the dimensions were set when
      // it was last visible and are still valid. This avoids a visible
      // glitch where the PTY renders at the wrong size for one frame.
      if(!p||!p.term||!p.term.cols||!p.term.rows) continue;
      const m=new Uint8Array(5);m[0]=0x01;
      new DataView(m.buffer).setUint16(1,p.term.cols,false);
      new DataView(m.buffer).setUint16(3,p.term.rows,false);
      p._send(m);
    }
  }

  // ── Mobile bindings ──

  _initMobile(){
    // Topbar mobile buttons
    const prev=document.getElementById('m-pane-prev');
    const next=document.getElementById('m-pane-next');
    const addT=document.getElementById('m-add-tab');
    const srch=document.getElementById('m-search-btn');
    const drwr=document.getElementById('m-drawer-toggle');
    const bd=document.getElementById('drawer-backdrop');
    if(prev) prev.addEventListener('click',()=>this.navMobilePane(-1));
    if(next) next.addEventListener('click',()=>this.navMobilePane(1));
    if(addT) addT.addEventListener('click',()=>{
      const pn=this._mobileCurrentPane(); if(pn) this.addTab(pn.id);
    });
    if(srch) srch.addEventListener('click',()=>this.toggleSearch&&this.toggleSearch());
    if(drwr) drwr.addEventListener('click',()=>{this._toggleDrawer();this._rTopbar()});
    if(bd) bd.addEventListener('click',()=>{this._toggleDrawer(false);this._rTopbar()});
    // Drawer close button injected into sidebar (visible only on mobile)
    const sb=document.getElementById('sidebar');
    if(sb && !sb.querySelector('.drawer-close')){
      const xb=document.createElement('button');
      xb.className='drawer-close';xb.textContent='✕';xb.title='닫기';
      xb.addEventListener('click',()=>{this._toggleDrawer(false);this._rTopbar()});
      sb.insertBefore(xb, sb.firstChild);
    }
    // Auto-close drawer on window switch (mobile)
    // (handled in switchWindow via _drawerOpen check)

    // Display Settings panel sync
    const dsMode=document.getElementById('ds-mode');
    const dsBp=document.getElementById('ds-bp');
    if(dsMode){
      dsMode.value=this.displayMode;
      dsMode.addEventListener('change',()=>{
        this.displayMode=dsMode.value;
        this.render();
      });
    }
    if(dsBp){
      dsBp.value=this.mobileBreakpoint;
      dsBp.addEventListener('change',()=>{
        let v=parseInt(dsBp.value,10);
        if(!(v>=320&&v<=2000)){v=768;dsBp.value=v}
        this.mobileBreakpoint=v;
        this.render();
      });
    }
  }

  _initMobileKeybar(){
    const bar=document.getElementById('mobile-keybar');
    if(!bar) return;
    bar.innerHTML='';
    const keys=[
      {label:'Esc',send:''},
      {label:'Tab',send:'\t'},
      {label:'Ctrl',mod:'ctrl'},
      {label:'Alt',mod:'alt'},
      {label:'↑',send:'[A'},
      {label:'↓',send:'[B'},
      {label:'←',send:'[D'},
      {label:'→',send:'[C'},
      {label:'|',send:'|'},
      {label:'~',send:'~'},
      {label:'/',send:'/'},
      {label:'-',send:'-'},
      {label:'Home',send:'[H'},
      {label:'End',send:'[F'},
      {label:'PgUp',send:'[5~'},
      {label:'PgDn',send:'[6~'},
    ];
    const FULL_NAMES={
      'Esc':'Escape','Tab':'Tab','Ctrl':'Control (modifier)','Alt':'Alt (modifier)',
      '↑':'Arrow Up','↓':'Arrow Down','←':'Arrow Left','→':'Arrow Right',
      '|':'Pipe','~':'Tilde','/':'Slash','-':'Hyphen',
      'Home':'Home','End':'End','PgUp':'Page Up','PgDn':'Page Down',
    };
    this._modKbd={ctrl:false,alt:false};
    const refresh=()=>{
      bar.querySelectorAll('.mkb-btn[data-mod]').forEach(b=>{
        const m=b.dataset.mod, st=this._modKbd[m];
        b.classList.toggle('sticky', st===true);
        b.classList.toggle('locked', st==='lock');
      });
    };
    const sendToFocused=(s)=>{
      const p=this._focusedTerminal();
      if(!p) return;
      let out=s;
      // Ctrl modifier: convert printable a-z/A-Z to ctrl code (1-26)
      if(this._modKbd.ctrl && s.length===1){
        const c=s.charCodeAt(0);
        if(c>=0x40 && c<=0x7e) out=String.fromCharCode(c & 0x1f);
      }
      // Alt prefix: ESC + char
      if(this._modKbd.alt && out.length>=1 && !out.startsWith('')){
        out=''+out;
      }
      if(p.term){try{p.term.focus()}catch{}}
      try{
        const bts=enc.encode(out);
        const msg=new Uint8Array(1+bts.length);msg[0]=OP.INPUT;msg.set(bts,1);
        p._send(msg);
      }catch{}
      // Clear sticky (not lock)
      if(this._modKbd.ctrl===true) this._modKbd.ctrl=false;
      if(this._modKbd.alt===true) this._modKbd.alt=false;
      refresh();
    };
    const showTip=(text, btn)=>{
      let tip=document.getElementById('mkb-tip');
      if(!tip){tip=document.createElement('div');tip.id='mkb-tip';document.body.appendChild(tip)}
      tip.textContent=text;
      const r=btn.getBoundingClientRect();
      tip.style.left=(r.left+r.width/2)+'px';
      tip.style.top=(r.top-8)+'px';
    };
    const hideTip=()=>{const t=document.getElementById('mkb-tip');if(t)t.remove()};
    for(const k of keys){
      const b=document.createElement('button');
      b.className='mkb-btn';b.textContent=k.label;b.type='button';
      const full=FULL_NAMES[k.label]||k.label;
      b.title=full;b.setAttribute('aria-label',full);
      if(k.mod){b.dataset.mod=k.mod}
      // 마우스 경로에서만 포커스 탈취를 막는다. touchstart 에서 preventDefault
      // 하면 브라우저가 합성 click 과 스크롤을 함께 취소해, 실기기에서 버튼이
      // 아무 반응도 하지 않고 키바 슬라이드도 막힌다 (FR-MTB-1/3).
      b.addEventListener('mousedown',e=>e.preventDefault());

      let lastTap=0;          // 모디파이어 더블탭(lock) 판정
      let pressTimer=null;
      let longPressFired=false;
      let startPt=null;       // 터치 시작 좌표 — 이동 거리 판정의 기준
      let moved=false;        // TAP_SLOP 초과 = 스크롤 제스처
      let lastTouchEndAt=0;   // 합성 click(ghost click) 억제용

      const cancelPress=()=>{
        if(pressTimer){clearTimeout(pressTimer);pressTimer=null}
      };
      const activate=()=>{
        if(k.mod){
          const now=Date.now();
          const dbl=(now-lastTap)<MKB_DOUBLE_TAP_MS;
          lastTap=now;
          const cur=this._modKbd[k.mod];
          if(dbl){this._modKbd[k.mod]=(cur==='lock')?false:'lock'}
          else{this._modKbd[k.mod]=cur?false:true}
          refresh();
        }else{
          sendToFocused(k.send);
        }
      };

      b.addEventListener('touchstart',e=>{
        const t=e.touches[0];
        startPt=t?{x:t.clientX,y:t.clientY}:null;
        moved=false;longPressFired=false;
        cancelPress();
        pressTimer=setTimeout(()=>{longPressFired=true;showTip(full,b)},MKB_LONG_PRESS_MS);
      },{passive:true});

      // FR-MTB-5: 이동 거리 임계값으로 판정한다. touchmove 발생만으로 취소하면
      // 손떨림에도 롱프레스가 죽고, 스크롤과 공존할 수 없다.
      b.addEventListener('touchmove',e=>{
        if(!startPt||moved) return;
        const t=e.touches[0];
        if(!t) return;
        if(Math.abs(t.clientX-startPt.x)>MKB_TAP_SLOP_PX||Math.abs(t.clientY-startPt.y)>MKB_TAP_SLOP_PX){
          moved=true;cancelPress();hideTip();longPressFired=false;
        }
      },{passive:true});

      b.addEventListener('touchcancel',()=>{
        cancelPress();hideTip();
        startPt=null;moved=false;longPressFired=false;
        lastTouchEndAt=Date.now();
      });

      b.addEventListener('touchend',e=>{
        cancelPress();
        const wasLong=longPressFired, wasMoved=moved;
        startPt=null;moved=false;longPressFired=false;
        lastTouchEndAt=Date.now();
        if(wasLong){hideTip();e.preventDefault();return}
        if(wasMoved) return;              // 스크롤 제스처 — 키를 보내지 않는다
        e.preventDefault();               // 합성 click 억제. 여기서 직접 처리한다
        activate();
      });

      b.addEventListener('click',e=>{
        e.preventDefault();
        // FR-MTB-2: 터치 제스처가 합성한 click 은 무시한다 — touchend 가 이미
        // 처리했다. 시간 기준을 쓰는 이유는, 플래그를 쓰면 preventDefault 로
        // click 이 오지 않은 경우 플래그가 남아 다음 마우스 클릭을 먹는다.
        if(Date.now()-lastTouchEndAt<MKB_GHOST_CLICK_MS) return;
        activate();
      });
      bar.appendChild(b);
    }
    // visualViewport tracking — keyboard up/down detection
    if(window.visualViewport){
      const vv=window.visualViewport;
      const kbH_PX=()=>{
        const v=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m-kb-h'));
        return isFinite(v)?v:38;
      };
      const apply=()=>{
        if(!this.isMobile){
          document.body.classList.remove('keyboard-up');
          document.body.style.paddingTop='';
          document.body.style.paddingBottom='';
          bar.style.bottom='';
          return;
        }
        // FR-MKV-3: layout viewport 가 키보드만큼 함께 줄어드는 환경
        // (interactive-widget=resizes-content 를 지원하는 Chromium·Firefox)에서는
        // innerHeight 도 줄어 kbH 가 0 에 수렴하므로 이 보정이 스스로 비활성된다.
        // 엔진 판별을 하지 않는 이유다. WebKit 은 그 키를 무시하므로 여기가 유일한 수단이다.
        const kbH=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        const isUp=kbH > 80;
        document.body.classList.toggle('keyboard-up', isUp);
        if(isUp){
          bar.style.bottom = kbH + 'px';
          // FR-MKV-4: WebKit 은 포커스된 요소를 드러내려 visual viewport 를 위로
          // 스크롤한다. 그 스크롤은 overflow:hidden 으로 막을 수 없고 레이아웃은
          // layout viewport 좌표계에 그대로 남으므로, 상쇄하지 않으면 화면 상단
          // (topbar)이 가시 영역 밖으로 밀린다 — 사용자가 본 증상이 이것이다.
          //
          // padding-top 으로 상쇄하면 body 의 content box 가
          // [offsetTop, innerHeight-kbH-키바높이] 로 내려앉아 가시 영역 안에 정확히
          // 들어간다. kbH 는 이미 offsetTop 을 뺀 값이므로 padding-bottom 계산은
          // 바뀌지 않고, 키바(position:fixed, bottom:kbH)와도 틈 없이 맞물린다.
          //
          // transform 이 아니라 padding 인 이유: transform 은 fixed 자손의 컨테이닝
          // 블록을 만들어 키바의 bottom 기준을 layout viewport 에서 #app 으로 바꾼다.
          document.body.style.paddingTop = vv.offsetTop + 'px';
          document.body.style.paddingBottom = (kbH + kbH_PX()) + 'px';
        }else{
          bar.style.bottom = '';
          document.body.style.paddingTop = '';
          document.body.style.paddingBottom = '';
        }
        // Refit terminal
        for(const p of this.tools.values()){if(p.el.classList.contains('vis'))p.doFit()}
      };
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      apply();
    }
  }


  async _saveSettings(){
    // 블롭 전체를 갈아치우므로 읽어 쓰는 값은 전부 실어야 한다 — git 주기(FR-GIT-23)는
    // UI 가 없지만 여기서 빠지면 다른 설정을 건드릴 때 조용히 사라진다.
    try{await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({themeName:customTheme?null:currentThemeName,customTheme,shortcuts,statusBar,statsInterval,gitSignatureInterval,gitStatusInterval,layoutPresets,defaultPreset})})}catch{}
  }

  // ── Modal & Theme ──

  _initModal(){
    const overlay=document.getElementById('modal-overlay');
    const modal=document.getElementById('modal');
    document.getElementById('settings-btn').addEventListener('click',()=>{
      overlay.classList.add('open');
      this._renderThemePanel();this._renderShortcutList();this._renderPresets();
      const dsMode=document.getElementById('ds-mode');
      const dsBp=document.getElementById('ds-bp');
      if(dsMode) dsMode.value=this.displayMode;
      if(dsBp) dsBp.value=this.mobileBreakpoint;
      // Auto-close drawer when opening settings on mobile
      if(this.isMobile && this._drawerOpen){this._toggleDrawer(false);this._rTopbar()}
    });
    document.getElementById('modal-close').addEventListener('click',()=>overlay.classList.remove('open'));
    overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.classList.remove('open')});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('open')){e.preventDefault();overlay.classList.remove('open')}});
    modal.querySelectorAll('.mtab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        modal.querySelectorAll('.mtab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        modal.querySelectorAll('.mpanel').forEach(p=>p.style.display='none');
        document.getElementById('panel-'+tab.dataset.tab).style.display='';
        if(tab.dataset.tab==='presets')this._renderPresets();
      });
    });
  }

  _renderThemePanel(){
    const list=document.getElementById('theme-list'); list.innerHTML='';
    const activeName=customTheme?null:currentThemeName;
    const groups={dark:[],light:[]};
    for(const name of Object.keys(THEMES)){
      const t=THEMES[name];
      (t.mode==='light'?groups.light:groups.dark).push(name);
    }
    const renderGroup=(label,names)=>{
      if(!names.length) return;
      const hdr=document.createElement('div');
      hdr.className='tl-section'; hdr.textContent=label;
      list.appendChild(hdr);
      for(const name of names){
        const t=THEMES[name];
        const item=document.createElement('div');
        item.className='tl-item'+(name===activeName?' active':'');
        const keys=['bg','accent','text','border','danger'];
        let dots='<div class="tl-dots">';
        for(const k of keys){const v=t.ui[k];dots+=`<span style="background:${v}"></span>`}
        dots+='</div>';
        item.innerHTML=`${dots}<span class="tl-name">${name}</span>`;
        item.addEventListener('click',()=>{
          currentThemeName=name; customTheme=null;
          applyThemeObj(t); this._renderThemePanel(); this._hideCustomEditor();
          this._saveSettings();
        });
        list.appendChild(item);
      }
    };
    renderGroup('Dark', groups.dark);
    renderGroup('Light', groups.light);
    this._renderPreview();
  }

  _renderPreview(){
    const t=getCurrentTheme();
    const u=t.ui, tr=t.terminal;
    const ah=hexToRgba(u.accent,.08);
    const c=tr; // shorthand
    document.getElementById('theme-preview').innerHTML=`
    <div style="display:flex;height:100%">
      <div class="pv-sidebar" style="background:${u.sidebarBg};border-right:1px solid ${u.border}">
        <div style="font-size:6px;color:${u.textMuted};padding:4px 2px;letter-spacing:.05em">SESSIONS</div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px">
          <div class="pv-dot" style="background:${u.accent}"></div>
          <span style="font-size:7px;color:${u.textBright}">Main</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto">×</span>
        </div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px;background:${ah}">
          <div class="pv-dot" style="background:${u.accent}"></div>
          <span style="font-size:7px;color:${u.textBright};font-weight:600">Work</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto">×</span>
        </div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px">
          <div class="pv-dot" style="background:${u.textDim}"></div>
          <span style="font-size:7px;color:${u.text}">Test</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto;opacity:.4">×</span>
        </div>
      </div>
      <div class="pv-main" style="background:${u.bg}">
        <div class="pv-topbar" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
          <span style="color:${u.text}">Work</span>
          <span style="flex:1"></span>
          <span style="color:${u.textMuted};font-size:7px;border:1px solid ${u.accentBorder};border-radius:2px;padding:0 3px">Split H</span>
          <span style="color:${u.accent};font-size:7px;border:1px solid ${u.accentBorder};border-radius:2px;padding:0 3px">Split V</span>
        </div>
        <div class="pv-split">
          <div class="pv-split-left" style="border:2px solid ${u.accent}">
            <div class="pv-tabs" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
              <div class="pv-tab" style="color:${u.textMuted};border-right:1px solid ${u.border}">Shell <span style="color:${u.danger}">×</span></div>
              <div class="pv-tab" style="color:${u.textBright};background:${ah};border-bottom:1px solid ${u.accent}">vim <span style="color:${u.danger}">×</span></div>
            </div>
            <div class="pv-term" style="background:${c.background};color:${c.foreground}">
              <span style="color:${c.green}">$</span> <span style="color:${c.cyan}">echo</span> <span style="color:${c.yellow}">"palette"</span><br>
              <span style="background:${c.selectionBackground};color:${c.selectionForeground}">selected text here █</span><br>
              <span style="color:${c.red}">● Red</span> <span style="color:${c.green}">● Grn</span> <span style="color:${c.yellow}">● Ylw</span> <span style="color:${c.blue}">● Blu</span><br>
              <span style="color:${c.magenta}">● Mag</span> <span style="color:${c.cyan}">● Cyn</span> <span style="color:${c.white}">● Wht</span> <span style="color:${c.brightBlack}">● Bk</span><br>
              <span style="color:${c.brightRed}">● BR</span> <span style="color:${c.brightGreen}">● BG</span> <span style="color:${c.brightYellow}">● BY</span> <span style="color:${c.brightBlue}">● BB</span><br>
              <span style="color:${c.brightMagenta}">● BM</span> <span style="color:${c.brightCyan}">● BC</span> <span style="color:${c.brightWhite}">● BW</span> <span style="color:${c.black}">● Bk</span>
            </div>
          </div>
          <div style="width:3px;background:${u.border}"></div>
          <div class="pv-split-right" style="border:1px solid ${u.border}">
            <div class="pv-tabs" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
              <div class="pv-tab" style="color:${u.textBright};background:${ah};border-bottom:1px solid ${u.accent}">htop <span style="color:${u.danger}">×</span></div>
              <div class="pv-tab" style="color:${u.textMuted};border-left:1px solid ${u.border}">Shell <span style="color:${u.danger}">×</span></div>
            </div>
            <div class="pv-term" style="background:${c.background};color:${c.foreground}">
              <span style="color:${c.cyan}">PID</span> <span style="color:${c.green}">CPU</span> <span style="color:${c.yellow}">MEM</span> <span style="color:${c.blue}">CMD</span><br>
              <span style="color:${c.foreground}"> 1  </span><span style="color:${c.green}">  2% </span><span style="color:${c.yellow}">  1% </span><span style="color:${c.foreground}">bash</span><br>
              <span style="color:${c.foreground}"> 42 </span><span style="color:${c.red}"> 99% </span><span style="color:${c.red}"> 45% </span><span style="color:${c.foreground}">node</span><br>
              <br>
              <span style="color:${c.foreground}">cursor: </span><span style="background:${c.cursor};color:${c.cursorAccent}"> █ </span>
            </div>
          </div>
        </div>
        <div class="pv-status" style="background:${u.sidebarBg};border-top:1px solid ${u.border}">
          <span style="color:${u.accent}">●</span>
          <span style="color:${u.textMuted};margin-left:4px">2 windows · 3 panes</span>
          <span style="margin-left:auto;color:${u.danger};font-size:7px">ERR</span>
          <span style="margin-left:4px;color:${u.text};font-size:7px">OK</span>
        </div>
      </div>
    </div>`;
  }

  _hideCustomEditor(){
    document.getElementById('custom-editor').style.display='none';
    document.getElementById('custom-toggle').classList.remove('active');
  }

  _showCustomEditor(){
    const base=getCurrentTheme();
    customTheme=JSON.parse(JSON.stringify(base));
    document.getElementById('custom-toggle').classList.add('active');
    document.getElementById('custom-editor').style.display='';
    // UI colors
    const uiDiv=document.getElementById('ce-ui'); uiDiv.innerHTML='';
    for(const [key,label] of Object.entries(UI_LABELS)){
      uiDiv.appendChild(this._colorInput(key,label,customTheme.ui));
    }
    // Terminal colors
    const termDiv=document.getElementById('ce-terminal'); termDiv.innerHTML='';
    for(const [key,label] of Object.entries(TERM_LABELS)){
      termDiv.appendChild(this._colorInput(key,label,customTheme.terminal));
    }
  }

  _colorInput(key,label,obj){
    const item=document.createElement('div'); item.className='ce-item';
    const lbl=document.createElement('label'); lbl.textContent=label;
    const inp=document.createElement('input'); inp.type='color'; inp.value=obj[key]||'#000000';
    inp.addEventListener('input',()=>{
      obj[key]=inp.value;
      applyThemeObj(customTheme);
      this._renderPreview();
      this._saveSettings();
    });
    item.appendChild(lbl); item.appendChild(inp);
    return item;
  }

  _renderShortcutList(){
    const el=document.getElementById('sc-list');if(!el)return;
    el.innerHTML='';
    const groups=[
      {label:'창',keys:['windowNext','windowPrev','newWindow','closeWindow']},
      {label:'탭',keys:['tabNext','tabPrev','newTab','closeTab']},
      {label:'Pane',keys:['paneUp','paneDown','paneLeft','paneRight']},
      {label:'분할',keys:['splitH','splitV']},
      {label:'에이전트',keys:['agentsToggle']},
    ];
    for(const g of groups){
      const title=document.createElement('div');title.className='sc-group-title';title.textContent=g.label;
      el.appendChild(title);
      for(const k of g.keys){
        const row=document.createElement('div');row.className='sc-row';
        const label=document.createElement('span');label.textContent=SHORTCUT_LABELS[k];
        const btn=document.createElement('button');btn.className='sc-key';btn.dataset.action=k;
        btn.textContent=displayKey(shortcuts[k]||'');
        // Click → record mode
        btn.addEventListener('click',()=>{
          this._cancelRecording();
          this._recording=k;btn.textContent='키를 누르세요...';btn.classList.add('recording');
        });
        const rst=document.createElement('button');rst.className='sc-rst';rst.textContent='↺';rst.title='초기화';
        rst.addEventListener('click',()=>{shortcuts[k]=SHORTCUT_DEFAULTS[k];this._saveSettings();btn.textContent=displayKey(shortcuts[k])});
        row.appendChild(label);
        const btns=document.createElement('div');btns.className='sc-btns';
        btns.appendChild(btn);btns.appendChild(rst);
        row.appendChild(btns);
        el.appendChild(row);
      }
    }
  }
  _cancelRecording(){
    if(!this._recording)return;
    const btn=document.querySelector('.sc-key.recording');
    if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
    this._recording=null;
  }

  // ── Status Bar ──
  _initStatusBar(){
    this._stats={};this._latency=null;
    // FR-GIT-112: 진행 중인 원격 작업. Git 창을 보지 않아도 알 수 있어야 하므로
    // Git 창의 폴링이 아니라 상태바 폴링에 얹는다.
    this._gitJobs=[];
    // FR-BGU-4: 진입점은 정적 요소다. 리스너를 여기서 한 번만 부착한다 —
    // 지표 재생성(_updateStatusBar) 주기에 종속되면 안 된다.
    const bgBtn=document.getElementById('sb-bg-btn');
    if(bgBtn) bgBtn.addEventListener('click',e=>{e.stopPropagation();this._bgModalToggle()});
    // FR-GIT-58: chip 은 _updateStatusBar 가 매번 다시 만든다 — 리스너를 거기서
    // 붙이면 갱신마다 누적된다. 정적 컨테이너에 위임해 여기서 한 번만 붙인다.
    const sbItems=document.getElementById('sb-items');
    if(sbItems) sbItems.addEventListener('click',e=>{
      if(e.target.closest&&e.target.closest('.sb-git')) this.openGitWindow();
    });
    this._startStatsPoll();
    this._renderStatusBarSettings();
  }
  _startStatsPoll(){
    if(this._statsInterval)clearInterval(this._statsInterval);
    // Skip polling while the tab is hidden — the status bar isn't visible, so
    // the request buys nothing (SYSTEM_STATS_SRS FR-STAT-17). Registered once;
    // _startStatsPoll also runs on interval changes.
    if(!this._statsVisHook){
      this._statsVisHook=true;
      document.addEventListener('visibilitychange',()=>{
        if(!document.hidden)this._pollStats();
      });
    }
    this._statsInterval=setInterval(()=>{
      if(document.hidden)return;
      this._pollStats();
    },statsInterval);
    this._pollStats();
  }
  async _pollStats(){
    // Measure real network latency with lightweight ping
    try{
      const t0=performance.now();
      await fetch('/api/ping');
      this._latency=Math.round(performance.now()-t0);
    }catch{this._latency=null}
    // Fetch stats separately (kept separate so ping stays a clean latency probe)
    try{
      const r=await fetch('/api/stats');
      this._stats=await r.json();
    }catch{}
    await this._pollGitJobs();
    this._updateStatusBar();
  }

  /**
   * FR-GIT-112: 진행 중 원격 작업을 상태바에 보인다.
   *
   * Git 창의 폴링(FR-GIT-22)은 창이 활성일 때만 돌므로 그것에 얹으면 요구사항이
   * 뜻을 잃는다. 이 호출은 git 을 실행하지 않는다 — 서버가 들고 있는 목록이다.
   *
   * 목록은 Git 창에도 넘긴다: 다른 브라우저 창이 띄운 작업도 같은 리포의 원격
   * 버튼을 막아야 한다 (FR-GIT-101).
   */
  async _pollGitJobs(){
    if(!statusBar.git){this._gitJobs=[];return}
    let r=null,d=null;
    try{r=await fetch('/api/git/jobs')}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    // 받지 못했으면 이전 목록을 유지한다 — 한 번의 실패로 chip 이 사라지면
    // "작업이 끝났다" 와 "모른다" 가 같아진다.
    if(!d||!Array.isArray(d.jobs)) return;
    this._gitJobs=d.jobs;
    if(this.gitPanel) this.gitPanel.adoptJobs(d.jobs);
  }

  // 방금 띄운 작업은 폴링 주기를 기다리지 않는다 (FR-GIT-112).
  _gitJobSeen(job){
    if(!job||!job.id) return;
    if(!this._gitJobs) this._gitJobs=[];
    if(this._gitJobs.some(j=>j.id===job.id)) return;
    this._gitJobs=this._gitJobs.concat([job]);
    this._updateStatusBar();
  }

  _gitJobEnded(id){
    if(!id||!this._gitJobs) return;
    const n=this._gitJobs.length;
    this._gitJobs=this._gitJobs.filter(j=>j.id!==id);
    if(this._gitJobs.length!==n) this._updateStatusBar();
  }
  _updateStatusBar(){
    const bar=document.getElementById('sb-items');if(!bar)return;
    const items=[];
    if(statusBar.connection){
      const ok=this._latency!==null;
      items.push(`<span class="sb-item"><span class="sb-dot ${ok?'ok':'err'}"></span>${ok?'연결됨':'끊김'}</span>`);
    }
    if(statusBar.latency&&this._latency!==null){
      items.push(`<span class="sb-item">${this._latency}ms</span>`);
    }
    if(statusBar.location){
      const loc=this._locationLabel();
      if(loc)items.push(`<span class="sb-item" title="dmctl 대상: ${loc}">📍 ${loc}</span>`);
    }
    if(statusBar.cwd){
      const cwd=this._cwd||'~';
      // Show ~/.../last3dirs
      let short=cwd.replace(/^\/Users\/[^/]+/,'~');
      const parts=short.split('/');
      if(parts.length>4)short='~/.../'+parts.slice(-3).join('/');
      items.push(`<span class="sb-item">📁 ${short}</span>`);
    }
    if(statusBar.hostname&&this._stats.hostname){
      items.push(`<span class="sb-item">💻 ${this._stats.hostname}</span>`);
    }
    if(statusBar.cpu&&this._stats.cpu!==undefined){
      items.push(`<span class="sb-item">CPU ${this._stats.cpu}%</span>`);
    }
    if(statusBar.memory&&this._stats.memTotal){
      const used=this._fmtBytes(this._stats.memUsed);
      const total=this._fmtBytes(this._stats.memTotal);
      items.push(`<span class="sb-item">MEM ${used}/${total}</span>`);
    }
    if(statusBar.disk&&this._stats.diskPct){
      items.push(`<span class="sb-item">DISK ${this._stats.diskPct}%</span>`);
    }
    if(statusBar.termsize){
      const p=this._focusedTerminal();
      if(p&&p.term){
        items.push(`<span class="sb-item">${p.term.cols}×${p.term.rows}</span>`);
      }
    }
    if(statusBar.uptime){
      const parts=[];
      if(this._stats.sysUptime)parts.push('시스템 '+this._stats.sysUptime);
      if(this._stats.srvUptime)parts.push('서버 '+this._stats.srvUptime);
      if(parts.length)items.push(`<span class="sb-item">↑ ${parts.join(' │ ')}</span>`);
    }
    bar.innerHTML=items.join('')||'';
    // chip 은 문자열이 아니라 DOM 으로 붙인다 — 브랜치 이름에는 < 와 & 가 올 수 있다.
    if(statusBar.git){
      const c=this._gitChip(); if(c) bar.appendChild(c);
      // FR-GIT-112: 진행 중 원격 작업은 chip 옆에 별도로 붙는다 — 브랜치 표시와
      // 섞으면 어느 것이 관측이고 어느 것이 진행인지 구분되지 않는다.
      const j=this._gitJobChip(); if(j) bar.appendChild(j);
    }
    this._updateBgBtn();
  }

  // FR-GIT-57·59: 활성 리포의 마지막 관측을 chip 으로 만든다. 리포가 없거나
  // 관측이 없으면 null 이다 — 빈 chip 이나 '-' 를 보이면 "변경 없음" 과
  // "모른다" 가 같아진다.
  _gitChip(){
    const g=this.gitPanel;
    const s=(g&&g.repo&&g._status&&g._status.status)||null;
    if(!s) return null;
    const el=document.createElement('span');
    el.className='sb-item sb-git'+(s.detached?' sb-git-detached':'');
    el.title=(g.repo||'')+' — '+GIT_SB_TITLE;
    const b=document.createElement('span'); b.className='sb-git-branch';
    // detached 면 브랜치 자리에 해시 앞 7자가 온다 (.git-head-branch 와 같은 규약).
    b.textContent=GIT_SB_BRANCH_ICON+' '+(s.detached?(s.oid||'').slice(0,7):(s.branch||''));
    el.appendChild(b);
    // 변경 수가 0 이면 숫자를 붙이지 않는다.
    const n=s.total||0;
    if(n){
      const d=document.createElement('span'); d.className='sb-git-dirty';
      d.textContent=GIT_SB_DIRTY_ICON+n;
      el.appendChild(d);
    }
    return el;
  }

  // FR-GIT-112: 진행 중 원격 작업의 chip. 없으면 null 이다 — 빈 chip 을 보이면
  // "작업 중" 과 "아무 일도 없음" 이 같아진다.
  _gitJobChip(){
    const jobs=this._gitJobs||[];
    if(!jobs.length) return null;
    const el=document.createElement('span');
    el.className='sb-item sb-git-job';
    el.textContent=GIT_SB_JOB_ICON+' '+jobs.map(j=>j.kind||'').join(' ')+GIT_SB_JOB_SUFFIX;
    el.title=GIT_SB_JOB_TITLE+' — '+jobs.map(j=>(j.kind||'')+' @ '+(j.repo||'')).join('\n');
    return el;
  }

  // FR-BGU-2..5: 진입점은 상태바 우측 끝의 정적 버튼이다. 지표 재생성과
  // 수명을 공유하지 않으므로 여기서는 표시 여부와 개수만 갱신한다.
  _updateBgBtn(){
    const btn=document.getElementById('sb-bg-btn');if(!btn)return;
    const n=(this._bg&&this._bg.length)||0;
    // FR-BGU-5 (구 FR-BG-8): 0개면 UI 에 아무 흔적이 없어야 한다.
    btn.style.display=n?'':'none';
    if(!n) return;
    btn.textContent=`⏻ ${n}`;
    btn.title=`백그라운드 도구 ${n}개`;
  }

  // FR-BGU-6/7: 진입점 클릭 → 중앙 모달. 항목 클릭 시 현재 분할 칸의 새 탭으로
  // 복귀한다 (detach --restore 와 같은 경로).
  _bgModalToggle(open){
    this._bgModalOpen = (open===undefined) ? !this._bgModalOpen : !!open;
    if(this._bgModalOpen){ this._bgRefresh(); this._bgModalRender(); return }
    const el=document.getElementById('bg-modal'); if(el) el.remove();
    if(this._bgModalKey){document.removeEventListener('keydown',this._bgModalKey);this._bgModalKey=null}
  }

  _bgModalRender(){
    let ov=document.getElementById('bg-modal');
    if(!ov){
      ov=document.createElement('div'); ov.id='bg-modal'; ov.className='bg-modal';
      document.body.appendChild(ov);
      // FR-BGU-7: 배경 클릭 — 오버레이 자신이 대상일 때만 닫는다.
      ov.addEventListener('click',e=>{if(e.target===ov)this._bgModalToggle(false)});
      this._bgModalKey=e=>{if(e.key==='Escape'){e.preventDefault();this._bgModalToggle(false)}};
      document.addEventListener('keydown',this._bgModalKey);
    }
    ov.innerHTML='';
    const box=document.createElement('div'); box.className='bg-box';
    const head=document.createElement('div'); head.className='bg-head';
    head.textContent=`백그라운드 도구 ${this._bg.length}개`;
    box.appendChild(head);
    if(!this._bg.length){
      const empty=document.createElement('div'); empty.className='bg-empty';
      empty.textContent='없음'; box.appendChild(empty);
    }
    for(const b of this._bg){
      const row=document.createElement('div'); row.className='bg-row'; row.title='클릭하면 현재 분할 칸의 새 탭으로 복귀';
      // .pn-tab[data-toolid] 과 같은 관행 — 어느 도구의 행인지 DOM 으로 식별한다.
      row.dataset.toolid=b.toolId;
      const name=document.createElement('span'); name.className='bg-name'; name.textContent=b.name||DEFAULT_TOOL_NAME;
      const cwd=document.createElement('span'); cwd.className='bg-cwd'; cwd.textContent=b.cwd||'';
      row.appendChild(name); row.appendChild(cwd);
      row.addEventListener('click',()=>{this._bgModalToggle(false);this._restoreTool(b.toolId)});
      box.appendChild(row);
    }
    ov.appendChild(box);
  }
  _fmtBytes(b){
    if(b<1073741824)return(b/1048576).toFixed(1)+'MB';
    return(b/1073741824).toFixed(1)+'GB';
  }
  _locationLabel(){
    const s=this._aw();if(!s||!s.layout||!this.focused)return null;
    const sidx=this.ws.windows.findIndex(x=>x.id===this.ws.activeWindow);
    if(sidx<0)return null;
    const panes=[];
    const walk=n=>{
      if(!n)return;
      if(n.type==='pane')panes.push(n);
      else if(n.type==='split')for(const c of(n.children||[]))walk(c);
    };
    walk(s.layout);
    const pidx=panes.findIndex(r=>r.id===this.focused);
    if(pidx<0)return null;
    const pn=panes[pidx];
    const tidx=pn.tabs.findIndex(t=>t.id===pn.activeTab);
    if(tidx<0)return null;
    return `W${sidx+1}.P${pidx+1}.T${tidx+1}`;
  }
  _updateCwd(){
    const p=this._focusedTerminal();if(!p)return;
    fetch('/api/cwd?tool='+p.id).then(r=>r.json()).then(({cwd})=>{this._cwd=cwd;this._updateStatusBar()}).catch(()=>{});
  }
  _renderStatusBarSettings(){
    const el=document.getElementById('sb-settings');if(!el)return;
    el.innerHTML='';
    // Interval selector
    const iRow=document.createElement('div');iRow.className='sbs-row';
    const iLabel=document.createElement('span');iLabel.textContent='갱신 주기';
    const iSel=document.createElement('select');iSel.className='sbs-select';
    [{v:1000,t:'1초'},{v:2000,t:'2초'},{v:3000,t:'3초'},{v:5000,t:'5초'},{v:10000,t:'10초'},{v:30000,t:'30초'}].forEach(o=>{
      const opt=document.createElement('option');opt.value=o.v;opt.textContent=o.t;
      if(String(statsInterval)===String(o.v))opt.selected=true;
      iSel.appendChild(opt);
    });
    iSel.addEventListener('change',()=>{statsInterval=parseInt(iSel.value);this._saveSettings();this._startStatsPoll()});
    iRow.appendChild(iLabel);iRow.appendChild(iSel);
    el.appendChild(iRow);
    // Item toggles
    for(const[k,v]of Object.entries(STATUS_ITEMS)){
      const row=document.createElement('div');row.className='sbs-row';row.dataset.item=k;
      const label=document.createElement('span');label.textContent=v.label;
      const toggle=document.createElement('label');
      const inp=document.createElement('input');inp.type='checkbox';inp.checked=!!statusBar[k];
      const slider=document.createElement('span');slider.className='slider';
      inp.addEventListener('change',()=>{statusBar[k]=inp.checked;this._saveSettings();this._updateStatusBar()});
      toggle.appendChild(inp);toggle.appendChild(slider);
      row.appendChild(label);row.appendChild(toggle);
      el.appendChild(row);
    }
  }

  // ── Layout Presets ──
  _initPresets(){
    document.getElementById('preset-save').addEventListener('click',()=>this._savePreset());
    this._renderPresets();
  }
  _savePreset(){
    const s=this._aw();if(!s)return;
    // Strip layout to just structure (remove toolIds, keep tab counts)
    const strip=n=>{
      if(!n)return null;
      if(n.type==='pane')return{type:'pane',tabCount:n.tabs?n.tabs.length:1};
      if(n.type==='split')return{type:'split',direction:n.direction,children:n.children.map(strip),sizes:n.sizes?[...n.sizes]:null};
      return null;
    };
    const layout=strip(s.layout);
    const name='프리셋 '+(layoutPresets.length+1);
    layoutPresets.push({name,layout});
    this._saveSettings();
    this._renderPresets();
  }
  async _loadPreset(idx){
    const preset=layoutPresets[idx];if(!preset)return;
    // Create new window with preset layout
    await this._mkWindow();
    const s=this._aw();if(!s)return;
    // Build layout from preset, creating panes as needed
    const build=async(tpl)=>{
      if(!tpl)return null;
      if(tpl.type==='pane'){
        const tabs=[];
        for(let i=0;i<tpl.tabCount;i++){
          const p=await this._newTool();
          tabs.push({id:newEntityId(),name:'Shell',type:'terminal',toolId:p.id});
        }
        const rid=newEntityId();
        return{type:'pane',id:rid,tabs,activeTab:tabs[0].id};
      }
      if(tpl.type==='split'){
        const children=[];
        for(const c of tpl.children){
          const built=await build(c);
          if(built)children.push(built);
        }
        return{type:'split',direction:tpl.direction,children,sizes:tpl.sizes?[...tpl.sizes]:null};
      }
      return null;
    };
    s.layout=await build(preset.layout);
    this._setFocus(firstPane(s.layout)?.id||null, s);
    await this._save();this.render();
  }
  _deletePreset(idx){
    layoutPresets.splice(idx,1);
    if(defaultPreset===idx)defaultPreset=-1;
    else if(defaultPreset>idx)defaultPreset--;
    this._saveSettings();
    this._renderPresets();
  }
  _renamePreset(idx){
    const item=document.querySelector(`.preset-item[data-idx="${idx}"] .preset-name`);
    if(!item)return;
    const inp=document.createElement('input');inp.className='preset-rename-input';
    inp.value=layoutPresets[idx].name;inp.style.cssText='background:var(--bg);border:1px solid var(--accent);border-radius:3px;padding:2px 6px;color:var(--text);font-size:12px;width:100%;outline:none';
    item.replaceWith(inp);inp.focus();inp.select();
    const save=()=>{
      layoutPresets[idx].name=inp.value.trim()||layoutPresets[idx].name;
      this._saveSettings();this._renderPresets();
    };
    inp.addEventListener('blur',save);
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')save();if(e.key==='Escape'){inp.value=layoutPresets[idx].name;save()}e.stopPropagation()});
  }
  _describeLayout(layout){
    if(!layout)return'';
    if(layout.type==='pane')return`탭 ${layout.tabCount}개`;
    if(layout.type==='split'){
      const dir=layout.direction==='horizontal'?'가로':'세로';
      const descs=layout.children.map(c=>this._describeLayout(c)).filter(Boolean);
      return`${dir} 분할 [${descs.join(', ')}]`;
    }
    return'';
  }
  _renderPresets(){
    const el=document.getElementById('preset-list');if(!el)return;
    el.innerHTML='';
    // Update sidebar preset button visibility
    const pbtn=document.getElementById('add-preset');
    if(pbtn)pbtn.style.display=defaultPreset>=0&&layoutPresets[defaultPreset]?'':'none';
    if(!layoutPresets.length){
      el.innerHTML='<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px">저장된 프리셋이 없습니다</div>';
      return;
    }
    layoutPresets.forEach((p,i)=>{
      const item=document.createElement('div');item.className='preset-item';item.dataset.idx=i;
      if(i===defaultPreset)item.style.borderColor='var(--accent)';
      const info=document.createElement('div');info.className='preset-info';
      const name=document.createElement('div');name.className='preset-name';name.textContent=p.name;
      name.addEventListener('dblclick',e=>{e.stopPropagation();this._renamePreset(i)});
      const desc=document.createElement('div');desc.className='preset-desc';desc.textContent=this._describeLayout(p.layout);
      info.appendChild(name);info.appendChild(desc);
      item.appendChild(info);
      // Star (default) button
      const star=document.createElement('button');star.className='preset-btn';
      star.textContent=i===defaultPreset?'★':'☆';star.title='기본 프리셋으로 설정';
      star.addEventListener('click',e=>{e.stopPropagation();defaultPreset=defaultPreset===i?-1:i;this._saveSettings();this._renderPresets()});
      item.appendChild(star);
      // Load button
      const load=document.createElement('button');load.className='preset-btn';load.textContent='▶';load.title='불러오기';
      load.addEventListener('click',e=>{e.stopPropagation();this._loadPreset(i)});
      item.appendChild(load);
      // Delete button
      const del=document.createElement('button');del.className='preset-btn del';del.textContent='✕';del.title='삭제';
      del.addEventListener('click',e=>{e.stopPropagation();this._deletePreset(i)});
      item.appendChild(del);
      el.appendChild(item);
    });
  }

  // ── Drag helpers ──
  _getDragZone(el,e){const rect=el.getBoundingClientRect();const x=e.clientX-rect.left;const y=e.clientY-rect.top;const w=rect.width,h=rect.height;if(x/w<0.25)return'left';if(x/w>0.75)return'right';if(y/h<0.25)return'top';if(y/h>0.75)return'bottom';return'center'}
  _showBodyDropIndicator(bodyEl,zone){let ind=bodyEl.querySelector('.pn-drop-indicator');if(!ind){ind=document.createElement('div');ind.className='pn-drop-indicator';bodyEl.appendChild(ind)}ind.dataset.zone=zone;ind.style.display=''}
  _clearBodyDropIndicator(bodyEl){const ind=bodyEl?.querySelector('.pn-drop-indicator');if(ind)ind.style.display='none'}

  _moveTabToPane(srcRid,tabId,dstRid,beforeTabId,insertBefore){
    const s=this._aw();if(!s)return;
    // FR-GIT-181: Git 창은 탭을 받지도 내주지도 않는다.
    if(this._isGitWin(s))return;
    const srcRg=findPane(s.layout,srcRid);const dstRg=findPane(s.layout,dstRid);
    if(!srcRg||!dstRg)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    // FR-GIT-28: git 탭은 pane 을 옮기지 않는다. draggable=false 로 드래그 시작은
    // 막았지만, 이 경로는 드롭 핸들러 밖에서도 불릴 수 있어 여기서 한 번 더 막는다.
    if(srcRg.tabs[ti].type===TAB_TYPE_GIT)return;
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0){s.layout=doRemove(s.layout,srcRid);if(this.focused===srcRid)this._setFocus(dstRid, s)}
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const dst=findPane(s.layout,dstRid);if(!dst)return;
    if(beforeTabId){let ins=dst.tabs.findIndex(t=>t.id===beforeTabId);if(ins<0)ins=dst.tabs.length;else if(!insertBefore)ins++;dst.tabs.splice(ins,0,tab)}
    else dst.tabs.push(tab);
    dst.activeTab=tab.id;this._setFocus(dstRid, s);
    if(!s.layout){this._mkWindow();return}
    this._save();this.render();
  }

  _splitPaneWithTab(srcRid,tabId,targetRid,zone){
    const s=this._aw();if(!s)return;
    // FR-GIT-179·181: Git 창에는 분할 칸이 생기지 않는다.
    if(this._isGitWin(s))return;
    const srcRg=findPane(s.layout,srcRid);if(!srcRg)return;
    if(srcRid===targetRid&&srcRg.tabs.length<=1)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    // FR-GIT-28: git 탭은 분할로 떼어내지지 않는다 (_moveTabToPane 과 같은 이유).
    if(srcRg.tabs[ti].type===TAB_TYPE_GIT)return;
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0)s.layout=doRemove(s.layout,srcRid);
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const newRid=newEntityId();
    const newRg={type:'pane',id:newRid,tabs:[tab],activeTab:tab.id};
    const dir=(zone==='left'||zone==='right')?'horizontal':'vertical';
    const before=zone==='left'||zone==='top';
    const splitNode=n=>{
      if(!n)return null;
      if(n.type==='pane'&&n.id===targetRid)return{type:'split',direction:dir,children:before?[newRg,n]:[n,newRg]};
      if(n.type==='split'){n.children=n.children.map(splitNode).filter(Boolean);if(!n.children.length)return null;if(n.children.length===1)return n.children[0]}
      return n;
    };
    s.layout=splitNode(s.layout);
    if(!s.layout){this._mkWindow();return}
    this._setFocus(newRid, s);this._save();this.render();
  }
}
