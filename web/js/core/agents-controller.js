/**
 * Remote Terminal — App 활동 패널 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * `AgentsController` 가 활동(에이전트) 상태의 받기·복원·카드 그리기·순서를 진다. App 은 이것을 `agents` 로 든다
 * (REFACTOR3_FE_APPCTL_SRS 9c). 부품 둘 — 서브에이전트 `AgentsSub`(`agents-sub.js`) `.sub` · 활동 패널의 구역
 * `ActivityList`(`activity-list.js`, 옛 `app-activity.js`) `.list`. 활동 표 `_activity`·한도 `_limits` 는 App 에 남는다 —
 * 작업 표식·알림·계약·시험이 읽는다.
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */

/**
 * ACTIVITY_CARD_USAGE_SRS FR-ACU-10~14: 카드의 사용량 줄이 그릴 값. 그릴 것이 없으면
 * null 이다. 등급은 서버가 정해 보낸다 — 여기에는 경계값이 없다 (D-ACU-2).
 */
function agentUsageView(u){
  if(!u) return null;
  const hasPct=typeof u.ctxPct==='number';
  const label=[u.model,u.effort].filter(Boolean).join('·');
  if(!hasPct&&!label) return null;
  const pct=hasPct?Math.round(u.ctxPct):null;
  const title=[hasPct?'Context '+pct+'%':'',u.model||'',u.effort?'effort '+u.effort:'']
    .filter(Boolean).join(' · ');
  return {pct,fill:hasPct?Math.min(100,Math.max(0,u.ctxPct)):null,level:u.ctxLevel||'',label,title};
}

/** FR-ACU-15: 사용량 줄의 재조정 근거. 그려지는 값만 담는다. */
function agentUsageSig(u){
  const v=agentUsageView(u);
  return v?[v.pct,v.level,v.label].join('\u0002'):'';
}

class AgentsController extends Controller {
  constructor(app){
    super(app);
    this.sub=new AgentsSub(app);
    this.list=new ActivityList(app);
  }

  // FR-AAP-15: SSE tool_activity 수신 → 최신 상태로 덮어쓰고 카드 타깃 갱신
  _onToolActivity({toolId,state,tool,detail}={}){
    if(!toolId||!state) return;
    this.app._restoreNote('activity',toolId);   // FR-RSF-4
    if(state===ACTIVITY_STATE.ENDED){ // 종료 → 카드 제거
      if(this.app._activity.delete(toolId)) this.agentsRender();
      return;
    }
    // FR-AAP-13/21: 기존 항목은 제자리 갱신(순서 불변), 신규는 Map 끝(=최하단)에 추가
    // FR-ACU-16: SSE 는 사용량을 싣지 않는다 — 있던 것을 지우면 막대가 깜빡인다.
    // SUBAGENT_USAGE_SRS FR-SAU-25: 서브에이전트 목록도 같다.
    const prev=this.app._activity.get(toolId);
    this.app._activity.set(toolId,{state,tool:tool||'',detail:detail||'',usage:prev&&prev.usage,subagents:prev&&prev.subagents});
    this.agentsRender();
  }

