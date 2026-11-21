/**
 * Dongminal — 설정창 **Claude 계정** 패널의 값 → 줄·본문 (CLAUDE_ACCOUNTS_SRS FR-CAC-94·94a·34a·88b).
 *
 * DOM 을 모르는 순수 함수와 표다. 패널의 배선과 그리기는 `ClaudeSection`(`settings-claude.js`)이 한다
 * (REFACTOR3_FE_SETTINGS_SRS 8c — 400줄이던 파일을 둘로 나눴다).
 *
 * 로드 순서 계약: `activity-list.js`·`claude-accounts-view.js`·`claude-accounts-controller.js`·`claude-maps.js` 뒤.
 */

/**
 * FR-CAC-70·94a: 자동 전환의 숫자 칸. `required` 가 아니면 비울 수 있다(비우면 지운다).
 * 범위는 여기 없다 — 서버 응답의 `ranges` 가 준다(`cacctAutoRange`, REFACTOR3_FE_REST1_SRS FR-FR1-13).
 */
const CACCT_AUTO_FIELDS=[
  {key:'threshold',label:'cacct.set.auto_threshold',required:true},
  {key:'weeklyThreshold',label:'cacct.set.auto_weekly',required:false},
  {key:'intervalSeconds',label:'cacct.set.auto_interval',required:true},
  {key:'cooldownSeconds',label:'cacct.set.auto_cooldown',required:true},
  {key:'hysteresisPct',label:'cacct.set.auto_hysteresis',required:true},
  {key:'unhealthyTicks',label:'cacct.set.auto_unhealthy',required:true},
];
/** FR-CAC-70: 전략과 그 문구. */
const CACCT_STRATEGIES=[
  {id:'best',label:'cacct.set.st_best'},
  {id:'consume-first',label:'cacct.set.st_consume_first'},
  {id:'priority-consume-first',label:'cacct.set.st_priority_consume_first'},
];
const CACCT_COLORS=['acct-1','acct-2','acct-3','acct-4','acct-5','acct-6','acct-7','acct-8'];

/** FR-CAC-94a·98: 색 견본 8개 — 번호 순서의 색 이름과 고른 색. */
function cacctColorSwatches(cur){
  return CACCT_COLORS.map(c=>({color:c,name:t('cacct.color.'+c.replace('-','_')),selected:c===cur}));
}

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

/**
 * REFACTOR3_FE_REST1_SRS FR-FR1-13 (FC-11): 칸 하나의 범위 — 서버 응답(`GET·PUT /autoswitch` 의 `ranges`)의 것.
 *   이전 동작: `CACCT_AUTO_FIELDS` 의 min·max(Go `Validate` 와 두 벌)
 *   새  동작: 응답의 값. 받지 못하면 null 이고 칸에 범위를 세우지 않는다(D-FR1-9)
 *   이유:     범위의 원천은 서버다 — 범위 밖 값은 서버가 400 으로 거절한다
 */
function cacctAutoRange(ranges,key){
  const r=ranges&&ranges[key];
  return r&&typeof r.min==='number'&&typeof r.max==='number'?{min:r.min,max:r.max}:null;
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
