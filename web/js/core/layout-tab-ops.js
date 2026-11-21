/**
 * Remote Terminal — 탭 닫기·전환·분할·칸 이동·사이드바 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * `LayoutController` 의 부품 `.tabOps` 다(REFACTOR3_FE_APPCTL_SRS 9i-1, 옛 `app-layout.js` 의 뒤쪽).
 * 분할의 줄 세우기 `_splitChain` 과 메인 패널 `sidebarPanel` 은 이 부품의 것이다(§2.2 SH-4).
 */
class LayoutTabOps extends Controller {
  async closeTab(rid,tid,sid,opts={}){
    // sid 를 지정하면 해당 창의 탭을 닫는다 (비활성 창 대상도 지원).
    // 지정 안 하면 기존 동작: 활성 창에서 닫는다.
    const s = sid ? this.app.ws.windows.find(x=>x.id===sid) : this.app.aw();
    if(!s) return;
    const pn=findPane(s.layout,rid); if(!pn) return;
    const tab=pn.tabs.find(x=>x.id===tid); if(!tab) return;
    const gitTab=tab.type===TAB_TYPE_GIT;
    const isEditor=tab.type===TAB_TYPE_EDITOR;
    // FR-OPT-11-2 (FEC-22): 묻기 → 탭 빼기 → 시선 옮기기 → 도구 처분 순서다.
    // 물을 것이 없으면 기다리지 않는다 — 부른 쪽이 await 없이 곧바로 그리는 자리가 있고
    // (Run 탭 닫기), 종전에도 그 경로는 같은 틱에 탭을 뺐다.
    let ask=this._closeTabAsk(s,tab,opts);
    if(ask&&typeof ask.then==='function') ask=await ask;
    if(!ask) return;
    opts=ask;
    // UX_BATCH12_SRS FR-RTR-2: 닫은 탭 목록에 적는다. 커서·스크롤을 읽으므로 인스턴스를 놓기 전이다.
    this.app._tabReopenNote(s,pn,tab);
    if(gitTab) this.app._gitDropView(this.app.edRootOf(s),tab.gitView,tab.id);
    // REPO_FIX 03 E-4: 칸 1 이상의 인스턴스도 함께 거둔다.
    if(isEditor) this.app.editorsDrop(tab.id);
    const toolId=tab.toolId;
    const closingIdx=pn.tabs.findIndex(x=>x.id===tid);
    const wasShown=this.app.paneTab(pn,opts.slot)===tid;
    pn.tabs=pn.tabs.filter(x=>x.id!==tid);
    // FR-RTU-62: 마지막 git 뷰 탭이 닫히면 그 창의 git 표면이 사라진다 —
    // 사이드가 Explorer 면 관측을 쓰는 화면이 없으므로 폴링도 멎어야 한다.
    if(gitTab) this.app._gitRescheduleAll();
    const isActive = s.id === this.app.ws.activeWindow;
    const tool=isEditor?null:toolId;
    if(pn.tabs.length===0){
      // 창까지 지우는 갈래만 약속이다 — 나머지는 종전처럼 같은 틱에 이어진다.
      const done=this._closeTabLastInPane(s,rid,isActive,tool,opts);
      if(done&&typeof done.then==='function'){ await done; return }
      if(done) return;
    }else{
      const nextId=pn.tabs[Math.min(closingIdx,pn.tabs.length-1)].id;
      // FR-SVS-10: 닫은 칸의 시선이 이웃 탭으로 간다. 다른 칸은 자기 오버라이드가
      // 살아 있으면 움직이지 않고, 같은 탭을 보고 있었다면 FR-SVS-5 로 폴백한다.
      // 보이지 않던 탭을 닫으면 보이는 탭은 그대로다 — 이슈 트리가 자식 탭을 닫을 때 사용자가 보던
      // 에이전트 탭이 이웃으로 바뀌었다 (사용자 보고 2026-11-16, FR-SVS-10 개정).
      if(wasShown) this.app.paneTabSet(pn,nextId,opts.slot);
      // 워크스페이스가 죽은 탭을 가리키지 않게 한다 — 비포커스 칸이 닫은
      // 경우에는 `paneTabSet` 이 `activeTab` 을 쓰지 않는다 (FR-SVS-14).
      if(pn.activeTab===tid) pn.activeTab=nextId;
      // `keepView`(지목한 원격 닫기)는 사용자가 다른 칸에 있으면 포커스를 옮기지 않는다.
      //   이전: 닫은 탭의 칸으로 포커스가 옮겨졌다 — 이슈 트리가 탭을 닫을 때 포커스가 튀었다
      if(isActive&&!(opts.keepView&&this.app.focused!==rid)){
        this.app.setFocusState(rid,s);
        this.app._focusWindow(s.id);
      }
    }
    this.app.render();
    if(tool){
      if(opts.keepTool){
        // 탭만 제거한다 — 도구는 백그라운드에서 계속 실행된다 (FR-BG-2/3).
        this.app._setToolBackground(tool,true).then(()=>this.app._bgRefresh());
      }else{
        this.app._killTool(tool);
      }
    }
    this.app.save();
  }

