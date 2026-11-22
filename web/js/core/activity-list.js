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
 * `ActivityList` 는 `AgentsController` 의 부품이다(`agents.list`, REFACTOR3_FE_APPCTL_SRS 9c). 구역 서술자는 종전대로 App 을
 * 받는다. 패널(`ActivityPanel`)은 이 부품이 든다(`activityPanel`).
 *
 * 로드 순서 계약: `app.js` **뒤**, `agents-controller.js` 뒤. 구역이 부르는 이름들
 * (`_bgRow`·`runsPanel`·`_attnDetail`)은 **호출 시점**에만 있으면 된다.
 */

/**
 * 구역과 그 순서. 패널 머리의 탭 줄이 이 순서다 (PEER_CHAT_SRS FR-PCH-80, §4.2).
 *
 *   items(app)  이 구역이 그릴 항목들. `reconcileList` 의 항목 규약을 따른다
 *   badge(app,its)  탭의 배지 `{n, dot}`. 없으면 항목 수다
 *   shownOnly   참이면 고른 탭일 때만 items 를 부른다 — 배지가 항목을 읽지 않는다
 *   empty()     비었을 때의 한 줄 · `hint()` 가 있으면 그 아래 한 줄 더
 *   icon        탭의 아이콘. 레일에서는 이것만 선다 (FR-PCH-82)
 *   tip         탭의 툴팁. 영어다 (FR-TIP-2)
 *   badgeWork   참이면 배지의 수가 작업 중인 수다 — 툴팁·접근 이름이 그 수를 말한다 (REFACTOR3_FE_FIX_SRS FR-FFX-4)
 */
const ACTIVITY_SECTIONS=[
  {key:'agents', icon:'bot', title:()=>t('panel.sec_agents'), tip:()=>TIP_ACT_AGENTS, empty:()=>t('attn.no_active_agents'),
   items:app=>app.agents._agWindowItems(),
   // FR-PCH-81: Agents 는 알람 점이다. 접힌 창도 그룹 머리가 알람 수를 갖는다.
   // UX_AUDIT_FIX_SRS FR-UXF-63: 배지는 작업 중인 수다. 주의가 있으면 종전대로 점이고 수는 말하지 않는다.
   badge:(app,its)=>{const dot=its.some(i=>i.t==='group'&&i.attn>0);return {n:dot||!app.tool?.work.workingToolIds?0:app.tool.work.workingToolIds().size,dot}},
   badgeWork:true},
  {key:'bg', icon:'layers', title:()=>t('bg.title'), tip:()=>TIP_ACT_BG, empty:()=>t('bg.empty'),
   items:app=>app.agents.list._actBgRows()},
  {key:'runs', icon:'workflow', title:()=>t('runs.title'), tip:()=>TIP_ACT_RUNS, empty:()=>t('runs.empty'), hint:()=>t('runs.empty_hint'),
   items:app=>app.agents.list._actRunsRows()},
  // CHAT_WINDOW_SRS FR-CW-40 (D-7): Chats 구역은 메인 패널의 `채팅` 탭으로 옮겼다. 이전: 넷째 탭 `chats`.
];

/**
 * ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-40~43 (D-ASV-11): Usage 바닥 — 패널 맨 아래에 붙은 계정 한도.
 * 창 블록의 모양은 Claude Code `/usage` 와 CodexBar 를 따른다 — 이름 · `NN% used` · 막대 · `Resets in 2h 10m`.
 *
 * CLAUDE_ACCOUNTS_SRS FR-CAC-90·93 (D-CAC-6): 바닥은 등록 계정마다 묶음 하나(`claude-accounts-controller.js`)와
 * 맨 아래 statusLine 한 줄이다.
 *   이전 동작: statusLine `rate_limits` 를 창마다 막대 블록으로 그렸다
 *   새  동작: statusLine 값은 한 줄(`statusLine · 세션 34% · 주간 21% · 2시간 10분 후 초기화`)이고,
 *             창 블록은 계정 묶음이 쓴다
 *   이유:     계정을 구분하는 값(계정 묶음)과 구분하지 못하는 값(statusLine)을 섞지 않는다
 */

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

