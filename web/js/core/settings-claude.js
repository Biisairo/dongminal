/**
 * ClaudeSection — 설정창의 **Claude 계정** 패널 (CLAUDE_ACCOUNTS_SRS FR-CAC-94·94a·34a·88b · REFACTOR3_FE_SETTINGS_SRS 8c).
 *
 * 탭을 열 때 목록·자동 전환·매핑·보관 목록·기록을 다시 받고, 열린 동안 `claude_accounts_changed` 를 받으면
 * 다시 받는다. 저장은 칸마다 한다 — 응답이 오면 다시 받아 서버 값으로 그린다. 값 → 줄·본문의 순수 함수는
 * `settings-claude-rows.js` 에 있다.
 *
 * 패널 상태(`_cacctSet`·`_cacctDirty`·`_cacctStale`·`_cacctDrag`·`_cacctFocusWired`)는 이 섹션이 든다. 설정 밖
 * (`ClaudeAccountsController`)이 부르는 `_cacctPanelShown`·`_cacctRefreshSoft` 는 App 에 위임자가 있다.
 */
class ClaudeSection extends SettingsSection {
  constructor(app){ super(app,'claude') }

  _cacctPanelShown(){
    const panel=document.getElementById('panel-claude');
    const overlay=document.getElementById('modal-overlay');
    return !!(panel&&!panel.hidden&&overlay&&overlay.classList.contains('open'));
  }

  /**
   * FR-CAC-94a: 설정창을 열 때. 탭은 닫을 때 고른 채로 남는다 — 탭 클릭만 다시 읽으면 닫은 사이
   * 다른 곳(Explorer·탭 메뉴)에서 바꾼 폴더 연결이 옛 값으로 보인다.
   */
  onOpen(){
    const tab=document.querySelector('#modal .mtab.active');
    if(tab&&tab.dataset.tab==='claude') this._loadClaudePanel();
  }

  onTab(){ return this._loadClaudePanel() }