  /**
   * 닫기 전에 묻는다. 닫지 않으면 null, 닫으면 (답이 더해졌을 수 있는) opts 다.
   * 물어야 할 때만 그 답의 약속을 돌려준다 — 묻지 않는 갈래는 동기다.
   *
   * REPO_TAB_UNIFY_SRS FR-RTU-33·34: **git 뷰 탭은 닫을 수 있다.**
   *
   *   이전 동작: `TAB_TYPE_GIT` 은 조기 반환 — 닫히지 않았다 (FR-GIT-28)
   *   새  동작: 편집기 탭과 같이 닫힌다. 확인은 없다 (잃는 편집이 없다)
   *   이유:     그 금지의 근거는 Git 창의 탭이 **고정 일곱**이라 자리가 늘
   *             같아야 한다는 것이었다. 뷰가 본문의 탭이 된 지금 자리를
   *             정하는 것은 사용자다 (FR-RTU-30·33)
   *
   * 뷰의 상태(스크롤·선택·diff 대상)는 **패널**이 들고 있으므로 다시 열면
   * 그대로다 (FR-RTU-34). 놓는 것은 그 뷰의 DOM 과 편집기뿐이며, 그것이
   * NFR-RTU-3 이 요구하는 것이다 — 탭이 없는 뷰는 인스턴스도 없다.
   */
  _closeTabAsk(s,tab,opts){
    if(tab.type===TAB_TYPE_GIT){
      /**
       * FR-RTU-103: Diff 의 저장하지 않은 편집도 확인을 지난다.
       *
       * 위 FR-RTU-33 의 "확인은 없다 (잃는 편집이 없다)" 는 **그 시점의 전제**였다.
       * 그 뒤 Diff 가 unstaged·conflict 축에서 편집을 받게 되면서(FR-RTU-54,
       * `GIT_AXIS_EDITABLE`) 전제가 깨졌다 — `GitDiffView` 는 자기 `_dirty` 와
       * `save()`·`Cmd+S` 를 든다.
       *
       * **확인이 `_gitDropView` 앞에 선다.** 뒤에 두면 뷰가 이미 `destroy()` 된
       * 뒤라서, 취소를 눌러도 편집은 돌아오지 않는다.
       */
      if(opts.force) return opts;
      const root=this.app.edRootOf(s);
      if(!this.app._gitViewDirty(root,tab.gitView,true,tab.id)) return opts;
      return (async()=>{
        const r=await this.app._confirmClose(CLOSE_DIRTY_MSG,{saveBtn:true});
        if(!r) return null;
        // 저장이 실패하면 닫지 않는다 — 저장한 줄 알고 닫는 것이 곧 손실이다.
        if(r==='save'&&!await this.app._gitViewSave(root,tab.gitView,tab.id)) return null;
        return opts;
      })();
    }
    if(tab.type===TAB_TYPE_EDITOR){
      const editor=this.app.editorAny(tab.id);
      // EDITOR_TAB_SRS FR-EDT-91: 파일이 삭제되어 닫는 경로는 확인을 건너뛴다 —
      // dirty 라는 사실은 삭제 확인창이 이미 밝혔고(FR-EDT-84), 여기서 취소해도
      // 파일은 이미 없다.
      if(!editor || !editor._dirty || opts.force) return opts;
      return (async()=>{
        const result=await this.app._confirmClose(CLOSE_DIRTY_MSG, { saveBtn: true });
        // EDITOR_EXTERNAL_CHANGE_SRS FR-EXC-13: **저장이 실패하면 닫지 않는다.**
        // 위 Diff 경로가 이미 그렇게 한다 — 편집기 경로에만 그 가드가 없었다.
        //
        //   이전 동작: `await editor.save()` 뒤 무조건 닫았다
        //   새  동작: 저장이 거짓을 주면 탭이 남는다 (dirty 도 남는다)
        //   이유:     경합(FR-EXC-5)이면 저장이 막힌다. 저장한 줄 알고 닫는 것이
        //             곧 손실이다 (FR-RTU-103)
        if(result==='save') return (await editor.save())?opts:null;
        return result?opts:null;
      })();
    }
    // FR-BG-1: 한가하면 확인 없이 닫고 도구를 종료한다.
    // FR-BG-3: 실행 중이면 살려둘 선택지를 준다. 프로세스가 도는 탭에는
    // 셸 프롬프트가 없어 detach 를 입력할 수 없고, 바로 그 탭이 이 창을
    // 띄우는 탭이다.
    // run 은 도구가 없다 — toolId 없이 busy 를 물으면
    // /api/tools/undefined/busy 404 가 콘솔에 남는다 (FR-RVZ-6).
    // UX_BATCH6_SRS FR-RUN-6: `force` 는 **이미 물었다**는 뜻이다. Run 정리가
    // 그 길로 온다 — 서버가 에이전트에게 종료를 청하고 셸로 돌아오기를 기다린
    // 뒤이며, 그러고도 도는 프로세스에 확인창을 띄우면 무인 정리가 그 자리에서
    // 막힌다. 사용자의 결정은 `dmctl run close` 를 부른 순간에 이미 있었다.
    if(!tab.toolId || opts.keepTool || opts.force) return opts;
    return (async()=>{
      if(!await this.app._isToolBusy(tab.toolId)) return opts;
      const r=await this.app._confirmClose(t('core.q_close_tab'),{bgBtn:toolBackgroundCapable(tab.type)});
      if(!r) return null;
      return r==='background'?{...opts,keepTool:true}:opts;
    })();
  }

