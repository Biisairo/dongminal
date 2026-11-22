/**
 * Remote Terminal — 도구 수명 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * 백그라운드·복원·만들기·죽이기·찾기. `ToolController` 의 부품 `.life` 다(REFACTOR3_FE_APPCTL_SRS 9j, 옛 `app-tool.js` 의 뒤쪽).
 */
class ToolLife extends Controller {

  // _setToolBackground는 도구를 백그라운드로 보내거나 되돌린다. 실패해도
  // 호출자의 흐름을 막지 않는다 — 탭 닫기가 알림 실패로 멈추면 더 나쁘다.
  async _setToolBackground(toolId,bg){
    if(!toolId) return false;
    const r=await apiPost('/api/tools/background/set',{toolId,background:!!bg});
    return r.ok;
  }

  /**
   * 백그라운드 목록 (FR-BGV-1).
   *
   * `state-registry` 의 `merge:'latest'` — **추월만 막는다.**
   * `tools_background_changed` 는 증분을 나르지 않고 "목록을 다시 받으라" 는
   * 신호이므로 만진 id 라는 개념이 없다. 막아야 하는 것은 두 스냅샷이 겹칠 때
   * 늦게 떠난 것이 먼저 도착해 새 목록을 낡은 것으로 되돌리는 일이다.
   */
  async _bgRefresh(src){
    const flight=this.app._restoreBegin('background');
    const r=await stateFetch(src,'/api/tools/background');
    if(!r.ok||!r.data) return;
    if(!this.app._restoreLive('background',flight)) return;
    this.app._bg=Array.isArray(r.data.background)?r.data.background:[];
    this.app._restoreEnd('background',flight);
    this.app.statusbar.updateStatusBar();
    this.app.statusbar._bgPanelPaint();
  }

