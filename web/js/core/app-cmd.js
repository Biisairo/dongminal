/**
 * Remote Terminal — App 원격 커맨드 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 7개. 본문은 수정하지 않았다 (FR-APP-3).
 * 워크스페이스 동기화·SSE 배선은 `app-ws-sync.js` 로 갈랐다 (REFACTOR PROD2 §8).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
/**
 * M9_SRS FR-M9-4: 원격 닫기 명령의 인자를 `closeTab`·`delWindow` 의 opts 로 옮긴다.
 *
 * 두 자리가 같은 규칙을 쓰므로 함수로 둔다 — 손으로 옮겨 적으면 한쪽만 고쳐진다.
 * `keepTool` 은 `force` 없이 오지 않는다(`dmctl` 이 둘을 함께 싣는다). 그래도 여기서
 * 함께 세우는 것은, 답을 준 요청이 확인창을 만나면 무인 정리가 그 자리에서 멎기 때문이다.
 */
function _closeOpts(args){
  if(!args||(!args.force&&!args.keepTool)) return undefined;
  const o={force:true};
  if(args.keepTool) o.keepTool=true;
  return o;
}

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-2 (FEC-23 · IPC-17): 원격 action → 처리기.
 *
 * **이름의 집합은 서버의 허용 표(`hub/commands.go` `cmdActions`)와 같다** —
 * `remote-actions.test` 가 두 표를 대조한다. 서버가 받는 action 을 더하면 여기에도
 * 처리기를 더해야 검사가 통과한다.
 *
 * 생성 명령의 처리기는 echo 할 결과(`{newWindows,newPanes,newTabs}`)를 약속으로
 * 돌려준다 (FR-RCR-6). 시선 이동은 앱 단축키와 같은 함수를 부른다(`executeAction`).
 */
const REMOTE_ACTIONS=Object.freeze({
  focus:(app,a)=>app._remoteFocus(a),
  // VIEWER_URL_OPEN_SRS FR-VUO-3: 서버가 원격 뷰어라 판정했을 때만 온다.
  // 지명(execClientId)은 event-bus 가 이미 걸렀으므로 여기 오면 이 기기가
  // 열 차례다.
  openUrl:(app,a)=>OpenUrl.handle(a.url),
  openEditorTab:(app,a)=>app._remoteOpenEditorTab(a),
  renameTab:(app,a)=>app._remoteRename('renameTab',a),
  renameWindow:(app,a)=>app._remoteRename('renameWindow',a),
  newWindow:(app,a)=>app._remoteNewWindow(a),
  newTab:(app,a)=>app._remoteNewTab(a),
  splitH:(app,a)=>app._remoteSplit('horizontal',a),
  splitV:(app,a)=>app._remoteSplit('vertical',a),
  detachTab:(app,a)=>app._remoteDetachTab(a),
  restoreTool:(app,a)=>app._remoteRestoreTool(a),
  closeWindow:(app,a)=>app._remoteCloseWindow(a),
  closeTab:(app,a)=>app._remoteCloseTab(a),
  windowNext:(app,a)=>app._remoteViaAction('windowNext',a),
  windowPrev:(app,a)=>app._remoteViaAction('windowPrev',a),
  tabNext:(app,a)=>app._remoteViaAction('tabNext',a),
  tabPrev:(app,a)=>app._remoteViaAction('tabPrev',a),
  paneUp:(app,a)=>app._remoteViaAction('paneUp',a),
  paneDown:(app,a)=>app._remoteViaAction('paneDown',a),
  paneLeft:(app,a)=>app._remoteViaAction('paneLeft',a),
  paneRight:(app,a)=>app._remoteViaAction('paneRight',a),
  // ISSUE_AGENT_TREE_SRS 묶음 G·O (`app-groups.js`).
  newGroup:(app,a)=>app._remoteNewGroup(a),
  renameGroup:(app,a)=>app._remoteRenameGroup(a),
  deleteGroup:(app,a)=>app._remoteDeleteGroup(a),
  moveTab:(app,a)=>app._remoteMoveTab(a),
  moveWindow:(app,a)=>app._remoteMoveWindow(a),
  moveGroup:(app,a)=>app._remoteMoveGroup(a),
});