  // 칸의 마지막 탭을 닫았다 — 칸을 지운다. 여기서 끝났으면 true, 창을 지우는 갈래는
  // 그 끝의 약속, 공통 처리로 이어가면 false.
  _closeTabLastInPane(s,rid,isActive,toolId,opts){
    s.layout=doRemove(s.layout,rid);
    // FR-EDT-52·55·56: Editor 창은 pane 이 0이 되어도 남는다 — 창의 수명은
    // 행의 수명이다 (FR-EDT-42). 빈 pane 을 남기지 않는 것과 창을 지우는 것은
    // 다른 일이다.
    if(!s.layout&&(this.app.isEditorWin(s)||this.app.isChatWin(s))){ // CHAT_WINDOW_SRS FR-CW-4·13: 채팅 창도 같다
      if(isActive){this.app.setFocusState(null,s);this.app._focusWindow(s.id)}
      this.app.render();
      this.app.save();
      return true;
    }
    if(!s.layout){
      // FR-BG-6f: 마지막 탭이 닫혀 창까지 사라지는 경로. 공통 처리에
      // 도달하지 못하고 조기 반환하므로 도구 처분을 여기서 마쳐야 한다.
      // keepTool 이면 백그라운드로 등록한다 — 등록을 빠뜨리면 종료되지도,
      // 목록에 오르지도 않아 어디서도 닿을 수 없는 도구가 된다.
      return (async()=>{
        if(toolId){
          if(opts.keepTool) await this.app._setToolBackground(toolId,true);
          else this.app._killTool(toolId);
        }
        await this.app.delWindow(s.id);
        if(toolId&&opts.keepTool) this.app._bgRefresh();
      })();
    }
    if(isActive){
      // 칸이 사라졌으므로 이웃 탭은 없다 — 닫은 칸이 포커스였으면 첫 칸으로 간다.
      const fallback=this.app.focused===rid?null:this.app.focused;
      const next=fallback&&findPane(s.layout,fallback)?fallback:firstPane(s.layout)?.id||null;
      this.app.setFocusState(next,s);
      this.app._focusWindow(s.id);
    }
    return false;
  }

  // FR-SVS-4: 탭을 고르는 **단일 통로**다. `slot` 을 주면 그 칸의 시선만 바뀌고,
  // 생략하면 포커스 칸이다. 사이드바·순회 키·클릭이 모두 여기를 지난다.
  switchTab(rid,tid,slot){
    const i=(slot==null)?this.app.slotFocused():slot;
    // 비포커스 칸의 창은 활성 창이 아닐 수 있다 — 그 칸의 창에서 pane 을 찾는다.
    const s=(slot==null)?this.app.aw():(this.app.slotWindow(i)||this.app.aw());
    if(!s) return;
    const pn=findPane(s.layout,rid); if(!pn) return;
    if(this.app.paneTab(pn,i)===tid && this.app.focused===rid){this.app.setFocusState(rid, s); return}
    this.app.paneTabSet(pn,tid,i); this.app.setFocusState(rid, s);
    this.app.save(); this.app.render();
  }