  /** FR-CAC-94a: 입력 중인가 — 구역 안의 입력 칸에 포커스가 있거나, 다시 그린 뒤 입력한 것이 있다. */
  _cacctEditing(){
    const root=document.getElementById('cacct-set');
    if(!root) return false;
    const f=document.activeElement;
    return !!this._cacctDirty||!!(f&&root.contains(f)&&/^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName));
  }

  /** FR-CAC-94a: 변경 신호로 다시 받기. 입력 중이면 미루고, 포커스가 구역을 떠날 때 다시 본다. */
  _cacctRefreshSoft(){
    if(!this._cacctEditing()) return this._loadClaudePanel();
    this._cacctStale=true;
  }

  /** 구역 뿌리는 한 번만 세워지므로 듣개도 한 번만 단다. */
  _cacctWireEditing(root){
    if(this._cacctFocusWired===root) return;
    this._cacctFocusWired=root;
    this.listen(root,'input',()=>{this._cacctDirty=true});
    this.listen(root,'focusout',()=>TIMERS.defer(()=>{
      if(this._cacctStale&&!this._cacctEditing()&&this._cacctPanelShown()) this._loadClaudePanel();
    },{label:'cacct-stale'}));
  }

  /** FR-CAC-94a: 탭을 열 때 다섯 가지를 다시 받는다. 503 이면 계정 기능이 없는 서버다. */
  async _loadClaudePanel(){
    const [list,auto,maps,unc]=await Promise.all([
      apiGet('/api/claude-accounts'),apiGet('/api/claude-accounts/autoswitch'),apiGet('/api/claude-accounts/mappings'),
      apiGet('/api/claude-accounts/unclaimed')]);
    this._cacctSet={
      off:list.status===503,
      accounts:list.ok&&list.data&&Array.isArray(list.data.accounts)?list.data.accounts:[],
      ranges:list.ok&&list.data?list.data.ranges:null,
      auto:auto.ok&&auto.data?auto.data:null,
      folders:maps.ok&&maps.data?maps.data.folders||{}:{},
      unclaimed:unc.ok&&unc.data?unc.data.entries:[],
    };
    this._cacctPaint();
    return list;
  }

  /** 동작 하나. 실패는 알리고, 끝나면 패널을 다시 받는다 (실패해도 — 칸을 서버 값으로 되돌린다). */
  async _cacctDo(method,path,body,what){
    const r=await apiSend(method,path,body);
    if(!r.ok) Toast.show(apiErrText(r,what),'err');
    await this._loadClaudePanel();
    return r;
  }

  async _cacctAdd(){
    const r=await this._cacctDo('POST','/api/claude-accounts/add',{},t('cacct.set.add'));
    if(r.ok) Toast.show(t(r.data&&r.data.created?'cacct.set.added':'cacct.set.updated'),'ok');
    return r;
  }

  _cacctItem(id,field,v){
    const body=cacctItemPatch(id,field,v);
    if(!body){ this._cacctPaint(); return Promise.resolve(null) }
    return this._cacctDo('PUT','/api/claude-accounts/item',body,t('cacct.set.save'));
  }

  /** FR-CAC-12: 확인 대화상자에서 "삭제" 를 골라야 보낸다. */
  _cacctAsk(title,text,okLabel,run){
    const body=document.createElement('p');
    body.textContent=text;
    const m=UIKit.modal({title,cls:'cacct-set-confirm',boxCls:'ui-modal-sm',body,
      actions:[{label:t('core.cancel')},{label:okLabel,kind:'danger',onClick:run}]});
    document.body.appendChild(m.el);
  }

  _cacctAccountRow(list,r,ids){
    const row=list.appendChild(domEl('div','cacct-set-row'));
    row.dataset.id=r.id;
    row.draggable=true;
    row.addEventListener('dragstart',e=>{this._cacctDrag=r.id;e.dataTransfer.effectAllowed='move'});
    row.addEventListener('dragover',e=>{if(this._cacctDrag)e.preventDefault()});
    row.addEventListener('drop',e=>{
      e.preventDefault();
      const rect=row.getBoundingClientRect();
      const ids2=cacctReorder(ids,this._cacctDrag,r.id,e.clientY<rect.top+rect.height/2);
      this._cacctDrag=null;
      if(ids2) this._cacctDo('POST','/api/claude-accounts/order',{ids:ids2},t('cacct.set.save'));
    });
    const head=row.appendChild(domEl('div','cacct-set-head'));
    head.appendChild(domEl('span','cacct-set-grip','⠿')).title=t('cacct.set.drag');
    head.appendChild(domEl('span','cacct-dot')).style.background='var(--'+r.color+')';
    head.appendChild(domEl('span','cacct-set-name',r.name));
    head.appendChild(domEl('span','cacct-set-meta',[r.email,r.org].filter(Boolean).join(' · ')));
    if(r.status) head.appendChild(domEl('span','cacct-st',r.status));
    head.appendChild(domEl('span','cacct-set-login'+(r.login.warn?' warn':''),r.login.text));
    const f=row.appendChild(domEl('div','cacct-set-fields'));
    const pick=f.appendChild(domEl('div','cacct-swatches'));
    pick.setAttribute('role','radiogroup');
    pick.setAttribute('aria-label',t('cacct.set.color'));
    let curName='';
    for(const sw of cacctColorSwatches(r.color)){
      const b=pick.appendChild(domEl('button','cacct-swatch'+(sw.selected?' on':'')));
      b.type='button';
      b.dataset.color=sw.color;
      b.title=sw.name;
      b.setAttribute('role','radio');
      b.setAttribute('aria-checked',String(sw.selected));
      b.setAttribute('aria-label',sw.name);
      b.style.background='var(--'+sw.color+')';
      if(!sw.selected) b.addEventListener('click',()=>this._cacctItem(r.id,'color',sw.color));
      if(sw.selected) curName=sw.name;
    }
    const nm=pick.appendChild(domEl('span','cacct-swatch-name',curName));
    nm.style.color='var(--'+r.color+')';
    const field=(key,label,cls,type,value,ph)=>{
      const lab=f.appendChild(domEl('label','cacct-set-field',label));
      const inp=lab.appendChild(domEl('input',cls));
      inp.type=type; inp.value=value; if(ph) inp.placeholder=ph;
      inp.addEventListener('change',()=>this._cacctItem(r.id,key,inp.value));
      return inp;
    };
    // FR-FFX-23: 범위는 계정 목록 응답의 `ranges` 가 준다.
    const rg=this._cacctSet&&this._cacctSet.ranges;
    cacctRangeApply(field('alias',t('cacct.set.alias'),'sbx-input','text',r.alias,''),rg,'alias');
    cacctRangeApply(field('threshold',t('cacct.set.threshold'),'ds-num','number',r.threshold,t('cacct.set.threshold_ph')),rg,'threshold');
    cacctRangeApply(field('priority',t('cacct.set.priority'),'ds-num','number',r.priority,''),rg,'priority');
    const dl=f.appendChild(domEl('label','sbx-flag'));
    const dis=dl.appendChild(domEl('input','ui-switch'));
    dis.type='checkbox'; dis.checked=r.disabled;
    dis.addEventListener('change',()=>this._cacctItem(r.id,'disabled',dis.checked));
    dl.appendChild(domEl('span','',t('cacct.set.disabled')));
    f.appendChild(UIKit.button({label:t('cacct.set.remove'),kind:'danger',size:'sm',cls:'cacct-set-remove',
      onClick:()=>this._cacctAsk(t('cacct.set.remove_title'),t('cacct.set.remove_body',{name:r.name}),t('cacct.set.remove'),
        ()=>this._cacctDo('POST','/api/claude-accounts/remove',{id:r.id},t('cacct.set.remove')))}));
    if(r.warnings) row.appendChild(domEl('div','cacct-set-warn',r.warnings));
  }

  _cacctAutoEl(root,a){
    root.appendChild(domEl('div','ds-sec',t('cacct.set.sec_auto')));
    if(!a) return;
    const form=cacctAutoForm(a.settings);
    root.appendChild(domEl('div','ds-hint',claudeAcctAutoView({enabled:a.settings&&a.settings.enabled,status:a.state&&a.state.status}).text));
    const box=root.appendChild(domEl('div','cacct-set-auto'));
    const en=box.appendChild(domEl('label','sbx-flag')).appendChild(domEl('input','ui-switch'));
    en.type='checkbox'; en.checked=form.enabled;
    en.parentNode.appendChild(document.createTextNode(t('cacct.set.auto_enabled')));
    const inputs={};
    for(const fd of CACCT_AUTO_FIELDS){
      const lab=box.appendChild(domEl('label','cacct-set-field',t(fd.label)));
      const inp=lab.appendChild(domEl('input','ds-num'));
      inp.type='number'; inp.value=form[fd.key];
      cacctRangeApply(inp,a.ranges,fd.key);
      inputs[fd.key]=inp;
    }
    const sl=box.appendChild(domEl('label','cacct-set-field',t('cacct.set.auto_strategy')));
    const st=sl.appendChild(domEl('select','sbs-select'));
    for(const s of CACCT_STRATEGIES){const o=st.appendChild(domEl('option','',t(s.label)));o.value=s.id;o.selected=s.id===form.strategy}
    const ml=box.appendChild(domEl('label','cacct-set-field',t('cacct.set.auto_models')));
    const models=ml.appendChild(domEl('input','sbx-input'));
    models.value=form.models; models.placeholder=t('cacct.set.auto_models_ph');
    box.appendChild(UIKit.button({label:t('cacct.set.save'),size:'sm',cls:'cacct-set-auto-save',onClick:async()=>{
      const f2={enabled:en.checked,strategy:st.value,models:models.value};
      for(const k in inputs) f2[k]=inputs[k].value;
      const {body,bad}=cacctAutoBody(a.settings,f2);
      if(bad){ Toast.show(bad,'err'); return }
      if(!Object.keys(body).length) return;
      const r=await this._cacctDo('PUT','/api/claude-accounts/autoswitch',body,t('cacct.set.sec_auto'));
      if(r.ok) Toast.show(t('cacct.set.auto_saved'),'ok');
    }}));
  }

  _cacctFoldersEl(root,s){
    root.appendChild(domEl('div','ds-sec',t('cacct.set.sec_folders')));
    const rows=cacctFolderRows(s.folders,s.accounts);
    const list=root.appendChild(domEl('div','cacct-set-folders'));
    if(!rows.length) list.appendChild(domEl('div','ds-hint',t('cacct.set.folders_none')));
    for(const r of rows){
      const row=list.appendChild(domEl('div','cacct-set-folder'));
      const name=row.appendChild(domEl('div','cacct-set-fname'));
      name.style.paddingLeft=(r.depth*16)+'px';
      name.appendChild(UIKit.icon('folder',{size:'sm'}));
      const path=name.appendChild(domEl('span','cacct-set-path',r.path));
      path.title=r.path;
      if(r.overrides) name.appendChild(domEl('span','cacct-set-over',t('cacct.set.overrides')));
      const chip=row.appendChild(domEl('span','cacct-chip',r.name));
      if(r.color) chip.style.setProperty('--cacct-c','var(--'+r.color+')');
      row.appendChild(UIKit.button({label:t('cacct.set.unlink'),kind:'ghost',size:'sm',cls:'cacct-set-unlink',
        onClick:()=>this._cacctDo('PUT','/api/claude-accounts/mappings',{folder:r.path,accountId:''},t('cacct.set.unlink'))}));
    }
    if(!s.accounts.length) return;
    const add=root.appendChild(domEl('div','set-row cacct-set-link'));
    const path=add.appendChild(domEl('input','sbx-input'));
    path.placeholder=t('cacct.set.folder_ph'); path.spellcheck=false;
    if(typeof PathSuggest==='function') new PathSuggest(path,v=>this.app._edPathCandidates(v,[]));
    const sel=add.appendChild(domEl('select','sbs-select'));
    for(const a of s.accounts){const o=sel.appendChild(domEl('option','',a.alias||a.email));o.value=a.id}
    add.appendChild(UIKit.button({label:t('cacct.set.link'),size:'sm',cls:'cacct-set-link-btn',onClick:()=>{
      const p=path.value.trim();
      if(p) this._cacctDo('PUT','/api/claude-accounts/mappings',{folder:p,accountId:sel.value},t('cacct.set.link'));
    }}));
  }

  _cacctUnclaimedEl(root,s){
    root.appendChild(domEl('div','ds-sec',t('cacct.set.sec_unclaimed')));
    root.appendChild(domEl('div','ds-hint',t('cacct.set.unclaimed_hint')));
    const rows=cacctUnclaimedRows(s.unclaimed);
    if(!rows.length) root.appendChild(domEl('div','ds-hint',t('cacct.set.unclaimed_none')));
    for(const r of rows){
      const row=root.appendChild(domEl('div','ds-row cacct-set-unclaimed'));
      row.appendChild(domEl('span','',r.text));
      row.appendChild(UIKit.button({label:t('cacct.set.remove'),kind:'ghost',size:'sm',cls:'cacct-set-unclaimed-remove',
        onClick:()=>this._cacctAsk(t('cacct.set.unclaimed_remove_title'),t('cacct.set.unclaimed_remove_body',{fp:r.fp}),t('cacct.set.remove'),
          ()=>this._cacctDo('POST','/api/claude-accounts/unclaimed/remove',{name:r.name},t('cacct.set.remove')))}));
    }
  }

  /** FR-CAC-111: 전환 기록은 단추로 대화상자를 연다. */
  _cacctHistoryEl(root){
    root.appendChild(domEl('div','ds-sec',t('cacct.set.sec_history')));
    const row=root.appendChild(domEl('div','ds-row'));
    row.appendChild(UIKit.button({label:t('cacct.hist.open'),size:'sm',cls:'cacct-history-btn',onClick:()=>this.app.claude._claudeAcctHistory()}));
  }

  _cacctPaint(){
    const root=document.getElementById('cacct-set');
    const s=this._cacctSet;
    if(!root||!s) return;
    this._cacctDirty=false;
    this._cacctStale=false;
    this._cacctWireEditing(root);
    root.replaceChildren();
    if(s.off){ root.appendChild(domEl('div','ds-hint',t('cacct.set.unavailable'))); return }
    root.appendChild(domEl('div','ds-sec',t('cacct.set.sec_accounts')));
    const add=root.appendChild(domEl('div','ds-row'));
    add.appendChild(UIKit.button({label:t('cacct.set.add'),size:'sm',cls:'cacct-set-add',onClick:()=>this._cacctAdd()}));
    root.appendChild(domEl('div','ds-hint',t('cacct.set.add_hint')));
    const rows=cacctSetRows(s.accounts);
    const list=root.appendChild(domEl('div','cacct-set-list'));
    if(!rows.length) list.appendChild(domEl('div','ds-hint',t('cacct.set.none')));
    const ids=rows.map(r=>r.id);
    for(const r of rows) this._cacctAccountRow(list,r,ids);
    this._cacctAutoEl(root,s.auto);
    this._cacctFoldersEl(root,s);
    this._cacctUnclaimedEl(root,s);
    this._cacctHistoryEl(root);
  }
}
