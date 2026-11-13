/**
 * Dongminal — Claude 계정의 탭 틴트·Repo 칩·Explorer 칩과 계정 메뉴 (CLAUDE_ACCOUNTS_SRS FR-CAC-95~97·95a·85·36).
 *
 * 해석(FR-CAC-81)은 `GET /mappings` 와 계정 목록으로 화면이 셈한다. 경로는 서버가 정규화한 값으로 견준다 (D-CAC-30).
 *
 * 로드 순서 계약: `path.js`·`app-claude-accounts.js` 뒤 (`pathSep`·`pathJoin`·`CLAUDE_ACCT_COLOR_RE` 를 쓴다).
 */

/** FR-CAC-95 · D-CAC-9: 탭 지정은 진하게, 폴더 연결은 옅게. */
const CLAUDE_ACCT_TINT_TAB=0.28;
const CLAUDE_ACCT_TINT_FOLDER=0.14;

/** FR-CAC-80·95a: 구분자가 `\` 이면(Windows) 대소문자를 가리지 않는다. */
function claudeAcctFold(p){ return pathSep(p)==='\\'?p.toLowerCase():p }

function claudeAcctUnder(p,k){
  if(p===k) return true;
  const sep=pathSep(k);
  return p.startsWith(k.endsWith(sep)?k:k+sep);
}

function claudeAcctById(accounts,id){
  return (Array.isArray(accounts)?accounts:[]).find(a=>a.id===id)||null;
}

/** FR-CAC-81: ① 탭 지정 ② 같거나 가장 가까운 상위 폴더 연결 ③ 없음. 지워진 계정은 없는 것으로 본다. */
function claudeAcctResolve(maps,accounts,toolId,norm){
  const tabs=(maps&&maps.tabs)||{},folders=(maps&&maps.folders)||{};
  const tm=toolId?tabs[toolId]:null;
  const ta=tm?claudeAcctById(accounts,tm.accountId):null;
  if(ta) return {account:ta,source:'tab'};
  if(norm){
    const p=claudeAcctFold(norm);
    let best='',acc=null;
    for(const k of Object.keys(folders)){
      const a=claudeAcctById(accounts,folders[k].accountId);
      if(a&&claudeAcctUnder(p,claudeAcctFold(k))&&(!acc||k.length>best.length)){best=k;acc=a}
    }
    if(acc) return {account:acc,source:'folder',folder:best};
  }
  return {account:null,source:'none'};
}

/** FR-CAC-97: 그 폴더에 **직접** 걸린 연결의 계정. */
function claudeAcctDirect(maps,accounts,norm){
  if(!norm) return null;
  const folders=(maps&&maps.folders)||{};
  const p=claudeAcctFold(norm);
  for(const k of Object.keys(folders)) if(claudeAcctFold(k)===p) return claudeAcctById(accounts,folders[k].accountId);
  return null;
}

function claudeAcctColorOf(a){ return CLAUDE_ACCT_COLOR_RE.test(a.color)?a.color:CLAUDE_ACCT_COLOR_DEFAULT }

/** FR-CAC-95: 틴트의 값. 적용되는 계정이 없으면(전역 활성 계정) null 이다. */
function claudeAcctTabTint(res){
  if(!res||!res.account) return null;
  const tab=res.source==='tab';
  return {
    color:claudeAcctColorOf(res.account),
    alpha:tab?CLAUDE_ACCT_TINT_TAB:CLAUDE_ACCT_TINT_FOLDER,
    source:res.source,
    title:t('cacct.map.tab_title',{name:res.account.alias||res.account.email,
      where:tab?t('cacct.map.src_tab'):t('cacct.map.src_folder',{p:res.folder})}),
  };
}

function claudeAcctTintCss(v){
  return v?'color-mix(in srgb, var(--'+v.color+') '+Math.round(v.alpha*100)+'%, transparent)':'';
}

/** FR-CAC-96·95a: 칩 — 별칭, 없으면 이메일의 `@` 앞. */
function claudeAcctChip(a){
  if(!a) return null;
  return {text:a.alias||String(a.email||'').split('@')[0],color:claudeAcctColorOf(a),
    title:t('cacct.map.chip_title',{name:a.alias||a.email})};
}

/** FR-CAC-96: 저장소 루트에 적용되는 폴더 연결만. */
function claudeAcctRepoChip(maps,accounts,norm){
  const r=claudeAcctResolve(maps,accounts,'',norm);
  return r.source==='folder'?claudeAcctChip(r.account):null;
}

function claudeAcctFolderChip(maps,accounts,norm){ return claudeAcctChip(claudeAcctDirect(maps,accounts,norm)) }

