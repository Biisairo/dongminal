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
   */
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
  },
});
