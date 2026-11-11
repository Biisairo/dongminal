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
 *   icon        레일에서 이름 대신 서는 아이콘 (UX_BATCH12_SRS FR-ACF-3)
 */
const ACTIVITY_SECTIONS=[
  {key:'agents', icon:'terminal', title:()=>t('panel.sec_agents'), empty:()=>t('attn.no_active_agents'),
   items:app=>app._agWindowItems(), count:its=>its.filter(i=>i.t==='card').length},
  {key:'bg', icon:'archive', title:()=>t('bg.title'), empty:()=>t('bg.empty'),
   items:app=>app._actBgRows()},
  {key:'runs', icon:'play', title:()=>t('runs.title'), empty:()=>t('runs.empty'), hint:()=>t('runs.empty_hint'),
   items:app=>app._actRunsRows()},
];

/**
 * ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-40~43 (D-ASV-11): Usage 바닥 — 패널 맨 아래에 붙은 계정 한도.
 * 이름과 모양은 Claude Code `/usage` 와 CodexBar 를 따른다 — 창마다 이름 · `NN% used` · 막대 ·
 * `Resets in 2h 10m`.
 */

/** FR-ASV-42: 관측이 이보다 오래되면 머리 줄에 `as of HH:MM` 을 보인다. */
const LIMIT_STALE_MS=10*60*1000;
/** FR-ASV-41: i18n 이름이 있는 창. 나머지는 `limitWindowLabel` 이 사람이 읽는 꼴로 쓴다. */
const LIMIT_WINDOW_KEYS=Object.freeze(['five_hour','seven_day','seven_day_opus','seven_day_sonnet']);
const LIMIT_AGENT_NAMES=Object.freeze({claude:'Claude'});

function limitWindowLabel(name){
  if(LIMIT_WINDOW_KEYS.includes(name)) return t('usage.win.'+name);
  const words=String(name).replace(/_/g,' ');
  return words.charAt(0).toUpperCase()+words.slice(1);
}

/** FR-ASV-41: 남은 초를 큰 단위 둘로 쓴다 — `Resets in 4d 6h`·`2h 10m`·`35m`. 0 이하면 `Resets soon` 이다. */
function limitResetText(sec){
  if(!(sec>0)) return t('usage.resets_soon');
  const m=Math.floor(sec/60),d=Math.floor(m/1440),h=Math.floor(m/60)%24;
  const u=(k,n)=>t('usage.dur.'+k,{n});
  const span=d>0?u('d',d)+' '+u('h',h):m>=60?u('h',h)+' '+u('m',m%60):u('m',m);
  return t('usage.resets_in',{t:span});
}

function limitClock(ms){
  const d=new Date(ms);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}

/**
 * FR-ASV-41·42: 바닥이 그리는 값. 에이전트마다 머리 하나와 창 블록들이다. 사용률이 없는 창은 뺀다.
 * 남은 시간은 서버가 셈한 `resetsInSec` 만 쓴다 (D-ASV-10). `nowMs` 는 오래된 관측을 가를 때만 쓴다.
 */
function limitFootView(limits,nowMs){
  const out=[];
  for(const l of Array.isArray(limits)?limits:[]){
    const stale=typeof l.observedAt==='number'&&nowMs-l.observedAt>LIMIT_STALE_MS;
    const windows=[];
    for(const w of Array.isArray(l.windows)?l.windows:[]){
      if(typeof w.usedPct!=='number') continue;
      const pct=Math.round(w.usedPct),label=limitWindowLabel(w.name);
      // 툴팁은 영어다 (FR-TIP-2) — 이름은 화면 문구를 그대로 쓰고, 나머지 낱말만 영어로 둔다.
      const title=[label,pct+'% used',typeof w.resetsAt==='number'?'resets at '+limitClock(w.resetsAt*1000):'']
        .filter(Boolean).join(' · ');
      windows.push({id:l.agent+':'+w.name,label,used:t('usage.used',{n:pct}),
        fill:Math.min(100,Math.max(0,w.usedPct)),level:w.level||'',
        reset:typeof w.resetsInSec==='number'?limitResetText(w.resetsInSec):'',title});
    }
    out.push({agent:l.agent,name:LIMIT_AGENT_NAMES[l.agent]||l.agent,
      asOf:stale?t('usage.as_of',{t:limitClock(l.observedAt)}):'',windows});
  }
  return out;
}

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
    // FR-ASV-40·43: Usage 바닥은 늘 맨 끝이고, 한도가 없으면 없다.
    const foot=limitFootView(this._limits,Date.now());
    if(foot.length) out.push({t:'foot',view:foot});
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
    g.appendChild(UIKit.icon(sec.icon,{cls:'ag-sec-icon'}));
    const name=document.createElement('div');
    name.className='ag-sec-name';
    name.textContent=g.title=sec.title();
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
    // UX_BATCH12_SRS FR-ACF-4: 레일에서는 접기가 아니라 그 구역으로 펼치기다.
    g.addEventListener('click',()=>{
      if(this.agentsPanelOpen()) this._actFoldToggle(sec.key);
      else this.actPanelOpen(sec.key);
    });
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
    PrefStore.local.setJson(STORE_KEYS.agentsGroupFold,Array.from(f));
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
    // 구역이 비어 있으면 그릴 것이 없으므로 먼저 받아 온다 — 열자마자 빈 구역을
    // 보이고 한 박자 뒤에 채우면 "없다" 를 잘못 읽는다. 닫혀 있었으면 `agentsToggle`
    // 이 받는다 (FR-ARR-5).
    if(!open) this.agentsToggle();
    else this._actRefresh();
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

  /** FR-ASV-40·41·42: Usage 바닥. 머리 줄 · 창 블록(이름과 사용률 / 막대 / 남은 시간). */
  _actUsageFootEl(view){
    const foot=document.createElement('div');
    foot.className='act-usage-foot';
    const el=(parent,tag,cls,text)=>{
      const e=document.createElement(tag);e.className=cls;
      if(text!==undefined) e.textContent=text;
      parent.appendChild(e);return e;
    };
    for(const a of view){
      const head=el(foot,'div','act-usage-head');
      el(head,'span','act-usage-name',a.name);
      if(a.asOf) el(head,'span','act-usage-asof',a.asOf);
      for(const w of a.windows){
        const win=el(foot,'div','act-usage-win'+(w.level==='warn'||w.level==='critical'?' lv-'+w.level:''));
        win.title=w.title;
        const top=el(win,'div','act-usage-top');
        el(top,'span','act-usage-label',w.label);
        el(top,'span','act-usage-used',w.used);
        const track=el(win,'div','act-usage-track');
        el(track,'div','act-usage-fill').style.width=w.fill+'%';
        if(w.reset) el(win,'div','act-usage-reset',w.reset);
      }
    }
    return foot;
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