/** FR-CAC-95a: Explorer 행의 정규화 경로 = 루트의 정규화 경로 + 상대 경로. 루트 밖이거나 모르면 ''. */
function claudeAcctNormUnder(root,normRoot,path){
  if(!normRoot) return '';
  if(path===root) return normRoot;
  const sep=pathSep(root);
  const pre=root.endsWith(sep)?root:root+sep;
  return path.startsWith(pre)?pathJoin(normRoot,path.slice(pre.length)):'';
}

/** FR-CAC-85·95a: 탭 메뉴 "Claude 계정…" 을 누를 수 없는 사유. 누를 수 있으면 ''. */
function claudeAcctTabMenuWhy(tab,accounts){
  if(!tab||tab.type!=='terminal'||!tab.toolId) return t('cacct.map.tab_only_terminal');
  if(!Array.isArray(accounts)||!accounts.length) return t('cacct.map.no_accounts');
  return '';
}

/** FR-CAC-95a · D-CAC-31: 계정 고르기 메뉴. 탭이면 해제와 안내가 붙는다. */
function claudeAcctPickItems(accounts,cur,kind){
  const items=(Array.isArray(accounts)?accounts:[]).map(a=>({id:'acct:'+a.id,accountId:a.id,label:a.alias||a.email,cur:a.id===cur}));
  if(kind!=='tab') return items;
  if(cur) items.push({sep:true},{id:'clear',accountId:'',label:t('cacct.map.tab_clear')});
  items.push({sep:true},{label:t('cacct.map.tab_note'),static:true});
  return items;
}

/** FR-CAC-97·95a: "연결 해제" 를 누를 수 없는 사유. */
function claudeAcctUnlinkWhy(maps,accounts,norm){
  return claudeAcctDirect(maps,accounts,norm)?'':t('cacct.map.folder_none');
}

/** FR-CAC-36: 전환 응답의 `pinnedRunning` 안내. */
function claudeAcctPinnedNotice(d){ return d&&d.pinnedRunning?t('cacct.pinned_running'):'' }