  // FR-AAP-15: 합류/재연결 시 현재 활동 스냅샷 복원
  //
  // FR-RSF-8: 응답 도착 시점의 `clear()` 후 재구성이 아니라 차분이다. 이 함수는
  // `agentsPollMs`(기본 5초)마다 불리므로 비행 창이 상시 열려 있고, 통째로 비우면
  // 그 사이 도착한 활동이 태어나자마자 사라진다 (RESTORE_FLIGHT_SRS §2.1).
  _activityRestore(src){
    const flight=this.app._restoreBegin('activity');
    return stateFetch(src,'/api/tools/activity').then(res=>{
      // UX_AUDIT_FIX_SRS FR-UXF-28: 실패한 응답은 "활동이 없다" 가 아니다 — 목록을 그대로 두고 실패만 센다.
      //   이전: `res.ok` 가 아니면 빈 목록으로 읽어 카드를 모두 지웠다
      if(!res.ok||!res.data){this.app._restoreEnd('activity',flight);this._actStaleCount(false);return}
      const j=res.data;
      if(!this.app._restoreLive('activity',flight)) return;
      const list=(j&&Array.isArray(j.activities))?j.activities.slice():[];
      if(j) this.app._limits=Array.isArray(j.limits)?j.limits:[]; // ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-40
      list.sort((a,b)=>(a.updatedAt||0)-(b.updatedAt||0)); // 오래된→최신: 끝이 가장 최근
      const seen=new Set();
      for(const a of list){
        if(!a||!a.toolId) continue;
        seen.add(a.toolId);
        if(flight.has(a.toolId)) continue;
        this.app._activity.set(a.toolId,{state:a.state,tool:a.tool||'',detail:a.detail||'',usage:a.usage,subagents:a.subagents}); // FR-ACU-17 · FR-SAU-25
      }
      for(const id of Array.from(this.app._activity.keys())){
        if(!seen.has(id)&&!flight.has(id)) this.app._activity.delete(id);
      }
      this.app._restoreEnd('activity',flight);
      this._actStaleCount(true);
      this.agentsRender();
    }).catch(()=>{this.app._restoreEnd('activity',flight);this._actStaleCount(false)});
  }

  /**
   * FR-UXF-28: 스냅샷 실패가 `ACT_STALE_AFTER` 번 이어지면 머리 아래에 안내와 앱 새로고침 단추를 세운다.
   * 성공하면 걷는다. 수동 목록 새로고침은 없다 (FR-UXF-27) — 실패는 보여야 한다.
   */
  _actStaleCount(ok){
    this._actFails=ok?0:(this._actFails||0)+1;
    if(typeof document.getElementById!=='function') return;   // 단위 시험 하네스에는 DOM 이 없다
    const panel=document.getElementById('agents-panel'),body=document.getElementById('agents-body');
    if(!panel||!body) return;
    let note=panel.querySelector(':scope>.ag-stale');
    if(this._actFails<ACT_STALE_AFTER){ if(note) note.remove(); return }
    if(note) return;
    note=document.createElement('div');
    note.className='ui-notice ui-notice-attn ag-stale';
    note.append(document.createTextNode(t('activity.stale')),
      UIKit.button({label:t('core.reload_app'),kind:'ghost',size:'sm',cls:'ag-stale-reload',onClick:()=>this.app.softReload()}));
    panel.insertBefore(note,body);
  }

  // FR-AAP-11/12: 우측 활동 패널 토글(열림 상태 영속)
  agentsToggle(){ this.app.agents.list.actPanel().toggle() }

  /**
   * UX_BATCH12_SRS FR-ACF-1·8: `.open` 은 **펼침**이다. 데스크톱에서 `.open` 이 없으면 레일이고
   * (CSS 가 폭을 덮는다), 모바일에서는 숨는다. 저장 값(`agentsPanelOpen`)의 뜻도 같다. 하는 일은 `ActivityPanel` 이 맡는다.
   */
  setAgentsPanelOpen(open){ this.app.agents.list.actPanel().setOpen(open) }

  agentsPanelOpen(){ return this.app.agents.list.actPanel().isOpen() }

  /**
   * FR-AAP-19 (회복 — OPTIMIZE_REFACTOR_SRS FR-OPT-4-6): 활동 스냅샷의 주기는 **패널이
   * 보이거나 알림이 있을 때만** 돈다. 주기는 `state-registry` 의 `tool.activity` 가
   * 갖고 이것은 그 `when` 이다. 알림이 있으면 주의 센터가 활동의 detail 을 읽는다
   * (`_attnDetail`). 증분은 닫혀 있어도 SSE `tool_activity` 로 온다.
   *
   * UX_BATCH12_SRS FR-ACF-9: 데스크톱의 레일도 목록을 보이므로 "보인다" 에 든다.
   */
  _agentsPanelShown(){
    return !this.app.isMobile||this.agentsPanelOpen();
  }