  // split is serialized through this._splitChain so that rapid successive
  // calls (e.g. holding the shortcut) don't race on this.app.focused: each call
  // waits for the previous to finish — including the setFocusState that updates
  // the new target — before reading focus or layout state.
  split(dir,opts={}){
    const prev=this._splitChain||Promise.resolve();
    const next=prev.then(()=>this._splitInner(dir,opts)).catch(err=>{console.error('[split] error',err)});
    this._splitChain=next.finally(()=>{ if(this._splitChain===next) this._splitChain=null; });
    return next;
  }

  async _splitInner(dir,opts={}){
    if(this.app.isMobile && !opts.force) return;
    const tgtWindowId=opts.targetWindow||this.app.ws.activeWindow;
    let s=this.app.ws.windows.find(x=>x.id===tgtWindowId);
    // FR-GIT-179: Git 창은 닫힌 창이다 — 분할 칸을 만들 수 없다.
    if(this.app.isGitWin(s)) return;
    // FR-EDT-50·51: Editor 창에서 분할이 생기는 유일한 길은 드래그드롭이다.
    // 단축키와 버튼은 이 자리에서 무시된다.
    if(this.app.isEditorWin(s)||this.app.isChatWin(s)) return; // CHAT_WINDOW_SRS FR-CW-11: 채팅 창도 같다
    const tgtPaneId=opts.targetPane||(tgtWindowId===this.app.ws.activeWindow?this.app.focused:null);
    if(!s||!tgtPaneId) return;
    let count=parseInt(opts.count,10); if(!Number.isFinite(count)||count<2) count=2;
    const keepFocus=!!opts.keepFocus;
    // SPLIT_KEEPFOCUS_FIX_SRS FR-SKF-1: keepFocus 면 호출 직전 사용자 포커스를 저장해 사후 복원.
    const savedWindow = keepFocus ? this.app.ws.activeWindow : null;
    const savedFocused = keepFocus ? this.app.focused : null;
    const ref=this._paneNewToolRef(s,tgtPaneId);
    const refPaneId=ref.cwd ? null : (ref.cwdTool || null);
    const newPanes=[]; let lastR=null;
    for(let i=0;i<count-1;i++){
      const p=await this.app._newTool(ref.cwd || null, refPaneId, s);
      const r=newEntityId(),tabId=newEntityId();
      newPanes.push({type:'pane',id:r,tabs:[{id:tabId,name:TAB_NAME_DEFAULT,type:TAB_TYPE_TERMINAL,toolId:p.id}],activeTab:tabId});
      lastR=r;
    }
    // Re-fetch window after awaits: this.app.ws may have been replaced by an
    // SSE workspace_changed apply during the _newTool awaits, leaving our
    // earlier `s` reference stale (and invisible to render). Bail if the
    // target pane is gone — the created panes will be reaped on the next
    // workspace sync.
    s=this.app.ws.windows.find(x=>x.id===tgtWindowId);
    if(!s||!findPane(s.layout,tgtPaneId)) return;
    s.layout=doSplit(s.layout,tgtPaneId,newPanes,dir);
    if(keepFocus){
      // FR-SKF-1: 저장된 사용자 포커스를 그대로 복원. activeWindow / focused 모두.
      // FR-SKF-3: 저장된 pane 이 사후 layout 에서 사라졌으면 무동작 + 경고.
      if(this.app.ws.activeWindow!==savedWindow && this.app.ws.windows.some(x=>x.id===savedWindow)){
        this.app._activateWindow(savedWindow);
      }
      const a=this.app.aw();
      if(a && savedFocused && findPane(a.layout,savedFocused)){
        this.app.setFocusState(savedFocused, a);
      } else if(savedFocused){
        console.warn('[split] keepFocus: savedFocused pane gone after split, leaving focus as-is');
      }
    } else {
      if(this.app.ws.activeWindow!==tgtWindowId){
        this.app._activateWindow(tgtWindowId,{rememberFocus:true});
      }
      const next = lastR || tgtPaneId;
      this.app.setFocusState(next, s);
      this.app._focusWindow(tgtWindowId);
    }
    this.app.render();
    this.app.save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 pane/tab id 반환 (echo 용).
    return {
      panes: newPanes.map(pn=>pn.id),
      tabs: newPanes.map(pn=>({uuid:pn.tabs[0].id, toolId:pn.tabs[0].toolId})),
    };
  }