/** D-CAC-37: 남은 시간을 가장 큰 단위 하나로 짧게 — `4d`·`2h`·`35m`. 1분 미만·모름은 빈 값이다. */
function limitShortLeft(sec){
  if(!(sec>=60)) return '';
  const m=Math.floor(sec/60);
  if(m>=1440) return t('usage.short.d',{n:Math.floor(m/1440)});
  if(m>=60) return t('usage.short.h',{n:Math.floor(m/60)});
  return t('usage.short.m',{n:m});
}

/**
 * D-CAC-37: 좁은 카드·statusLine 줄의 칸 하나. `name` 은 `five_hour`·`seven_day` 다. 툴팁은 창 이름·사용률·초기화 문구다.
 * 값이 없으면 null — 칸은 자리만 지킨다.
 */
/** 레일 칸(약 18px)에 드는 % 글자 수 — `99%` 까지. */
const RAIL_PCT_FIT=3;

function limitCell(name,pct,resetsInSec,level){
  if(typeof pct!=='number') return null;
  const n=Math.round(pct);
  const used=t('usage.used',{n});
  const has=typeof resetsInSec==='number';
  return {label:t('usage.sl.'+name),short:t('usage.rail.'+name),pct:n+'%',left:has?limitShortLeft(resetsInSec):'',
    fill:Math.min(100,Math.max(0,pct)),level:level||'',
    title:[limitWindowLabel(name),used,has?limitResetText(resetsInSec):''].filter(Boolean).join(' · ')};
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
  const title=[label,n+'% used',typeof resetsAt==='number'&&resetsAt>0?'resets at '+limitClock(resetsAt*MS_PER_SEC):'']
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
  const ws=Array.isArray(l.windows)?l.windows:[];
  const cells=LIMIT_SL_KEYS.map(name=>{
    const w=ws.find(x=>x&&x.name===name);
    return w?limitCell(name,w.usedPct,w.resetsInSec,w.level):null;
  });
  if(!cells.some(Boolean)) return null;
  const stale=typeof l.observedAt==='number'&&nowMs-l.observedAt>LIMIT_STALE_MS;
  return {label:t('usage.sl.label'),cells,asOf:stale?t('usage.as_of',{t:limitClock(l.observedAt)}):''};
}

/**
 * MOBILE_UX_OVERHAUL_SRS FR-MUX-70: 모바일 바닥의 요약 한 줄 — 활성 계정, 없으면 첫 계정, 계정이 없으면 첫 statusLine 줄.
 * `accounts` 는 `claudeAcctFootViews` 의 값, `lines` 는 statusLine 줄들이다.
 */
function actUsageSumView(accounts,lines,open){
  const a=accounts.find(x=>x.active)||accounts[0];
  if(a) return {name:a.name,color:a.color,cells:a.mini,open};
  const l=lines[0];
  return {name:l.name||l.label,color:l.color||'',cells:l.cells,open};
}

class ActivityList extends Controller {

