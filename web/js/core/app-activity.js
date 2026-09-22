/**
 * Remote Terminal — 활동 패널의 구역 (UIUX_OVERHAUL_SRS FR-ACT-1~4 · 7~10)
 *
 * "지금 뭐가 돌고 있나" 를 보는 창구가 **셋이고 표면 문법이 전부 달랐다** —
 * Agents 는 우측 도킹 패널, Background 와 Runs 는 **중앙 차단 모달** (§2.5).
 * 되돌릴 것이 없는 조회가 백드롭으로 앱 전체를 막고 있었다.
 *
 * 한 질문의 답은 한 자리에 있어야 한다. 셋을 **이미 있는 패널**의 구역으로
 * 모은다 — 패널을 새로 만들지 않고, 각 표면이 그리던 **행 마크업을 그대로**
 * 쓴다 (FR-ACT-1: 정보는 그대로다, 합치는 것은 표면이다).
 *
 * ## 주의는 여기 없다 (FR-ACT-7·8, D-7)
 *
 * 초판은 주의 알림까지 **넷**을 모았다. 거기 질문이 둘이었다 — 주의는 *"나를
 * 기다리는 것이 있나"* 이고 나머지 셋은 *"지금 뭐가 돌고 있나"* 다. 물음이
 * 다르면 자리도 다르므로 주의는 팝오버(`#attn-center`)로 돌아갔다.
 *
 * 넷이 셋이 되는 일은 **배열에서 한 줄을 빼는 것**으로 끝났다 — 아래 서술자
 * 규약이 그 방향으로도 선다는 증거다.
 *
 * ## 구역은 서술자다
 *
 * 이 파일이 아는 것은 **구역이 넷이라는 사실과 그 순서**뿐이고, 각 구역이 무엇을
 * 그리는지는 그 표면의 주인이 안다 (`sidebar-tabs.js` 의 *"새 탭 = 서술자 1개"*
 * 와 같은 규약). 다섯째가 생기면 `ACTIVITY_SECTIONS` 에 한 줄이 늘 뿐이다.
 *
 * ## 빈 구역도 머리를 갖는다
 *
 * `FR-AGG-4`("빈 머리는 정보가 아니다")는 **창 그룹**의 규칙이고 구역에는 쓰지
 * 않는다. 구역이 사라지면 `Ctrl+Shift+B` 가 닿을 자리가 없어지고(FR-ACT-4),
 * 무엇이 이 패널에 사는지도 화면이 말하지 못한다. 대신 빈 구역은 **다음 할 일을
 * 말하는 한 줄**을 갖는다 (FR-CPY-2) — 모달 시절의 그 문구 그대로다.
 *
 * 로드 순서 계약: `app.js` **뒤**, `app-agents.js` 뒤. 구역이 부르는 이름들
 * (`_bgRow`·`_runsPanel`·`_attnDetail`)은 **호출 시점**에만 있으면 된다.
 */

/**
 * 구역과 그 순서. 급한 것이 위다 — 주의는 사람을 기다리게 하고 있고, Run 은
 * 대개 이미 돌고 있다.
 *
 *   items(app)  이 구역이 그릴 항목들. `reconcileList` 의 항목 규약을 따른다
 *   count(its)  머리의 배지 수. 항목 수와 다를 수 있다 (에이전트는 창 머리를 뺀다)
 *   empty()     비었을 때의 한 줄 · `hint()` 가 있으면 그 아래 한 줄 더
 *   act(app)    머리에 서는 그 구역만의 동작. 없으면 접기와 수뿐이다
 */
const ACTIVITY_SECTIONS=[
  {key:'agents', title:()=>t('panel.sec_agents'), empty:()=>t('attn.no_active_agents'),
   items:app=>app._agWindowItems(), count:its=>its.filter(i=>i.t==='card').length},
  {key:'bg', title:()=>t('bg.title'), empty:()=>t('bg.empty'),
   items:app=>app._actBgRows()},
  {key:'runs', title:()=>t('runs.title'), empty:()=>t('runs.empty'), hint:()=>t('runs.empty_hint'),
   items:app=>app._actRunsRows()},
];

