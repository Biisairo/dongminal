/**
 * Dongminal — Claude 다중 계정의 Activity 하단 묶음 (CLAUDE_ACCOUNTS_SRS FR-CAC-90~92 · FR-CAC-122).
 *
 * 목록은 `GET /api/claude-accounts` 다. 서버가 상태가 바뀌면 `claude_accounts_changed` 를 밀고,
 * 패널이 열린 동안에는 등록부(`state-registry.js` 의 `claude.accounts`)가 주기로 다시 받는다.
 * 사용률의 등급과 남은 시간은 서버가 셈한 값만 쓴다 (D-ASV-10).
 *
 * 로드 순서 계약: `app.js` 뒤, `app-activity.js` 뒤 (`limitBarView`·`actEl` 을 부른다).
 */

/** FR-CAC-122: 패널이 열린 동안 다시 받는 주기. 서버의 조회 주기(최소 180초)보다 짧아 변화를 놓치지 않는다. */
const CLAUDE_ACCT_POLL_MS=30*1000;
/** FR-CAC-98: 서버가 주는 색 키. 밖의 값은 첫 색으로 그린다. */
const CLAUDE_ACCT_COLOR_RE=/^acct-[1-8]$/;
const CLAUDE_ACCT_COLOR_DEFAULT='acct-1';

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

function claudeAcctBar(id,label,w){
  return limitBarView(id,label,w.pct,w.resetsAt,w.resetsInSec,w.level);
}

/**
 * FR-CAC-91: 계정 묶음 하나의 값. 접힌 모양은 머리 + 5시간·주간 막대이고, `open` 이면 `more` 에
 * scoped 창·예측·추가 사용량·로그인 만료·동작이 든다.
 */
function claudeAcctView(a,open){
  const u=a.usage||{};
  const w=u.windows||{};
  let status='';
  if(u.status&&u.status!=='ok'){
    status=t('cacct.st.'+u.status);
    if(u.backoffUntil>0) status+=' · '+t('cacct.retry_at',{t:limitClock(u.backoffUntil*1000)});
  }
  const bars=[];
  if(w.fiveHour) bars.push(claudeAcctBar(a.id+':five_hour',limitWindowLabel('five_hour'),w.fiveHour));
  if(w.sevenDay) bars.push(claudeAcctBar(a.id+':seven_day',limitWindowLabel('seven_day'),w.sevenDay));
  let more=null;
  if(open){
    const sp=w.spend;
    more={
      scoped:(Array.isArray(w.scoped)?w.scoped:[]).map(s=>claudeAcctBar(a.id+':scoped:'+s.name,s.name,s)),
      pace:claudeAcctPace(u.pace&&u.pace.sevenDay),
      spend:sp?t('cacct.spend',{used:claudeAcctMoney(sp.used,sp.currency),limit:claudeAcctMoney(sp.limit,sp.currency)}):'',
      login:u.loginExpiresAt>0?{text:t('cacct.login_expires',{d:claudeAcctDate(u.loginExpiresAt*1000)}),warn:!!u.loginExpiringSoon}:null,
      canSwitch:!a.active,
    };
  }
  return {
    id:a.id,
    name:a.alias||a.email,
    title:[a.email,a.organizationName].filter(Boolean).join(' · '),
    color:CLAUDE_ACCT_COLOR_RE.test(a.color)?a.color:CLAUDE_ACCT_COLOR_DEFAULT,
    active:!!a.active,
    status,
    age:u.stale?t('cacct.age_min',{n:Math.max(1,Math.floor((u.ageSeconds||0)/60))}):'',
    open:!!open,
    bars,
    more,
  };
}

/** FR-CAC-90: 계정 순서대로의 묶음들. */
function claudeAcctFootViews(accounts,openSet){
  return (Array.isArray(accounts)?accounts:[]).map(a=>claudeAcctView(a,openSet.has(a.id)));
}