Object.assign(App.prototype, {
  /** FR-CAC-95a: 매핑을 다시 받는다. 503 은 계정 기능이 없는 서버다 — 화면에 아무것도 붙이지 않는다. */
  async _claudeMapsLoad(){
    const r=await apiGet('/api/claude-accounts/mappings');
    if(r.ok&&r.data) this._claudeMaps=r.data;
    else if(r.status===503) this._claudeMaps=null;
    this._claudeMapsRepaint();
  },

  /** 탭·사이드바(render)와 열린 Explorer 를 다시 칠한다. 둘 다 서명으로 걸러 바뀐 것만 고친다. */
  _claudeMapsRepaint(){
    if(this.render) this.render();
    if(this.edStores) for(const st of this.edStores.values()) st.paintAll();
  },

  _claudeRepaintSoon(){
    if(this._claudeRepaintArmed) return;
    this._claudeRepaintArmed=true;
    TIMERS.defer(()=>{this._claudeRepaintArmed=false;this._claudeMapsRepaint()},{label:'cacct-repaint'});
  },

  /** 폴더 연결이 하나라도 있는가. 없으면 경로를 정규화할 까닭이 없다. */
  _claudeHasFolders(){
    const f=this._claudeMaps&&this._claudeMaps.folders;
    return !!f&&Object.keys(f).length>0;
  },

  /**
   * FR-CAC-95a · D-CAC-30: 서버가 정규화한 경로. 처음 보는 경로는 '' 를 돌려주고 한 번만 묻는다 —
   * 답이 오면 다시 칠한다. 실패한 경로는 다시 묻지 않는다.
   */
  _claudeNorm(p){
    if(!p||!this._claudeHasFolders()) return '';
    if(!this._claudeNormMap) this._claudeNormMap=new Map();
    const m=this._claudeNormMap;
    if(m.has(p)) return m.get(p)||'';
    m.set(p,'');
    apiGet('/api/claude-accounts/resolve',{query:{cwd:p}}).then(r=>{
      if(r.ok&&r.data&&r.data.path){m.set(p,r.data.path);this._claudeRepaintSoon()}
    });
    return '';
  },

  /** FR-CAC-95a: 탭의 cwd — 터미널의 cwd 보고값, 없으면 도구마다 한 번 `/api/cwd` 를 묻는다. */
  _claudeTabCwd(toolId){
    const p=this.tools&&this.tools.get(toolId);
    if(p&&p._cwd) return p._cwd;
    if(!this._claudeHasFolders()) return '';
    if(!this._claudeToolCwd) this._claudeToolCwd=new Map();
    const m=this._claudeToolCwd;
    if(m.has(toolId)) return m.get(toolId);
    m.set(toolId,'');
    apiGet('/api/cwd',{query:{tool:toolId}}).then(r=>{
      if(r.ok&&r.data&&r.data.cwd){m.set(toolId,r.data.cwd);this._claudeRepaintSoon()}
    });
    return '';
  },

  /** FR-CAC-95: 탭 틴트의 값. 계정 기능이 없거나 터미널 탭이 아니면 null. */
  claudeTabTint(tab){
    if(!this._claudeMaps||!tab||!tab.toolId) return null;
    const norm=this._claudeNorm(this._claudeTabCwd(tab.toolId));
    return claudeAcctTabTint(claudeAcctResolve(this._claudeMaps,this._claudeAccts,tab.toolId,norm));
  },

  /** 터미널의 cwd 가 바뀌었다. 폴더 연결이 있을 때만 다시 칠한다. */
  claudeOnCwd(){ if(this._claudeHasFolders()) this._claudeRepaintSoon() },

  /** FR-CAC-96 */
  claudeRepoChip(path){
    if(!this._claudeMaps) return null;
    return claudeAcctRepoChip(this._claudeMaps,this._claudeAccts,this._claudeNorm(path));
  },

  _claudeFolderNorm(root,path){ return claudeAcctNormUnder(root,this._claudeNorm(root),path) },

  /** FR-CAC-97 */
  claudeFolderChip(root,path){
    if(!this._claudeMaps) return null;
    return claudeAcctFolderChip(this._claudeMaps,this._claudeAccts,this._claudeFolderNorm(root,path));
  },

  async _claudeMapPut(body){
    const r=await apiPut('/api/claude-accounts/mappings',body);
    if(!r.ok){ Toast.show(apiErrText(r,t('cacct.map.save_failed')),'err'); return r }
    this._claudeMaps=r.data;
    this._claudeMapsRepaint();
    return r;
  },

  /**
   * FR-CAC-95a · D-CAC-31: 계정 고르기 메뉴를 같은 자리에 연다. 앞 메뉴의 항목 클릭 안에서 불리므로 다음 틱에
   * 연다 — 메뉴는 한 번에 하나라 앞 메뉴가 닫히며 새 메뉴를 함께 닫는다.
   */
  _claudePickMenu(cur,kind,at,pick){
    const items=claudeAcctPickItems(this._claudeAccts,cur,kind).map(it=>
      it.sep||it.static?it:{id:it.id,label:it.label,cur:it.cur,onClick:()=>pick(it.accountId)});
    TIMERS.defer(()=>UIKit.menu(items,{at,cls:'cacct-pick-menu'}),{label:'cacct-pick-menu'});
  },

  /** FR-CAC-85: 탭 우클릭 메뉴의 항목. 계정 기능이 없는 서버면 항목이 없다. */
  claudeTabMenuItem(tab,at){
    if(!this._claudeMaps) return null;
    const why=claudeAcctTabMenuWhy(tab,this._claudeAccts);
    return {id:'claudeAccount',label:t('cacct.map.tab_menu'),disabled:why||false,onClick:()=>{
      const m=this._claudeMaps.tabs||{};
      const cur=m[tab.toolId]&&claudeAcctById(this._claudeAccts,m[tab.toolId].accountId)?m[tab.toolId].accountId:'';
      this._claudePickMenu(cur,'tab',at,id=>this._claudeMapPut({toolId:tab.toolId,accountId:id}));
    }};
  },

  /** FR-CAC-97: Explorer 의 두 항목 `{link, unlinkWhy, unlink}`. 계정 기능이 없는 서버면 null. */
  claudeFolderMenu(root,path,at){
    if(!this._claudeMaps) return null;
    const norm=this._claudeFolderNorm(root,path);
    const direct=claudeAcctDirect(this._claudeMaps,this._claudeAccts,norm);
    const none=(Array.isArray(this._claudeAccts)&&this._claudeAccts.length)?'':t('cacct.map.no_accounts');
    return {
      linkWhy:none,
      unlinkWhy:claudeAcctUnlinkWhy(this._claudeMaps,this._claudeAccts,norm),
      link:()=>this._claudePickMenu(direct?direct.id:'','folder',at,id=>this._claudeMapPut({folder:path,accountId:id})),
      unlink:()=>this._claudeMapPut({folder:path,accountId:''}),
    };
  },
});

/** FR-CAC-96·97·98: 칩 원소. 색은 테마 토큰이고, 글자는 본문 색이라 표면 대비를 따른다. */
function claudeAcctChipEl(c){
  const s=document.createElement('span');
  s.className='cacct-chip';
  s.textContent=c.text;
  s.title=c.title;
  s.style.setProperty('--cacct-c','var(--'+c.color+')');
  return s;
}
