/**
 * Dongminal — 설정창의 **Claude 계정** 패널 (CLAUDE_ACCOUNTS_SRS FR-CAC-94·94a·34a·88b).
 *
 * 탭을 열 때 목록·자동 전환·매핑·보관 목록·기록을 다시 받고, 열린 동안 `claude_accounts_changed` 를 받으면
 * 다시 받는다. 저장은 칸마다 한다 — 응답이 오면 다시 받아 서버 값으로 그린다.
 *
 * 로드 순서 계약: `app-activity.js`·`app-claude-accounts.js`·`app-claude-accounts-map.js` 뒤.
 */

/** FR-CAC-70·94a: 자동 전환의 숫자 칸. `required` 가 아니면 비울 수 있다(비우면 지운다). */
const CACCT_AUTO_FIELDS=[
  {key:'threshold',label:'cacct.set.auto_threshold',min:50,max:100,required:true},
  {key:'weeklyThreshold',label:'cacct.set.auto_weekly',min:50,max:100,required:false},
  {key:'intervalSeconds',label:'cacct.set.auto_interval',min:15,max:3600,required:true},
  {key:'cooldownSeconds',label:'cacct.set.auto_cooldown',min:0,max:86400,required:true},
  {key:'hysteresisPct',label:'cacct.set.auto_hysteresis',min:0,max:50,required:true},
  {key:'unhealthyTicks',label:'cacct.set.auto_unhealthy',min:1,max:100,required:true},
];
/** FR-CAC-70: 전략과 그 문구. */
const CACCT_STRATEGIES=[
  {id:'best',label:'cacct.set.st_best'},
  {id:'consume-first',label:'cacct.set.st_consume_first'},
  {id:'priority-consume-first',label:'cacct.set.st_priority_consume_first'},
];
/** FR-CAC-111: 설정이 보이는 전환 기록 건수. */
const CACCT_SET_HISTORY_LIMIT=50;
const CACCT_COLORS=['acct-1','acct-2','acct-3','acct-4','acct-5','acct-6','acct-7','acct-8'];

function cacctNum(v){
  const s=String(v==null?'':v).trim();
  return /^-?\d+(\.\d+)?$/.test(s)?Number(s):null;
}

function cacctSame(a,b){ return JSON.stringify(a==null?null:a)===JSON.stringify(b==null?null:b) }

/** FR-CAC-94a: 계정 줄의 값. */
function cacctSetRows(accounts){
  return (Array.isArray(accounts)?accounts:[]).map(a=>{
    const u=a.usage||{};
    const w=Array.isArray(a.profileWarnings)?a.profileWarnings:[];
    return {
      id:a.id,name:a.alias||a.email,email:a.email,org:a.organizationName||'',
      color:claudeAcctColorOf(a),alias:a.alias||'',
      threshold:typeof a.threshold==='number'?String(a.threshold):'',
      priority:String(a.priority||0),disabled:!!a.disabled,
      login:u.loginExpiresAt>0
        ?{text:t('cacct.login_expires',{d:claudeAcctDate(u.loginExpiresAt*1000)}),warn:!!u.loginExpiringSoon}
        :{text:t('cacct.set.login_unknown'),warn:false},
      status:u.status&&u.status!=='ok'?t('cacct.st.'+u.status):'',
      warnings:w.length?t('cacct.set.warn_links',{names:w.join(', ')}):'',
    };
  });
}

/** FR-CAC-94a: 칸 하나의 `PUT /item` 본문. 보낼 수 없는 값이면 null — 화면은 서버 값으로 되돌린다. */
function cacctItemPatch(id,field,v){
  if(field==='alias') return {id,alias:String(v||'').trim()};
  if(field==='disabled') return {id,disabled:!!v};
  if(field==='color') return {id,color:String(v)};
  if(field==='threshold'){
    if(String(v||'').trim()==='') return {id,clearThreshold:true};
    const n=cacctNum(v);
    return n===null?null:{id,threshold:n};
  }
  if(field==='priority'){
    const s=String(v||'').trim();
    return /^-?\d+$/.test(s)?{id,priority:Number(s)}:null;
  }
  return null;
}

