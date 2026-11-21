/**
 * Dongminal — Claude 다중 계정의 Activity 하단 묶음 (CLAUDE_ACCOUNTS_SRS FR-CAC-90~92 · FR-CAC-122).
 *
 * 목록은 `GET /api/claude-accounts` 다. 서버가 상태가 바뀌면 `claude_accounts_changed` 를 밀고,
 * 패널이 열린 동안에는 등록부(`state-registry.js` 의 `claude.accounts`)가 주기로 다시 받는다.
 * 사용률의 등급과 남은 시간은 서버가 셈한 값만 쓴다 (D-ASV-10).
 *
 * `ClaudeAccountsController` 가 목록 읽기·하단 묶음·팝오버·전환을 진다. App 은 이것을 `claude` 로 든다
 * (REFACTOR3_FE_APPCTL_SRS 9b). 부품 `ClaudeMaps`(`claude-maps.js`) `.maps` 가 탭 틴트·칩·계정 메뉴를 진다. 목록
 * `_claudeAccts` 와 시험·활동 패널이 읽는 펼침·팝오버 필드는 App 에 남는다. 화면 값의 순수 함수는
 * `claude-accounts-view.js` 다.
 *
 * 로드 순서 계약: `app.js` 뒤, `claude-accounts-view.js` 뒤.
 */

class ClaudeAccountsController extends Controller {
  constructor(app){
    super(app);
    this.maps=new ClaudeMaps(app);
  }

  _claudeAcctRestore(src){
    const flight=this.app._restoreBegin('claudeAccounts');
    return stateFetch(src,'/api/claude-accounts').then(r=>{
      if(!this.app._restoreLive('claudeAccounts',flight)) return;
      // 503 은 계정 기능이 없는 서버다(데이터 폴더 없음). 망 실패는 마지막 값을 지우지 않는다.
      if(r.ok&&r.data){
        this.app._claudeAccts=Array.isArray(r.data.accounts)?r.data.accounts:[];
        this._claudeAcctActiveSeen(this.app._claudeAccts);
        this.app._claudeAcctAuto=r.data.autoswitch||null;
        this.app._claudeAcctOtherSl=Array.isArray(r.data.otherStatusLines)?r.data.otherStatusLines:[];
      }else if(r.status===503){
        this.app._claudeAccts=[];
        this.app._claudeAcctAuto=null;
        this.app._claudeAcctOtherSl=[];
      }
      this.app._restoreEnd('claudeAccounts',flight);
      this.app.agentsRender();
      // FR-CAC-95a: 매핑은 탭·Repo·Explorer 가 쓴다. 계정 기능이 없는 서버면 받지 않는다.
      if(r.status===503){ if(this.app._claudeMaps){this.app._claudeMaps=null;this.maps._claudeMapsRepaint()} }
      else if(r.ok) return this.maps._claudeMapsLoad();
    });
  }

  /** FR-CAC-94a: 설정의 Claude 계정 패널이 열려 있으면 그것도 다시 받는다. */
  _onClaudeAccountsChanged(){
    if(this.app._cacctPanelShown&&this.app._cacctPanelShown()) this.app._cacctRefreshSoft();
    return this.app._claudeAcctRestore();
  }

  /** FR-CAC-100a: 서버의 계정 알림. 자동 전환은 알림(ok), 나머지는 주의(err) 토스트다. */
  _onClaudeAccountAlert(a){
    const text=claudeAcctAlertText(a);
    if(text) Toast.show(text,a.kind==='autoswitch'?'ok':'err');
  }

  /** FR-CAC-91: 계정별로 기억한 모양(`id → 넓음`). 기기의 취향이므로 local 에 둔다. */
  _claudeAcctFold(){
    const f=PrefStore.local.json(STORE_KEYS.claudeAcctFold,{});
    return f&&typeof f==='object'&&!Array.isArray(f)?f:{};
  }