  // FR-BGR-7: 복귀 대상 Pane 을 고른다.
  //
  // 명시 대상(opts.paneId)은 폴백하지 않는다 — 지목한 곳이 사라졌으면 실패가
  // 옳고, 그때 도구는 백그라운드 목록에 남아 여전히 닿을 수 있다 (TC-BGR-6b).
  // location 미지정은 "대상을 정하지 않았다"는 뜻이므로 폴백이 정당하다.
  async _restorePane(opts){
    if(opts.paneId){
      const win=this.app.ws.windows.find(s=>s.id===opts.windowId)||null;
      return win&&win.layout?findPane(win.layout,opts.paneId):null;
    }
    for(let i=0;i<RESTORE_PANE_WAIT_TRIES;i++){
      // FR-EDT-54: Editor 창에는 편집기 탭만 산다. 복귀는 `addTab` 을 거치지 않고
      // 터미널 탭을 pane 에 직접 넣으므로(`_restoreTool`) 그 게이트가 여기에도
      // 있어야 한다 — 없으면 Editor 창에 터미널 탭이 생기고, 일반 창만 걷는
      // `_migrateEditorTabs` 가 그것을 영원히 지나친다. Git 창도 같은 구멍이다.
      const a=this.aw();
      const cur=this.app.git.isKindWin(a)?null:a;
      const pn=(this.app.focused&&cur&&cur.layout?findPane(cur.layout,this.app.focused):null)
        ||(cur&&cur.layout?firstPane(cur.layout):null)
        ||this.app.git.plainWindows().map(s=>firstPane(s.layout)).find(Boolean)
        ||null;
      if(pn) return pn;
      // 창이 하나도 없는 것은 delWindow 가 _mkWindow 를 끝내기 전의 과도
      // 상태뿐이다. 조용히 무효가 되지 않도록 그 왕복만큼 기다린다.
      await this.app.timers.sleep(RESTORE_PANE_WAIT_MS,{owner:'app',label:'restore-pane'});
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
    /**
     * FUI-21: **실패를 화면이 말한다.**
     *
     * 이 함수는 백그라운드 **구역의 행 클릭**에서 불린다. `console.warn` 은
     * 사용자에게 아무것도 아니다 — 화면에서 보면 "눌렀는데 아무 일도 없음"
     * 이고, 그 상태에서 할 수 있는 것은 같은 것을 다시 누르는 일뿐이다.
     * (모달이던 시절에는 이미 닫힌 뒤라 더 그랬다 — FR-ACT-2 로 표면이
     * 패널이 된 지금은 목록이 그대로 보이므로 안내가 그 위에 선다.)
     *
     * 도구는 두 갈래 모두에서 **백그라운드 목록에 그대로 남는다** (FR-BGR-5 가
     * 대상 확정을 앞세운 이유) — 안내가 그 사실을 함께 말한다.
     */
    if(!pn){
      console.warn('[bg] 복귀할 분할 칸 없음',opts.paneId||this.app.focused);
      Toast.show(BG_RESTORE_NO_PANE,'err');
      return;
    }
    if(!await this._setToolBackground(toolId,false)){
      Toast.show(BG_RESTORE_FAIL,'err');
      return;
    }
    const tabId=newEntityId();
    if(!this.app.tools.has(toolId)) this.app.mkTool(toolId,DEFAULT_TOOL_NAME);
    pn.tabs.push({id:tabId,name:TAB_NAME_DEFAULT,type:TAB_TYPE_TERMINAL,toolId});
    this.app.paneTabSet(pn,tabId);
    this.app.render();
    this.app.save();
    this._bgRefresh();
  }

  // win 은 이 도구가 들어갈 창이다. 샌드박스 창이면 도구가 그 창의 대응
  // 컨테이너 안에서 뜬다 (SANDBOX_WINDOW_SRS FR-SBX-11).
  async _newTool(cwd,cwdTool,win){
    // FR-OPT-11-7 (FEC-31): 쿼리는 `apiPost` 의 `query` 가 조립한다 — 손으로 잇지 않는다.
    const query={cols:TOOL_COLS_DEFAULT,rows:TOOL_ROWS_DEFAULT};
    if(cwd) query.cwd=cwd;
    else if(cwdTool) query.cwdTool=cwdTool;
    // 프로파일을 창 id 와 **함께** 보낸다. 서버가 workspace 를 조회하게 하면,
    // 창이 저장되기 전에 탭이 만들어지는 순간 샌드박스 창이 일반 창으로 읽혀
    // 호스트에서 뜬다 (FR-SBX-10).
    if(win&&win.sandbox&&win.id){
      query.window=win.id; query.sandbox=win.sandbox;
      // UX_BATCH6_SRS FR-SBM-3: 이 창이 고른 작업 방식. 창 레코드에 사는 이유는
      // 뒤에 만드는 탭도 **같은 컨테이너**에 들어가기 때문이다 — 프로파일과 같다.
      if(win.sandboxWork) query.sandboxWork=win.sandboxWork;
    }
    const r=await apiPost(TOOLS_API,null,{query});
    if(!r.ok){
      // FR-SBX-20: 샌드박스 기동 실패의 사유는 사용자에게 닿아야 한다 — 런타임
      // 미설치·데몬 미실행·이미지 없음이 모두 여기로 온다. 뭉개면 "창이 안 열린다"
      // 만 남는다.
      throw new Error(r.text.trim()||'create pane failed');
    }
    const {id,name}=r.data;
    return this.app.mkTool(id,name);
  }

  async _focusedCwd(){
    const p=this.app.tool.search.focusedTerminal();
    if(!p) return null;
    const r=await apiGet('/api/cwd',{query:{tool:p.id}});
    return (r.data&&r.data.cwd)||null;
  }

  // FR-ATL-7: 지우는 도구의 알람은 로컬에서 먼저 뗀다. 서버 브로드캐스트를
  // 기다리면 그 사이 배지가 없는 도구를 가리키고, 통지가 유실되면 영영 남는다.
  // FR-WSL-22: 도구를 지우는 경로는 **모든 슬롯의 인스턴스**를 파괴한다. 슬롯 1 의
  // 인스턴스가 남으면 이미 죽은 PTY 로 재연결을 시도한다.
  // FR-SAF-17·18: 칸 목록을 손으로 적지 않는다. 종전에는 `[pid, slotKey(pid,1)]`
  // 두 칸만 돌아, `SLOT_MAX` 가 4 로 자란 뒤 슬롯 2·3 의 인스턴스가 살아남았다.
  _killToolInstances(pid){
    this.app.toolIds.delete(pid); this.app._toolsBoot.delete(pid);
    for(const k of this.app.slotKeysOf(pid)){
      const p=this.app.tools.get(k);
      if(p){ErrorLog.quiet('destroy',()=>p.destroy()); this.app.tools.delete(k)}
    }
  }

  async _kill(pid){
    this._killToolInstances(pid);
    if(this.app.attn._attnDrop(pid)) this.app.attn._attnRefresh();
    await apiDel(`/api/tools/${pid}`);
  }
  _killTool(pid){
    this._killToolInstances(pid);
    if(this.app.attn._attnDrop(pid)) this.app.attn._attnRefresh();
    apiDel(`/api/tools/${pid}`);
  }

  aw(){return this.app.ws.windows.find(s=>s.id===this.app.ws.activeWindow)||null}

  // _isToolInActiveWindow reports whether a pane (by id) is present in the
  // currently active window's layout. Used to route focus commands only to
  // the window that is actually viewing the source pane (multi-window).
  _isToolInActiveWindow(toolId){
    if(!toolId) return false;
    const s=this.aw();
    if(!s||!s.layout) return false;
    return !!findTabWhere([s],tab=>tab.toolId===toolId);
  }

  /**
   * FR-NAM-1: 도구 이름을 묻는 자리는 전부 여기를 지난다. 탭이 있으면 그
   * 탭의 규칙(FR-TAN-15)이 적용되고, 없으면 파생 이름이 답한다.
   */
  _toolName(toolId,fallback){
    const loc=this.findToolLocation(toolId);
    return toolDisplayName(toolId,this.app.fgNames,loc&&loc.tab,fallback);
  }

  // toolId 를 가진 tab 의 위치 (FR-PAN-16)
  findToolLocation(toolId){
    return toolId?findTabWhere(this.app.ws.windows,tab=>tab.toolId===toolId):null;
  }
}