Object.assign(App.prototype, {
  _claudeAcctRestore(src){
    const flight=this._restoreBegin('claudeAccounts');
    return stateFetch(src,'/api/claude-accounts').then(r=>{
      if(!this._restoreLive('claudeAccounts',flight)) return;
      // 503 은 계정 기능이 없는 서버다(데이터 폴더 없음). 망 실패는 마지막 값을 지우지 않는다.
      if(r.ok&&r.data) this._claudeAccts=Array.isArray(r.data.accounts)?r.data.accounts:[];
      else if(r.status===503) this._claudeAccts=[];
      this._restoreEnd('claudeAccounts',flight);
      this.agentsRender();
    });
  },

  _onClaudeAccountsChanged(){ return this._claudeAcctRestore() },

  /** FR-CAC-91: 펼친 계정의 id. 기기의 취향이므로 local 에 둔다. */
  _claudeAcctOpen(){ return new Set(PrefStore.local.json(STORE_KEYS.claudeAcctOpen,[])) },

  _claudeAcctToggle(id){
    const s=this._claudeAcctOpen();
    if(s.has(id)) s.delete(id); else s.add(id);
    PrefStore.local.setJson(STORE_KEYS.claudeAcctOpen,Array.from(s));
    this.agentsRender();
  },

  /** 동작 하나. 실패는 알리고, 성공하면 목록을 다시 받는다 (방송도 오지만 이 탭이 먼저 본다). */
  async _claudeAcctAct(path,body,what){
    const r=await apiPost(path,body);
    if(!r.ok){ Toast.show(apiErrText(r,what),'err'); return r }
    await this._claudeAcctRestore();
    return r;
  },

  _claudeAcctSwitch(id){ return this._claudeAcctAct('/api/claude-accounts/switch',{id},t('cacct.switch')) },
  /** FR-CAC-92: 스마트 전환. 지금은 `next` 하나다 — `next-available`·`best` 는 사용량 판단과 함께 4단계에 선다. */
  _claudeAcctNext(){ return this._claudeAcctAct('/api/claude-accounts/switch',{strategy:'next'},t('cacct.next')) },
  /** FR-CAC-58: 1분 안에 조회했거나 물러나는 중이면 서버가 409 로 다음 가능 시각을 알린다. */
  _claudeAcctRefresh(id){ return this._claudeAcctAct('/api/claude-accounts/refresh',{id},t('cacct.refresh')) },

  /** FR-CAC-91: 계정 묶음 — 머리(색 점·이름·활성·상태·n분 전) / 막대 / 펼치면 나머지. 머리를 누르면 접고 편다. */
  _claudeAcctEl(v){
    const box=document.createElement('div');
    box.className='cacct'+(v.active?' active':'')+(v.open?' open':'');
    box.dataset.id=v.id;
    const head=actEl(box,'div','cacct-head');
    head.title=v.title;
    actEl(head,'span','cacct-dot').style.background='var(--'+v.color+')';
    actEl(head,'span','cacct-name',v.name);
    if(v.active) actEl(head,'span','cacct-active',t('cacct.active'));
    if(v.status) actEl(head,'span','cacct-st',v.status);
    if(v.age) actEl(head,'span','cacct-age',v.age);
    head.addEventListener('click',()=>this._claudeAcctToggle(v.id));
    for(const b of v.bars) this._actUsageWinEl(box,b);
    const m=v.more;
    if(!m) return box;
    const more=actEl(box,'div','cacct-more');
    for(const b of m.scoped) this._actUsageWinEl(more,b);
    if(m.pace) actEl(more,'div','cacct-pace'+(m.pace.warn?' warn':''),m.pace.text);
    if(m.spend) actEl(more,'div','cacct-spend',m.spend);
    if(m.login) actEl(more,'div','cacct-login'+(m.login.warn?' warn':''),m.login.text);
    const acts=actEl(more,'div','cacct-acts');
    if(m.canSwitch) acts.appendChild(UIKit.button({label:t('cacct.switch'),size:'sm',cls:'cacct-switch',
      onClick:e=>{e.stopPropagation();this._claudeAcctSwitch(v.id)}}));
    acts.appendChild(UIKit.button({label:t('cacct.refresh'),kind:'ghost',size:'sm',cls:'cacct-refresh',
      onClick:e=>{e.stopPropagation();this._claudeAcctRefresh(v.id)}}));
    return box;
  },
});