/** FR-CAC-13: 끌어 놓은 뒤의 순서. 바뀌지 않으면 null. */
function cacctReorder(ids,src,target,before){
  if(src===target||!ids.includes(src)||!ids.includes(target)) return null;
  const out=ids.filter(x=>x!==src);
  out.splice(out.indexOf(target)+(before?0:1),0,src);
  return out;
}

function cacctSegs(p){ return claudeAcctFold(p).split(pathSep(p)) }

/** 경로 조각 순 — `/r` 의 하위가 `/r-x` 보다 앞에 온다. */
function cacctPathCmp(a,b){
  const x=cacctSegs(a),y=cacctSegs(b);
  for(let i=0;i<Math.min(x.length,y.length);i++) if(x[i]!==y[i]) return x[i]<y[i]?-1:1;
  return x.length-y.length;
}

/** FR-CAC-94: 폴더 연결 트리. 다른 연결의 하위면 그 깊이만큼 들여 쓰고 덮어씀을 표시한다. */
function cacctFolderRows(folders,accounts){
  const keys=Object.keys(folders||{}).sort(cacctPathCmp);
  return keys.map(k=>{
    const depth=keys.filter(o=>o!==k&&claudeAcctUnder(claudeAcctFold(k),claudeAcctFold(o))).length;
    const a=claudeAcctById(accounts,folders[k].accountId);
    return {path:k,depth,overrides:depth>0,accountId:folders[k].accountId,
      name:a?(a.alias||a.email):t('cacct.hist.deleted'),color:a?claudeAcctColorOf(a):''};
  });
}

/** FR-CAC-94a: 자동 전환 설정 → 칸 값. */
function cacctAutoForm(s){
  const v=s||{};
  const out={enabled:!!v.enabled};
  for(const f of CACCT_AUTO_FIELDS) out[f.key]=typeof v[f.key]==='number'?String(v[f.key]):'';
  out.strategy=v.strategy||'best';
  out.models=Array.isArray(v.models)?v.models.join(', '):(v.models==='all'?'all':'');
  return out;
}

function cacctModels(v){
  const s=String(v||'').trim();
  if(!s) return null;
  if(s==='all') return 'all';
  return s.split(',').map(x=>x.trim()).filter(Boolean);
}

/** FR-CAC-94a: 칸 값 → 바뀐 키만 담은 `PUT /autoswitch` 본문. 숫자가 아닌 칸이 있으면 `bad` 문구. */
function cacctAutoBody(prev,form){
  const p=prev||{},body={};
  if(!!form.enabled!==!!p.enabled) body.enabled=!!form.enabled;
  for(const f of CACCT_AUTO_FIELDS){
    const raw=String(form[f.key]==null?'':form[f.key]).trim();
    let v=null;
    if(raw||f.required){
      v=cacctNum(raw);
      if(v===null) return {body:null,bad:t('cacct.set.auto_bad',{field:t(f.label)})};
    }
    if(!cacctSame(v,p[f.key])) body[f.key]=v;
  }
  if(form.strategy&&form.strategy!==p.strategy) body.strategy=form.strategy;
  const m=cacctModels(form.models);
  if(!cacctSame(m,p.models)) body.models=m;
  return {body,bad:''};
}

/** FR-CAC-34a: 보관 목록 줄. */
function cacctUnclaimedRows(entries){
  return (Array.isArray(entries)?entries:[]).map(e=>({name:e.name,fp:e.fingerprint,
    text:t('cacct.set.unclaimed_row',{t:claudeAcctDate(e.at*1000)+' '+limitClock(e.at*1000),fp:e.fingerprint})}));
}

