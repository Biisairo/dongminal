/**
 * Remote Terminal — main application class
 */
class App {
  constructor(){
    this.panes=new Map();
    this.fileEditors=new Map();
    this.clientId=(crypto&&crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2));
    this.ws={sessions:[],activeSession:null};
    this.wsETag=null;
    this.focused=null;
    this._attn=new Map(); // paneId → {reason} 주의 상태 집합 (FR-PAN-9/16)
    this._attnNotifs={}; // paneId → Notification (재팝업 위해 직전 알림 보관)
    this._activity=new Map(); // paneId → {state,tool,detail} 활동 상태 (AGENT_ACTIVITY_PANEL_SRS)
    this._s=0;this._r=0;this._t=0;this._kb=false;
    this._windowFocused=typeof document!=='undefined'&&document.hasFocus?document.hasFocus():true;
    this._sessionFocusOwner={}; // { sessionId: clientId } — per-session focus ownership
    this._focusCh=null; // BroadcastChannel for focus sync (lazy init)
    this._drag=null;
    this._stats={};this._latency=null;
    this._mPaneIdx=0; // mobile current pane index (volatile)
    this._drawerOpen=false;
    this._modKbd=null; // {ctrl:bool|'lock', alt:bool|'lock'}
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

  // Flatten split tree → array of region nodes (in-order: L→R, T→B)
  _flattenRegions(node, out){
    out = out || [];
    if(!node) return out;
    if(node.type==='region') out.push(node);
    else if(node.type==='split' && node.children){
      for(const c of node.children) this._flattenRegions(c, out);
    }
    return out;
  }
  _mobileCurrentRegion(){
    const s=this._as(); if(!s||!s.layout) return null;
    const regs=this._flattenRegions(s.layout);
    if(!regs.length) return null;
    if(this._mPaneIdx>=regs.length) this._mPaneIdx=regs.length-1;
    if(this._mPaneIdx<0) this._mPaneIdx=0;
    return regs[this._mPaneIdx];
  }
  _mobilePaneCount(){
    const s=this._as(); if(!s||!s.layout) return 0;
    return this._flattenRegions(s.layout).length;
  }
  navMobilePane(delta){
    const n=this._mobilePaneCount(); if(n<=1) return;
    this._mPaneIdx = (this._mPaneIdx + delta + n) % n;
    const rg=this._mobileCurrentRegion();
    if(rg){
      this._setFocus(rg.id);
      this._save();
    }
    this.render();
  }

  async init(){
    // Set up BroadcastChannel listener BEFORE any async work so we don't
    // miss session focus claims from other windows during init.
    this._initFocusChannel();
    try{
      const stRes=await fetch('/api/state');
      this.wsETag=stRes.headers.get('ETag')||stRes.headers.get('Etag')||null;
      const st=await stRes.json();
      const sp=st.panes||[];
      const sv=st.workspace;
      const ok=new Set(sp.map(p=>p.id));
      for(const p of sp){const pane=this._mkPane(p.id,p.name);pane._reconnecting=true;pane.el.style.opacity='0'}
      if(sv&&sv.sessions&&sv.sessions.length){
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
        for(const s of this.ws.sessions){
          if(!s||!s.id) continue;
          const n=parseInt(s.id.replace(/\D/g,''),10); if(n>this._s) this._s=n;
          s.layout=clean(s.layout,ok);
          if(s.layout) normalizeLayout(s.layout);
          if(s.layout) this._rids(s.layout);
        }
        this.ws.sessions=this.ws.sessions.filter(s=>s&&s.layout);
        if(!this.ws.sessions.find(s=>s.id===this.ws.activeSession))
          this.ws.activeSession=this.ws.sessions[0]?.id||null;
      }
      if(!this.ws.sessions.length) await this._mkSession();
    }catch(e){
      console.error('[App] init error:',e);
      if(!this.ws.sessions.length) await this._mkSession();
    }
    // Restore per-window activeSession from sessionStorage (survives refresh).
    // Only apply if the session still exists in the loaded workspace.
    try{
      const saved=sessionStorage.getItem('activeSession');
      if(saved && this.ws.sessions.some(s=>s.id===saved)){
        this.ws.activeSession=saved;
      }
      // Restore per-window focusedRegion for each session from sessionStorage.
      const savedFocus=sessionStorage.getItem('focusedRegions');
      if(savedFocus){
        const map=JSON.parse(savedFocus);
        for(const s of this.ws.sessions){
          const rid=map[s.id];
          if(rid && s.layout && findRg(s.layout, rid)) s.focusedRegion=rid;
        }
      }
    }catch{}
    const a=this._as();
    if(a&&a.layout){const saved=a.focusedRegion;const f=(saved&&findRg(a.layout,saved))?{id:saved}:firstRg(a.layout);if(f)this._setFocus(f.id, a)}
    this.render();
    this._bind();
    this._subscribeCommands();
    // Initial session claim: only if window has focus AND no other window
    // already owns this session (prevents init-time claim races).
    if(document.hasFocus&&document.hasFocus()){
      const sid=this.ws.activeSession;
      if(sid && !this._sessionFocusOwner[sid]){
        this._focusSession(sid);
      }
    }
    this._applyFocusOverlay();
  }


  // 외부 CLI(dmctl) → 서버 → SSE 브로드캐스트 수신 → executeAction 재사용
  _subscribeCommands(){
    let retry=1000, retryCount=0, maxRetries=20;
    const connect=()=>{
      try{
        const es=new EventSource('/api/commands/sse');
        es.onopen=()=>{retry=1000;retryCount=0;this._attnRestore();this._activityRestore()};
        es.onmessage=(e)=>{
          try{
            const m=JSON.parse(e.data);
            if(m.action==='workspace_changed'){
              this._onWorkspaceChanged(m.args&&m.args.rev);
              return;
            }
            if(m.action==='pane_attention'){
              this._onPaneAttention(m.args||{});
              return;
            }
            if(m.action==='pane_attention_clear'){
              this._onPaneAttentionClear(m.args||{});
              return;
            }
            if(m.action==='pane_activity'){
              this._onPaneActivity(m.args||{});
              return;
            }
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
        const sp=(st&&st.panes)||[];
        if(!sv||!sv.sessions) break;
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
      if(!this.panes.has(id)) this._mkPane(id, nameOf.get(id)||id);
    }
    for(const [id,p] of Array.from(this.panes.entries())){
      if(!ok.has(id)){ try{p.destroy()}catch{} this.panes.delete(id) }
    }
    for(const s of sv.sessions){
      if(!s||!s.id) continue;
      const n=parseInt(s.id.replace(/\D/g,''),10); if(n>this._s) this._s=n;
      s.layout=clean(s.layout, ok);
      if(s.layout) normalizeLayout(s.layout);
      if(s.layout) this._rids(s.layout);
    }
    sv.sessions=sv.sessions.filter(s=>s&&s.layout);
    if(!sv.sessions.find(s=>s.id===sv.activeSession))
      sv.activeSession=sv.sessions[0]?.id||null;
    // Preserve per-window viewport state: activeSession and each session's
    // focusedRegion. Remote structural changes (splits/tabs) are applied
    // but this window stays on its own session/region.
    const localActive=this.ws.activeSession;
    const localFocus=new Map();
    for(const s of this.ws.sessions){
      if(s.focusedRegion) localFocus.set(s.id, s.focusedRegion);
    }
    this.ws=sv;
    if(localActive && this.ws.sessions.some(s=>s.id===localActive)){
      this.ws.activeSession=localActive;
    }
    // Restore each session's focusedRegion if the region still exists.
    for(const s of this.ws.sessions){
      const rid=localFocus.get(s.id);
      if(rid && s.layout && findRg(s.layout, rid)) s.focusedRegion=rid;
    }
    if('displayMode' in this.ws) delete this.ws.displayMode;
    if('mobileBreakpoint' in this.ws) delete this.ws.mobileBreakpoint;
    if(this.ws.sidebarWidth){
      const w=Math.max(100,Math.min(400,this.ws.sidebarWidth));
      document.documentElement.style.setProperty('--sb-w',w+'px');
      try{localStorage.setItem('sidebarWidth',w)}catch{}
    }
    const a=this._as();
    if(a&&a.layout){
      const saved=a.focusedRegion;
      const f=(saved&&findRg(a.layout,saved))?{id:saved}:firstRg(a.layout);
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
        newSessions:result.newSessions||[],
        newRegions:result.newRegions||[],
        newTabs:result.newTabs||[],
      }),
    }).catch(()=>{});
  }