  /** FR-CAC-91: 활성 계정이 바뀌면(어떤 경로든) 이전·새 활성 계정의 기억한 모양을 지워 기본값으로 그린다. */
  _claudeAcctActiveSeen(accounts){
    const cur=(accounts.find(a=>a.active)||{}).id||'';
    const prev=this._claudeAcctActiveId;
    this._claudeAcctActiveId=cur;
    if(prev===undefined||prev===cur) return;
    const f=this.app._claudeAcctFold();
    if(!(prev in f)&&!(cur in f)) return;
    delete f[prev]; delete f[cur];
    PrefStore.local.setJson(STORE_KEYS.claudeAcctFold,f);
  }

  _claudeAcctFoldToggle(id){
    const f=this.app._claudeAcctFold();
    const a=(this.app._claudeAccts||[]).find(x=>x.id===id);
    const wide=typeof f[id]==='boolean'?f[id]:!!(a&&a.active);
    f[id]=!wide;
    PrefStore.local.setJson(STORE_KEYS.claudeAcctFold,f);
    this.app.agentsRender();
  }

  /**
   * FR-CAC-91: 요약 오버레이. 한 번에 하나이고 기억하지 않는다. 바깥 누름은 `_claudeAcctPopDismiss` 가, Esc 는
   * EscapeStack 캡처 층 항목이 닫는다(REFACTOR3_FE_ESC_SRS FR-FEE-7).
   */
  _claudeAcctPopToggle(id){
    const opening=this.app._claudeAcctPopId!==id;
    this.app._claudeAcctPopId=opening?id:null;
    if(opening&&!this._claudeAcctPopWired){
      this._claudeAcctPopWired=true;
      document.addEventListener('pointerdown',e=>this._claudeAcctPopDismiss(e),true);
    }
    if(!this._claudeAcctPopEsc) this._claudeAcctPopEsc={active:()=>!!this.app._claudeAcctPopId,close:()=>this._claudeAcctPopClose()};
    if(opening) EscapeStack.push(this._claudeAcctPopEsc); else EscapeStack.remove(this._claudeAcctPopEsc);
    this.app.agentsRender();
  }

  /** 칸 누름은 칸의 처리기(`_claudeAcctPopToggle`)가 맡는다 — 여기서 닫으면 같은 칸이 다시 연다. */
  _claudeAcctPopDismiss(e){
    if(!this.app._claudeAcctPopId) return;
    if(e.target&&e.target.closest&&e.target.closest('.cacct-pop,.cacct')) return;
    this._claudeAcctPopClose();
  }

  _claudeAcctPopClose(){
    if(this._claudeAcctPopEsc) EscapeStack.remove(this._claudeAcctPopEsc);
    this.app._claudeAcctPopId=null;
    this.app.agentsRender();
  }

