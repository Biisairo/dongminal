/**
 * Dongminal — Claude 다중 계정의 Activity 하단 묶음 (CLAUDE_ACCOUNTS_SRS FR-CAC-90~92 · FR-CAC-122).
 *
 * 목록은 `GET /api/claude-accounts` 다. 서버가 상태가 바뀌면 `claude_accounts_changed` 를 밀고,
 * 패널이 열린 동안에는 등록부(`state-registry.js` 의 `claude.accounts`)가 주기로 다시 받는다.
 * 사용률의 등급과 남은 시간은 서버가 셈한 값만 쓴다 (D-ASV-10).
 *
 * 로드 순서 계약: `app.js` 뒤, `app-activity.js` 뒤 (`limitBarView` 를 부른다).
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

Object.assign(App.prototype, {
  _claudeAcctRestore(src){
    const flight=this._restoreBegin('claudeAccounts');
    return stateFetch(src,'/api/claude-accounts').then(r=>{
      if(!this._restoreLive('claudeAccounts',flight)) return;
      // 503 은 계정 기능이 없는 서버다(데이터 폴더 없음). 망 실패는 마지막 값을 지우지 않는다.
      if(r.ok&&r.data){
        this._claudeAccts=Array.isArray(r.data.accounts)?r.data.accounts:[];
        this._claudeAcctActiveSeen(this._claudeAccts);
        this._claudeAcctAuto=r.data.autoswitch||null;
        this._claudeAcctOtherSl=Array.isArray(r.data.otherStatusLines)?r.data.otherStatusLines:[];
      }else if(r.status===503){
        this._claudeAccts=[];
        this._claudeAcctAuto=null;
        this._claudeAcctOtherSl=[];
      }
      this._restoreEnd('claudeAccounts',flight);
      this.agentsRender();
      // FR-CAC-95a: 매핑은 탭·Repo·Explorer 가 쓴다. 계정 기능이 없는 서버면 받지 않는다.
      if(r.status===503){ if(this._claudeMaps){this._claudeMaps=null;this._claudeMapsRepaint()} }
      else if(r.ok) return this._claudeMapsLoad();
    });
  },

  /** FR-CAC-94a: 설정의 Claude 계정 패널이 열려 있으면 그것도 다시 받는다. */
  _onClaudeAccountsChanged(){
    if(this._cacctPanelShown&&this._cacctPanelShown()) this._cacctRefreshSoft();
    return this._claudeAcctRestore();
  },

  /** FR-CAC-100a: 서버의 계정 알림. 자동 전환은 알림(ok), 나머지는 주의(err) 토스트다. */
  _onClaudeAccountAlert(a){
    const text=claudeAcctAlertText(a);
    if(text) Toast.show(text,a.kind==='autoswitch'?'ok':'err');
  },

  /** FR-CAC-91: 계정별로 기억한 모양(`id → 넓음`). 기기의 취향이므로 local 에 둔다. */
  _claudeAcctFold(){
    const f=PrefStore.local.json(STORE_KEYS.claudeAcctFold,{});
    return f&&typeof f==='object'&&!Array.isArray(f)?f:{};
  },

  /** FR-CAC-91: 활성 계정이 바뀌면(어떤 경로든) 이전·새 활성 계정의 기억한 모양을 지워 기본값으로 그린다. */
  _claudeAcctActiveSeen(accounts){
    const cur=(accounts.find(a=>a.active)||{}).id||'';
    const prev=this._claudeAcctActiveId;
    this._claudeAcctActiveId=cur;
    if(prev===undefined||prev===cur) return;
    const f=this._claudeAcctFold();
    if(!(prev in f)&&!(cur in f)) return;
    delete f[prev]; delete f[cur];
    PrefStore.local.setJson(STORE_KEYS.claudeAcctFold,f);
  },

  _claudeAcctFoldToggle(id){
    const f=this._claudeAcctFold();
    const a=(this._claudeAccts||[]).find(x=>x.id===id);
    const wide=typeof f[id]==='boolean'?f[id]:!!(a&&a.active);
    f[id]=!wide;
    PrefStore.local.setJson(STORE_KEYS.claudeAcctFold,f);
    this.agentsRender();
  },

  /**
   * FR-CAC-91: 요약 오버레이. 한 번에 하나이고 기억하지 않는다. 바깥 누름은 `_claudeAcctPopDismiss` 가, Esc 는
   * EscapeStack 캡처 층 항목이 닫는다(REFACTOR3_FE_ESC_SRS FR-FEE-7).
   */
  _claudeAcctPopToggle(id){
    const opening=this._claudeAcctPopId!==id;
    this._claudeAcctPopId=opening?id:null;
    if(opening&&!this._claudeAcctPopWired){
      this._claudeAcctPopWired=true;
      document.addEventListener('pointerdown',e=>this._claudeAcctPopDismiss(e),true);
    }
    if(!this._claudeAcctPopEsc) this._claudeAcctPopEsc={active:()=>!!this._claudeAcctPopId,close:()=>this._claudeAcctPopClose()};
    if(opening) EscapeStack.push(this._claudeAcctPopEsc); else EscapeStack.remove(this._claudeAcctPopEsc);
    this.agentsRender();
  },

  /** 칸 누름은 칸의 처리기(`_claudeAcctPopToggle`)가 맡는다 — 여기서 닫으면 같은 칸이 다시 연다. */
  _claudeAcctPopDismiss(e){
    if(!this._claudeAcctPopId) return;
    if(e.target&&e.target.closest&&e.target.closest('.cacct-pop,.cacct')) return;
    this._claudeAcctPopClose();
  },

  _claudeAcctPopClose(){
    if(this._claudeAcctPopEsc) EscapeStack.remove(this._claudeAcctPopEsc);
    this._claudeAcctPopId=null;
    this.agentsRender();
  },

  /** FR-CAC-62·63: 확인을 받은 뒤의 사용. 결과는 언제나 알리고, 목록을 다시 받는다. */
  async _claudeAcctReset(id,item){
    const body={id,program:item.program};
    if(item.grantId) body.grantId=item.grantId;
    const r=await apiPost('/api/claude-accounts/reset',body);
    if(!r.ok){ Toast.show(apiErrText(r,t('cacct.rs.use')),'err'); return r }
    const res=r.data&&r.data.result;
    Toast.show(t('cacct.rs.r.'+res),res==='reset'?'ok':'err');
    await this._claudeAcctRestore();
    return r;
  },

  /** FR-CAC-62: 확인 대화상자. "사용" 을 골라야만 보낸다 — 한정된 자원을 되돌릴 수 없게 쓴다 (D-CAC-4). */
  _claudeAcctResetAsk(v,item){
    const body=document.createElement('div');
    for(const line of [v.name+' — '+item.name,item.confirm.clears,item.confirm.left,item.confirm.ends,item.confirm.weekly,t('cacct.rs.irreversible')]){
      if(!line) continue;
      const p=document.createElement('p');
      p.textContent=line;
      body.appendChild(p);
    }
    const m=UIKit.modal({
      title:t('cacct.rs.confirm_title'),
      cls:'cacct-reset-confirm',
      width:'min(420px,90vw)',
      body,
      actions:[
        {label:t('core.cancel')},
        {label:t('cacct.rs.confirm_use'),kind:'primary',onClick:()=>this._claudeAcctReset(v.id,item)},
      ],
    });
    document.body.appendChild(m.el);
  },

  /** 동작 하나. 실패는 알리고, 성공하면 목록을 다시 받는다 (방송도 오지만 이 탭이 먼저 본다). */
  async _claudeAcctAct(path,body,what){
    const r=await apiPost(path,body);
    if(!r.ok){ Toast.show(apiErrText(r,what),'err'); return r }
    await this._claudeAcctRestore();
    return r;
  },

  /** FR-CAC-36: 떠나는 계정이 고정 실행 중이면 막지 않고 알린다 (D-CAC-28). */
  _claudeAcctPinnedToast(r){
    const s=r&&r.ok?claudeAcctPinnedNotice(r.data):'';
    if(s) Toast.show(s,'');
    return r;
  },

  async _claudeAcctSwitch(id){
    return this._claudeAcctPinnedToast(await this._claudeAcctAct('/api/claude-accounts/switch',{id},t('cacct.switch')));
  },
  /** FR-CAC-31·31a·92: 스마트 전환. `best` 가 머물면 서버가 준 이유를 알린다. */
  async _claudeAcctSmart(strategy){
    const r=await this._claudeAcctAct('/api/claude-accounts/switch',{strategy},t(claudeAcctKey('cacct.smart.',strategy)));
    if(r.ok&&r.data&&r.data.reason) Toast.show(t(claudeAcctKey('cacct.reason.',r.data.reason)),'');
    return this._claudeAcctPinnedToast(r);
  },

  /** FR-CAC-92: "전환 ▾" 의 세 항목 메뉴. */
  _claudeAcctSmartMenu(at){
    UIKit.menu(['next','next-available','best'].map(s=>({id:s,label:t(claudeAcctKey('cacct.smart.',s)),onClick:()=>this._claudeAcctSmart(s)})),
      {at,cls:'cacct-smart-menu'});
  },

  /** FR-CAC-111: 최근 50건의 전환 기록 대화상자. 설정의 "기록" 이 연다. */
  async _claudeAcctHistory(){
    const r=await apiGet('/api/claude-accounts/history?limit='+CLAUDE_ACCT_HISTORY_LIMIT);
    if(!r.ok){ Toast.show(apiErrText(r,t('cacct.hist.open')),'err'); return r }
    const rows=claudeAcctHistoryRows(r.data&&r.data.entries,this._claudeAccts);
    const body=document.createElement('div');
    body.className='cacct-hist ui-scroll-sm';
    if(!rows.length) body.appendChild(domEl('p','cacct-hist-empty',t('cacct.hist.empty')));
    for(const x of rows){
      const row=body.appendChild(domEl('div','cacct-hist-row'));
      row.appendChild(domEl('span','cacct-hist-time',x.time));
      row.appendChild(domEl('span','cacct-hist-move',x.from+' → '+x.to));
      row.appendChild(domEl('span','cacct-hist-meta',x.trigger+' · '+x.by));
    }
    const m=UIKit.modal({title:t('cacct.hist.title'),cls:'cacct-history',width:'min(520px,92vw)',body,actions:[{label:t('core.close')}]});
    document.body.appendChild(m.el);
    return r;
  },
  /** FR-CAC-58: 1분 안에 조회했거나 물러나는 중이면 서버가 409 로 다음 가능 시각을 알린다. */
  _claudeAcctRefresh(id){ return this._claudeAcctAct('/api/claude-accounts/refresh',{id},t('cacct.refresh')) },

  /** FR-CAC-91: 오버레이를 패널 옆에 놓는다. 그린 뒤 한 프레임 뒤에 잰다 — 붙기 전에는 크기가 없다. */
  _claudeAcctPopPlaceEl(box,pop){
    if(!box.isConnected) return;
    const panel=box.closest('#agents-panel')||box;
    const p=claudeAcctPopPlace(box.getBoundingClientRect(),panel.getBoundingClientRect(),
      pop.offsetWidth,pop.offsetHeight,window.innerWidth,window.innerHeight);
    pop.style.left=p.left+'px';
    pop.style.top=p.top+'px';
    pop.style.width=p.width+'px';
    pop.dataset.side=p.side;
    pop.style.visibility='';
  },

  /** FR-CAC-91: 계정 묶음 — 색 바(모양 바꾸기) / 머리(색 점·이름·활성·상태·n분 전) / 넓으면 막대, 좁으면 머리에 작은 막대 / 오버레이. 색 바 밖을 누르면 오버레이. */
  _claudeAcctEl(v){
    const box=document.createElement('div');
    box.className='cacct'+(v.active?' active':'')+(v.wide?' wide':'')+(v.pop?' pop':'');
    box.dataset.id=v.id;
    const bar=box.appendChild(domEl('div','cacct-bar'));
    bar.style.background='var(--'+v.color+')';
    bar.addEventListener('click',e=>{e.stopPropagation();this._claudeAcctFoldToggle(v.id)});
    box.addEventListener('click',()=>this._claudeAcctPopToggle(v.id));
    const head=box.appendChild(domEl('div','cacct-head'));
    head.title=v.title;
    const who=head.appendChild(domEl('span','cacct-who'));
    who.appendChild(domEl('span','cacct-dot')).style.background='var(--'+v.color+')';
    who.appendChild(domEl('span','cacct-name',v.name));
    if(v.active) who.appendChild(domEl('span','cacct-active',t('cacct.active')));
    if(v.status) who.appendChild(domEl('span','cacct-st',v.status)).title=v.status;
    if(v.age) who.appendChild(domEl('span','cacct-age',v.age));
    if(!v.wide) this._actCellsEl(head,v.mini);
    if(v.wide) for(const b of v.bars) this._actUsageWinEl(box,b);
    const m=v.more;
    if(!m) return box;
    const more=box.appendChild(document.createElement('div'));
    more.className='cacct-pop ui-scroll-sm';
    more.style.visibility='hidden';
    more.addEventListener('click',e=>e.stopPropagation());
    TIMERS.frame(()=>this._claudeAcctPopPlaceEl(box,more),{owner:this,label:'cacct-pop'});
    const ph=more.appendChild(domEl('div','cacct-pop-head'));
    const top=ph.appendChild(domEl('div','cacct-pop-top'));
    top.appendChild(domEl('span','cacct-dot')).style.background='var(--'+v.color+')';
    top.appendChild(domEl('span','cacct-pop-name',v.name));
    if(v.active) top.appendChild(domEl('span','cacct-active',t('cacct.active')));
    if(v.title&&v.title!==v.name) ph.appendChild(domEl('div','cacct-pop-title',v.title));
    if(m.status) ph.appendChild(domEl('div','cacct-pop-st',m.status));
    const usage=more.appendChild(domEl('div','cacct-pop-sec'));
    for(const b of v.bars) this._actUsageWinEl(usage,b);
    for(const b of m.scoped) this._actUsageWinEl(usage,b);
    if(m.pace) usage.appendChild(domEl('div','cacct-pace'+(m.pace.warn?' warn':''),m.pace.text));
    if(m.spend||m.login){
      const info=more.appendChild(domEl('div','cacct-pop-sec'));
      if(m.spend) info.appendChild(domEl('div','cacct-spend',m.spend));
      if(m.login) info.appendChild(domEl('div','cacct-login'+(m.login.warn?' warn':''),m.login.text));
    }
    if(m.resets.length||m.resetsUnknown){
      const sec=more.appendChild(domEl('div','cacct-pop-sec cacct-resets'));
      const rh=sec.appendChild(domEl('div','cacct-resets-h',t('cacct.rs.title')));
      if(m.resetsAge) rh.appendChild(domEl('span','cacct-resets-age',m.resetsAge));
      if(m.resetsUnknown) sec.appendChild(domEl('div','cacct-resets-unknown',t('cacct.rs.unknown')));
      for(const it of m.resets){
        const row=sec.appendChild(domEl('div','cacct-rs'));
        const txt=row.appendChild(domEl('div','cacct-rs-txt'));
        txt.appendChild(domEl('span','cacct-rs-name',it.name));
        if(it.detail) txt.appendChild(domEl('span','cacct-rs-detail',it.detail));
        if(it.usable) row.appendChild(UIKit.button({label:t('cacct.rs.use'),size:'sm',cls:'cacct-rs-use',
          onClick:e=>{e.stopPropagation();this._claudeAcctResetAsk(v,it)}}));
      }
    }
    const acts=more.appendChild(domEl('div','cacct-acts'));
    acts.appendChild(UIKit.button({label:t('cacct.refresh'),kind:'ghost',size:'sm',cls:'cacct-refresh',
      onClick:e=>{e.stopPropagation();this._claudeAcctRefresh(v.id)}}));
    if(m.canSwitch) acts.appendChild(UIKit.button({label:t('cacct.switch'),kind:'primary',size:'sm',cls:'cacct-switch',
      onClick:e=>{e.stopPropagation();this._claudeAcctPopId=null;this._claudeAcctSwitch(v.id)}}));
    return box;
  },
});
