/**
 * Remote Terminal — App 활동 패널 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 9개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
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
  },

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
  },

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
  },

  // FR-AAP-19: 패널 열림 동안 주기적으로 서버 스냅샷과 동기화(자동 새로고침)
  _agentsStartPoll(){
    this._agentsStopPoll();
    this._agentsTimer=setInterval(()=>this._activityRestore(),this.agentsPollMs);
  },
  _agentsStopPoll(){
    if(this._agentsTimer){clearInterval(this._agentsTimer);this._agentsTimer=null}
  },

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
  },

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
  },

  _agentOrderSync(){
    if(!Array.isArray(this.ws.agentsOrder)) this.ws.agentsOrder=[];
    const present=new Set(this._activity.keys());
    const order=this.ws.agentsOrder.filter(pid=>present.has(pid));
    const seen=new Set(order);
    for(const pid of this._activity.keys()) if(!seen.has(pid)) order.push(pid);
    this.ws.agentsOrder=order;
    return order;
  },

  // FR-AAP-13/14/16/18/21: 활동 중인 pane 카드 렌더. _findToolLocation 실패(종료/없음)
  // pane 은 제외, attention 있으면 .attn 합성, 클릭 시 점프+알람 해제. 카드 순서는
  // ws.agentsOrder(드래그로 조절·영속) 를 따른다.
  /**
   * FR-RPT-3: 패널을 비우고 다시 만들지 않는다.
   *
   * `_agentsStartPoll` 이 `agentsPollMs` 마다 부르고 SSE `tool_activity` 도 부른다 —
   * 둘 다 바깥 계기다. 카드를 새로 만들면 **끌고 있던 카드가 DOM 에서 빠져 재배치가
   * 조용히 실패한다** (FR-AAP-21).
   *
   * 머리글도 항목으로 다룬다 — 값이 없으므로 한 번 만들면 그대로 남는다.
   */
  _agentsRender(){
    const panel=document.getElementById('agents-panel');
    if(!panel||!panel.classList.contains('open')) return;
    const items=[{t:'head'}];
    for(const toolId of this._agentOrderSync()){ // ws.agentsOrder 순서(신규=최하단)
      const loc=this._findToolLocation(toolId);
      if(!loc) continue;
      items.push({t:'card',toolId,info:this._activity.get(toolId),loc});
    }
    if(items.length===1) items.push({t:'empty'});
    reconcileList(panel,items,{
      key:it=>it.t==='card'?'card:'+it.toolId:it.t,
      sig:it=>{
        if(it.t!=='card') return '1';
        const i=it.info||{};
        // `_agCardEl` 이 읽는 값 전부다 (FR-RPT-2).
        // FR-NAM-6: 표시 이름이 근거에 들어간다 — 파생 이름이 바뀌면 카드도 바뀐다.
        return [it.loc.win.name||'',this._toolName(it.toolId,it.loc.tab.name),i.state||'',i.tool||'',i.detail||'',
                this._attnHas(it.toolId)?1:0,this._isToolFocusedActive(it.toolId)?1:0]
          .join('\u0001');
      },
      build:it=>it.t==='head'?this._agHeadEl()
        :it.t==='empty'?this._agEmptyEl()
        :this._agCardEl(panel,it.toolId,it.info,it.loc),
    });
  },

  _agHeadEl(){
    const head=document.createElement('div');
    head.className='ag-head';
    head.innerHTML=`<span class="ag-title">Agents</span><button class="ag-refresh" title="새로고침">↻</button><button class="ag-close" title="닫기">✕</button>`;
    head.querySelector('.ag-refresh').addEventListener('click',e=>{e.stopPropagation();this._activityRestore()});
    head.querySelector('.ag-close').addEventListener('click',e=>{e.stopPropagation();this._agentsToggle()});
    return head;
  },

  _agEmptyEl(){
    const empty=document.createElement('div');
    empty.className='ag-empty';
    empty.textContent='활동 중인 에이전트 없음';
    return empty;
  },

  _agCardEl(panel,toolId,info,loc){
    info=info||{};
    const card=document.createElement('div');
    card.className='ag-card'+(this._attnHas(toolId)?' attn':'')+(this._isToolFocusedActive(toolId)?' focused':'');
    card.dataset.toolid=toolId;
    // FR-NAM-1·6: 도구 이름은 한 자리에서 온다 — 에이전트 패널이 화면의 탭과
    // 다른 이름을 부르면 어느 도구인지 짚을 수 없다.
    const locDiv=document.createElement('div');locDiv.className='ag-loc';
    locDiv.textContent=(loc.win.name||'')+' · '+this._toolName(toolId,loc.tab.name||toolId);
    const st=document.createElement('div');st.className='ag-state';
    if(info.state) st.classList.add(info.state); // 상태별 색(.ag-state.working 등)
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
    return card;
  },
});
