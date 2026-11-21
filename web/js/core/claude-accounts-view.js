/**
 * Dongminal — Claude 다중 계정의 화면 값 (CLAUDE_ACCOUNTS_SRS FR-CAC-90~92 · FR-CAC-122).
 *
 * Activity 하단 묶음·팝오버·알림 줄이 그리는 값을 셈하는 순수 함수와 상수다. 그리는 일은
 * `ClaudeAccountsController`(`claude-accounts-controller.js`)가 한다 — REFACTOR3_FE_APPCTL_SRS 9b 에서 그 파일이
 * 500줄을 넘지 않도록 갈랐다.
 *
 * 로드 순서 계약: `activity-list.js` 뒤 (`limitBarView`·`limitClock`·`limitCell` 을 부른다), `claude-accounts-controller.js` 앞.
 */

/** FR-CAC-98: 서버가 주는 색 키. 밖의 값은 첫 색으로 그린다. */
const CLAUDE_ACCT_COLOR_RE=/^acct-[1-8]$/;
const CLAUDE_ACCT_COLOR_DEFAULT='acct-1';
/** FR-CAC-111: 설정의 "기록" 이 띄우는 건수. */
const CLAUDE_ACCT_HISTORY_LIMIT=50;

function claudeAcctDay(ms){
  const d=new Date(ms);
  return t('cacct.wd.'+d.getDay())+' '+limitClock(ms);
}