Object.assign(App.prototype, {

  /** FR-ACT-1: 패널 머리 아래의 전부. 네 구역이 차례로 선다. */
  _actItems(){
    const out=[],fold=this._agFolded();
    for(const sec of ACTIVITY_SECTIONS){
      const its=sec.items(this)||[];
      const n=sec.count?sec.count(its):its.length;
      const folded=fold.has('sec:'+sec.key);
      out.push({t:'sec',sec,n,folded});
      if(folded) continue;
      if(!its.length) out.push({t:'secempty',sec});
      else for(const it of its) out.push(it);
    }
    return out;
  },

  /** 구역 머리. 창 그룹(`_agGroupEl`)과 달리 **접기와 수**만 갖는다. */
  _actSecEl(sec,n,folded){
    const g=document.createElement('div');
    g.className='ag-sec'+(folded?' folded':'');
    g.dataset.sec=sec.key;
    g.appendChild(UIKit.button({
      icon:folded?'chevron-right':'chevron-down',
      // FR-TIP-2: 툴팁은 영어다. 패널의 다른 버튼(`Refresh the activity list` ·
      // `Close the panel`)과 같은 규약이다.
      title:folded?'Expand this section':'Collapse this section',
      kind:'ghost',size:'sm',cls:'ag-sec-fold',
      onClick:e=>{e.stopPropagation();this._actFoldToggle(sec.key)},
    }));
    const name=document.createElement('div');
    name.className='ag-sec-name';
    name.textContent=name.title=sec.title();
    g.appendChild(name);
    const b=document.createElement('span');
    b.className='ag-sec-n ui-badge';
    b.textContent=String(n);
    g.appendChild(b);
    // 구역의 동작은 비어 있을 때 뜻이 없다 — 지울 것이 없으면 "모두 제거" 도 없다.
    if(sec.act&&n){
      const a=sec.act(this);
      if(a) g.appendChild(a);
    }
    g.addEventListener('click',()=>this._actFoldToggle(sec.key));
    return g;
  },

  /** 빈 구역의 한 줄. 문구는 그 표면이 모달·팝오버 시절에 쓰던 것 그대로다. */
  _actSecEmptyEl(sec){
    const d=document.createElement('div');
    d.className='ui-empty ag-sec-empty';
    d.appendChild(document.createTextNode(sec.empty()));
    if(sec.hint){
      const h=document.createElement('div');
      h.className='ag-sec-empty-h'; h.textContent=sec.hint();
      d.appendChild(h);
    }
    return d;
  },

  _actFoldToggle(key){
    const f=this._agFolded(),k='sec:'+key;
    if(f.has(k)) f.delete(k); else f.add(k);
    try{localStorage.setItem('agentsGroupFold',JSON.stringify(Array.from(f)))}catch{}
    this.agentsRender();
  },

  /**
   * FR-ACT-3·4: 패널을 열고 그 구역으로 간다.
   *
   * 기존 진입점 셋(`Ctrl+Shift+O`·`B`·`A`)이 전부 이리로 온다 — 주의 배지는
   * 제 팝오버를 가지므로 여기 없다 (FR-ACT-8) —
   * **외운 키를 뺏지 않는다** (NFR-4). 같은 구역을 다시 부르면 패널이 닫힌다:
   * 토글이던 것은 토글로 남는다.
   */
  actPanelOpen(key){
    const panel=document.getElementById('agents-panel');
    if(!panel) return;
    const open=panel.classList.contains('open');
    if(open&&(!key||this._actLastKey===key)){this._actLastKey=null;this.agentsToggle();return}
    this._actLastKey=key||null;
    if(!open) this.agentsToggle();
    // 구역이 비어 있으면 그릴 것이 없으므로 먼저 받아 온다 — 열자마자 빈 구역을
    // 보이고 한 박자 뒤에 채우면 "없다" 를 잘못 읽는다.
    this._actRefresh();
    this.agentsRender();
    if(key) this._actScrollTo(key);
  },

  /** 구역의 목록을 다시 받는다. 활동은 자기 등록부가 몰고 온다 (FR-HUB-3). */
  _actRefresh(){
    this._bgRefresh();
    this._runsPanel()._runsRefresh();
    this._activityRestore();
  },

  _actScrollTo(key){
    const panel=document.getElementById('agents-panel');
    if(!panel) return;
    // 접혀 있으면 펴 준다 — 부른 구역이 접힌 채로 스크롤되면 아무것도 안 보인다.
    const f=this._agFolded();
    if(f.has('sec:'+key)){f.delete('sec:'+key);this.agentsRender()}
    const el=panel.querySelector('[data-sec="'+key+'"]');
    if(el) el.scrollIntoView({block:'start'});
    else panel.scrollTop=0;
  },

  // ── 구역이 주는 항목 ─────────────────────────────────────────────

  _actBgRows(){
    return (this._bg||[]).map(b=>({t:'row',sec:'bg',id:b.toolId,el:this._bgRow(b)}));
  },

  _actRunsRows(){
    const rp=this._runsPanel();
    // 목록을 받지 못한 것은 "없다" 가 아니다 — 그 사실이 구역 안에 남는다 (FR-RVZ-4).
    if(rp._runsErr){
      const d=document.createElement('div'); d.className='runs-err'; d.textContent=rp._runsErr;
      return [{t:'row',sec:'runs',id:'err',el:d}];
    }
    return (rp._runsList||[]).map(rv=>({t:'row',sec:'runs',id:String(rv.id),el:rp._runsRow(rv)}));
  },

});