  _paneNewToolRef(sess,rid){
    const pn=findPane(sess.layout,rid);if(!pn)return {};
    const tab=pn.tabs.find(x=>x.id===this.app.paneTab(pn));
    if(!tab) return {};
    // 절대경로 판정과 부모 자르기를 `/` 로 굳히지 않는다 — Windows 의 절대경로는
    // `C:\…` 로 시작하고 그 안에 `/` 가 없다. 굳히면 편집기 탭에서 만든 도구가
    // 그 파일의 폴더가 아니라 서버의 자리에서 뜬다.
    if(tab.type===TAB_TYPE_EDITOR && typeof tab.filePath==='string' && isAbsPath(tab.filePath)){
      const i=Math.max(tab.filePath.lastIndexOf('/'),tab.filePath.lastIndexOf('\\'));
      const dir = i>0 ? tab.filePath.substring(0,i) : pathSep(tab.filePath);
      return {cwd: dir};
    }
    const toolId = tab.toolId;
    // FR-OPT-4-11: 그려지지 않은 도구(다른 창)도 살아 있으면 기준이다 — cwd 는 서버가 안다.
    if (toolId && this.app.toolIds.has(toolId)) return { cwdTool: toolId };
    return {};
  }
  switchTabPrev(){
    const s=this.app.aw();if(!s||!this.app.focused)return;
    const pn=findPane(s.layout,this.app.focused);if(!pn)return;
    const i=pn.tabs.findIndex(tab=>tab.id===this.app.paneTab(pn));if(i<0)return;
    this.switchTab(pn.id,pn.tabs[(i-1+pn.tabs.length)%pn.tabs.length].id);
  }
  switchTabNext(){
    const s=this.app.aw();if(!s||!this.app.focused)return;
    const pn=findPane(s.layout,this.app.focused);if(!pn)return;
    const i=pn.tabs.findIndex(tab=>tab.id===this.app.paneTab(pn));if(i<0)return;
    this.switchTab(pn.id,pn.tabs[(i+1)%pn.tabs.length].id);
  }
  // 순회 키(Ctrl+Shift+[ ])의 **단일 디스패치 지점**이다.
  //
  // GIT_SIDEBAR_TABS_SRS FR-SBT-31/33: 이 키는 활성 사이드바 탭의 목록을 순회한다
  // — Windows 탭이면 창, Git 탭이면 리포. 새 키를 만들지 않고 대상만 바뀐다.
  // cycle 을 제공하지 않는 탭이 활성이면 아무 일도 하지 않는다 (FR-SBT-20).
  //
  _cycleActive(step){
    const d=this.app._sbTabs.find(tab=>tab.id===this.app.sbTab);
    if(!d) return;
    // UX_REVISION_SRS FR-BLP-15: 순회 규약은 블루프린트 한 자리에 있다. 탭마다
    // 자기 순회를 구현하던 때는 같은 규약이라고 적어 두고도 서로 달랐다.
    SidebarList.cycle(this.app,d,step);
  }
  switchWindowPrev(){this._cycleActive(-1)}
  switchWindowNext(){this._cycleActive(1)}
  //
  // WINDOW_SLOTS_SRS FR-WSL-40·41: 창 안에서 갈 pane 이 없으면 슬롯 경계를 넘는다.
  // **빠져나오는 자리가 셋이고 셋 모두**가 넘침으로 흘러야 한다 (§2.6) — 특히
  // `path.length<2` 는 분할이 없는 창(Git 창 포함)이 타는 자리다. 여기를 빠뜨리면
  // 터미널 창에서는 넘어가는데 Git 창에서는 안 넘어가는 비대칭이 생긴다.
  paneNavigate(dir){
    const s=this.app.aw();if(!s||!this.app.focused)return this.app.slotNavigate(dir);
    const path=s.layout?findPath(s.layout,this.app.focused):null;
    if(!path||path.length<2)return this.app.slotNavigate(dir);
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
        if(target){this.app.setFocusState(target.id, s);this.app.save();this.app.render();return}
      }
    }
    return this.app.slotNavigate(dir);
  }
  addTabFocused(){if(this.app.focused)this.app.addTab(this.app.focused,TAB_TYPE_TERMINAL).catch(err=>this.app._notify(errText(t('core.open_tab_fail'),err)))}
  closeTabFocused(){
    const s=this.app.aw();if(!s||!this.app.focused)return;
    const pn=findPane(s.layout,this.app.focused);if(!pn)return;
    this.closeTab(pn.id,this.app.paneTab(pn));
  }
  closeWindowActive(opts){this.app.delWindow(this.app.ws.activeWindow,opts||{})}

  /**
   * SIDEBAR_COLLAPSE_SRS 묶음 SBC — 사이드바 접기.
   *
   * D-5: 상태 변경·저장·재적합이 한 자리에 모인다. 흩어 두면 나중에 단축키가
   * 붙을 때 배선이 세 벌이 된다.
   *
   * D-1: 접힘은 **클래스 하나**다. 폭을 계산해 `--sb-w` 에 쓰면 펼침 폭을 잃는다
   * (FR-SBC-2) — CSS 가 `#sidebar` 의 폭을 덮는 쪽이 되돌릴 것이 없다.
   * D-2: 자리는 `documentElement` 다. index.html 의 인라인 스크립트가 같은 곳에
   * 붙이며(FR-SBC-5), 그 시점에 `body` 는 아직 없다.
   */
  sidebarCollapsed(){ return !this.sbPanel().isOpen() }

  /**
   * FR-SBC-6: 저장이 막힌 환경에서도 화면은 바뀐다. 상태는 이 탭의 것이다
   * (PANEL_LAYOUT_SRS FR-PLY-1 — 이전에는 `localStorage`, FR-SBC-4).
   *
   * FR-SBC-19: 폭이 바뀌면 터미널의 열 수가 바뀐다. 재적합은 드래그 리사이즈가
   * 끝날 때와 **같은 코드**다 (input-binding.js) — 두 벌로 두면 한쪽만 고쳐진다.
   * 상태가 그대로면 아무것도 하지 않는다: 레일의 활성 탭 클릭(FR-SBC-18)이 이미
   * 펼쳐진 사이드바에 재적합을 걸 이유가 없다. 하는 일은 `SidebarPanel` 이 맡는다 (REFACTOR3_FE_BASE_SRS FR-FEB-24).
   */
  setSidebarCollapsed(on){ this.sbPanel().setOpen(!on) }

  /** 메인 패널 (FR-FEB-24). 처음 부를 때 만든다 — 탭 줄(`SidebarTabBar`)을 든다. */
  sbPanel(){ return this.sidebarPanel||(this.sidebarPanel=new SidebarPanel(this.app)) }

  _toggleSidebar(){this.app.setSidebarCollapsed(!this.sidebarCollapsed())}

  /**
   * PANEL_SURFACE_SRS FR-RAL-9·10: **사이드바가 지금 레일인가.**
   *
   * CSS 선택자 `html.sb-collapsed body:not(.mobile)` 와 같은 판정이며, JS 쪽의
   * 유일한 자리다. 접힘만으로는 답이 되지 않는다 — 모바일에서 사이드바는
   * 드로어이고(FR-SBC-20) 그때 접힘 클래스는 아무것도 좁히지 않는다.
   */
  sbRail(){return this.sidebarCollapsed()&&!this.app.isMobile}

  /**
   * UI_KIT_SRS FR-HSZ-5: **이 영역 안에 있는 보이는 터미널.**
   *
   * 핸들의 한쪽이 터미널이면 크기 표시에 `C×R` 줄이 붙고, 아니면 붙지 않는다.
   * 그 판정을 각 핸들이 따로 하면 "어느 칸이 터미널인가" 가 여섯 벌이 된다.
   *
   * `vis` 를 함께 보는 이유는 숨은 도구가 DOM 에 남아 있기 때문이다 — 그것을
   * 집으면 보이지 않는 칸의 격자를 보이는 칸의 값으로 적게 된다.
   */
  termIn(el){
    if(!el) return null;
    for(const p of this.app.tools.values())
      if(p.term&&p.el&&p.el.classList.contains('vis')&&el.contains(p.el)) return p;
    return null;
  }
}

// 바깥이 부르는 이름 — `app.js`(단축키)·`app-cmd.js`·`app-dnd.js`·`app-dock.js`·편집기·채팅·`ui/`·e2e·계약.
Controller.delegate(App,'layout.tabOps',['closeTab','switchTab','split','switchTabPrev','switchTabNext','switchWindowPrev',
  'switchWindowNext','paneNavigate','addTabFocused','closeTabFocused','closeWindowActive','sidebarCollapsed','setSidebarCollapsed',
  'sbPanel','_toggleSidebar','sbRail','termIn']);
