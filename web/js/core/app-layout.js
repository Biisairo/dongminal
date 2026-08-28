/**
 * Remote Terminal — App 창·탭·분할 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 21개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
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
  },

  // ── 탭 이름의 출처 (CONVENIENCE_SRS 묶음 N) ──




  async _mkWindow(opts={}){
    const p=await this._newTool();
    const r=newEntityId(),t=newEntityId();
    const name=(typeof opts.name==='string'&&opts.name?opts.name:'Window').slice(0,64);
    const s={
      id:newEntityId(),name,
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
  },

  async addWindow(){await this._mkWindow();this.render()},

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
  },

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
        existing.pane.activeTab = existing.tab.id;
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
      pn.activeTab = t;
      this.render();
      this._save();
      return { uuid: t };
    }
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
    // FR-GIT-244: 호출자가 cwd 를 주면 그것이 이긴다 — worktree 에서 터미널을 열 때
    // 기준은 pane 의 cwd 가 아니라 그 worktree 다. 주지 않으면 기존 동작 그대로다.
    const cwd = opts.cwd || ref.cwd || null;
    const p = await this._newTool(cwd, cwd ? null : (ref.cwdTool || null));
    const t = newEntityId();
    // FR-RST-4: keepFocus 면 대상 pane 의 활성 탭도 바꾸지 않는다 (백그라운드 추가).
    if (!opts.keepFocus) pn.activeTab = t;
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
  },

  switchTab(rid,tid){
    const s=this._aw(); if(!s) return;
    const pn=findPane(s.layout,rid); if(!pn) return;
    if(pn.activeTab===tid && this.focused===rid){this._setFocus(rid, s); return}
    pn.activeTab=tid; this._setFocus(rid, s);
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
  },

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
  },
  switchTabPrev(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    const i=pn.tabs.findIndex(t=>t.id===pn.activeTab);if(i<0)return;
    this.switchTab(pn.id,pn.tabs[(i-1+pn.tabs.length)%pn.tabs.length].id);
  },
  switchTabNext(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    const i=pn.tabs.findIndex(t=>t.id===pn.activeTab);if(i<0)return;
    this.switchTab(pn.id,pn.tabs[(i+1)%pn.tabs.length].id);
  },
  // FR-GIT-182: 순환은 일반 창만 돈다. Git 창에 있으면 순환의 첫 창으로 **나간다**
  // — 단축키가 막다른 길이 되면 사용자는 고장으로 읽는다 (FR-GIT-184).
  _cycleWindow(step){
    const arr=this._plainWindows(); if(!arr.length) return;
    const i=arr.findIndex(s=>s.id===this.ws.activeWindow);
    if(i<0){this.switchWindow(arr[0].id);return}
    if(arr.length<2) return;
    this.switchWindow(arr[(i+step+arr.length)%arr.length].id);
  },
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
  },
  addTabFocused(){if(this.focused)this.addTab(this.focused,'terminal')},
  closeTabFocused(){
    const s=this._aw();if(!s||!this.focused)return;
    const pn=findPane(s.layout,this.focused);if(!pn)return;
    this.closeTab(pn.id,pn.activeTab);
  },
  closeWindowActive(){this.delWindow(this.ws.activeWindow)},
});