  /** FR-CAC-62·63: 확인을 받은 뒤의 사용. 결과는 언제나 알리고, 목록을 다시 받는다. */
  async _claudeAcctReset(id,item){
    const body={id,program:item.program};
    if(item.grantId) body.grantId=item.grantId;
    const r=await apiPost('/api/claude-accounts/reset',body);
    if(!r.ok){ Toast.show(apiErrText(r,t('cacct.rs.use')),'err'); return r }
    const res=r.data&&r.data.result;
    Toast.show(t('cacct.rs.r.'+res),res==='reset'?'ok':'err');
    await this.app._claudeAcctRestore();
    return r;
  }

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
  }

  /** 동작 하나. 실패는 알리고, 성공하면 목록을 다시 받는다 (방송도 오지만 이 탭이 먼저 본다). */
  async _claudeAcctAct(path,body,what){
    const r=await apiPost(path,body);
    if(!r.ok){ Toast.show(apiErrText(r,what),'err'); return r }
    await this.app._claudeAcctRestore();
    return r;
  }

  /** FR-CAC-36: 떠나는 계정이 고정 실행 중이면 막지 않고 알린다 (D-CAC-28). */
  _claudeAcctPinnedToast(r){
    const s=r&&r.ok?claudeAcctPinnedNotice(r.data):'';
    if(s) Toast.show(s,'');
    return r;
  }

  async _claudeAcctSwitch(id){
    return this._claudeAcctPinnedToast(await this._claudeAcctAct('/api/claude-accounts/switch',{id},t('cacct.switch')));
  }
  /** FR-CAC-31·31a·92: 스마트 전환. `best` 가 머물면 서버가 준 이유를 알린다. */
  async _claudeAcctSmart(strategy){
    const r=await this._claudeAcctAct('/api/claude-accounts/switch',{strategy},t(claudeAcctKey('cacct.smart.',strategy)));
    if(r.ok&&r.data&&r.data.reason) Toast.show(t(claudeAcctKey('cacct.reason.',r.data.reason)),'');
    return this._claudeAcctPinnedToast(r);
  }

  /** FR-CAC-92: "전환 ▾" 의 세 항목 메뉴. */
  _claudeAcctSmartMenu(at){
    UIKit.menu(['next','next-available','best'].map(s=>({id:s,label:t(claudeAcctKey('cacct.smart.',s)),onClick:()=>this._claudeAcctSmart(s)})),
      {at,cls:'cacct-smart-menu'});
  }

  /** FR-CAC-111: 최근 50건의 전환 기록 대화상자. 설정의 "기록" 이 연다. */
  async _claudeAcctHistory(){
    const r=await apiGet('/api/claude-accounts/history?limit='+CLAUDE_ACCT_HISTORY_LIMIT);
    if(!r.ok){ Toast.show(apiErrText(r,t('cacct.hist.open')),'err'); return r }
    const rows=claudeAcctHistoryRows(r.data&&r.data.entries,this.app._claudeAccts);
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
  }
  /** FR-CAC-58: 1분 안에 조회했거나 물러나는 중이면 서버가 409 로 다음 가능 시각을 알린다. */
  _claudeAcctRefresh(id){ return this._claudeAcctAct('/api/claude-accounts/refresh',{id},t('cacct.refresh')) }

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
  }

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
    if(!v.wide) this.app._actCellsEl(head,v.mini);
    if(v.wide) for(const b of v.bars) this.app._actUsageWinEl(box,b);
    const m=v.more;
    if(!m) return box;
    const more=box.appendChild(document.createElement('div'));
    more.className='cacct-pop ui-scroll-sm';
    more.style.visibility='hidden';
    more.addEventListener('click',e=>e.stopPropagation());
    TIMERS.frame(()=>this._claudeAcctPopPlaceEl(box,more),{owner:this.app,label:'cacct-pop'});
    const ph=more.appendChild(domEl('div','cacct-pop-head'));
    const top=ph.appendChild(domEl('div','cacct-pop-top'));
    top.appendChild(domEl('span','cacct-dot')).style.background='var(--'+v.color+')';
    top.appendChild(domEl('span','cacct-pop-name',v.name));
    if(v.active) top.appendChild(domEl('span','cacct-active',t('cacct.active')));
    if(v.title&&v.title!==v.name) ph.appendChild(domEl('div','cacct-pop-title',v.title));
    if(m.status) ph.appendChild(domEl('div','cacct-pop-st',m.status));
    const usage=more.appendChild(domEl('div','cacct-pop-sec'));
    for(const b of v.bars) this.app._actUsageWinEl(usage,b);
    for(const b of m.scoped) this.app._actUsageWinEl(usage,b);
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
      onClick:e=>{e.stopPropagation();this.app._claudeAcctPopId=null;this._claudeAcctSwitch(v.id)}}));
    return box;
  }
}

// 바깥(상태 등록부·SSE·활동 패널·설정 ▸ Claude)과 계약이 App 에서 부르는 이름 (FR-FEA-4).
Controller.delegate(App,'claude',['_claudeAcctRestore','_onClaudeAccountsChanged','_onClaudeAccountAlert','_claudeAcctFold',
  '_claudeAcctSmartMenu','_claudeAcctHistory','_claudeAcctEl']);