  /**
   * POLL_INTERVAL_SETTINGS_SRS FR-PIS-22: **`_initAgentsSettings` 가 사라졌다.**
   *
   * 이 배선이 만지던 것은 Notifications 탭의 `에이전트 패널 새로고침 주기`
   * 드롭다운 하나였고, 그 손잡이는 `Polling` 탭으로 옮겼다 (D-2). 주기의 배선은
   * 이제 `POLL_SETTINGS` 의 한 행이며, 재시작도 재무장 한 줄이 한다 (주기는
   * `state-registry` 의 것이다).
   */

  // FR-AAP-21: 활동 카드 드래그 재배치. drop(즉시) 1순위 + dragend 폴백, done 으로 중복 차단.
  reorderAgents(dr){
    if(!dr||dr.done||!dr.pid||!dr.targetPid||dr.pid===dr.targetPid) return;
    // FR-AGG-7·8: 재배치는 **그룹 안**의 일이다. 다른 창의 카드 위에 놓는 것은
    // 아무 일도 아니다 — 창 사이의 이동은 탭을 옮기는 일이고, 그 손잡이는
    // 사이드바에 이미 있다 (`tabDrop`). done 을 세워 dragend 폴백도 막는다.
    const sl=this.app.findToolLocation(dr.pid),tl=this.app.findToolLocation(dr.targetPid);
    if(!sl||!tl||sl.win.id!==tl.win.id){dr.done=true;return}
    dr.done=true;
    const ord=this.app.ws.agentsOrder;
    if(!Array.isArray(ord)) return;
    const si=ord.indexOf(dr.pid);
    if(si<0) return;
    ord.splice(si,1);
    let ti=ord.indexOf(dr.targetPid);
    if(ti<0){ord.push(dr.pid)}else{if(!dr.before)ti++;ord.splice(ti,0,dr.pid)}
    this.app.save();this.agentsRender();
  }

  // FR-EM-16: 부팅 시 workspace 트리에 없는 도구 id 를 agentsOrder 에서 제거한다.
  // 저장된 순서를 지우는 자리는 여기 하나다(FR-UXF-112). 기준은 활동 보고가 아니라
  // 레이아웃 참조다 — 부팅 직후에는 보고가 0건이다.
  _pruneAgentOrder(){
    if(!Array.isArray(this.app.ws.agentsOrder)||!this.app.ws.agentsOrder.length) return;
    const present=new Set();
    for(const w of this.app.ws.windows||[]){
      for(const pn of panesOf(w.layout)) for(const tab of (pn.tabs||[])) if(tab.toolId) present.add(tab.toolId);
    }
    const kept=this.app.ws.agentsOrder.filter(id=>present.has(id));
    if(kept.length!==this.app.ws.agentsOrder.length) this.app.ws.agentsOrder=kept;
  }

  // FR-AAP-21 → UX_AUDIT_FIX_SRS FR-UXF-111·112 (D-37): 그릴 순서 = 저장된 순서(ws.agentsOrder)를 지금 활동 집합으로 거른 것.
  //   이전: 보고 없는 id 를 저장된 순서에서 **지웠고** 새 id 는 도착 순서로 붙였다 — 새로 고침 직후 끌어 놓은 순서가 사라졌다
  //   지금: 저장된 순서는 지우지 않는다(정리는 `_pruneAgentOrder` 만). 새 id 는 생성 순서(UUID v7 의 사전순)로 끝에 붙는다
  // save() 를 유발하지 않는다(드래그 시에만 저장).
  _agentOrderSync(){
    if(!Array.isArray(this.app.ws.agentsOrder)) this.app.ws.agentsOrder=[];
    const ord=this.app.ws.agentsOrder, seen=new Set(ord);
    const fresh=[...this.app._activity.keys()].filter(pid=>!seen.has(pid)).sort();
    ord.push(...fresh);
    return ord.filter(pid=>this.app._activity.has(pid));
  }

