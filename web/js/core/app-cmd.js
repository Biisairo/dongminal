/**
 * Remote Terminal — App 원격 커맨드·워크스페이스 동기화 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 7개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // 외부 CLI(dmctl) → 서버 → SSE 브로드캐스트 수신 → executeAction 재사용
  _subscribeCommands(){
    let retry=1000, retryCount=0, maxRetries=20;
    const connect=()=>{
      try{
        // FR-XDF-8: clientId 를 실어 서버가 구독↔Client 를 결선한다. 이 결선이
        // 구독 해제 시 소유권 해제(FR-XDF-9)의 선행 조건이다.
        const es=new EventSource('/api/commands/sse?clientId='+encodeURIComponent(this.clientId));
        es.onopen=()=>{retry=1000;retryCount=0;this._attnRestore();this._activityRestore();this._bgRefresh();this._focusRestore();this._fgRestore()};
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
            // FR-RVZ-16: Run 이 바뀌었다. 열려 있는 그 Run 의 탭만 /graph 를
            // 다시 부른다 — 폴링하지 않으며, 열린 Run 탭이 없으면 아무 요청도
            // 나가지 않는다.
            if(m.action==='run_changed'){
              this._onRunChanged(m.args||{});
              return;
            }
            if(m.action==='tool_activity'){
              this._onToolActivity(m.args||{});
              return;
            }
            // FR-TAN-8/9: 전경 프로세스 이름이 **바뀌었을 때만** 온다. 서버가
            // 이미 중복을 걸렀으므로 여기서 또 거르지 않는다.
            if(m.action==='tool_foreground'){
              this._onToolForeground(m.args||{});
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
  },

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
  },

  // ── 전경 프로세스 이름 (CONVENIENCE_SRS 묶음 N) ──

  // FR-TAN-8: 값이 바뀐 도구 하나가 SSE 로 왔다. name 이 빈 문자열이면 전경
  // 프로그램이 끝난 것이며 탭 이름은 기본값으로 돌아간다 (FR-TAN-12).
  _onToolForeground({toolId,name}={}){
    if(!toolId) return;
    const m=this._fgMap();
    if(name) m.set(toolId,name); else m.delete(toolId);
    this._fgRepaint(toolId);
  },

  _fgMap(){ return this._fgNames||(this._fgNames=new Map()) },

  // 합류/재연결 시의 스냅샷 복원 (`_attnRestore` 와 같은 규약). SSE 는 **변화**
  // 만 나르므로, 합류 시점에 이미 떠 있던 전경 프로그램은 이것으로만 보인다.
  _fgRestore(){
    fetch('/api/state').then(r=>r.ok?r.json():null).then(j=>{
      if(j) this._fgApply(j.tools||[]);
    }).catch(()=>{});
  },

  // `/api/state` 의 도구 목록(`fgName` 포함)을 런타임 Map 에 반영한다. 목록에
  // 없는 도구의 이름은 지운다 — 죽은 도구의 이름이 남으면 안 된다.
  _fgApply(tools){
    const m=this._fgMap();
    const seen=new Set();
    let changed=false;
    for(const p of tools||[]){
      if(!p||!p.id) continue;
      seen.add(p.id);
      const n=p.fgName||'';
      if((m.get(p.id)||'')===n) continue;
      if(n) m.set(p.id,n); else m.delete(p.id);
      changed=true;
    }
    for(const id of Array.from(m.keys())){
      if(!seen.has(id)){m.delete(id);changed=true}
    }
    if(changed) this._fgRepaint();
  },

  /**
   * 탭 라벨만 제자리에서 고쳐 쓴다. `render()` 를 부르지 않는 이유는 FR-RPT-3
   * 과 같다 — 파생 이름은 프로그램이 뜨고 질 때마다 바뀌므로, 그때마다 레이아웃
   * 을 다시 만들면 터미널이 재부착·재fit 되고 스크롤백 복원이 매번 돈다.
   *
   * toolId 를 주면 그 도구의 탭만, 안 주면 전부 (설정 토글 — FR-TAN-20).
   */
  _fgRepaint(toolId){
    for(const s of this.ws.windows){
      if(!s||!s.layout) continue;
      for(const pn of this._flattenPanes(s.layout)){
        for(const tab of (pn.tabs||[])){
          if(toolId&&tab.toolId!==toolId) continue;
          if(!toolId&&!tab.toolId) continue;
          const el=document.querySelector('.pn-tab[data-tab-id="'+CSS.escape(tab.id)+'"] .pn-tab-label');
          if(el) el.textContent=this.renderer._tabDisplayName(tab);
        }
      }
    }
  },

  _applyRemoteWorkspace(sv, serverPanes){
    this._fgApply(serverPanes);
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
  },

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
  },

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
      // FR-TAN-22: `rename-tab --auto` 는 이름 없이 온다 — 자동으로 되돌리는
      // 것이 그 명령의 전부다. 창 이름에는 출처가 없으므로 해당 없다.
      const toAuto=action==='renameTab'&&!!args.auto;
      if(!args.location||(!args.name&&!toAuto)){console.warn('[cmd] '+action+': location/name 필수');return}
      const tgt=this._resolveLocation(args.location);
      if(!tgt){console.warn('[cmd] '+action+': 대상 없음',args.location);return}
      if(toAuto){ this._tabToAuto(tgt.tab); this._save(); this.render(); return }
      const name=String(args.name).slice(0,64);
      // FR-TAN-2: 에이전트가 준 이름도 사용자가 준 이름과 같은 자격이다 —
      // 역할명이 다음 조회에 지워지면 안 된다.
      if(action==='renameTab'){ tgt.tab.name=name; this._tabToManual(tgt.tab) }
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
  },

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
  },

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
  },
});