Object.assign(App.prototype, {
  // REMOTE_COMMAND_RESULT_SRS FR-RCR-6: 생성 명령의 새 엔터티 id 를 reqId 와 묶어
  // 서버에 echo. best-effort — 실패해도 서버 timeout 이 백스톱 (DC-RCR-3).
  _echoResult(reqId, result){
    const body={
      reqId,
      newWindows:result.newWindows||[],
      newPanes:result.newPanes||[],
      newTabs:result.newTabs||[],
    };
    // ISSUE_AGENT_TREE_SRS FR-WGR-30 · FR-ORD-6: 새 그룹 id, 이동의 최종 위치, 실패 사유.
    if(result.newGroups) body.newGroups=result.newGroups;
    if(result.position) body.position=result.position;
    if(result.error) body.error=result.error;
    apiPost('/api/command-result',body);
  },

  /**
   * 구독자 없는 action 의 처리 (FR-OPT-11-2 · FEC-23 · IPC-17).
   *
   * 처리기는 `REMOTE_ACTIONS` 표에서 찾는다 — 종전의 190줄 if-체인은 `return` 하나를
   * 빠뜨리면 공통 경로로 떨어졌다(FR-RUN-6b 의 사고가 그 꼴이다). 생성 명령의 처리기는
   * echo 할 결과를 약속으로 돌려주고, echo 는 여기 한 자리에서 한다 (FR-RCR-6).
   * 표에 없는 action 은 종전대로 공통 경로(`executeAction`)로 간다.
   */
  _execRemote(action, args){
    args=args||{};
    const h=Object.hasOwn(REMOTE_ACTIONS,action)?REMOTE_ACTIONS[action]:null;
    if(!h){ this._remoteViaAction(action,args); return }
    const r=h(this,args);
    if(args.reqId&&r&&typeof r.then==='function'){
      r.then(res=>{ if(res) this._echoResult(args.reqId,res) });
    }
  },

  // 시선 이동·지목 없는 닫기의 공통 경로. `-n` 이면 명령 뒤에 시선을 되돌린다 (FR-M11-11).
  _remoteViaAction(action,args){
    const back=this._viewMark(args,!!args.keepFocus);
    if(args.location) this._focusLocation(args.location);
    Promise.resolve(this.executeAction(action)).then(()=>this._viewRestore(back));
  },

  _remoteFocus(args){
    // Multi-window: only apply focus if the source pane is in this window's
    // *active* window. If the pane belongs to a window that another
    // window is viewing, this window stays put.
    if(args.sourcePane && !this._isToolInActiveWindow(args.sourcePane)) return;
    this._focusLocation(args.location);
  },

  _remoteOpenEditorTab(args){
    const{name,filePath,location}=args;
    if(!filePath){console.warn('[cmd] openEditorTab: filePath required');return}
    // FR-EDT-94·96: 편집기 탭은 Editor 창에서만 열린다. 대상은 **그 경로에
    // 연결된 Editor** 이고 없으면 root 에디터다 (FR-EDT-95) — 기준 경로가 파일
    // 자신이므로 anchor 를 따로 주지 않는다. `location` 은 따라가지 않는다:
    // 어느 창에 열지는 루트가 정하지 사용자가 서 있던 자리가 정하지 않는다.
    if(this.edOn()){
      this.edOpenFile(filePath,{name:name||pathBase(filePath)});
      return;
    }
    if(location) this._focusLocation(location);
    const rid=this.focused;
    if(rid) this.addTab(rid,TAB_TYPE_EDITOR,{name:name||pathBase(filePath),filePath});
  },

  // RENAME_TAB_SESSION_SRS FR-RNS-1/2: 순수 데이터 변경 — 포커스 무영향.
  _remoteRename(action,args){
    // FR-TAN-22: `rename-tab --auto` 는 이름 없이 온다 — 자동으로 되돌리는
    // 것이 그 명령의 전부다. 창 이름에는 출처가 없으므로 해당 없다.
    const toAuto=action==='renameTab'&&!!args.auto;
    if(!args.location||(!args.name&&!toAuto)){console.warn('[cmd] '+action+': location/name 필수');return}
    const tgt=this._resolveLocation(args.location);
    if(!tgt){console.warn('[cmd] '+action+': 대상 없음',args.location);return}
    if(toAuto){ this._tabToAuto(tgt.tab); this.save(); this.render(); return }
    const name=clampEntityName(args.name);
    // FR-TAN-2: 에이전트가 준 이름도 사용자가 준 이름과 같은 자격이다 —
    // 역할명이 다음 조회에 지워지면 안 된다.
    if(action==='renameTab'){ tgt.tab.name=name; this._tabToManual(tgt.tab) }
    else tgt.win.name=name;
    this.save(); this.render();
  },

  // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-5: newWindow/newTab 은 name/keepFocus
  // 를 전달하기 위해 명시 분기. 의미는 _mkWindow/addTab 내부에서 보장.
  _remoteNewWindow(args){
    // ISSUE_AGENT_TREE_SRS FR-WGR-33: 그 그룹의 끝에 만든다. 없는 그룹이면 만들지 않는다.
    if(args.group&&!this.windowGroups().some(g=>g.id===args.group)) return Promise.resolve({error:'not_found'});
    // FR-WBR-22: `dmctl` 은 더 이상 호출자 도구를 자동으로 싣지 않는다 —
    // 새 창은 홈에서 뜬다. `cwdTool` 은 다른 호출자가 명시로 줄 때만 온다
    // (FR-CWD-3 은 남는다).
    // FR-WBR-23: `--cwd` 가 오면 그 경로다. `--workdir` 은 샌드박스 창의
    // 컨테이너 안 자리라 다른 인자이며, 둘이 함께 오면 앞의 것이 이긴다.
    // M8 D-A-25: 도구 생성의 거부(없는 `--cwd` 400 · 샌드박스 실패)는 화면에
    // 말한다. echo 는 내지 않는다 — dmctl 은 `timedOut` 으로 exit 1 을 받는다(D-A-2).
    return this._mkWindow({name:args.name,keepFocus:!!args.keepFocus,cwdTool:args.cwdTool,
      sandbox:args.sandbox,cwd:args.cwd||args.workdir}).then((c)=>{
      if(c&&args.group) this.moveWindowTo(c.win,{to:args.group});
      this.render();
      return c&&{newWindows:[c.win],newPanes:[c.pane],newTabs:[c.tab]};
    }).catch(err=>{ this._notify(errText(t('core.open_window_fail'),err)) });
  },

  _remoteNewTab(args){
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
    if(!rid) return;
    // ISSUE_AGENT_TREE_SRS FR-ORD-11: 만든 뒤 그 칸 안에서 자리를 잡는다.
    return this.addTab(rid,TAB_TYPE_TERMINAL,opts).then((tab)=>{
      if(tab&&(args.after||args.index!==undefined)) this.moveTabTo(tab.uuid,args.after?{after:args.after}:{index:args.index});
      return tab&&{newTabs:[tab]};
    })
      .catch(err=>{ this._notify(errText(t('core.open_tab_fail'),err)) });
  },

  _remoteSplit(dir,args){
    const opts={count:args.count,keepFocus:!!args.keepFocus};
    if(args.location){
      const tgt=this._resolveLocation(args.location);
      if(!tgt) return;
      opts.targetWindow=tgt.windowId;
      opts.targetPane=tgt.paneId;
    }
    return this.split(dir,opts).then((c)=>c&&{newPanes:c.panes,newTabs:c.tabs});
  },

  // FR-BG-2: detach 명령 — 도구를 백그라운드로 보내고 탭을 닫는다.
  _remoteDetachTab(args){
    const loc=this.findToolLocation(args.toolId);
    if(!loc){console.warn('[cmd] detachTab: 도구 위치 없음',args.toolId);return}
    if(!toolBackgroundCapable(loc.tab.type)){
      console.warn('[cmd] detachTab: 백그라운드 미지원 도구',loc.tab.type);return;
    }
    this.closeTab(loc.pane.id,loc.tab.id,loc.win.id,{keepTool:true});
  },

  _remoteRestoreTool(args){
    // FR-BGR-2: location 은 좌표나 탭 uuid 다(원격 tab 배치는 uuid, PEER_NETWORK_SRS I-63).
    // 복귀는 Pane 단위이므로 T 성분은 쓰지 않는다 (newTab/splitH 와 같은 해석).
    const opts={};
    if(args.location){
      const tgt=this._resolveLocation(args.location);
      if(!tgt){console.warn('[cmd] restoreTool: 대상 없음',args.location);return}
      opts.windowId=tgt.windowId; opts.paneId=tgt.paneId;
    }
    this._restoreTool(args.toolId,opts);
  },

  /**
   * M9_SRS FR-M9-4: `closeWindow` 도 답을 미리 받는다.
   *
   * 자리를 지목하지 않은 `closeWindow` 는 공통 경로에서 `executeAction` 이
   * **활성 창**을 닫는다 — 그 길에 opts 를 실을 자리가 없어 여기서 가른다.
   * 지목했으면 `_focusLocation` 으로 그 창을 활성으로 만든 뒤 같은 함수를 부른다
   * (좌표 해석은 한 벌이다).
   */
  _remoteCloseWindow(args){
    if(!(args.force||args.keepTool)){ this._remoteViaAction('closeWindow',args); return }
    /**
     * M11_SRS FR-M11-11 (M11-B9 의 둘째): **`-n` 은 이 갈래에서도 지켜진다.**
     *
     *   이전 동작: 지목한 창을 활성으로 만든 뒤 닫는다 — 공통 경로의
     *             복원 블록을 지나지 않아 `keepFocus` 가 통째로 무시됐다
     *   새  동작: 공통 경로와 **같은 함수**로 시선을 되돌린다
     *   이유:     `-n` 은 "명령 전후로 사용자 포커스를 이동시키지 않는다" 는
     *             약속이고, 한 갈래만 지키지 않으면 없는 것과 같다
     */
    const back=this._viewMark(args,!!args.keepFocus);
    if(args.location) this._focusLocation(args.location);
    Promise.resolve(this.closeWindowActive(_closeOpts(args)))
      .then(()=>this._viewRestore(back));
  },

  // location 지정 closeTab 은 활성/비활성 창 구분 없이 포커스를 건드리지 않고 직접 close.
  // keepFocus 인자는 호환을 위해 받지만, location 이 있으면 항상 포커스 유지로 취급한다.
  _remoteCloseTab(args){
    if(!args.location){ this._remoteViaAction('closeTab',args); return }
    const tgt=this._resolveLocation(args.location);
    if(tgt && tgt.paneId && tgt.tabId){
      // UX_BATCH6_SRS FR-RUN-6: `force` 는 확인창을 건너뛴다. 서버가 이미
      // 에이전트에게 종료를 청하고 기다린 뒤이며, 사용자의 결정은 그 명령을
      // 부른 순간에 있었다.
      //
      // M9_SRS FR-M9-4: `keepTool` 은 그 답이 "백그라운드로 보내기" 일 때다
      // (`dmctl close-tab --background`). `force` 없이 오지 않는다 — 답을 준
      // 요청이 확인창을 만나면 그 자리에서 멎는다.
      this.closeTab(tgt.paneId, tgt.tabId, tgt.windowId, _closeOpts(args));
      return;
    }
    /**
     * UX_BATCH6_SRS FR-RUN-6b: **자리를 찾지 못하면 아무것도 닫지 않는다.**
     *
     *   이전 동작: 공통 경로로 떨어져 `_focusLocation` 이 실패하고,
     *             그대로 `executeAction('closeTab')` 이 **포커스 탭**을 닫았다
     *   새  동작: 사유를 남기고 끝낸다
     *   이유:     지목한 자리를 못 찾은 명령이 **엉뚱한 탭을 지우는** 것은
     *             어떤 경우에도 옳지 않다. 이미 닫힌 탭을 한 번 더 닫으라는
     *             요청이 사용자의 터미널을 없애는 것을 실측했다 (e2e
     *             `skill-contract` 의 "사용자 공간이 전후로 같다" 가 잡았다)
     *
     * `_resolveLocation` 과 `_focusLocation` 은 같은 규칙을 쓰므로, 앞이
     * 실패했으면 뒤도 실패한다 — 이 갈래에서 잃을 정상 동작이 없다.
     */
    console.warn('[cmd] closeTab: 대상 없음',args.location);
  },

  /**
   * FR-M11-11: **되돌릴 자리를 적는다.** `location` 을 지목한 명령이 `keepFocus`
   * 와 함께 올 때만 적는다 — 지목이 없으면 그 명령은 애초에 활성 자리를 대상으로
   * 하므로 되돌릴 "다른 자리" 가 없다.
   */
  _viewMark(args,keepFocus){
    if(!(args&&args.location&&keepFocus)) return null;
    return {win:this.ws.activeWindow, pane:this.focused};
  },

  /**
   * FR-M11-11: 적어 둔 자리로 시선을 되돌린다.
   *
   * **두 호출처가 이 함수 하나를 함께 쓴다** — 종전에는 공통 경로에만 있었고
   * `closeWindow` 의 `force` 갈래가 그것을 지나지 않았다. 두 벌로 두면 한쪽만
   * 고쳐진다 (이 저장소가 여러 번 겪은 자리).
   *
   * 창이 사라졌으면 되돌리지 않는다 — 없는 창으로 갈 수는 없고, 그때의 폴백은
   * 닫기가 이미 세운 것이 옳다.
   */
  _viewRestore(back){
    if(!back) return;
    if(this.ws.activeWindow!==back.win && this.ws.windows.some(x=>x.id===back.win)){
      this._activateWindow(back.win,{rememberFocus:true});
      this._focusWindow(back.win);
    }
    const a=this.aw();
    if(a&&back.pane&&findPane(a.layout,back.pane)) this.setFocusState(back.pane,a);
    this.save(); this.render();
  },

  /**
   * UX_BATCH6_SRS FR-RUN-6a: **탭 uuid 를 먼저 본다.**
   *
   *   이전 동작: 좌표(`W1.P1.T1`)만 해석했다
   *   새  동작: uuid 면 그 탭을 찾고, 아니면 종전대로 좌표로 읽는다
   *   이유:     좌표는 **자리**라 앞의 탭이 닫히면 뒤의 것이 밀린다. 여러 탭을
   *             한 번에 닫는 명령(Run 정리, FR-RUN-6)이 좌표를 미리 계산해
   *             보내면 두 번째부터 **엉뚱한 탭**을 가리킨다. uuid 는 그 성질이
   *             없고, 그것이 uuid 를 둔 이유다 (FR-IDU-1)
   *
   * `/api/commands` 는 종전대로 uuid 를 좌표로 바꿔 보낸다 — 그 경로는 바뀌지
   * 않는다. 여기서 uuid 를 함께 받는 것은 **서버가 직접 방송하는** 명령을 위한
   * 것이다.
   */
  _resolveLocation(loc){
    if(!loc) return null;
    // 좌표 모양이 아니면 uuid 다. **좌표를 먼저 본다** — 옛 워크스페이스의 짧은
    // 숫자 id 가 좌표로도 읽히는 경우에 뜻이 갈리지 않게 한다.
    const at=this._parseLocation(loc);
    return at?this._locationAt(at):this._findTabById(String(loc));
  },

  // "4.1.1", "W4.P1.T1", "4", "4.2" 등. 1-base positional (window.pane.tab) → 0-base.
  _parseLocation(loc){
    const m=String(loc).toUpperCase().trim().match(/^W?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m) return null;
    return {si:parseInt(m[1],10)-1, pi:m[2]?parseInt(m[2],10)-1:0, ti:m[3]?parseInt(m[3],10)-1:0};
  },

  _locationAt({si,pi,ti}){
    const win=this.ws.windows[si]; if(!win) return null;
    const pane=panesOf(win.layout)[pi]; if(!pane) return null;
    const tab=pane.tabs[ti]; if(!tab) return null;
    return {windowId:win.id,paneId:pane.id,tabId:tab.id,win,pane,tab};
  },

  // 탭 uuid 로 그 자리를 찾는다. 없으면 null 이다 (FR-RUN-6a).
  _findTabById(id){
    const r=findTabWhere(this.ws.windows,tab=>tab.id===id);
    return r&&{windowId:r.win.id,paneId:r.pane.id,tabId:r.tab.id,...r};
  },

  // `focus` 명령은 좌표만 받는다 (uuid 는 `_resolveLocation` 을 지나는 명령의 것이다).
  _focusLocation(loc){
    if(!loc){console.warn('[cmd] focus: location 누락');return}
    const at=this._parseLocation(loc);
    if(!at){console.warn('[cmd] focus: 형식 오류',loc);return}
    const r=this._locationAt(at);
    if(!r){console.warn('[cmd] focus: 자리 없음',loc);return}
    this._activateWindow(r.win.id,{rememberFocus:true});
    this.paneTabSet(r.pane,r.tab.id);
    this.setFocusState(r.pane.id, r.win);
    this._focusWindow(r.win.id);
    this.save(); this.render();
  },
});