  // FR-AAP-13/14/16/18/21: 활동 중인 pane 카드 렌더. findToolLocation 실패(종료/없음)
  // pane 은 제외, attention 있으면 .attn 합성, 클릭 시 점프+알람 해제. 카드 순서는
  // ws.agentsOrder(드래그로 조절·영속) 를 따른다.
  /**
   * FR-RPT-3: 패널을 비우고 다시 만들지 않는다.
   *
   * 활동 주기(`agentsPollMs`)가 부르고 SSE `tool_activity` 도 부른다 —
   * 둘 다 바깥 계기다. 카드를 새로 만들면 **끌고 있던 카드가 DOM 에서 빠져 재배치가
   * 조용히 실패한다** (FR-AAP-21).
   *
   * 머리글도 항목으로 다룬다 — 값이 없으므로 한 번 만들면 그대로 남는다.
   */
  agentsRender(){
    if(this.app.mobile.nav.mobileActSync) this.app.mobile.nav.mobileActSync();   // MOBILE_UX_OVERHAUL_SRS FR-MUX-75 — 닫힌 패널은 아래에서 물러선다
    if(this.app._workSync) this.app._workSync();   // UX_AUDIT_FIX_SRS FR-UXF-64 — 탭·창 행의 작업 중 표식도 닫힌 패널과 무관하다
    const panel=document.getElementById('agents-panel');
    const body=document.getElementById('agents-body'),footHost=document.getElementById('agents-foot');
    const headHost=document.getElementById('agents-head');
    if(!panel||!body||!footHost||!headHost||!this._agentsPanelShown()) return;
    // PEER_CHAT_SRS FR-PCH-80: 탭 줄과 고른 탭의 항목. 무엇을 그릴지는
    // 각 표면의 주인이 알고, 여기가 아는 것은 머리 하나뿐이다 (`activity-list.js` 의 `ACTIVITY_SECTIONS`).
    const items=[{t:'head'}].concat(this.list._actItems());
    const opts={
      key:it=>it.t==='card'?'card:'+it.toolId
        :it.t==='sub'?'sub:'+it.toolId+':'+it.s.id
        :it.t==='group'?'grp:'+it.win.id
        :it.t==='secempty'?'secempty:'+it.sec.key
        :it.t==='row'?it.sec+':'+it.id
        :it.t,
      sig:it=>{
        // FR-AGG-14: 머리도 항목이다 — 값이 바뀌는 항목이므로 근거를 준다.
        if(it.t==='group') return [it.win.name||'',it.attn,it.folded?1:0].join('\u0001');
        if(it.t==='tabs') return 'tabs'; // UX_AUDIT_FIX_SRS FR-UXF-123: 줄은 한 번 만들고 `_actTabsPaint` 가 고친다
        // 구역의 행은 **그려질 마크업 전부**가 근거다 (FR-RPT-2) — 그 행이 무엇을
        // 보이는지 이 파일은 모르고, 알 필요도 없다.
        if(it.t==='row') return it.el.outerHTML;
        if(it.t==='foot') return JSON.stringify(it.view); // ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-40
        if(it.t==='head') return (this.agentsPanelOpen()?'open':'rail')+':'+this._agCollapseIcon(); // FR-ACF-5 · UX_BATCH13_SRS FR-ACB-5
        if(it.t!=='card') return '1';
        const i=it.info||{};
        // `_agCardEl` 이 읽는 값 전부다 (FR-RPT-2).
        // FR-NAM-6: 표시 이름이 근거에 들어간다 — 파생 이름이 바뀌면 카드도 바뀐다.
        // FR-AGG-13: 창 이름은 더 이상 카드가 읽지 않으므로 근거에서도 빠진다 —
        // 창을 옮긴 카드는 **자리**가 바뀌고, 그것은 items 순서가 말한다.
        return [this.app._toolName(it.toolId,it.loc.tab.name),i.state||'',i.tool||'',i.detail||'',
                this.app.attn.attnHas(it.toolId)?1:0,it.toolId===this.app.attn._agFocusedTool()?1:0,
                agentUsageSig(i.usage),agentSubagentsSig(i.subagents)] // FR-ACU-15 · FR-SAU-24 · FR-ASV-37
          .join('\u0001');
      },
      build:it=>it.t==='head'?this._agHeadEl()
        :it.t==='group'?this._agGroupEl(it.win,it.attn,it.folded)
        :it.t==='tabs'?this.list._actTabsEl()
        :it.t==='secempty'?this.list._actSecEmptyEl(it.sec)
        :it.t==='row'?it.el
        :it.t==='foot'?this.list._actUsageFootEl(it.view)
        :this._agCardEl(panel,it.toolId,it.info,it.loc),
    };
    // PANEL_TEMPLATE_SRS FR-PNT-1·2: 머리(탭 줄 → 끝 단추)는 몸통 스크롤 밖의 `#agents-head` 다.
    // ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-40 (D-ASV-12): Usage 바닥도 스크롤 몸통 밖에 그린다.
    // REFACTOR3_FE_REST2_SRS FR-FR2-6 (FC-15): 항목을 한 번 훑어 구역으로 가른다. 머리는 탭 줄 뒤에 끝 단추다.
    const zone={tabs:[],head:[],body:[],foot:[]};
    for(const it of items) zone[it.t==='tabs'||it.t==='head'||it.t==='foot'?it.t:'body'].push(it);
    reconcileList(headHost,zone.tabs.concat(zone.head),opts);
    const tabsIt=zone.tabs[0];
    // UX_AUDIT_FIX_SRS FR-UXF-98: 라벨 맞춤은 탭 줄이 그리면서 한다 (REFACTOR3_FE_BASE_SRS FR-FEB-26 — 사이드바와 같은 길).
    //   이전: 여기서 `#agents-head` 에 관측을 걸고 직접 쟀다 — 사이드바는 `#sb-tabs` 에 걸어, 두 패널의 재는 대상과 시점이 갈렸다
    if(tabsIt) this.list._actTabsPaint(headHost.querySelector('.ag-tabs'),tabsIt.cur,tabsIt.tabs);
    reconcileList(body,zone.body,opts);
    reconcileList(footHost,zone.foot,opts);
  }