  _execRemote(action, args){
    args=args||{};
    if(action==='focus'){
      // Multi-window: only apply focus if the source pane is in this window's
      // *active* session. If the pane belongs to a session that another
      // window is viewing, this window stays put.
      if(args.sourcePane && !this._isPaneInActiveSession(args.sourcePane)){
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
    if(action==='renameTab'||action==='renameSession'){
      if(!args.location||!args.name){console.warn('[cmd] '+action+': location/name 필수');return}
      const tgt=this._resolveLocation(args.location);
      if(!tgt){console.warn('[cmd] '+action+': 대상 없음',args.location);return}
      const name=String(args.name).slice(0,64);
      if(action==='renameTab') tgt.tab.name=name;
      else tgt.session.name=name;
      this._save(); this.render();
      return;
    }
    // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-5: newSession/newTab 은 name/keepFocus
    // 를 전달하기 위해 명시 분기. 의미는 _mkSession/addTab 내부에서 보장.
    if(action==='newSession'){
      this._mkSession({name:args.name,keepFocus:!!args.keepFocus}).then((c)=>{
        this.render();
        if(args.reqId&&c) this._echoResult(args.reqId,{newSessions:[c.session],newRegions:[c.region],newTabs:[c.tab]});
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
          opts.sessionId=tgt.sessionId;
          rid=tgt.regionId;
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
        opts.targetSession=tgt.sessionId;
        opts.targetRegion=tgt.regionId;
      }
      const dir=action==='splitH'?'horizontal':'vertical';
      this.split(dir,opts).then((c)=>{
        if(args.reqId&&c) this._echoResult(args.reqId,{newRegions:c.regions,newTabs:c.tabs});
      });
      return;
    }
    const keepFocus=!!args.keepFocus;
    // location 지정 closeTab 은 활성/비활성 세션 구분 없이 포커스를 건드리지 않고 직접 close.
    // keepFocus 인자는 호환을 위해 받지만, location 이 있으면 항상 포커스 유지로 취급한다.
    if(action==='closeTab' && args.location){
      const tgt=this._resolveLocation(args.location);
      if(tgt && tgt.regionId && tgt.tabId){
        this.closeTab(tgt.regionId, tgt.tabId, tgt.sessionId);
        return;
      }
    }
    let savedSession=null, savedFocused=null;
    if(args.location && keepFocus){
      savedSession=this.ws.activeSession;
      savedFocused=this.focused;
    }
    if(args.location) this._focusLocation(args.location);
    const result=this.executeAction(action);
    Promise.resolve(result).then(()=>{
      if(savedSession==null) return;
      if(this.ws.activeSession!==savedSession && this.ws.sessions.some(x=>x.id===savedSession)){
        const cur=this._as(); if(cur) cur.focusedRegion=this.focused;
        this.ws.activeSession=savedSession;
        try{sessionStorage.setItem('activeSession', savedSession)}catch{}
        this._focusSession(savedSession);
      }
      const a=this._as();
      if(a&&savedFocused&&findRg(a.layout,savedFocused)){
        this._setFocus(savedFocused, a);
      }
      this._save(); this.render();
    });
  }

  _resolveLocation(loc){
    if(!loc) return null;
    const m=String(loc).toUpperCase().trim().match(/^S?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m) return null;
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.sessions[si]; if(!sess) return null;
    const regions=[]; this._collectRegions(sess.layout,regions);
    const rg=regions[pi]; if(!rg) return null;
    const tab=rg.tabs[ti]; if(!tab) return null;
    return {sessionId:sess.id,regionId:rg.id,tabId:tab.id,session:sess,region:rg,tab:tab};
  }

  // "4.1.1", "S4.P1.T1", "4", "4.2" 등을 지원. 1-base positional (session.region.tab).
  _focusLocation(loc){
    if(!loc){console.warn('[cmd] focus: location 누락');return}
    const m=String(loc).toUpperCase().trim().match(/^S?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m){console.warn('[cmd] focus: 형식 오류',loc);return}
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.sessions[si];
    if(!sess){console.warn('[cmd] focus: session #'+(si+1)+' 없음');return}
    const regions=[]; this._collectRegions(sess.layout, regions);
    const rg=regions[pi];
    if(!rg){console.warn('[cmd] focus: region #'+(pi+1)+' 없음');return}
    const tab=rg.tabs[ti];
    if(!tab){console.warn('[cmd] focus: tab #'+(ti+1)+' 없음');return}
    if(this.ws.activeSession!==sess.id){
      const cur=this._as(); if(cur) cur.focusedRegion=this.focused;
      this.ws.activeSession=sess.id;
      try{sessionStorage.setItem('activeSession', sess.id)}catch{}
    }
    rg.activeTab=tab.id;
    this._setFocus(rg.id, sess);
    this._focusSession(sess.id);
    this._save(); this.render();
  }

  _collectRegions(n, out){
    if(!n) return;
    if(n.type==='region'){out.push(n);return}
    if(n.children) for(const c of n.children) this._collectRegions(c,out);
  }

  _rids(n){
    if(!n) return;
    if(n.type==='region'){
      const r=parseInt((n.id||'').replace(/\D/g,''),10);if(r>this._r)this._r=r;
      if(n.tabs) for(const t of n.tabs){const x=parseInt((t.id||'').replace(/\D/g,''),10);if(x>this._t)this._t=x}
      return;
    }
    if(n.children) for(const c of n.children) this._rids(c);
  }

  _mkPane(id,name){
    if(this.panes.has(id)) return this.panes.get(id);
    const p=new TermPane(id,name);
    document.getElementById('area').appendChild(p.el);
    p.connect();
    this.panes.set(id,p);
    this._applyFocusOverlay();
    return p;
  }

  async _isPaneBusy(paneId){
    try{const r=await fetch(`/api/panes/${paneId}/busy`);const d=await r.json();return d.busy}catch{return false}
  }

  _confirmClose(msg, opts = {}){
    return new Promise(resolve=>{
      const ov=document.createElement('div');ov.className='confirm-overlay';
      let btns = '<button class="confirm-ok">닫기</button><button class="confirm-cancel">취소</button>';
      if (opts.saveBtn) {
        btns = '<button class="confirm-save">저장 후 닫기</button>' + btns;
      }
      ov.innerHTML=`<div class="confirm-box"><div class="confirm-msg">${msg}</div><div class="confirm-btns">${btns}</div></div>`;
      document.body.appendChild(ov);
      const saveBtn = ov.querySelector('.confirm-save');
      if (saveBtn) saveBtn.focus(); else ov.querySelector('.confirm-ok').focus();
      const cleanup=v=>{ov.remove();document.removeEventListener('keydown',onKey);resolve(v)};
      const onKey=e=>{if(e.key==='Enter'){e.preventDefault();cleanup(saveBtn?'save':true)}else if(e.key==='Escape'){e.preventDefault();cleanup(false)}};
      document.addEventListener('keydown',onKey);
      if (saveBtn) saveBtn.addEventListener('click',()=>cleanup('save'));
      ov.querySelector('.confirm-ok').addEventListener('click',()=>cleanup(true));
      ov.querySelector('.confirm-cancel').addEventListener('click',()=>cleanup(false));
      ov.addEventListener('click',e=>{if(e.target===ov)cleanup(false)});
    });
  }

  async _newPane(cwd,cwdPane){
    let q='';
    if(cwd) q='&cwd='+encodeURIComponent(cwd);
    else if(cwdPane) q='&cwdPane='+encodeURIComponent(cwdPane);
    const r=await fetch('/api/panes?cols=120&rows=40'+q,{method:'POST'});
    if(!r.ok) throw new Error('create pane failed');
    const {id,name}=await r.json();
    return this._mkPane(id,name);
  }

  async _focusedCwd(){
    const p=this._focusedTermPane();
    if(!p) return null;
    try{const r=await fetch('/api/cwd?pane='+p.id);const d=await r.json();return d.cwd||null}catch{return null}
  }

  async _kill(pid){
    const p=this.panes.get(pid);
    if(p){p.destroy();this.panes.delete(pid)}
    try{await fetch(`/api/panes/${pid}`,{method:'DELETE'})}catch{}
  }
  _killBg(pid){
    const p=this.panes.get(pid);
    if(p){p.destroy();this.panes.delete(pid)}
    fetch(`/api/panes/${pid}`,{method:'DELETE'}).catch(()=>{});
  }

  _as(){return this.ws.sessions.find(s=>s.id===this.ws.activeSession)||null}

  // _isPaneInActiveSession reports whether a pane (by id) is present in the
  // currently active session's layout. Used to route focus commands only to
  // the window that is actually viewing the source pane (multi-window).
  _isPaneInActiveSession(paneId){
    if(!paneId) return false;
    const s=this._as();
    if(!s||!s.layout) return false;
    let found=false;
    const walk=n=>{
      if(!n||found) return;
      if(n.type==='region'&&n.tabs){
        for(const t of n.tabs) if(t.paneId===paneId){found=true;return}
      }
      if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
    };
    walk(s.layout);
    return found;
  }

  // _setFocus is the single entry point for the focus invariant
  // (this.focused === active session.focusedRegion). It accepts an optional
  // session reference; when omitted, the active session is used. When the
  // mutated session is not the active one, only its focusedRegion is updated
  // (this.focused unchanged). REG-2~8 회귀 클래스 차단용 단일 진입점.
  _setFocus(rid, sess){
    const target = sess || this._as();
    if(target) target.focusedRegion = rid;
    if(!sess || (target && target.id === this.ws.activeSession)){
      this.focused = rid;
      // FR-PAN-11: 포커스된 활성 탭 pane 의 주의 상태 해제(로컬+엔드포인트)
      if(this.focused===rid) this._attnClearFocused();
    }
    this._agentsRender(); // 외부 포커스 변경도 카드 .focused 에 즉시 반영(render 미경유 경로 포함)
    this._persistFocusedRegions();
  }

  // Persist per-window focusedRegion map to sessionStorage so a refresh
  // restores the same view (multi-window: each window owns its viewport).
  _persistFocusedRegions(){
    try{
      const map={};
      for(const s of this.ws.sessions){
        if(s.focusedRegion) map[s.id]=s.focusedRegion;
      }
      sessionStorage.setItem('focusedRegions', JSON.stringify(map));
    }catch{}
  }

  // ── Pane Attention Notify (PANE_ATTENTION_NOTIFY_SRS) ──

  // 설정 영속화는 localStorage(per-device), 기존 /api/settings 스키마 무변경 (FR-PAN-14)
  // 데스크톱 알림은 기본 ON(권한 허용 시 동작) — '0' 으로 명시 비활성만 끈다 (FR-PAN-13a)
  get attnDesktop(){try{return localStorage.getItem('attnDesktop')!=='0'}catch{return true}}
  set attnDesktop(v){try{localStorage.setItem('attnDesktop',v?'1':'0')}catch{}}
  get attnSound(){try{return localStorage.getItem('attnSound')==='1'}catch{return false}}
  set attnSound(v){try{localStorage.setItem('attnSound',v?'1':'0')}catch{}}
  get agentsPollMs(){try{const v=parseInt(localStorage.getItem('agentsPollMs'));return v>=1000?v:AGENTS_POLL_DEFAULT}catch{return AGENTS_POLL_DEFAULT}}
  set agentsPollMs(v){try{localStorage.setItem('agentsPollMs',String(v))}catch{}}

  _attnHas(paneId){return this._attn.has(paneId)}

  // 활성 세션의 포커스 region 의 activeTab paneId === paneId 인지 (FR-PAN-9)
  _isPaneFocusedActive(paneId){
    if(!paneId) return false;
    const s=this._as(); if(!s||!s.layout) return false;
    const rg=findRg(s.layout,this.focused); if(!rg) return false;
    const at=(rg.tabs||[]).find(t=>t.id===rg.activeTab);
    return !!at&&at.paneId===paneId;
  }

  _onPaneAttention({paneId,reason}={}){
    if(!paneId) return;
    // 억제(즉시 해제)는 "정말로 보고 있을 때"만 — 브라우저 창이 OS 포커스를 가졌고(다른 앱이
    // 위에 있지 않음) 그 pane 에 포커스가 있을 때. 다른 프로그램을 보고 있으면(document.hasFocus()
    // false) 포커스여도 알람을 살린다 (FR-PAN-9/13/요구2).
    const browserFocused=(typeof document!=='undefined'&&typeof document.hasFocus==='function')?document.hasFocus():true;
    if(browserFocused&&this._isPaneFocusedActive(paneId)){this._attnClear(paneId);return}
    this._attn.set(paneId,{reason});
    this._attnRefresh();
    this._attnDesktopNotify(reason,paneId); // FR-PAN-13a
    this._attnBeep(); // FR-PAN-13c
  }

  _onPaneAttentionClear({paneId}={}){
    if(!paneId) return;
    this._attnCloseNotif(paneId);
    if(!this._attn.delete(paneId)) return;
    this._attnRefresh();
  }

  // FR-PAN-12: 합류/재연결 시 현재 주의 집합 복원(기존 것 병합)
  _attnRestore(){
    fetch('/api/panes/attention').then(r=>r.ok?r.json():null).then(j=>{
      if(!j||!Array.isArray(j.paneIds)) return;
      for(const pid of j.paneIds){if(!this._attn.has(pid))this._attn.set(pid,{reason:'signaled'})}
      this._attnRefresh();
    }).catch(()=>{});
  }

  // FR-PAN-11: 로컬 즉시 제거 + 백엔드 해제(다른 브라우저로 전파)
  _attnClear(paneId){
    if(!paneId) return;
    this._attnCloseNotif(paneId);
    this._attn.delete(paneId);
    fetch('/api/panes/attention/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paneId})}).catch(()=>{});
    this._attnRefresh();
  }

  // FR-PAN-17: 모든 알람 일괄 해제
  _attnClearAll(){
    fetch('/api/panes/attention/clear-all',{method:'POST'}).catch(()=>{});
    Object.keys(this._attnNotifs||{}).forEach(k=>this._attnCloseNotif(k));
    this._attn.clear();
    this._attnCenterClose();
    this._attnRefresh();
  }

  // FR-PAN-16: 세션 layout 안에 주의 상태 pane 이 있는지
  _sessionHasAttn(s){
    if(!s||!s.layout||!this._attn.size) return false;
    const walk=(node)=>{
      if(!node) return false;
      if(node.type==='region') return (node.tabs||[]).some(t=>t.paneId&&this._attn.has(t.paneId));
      if(node.children) return node.children.some(walk);
      return false;
    };
    return walk(s.layout);
  }

  // 포커스된 활성 탭이 주의 상태면 해제. 그 탭은 어차피 강조 안 되므로 full render 불필요
  _attnClearFocused(){
    if(!this._attn.size) return;
    const s=this._as(); if(!s||!s.layout) return;
    const rg=findRg(s.layout,this.focused); if(!rg) return;
    const at=(rg.tabs||[]).find(t=>t.id===rg.activeTab);
    if(at&&at.paneId&&this._attn.has(at.paneId)) this._attnClear(at.paneId);
  }

  // 모든 세션 layout 트리를 walk 해 paneId 를 가진 tab 위치 반환 (FR-PAN-16)
  _findPaneLocation(paneId){
    if(!paneId) return null;
    const walk=(node,session)=>{
      if(!node) return null;
      if(node.type==='region'){
        const tab=(node.tabs||[]).find(t=>t.paneId===paneId);
        return tab?{session,region:node,tab}:null;
      }
      if(node.children) for(const c of node.children){const f=walk(c,session);if(f)return f}
      return null;
    };
    for(const s of this.ws.sessions){const f=walk(s.layout,s);if(f)return f}
    return null;
  }

  // FR-PAN-16: 해당 pane 으로 포커스 이동(_setFocus 가 _attnClearFocused 로 해제)
  _jumpToPane(paneId){
    const loc=this._findPaneLocation(paneId);
    if(!loc) return;
    this.ws.activeSession=loc.session.id;
    try{sessionStorage.setItem('activeSession', loc.session.id)}catch{}
    loc.region.activeTab=loc.tab.id;
    this._setFocus(loc.region.id, loc.session);
    this._focusSession(loc.session.id);
    this.render();
  }

  // FR-AAP-15: SSE pane_activity 수신 → 최신 상태로 덮어쓰고 카드 타깃 갱신
  _onPaneActivity({paneId,state,tool,detail}={}){
    if(!paneId||!state) return;
    if(state==='ended'){ // 종료 → 카드 제거
      if(this._activity.delete(paneId)) this._agentsRender();
      return;
    }
    // FR-AAP-13/21: 기존 항목은 제자리 갱신(순서 불변), 신규는 Map 끝(=최하단)에 추가
    this._activity.set(paneId,{state,tool:tool||'',detail:detail||''});
    this._agentsRender();
  }

  // FR-AAP-15: 합류/재연결 시 현재 활동 스냅샷 복원
  _activityRestore(){
    fetch('/api/panes/activity').then(r=>r.ok?r.json():null).then(j=>{
      this._activity.clear();
      if(j&&Array.isArray(j.activities)){
        j.activities.sort((a,b)=>(a.updatedAt||0)-(b.updatedAt||0)); // 오래된→최신: 끝이 가장 최근
        for(const a of j.activities) this._activity.set(a.paneId,{state:a.state,tool:a.tool||'',detail:a.detail||''});
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
    for(const p of this.panes.values()) if(p.el.classList.contains('vis')) p.doFit();
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

  // 세션 사이드바 드래그 재배치. drop(즉시) 1순위 + dragend 폴백, done 으로 중복 커밋 차단.
  // 식별자(id)로 원본/대상을 찾아 splice 후 인덱스 이동에 안전. 대상 미존재(끝 너머)면 맨 끝으로.
  _reorderSessions(dr){
    if(!dr||dr.done||!dr.srcId||dr.targetId==null||dr.srcId===dr.targetId) return;
    dr.done=true;
    const arr=this.ws.sessions;
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
  // 사라진 paneId 는 제외, 배열에 없던 새 paneId 는 신호 도착 순서대로 최하단에 추가.
  // reconcile 은 결정적이라 _save() 를 유발하지 않는다(드래그 시에만 저장).
  _agentOrderSync(){
    if(!Array.isArray(this.ws.agentsOrder)) this.ws.agentsOrder=[];
    const present=new Set(this._activity.keys());
    const order=this.ws.agentsOrder.filter(pid=>present.has(pid));
    const seen=new Set(order);
    for(const pid of this._activity.keys()) if(!seen.has(pid)) order.push(pid);
    this.ws.agentsOrder=order;
    return order;
  }

  // FR-AAP-13/14/16/18/21: 활동 중인 pane 카드 렌더. _findPaneLocation 실패(종료/없음)
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
    for(const paneId of this._agentOrderSync()){ // ws.agentsOrder 순서(신규=최하단)
      const info=this._activity.get(paneId);
      const loc=this._findPaneLocation(paneId);
      if(!loc) continue;
      n++;
      const card=document.createElement('div');
      card.className='ag-card'+(this._attnHas(paneId)?' attn':'')+(this._isPaneFocusedActive(paneId)?' focused':'');
      card.dataset.pid=paneId;
      const locDiv=document.createElement('div');locDiv.className='ag-loc';locDiv.textContent=(loc.session.name||'')+' · '+(loc.tab.name||paneId);
      const st=document.createElement('div');st.className='ag-state';
      st.classList.add(info.state); // 상태별 색(.ag-state.working 등)
      st.textContent=(AGENT_STATE_ICON[info.state]||'●')+' '+info.state+(info.tool?' · '+info.tool:'');
      const dt=document.createElement('div');dt.className='ag-detail';
      if(info.detail){dt.textContent=info.detail;card.appendChild(dt);}
      card.appendChild(locDiv);
      card.appendChild(st);
      card.addEventListener('click',()=>{this._jumpToPane(paneId);if(this._attnHas(paneId))this._attnClear(paneId)});
      // FR-AAP-21: 세션 사이드바와 동일한 native DnD. drop(즉시) 1순위, dragend 폴백.
      card.draggable=true;
      card.addEventListener('dragstart',e=>{this._drag={type:'agent',pid:paneId,targetPid:null,before:false,done:false};e.dataTransfer.effectAllowed='move';setTimeout(()=>card.classList.add('dragging'),0)});
      card.addEventListener('dragover',e=>{const dr=this._drag;if(!dr||dr.type!=='agent')return;e.preventDefault();panel.querySelectorAll('.ag-card').forEach(c=>c.classList.remove('drag-above','drag-below'));const rect=card.getBoundingClientRect();const before=e.clientY<rect.top+rect.height/2;card.classList.add(before?'drag-above':'drag-below');dr.targetPid=paneId;dr.before=before});
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
    document.title=(n?'('+n+') ':'')+'Terminal'; // FR-PAN-13b
    // 사이드바 세션 알람 표시 갱신 (전체 재렌더 없이)
    document.querySelectorAll('#sessions .si').forEach(el=>{
      const s=this.ws.sessions.find(x=>x.id===el.dataset.sid);
      el.classList.toggle('attn', !!(s&&this._sessionHasAttn(s)));
    });
    // 탭/리전 강조도 타깃 토글 — 전체 render() 를 피해 포커스 플리커(xterm blur/refocus)를 막는다.
    document.querySelectorAll('#area .rt[data-pid]').forEach(t=>{
      const rg=t.closest('.rg');
      const focusedRegion=!!(rg&&rg.classList.contains('focused'));
      const active=t.classList.contains('active');
      t.classList.toggle('attn', this._attnHas(t.dataset.pid)&&!(focusedRegion&&active));
    });
    document.querySelectorAll('#area .rg[data-rid]').forEach(rg=>{
      const at=rg.querySelector('.rt.active[data-pid]');
      const pid=at?at.dataset.pid:null;
      rg.classList.toggle('attn', !!(pid&&this._attnHas(pid)&&!rg.classList.contains('focused')));
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
    for(const [paneId,info] of this._attn){
      const loc=this._findPaneLocation(paneId);
      const name=loc?loc.tab.name:paneId;
      const reason=info&&info.reason==='idle'?'작업 멈춤':'알림 신호';
      const item=document.createElement('div');
      item.className='attn-item';
      const nameSpan=document.createElement('span');nameSpan.className='attn-name';nameSpan.textContent=name;
      const reasonSpan=document.createElement('span');reasonSpan.className='attn-reason';reasonSpan.textContent=reason;
      item.appendChild(nameSpan);
      item.appendChild(reasonSpan);
      item.addEventListener('click',()=>{this._jumpToPane(paneId);this._attnCenterClose()});
      center.appendChild(item);
    }
  }

  // FR-PAN-13a: 데스크톱 알림(권한 granted + 설정 on). pane 별 직전 알림을 닫고 새로 띄운다.
  _attnDesktopNotify(reason,paneId){
    if(!this.attnDesktop) return;
    if(typeof Notification==='undefined'||Notification.permission!=='granted') return;
    const loc=this._findPaneLocation(paneId);
    const where=loc?[loc.session&&loc.session.name,loc.tab&&loc.tab.name].filter(Boolean).join(' · '):('pane '+paneId);
    const head=reason==='done'?'✅ 작업 완료':reason==='waiting'?'⌨️ 입력 대기 중':reason==='idle'?'⏸️ 작업이 멈췄습니다':'🔔 주의가 필요합니다';
    // 같은 pane 의 이전 알림을 닫고 새로 띄운다 — tag+renotify 는 (특히 macOS 에서)
    // 조용히 갱신만 되어 재팝업이 안 되므로, close→재생성으로 매번 확실히 다시 띄운다.
    this._attnNotifs=this._attnNotifs||{};
    this._attnCloseNotif(paneId);
    try{this._attnNotifs[paneId]=new Notification(head,{body:where||('pane '+paneId)})}catch{}
  }

  // 저장해 둔 데스크톱 알림 객체를 닫는다(있으면).
  _attnCloseNotif(paneId){
    if(this._attnNotifs&&this._attnNotifs[paneId]){
      try{this._attnNotifs[paneId].close()}catch{}
      delete this._attnNotifs[paneId];
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

  async _mkSession(opts={}){
    const p=await this._newPane();
    const r=`r${++this._r}`,t=`t${++this._t}`;
    const name=(typeof opts.name==='string'&&opts.name?opts.name:'Session').slice(0,64);
    const s={
      id:`s${++this._s}`,name,
      layout:{type:'region',id:r,tabs:[{id:t,name:'Shell',type:'terminal',paneId:p.id}],activeTab:t}
    };
    this.ws.sessions.push(s);
    // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-2: keepFocus 면 세션은 사이드바에만
    // 추가 — activeSession/focused 무변화 (백그라운드 잡 컨테이너 패턴).
    if(!opts.keepFocus){
      this.ws.activeSession=s.id;
      try{sessionStorage.setItem('activeSession', s.id)}catch{}
      this._setFocus(r, s);
      this._focusSession(s.id);
    }
    // Fire-and-forget save: keeps the UI snappy. Awaiting here would block
    // render on the PUT roundtrip (see split/addTab which already use
    // this pattern).
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-6/7: 생성한 엔터티 id 반환 (echo 용).
    return {session:s.id, region:r, tab:{uuid:t, paneId:p.id}};
  }

  async addSession(){await this._mkSession();this.render()}

  async delSession(sid){
    const i=this.ws.sessions.findIndex(s=>s.id===sid);
    if(i<0) return;
    const s=this.ws.sessions[i];
    const pids=allPids(s.layout);
    const busyChecks=await Promise.all(pids.map(pid=>this._isPaneBusy(pid)));
    if(busyChecks.some(Boolean)){
      const ok=await this._confirmClose('실행 중인 프로세스가 있습니다. 세션을 종료하시겠습니까?');
      if(!ok) return;
    }
    for(const pid of pids) this._kill(pid);
    this.ws.sessions.splice(i,1);
    if(!this.ws.sessions.length){await this._mkSession();this.render();return}
    if(this.ws.activeSession===sid){
      this.ws.activeSession=this.ws.sessions[Math.min(i,this.ws.sessions.length-1)].id;
      try{sessionStorage.setItem('activeSession', this.ws.activeSession)}catch{}
    }
    const a=this._as();
    if(a&&a.layout){
      const next=(a.focusedRegion&&findRg(a.layout,a.focusedRegion))?a.focusedRegion:firstRg(a.layout)?.id||null;
      this._setFocus(next, a);
    } else this.focused=null;
    // Render first, save in background (matches split/addTab/closeTab).
    this._focusSession(this.ws.activeSession);
    this.render();
    this._save();
  }

  switchSession(sid){
    if(this.ws.activeSession===sid){
      if(this.isMobile && this._drawerOpen) this._toggleDrawer(false);
      return;
    }
    const cur=this._as();if(cur)cur.focusedRegion=this.focused;
    this.ws.activeSession=sid;
    // Persist per-window activeSession to sessionStorage (survives refresh,
    // independent across windows).
    try{sessionStorage.setItem('activeSession', sid)}catch{}
    const a=this._as();
    if(a&&a.layout){
      const next=(a.focusedRegion&&findRg(a.layout,a.focusedRegion))?a.focusedRegion:firstRg(a.layout)?.id||null;
      this._setFocus(next, a);
    } else this.focused=null;
    this._mPaneIdx=0;
    if(this.isMobile && this._drawerOpen) this._toggleDrawer(false);
    this._focusSession(sid);
    this._save(); this.render();
  }

  _findEditorTab(filePath) {
    for (const s of this.ws.sessions) {
      if (!s || !s.layout) continue;
      let result = null;
      const walk = n => {
        if (!n || result) return;
        if (n.type === 'region' && n.tabs) {
          for (const t of n.tabs) {
            if (t.type === 'editor' && t.filePath === filePath) {
              result = { tab: t, region: n, session: s };
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
    // opts.sessionId 지정 시 비활성 세션의 region 에도 추가 가능 (FR-RST-4).
    const s = opts.sessionId ? this.ws.sessions.find(x => x.id === opts.sessionId) : this._as();
    if (!s) return;
    const rg = findRg(s.layout, rid); if (!rg) return;
    if (type === 'editor') {
      if (!opts.filePath) { console.warn('[addTab] editor tab requires filePath'); return }
      const existing = this._findEditorTab(opts.filePath);
      if (existing) {
        const cur = this._as(); if (cur) cur.focusedRegion = this.focused;
        this.ws.activeSession = existing.session.id;
        try{sessionStorage.setItem('activeSession', existing.session.id)}catch{}
        existing.region.activeTab = existing.tab.id;
        this._setFocus(existing.region.id, existing.session);
        this._focusSession(existing.session.id);
        const editor = this.fileEditors.get(existing.tab.id);
        if (editor) editor.refresh();
        this.render();
        this._save();
        return;
      }
      const name = opts.name || opts.filePath.split('/').pop();
      const t = `t${++this._t}`;
      rg.tabs.push({ id: t, name, type: 'editor', filePath: opts.filePath });
      rg.activeTab = t;
      this.render();
      this._save();
      return;
    }
    const ref = this._regionNewPaneRef(s, rid);
    const p = await this._newPane(ref.cwd || null, ref.cwd ? null : (ref.cwdPane || null));
    const t = `t${++this._t}`;
    const name = (typeof opts.name === 'string' && opts.name ? opts.name : 'Shell').slice(0, 64);
    rg.tabs.push({ id: t, name, type: 'terminal', paneId: p.id });
    // FR-RST-4: keepFocus 면 대상 region 의 활성 탭도 바꾸지 않는다 (백그라운드 추가).
    if (!opts.keepFocus) rg.activeTab = t;
    this.render();
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 tab id+paneId 반환 (echo 용).
    return { uuid: t, paneId: p.id };
  }

  async closeTab(rid,tid,sid){
    // sid 를 지정하면 해당 세션의 탭을 닫는다 (비활성 세션 대상도 지원).
    // 지정 안 하면 기존 동작: 활성 세션에서 닫는다.
    const s = sid ? this.ws.sessions.find(x=>x.id===sid) : this._as();
    if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    const tab=rg.tabs.find(t=>t.id===tid); if(!tab) return;
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
      if(await this._isPaneBusy(tab.paneId)){
        const ok=await this._confirmClose('실행 중인 프로세스가 있습니다. 탭을 닫으시겠습니까?');
        if(!ok) return;
      }
    }
    const paneId=tab.paneId;
    const closingIdx=rg.tabs.findIndex(t=>t.id===tid);
    rg.tabs=rg.tabs.filter(t=>t.id!==tid);
    const prevClosestId=rg.tabs.length?rg.tabs[Math.min(closingIdx,rg.tabs.length-1)].id:null;
    const isActive = s.id === this.ws.activeSession;
    if(rg.tabs.length===0){
      s.layout=doRemove(s.layout,rid);
      if(!s.layout){if(!isEditor&&paneId)this._killBg(paneId);await this.delSession(s.id);return}
      if(isActive){
        const fallback=this.focused===rid?prevClosestId:this.focused;
        const next=fallback&&findRg(s.layout,fallback)?fallback:firstRg(s.layout)?.id||null;
        this._setFocus(next,s);
        this._focusSession(s.id);
      }
    }else{
      rg.activeTab=rg.tabs[Math.min(closingIdx,rg.tabs.length-1)].id;
      if(isActive){
        this._setFocus(rid,s);
        this._focusSession(s.id);
      }
    }
    this.render();
    if(!isEditor&&paneId){
      this._killBg(paneId);
    }
    this._save();
  }

  switchTab(rid,tid){
    const s=this._as(); if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    if(rg.activeTab===tid && this.focused===rid){this._setFocus(rid, s); return}
    rg.activeTab=tid; this._setFocus(rid, s);
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
    const tgtSessionId=opts.targetSession||this.ws.activeSession;
    let s=this.ws.sessions.find(x=>x.id===tgtSessionId);
    const tgtRegionId=opts.targetRegion||(tgtSessionId===this.ws.activeSession?this.focused:null);
    if(!s||!tgtRegionId) return;
    let count=parseInt(opts.count,10); if(!Number.isFinite(count)||count<2) count=2;
    const keepFocus=!!opts.keepFocus;
    // SPLIT_KEEPFOCUS_FIX_SRS FR-SKF-1: keepFocus 면 호출 직전 사용자 포커스를 저장해 사후 복원.
    const savedSession = keepFocus ? this.ws.activeSession : null;
    const savedFocused = keepFocus ? this.focused : null;
    const ref=this._regionNewPaneRef(s,tgtRegionId);
    const refPaneId=ref.cwd ? null : (ref.cwdPane || null);
    const newRegions=[]; let lastR=null;
    for(let i=0;i<count-1;i++){
      const p=await this._newPane(ref.cwd || null, refPaneId);
      const r=`r${++this._r}`,t=`t${++this._t}`;
      newRegions.push({type:'region',id:r,tabs:[{id:t,name:'Shell',type:'terminal',paneId:p.id}],activeTab:t});
      lastR=r;
    }
    // Re-fetch session after awaits: this.ws may have been replaced by an
    // SSE workspace_changed apply during the _newPane awaits, leaving our
    // earlier `s` reference stale (and invisible to render). Bail if the
    // target region is gone — the created panes will be reaped on the next
    // workspace sync.
    s=this.ws.sessions.find(x=>x.id===tgtSessionId);
    if(!s||!findRg(s.layout,tgtRegionId)) return;
    s.layout=doSplit(s.layout,tgtRegionId,newRegions,dir);
    if(keepFocus){
      // FR-SKF-1: 저장된 사용자 포커스를 그대로 복원. activeSession / focused 모두.
      // FR-SKF-3: 저장된 region 이 사후 layout 에서 사라졌으면 무동작 + 경고.
      if(this.ws.activeSession!==savedSession && this.ws.sessions.some(x=>x.id===savedSession)){
        this.ws.activeSession=savedSession;
        try{sessionStorage.setItem('activeSession', savedSession)}catch{}
      }
      const a=this._as();
      if(a && savedFocused && findRg(a.layout,savedFocused)){
        this._setFocus(savedFocused, a);
      } else if(savedFocused){
        console.warn('[split] keepFocus: savedFocused region gone after split, leaving focus as-is');
      }
    } else {
      if(this.ws.activeSession!==tgtSessionId){
        const cur=this._as(); if(cur) cur.focusedRegion=this.focused;
        this.ws.activeSession=tgtSessionId;
        try{sessionStorage.setItem('activeSession', tgtSessionId)}catch{}
      }
      const next = lastR || tgtRegionId;
      this._setFocus(next, s);
      this._focusSession(tgtSessionId);
    }
    this.render();
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 region/tab id 반환 (echo 용).
    return {
      regions: newRegions.map(rg=>rg.id),
      tabs: newRegions.map(rg=>({uuid:rg.tabs[0].id, paneId:rg.tabs[0].paneId})),
    };
  }

  _regionActivePaneId(sess,rid){
    const rg=findRg(sess.layout,rid); if(!rg) return null;
    const tab=rg.tabs.find(t=>t.id===rg.activeTab)||rg.tabs[0];
    return tab?.paneId||null;
  }

  _regionNewPaneRef(sess,rid){
    const rg=findRg(sess.layout,rid);if(!rg)return {};
    const tab=rg.tabs.find(t=>t.id===rg.activeTab);
    if(!tab) return {};
    if(tab.type==='editor' && typeof tab.filePath==='string' && tab.filePath.startsWith('/')){
      const i=tab.filePath.lastIndexOf('/');
      const dir = i>0 ? tab.filePath.substring(0,i) : '/';
      return {cwd: dir};
    }
    const paneId = tab.paneId;
    if (paneId) {
      const p = this.panes.get(paneId);
      if (p) return { cwdPane: paneId };
    }
    return {};
  }
  switchTabPrev(){
    const s=this._as();if(!s||!this.focused)return;
    const rg=findRg(s.layout,this.focused);if(!rg)return;
    const i=rg.tabs.findIndex(t=>t.id===rg.activeTab);if(i<0)return;
    this.switchTab(rg.id,rg.tabs[(i-1+rg.tabs.length)%rg.tabs.length].id);
  }
  paneNavigate(dir){
    const s=this._as();if(!s||!this.focused)return;
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
        const target=firstRg(parent.children[ti]);
        if(target){this._setFocus(target.id, s);this._save();this.render();return}
      }
    }
  }
  addTabFocused(){if(this.focused)this.addTab(this.focused,'terminal')}
  closeTabFocused(){
    const s=this._as();if(!s||!this.focused)return;
    const rg=findRg(s.layout,this.focused);if(!rg)return;
    this.closeTab(rg.id,rg.activeTab);
  }
  closeSessionActive(){this.delSession(this.ws.activeSession)}

  executeAction(action){
    const map={
      sessionNext:()=>this.switchSessionNext(),sessionPrev:()=>this.switchSessionPrev(),
      tabNext:()=>this.switchTabNext(),tabPrev:()=>this.switchTabPrev(),
      paneUp:()=>this.paneNavigate('up'),paneDown:()=>this.paneNavigate('down'),
      paneLeft:()=>this.paneNavigate('left'),paneRight:()=>this.paneNavigate('right'),
      splitH:()=>this.split('horizontal'),splitV:()=>this.split('vertical'),
      newSession:()=>this.addSession(),newTab:()=>this.addTabFocused(),
      closeSession:()=>this.closeSessionActive(),closeTab:()=>this.closeTabFocused(),
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
    for(const pane of this.panes.values())if(pane.el.classList.contains('vis'))pane.doFit();
  }
  closeSearch(){
    const bar=document.getElementById('search-bar');
    bar.classList.add('hidden');
    document.getElementById('search-input').value='';
    document.getElementById('search-count').textContent='';
    this._clearAllSearchDecorations();
    this._focusedTermPane()?.focus();
    for(const pane of this.panes.values())if(pane.el.classList.contains('vis'))pane.doFit();
  }
  _clearAllSearchDecorations(){
    for(const p of this.panes.values())if(p.search)p.search.clearDecorations();
  }
  _searchOpen(){return !document.getElementById('search-bar').classList.contains('hidden')}
  _researchIfOpen(){
    if(!this._searchOpen())return;
    setTimeout(()=>this._doSearch('next'),50);
  }
  _focusedTermPane(){
    if(!this.focused)return null;
    const s=this._as();if(!s)return null;
    const rg=findRg(s.layout,this.focused);if(!rg)return null;
    const tab=rg.tabs.find(t=>t.id===rg.activeTab);
    if(!tab||tab.type!=='terminal')return null;
    return this.panes.get(tab.paneId);
  }
  _focusedTab(){
    if(!this.focused)return null;
    const s=this._as();if(!s)return null;
    const rg=findRg(s.layout,this.focused);if(!rg)return null;
    const tab=rg.tabs.find(t=>t.id===rg.activeTab);
    return tab||null;
  }
  _doSearch(dir){
    const p=this._focusedTermPane();if(!p||!p.search)return;
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
    // Claim session ownership on every click — even if focus doesn't change,
    // the user is asserting "I want this session" (multi-window).
    this._focusSession(this.ws.activeSession);
    if(this.focused===rid) return;
    this._clearAllSearchDecorations();
    this._setFocus(rid);
    this._prevFocus=rid;
    document.querySelectorAll('.rg').forEach(el=>{
      el.classList.toggle('focused',el.dataset.rid===rid);
    });
    this._researchIfOpen();
    this._updateCwd();
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
          // activeSession and focusedRegion are per-window; strip them so
          // remote windows aren't forced to switch views (multi-window sync).
          const wsBody=JSON.parse(JSON.stringify(this.ws,(k,v)=>{
            if(k==='activeSession'||k==='focusedRegion') return undefined;
            return v;
          }));
          const res=await fetch('/api/workspace',{method:'PUT',headers,body:JSON.stringify(wsBody)});
          if(res.status===409){
            try{
              const gr=await fetch('/api/workspace');
              if(gr.ok) this.wsETag=gr.headers.get('ETag')||gr.headers.get('Etag')||null;
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
  //  Session Focus Ownership (multi-window)
  // ═══════════════════════════════════════════════════════════════════════
  //
  //  Rules:
  //    • Each session has ONE focus owner — the last window that focused on it.
  //    • The owner controls PTY size for that session's panes.
  //    • All other windows see that session dimmed (rg-dimmed overlay).
  //    • If no window owns a session, all windows see it bright.
  //
  //  State:
  //    _sessionFocusOwner : { sessionId → clientId }
  //    _windowFocused      : boolean (OS focus on this window)
  //    _focusCh            : BroadcastChannel (cross-window messaging)
  //
  //  Single entry point:
  //    _focusSession(sid)  — claim ownership, broadcast, resize, overlay.
  //    Called from: setFocus, switchSession, _focusLocation, _jumpToPane,
  //                 _mkSession, addTab(existing), window.focus, split.
  // ═══════════════════════════════════════════════════════════════════════

  // _initFocusChannel sets up cross-window messaging and OS focus listeners.
  _initFocusChannel(){
    if(typeof BroadcastChannel!=='undefined'){
      this._focusCh=new BroadcastChannel('dongminal-focus');
      this._focusCh.onmessage=(e)=>{
        if(e.data.type==='sessionFocus'){
          this._sessionFocusOwner[e.data.sessionId]=e.data.id;
          this._applyFocusOverlay();
        }else if(e.data.type==='sessionRelease'){
          if(this._sessionFocusOwner[e.data.sessionId]===e.data.id){
            delete this._sessionFocusOwner[e.data.sessionId];
            this._applyFocusOverlay();
          }
        }
      };
    }
    window.addEventListener('focus',()=>{
      this._windowFocused=true;
      if(this.ws.activeSession) this._focusSession(this.ws.activeSession);
    });
    window.addEventListener('blur',()=>{this._windowFocused=false});
    window.addEventListener('beforeunload',()=>{
      const ch=this._focusCh; if(!ch) return;
      for(const sid of Object.keys(this._sessionFocusOwner)){
        if(this._sessionFocusOwner[sid]===this.clientId){
          ch.postMessage({type:'sessionRelease',sessionId:sid,id:this.clientId});
        }
      }
    });
  }

  // _focusSession is the SINGLE entry point for claiming session ownership.
  // Releases old sessions owned by this window, claims the new one,
  // broadcasts via BroadcastChannel, sends resize, and updates the overlay.
  _focusSession(sessionId){
    if(!sessionId) return;
    if(!this._focusCh&&typeof BroadcastChannel!=='undefined'){
      this._focusCh=new BroadcastChannel('dongminal-focus');
    }
    const ch=this._focusCh;
    // Release other sessions this window owns (one window → one session).
    for(const sid of Object.keys(this._sessionFocusOwner)){
      if(sid!==sessionId&&this._sessionFocusOwner[sid]===this.clientId){
        delete this._sessionFocusOwner[sid];
        if(ch) ch.postMessage({type:'sessionRelease',sessionId:sid,id:this.clientId});
      }
    }
    // Only broadcast if ownership actually changes.
    if(this._sessionFocusOwner[sessionId]!==this.clientId){
      this._sessionFocusOwner[sessionId]=this.clientId;
      if(ch) ch.postMessage({type:'sessionFocus',sessionId,id:this.clientId});
    }
    // Send resize immediately (before render) so PTY matches this window's
    // size by the time the user sees the panes. Only if OS-focused.
    if(this._windowFocused) this._resendSessionSizes(sessionId);
    this._applyFocusOverlay();
  }

  // _resizeCheck returns true if this window is allowed to send resize for
  // a given pane (has OS focus + owns the pane's session or it's unowned).
  _resizeCheck(paneId){
    if(!this._windowFocused) return false;
    const sid=this._paneSessionId(paneId);
    if(!sid) return true; // pane not in any session yet → allow
    const owner=this._sessionFocusOwner[sid];
    return !owner||owner===this.clientId;
  }

  // _applyFocusOverlay syncs the DOM: regions whose session is owned by
  // another window get the dimmed overlay (rg-dimmed class).
  _applyFocusOverlay(){
    const otherOwned=new Set();
    for(const[sid,owner] of Object.entries(this._sessionFocusOwner)){
      if(owner&&owner!==this.clientId) otherOwned.add(sid);
    }
    for(const rg of document.querySelectorAll('.rg')){
      let dim=false;
      for(const t of rg.querySelectorAll('.rt[data-pid]')){
        const sid=this._paneSessionId(t.dataset.pid);
        if(sid&&otherOwned.has(sid)){dim=true;break}
      }
      rg.classList.toggle('rg-dimmed',dim);
    }
  }

  // _paneSessionId returns the session id containing a pane (by walking the
  // workspace layout tree). Returns null if the pane is not in any session.
  _paneSessionId(paneId){
    if(!paneId) return null;
    for(const s of this.ws.sessions){
      if(!s||!s.layout) continue;
      let found=null;
      const walk=n=>{
        if(!n||found) return;
        if(n.type==='region'&&n.tabs){
          for(const t of n.tabs) if(t.paneId===paneId){found=s.id;return}
        }
        if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
      };
      walk(s.layout);
      if(found) return found;
    }
    return null;
  }

  // _resendSessionSizes sends resize for every pane in a session.
  // Sends even for hidden panes (they retain last-visible dimensions) so the
  // PTY is sized correctly BEFORE render, avoiding a one-frame glitch.
  _resendSessionSizes(sessionId){
    if(!sessionId) return;
    // Don't send resize if another window owns this session.
    const owner=this._sessionFocusOwner[sessionId];
    if(owner&&owner!==this.clientId) return;
    const s=this.ws.sessions.find(x=>x.id===sessionId);
    if(!s||!s.layout) return;
    const paneIds=new Set();
    const walk=n=>{
      if(!n) return;
      if(n.type==='region'&&n.tabs){
        for(const t of n.tabs) if(t.paneId) paneIds.add(t.paneId);
      }
      if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
    };
    walk(s.layout);
    for(const pid of paneIds){
      const p=this.panes.get(pid);
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
      const rg=this._mobileCurrentRegion(); if(rg) this.addTab(rg.id);
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
    // Auto-close drawer on session switch (mobile)
    // (handled in switchSession via _drawerOpen check)

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
      const p=this._focusedTermPane();
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
      // prevent focus theft from xterm
      b.addEventListener('mousedown',e=>e.preventDefault());
      let lastTap=0;
      let pressTimer=null;
      let longPressFired=false;
      b.addEventListener('touchstart',e=>{
        e.preventDefault();
        longPressFired=false;
        pressTimer=setTimeout(()=>{longPressFired=true;showTip(full,b)},600);
      },{passive:false});
      const cancelPress=()=>{
        if(pressTimer){clearTimeout(pressTimer);pressTimer=null}
      };
      b.addEventListener('touchmove',()=>{cancelPress();hideTip();longPressFired=false});
      b.addEventListener('touchcancel',()=>{cancelPress();hideTip();longPressFired=false});
      b.addEventListener('touchend',e=>{
        cancelPress();
        if(longPressFired){e.preventDefault();hideTip();return}
      });
      b.addEventListener('click',e=>{
        e.preventDefault();
        if(longPressFired){longPressFired=false;return}
        if(k.mod){
          const now=Date.now();
          const dbl=(now-lastTap)<350;
          lastTap=now;
          const cur=this._modKbd[k.mod];
          if(dbl){this._modKbd[k.mod]=(cur==='lock')?false:'lock'}
          else{this._modKbd[k.mod]=cur?false:true}
          refresh();
        }else{
          sendToFocused(k.send);
        }
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
          document.body.style.paddingBottom='';
          bar.style.bottom='';
          return;
        }
        const kbH=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        const isUp=kbH > 80;
        document.body.classList.toggle('keyboard-up', isUp);
        if(isUp){
          bar.style.bottom = kbH + 'px';
          document.body.style.paddingBottom = (kbH + kbH_PX()) + 'px';
        }else{
          bar.style.bottom = '';
          document.body.style.paddingBottom = '';
        }
        // Refit terminal
        for(const p of this.panes.values()){if(p.el.classList.contains('vis'))p.doFit()}
      };
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      apply();
    }
  }


  async _saveSettings(){
    try{await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({themeName:customTheme?null:currentThemeName,customTheme,shortcuts,statusBar,statsInterval,layoutPresets,defaultPreset})})}catch{}
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
          <span style="color:${u.textMuted};margin-left:4px">2 sessions · 3 panes</span>
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
      {label:'세션',keys:['sessionNext','sessionPrev','newSession','closeSession']},
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
    this._startStatsPoll();
    this._renderStatusBarSettings();
  }
  _startStatsPoll(){
    if(this._statsInterval)clearInterval(this._statsInterval);
    this._statsInterval=setInterval(()=>this._pollStats(),statsInterval);
    this._pollStats();
  }
  async _pollStats(){
    // Measure real network latency with lightweight ping
    try{
      const t0=performance.now();
      await fetch('/api/ping');
      this._latency=Math.round(performance.now()-t0);
    }catch{this._latency=null}
    // Fetch stats separately (may be slow due to `top` command)
    try{
      const r=await fetch('/api/stats');
      this._stats=await r.json();
    }catch{}
    this._updateStatusBar();
  }
  _updateStatusBar(){
    const bar=document.getElementById('status-bar');if(!bar)return;
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
      if(loc)items.push(`<span class="sb-item" title="MCP id: ${loc}">📍 ${loc}</span>`);
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
      const p=this._focusedTermPane();
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
  }
  _fmtBytes(b){
    if(b<1073741824)return(b/1048576).toFixed(1)+'MB';
    return(b/1073741824).toFixed(1)+'GB';
  }
  _locationLabel(){
    const s=this._as();if(!s||!s.layout||!this.focused)return null;
    const sidx=this.ws.sessions.findIndex(x=>x.id===this.ws.activeSession);
    if(sidx<0)return null;
    const regions=[];
    const walk=n=>{
      if(!n)return;
      if(n.type==='region')regions.push(n);
      else if(n.type==='split')for(const c of(n.children||[]))walk(c);
    };
    walk(s.layout);
    const pidx=regions.findIndex(r=>r.id===this.focused);
    if(pidx<0)return null;
    const rg=regions[pidx];
    const tidx=rg.tabs.findIndex(t=>t.id===rg.activeTab);
    if(tidx<0)return null;
    return `S${sidx+1}.P${pidx+1}.T${tidx+1}`;
  }
  _updateCwd(){
    const p=this._focusedTermPane();if(!p)return;
    fetch('/api/cwd?pane='+p.id).then(r=>r.json()).then(({cwd})=>{this._cwd=cwd;this._updateStatusBar()}).catch(()=>{});
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
      const row=document.createElement('div');row.className='sbs-row';
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
    const s=this._as();if(!s)return;
    // Strip layout to just structure (remove paneIds, keep tab counts)
    const strip=n=>{
      if(!n)return null;
      if(n.type==='region')return{type:'region',tabCount:n.tabs?n.tabs.length:1};
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
    // Create new session with preset layout
    await this._mkSession();
    const s=this._as();if(!s)return;
    // Build layout from preset, creating panes as needed
    const build=async(tpl)=>{
      if(!tpl)return null;
      if(tpl.type==='region'){
        const tabs=[];
        for(let i=0;i<tpl.tabCount;i++){
          const p=await this._newPane();
          tabs.push({id:`t${++this._t}`,name:'Shell',type:'terminal',paneId:p.id});
        }
        const rid=`r${++this._r}`;
        return{type:'region',id:rid,tabs,activeTab:tabs[0].id};
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
    this._setFocus(firstRg(s.layout)?.id||null, s);
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
    if(layout.type==='region')return`탭 ${layout.tabCount}개`;
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
  _showBodyDropIndicator(bodyEl,zone){let ind=bodyEl.querySelector('.rg-drop-indicator');if(!ind){ind=document.createElement('div');ind.className='rg-drop-indicator';bodyEl.appendChild(ind)}ind.dataset.zone=zone;ind.style.display=''}
  _clearBodyDropIndicator(bodyEl){const ind=bodyEl?.querySelector('.rg-drop-indicator');if(ind)ind.style.display='none'}

  _moveTabToRegion(srcRid,tabId,dstRid,beforeTabId,insertBefore){
    const s=this._as();if(!s)return;
    const srcRg=findRg(s.layout,srcRid);const dstRg=findRg(s.layout,dstRid);
    if(!srcRg||!dstRg)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0){s.layout=doRemove(s.layout,srcRid);if(this.focused===srcRid)this._setFocus(dstRid, s)}
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const dst=findRg(s.layout,dstRid);if(!dst)return;
    if(beforeTabId){let ins=dst.tabs.findIndex(t=>t.id===beforeTabId);if(ins<0)ins=dst.tabs.length;else if(!insertBefore)ins++;dst.tabs.splice(ins,0,tab)}
    else dst.tabs.push(tab);
    dst.activeTab=tab.id;this._setFocus(dstRid, s);
    if(!s.layout){this._mkSession();return}
    this._save();this.render();
  }

  _splitRegionWithTab(srcRid,tabId,targetRid,zone){
    const s=this._as();if(!s)return;
    const srcRg=findRg(s.layout,srcRid);if(!srcRg)return;
    if(srcRid===targetRid&&srcRg.tabs.length<=1)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0)s.layout=doRemove(s.layout,srcRid);
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const newRid=`r${++this._r}`;
    const newRg={type:'region',id:newRid,tabs:[tab],activeTab:tab.id};
    const dir=(zone==='left'||zone==='right')?'horizontal':'vertical';
    const before=zone==='left'||zone==='top';
    const splitNode=n=>{
      if(!n)return null;
      if(n.type==='region'&&n.id===targetRid)return{type:'split',direction:dir,children:before?[newRg,n]:[n,newRg]};
      if(n.type==='split'){n.children=n.children.map(splitNode).filter(Boolean);if(!n.children.length)return null;if(n.children.length===1)return n.children[0]}
      return n;
    };
    s.layout=splitNode(s.layout);
    if(!s.layout){this._mkSession();return}
    this._setFocus(newRid, s);this._save();this.render();
  }
}