  /**
   * FR-PCH-80·81: 패널 머리 아래의 전부 — 탭 줄 하나와 고른 탭의 항목. 다른 탭은 배지만 센다.
   *
   *   이전 동작: 세 구역이 위아래로 쌓이고 구역마다 접고 폈다 (UX_BATCH12 FR-ACF)
   *   새  동작: 탭 줄로 한 번에 한 구역만 보인다. 구역 접기는 없다
   *   이유:     PEER_CHAT_SRS D-PCH-31 — Chats 를 더하면서 목록이 패널을 채우게 한다
   */
  _actItems(){
    const cur=this._actTab(),tabs=[];
    let body=[];
    for(const sec of ACTIVITY_SECTIONS){
      const shown=sec.key===cur;
      const its=(shown||!sec.shownOnly)?(sec.items(this.app)||[]):[];
      const b=sec.badge?sec.badge(this.app,its):{n:its.length};
      // REFACTOR3_FE_FIX_SRS FR-FFX-4: 배지가 작업 중인 수인 구역은 그 수를 이름으로도 말한다.
      tabs.push({key:sec.key,icon:sec.icon,title:sec.title(),tip:sec.tip(),n:b.n||0,dot:!!b.dot,
        work:sec.badgeWork&&!b.dot?(b.n||0):0});
      if(shown) body=its.length?its:[{t:'secempty',sec}];
    }
    const out=[{t:'tabs',cur,tabs}].concat(body);
    // FR-ASV-40·43 · FR-CAC-90: Usage 바닥은 늘 맨 끝이고, 계정도 statusLine 값도 없으면 없다.
    const accounts=claudeAcctFootViews(this.app._claudeAccts,this.app.claude._claudeAcctFold(),this.app._claudeAcctPopId);
    const sl=statusLineView(this.app._limits,Date.now());
    const acctSl=claudeAcctStatusLines(this.app._claudeAcctOtherSl);   // MOBILE_UX_OVERHAUL_SRS FR-MUX-81
    if(!accounts.length&&!sl&&!acctSl.length) return out;
    const view={accounts,next:accounts.length>1,auto:claudeAcctAutoView(this.app._claudeAcctAuto),acctSl,sl};
    // UX_AUDIT_FIX_SRS FR-UXF-73 (D-25): 데스크톱도 요약 줄이 먼저다.
    //   이전 동작: 요약 줄은 모바일에만 있었다 (MOBILE_UX_OVERHAUL_SRS FR-MUX-73)
    //   새  동작: 두 모드 모두. 펼침은 기기에 기억한다 (FR-UXF-74)
    //   이유:     진단 D17·X8 — 데스크톱 바닥이 늘 약 250px 를 차지했다
    view.sum=actUsageSumView(accounts,sl?acctSl.concat([sl]):acctSl,this._actUsageOpenNow());
    out.push({t:'foot',view});
    return out;
  }

  /** FR-UXF-74: 사용량 바닥의 펼침. 저장값이 없으면 데스크톱은 펼침, 모바일은 접힘이다. */
  _actUsageOpenNow(){ return PrefStore.local.bool(STORE_KEYS.activityUsageOpen,!this.app.isMobile) }

  /** 작업 패널과 그 탭 줄 (REFACTOR3_FE_BASE_SRS FR-FEB-24). 처음 부를 때 만든다 — 단위 시험의 App 대역도 같은 길을 지난다. */
  actPanel(){ return this.activityPanel||(this.activityPanel=new ActivityPanel(this.app)) }

  // ── 탭 줄 (REFACTOR3_FE_BASE_SRS FR-FEB-22, 위임) ── 하는 일은 `ActivityTabBar`(activity-tab-bar.js)가 맡는다.

  /** 고른 탭. 저장 값이 모르는 탭이면 첫 탭이다. */
  _actTab(){ return this.actPanel().tabs.current }

  /** FR-PCH-82 · FR-UXF-121: 탭을 바꾼다. 레일이면 레일인 채로 바뀌고, 탭마다 보던 자리로 돌아온다. */
  _actTabSelect(key){ this.actPanel().tabs.select(key) }

  /** FR-PCH-80~82 · FR-UXF-123: 탭 줄. 단추는 한 번 만들고 활성·배지·점·툴팁은 `_actTabsPaint` 가 고친다. */
  _actTabsEl(){ return this.actPanel().tabs.ensure() }