  /**
   * FR-AGG-1~14: 에이전트 구역의 항목 — **창 그룹과 그 안의 카드**.
   *
   * 구역 넷 중 하나이지만 하위 그룹을 갖는 유일한 것이라 조립이 다르다
   * (`activity-list.js` 의 `ACTIVITY_SECTIONS` 가 이것을 그대로 받는다).
   */
  _agWindowItems(){
    // FR-AGG-5·9: 카드의 소속은 `findToolLocation` 이 준다 — 어디에도 저장하지
    // 않는다 (D-9). 순서는 `ws.agentsOrder` 그대로이고, 그룹 안 순서는 그 평면
    // 배열을 창으로 거른 것이다 (D-10).
    const byWin=new Map();
    for(const toolId of this._agentOrderSync()){ // ws.agentsOrder 순서(신규=최하단)
      const loc=this.app.findToolLocation(toolId);
      if(!loc) continue;
      let g=byWin.get(loc.win.id);
      if(!g) byWin.set(loc.win.id,g=[]);
      g.push({t:'card',toolId,info:this.app._activity.get(toolId),loc});
    }
    const out=[],fold=this._agFolded();
    // FR-AGG-2·3: 그룹 순서는 `ws.windows` 의 순서다. 패널이 따로 갖는 순서가
    // 없으므로 창 순서가 바뀌면 그 자리에서 따라간다.
    // UX_AUDIT_FIX_SRS FR-UXF-110 (D-37): 상태로 자리를 옮기지 않는다 — 승인 대기 끌어올리기(FR-UXF-12)는 철회됐다.
    for(const win of this.app.ws.windows||[]){
      const g=byWin.get(win.id);
      if(!g||!g.length) continue; // FR-AGG-4: 빈 머리는 정보가 아니다
      const folded=fold.has(win.id);
      // FR-AGG-11: 알람 수는 접혀 있어도 보인다 — 접었다고 알람이 사라지면 안 된다.
      out.push({t:'group',win,attn:g.reduce((n,c)=>n+(this.app.attn.attnHas(c.toolId)?1:0),0),folded});
      if(folded) continue;
      for(const c of g) out.push(c);
    }
    return out;
  }