function claudeAcctDate(ms){
  const d=new Date(ms);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

/** FR-CAC-91: `$12.40` · 정수면 `$50`. 달러가 아니면 통화 코드를 뒤에 붙인다. */
function claudeAcctMoney(n,cur){
  const v=Number.isInteger(n)?String(n):n.toFixed(2);
  return cur==='USD'?'$'+v:v+' '+cur;
}

/** FR-CAC-57·91: 주간 창의 사용 속도 예측 한 줄. 예측이 없으면 null 이다. */
function claudeAcctPace(p){
  if(!p||typeof p.expectedPct!=='number') return null;
  let text=t('cacct.pace_expected',{n:p.expectedPct});
  if(!p.willLastToReset&&p.projectedExhaustionAt>0) text+=' · '+t('cacct.pace_runout',{t:claudeAcctDay(p.projectedExhaustionAt*1000)});
  else if(p.willLastToReset) text+=' · '+t('cacct.pace_lasts');
  return {text,warn:!!p.aheadOfPace};
}

/** FR-CAC-91: 초기화 시각 — 오늘이면 `14:30`, 아니면 `수 18:00`. `resetsAt` 은 서버가 준 unix 초다. */
function claudeAcctResetClock(resetsAt){
  const ms=resetsAt*1000;
  return new Date(ms).toDateString()===new Date(Date.now()).toDateString()?limitClock(ms):claudeAcctDay(ms);
}

function claudeAcctBar(id,label,w){
  const b=limitBarView(id,label,w.pct,w.resetsAt,w.resetsInSec,w.level);
  if(b.reset&&w.resetsAt>0) b.reset+=' · '+claudeAcctResetClock(w.resetsAt);
  return b;
}

/** FR-CAC-62: 확인 대화상자의 내용 — 채우는 창, 남은 횟수, 기한, 주간 한도 차감 여부. */
function claudeAcctResetConfirm(clears,left,ends,givesBack){
  return {
    clears:t('cacct.rs.clears',{w:clears.map(limitWindowLabel).join(', ')}),
    left,ends,
    weekly:t(givesBack?'cacct.rs.weekly_back':'cacct.rs.weekly_deduct'),
  };
}

/**
 * FR-CAC-65: 펼친 묶음의 "제한 초기화" 칸. 주간 5시간 초기화는 자격이 있을 때, 티켓은 자격이 있고 남은 횟수가
 * 있을 때만 줄이 된다. 상태가 없으면 빈 배열이다 (FR-CAC-61). 주간 5시간 초기화는 늘 주간 한도에서 차감한다.
 */
function claudeAcctResets(rs){
  const out=[];
  if(!rs) return out;
  const j=rs.juniperTide;
  if(j&&j.eligible){
    out.push({key:'juniper',program:'juniper_tide',grantId:'',name:t('cacct.rs.juniper'),
      detail:j.available?t('cacct.rs.usable'):j.nextAvailableAt>0?t('cacct.rs.next',{t:claudeAcctDay(j.nextAvailableAt*1000)}):'',
      usable:!!j.available,confirm:claudeAcctResetConfirm(['five_hour'],'','',false)});
  }
  const c=rs.cedarEmber;
  if(c&&c.eligible){
    for(const g of Array.isArray(c.grants)?c.grants:[]){
      if(!(g.resetsLeft>0)) continue;
      const left=t('cacct.rs.left',{n:g.resetsLeft,m:g.resetsTotal});
      const ends=g.endsAt>0?t('cacct.rs.until',{d:claudeAcctDate(g.endsAt*1000)}):'';
      const usable=!!g.usableNow&&!g.paused;
      const detail=[left,ends,g.paused?t('cacct.rs.paused'):usable?t('cacct.rs.usable'):''].filter(Boolean).join(' · ');
      out.push({key:'g:'+g.id,program:'cedar_ember',grantId:g.id,name:g.label||g.id,detail,usable,
        confirm:claudeAcctResetConfirm(Array.isArray(g.clears)?g.clears:[],left,ends,!!g.givesBackWeekly)});
    }
  }
  return out;
}

/**
 * FR-CAC-91: 계정 묶음 하나의 값. `wide` 면 머리 + 5시간·주간 막대, 아니면 한 줄에 `mini`(세션·주간 칸, D-CAC-37)를 붙인다.
 * `pop` 이면 오버레이의 `more` 에 scoped 창·예측·추가 사용량·로그인 만료·동작이 든다.
 */
function claudeAcctView(a,pop,wide){
  const u=a.usage||{};
  const w=u.windows||{};
  let status='';
  if(u.status&&u.status!=='ok'){
    status=t('cacct.st.'+u.status);
    if(u.backoffUntil>0) status+=' · '+t('cacct.retry_at',{t:limitClock(u.backoffUntil*1000)});
  }
  const headStatus=CLAUDE_ACCT_ACTION_STATES.includes(u.status)?status:'';
  const bars=[];
  if(w.fiveHour) bars.push(claudeAcctBar(a.id+':five_hour',limitWindowLabel('five_hour'),w.fiveHour));
  if(w.sevenDay) bars.push(claudeAcctBar(a.id+':seven_day',limitWindowLabel('seven_day'),w.sevenDay));
  const mini=[claudeAcctCell('five_hour',w.fiveHour),claudeAcctCell('seven_day',w.sevenDay)];
  let more=null;
  if(pop){
    const sp=w.spend;
    more={
      status,
      scoped:(Array.isArray(w.scoped)?w.scoped:[]).map(s=>claudeAcctBar(a.id+':scoped:'+s.name,s.name,s)),
      pace:claudeAcctPace(u.pace&&u.pace.sevenDay),
      spend:sp?t('cacct.spend',{used:claudeAcctMoney(sp.used,sp.currency),limit:claudeAcctMoney(sp.limit,sp.currency)}):'',
      login:u.loginExpiresAt>0?{text:t('cacct.login_expires',{d:claudeAcctDate(u.loginExpiresAt*1000)}),warn:!!u.loginExpiringSoon}:null,
      resets:claudeAcctResets(u.resets),
      resetsAge:u.resets&&u.resets.fetchedAt>0?t('cacct.age_min',{n:Math.max(1,Math.floor((Date.now()/1000-u.resets.fetchedAt)/60))}):'',
      resetsUnknown:!u.resets,
      canSwitch:!a.active,
    };
  }
  return {
    id:a.id,
    name:a.alias||a.email,
    title:[a.email,a.organizationName].filter(Boolean).join(' · '),
    color:CLAUDE_ACCT_COLOR_RE.test(a.color)?a.color:CLAUDE_ACCT_COLOR_DEFAULT,
    active:!!a.active,
    status:headStatus,
    age:u.stale?t('cacct.age_min',{n:Math.max(1,Math.floor((u.ageSeconds||0)/60))}):'',
    pop:!!pop,
    wide:!!wide,
    bars,
    mini,
    more,
  };
}

/** D-CAC-34: 카드 머리에 보이는 상태 — 사용자가 손써야 하는 것만. 나머지는 저절로 다시 시도한다. */
const CLAUDE_ACCT_ACTION_STATES=['relogin_required','keychain_unavailable','no_credentials'];

/** FR-CAC-91: 오버레이와 패널·화면 가장자리 사이의 틈(px). */
const CLAUDE_ACCT_POP_GAP=6;

/**
 * FR-CAC-91: 오버레이 자리. 패널 바깥 옆(패널이 화면 오른쪽 절반이면 왼쪽 먼저)에 칸 높이로 두고 화면 안으로 당긴다.
 * 양옆에 자리가 없으면 화면 폭으로 칸 위에 둔다. `card`·`panel` 은 getBoundingClientRect 값이다.
 */
function claudeAcctPopPlace(card,panel,w,h,vw,vh){
  const g=CLAUDE_ACCT_POP_GAP;
  const top=Math.max(g,Math.min(card.top,vh-h-g));
  const leftOk=panel.left>=w+2*g, rightOk=vw-panel.right>=w+2*g;
  const preferLeft=(panel.left+panel.right)/2>=vw/2;
  if(leftOk&&(preferLeft||!rightOk)) return {left:panel.left-g-w,top,width:w,side:'left'};
  if(rightOk) return {left:panel.right+g,top,width:w,side:'right'};
  return {left:g,top:Math.max(g,card.top-h-g),width:vw-2*g,side:'over'};
}

/** D-CAC-37: 서버 창 뷰(`{pct, resetsInSec, level}`) → 칸. 없으면 null. */
function claudeAcctCell(name,w){ return w?limitCell(name,w.pct,w.resetsInSec,w.level):null }

/** 서버 값(`next-available`·`at-limit` 등)으로 i18n 키를 만든다 — 키에는 `-` 를 쓰지 않는다. */
function claudeAcctKey(prefix,v){ return prefix+String(v).replace(/-/g,'_') }

/** FR-CAC-76·92: 자동 전환 표식. 목록 응답의 요약(`autoswitch`)에서 온다. 꺼져 있으면 상태와 무관하게 "꺼짐" 이다. */
const CLAUDE_ACCT_AUTO_STATES=['on','unmanaged','exhausted'];
function claudeAcctAutoView(s){
  const on=!!(s&&s.enabled);
  const st=on?(CLAUDE_ACCT_AUTO_STATES.includes(s.status)?s.status:'on'):'off';
  return {text:t('cacct.auto.'+st),on};
}

/** FR-CAC-111: 계정 이름. 지워진 계정은 "삭제된 계정" 이다. */
function claudeAcctName(accounts,id){
  const a=(Array.isArray(accounts)?accounts:[]).find(x=>x.id===id);
  return a?(a.alias||a.email):t('cacct.hist.deleted');
}

/** FR-CAC-110a·111: 기록 한 줄의 값. 서버는 계정 ID 만 주고 이름은 화면이 찾는다. */
function claudeAcctHistoryRows(entries,accounts){
  return (Array.isArray(entries)?entries:[]).map(e=>({
    time:claudeAcctDate(e.at*1000)+' '+limitClock(e.at*1000),
    from:claudeAcctName(accounts,e.from),
    to:claudeAcctName(accounts,e.to),
    trigger:t(claudeAcctKey('cacct.trig.',e.trigger)),
    by:t('cacct.by.'+e.by),
  }));
}

/** FR-CAC-100a: 알림 사건. 모르는 사건은 띄우지 않는다. */
const CLAUDE_ACCT_ALERTS=['autoswitch','near_limit','all_exhausted','relogin','login_expiring','autoswitch_stopped'];
function claudeAcctAlertText(a){
  if(!a||!CLAUDE_ACCT_ALERTS.includes(a.kind)) return '';
  let s=t('cacct.alert.'+a.kind,{
    name:a.name||'',from:a.from||'',to:a.to||'',
    trigger:a.trigger?t(claudeAcctKey('cacct.trig.',a.trigger)):'',
    window:a.window?limitWindowLabel(a.window):'',
    d:a.expiresAt>0?claudeAcctDate(a.expiresAt*1000):'',
  });
  if(a.resetAvailable) s+=' · '+t('cacct.alert.reset_available');
  return s;
}

/** FR-CAC-93: 계정 하나의 statusLine 줄. 값(`statusLine`, 서버가 셈한 창)이 없으면 null 이다. */
function claudeAcctStatusLine(key,name,color,sl){
  const w=sl&&sl.windows;
  if(!w) return null;
  const cells=[claudeAcctCell('five_hour',w.fiveHour),claudeAcctCell('seven_day',w.sevenDay)];
  if(!cells.some(Boolean)) return null;
  return {
    key,label:t('usage.sl.label'),name,color,cells,
    asOf:sl.stale?t('cacct.age_min',{n:Math.max(1,Math.floor((sl.ageSeconds||0)/60))}):'',
  };
}

/**
 * FR-CAC-78·93: 등록되지 않은 계정의 statusLine 줄들.
 *
 *   이전 동작: 등록 계정(계정 순서)의 줄을 먼저 그렸다 (D-CAC-22)
 *   새  동작: 등록되지 않은 계정의 줄만 낸다 (MOBILE_UX_OVERHAUL_SRS FR-MUX-81)
 *   이유:     등록 계정의 묶음 막대가 이미 OAuth 값과 statusLine 값 중 큰 값이다 (D-CAC-35) —
 *             같은 계정의 사용량이 두 번 보였다
 */
function claudeAcctStatusLines(others){
  const out=[];
  for(const o of Array.isArray(others)?others:[]){
    const l=claudeAcctStatusLine('other:'+o.name,o.name,'',o);
    if(l) out.push(l);
  }
  return out;
}

/** FR-CAC-90·91: 계정 순서대로의 묶음들. 기억한 모양이 없는 계정은 활성이면 넓다. */
function claudeAcctFootViews(accounts,fold,popId){
  return (Array.isArray(accounts)?accounts:[]).map(a=>
    claudeAcctView(a,a.id===popId,typeof fold[a.id]==='boolean'?fold[a.id]:!!a.active));
}
