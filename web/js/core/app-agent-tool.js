/**
 * App — 에이전트 도구 (M8_UNIFIED_SRS 묶음 T, FR-AGT-1·7·8·10).
 *
 * 에이전트 탭은 `type:'agent'` + `toolId` 다 (D-C-1). `toolId` 를 보는 길(닫기·백그라운드·
 * 포커스 소유·복원)은 터미널 도구와 같고, 여기 있는 것은 종류가 갈리는 셋 중 **뷰**
 * 하나다 — 인스턴스(`AgentPane`)의 수명과 SSE 배선, 그리고 TUI 출구.
 */
Object.assign(App.prototype, {
  /** FR-WSL-20: 슬롯마다 인스턴스. `mkTool` 과 같은 규약이다. */
  mkAgent(id,name,slot){
    if(!this.agentPanes) this.agentPanes=new Map();
    const key=this.slotKey(id,slot||0);
    if(this.agentPanes.has(key)) return this.agentPanes.get(key);
    const p=new AgentPane(this,id,name);
    p._slot=slot||0;
    document.getElementById('area').appendChild(p.el);
    p.connect();
    this.agentPanes.set(key,p);
    this.applyFocusOverlay();
    return p;
  },

  _agentPanesOf(toolId){
    if(!this.agentPanes) return [];
    const out=[];
    for(const [k,p] of this.agentPanes) if(this.slotBase(k)===toolId) out.push(p);
    return out;
  },

  /** 등록부에서 파생한 목록 — 프로토콜 표면이 있고 실행 파일이 있는 것만 (FR-APS-4). */
  async _agentList(){
    if(this._agentListCache) return this._agentListCache;
    const r=await apiGet('/api/agents');
    const all=r.ok&&Array.isArray(r.data)?r.data:[];
    this._agentListCache=all.filter(a=>a&&a.proto&&a.available).map(a=>a.id);
    return this._agentListCache;
  },

  /** 메뉴 항목 — 에이전트마다 하나. 없으면 사유 하나. */
  agentMenuItems(paneId){
    const ids=this._agentListCache||[];
    if(!ids.length) return [{id:'agent-none',label:t('agent.no_agents'),disabled:true}];
    return ids.map(id=>({id:'agent:'+id,label:t('agent.tab_new',{agent:id}),onClick:()=>this.addTab(paneId,'agent',{agent:id})}));
  },

  /**
   * `POST /api/tools?kind=agent` — 터미널 도구와 같은 종단이다 (FR-AGT-8). 실패의
   * 문장은 프론트의 것이다 (D-B-3).
   */
  async _newAgentTool(agent,cwd,cwdTool,win,opts){
    let q='&agent='+encodeURIComponent(agent);
    if(cwd) q+='&cwd='+encodeURIComponent(cwd);
    else if(cwdTool) q+='&cwdTool='+encodeURIComponent(cwdTool);
    if(win&&win.id) q+='&window='+encodeURIComponent(win.id);
    if(opts&&opts.model) q+='&model='+encodeURIComponent(opts.model);
    // FR-M9-33: 세션을 이어받아 띄운다 (`LaunchOpts.Resume`). 종단은 이 질의를
    // 이미 받고 있었다 — 없던 것은 그것을 쓰는 쪽이다.
    if(opts&&opts.resume) q+='&resume='+encodeURIComponent(opts.resume);
    // F-4: 승인 정책은 설정이다. 어댑터가 자기 어휘로 싣거나 무시한다.
    if(agentApprovalMode) q+='&approval='+encodeURIComponent(agentApprovalMode);
    const r=await apiPost('/api/tools?kind=agent'+q);
    if(!r.ok){ Toast.show(apiErrText(r,t('agent.create_fail')),'err'); return null }
    return r.data;
  },

  /** SSE `agent_event` — 그 도구의 뷰(슬롯마다)로 간다. */
  _onAgentEvent(a){
    if(!a||!a.toolId) return;
    for(const p of this._agentPanesOf(a.toolId)) p.onEvent(a);
  },

  /** SSE 가 다시 붙었다 — 놓친 seq 가 있을 수 있으니 전부 재생으로 맞춘다. */
  _agentResyncAll(){
    if(!this.agentPanes) return;
    for(const p of this.agentPanes.values()) p.resync();
  },

  /**
   * FR-AGT-10 TUI 출구 — 같은 세션을 터미널 탭에서. 서버가 준 한 줄을 새 터미널
   * 탭의 셸에 넣는다; 그 탭의 에이전트는 훅으로 관측된다 (병행).
   *
   * M9_SRS FR-M9-31 (M9-B14): **전환은 제자리에서 일어난다.**
   *
   *   이전 동작: `addTab` 만 했다 — 터미널 탭이 하나 **더** 생기고 에이전트 탭이
   *             남았다. 사용자의 말로 *"자연스럽지 못하다"* 인 자리다
   *   새  동작: 새 터미널 탭을 **옛 에이전트 탭의 자리**로 옮기고 그 탭을 닫는다
   *   이유:     세션은 하나인데 표면이 둘 남으면 어느 쪽이 살아 있는지 화면이
   *             말하지 못한다. 남은 에이전트 도구는 세션을 놓은 껍데기가 된다
   *
   * **반대 방향은 대칭이 아니다** (D-M9-20). 터미널 → 에이전트에서는 탭을 남긴다 —
   * 그 탭에는 사용자의 셸이 살기 때문이다.
   *
   * 닫기는 `force` 로 지난다. 이것은 닫기가 아니라 **전환**이고, 그 세션은 방금 연
   * 터미널에서 이어진다 — 여기서 "정말 닫을까요" 를 묻는 것은 물음이 아니라 방해다.
   */
  /**
   * M9_SRS FR-M9-33 (M9-B15) — **CLI → GUI.** `FR-AGT-10` 의 남은 절반이다.
   *
   * 셸에서 도는 에이전트를 에이전트 도구로 올린다. 신원은 활동 훅이 실어 온 것이며
   * (FR-M9-32) 우리가 띄운 탭이든 사용자가 손으로 친 `claude` 든 같다.
   *
   * **터미널 탭은 남는다** (D-M9-20, 사용자 결정). `agentOpenTerminal` 과 대칭이
   * 아니며 그것이 의도다 — 에이전트 탭은 그 세션의 표면 하나뿐이지만 터미널 탭에는
   * **사용자의 셸**이 살고, 닫으면 히스토리·cwd·돌던 다른 일이 함께 사라진다.
   *
   * 셸 쪽 에이전트는 끝낸다. 예의가 아니라 **전제**다 — 같은 세션을 두 프로세스가
   * `--resume` 으로 동시에 열면 충돌한다. 그 지시(`exitCommand`)는 어댑터의 것이며
   * 서버가 실어 준다; 모르면 보내지 않는다 (추측해 `/exit` 를 적지 않는다).
   */
  async agentLiftFromTerminal(toolId){
    const r=await apiGet('/api/agent/session',{query:{tool:toolId}});
    if(!r.ok||!r.data||!r.data.liftable){ Toast.show(apiErrText(r,t('term.lift_to_agent')),'err'); return }
    const info=r.data;
    const loc=this.findToolLocation(toolId);
    const paneId=(loc&&loc.pane&&loc.pane.id)||this.focused;
    const c=await apiGet('/api/cwd',{query:{tool:toolId}});
    const cwd=(c.ok&&c.data&&c.data.cwd)||undefined;
    // 먼저 끝내고 연다. 순서가 바뀌면 두 프로세스가 같은 세션을 겹쳐 잡는다.
    //
    // M11_SRS FR-M11-5 (M11-B2): **끝난 것을 보고 연다.**
    //
    //   이전 동작: 종료 명령을 넣고 **답을 기다리지 않은 채** GUI 를 열었다.
    //             에이전트가 턴 중이면 그 한 줄은 입력창에 얹힐 뿐이고, 그래서
    //             접수한 말대로 *"gui 탭도 켜지고 에이전트도 살아서 돌아가고있다"*
    //   새  동작: 턴 중이면 먼저 끊고, 종료 명령을 넣고, **사라지기를 기다린다.**
    //             시한 안에 사라지지 않으면 **GUI 를 열지 않는다**
    //   이유:     둘을 다 여는 것보다 하나도 안 여는 쪽이 낫다 — 같은 세션을 두
    //             프로세스가 `--resume` 으로 잡으면 충돌한다 (D-M9-20 과 같은 근거)
    if(info.exitCommand&&!await this._endShellAgent(toolId,info.exitCommand)){
      Toast.show(t('agent.lift_still_running'),'err');
      return;
    }
    await this.addTab(paneId,'agent',{agent:info.agent,resume:info.sessionId,cwd,
      windowId:loc&&loc.win?loc.win.id:undefined});
  },

  /**
   * FR-M11-5: 셸 쪽 에이전트를 끝내고 **사라진 것을 확인한다.**
   *
   * 판정의 원천은 활동 등록부다 — `SessionEnd` 훅이 `ended` 를 보내면
   * `_onToolActivity` 가 그 항목을 지운다. 화면 출력으로 짐작하지 않는 것은
   * `refreshLift` 와 같은 근거다 (fingerprint 금지, FR-SKL-2).
   *
   * 애초에 활동이 없으면 기다릴 것도 없다 — 그때는 종료 명령만 넣고 지나간다.
   */
  async _endShellAgent(toolId,exitCommand){
    const act=this._activity&&this._activity.get(toolId);
    // 턴 중이면 종료 명령이 입력창에 얹힌다. 먼저 끊는다 (ESC — TUI 의 인터럽트).
    if(act&&act.state==='working'){
      await apiPost('/api/tools/input',{id:toolId,text:'\u001b'});
      await new Promise(done=>TIMERS.after(AGENT_LIFT_INTERRUPT_MS,done,{label:'agent-lift-interrupt'}));
    }
    await apiPost('/api/tools/input',{id:toolId,text:exitCommand,execute:true});
    if(!this._activity||!this._activity.has(toolId)) return true;
    const until=Date.now()+AGENT_LIFT_EXIT_MS;
    while(Date.now()<until){
      await new Promise(done=>TIMERS.after(AGENT_LIFT_POLL_MS,done,{label:'agent-lift-wait'}));
      if(!this._activity.has(toolId)) return true;
    }
    return false;
  },

  async agentOpenTerminal(toolId){
    const r=await apiGet('/api/agent/tui-line',{query:{tool:toolId}});
    if(!r.ok||!r.data||!r.data.line){ Toast.show(apiErrText(r,t('agent.open_terminal')),'err'); return }
    const loc=this.findToolLocation(toolId);
    const paneId=(loc&&loc.pane&&loc.pane.id)||this.focused;
    const c=await apiGet('/api/cwd',{query:{tool:toolId}});
    const cwd=(c.ok&&c.data&&c.data.cwd)||undefined;
    const made=await this.addTab(paneId,'terminal',{windowId:loc&&loc.win?loc.win.id:undefined,cwd});
    if(!made||!made.toolId) return;
    await apiPost('/api/tools/input',{id:made.toolId,text:r.data.line,execute:true});
    // 옛 탭을 못 찾았으면 여기서 끝난다 — 그때는 더할 것이 없고, 새 탭은 이미 섰다.
    if(!loc||!loc.tab) return;
    // 자리부터 옮기고 닫는다. 순서가 바뀌면 옛 탭이 사라진 뒤라 기준이 없다.
    this.moveTabToPane(paneId,made.uuid,paneId,loc.tab.id,true);
    await this.closeTab(paneId,loc.tab.id,loc.win&&loc.win.id,{force:true});
  },
});
