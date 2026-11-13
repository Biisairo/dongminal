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
 * 창 블록의 모양은 Claude Code `/usage` 와 CodexBar 를 따른다 — 이름 · `NN% used` · 막대 · `Resets in 2h 10m`.
 *
 * CLAUDE_ACCOUNTS_SRS FR-CAC-90·93 (D-CAC-6): 바닥은 등록 계정마다 묶음 하나(`app-claude-accounts.js`)와
 * 맨 아래 statusLine 한 줄이다.
 *   이전 동작: statusLine `rate_limits` 를 창마다 막대 블록으로 그렸다
 *   새  동작: statusLine 값은 한 줄(`statusLine · 세션 34% · 주간 21% · 2시간 10분 후 초기화`)이고,
 *             창 블록은 계정 묶음이 쓴다
 *   이유:     계정을 구분하는 값(계정 묶음)과 구분하지 못하는 값(statusLine)을 섞지 않는다
 */

/** FR-ASV-42: 관측이 이보다 오래되면 `as of HH:MM` 을 보인다. */
const LIMIT_STALE_MS=10*60*1000;
/** FR-ASV-41: i18n 이름이 있는 창. 나머지는 `limitWindowLabel` 이 사람이 읽는 꼴로 쓴다. */
const LIMIT_WINDOW_KEYS=Object.freeze(['five_hour','seven_day','seven_day_opus','seven_day_sonnet']);
/** FR-CAC-93: statusLine 줄에서 짧은 이름을 갖는 창. */
const LIMIT_SL_KEYS=Object.freeze(['five_hour','seven_day']);

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
 * FR-ASV-41: 창 블록 하나의 값. 남은 시간과 등급은 서버가 셈한 값만 쓴다 (D-ASV-10).
 * `resetsAt` 은 unix 초이고 툴팁에만 쓴다.
 */
function limitBarView(id,label,pct,resetsAt,resetsInSec,level){
  const n=Math.round(pct);
  // 툴팁은 영어다 (FR-TIP-2) — 이름은 화면 문구를 그대로 쓰고, 나머지 낱말만 영어로 둔다.
  const title=[label,n+'% used',typeof resetsAt==='number'&&resetsAt>0?'resets at '+limitClock(resetsAt*1000):'']
    .filter(Boolean).join(' · ');
  return {id,label,used:t('usage.used',{n}),fill:Math.min(100,Math.max(0,pct)),level:level||'',
    reset:typeof resetsInSec==='number'?limitResetText(resetsInSec):'',title};
}

/**
 * FR-CAC-93: statusLine 한 줄. 값이 없으면 null 이다. 창마다 짧은 이름과 %, 끝에 세션 창의 초기화.
 * `nowMs` 는 오래된 관측을 가를 때만 쓴다.
 */
function statusLineView(limits,nowMs){
  const l=(Array.isArray(limits)?limits:[]).find(x=>x&&x.agent==='claude');
  if(!l) return null;
  const segs=[];
  let reset='';
  for(const w of Array.isArray(l.windows)?l.windows:[]){
    if(typeof w.usedPct!=='number') continue;
    const name=LIMIT_SL_KEYS.includes(w.name)?t('usage.sl.'+w.name):limitWindowLabel(w.name);
    segs.push({text:name+' '+Math.round(w.usedPct)+'%',level:w.level||''});
    if(w.name==='five_hour'&&typeof w.resetsInSec==='number') reset=limitResetText(w.resetsInSec);
  }
  if(!segs.length) return null;
  const stale=typeof l.observedAt==='number'&&nowMs-l.observedAt>LIMIT_STALE_MS;
  return {label:t('usage.sl.label'),segs,reset,asOf:stale?t('usage.as_of',{t:limitClock(l.observedAt)}):''};
}

/** 바닥의 작은 원소 하나를 부모 끝에 붙인다. */
function actEl(parent,tag,cls,text){
  const e=document.createElement(tag);e.className=cls;
  if(text!==undefined) e.textContent=text;
  parent.appendChild(e);return e;
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
    // FR-ASV-40·43 · FR-CAC-90: Usage 바닥은 늘 맨 끝이고, 계정도 statusLine 값도 없으면 없다.
    const accounts=claudeAcctFootViews(this._claudeAccts,this._claudeAcctOpen());
    const sl=statusLineView(this._limits,Date.now());
    if(accounts.length||sl) out.push({t:'foot',view:{accounts,next:accounts.length>1,sl}});
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
    // UI_POLISH_SRS FR-UIP-7: 0 은 말하지 않는다 — 레일의 귀퉁이에 0 셋이 서 있었다.
    b.hidden=!n;
    g.appendChild(b);
    // 구역의 동작은 비어 있을 때 뜻이 없다 — 지울 것이 없으면 "모두 제거" 도 없다.
    if(sec.act&&n){
      const a=sec.act(this);
      if(a) g.appendChild(a);
    }
    // UX_BATCH12_SRS FR-ACF-4 (개정 16): 레일에서도 펼침과 같이 그 구역만 접고 편다.
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
    else document.getElementById('agents-body').scrollTop=0;
  },

  // ── 구역이 주는 항목 ─────────────────────────────────────────────

  _actBgRows(){
    return (this._bg||[]).map(b=>({t:'row',sec:'bg',id:b.toolId,el:this._bgRow(b)}));
  },

  /** FR-ASV-40·41 · FR-CAC-90~93: Usage 바닥. 계정 머리 줄 · 계정 묶음 · 맨 아래 statusLine 줄. */
  _actUsageFootEl(view){
    const foot=document.createElement('div');
    foot.className='act-usage-foot';
    if(view.accounts.length){
      const head=actEl(foot,'div','act-usage-head');
      actEl(head,'span','act-usage-name',t('cacct.title'));
      if(view.next) head.appendChild(UIKit.button({label:t('cacct.next'),kind:'ghost',size:'sm',cls:'cacct-next',
        onClick:e=>{e.stopPropagation();this._claudeAcctNext()}}));
      for(const a of view.accounts) foot.appendChild(this._claudeAcctEl(a));
    }
    if(view.sl){
      const sl=actEl(foot,'div','act-usage-sl');
      sl.title='Rate limits reported by the Claude Code statusLine';
      actEl(sl,'span','act-usage-sl-label',view.sl.label);
      for(const g of view.sl.segs) actEl(sl,'span','act-usage-sl-seg'+(g.level==='warn'||g.level==='critical'?' lv-'+g.level:''),g.text);
      if(view.sl.reset) actEl(sl,'span','act-usage-sl-reset',view.sl.reset);
      if(view.sl.asOf) actEl(sl,'span','act-usage-asof',view.sl.asOf);
    }
    return foot;
  },

  /** FR-ASV-41: 창 블록 — 이름과 사용률 / 막대 / 남은 시간. */
  _actUsageWinEl(parent,w){
    const win=actEl(parent,'div','act-usage-win'+(w.level==='warn'||w.level==='critical'?' lv-'+w.level:''));
    win.title=w.title;
    const top=actEl(win,'div','act-usage-top');
    actEl(top,'span','act-usage-label',w.label);
    actEl(top,'span','act-usage-used',w.used);
    const track=actEl(win,'div','act-usage-track');
    actEl(track,'div','act-usage-fill').style.width=w.fill+'%';
    if(w.reset) actEl(win,'div','act-usage-reset',w.reset);
    return win;
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
