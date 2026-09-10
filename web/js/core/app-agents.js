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
    this._restoreNote('activity',toolId);   // FR-RSF-4
    if(state==='ended'){ // 종료 → 카드 제거
      if(this._activity.delete(toolId)) this._agentsRender();
      return;
    }
    // FR-AAP-13/21: 기존 항목은 제자리 갱신(순서 불변), 신규는 Map 끝(=최하단)에 추가
    this._activity.set(toolId,{state,tool:tool||'',detail:detail||''});
    this._agentsRender();
  },

  // FR-AAP-15: 합류/재연결 시 현재 활동 스냅샷 복원
  //
  // FR-RSF-8: 응답 도착 시점의 `clear()` 후 재구성이 아니라 차분이다. 이 함수는
  // `agentsPollMs`(기본 5초)마다 불리므로 비행 창이 상시 열려 있고, 통째로 비우면
  // 그 사이 도착한 활동이 태어나자마자 사라진다 (RESTORE_FLIGHT_SRS §2.1).
  _activityRestore(){
    const t=this._restoreBegin('activity');
    fetch('/api/tools/activity').then(r=>r.ok?r.json():null).then(j=>{
      if(!this._restoreLive('activity',t)) return;
      const list=(j&&Array.isArray(j.activities))?j.activities.slice():[];
      list.sort((a,b)=>(a.updatedAt||0)-(b.updatedAt||0)); // 오래된→최신: 끝이 가장 최근
      const seen=new Set();
      for(const a of list){
        if(!a||!a.toolId) continue;
        seen.add(a.toolId);
        if(t.has(a.toolId)) continue;
        this._activity.set(a.toolId,{state:a.state,tool:a.tool||'',detail:a.detail||''});
      }
      for(const id of Array.from(this._activity.keys())){
        if(!seen.has(id)&&!t.has(id)) this._activity.delete(id);
      }
      this._restoreEnd('activity',t);
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
    if(ac&&ac.classList.contains('open')) TIMERS.frame(()=>this._positionAttnCenter(),{owner:'app',label:'attn-center'});
  },

  // FR-AAP-19: 패널 열림 동안 주기적으로 서버 스냅샷과 동기화(자동 새로고침)
  _agentsStartPoll(){
    this._agentsStopPoll();
    // FR-RST-23: 종전에는 숨김 판정조차 없어 보이지 않는 탭에서도 계속 받았다.
    // 주기는 `state-registry` 의 `tool.activity` 선언이 갖는다 (FR-HUB-3).
    // 여기서 다시 걸면 같은 상태를 두 타이머가 묻는다.
    this._agentsTimer=null;
  },
  _agentsStopPoll(){
    if(this._agentsTimer){this._agentsTimer.stop();this._agentsTimer=null}
  },

  /**
   * POLL_INTERVAL_SETTINGS_SRS FR-PIS-22: **`_initAgentsSettings` 가 사라졌다.**
   *
   * 이 배선이 만지던 것은 Notifications 탭의 `에이전트 패널 새로고침 주기`
   * 드롭다운 하나였고, 그 손잡이는 `Polling` 탭으로 옮겼다 (D-2). 주기의 배선은
   * 이제 `POLL_SETTINGS` 의 한 행이며, 재시작도 재무장 한 줄이 한다 —
   * `_agentsTimer` 는 이미 `null` 이었다 (주기는 `state-registry` 의 것이다).
   */

  // FR-AAP-21: 활동 카드 드래그 재배치. drop(즉시) 1순위 + dragend 폴백, done 으로 중복 차단.
  _reorderAgents(dr){
    if(!dr||dr.done||!dr.pid||!dr.targetPid||dr.pid===dr.targetPid) return;
    // FR-AGG-7·8: 재배치는 **그룹 안**의 일이다. 다른 창의 카드 위에 놓는 것은
    // 아무 일도 아니다 — 창 사이의 이동은 탭을 옮기는 일이고, 그 손잡이는
    // 사이드바에 이미 있다 (`tabDrop`). done 을 세워 dragend 폴백도 막는다.
    const sl=this._findToolLocation(dr.pid),tl=this._findToolLocation(dr.targetPid);
    if(!sl||!tl||sl.win.id!==tl.win.id){dr.done=true;return}
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
    // FR-AGG-5·9: 카드의 소속은 `_findToolLocation` 이 준다 — 어디에도 저장하지
    // 않는다 (D-9). 순서는 `ws.agentsOrder` 그대로이고, 그룹 안 순서는 그 평면
    // 배열을 창으로 거른 것이다 (D-10).
    const byWin=new Map();
    for(const toolId of this._agentOrderSync()){ // ws.agentsOrder 순서(신규=최하단)
      const loc=this._findToolLocation(toolId);
      if(!loc) continue;
      let g=byWin.get(loc.win.id);
      if(!g) byWin.set(loc.win.id,g=[]);
      g.push({t:'card',toolId,info:this._activity.get(toolId),loc});
    }
    const items=[{t:'head'}],fold=this._agFolded();
    let cards=0;
    // FR-AGG-2·3: 그룹 순서는 `ws.windows` 의 순서다. 패널이 따로 갖는 순서가
    // 없으므로 창 순서가 바뀌면 그 자리에서 따라간다.
    for(const win of this.ws.windows||[]){
      const g=byWin.get(win.id);
      if(!g||!g.length) continue; // FR-AGG-4: 빈 머리는 정보가 아니다
      cards+=g.length;
      const folded=fold.has(win.id);
      // FR-AGG-11: 알람 수는 접혀 있어도 보인다 — 접었다고 알람이 사라지면 안 된다.
      items.push({t:'group',win,attn:g.reduce((n,c)=>n+(this._attnHas(c.toolId)?1:0),0),folded});
      if(!folded) for(const c of g) items.push(c);
    }
    if(!cards) items.push({t:'empty'});
    reconcileList(panel,items,{
      key:it=>it.t==='card'?'card:'+it.toolId:it.t==='group'?'grp:'+it.win.id:it.t,
      sig:it=>{
        // FR-AGG-14: 머리도 항목이다 — 값이 바뀌는 항목이므로 근거를 준다.
        if(it.t==='group') return [it.win.name||'',it.attn,it.folded?1:0].join('\u0001');
        if(it.t!=='card') return '1';
        const i=it.info||{};
        // `_agCardEl` 이 읽는 값 전부다 (FR-RPT-2).
        // FR-NAM-6: 표시 이름이 근거에 들어간다 — 파생 이름이 바뀌면 카드도 바뀐다.
        // FR-AGG-13: 창 이름은 더 이상 카드가 읽지 않으므로 근거에서도 빠진다 —
        // 창을 옮긴 카드는 **자리**가 바뀌고, 그것은 items 순서가 말한다.
        return [this._toolName(it.toolId,it.loc.tab.name),i.state||'',i.tool||'',i.detail||'',
                this._attnHas(it.toolId)?1:0,this._isToolFocusedActive(it.toolId)?1:0]
          .join('\u0001');
      },
      build:it=>it.t==='head'?this._agHeadEl()
        :it.t==='group'?this._agGroupEl(it.win,it.attn,it.folded)
        :it.t==='empty'?this._agEmptyEl()
        :this._agCardEl(panel,it.toolId,it.info,it.loc),
    });
  },

  // FR-AGG-10: 그룹 접힘은 창 id 별로 **클라이언트**에 남는다 — 보는 방식은
  // 워크스페이스의 것이 아니다 (FR-SBT-6 과 같은 근거).
  _agFolded(){
    if(!this._agFold){
      let ids=null;
      try{ids=JSON.parse(localStorage.getItem('agentsGroupFold')||'[]')}catch{}
      this._agFold=new Set(Array.isArray(ids)?ids:[]);
    }
    return this._agFold;
  },

  _agFoldToggle(winId){
    const f=this._agFolded();
    if(f.has(winId)) f.delete(winId); else f.add(winId);
    try{localStorage.setItem('agentsGroupFold',JSON.stringify(Array.from(f)))}catch{}
    this._agentsRender();
  },

  // FR-AGG-1·10·11·12: 그룹 머리. 창 이름을 말하고, 접히고, 알람 수를 보이고,
  // 누르면 그 창으로 간다.
  _agGroupEl(win,attn,folded){
    const g=document.createElement('div');
    g.className='ag-group'+(folded?' folded':'')+(attn?' attn':'');
    g.dataset.sid=win.id;
    g.appendChild(UIKit.button({
      icon:folded?'chevron-right':'chevron-down',
      title:folded?'펼치기':'접기',
      kind:'ghost',size:'sm',cls:'ag-group-fold',
      onClick:e=>{e.stopPropagation();this._agFoldToggle(win.id)},
    }));
    const name=document.createElement('div');
    name.className='ag-group-name';
    name.textContent=name.title=win.name||win.id;
    g.appendChild(name);
    if(attn){
      const b=document.createElement('span');
      b.className='ag-group-attn ui-badge ui-badge-attn';
      b.textContent=String(attn);
      b.title=attn+'개의 알람';
      g.appendChild(b);
    }
    g.addEventListener('click',()=>this.switchWindow(win.id));
    return g;
  },

  _agHeadEl(){
    const head=document.createElement('div');
    head.className='ag-head';
    // UI_KIT_SRS FR-GLY-4·6 / FR-TIP-2: 문자에서 스프라이트로. 문구도 영어가
    // 된다 — 아이콘만 있는 버튼은 툴팁이 이름의 유일한 자리다.
    // 골격은 마크업으로, **값이 들어가는 자리는 DOM 으로** 세운다.
    // `iconHTML` 이 돌려주는 것은 스프라이트 마크업이라 이스케이프 대상이
    // 아니지만, 문자열 조립 안에 두면 "여기 들어오는 것은 마크업이다" 라는
    // 예외가 생긴다 — 예외가 있으면 다음 사람이 판단해야 하고, 그 판단이
    // 틀리는 날이 온다 (`scripts/check-html.sh`).
    head.innerHTML='<span class="ag-title">Agents</span>';
    const mkBtn=(cls,tip,icon)=>{
      const b=document.createElement('button');
      b.className='ui-btn ui-btn-icon ui-btn-ghost '+cls;
      b.title=tip; b.setAttribute('aria-label',tip);
      b.innerHTML=UIKit.iconHTML(icon);
      head.appendChild(b);
    };
    mkBtn('ag-refresh','Refresh the activity list','refresh-cw');
    mkBtn('ag-close','Close the panel','x');
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
    // FR-AGG-13: 창 이름은 머리가 말한다. 카드에는 도구 이름만 남는다.
    const locDiv=document.createElement('div');locDiv.className='ag-loc';
    locDiv.textContent=this._toolName(toolId,loc.tab.name||toolId);
    const st=document.createElement('div');st.className='ag-state';
    if(info.state) st.classList.add(info.state); // 상태별 색(.ag-state.working 등)
    st.textContent=(AGENT_STATE_ICON[info.state]||'●')+' '+info.state+(info.tool?' · '+info.tool:'');
    const dt=document.createElement('div');dt.className='ag-detail';
    if(info.detail){dt.textContent=info.detail;card.appendChild(dt);}
    card.appendChild(locDiv);
    card.appendChild(st);
    card.addEventListener('click',()=>this._jumpToTool(toolId)); // FR-ATA-6: 해제는 _jumpToTool 이 한다
    // FR-AAP-21: 창 사이드바와 동일한 native DnD. drop(즉시) 1순위, dragend 폴백.
    card.draggable=true;
    card.addEventListener('dragstart',e=>{this._drag={type:'agent',pid:toolId,targetPid:null,before:false,done:false};e.dataTransfer.effectAllowed='move';TIMERS.defer(()=>card.classList.add('dragging'),{label:'drag-class'})});
    card.addEventListener('dragover',e=>{const dr=this._drag;if(!dr||dr.type!=='agent')return;e.preventDefault();panel.querySelectorAll('.ag-card').forEach(c=>c.classList.remove('drag-above','drag-below'));const rect=card.getBoundingClientRect();const before=e.clientY<rect.top+rect.height/2;card.classList.add(before?'drag-above':'drag-below');dr.targetPid=toolId;dr.before=before});
    card.addEventListener('drop',e=>{const dr=this._drag;if(!dr||dr.type!=='agent')return;e.preventDefault();e.stopPropagation();this._reorderAgents(dr)});
    // dragend 는 시각 정리만 — 패널 밖 release 는 취소(순서 불변, snap-back 깜빡임 방지).
    card.addEventListener('dragend',()=>{this._drag=null;card.classList.remove('dragging');panel.querySelectorAll('.ag-card').forEach(c=>c.classList.remove('drag-above','drag-below'))});
    return card;
  },
});