  // FR-AGG-10: 그룹 접힘은 창 id 별로 **클라이언트**에 남는다 — 보는 방식은
  // 워크스페이스의 것이 아니다 (FR-SBT-6 과 같은 근거).
  _agFolded(){
    if(!this._agFold){
      const ids=PrefStore.local.json(STORE_KEYS.agentsGroupFold,[]);
      // UX_BATCH12_SRS FR-SVL-2·3: 폴더형 보기가 없어졌다 — 그 접힘(`sub:`)과 보기 값을 걷는다.
      this._agFold=new Set((Array.isArray(ids)?ids:[]).filter(k=>!String(k).startsWith('sub:')));
      PrefStore.local.remove(AGENT_SUB_VIEW_KEY);
    }
    return this._agFold;
  }

  _agFoldToggle(winId){
    const f=this._agFolded();
    if(f.has(winId)) f.delete(winId); else f.add(winId);
    PrefStore.local.setJson(STORE_KEYS.agentsGroupFold,Array.from(f));
    this.agentsRender();
  }

  // FR-AGG-1·10·11·12: 그룹 머리. 창 이름을 말하고, 접히고, 알람 수를 보이고,
  // 누르면 그 창으로 간다.
  _agGroupEl(win,attn,folded){
    const g=document.createElement('div');
    g.className='ag-group'+(folded?' folded':'')+(attn?' attn':'');
    g.dataset.sid=win.id;
    g.appendChild(UIKit.button({
      icon:folded?'chevron-right':'chevron-down',
      // FR-TIP-2: 툴팁은 영어다. 종전에는 한국어였고, 이 패널을 재는 시험이
      // 없어서 드러나지 않았다 — FR-ACT-1 이 주의 구역을 여기로 옮기면서
      // `tooltips.spec.ts` C10 이 패널 전체를 보게 됐다.
      title:folded?TIP_AG_GROUP_EXPAND:TIP_AG_GROUP_COLLAPSE,
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
      b.title=tn('attn.alarm_count',attn);
      g.appendChild(b);
    }
    /**
     * UIUX_OVERHAUL_SRS FR-ACT-10 (D-7): **몸통을 눌러도 접힌다.**
     *
     *   이전 동작: 몸통을 누르면 그 창으로 갔다 (`PANEL_SURFACE_SRS` FR-AGG-12)
     *   새  동작: 구역 머리(`.ag-sec`)와 같다 — 접고 편다
     *   이유:     같은 패널에서 같은 모양의 줄이 클릭에 다르게 답하고 있었다.
     *             한 줄이 접히고 옆줄이 창을 바꾸면 규칙을 외울 수 없다
     *
     * 잃는 것은 *"접힌 그룹에서 그 창으로 가기"* 하나다 — 펼친 그룹에서는 카드
     * 클릭이 `jumpToTool` 로 **창이 아니라 그 도구**로 가고, 창으로 가는 길은
     * 사이드바가 갖는다. 꺽쇠는 그대로 선다.
     */
    g.addEventListener('click',()=>this._agFoldToggle(win.id));
    return g;
  }

  /**
   * PANEL_TEMPLATE_SRS FR-PNT-2~4: 머리의 끝 단추 — 접기 (UX_AUDIT_FIX_SRS FR-UXF-27: 새로고침은 없다). 머리 줄 자체(`#agents-head.ag-head`,
   * 끌어서 자리를 바꾸는 손잡이, PANEL_DOCK_SRS FR-PDK-30)는 index.html 에 있다.
   *
   *   이전 동작: 제목 `Activity` 와 두 단추가 한 줄(`.ag-head`)이었고 그 아래에 탭 줄이 섰다
   *   새  동작: 제목이 없고, 두 단추는 탭 줄 끝의 `.ui-panel-acts` 다
   *   이유:     메인 패널과 같은 머리 — 탭 줄 한 줄이 상단바 선에 맞는다 (D-3)
   */
  _agHeadEl(){
    const head=document.createElement('div');
    head.className='ui-panel-acts';
    // UI_KIT_SRS FR-GLY-4·6 / FR-TIP-2: 문자에서 스프라이트로. 문구도 영어가
    // 된다 — 아이콘만 있는 버튼은 툴팁이 이름의 유일한 자리다.
    // 골격은 마크업으로, **값이 들어가는 자리는 DOM 으로** 세운다.
    // `iconHTML` 이 돌려주는 것은 스프라이트 마크업이라 이스케이프 대상이
    // 아니지만, 문자열 조립 안에 두면 "여기 들어오는 것은 마크업이다" 라는
    // 예외가 생긴다 — 예외가 있으면 다음 사람이 판단해야 하고, 그 판단이
    // 틀리는 날이 온다 (`scripts/check-html.sh`).
    const mkBtn=(cls,tip,icon)=>{
      const b=document.createElement('button');
      b.className='ui-btn ui-btn-icon ui-btn-ghost '+cls;
      b.title=tip; b.setAttribute('aria-label',tip);
      b.innerHTML=UIKit.iconHTML(icon);
      head.appendChild(b);
    };
    // UX_BATCH12_SRS FR-ACF-5: 닫기가 아니라 접기다. 레일에서는 같은 단추가 펼친다.
    // QUALITY_FIX_SRS FR-QFX-3: 메인 패널의 접기(`sb-collapse`)와 같은 큰 단추(30px)다. 이전: 표준(26px).
    const open=this.agentsPanelOpen();
    mkBtn('ui-btn-lg ag-collapse',open?(this.app.isMobile?TIP_PANEL_CLOSE:TIP_PANEL_COLLAPSE):TIP_PANEL_EXPAND,this._agCollapseIcon());   // FR-MUX-17
    head.querySelector('.ag-collapse').addEventListener('click',e=>{e.stopPropagation();this.agentsToggle()});
    return head;
  }

  // UX_BATCH13_SRS FR-ACB-4
  _agCollapseIcon(){
    return agCollapseIcon(this.agentsPanelOpen(),document.documentElement.dataset.agSide||'right',this.app.isMobile);
  }

  /** FR-ACU-10~14: 막대 → 백분율 → 모델·effort. 값이 없는 부분은 원소도 없다. */
  _agUsageEl(v){
    const row=document.createElement('div');
    row.className='ag-usage'+(v.level==='warn'||v.level==='critical'?' lv-'+v.level:'');
    row.title=v.title;
    // ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-30: 모델·effort 가 왼쪽, 막대와 백분율이 오른쪽 끝이다.
    if(v.label){
      const m=document.createElement('span');m.className='ag-usage-model';
      m.textContent=v.label;
      row.appendChild(m);
    }
    if(v.pct!==null){
      const bar=document.createElement('div');bar.className='ag-usage-bar';
      const fill=document.createElement('div');fill.className='ag-usage-fill';
      fill.style.width=v.fill+'%';
      bar.appendChild(fill);
      const pct=document.createElement('span');pct.className='ag-usage-pct';
      pct.textContent=v.pct+'%';
      row.appendChild(bar);row.appendChild(pct);
    }
    return row;
  }

  _agCardEl(panel,toolId,info,loc){
    info=info||{};
    const card=document.createElement('div');
    card.className='ag-card'+(this.app.attn.attnHas(toolId)?' attn':'')+(toolId===this.app.attn._agFocusedTool()?' focused':'');
    card.dataset.toolid=toolId;
    // FR-NAM-1·6: 도구 이름은 한 자리에서 온다 — 에이전트 패널이 화면의 탭과
    // 다른 이름을 부르면 어느 도구인지 짚을 수 없다.
    // FR-AGG-13: 창 이름은 머리가 말한다. 카드에는 도구 이름만 남는다.
    const locDiv=document.createElement('div');locDiv.className='ag-loc';
    locDiv.textContent=this.app._toolName(toolId,loc.tab.name||toolId);
    /**
     * UX_AUDIT_FIX_SRS FR-UXF-25: 첫 줄은 상태 기호 · 탭 이름, 둘째 줄은 상태·도구 · detail 이다.
     *   이전: detail → 탭 이름(작은 보조 글자) → `● working · Edit` 차례로 세 줄
     *   이유: 카드의 주인공(어느 탭인가)이 가장 작은 글자였다 (진단 D16·M12)
     */
    const dot=document.createElement('span');dot.className='ag-dot';
    if(info.state) dot.classList.add(info.state);
    dot.appendChild(agentStateIcon(info.state));  // UX_AUDIT_FIX_SRS FR-UXF-100
    const head=document.createElement('div');head.className='ag-line ag-line-head';
    head.append(dot,locDiv);
    const st=document.createElement('span');st.className='ag-state';
    if(info.state) st.classList.add(info.state); // 상태별 색(.ag-state.working 등)
    st.textContent=(AGENT_STATE_LABEL[info.state]||info.state)+(info.tool?' · '+info.tool:'');
    const what=document.createElement('div');what.className='ag-line ag-line-what';
    what.appendChild(st);
    if(info.detail){const dt=document.createElement('span');dt.className='ag-detail';dt.textContent=info.detail;what.appendChild(dt);}
    card.append(head,what);
    const uv=agentUsageView(info.usage); // FR-ACU-10·11
    if(uv) card.appendChild(this._agUsageEl(uv));
    const subs=Array.isArray(info.subagents)?info.subagents:[];
    // UX_BATCH12_SRS FR-SVL-1: 서브에이전트는 언제나 카드 안의 목록이다 (FR-ASV-34).
    for(const s of subs) card.appendChild(this.sub._agSubagentEl(agentSubagentView(s))); // FR-SAU-20
    // FR-ATA-6: 해제는 jumpToTool 이 한다. PANEL_TEMPLATE_SRS FR-PNT-15: 이동했으면 모바일 시트를 닫는다.
    card.addEventListener('click',()=>{this.app.attn.jumpToTool(toolId);if(this.app.mobile.nav.actSheetLeave)this.app.mobile.nav.actSheetLeave()});
    // FR-AAP-21: 창 사이드바와 동일한 native DnD. drop(즉시) 1순위, dragend 폴백.
    card.draggable=true;
    card.addEventListener('dragstart',e=>{
      this.app.drag={type:'agent',pid:toolId,targetPid:null,before:false,done:false};
      e.dataTransfer.effectAllowed='move';
      TIMERS.defer(()=>card.classList.add('dragging'),{label:'drag-class'});
    });
    card.addEventListener('dragover',e=>{
      const dr=this.app.drag;if(!dr||dr.type!=='agent')return;
      e.preventDefault();
      panel.querySelectorAll('.ag-card').forEach(c=>c.classList.remove('drag-above','drag-below'));
      const rect=card.getBoundingClientRect();
      const before=e.clientY<rect.top+rect.height/2;
      card.classList.add(before?'drag-above':'drag-below');
      dr.targetPid=toolId;dr.before=before;
    });
    card.addEventListener('drop',e=>{const dr=this.app.drag;if(!dr||dr.type!=='agent')return;e.preventDefault();e.stopPropagation();this.reorderAgents(dr)});
    // dragend 는 시각 정리만 — 패널 밖 release 는 취소(순서 불변, snap-back 깜빡임 방지).
    card.addEventListener('dragend',()=>{this.app.drag=null;card.classList.remove('dragging');panel.querySelectorAll('.ag-card').forEach(c=>c.classList.remove('drag-above','drag-below'))});
    return card;
  }
}