Object.assign(App.prototype, {
  _cacctPanelShown(){
    const panel=document.getElementById('panel-claude');
    const overlay=document.getElementById('modal-overlay');
    return !!(panel&&!panel.hidden&&overlay&&overlay.classList.contains('open'));
  },

  /** FR-CAC-94a: 탭을 열 때 다섯 가지를 다시 받는다. 503 이면 계정 기능이 없는 서버다. */
  async _loadClaudePanel(){
    const [list,auto,maps,unc,hist]=await Promise.all([
      apiGet('/api/claude-accounts'),apiGet('/api/claude-accounts/autoswitch'),apiGet('/api/claude-accounts/mappings'),
      apiGet('/api/claude-accounts/unclaimed'),apiGet('/api/claude-accounts/history?limit='+CACCT_SET_HISTORY_LIMIT)]);
    this._cacctSet={
      off:list.status===503,
      accounts:list.ok&&list.data&&Array.isArray(list.data.accounts)?list.data.accounts:[],
      auto:auto.ok&&auto.data?auto.data:null,
      folders:maps.ok&&maps.data?maps.data.folders||{}:{},
      unclaimed:unc.ok&&unc.data?unc.data.entries:[],
      history:hist.ok&&hist.data?hist.data.entries:[],
    };
    this._cacctPaint();
    return list;
  },

  /** 동작 하나. 실패는 알리고, 끝나면 패널을 다시 받는다 (실패해도 — 칸을 서버 값으로 되돌린다). */
  async _cacctDo(method,path,body,what){
    const r=await apiSend(method,path,body);
    if(!r.ok) Toast.show(apiErrText(r,what),'err');
    await this._loadClaudePanel();
    return r;
  },

  async _cacctAdd(){
    const r=await this._cacctDo('POST','/api/claude-accounts/add',{},t('cacct.set.add'));
    if(r.ok) Toast.show(t(r.data&&r.data.created?'cacct.set.added':'cacct.set.updated'),'ok');
    return r;
  },

  _cacctItem(id,field,v){
    const body=cacctItemPatch(id,field,v);
    if(!body){ this._cacctPaint(); return Promise.resolve(null) }
    return this._cacctDo('PUT','/api/claude-accounts/item',body,t('cacct.set.save'));
  },

  /** FR-CAC-12: 확인 대화상자에서 "삭제" 를 골라야 보낸다. */
  _cacctAsk(title,text,okLabel,run){
    const body=document.createElement('p');
    body.textContent=text;
    const m=UIKit.modal({title,cls:'cacct-set-confirm',width:'min(420px,90vw)',body,
      actions:[{label:t('core.cancel')},{label:okLabel,kind:'danger',onClick:run}]});
    document.body.appendChild(m.el);
  },

  _cacctAccountRow(list,r,ids){
    const row=actEl(list,'div','cacct-set-row');
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
    const head=actEl(row,'div','cacct-set-head');
    actEl(head,'span','cacct-set-grip','⠿').title=t('cacct.set.drag');
    actEl(head,'span','cacct-dot').style.background='var(--'+r.color+')';
    actEl(head,'span','cacct-set-name',r.name);
    actEl(head,'span','cacct-set-meta',[r.email,r.org].filter(Boolean).join(' · '));
    if(r.status) actEl(head,'span','cacct-st',r.status);
    actEl(head,'span','cacct-set-login'+(r.login.warn?' warn':''),r.login.text);
    const f=actEl(row,'div','cacct-set-fields');
    const color=actEl(f,'select','sbs-select cacct-set-color');
    color.title=t('cacct.set.color');
    CACCT_COLORS.forEach((c,i)=>{const o=actEl(color,'option','',t('cacct.set.color_n',{n:i+1}));o.value=c;o.selected=c===r.color});
    color.addEventListener('change',()=>this._cacctItem(r.id,'color',color.value));
    const field=(key,label,cls,type,value,ph)=>{
      const lab=actEl(f,'label','cacct-set-field',label);
      const inp=actEl(lab,'input',cls);
      inp.type=type; inp.value=value; if(ph) inp.placeholder=ph;
      inp.addEventListener('change',()=>this._cacctItem(r.id,key,inp.value));
      return inp;
    };
    field('alias',t('cacct.set.alias'),'sbx-input','text',r.alias,'').maxLength=24;
    const th=field('threshold',t('cacct.set.threshold'),'ds-num','number',r.threshold,t('cacct.set.threshold_ph'));
    th.min='50'; th.max='100';
    const pr=field('priority',t('cacct.set.priority'),'ds-num','number',r.priority,'');
    pr.min='0'; pr.max='1000';
    const dl=actEl(f,'label','sbx-flag');
    const dis=actEl(dl,'input','ui-switch');
    dis.type='checkbox'; dis.checked=r.disabled;
    dis.addEventListener('change',()=>this._cacctItem(r.id,'disabled',dis.checked));
    actEl(dl,'span','',t('cacct.set.disabled'));
    f.appendChild(UIKit.button({label:t('cacct.set.remove'),kind:'danger',size:'sm',cls:'cacct-set-remove',
      onClick:()=>this._cacctAsk(t('cacct.set.remove_title'),t('cacct.set.remove_body',{name:r.name}),t('cacct.set.remove'),
        ()=>this._cacctDo('POST','/api/claude-accounts/remove',{id:r.id},t('cacct.set.remove')))}));
    if(r.warnings) actEl(row,'div','cacct-set-warn',r.warnings);
  },

  _cacctAutoEl(root,a){
    actEl(root,'div','ds-sec',t('cacct.set.sec_auto'));
    if(!a) return;
    const form=cacctAutoForm(a.settings);
    actEl(root,'div','ds-hint',claudeAcctAutoView({enabled:a.settings&&a.settings.enabled,status:a.state&&a.state.status}).text);
    const box=actEl(root,'div','cacct-set-auto');
    const en=actEl(actEl(box,'label','sbx-flag'),'input','ui-switch');
    en.type='checkbox'; en.checked=form.enabled;
    en.parentNode.appendChild(document.createTextNode(t('cacct.set.auto_enabled')));
    const inputs={};
    for(const fd of CACCT_AUTO_FIELDS){
      const lab=actEl(box,'label','cacct-set-field',t(fd.label));
      const inp=actEl(lab,'input','ds-num');
      inp.type='number'; inp.min=String(fd.min); inp.max=String(fd.max); inp.value=form[fd.key];
      inputs[fd.key]=inp;
    }
    const sl=actEl(box,'label','cacct-set-field',t('cacct.set.auto_strategy'));
    const st=actEl(sl,'select','sbs-select');
    for(const s of CACCT_STRATEGIES){const o=actEl(st,'option','',t(s.label));o.value=s.id;o.selected=s.id===form.strategy}
    const ml=actEl(box,'label','cacct-set-field',t('cacct.set.auto_models'));
    const models=actEl(ml,'input','sbx-input');
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
  },

  _cacctFoldersEl(root,s){
    actEl(root,'div','ds-sec',t('cacct.set.sec_folders'));
    const rows=cacctFolderRows(s.folders,s.accounts);
    const list=actEl(root,'div','cacct-set-folders');
    if(!rows.length) actEl(list,'div','ds-hint',t('cacct.set.folders_none'));
    for(const r of rows){
      const row=actEl(list,'div','cacct-set-folder');
      row.style.paddingLeft=(r.depth*16)+'px';
      actEl(row,'span','cacct-set-path',r.path);
      if(r.overrides) actEl(row,'span','cacct-set-over',t('cacct.set.overrides'));
      const chip=actEl(row,'span','cacct-chip',r.name);
      if(r.color) chip.style.setProperty('--cacct-c','var(--'+r.color+')');
      row.appendChild(UIKit.button({label:t('cacct.set.unlink'),kind:'ghost',size:'sm',cls:'cacct-set-unlink',
        onClick:()=>this._cacctDo('PUT','/api/claude-accounts/mappings',{folder:r.path,accountId:''},t('cacct.set.unlink'))}));
    }
    if(!s.accounts.length) return;
    const add=actEl(root,'div','pn-row cacct-set-link');
    const path=actEl(add,'input','sbx-input');
    path.placeholder=t('cacct.set.folder_ph'); path.spellcheck=false;
    if(typeof PathSuggest==='function') new PathSuggest(path,v=>this._edPathCandidates(v,[]));
    const sel=actEl(add,'select','sbs-select');
    for(const a of s.accounts){const o=actEl(sel,'option','',a.alias||a.email);o.value=a.id}
    add.appendChild(UIKit.button({label:t('cacct.set.link'),size:'sm',cls:'cacct-set-link-btn',onClick:()=>{
      const p=path.value.trim();
      if(p) this._cacctDo('PUT','/api/claude-accounts/mappings',{folder:p,accountId:sel.value},t('cacct.set.link'));
    }}));
  },

  _cacctUnclaimedEl(root,s){
    actEl(root,'div','ds-sec',t('cacct.set.sec_unclaimed'));
    actEl(root,'div','ds-hint',t('cacct.set.unclaimed_hint'));
    const rows=cacctUnclaimedRows(s.unclaimed);
    if(!rows.length) actEl(root,'div','ds-hint',t('cacct.set.unclaimed_none'));
    for(const r of rows){
      const row=actEl(root,'div','ds-row cacct-set-unclaimed');
      actEl(row,'span','',r.text);
      row.appendChild(UIKit.button({label:t('cacct.set.remove'),kind:'ghost',size:'sm',cls:'cacct-set-unclaimed-remove',
        onClick:()=>this._cacctAsk(t('cacct.set.unclaimed_remove_title'),t('cacct.set.unclaimed_remove_body',{fp:r.fp}),t('cacct.set.remove'),
          ()=>this._cacctDo('POST','/api/claude-accounts/unclaimed/remove',{name:r.name},t('cacct.set.remove')))}));
    }
  },

  _cacctHistoryEl(root,s){
    actEl(root,'div','ds-sec',t('cacct.set.sec_history'));
    const rows=claudeAcctHistoryRows(s.history,s.accounts);
    const box=actEl(root,'div','cacct-hist ui-scroll-sm');
    if(!rows.length) actEl(box,'p','cacct-hist-empty',t('cacct.hist.empty'));
    for(const x of rows){
      const row=actEl(box,'div','cacct-hist-row');
      actEl(row,'span','cacct-hist-time',x.time);
      actEl(row,'span','cacct-hist-move',x.from+' → '+x.to);
      actEl(row,'span','cacct-hist-meta',x.trigger+' · '+x.by);
    }
  },

  _cacctPaint(){
    const root=document.getElementById('cacct-set');
    const s=this._cacctSet;
    if(!root||!s) return;
    root.replaceChildren();
    if(s.off){ actEl(root,'div','ds-hint',t('cacct.set.unavailable')); return }
    actEl(root,'div','ds-sec',t('cacct.set.sec_accounts'));
    const add=actEl(root,'div','ds-row');
    add.appendChild(UIKit.button({label:t('cacct.set.add'),size:'sm',cls:'cacct-set-add',onClick:()=>this._cacctAdd()}));
    actEl(root,'div','ds-hint',t('cacct.set.add_hint'));
    const rows=cacctSetRows(s.accounts);
    const list=actEl(root,'div','cacct-set-list');
    if(!rows.length) actEl(list,'div','ds-hint',t('cacct.set.none'));
    const ids=rows.map(r=>r.id);
    for(const r of rows) this._cacctAccountRow(list,r,ids);
    this._cacctAutoEl(root,s.auto);
    this._cacctFoldersEl(root,s);
    this._cacctUnclaimedEl(root,s);
    this._cacctHistoryEl(root,s);
  },
});