  _actTabsPaint(bar,cur,tabs){ if(bar) this.actPanel().tabs.paintWith(tabs) }

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
  }

  /**
   * FR-ACT-3·4: 패널을 열고 그 구역으로 간다.
   *
   * 기존 진입점 셋(`Ctrl+Shift+O`·`B`·`A`)이 전부 이리로 온다 — 주의 배지는
   * 제 팝오버를 가지므로 여기 없다 (FR-ACT-8) —
   * **외운 키를 뺏지 않는다** (NFR-4). 같은 구역을 다시 부르면 패널이 닫힌다:
   * 토글이던 것은 토글로 남는다.
   */
  actPanelOpen(key){ this.actPanel().show(key) }

  /** 구역의 목록을 다시 받는다. 활동은 자기 등록부가 몰고 온다 (FR-HUB-3). */
  _actRefresh(){
    this.app.tool.life._bgRefresh();
    this.app.runsPanel()._runsRefresh();
    this.app.agents._activityRestore();
  }

  // ── 구역이 주는 항목 ─────────────────────────────────────────────

  _actBgRows(){
    return (this.app._bg||[]).map(b=>({t:'row',sec:'bg',id:b.toolId,el:this.app.statusbar._bgRow(b)}));
  }

  /** FR-ASV-40·41 · FR-CAC-90~93: Usage 바닥. 계정 머리 줄(자동 전환 표식·전환 메뉴) · 계정 묶음 · 맨 아래 statusLine 줄. */
  _actUsageFootEl(view){
    const foot=document.createElement('div');
    foot.className='act-usage-foot';
    // MOBILE_UX_OVERHAUL_SRS FR-MUX-70·71 · FR-UXF-73: 요약 한 줄이 먼저다(두 모드). 접혀 있으면 그것뿐이다.
    if(view.sum){
      foot.classList.add('has-sum');
      foot.appendChild(this._actUsageSumEl(view.sum));
      if(!view.sum.open) return foot;
    }
    if(view.accounts.length){
      const head=foot.appendChild(domEl('div','act-usage-head'));
      head.appendChild(domEl('span','act-usage-name',t('cacct.title')));
      head.appendChild(domEl('span','cacct-auto'+(view.auto.on?' on':''),view.auto.text));
      // UX_AUDIT_FIX_SRS FR-UXF-100: 메뉴를 여는 꺾쇠는 라벨 뒤의 아이콘이다(이전 카탈로그 글자 `▾`).
      if(view.next) head.appendChild(UIKit.button({label:t('cacct.smart.menu'),kind:'ghost',size:'sm',cls:'cacct-smart',
        onClick:e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();this.app.claude._claudeAcctSmartMenu({x:r.left,y:r.bottom})}}))
        .appendChild(UIKit.icon('ellipsis',{size:'sm'}));
      for(const a of view.accounts) foot.appendChild(this.app.claude._claudeAcctEl(a));
    }
    // FR-CAC-93 · D-CAC-37: statusLine 은 머리 한 줄 아래 좁은 카드와 같은 줄 모양이다. 오래됨은 흐림·툴팁이다.
    // 계정을 모르는 보고는 이름 칸이 빈 마지막 줄이다.
    const lines=(view.acctSl||[]).slice();
    if(view.sl) lines.push(view.sl);
    if(lines.length) foot.appendChild(domEl('div','act-usage-sl-h',lines[0].label));
    for(const l of lines){
      const row=foot.appendChild(domEl('div','act-usage-sl'+(l.key?' cacct-sl':'')+(l.asOf?' stale':'')));
      row.title=TIP_LIMIT_STATUSLINE+(l.asOf?' · '+l.asOf:'');
      const who=row.appendChild(domEl('span','cacct-who'));
      if(l.color) who.appendChild(domEl('span','cacct-dot')).style.background='var(--'+l.color+')';
      if(l.name) who.appendChild(domEl('span','cacct-name',l.name));
      this._actCellsEl(row,l.cells);
    }
    return foot;
  }

  /** FR-MUX-70~72 · FR-UXF-73·74: 요약 줄 — 색 점 · 이름 · 세션·주간 칸 · 펼침 아이콘. 누르면 펼치고 접고, 기억한다. */
  _actUsageSumEl(v){
    const b=document.createElement('button');
    b.type='button';b.className='ui-btn ui-btn-ghost act-usage-sum';
    b.setAttribute('aria-expanded',String(v.open));
    b.title=v.open?TIP_USAGE_SUM_CLOSE:TIP_USAGE_SUM_OPEN;
    b.addEventListener('click',e=>{e.stopPropagation();PrefStore.local.setBool(STORE_KEYS.activityUsageOpen,!v.open);this.app.agents.agentsRender()});
    const who=b.appendChild(domEl('span','cacct-who'));
    if(v.color) who.appendChild(domEl('span','cacct-dot')).style.background='var(--'+v.color+')';
    who.appendChild(domEl('span','cacct-name',v.name));
    this._actCellsEl(b,v.cells);
    b.appendChild(UIKit.icon(v.open?'chevron-down':'chevron-right'));
    return b;
  }

  /** D-CAC-37: 세션·주간 두 칸 — 칸 앞에 작은 창 이름. 값이 없는 칸도 자리를 지켜 열이 맞는다. */
  _actCellsEl(parent,cells){
    const box=parent.appendChild(domEl('span','cacct-cells'));
    for(const c of cells){
      // `pct-wide`: 세 자리 %(100% 이상)는 레일 칸에 들지 않아 CSS 가 가로로 좁힌다 (RAIL_CHAT_USAGE_SRS FR-RCU-3 개정).
      const el=box.appendChild(domEl('span','cacct-cell'+(c&&(c.level==='warn'||c.level==='critical')?' lv-'+c.level:'')+(c&&c.pct.length>RAIL_PCT_FIT?' pct-wide':'')));
      if(!c) continue;
      el.title=c.title;
      el.appendChild(domEl('span','cacct-cell-label',c.label));
      el.appendChild(domEl('span','cacct-cell-pct',c.pct));
      if(c.left) el.appendChild(domEl('span','cacct-cell-left',c.left));
      el.appendChild(domEl('span','cacct-cell-win',c.short));
      // RAIL_CHAT_USAGE_SRS FR-RCU-3 (개정): 레일에서는 막대가 서서 높이로 찬다 — 폭과 높이에 같은 값을 주고 CSS 가 한쪽을 `min-*:100%` 로 덮는다.
      const fill=el.appendChild(domEl('span','cacct-cell-bar')).appendChild(domEl('span','cacct-cell-fill'));
      fill.style.width=fill.style.height=c.fill+'%';
    }
    return box;
  }

  /** FR-ASV-41: 창 블록 — 이름과 사용률 / 막대 / 남은 시간. */
  _actUsageWinEl(parent,w){
    const win=parent.appendChild(domEl('div','act-usage-win'+(w.level==='warn'||w.level==='critical'?' lv-'+w.level:'')));
    win.title=w.title;
    const top=win.appendChild(domEl('div','act-usage-top'));
    top.appendChild(domEl('span','act-usage-label',w.label));
    top.appendChild(domEl('span','act-usage-used',w.used));
    const track=win.appendChild(domEl('div','act-usage-track'));
    track.appendChild(domEl('div','act-usage-fill')).style.width=w.fill+'%';
    if(w.reset) win.appendChild(domEl('div','act-usage-reset',w.reset));
    return win;
  }

  _actRunsRows(){
    const rp=this.app.runsPanel();
    // 목록을 받지 못한 것은 "없다" 가 아니다 — 그 사실이 구역 안에 남는다 (FR-RVZ-4).
    if(rp._runsErr){
      const d=document.createElement('div'); d.className='runs-err'; d.textContent=rp._runsErr;
      return [{t:'row',sec:'runs',id:'err',el:d}];
    }
    return (rp._runsList||[]).map(rv=>({t:'row',sec:'runs',id:String(rv.id),el:rp._runsRow(rv)}));
  }
}
