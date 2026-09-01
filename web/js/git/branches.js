/**
 * Dongminal — Git Branches 탭 (GIT_SRS §3D.1 / FR-GIT-147~160)
 *
 * 목록은 **14단계의 `/api/git/refs` 를 그대로 쓴다** (FR-GIT-147) — 이름·대상·
 * upstream·ahead/behind 를 이미 주므로 새 조회를 만들지 않는다.
 *
 * 트리는 즐겨찾기 / 로컬 / 원격 / 태그 4그룹이고, 이름에 `/` 가 있으면 첫 조각으로
 * 다시 묶는다 (FR-GIT-148·149·150). 검색 중에는 접힘을 무시한다 — 일치하는 이름이
 * 접힌 그룹 안에 숨어 있으면 사용자는 없다고 읽는다 (FR-GIT-151).
 *
 * 쓰기 경로는 **static** 이다. 우클릭 메뉴는 History 탭의 refs 사이드바에서도
 * 열리므로 checkout 이 이 탭의 인스턴스에 묶여 있으면 그쪽에서 쓸 수 없다.
 *
 * 기본은 항상 안전한 쪽이다 (FR-GIT-97, O14): dirty checkout 의 기본은 취소이고,
 * 강제는 `GitConfirm` 의 파괴적 확인을 거친다.
 */
class GitBranches {
  constructor(panel){
    this.panel=panel;
    this.app=panel.app;
    this._el=null;
    this._repo=undefined; // 화면에 채워 둔 리포. 바뀌면 전부 되돌린다 (FR-GIT-16)
    this.reset();
  }

  // 리포에 붙은 것은 전부 여기서 지운다. 검색어도 함께 되돌린다 — 이전 리포의
  // 필터가 새 리포의 목록을 조용히 걸러내면 사용자는 브랜치가 없다고 읽는다.
  reset(){
    this._refs=[];
    this._err=null;
    this._loading=false;
    this._q='';
    this._head=null;   // 현재 브랜치. 바뀌면 목록의 ✓ 가 따라야 한다
    this._barRepo=null;
    // FR-GIT-254: 일괄 삭제의 대상. **로컬 브랜치만** 담는다 — 원격 ref 와 태그는
    // 이 동작의 대상이 아니다. 리포가 바뀌면 함께 비워진다 (FR-GIT-16).
    this._sel=new Set();
  }

  // ── 다중 선택 (FR-GIT-254) ──

  // 목록에 남아 있는 로컬 브랜치만 뜻이 있다 — 사라진 이름의 선택은 저절로 잊힌다
  // (Changes 탭의 선택과 같은 규약).
  selection(){
    const live=new Set(this._refs.filter(r=>r.kind===GIT_REF_KIND_LOCAL).map(r=>r.short));
    return [...this._sel].filter(s=>live.has(s));
  }

  clearSelection(){
    if(!this._sel.size) return;
    this._sel.clear();
    this._paintTree();
  }

  _toggleSel(short){
    if(this._sel.has(short)) this._sel.delete(short); else this._sel.add(short);
    this._paintTree();
  }

  // ── 골격 ──

  // 골격은 루트가 다시 만들어질 때 한 번 세운다. 리스너도 그때 한 번만 붙는다 —
  // paint 는 칠하기만 한다.
  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-br-bar">'+
        '<input class="git-br-search" type="text">'+
        '<span class="git-br-spacer"></span>'+
        '<button class="git-br-new"></button>'+
      '</div>'+
      '<div class="git-br-note">'+
        '<span class="git-br-note-msg"></span>'+
        '<button class="git-br-retry"></button>'+
      '</div>'+
      '<div class="git-br-tree"></div>'+
      // FR-GIT-269: 원격 목록. 트리 **아래**에 둔다 — 브랜치가 이 탭의 본체이고
      // 원격 설정은 그것을 보조한다. 채우는 것은 GitRemoteList 다 (remote.js).
      '<div class="git-br-remotes"></div>';
    el.querySelector('.git-br-search').placeholder=GIT_BR_SEARCH_PLACEHOLDER;
    el.querySelector('.git-br-new').textContent=GIT_BR_NEW;
    el.querySelector('.git-br-retry').textContent=GIT_BR_RETRY;
    el.querySelector('.git-br-search').addEventListener('input',ev=>{
      this._q=ev.target.value; this._paintTree();
    });
    el.querySelector('.git-br-new').addEventListener('click',()=>
      GitBranches.create(this.panel,{}));
    el.querySelector('.git-br-retry').addEventListener('click',()=>{
      this._err=null; this._load();
    });
    this._el.dataset.repo='';
    // FR-GIT-269: 원격 목록은 자기 상태를 스스로 든다 — 골격 자리만 내준다.
    this._remotes().mount(el.querySelector('.git-br-remotes'));
    // 골격이 새로 세워졌으므로 다음 paint 가 리포 상태를 다시 채운다.
    this._repo=undefined;
  }

  unmount(){
    if(this._remotesView) this._remotesView.unmount();
    this._el=null;
    this._repo=undefined;
  }

  // FR-GIT-269: 원격 목록 (remote.js 가 소유한다). 지연 생성이며, 목록을 다시
  // 받아야 하는 쪽(원격 add/remove 를 밖에서 한 경우)이 reloadRemotes 를 부른다.
  _remotes(){
    if(!this._remotesView) this._remotesView=new GitRemoteList(this.panel);
    return this._remotesView;
  }

  reloadRemotes(){return this._remotes().reload()}

  // ── 칠하기 ──

  paint(){
    if(!this._el) return;
    if(this.panel.repo!==this._repo) this._adopt();
    if(!this._el) return;
    this._paintBar();
    this._paintTree();
    this._remotes().paint();
  }

  /**
   * 폴링이 새 status 를 얻을 때마다 불린다. 목록에 영향을 주는 것은 현재 브랜치
   * 하나뿐이다 — 그 밖의 것으로 refs 를 다시 받으면 매초 git 을 실행한다.
   *
   * 창 밖에서(터미널의 `git checkout`) 옮겨 간 것도 이 경로로 들어온다.
   */
  paintStatus(){
    if(!this._el||this.panel.repo!==this._repo) return;
    const h=this.panel.headName();
    if(h===this._head) return;
    this._head=h;
    this._load();
  }

  // ref 를 바꾼 쓰기 뒤에 `GitPanel.afterRefWrite` 가 부른다 (FR-GIT-160). status
  // 하나로는 어느 브랜치가 생겼는지 사라졌는지 알 수 없으므로 목록을 다시 받는다.
  reload(){return this._load()}

  _adopt(){
    this._repo=this.panel.repo;
    this.reset();
    if(!this._el) return;
    this._el.dataset.repo=this._repo||'';
    if(!this._repo) return;
    this._head=this.panel.headName();
    this._load();
  }

  _paintBar(){
    const el=this._el;
    // 입력값은 사용자가 치는 중일 수 있다 — 리포가 바뀔 때만 되돌린다.
    if(this._barRepo!==this._repo){
      this._barRepo=this._repo;
      el.querySelector('.git-br-search').value=this._q;
    }
    // FR-GIT-132 과 같은 규약: 사유를 보이고 목록은 지우지 않는다.
    const note=el.querySelector('.git-br-note');
    note.classList.toggle('vis',!!this._err);
    note.querySelector('.git-br-note-msg').textContent=this._err||'';
  }

  // ── 트리 (FR-GIT-148~153) ──

  _paintTree(){
    const box=this._el&&this._el.querySelector('.git-br-tree');
    if(!box) return;
    box.innerHTML='';
    const q=this._q.trim().toLowerCase();
    const favs=this._favs();
    let n=0;
    for(const g of GIT_BR_GROUPS){
      const list=this._members(g.key,favs).filter(r=>!q||(r.short||'').toLowerCase().includes(q));
      n+=list.length;
      box.appendChild(this._groupEl(g,list,!!q));
    }
    // 빈 목록은 사실을 알린다 — 빈 화면은 실패와 구분되지 않는다.
    if(!n){
      const d=document.createElement('div'); d.className='git-br-empty';
      d.textContent=(this._loading&&!this._refs.length)?GIT_HIST_LOADING:GIT_BR_EMPTY;
      box.appendChild(d);
    }
  }

  // 즐겨찾기는 로컬·원격 브랜치에서만 뽑는다 (FR-GIT-149) — 태그는 고정 대상이
  // 아니다.
  _members(key,favs){
    if(key===GIT_BR_GROUP_FAV)
      return this._refs.filter(r=>r.kind!==GIT_REF_KIND_TAG&&favs.indexOf(r.short)>=0);
    return this._refs.filter(r=>r.kind===key);
  }

  _groupEl(g,list,searching){
    const d=document.createElement('div');
    d.className='git-br-group'; d.dataset.group=g.key;
    const open=searching||!this._collapsed('g:'+g.key);
    d.classList.toggle('open',open);
    const h=document.createElement('div'); h.className='git-br-group-head';
    h.appendChild(this._twist(open));
    const nm=document.createElement('span'); nm.className='git-br-group-name'; nm.textContent=g.name;
    const c=document.createElement('span'); c.className='git-br-group-count';
    c.textContent='('+list.length+')';
    h.appendChild(nm); h.appendChild(c);
    h.addEventListener('click',()=>this._toggleCollapse('g:'+g.key));
    d.appendChild(h);
    const body=document.createElement('div'); body.className='git-br-group-body';
    if(open) this._fill(body,g.key,list,searching);
    d.appendChild(body);
    return d;
  }

  /**
   * 접두사 그룹핑 (FR-GIT-150). 이름에 `/` 가 있으면 첫 조각으로 묶는다 — 원격의
   * `origin/` 도 같은 규칙으로 묶이므로 원격을 위한 별도 코드가 없다.
   *
   * 즐겨찾기는 묶지 않는다 — 사용자가 골라 둔 짧은 목록이고, 한 겹 더 접으면
   * 고정의 뜻이 사라진다.
   */
  _fill(body,key,list,searching){
    if(key===GIT_BR_GROUP_FAV){
      for(const r of list) body.appendChild(this._rowEl(r));
      return;
    }
    const order=[],groups=new Map();
    for(const r of list){
      const i=(r.short||'').indexOf(GIT_BR_PREFIX_SEP);
      if(i<=0){body.appendChild(this._rowEl(r));continue}
      const pfx=r.short.slice(0,i+1);
      if(!groups.has(pfx)){groups.set(pfx,[]);order.push(pfx)}
      groups.get(pfx).push(r);
    }
    for(const pfx of order) body.appendChild(this._pfxEl(key,pfx,groups.get(pfx),searching));
  }

  _pfxEl(key,pfx,list,searching){
    const d=document.createElement('div');
    d.className='git-br-pfx'; d.dataset.prefix=pfx;
    const ck='p:'+key+':'+pfx;
    const open=searching||!this._collapsed(ck);
    d.classList.toggle('open',open);
    const h=document.createElement('div'); h.className='git-br-pfx-head';
    h.appendChild(this._twist(open));
    const nm=document.createElement('span'); nm.className='git-br-pfx-name'; nm.textContent=pfx;
    const c=document.createElement('span'); c.className='git-br-pfx-count';
    c.textContent='('+list.length+')';
    h.appendChild(nm); h.appendChild(c);
    h.addEventListener('click',()=>this._toggleCollapse(ck));
    d.appendChild(h);
    const body=document.createElement('div'); body.className='git-br-pfx-body';
    if(open) for(const r of list) body.appendChild(this._rowEl(r));
    d.appendChild(body);
    return d;
  }

  _twist(open){
    const t=document.createElement('span'); t.className='git-br-twist';
    t.textContent=open?'▾':'▸';
    return t;
  }

  _rowEl(r){
    const d=document.createElement('div');
    // FR-GIT-254: 일괄 삭제의 대상은 눈에 보여야 한다 — 무엇이 지워질지 모르는
    // 선택은 선택이 아니다.
    const picked=r.kind===GIT_REF_KIND_LOCAL&&this._sel.has(r.short);
    d.className='git-br-row'+(r.isHead?' current':'')+(picked?' sel':'');
    d.dataset.ref=r.name||''; d.dataset.short=r.short||''; d.dataset.kind=r.kind||'';
    // FR-GIT-149: 태그는 고정 대상이 아니므로 ★ 자리를 주지 않는다.
    if(r.kind!==GIT_REF_KIND_TAG){
      const on=this._favs().indexOf(r.short)>=0;
      const f=document.createElement('span');
      f.className='git-br-fav'+(on?' on':'');
      f.textContent=GIT_BR_FAV_MARK;
      f.title=on?GIT_BR_FAV_ON_TITLE:GIT_BR_FAV_OFF_TITLE;
      f.addEventListener('click',ev=>{ev.stopPropagation();this._toggleFav(r.short)});
      d.appendChild(f);
    }
    const nm=document.createElement('span'); nm.className='git-br-name';
    nm.textContent=r.short||''; nm.title=r.name||'';
    d.appendChild(nm);
    // FR-GIT-152: 현재 브랜치를 구분 표시한다.
    if(r.isHead){
      const c=document.createElement('span'); c.className='git-br-cur';
      c.textContent=GIT_BR_CURRENT_MARK;
      d.appendChild(c);
    }
    // FR-GIT-153: ahead/behind 는 0 이면 숨긴다.
    const ab=document.createElement('span'); ab.className='git-br-ab';
    const parts=[];
    if(r.ahead>0) parts.push('↑'+r.ahead);
    if(r.behind>0) parts.push('↓'+r.behind);
    ab.textContent=parts.join(' ');
    d.appendChild(ab);
    const up=document.createElement('span'); up.className='git-br-up';
    up.textContent=r.upstream?'('+r.upstream+')':'';
    d.appendChild(up);
    // upstream 이 사라진 것은 ahead/behind 0 과 **다르다** — 구분하지 않으면
    // 사용자가 동기화된 브랜치로 읽는다.
    if(r.gone){
      const g=document.createElement('span'); g.className='git-br-gone';
      g.textContent=GIT_REF_GONE;
      d.appendChild(g);
    }
    d.title=(r.name||'')+(r.upstream?' → '+r.upstream:'')+(r.subject?'\n'+r.subject:'')
      +(r.kind===GIT_REF_KIND_LOCAL?'\n'+GIT_BR_SEL_TITLE:'');
    const kind=r.kind===GIT_REF_KIND_TAG?'tag':'branch';
    d.addEventListener('contextmenu',ev=>{
      ev.preventDefault();
      GitMenu.open(kind,r,ev);
    });
    /**
     * FR-GIT-254: `Cmd`/`Ctrl` + 클릭으로 여러 개를 고른다. 그냥 클릭은 선택을
     * 비운다 — 지난 선택이 남아 있으면 다음 삭제가 보이지 않는 대상까지 가져간다.
     *
     * 로컬 브랜치만 고를 수 있다. 원격 ref 와 태그는 이 동작의 대상이 아니며,
     * 고를 수 있는 것처럼 보이면 사용자가 지울 수 있다고 읽는다.
     */
    if(r.kind===GIT_REF_KIND_LOCAL){
      d.addEventListener('click',ev=>{
        if(ev.metaKey||ev.ctrlKey){this._toggleSel(r.short);return}
        this.clearSelection();
      });
    }
    // FR-GIT-222: 더블클릭은 그 행의 기본 동작이다. 메뉴와 **같은 경로**로 간다 —
    // dirty 3선택도 이름 충돌 처리도 그대로 걸린다.
    d.addEventListener('dblclick',()=>GitMenu.runPrimary(kind,r));
    return d;
  }

  // ── 즐겨찾기 (FR-GIT-149, O13) ──

  /**
   * 즐겨찾기는 `workspace.json` 최상위 `git.favorites[<repo>]` 다.
   *
   * **`git` 객체를 통째로 갈아치우지 않는다** — `git.pinned` 는 서버가 권위로 쓰고
   * (O1) `git.drafts` 는 커밋 영역이 쓴다 (O6).
   */
  _favBucket(){
    const ws=this.app.ws;
    if(!ws.git) ws.git={};
    const m=ws.git[GIT_BR_FAV_FIELD];
    if(!m||typeof m!=='object') ws.git[GIT_BR_FAV_FIELD]={};
    return ws.git[GIT_BR_FAV_FIELD];
  }

  _favs(){
    const g=this.app.ws.git, m=g&&g[GIT_BR_FAV_FIELD];
    const a=m&&m[this._repo];
    return Array.isArray(a)?a:[];
  }

  _toggleFav(short){
    if(!short||!this._repo) return;
    const b=this._favBucket();
    const cur=this._favs().slice();
    const i=cur.indexOf(short);
    if(i<0) cur.push(short); else cur.splice(i,1);
    if(cur.length) b[this._repo]=cur; else delete b[this._repo];
    this.app._save();
    this._paintTree();
  }

  // ── 접힘 (FR-GIT-150) ──

  // 접힘은 기기별 취향이라 localStorage 다. 리포별로 나눈다 — 다른 저장소의 접힘이
  // 이 저장소의 그룹을 접으면 사용자는 브랜치가 사라졌다고 읽는다.
  _collapseKey(){return GIT_BR_COLLAPSE_KEY+':'+(this._repo||'')}

  _collapsedSet(){
    if(this._cset&&this._csetRepo===this._repo) return this._cset;
    let raw=null;
    try{raw=localStorage.getItem(this._collapseKey())}catch{}
    let arr=[];
    if(raw){try{const v=JSON.parse(raw);if(Array.isArray(v))arr=v}catch{}}
    this._csetRepo=this._repo; this._cset=new Set(arr);
    return this._cset;
  }

  _collapsed(key){return this._collapsedSet().has(key)}

  _toggleCollapse(key){
    const s=this._collapsedSet();
    if(s.has(key)) s.delete(key); else s.add(key);
    try{localStorage.setItem(this._collapseKey(),JSON.stringify([...s]))}catch{}
    this._paintTree();
  }

  // ── 질의 ──

  async _load(){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    this._loading=true;
    const res=await gitFetch('/api/git/refs',{repo},
      {stale:()=>this.panel.isStale(tok),echo:{repo}});
    if(res.stale) return;
    this._loading=false;
    if(!res.ok){
      // 사유를 보이고 **이미 받은 목록을 지우지 않는다.**
      this._err=GIT_BR_LOAD_FAIL;
      if(this._el) this.paint();
      return;
    }
    const d=res.data;
    this._err=null;
    this._refs=Array.isArray(d.refs)?d.refs:[];
    if(this._el) this.paint();
  }

  // ── checkout (FR-GIT-155·156·157) ──

  /**
   * ref 하나로 옮겨 간다. dirty 면 무엇을 할지 먼저 고르게 한다 (FR-GIT-157).
   *
   * **기본은 취소다** (O14) — stash 도 사용자의 작업 상태를 옮기는 행위이므로
   * 기본이 아니고, 강제는 파괴적이므로 `GitConfirm` 의 확인을 거친다.
   */
  static async checkout(panel,ref,o){
    if(!panel||!panel.repo) return;
    const opts=Object.assign({repo:panel.repo,ref:ref||''},o||{});
    if(!panel.isDirty()) return GitBranches._send(panel,opts);
    const pick=await GitDialog.open({
      id:'git-choice',ns:'gch',action:'checkout_dirty',
      title:GIT_DIRTY_TITLE,body:GIT_DIRTY_NOTE,
      choices:GIT_DIRTY_OPTS,def:GIT_DIRTY_OPT_CANCEL,
    });
    if(pick===GIT_DIRTY_OPT_FORCE) return GitBranches._force(panel,opts);
    // 취소와 모르는 값은 아무것도 하지 않는다 — 기본은 항상 안전한 쪽이다 (O14).
    if(pick!==GIT_DIRTY_OPT_STASH) return;
    // stash 후 진행. untracked 까지 담는다 — 담지 않으면 untracked 뿐인 저장소에서
    // 서버가 `nothing_to_stash` 로 막고 사용자는 갈 곳이 없다 (FR-GIT-167).
    const res=await panel.post('/api/git/stash/push',
      {repo:panel.repo,message:GIT_STASH_BEFORE_MSG,includeUntracked:true});
    panel.afterStashWrite(res);
    if(!res.ok) return;
    return GitBranches._send(panel,opts);
  }

  // 원격 ref 는 같은 이름의 로컬을 만들며 추적을 설정한다 (FR-GIT-156) —
  // `origin/feat` 로 그냥 옮겨 가면 detached 가 된다.
  static checkoutRemote(panel,short){
    const s=short||'';
    const i=s.indexOf(GIT_BR_PREFIX_SEP);
    const name=i<0?s:s.slice(i+1);
    return GitBranches.checkout(panel,'',{create:name,track:s});
  }

  // 강제는 워킹 트리의 변경을 버린다. 서버의 파괴적 목록에 없는 이름이므로 확인
  // 단계를 **명시적으로 2** 로 요구한다 (계약 §1.1).
  static _force(panel,opts){
    return GitDialog.confirm({
      action:GIT_ACT_CHECKOUT_FORCE,title:GIT_FORCE_TITLE,
      targets:[opts.create||opts.ref||''],
      hint:{note:GIT_FORCE_NOTE,command:'git stash push -u'},
      stages:2,
      run:async()=>{
        const res=await GitBranches._post(panel,
          Object.assign({},opts,{force:true,confirm:true}));
        if(res.ok) return {ok:true};
        return {ok:false,reason:panel.writeReason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  static async _send(panel,opts){
    const res=await GitBranches._post(panel,opts);
    if(res.ok) return res;
    // 로컬 이름 충돌은 실패가 아니라 **선택**이다 (FR-GIT-156).
    const d=res.data||{};
    if(res.code===409&&d.error==='branch_exists'){
      await GitBranches._conflict(panel,opts,d);
      return res;
    }
    panel.applyWriteFail(res);
    return res;
  }

  static async _post(panel,opts){
    const res=await panel.post('/api/git/checkout',opts);
    // 조작 후 목록·상태를 갱신한다 (FR-GIT-160).
    if(res.ok) panel.afterRefWrite(res.data);
    return res;
  }

  /**
   * 이름 충돌의 선택지는 **서버가 준 순서 그대로**다 (계약 §1.2.1) — 목록을 프론트가
   * 복제하면 서버가 선택지를 늘려도 그것을 보이지 못한다. 기본은 취소다 (O14).
   */
  static async _conflict(panel,opts,d){
    const ids=Array.isArray(d.options)?d.options:[];
    const options=ids.map(id=>({id,label:GIT_BR_CONFLICT_LABEL[id]||id,
      danger:id==='checkout_existing'}));
    const pick=await GitDialog.open({
      id:'git-choice',ns:'gch',action:'branch_exists',
      title:GIT_BR_CONFLICT_TITLE,body:d.message||'',
      choices:options,def:'cancel',
    });
    if(pick==='checkout_existing')
      return GitBranches._send(panel,{repo:opts.repo,ref:d.branch||''});
    if(pick==='create_other_name')
      return GitBranches.create(panel,
        {name:(d.branch||'')+GIT_BR_RENAME_SUFFIX,track:d.track||opts.track||''});
  }

  // 브랜치 생성 다이얼로그 (FR-GIT-158·159).
  static create(panel,o){
    if(!panel||!panel.repo) return;
    return new GitBranchCreate(panel,o||{})._show();
  }

  // ── 묶음 B — 브랜치 동작 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259 · §3.5 FR-GIT-268) ──
  //
  // 접수한 말의 본체다: "branch 삭제, 이름변경 등 기본적인 기능들이 없다."
  //
  // 실행이 **static** 인 것은 checkout 과 같은 이유다 — 우클릭 메뉴는 History 탭의
  // refs 사이드바에서도 열리므로 Branches 탭 인스턴스에 묶여 있으면 그쪽에서 쓸 수
  // 없다. 다중 선택만 인스턴스의 것이며, 없으면 우클릭한 행 하나가 대상이다.
  //
  // 확인은 여기서 쓰지 않는다 — `GIT_MENUS.branch` 의 `destructive` 선언을
  // 프레임워크가 이미 거쳤다 (FR-GIT-146·172). 여기서는 그것을 거쳤음을 `confirm`
  // 으로 실어 보낸다. 서버도 같은 것을 요구한다.

  // 원격 ref 의 `origin/feat` 를 원격과 브랜치로 나눈다. 첫 `/` 만 보는 것은 브랜치
  // 이름에 `/` 가 흔하기 때문이다 (`origin/feature/a`) — checkoutRemote 와 같은 규칙이다.
  static _split(short){
    const s=short||'';
    const i=s.indexOf(GIT_BR_PREFIX_SEP);
    return i<0?{remote:s,branch:''}:{remote:s.slice(0,i),branch:s.slice(i+1)};
  }

  /**
   * 쓰기 하나의 공통 뒷정리. 성공이면 목록·상태를 갱신하고 (FR-GIT-160), 충돌이면
   * **실패가 아니라 진행 중 상태**로 다룬다 (FR-GIT-251·255).
   */
  static async _run(panel,url,body){
    const res=await panel.post(url,Object.assign({repo:panel.repo},body||{}));
    if(res.ok){panel.afterRefWrite(res.data);return res}
    if(GitBranches._conflicted(panel,res)) return res;
    panel.applyWriteFail(res);
    return res;
  }

  /**
   * FR-GIT-255: merge·rebase 가 충돌로 멈춘 것은 실패가 아니다 — 저장소에 중간
   * 상태가 남았고 출구는 묶음 A 가 준다 (FR-GIT-252).
   *
   * pull 이 쓰는 경로 그대로 Changes 탭으로 보내고 충돌 그룹을 펼친다 (FR-GIT-111).
   */
  static _conflicted(panel,res){
    const d=(res&&res.data)||{};
    const st=d.status;
    if(!st) return false;
    if(!((st.operation&&st.operation.kind)||(st.conflicts||[]).length)) return false;
    panel.adopt(d);
    panel.branchNote(GIT_BR_MERGE_CONFLICT_NOTE);
    panel.expandGroup('conflicts');
    panel.openView('changes');
    return true;
  }

  // FR-GIT-253: 이름 변경. 이름 검사는 생성과 **같은 자리**를 쓴다.
  static rename(panel,target){
    if(!panel||!panel.repo||!target) return;
    return new GitBranchRename(panel,target.short||'')._show();
  }

  /**
   * FR-GIT-254: 삭제. 기본은 `-d` 이고 대상은 다중 선택이 있으면 그것이다.
   *
   * **일괄 삭제는 `-d` 로만** 한다 — 확인 하나가 여러 개를 강제 삭제하는 자리를
   * 만들지 않는다. 서버도 같은 것을 막는다.
   */
  static del(panel,target){
    if(!panel||!panel.repo||!target) return;
    return GitBranches._delete(panel,GitBranches.targetsOf(panel,target),false);
  }

  /**
   * 삭제 대상. 다중 선택 안의 행을 눌렀으면 선택 전체이고, 밖의 행이면 그 행
   * 하나다 — 보이는 것과 지워지는 것이 어긋나면 사용자는 무엇을 잃는지 알 수 없다.
   */
  static targetsOf(panel,target){
    const one=[(target&&target.short)||''];
    const v=panel&&panel._branchesView;
    if(!v||typeof v.selection!=='function') return one;
    const sel=v.selection();
    return sel.indexOf(target.short)<0?one:sel;
  }

  static async _delete(panel,names,force){
    const res=await panel.post('/api/git/branch/delete',
      {repo:panel.repo,names,force:!!force,confirm:true});
    if(res.ok){
      if(panel._branchesView) panel._branchesView.clearSelection();
      panel.afterRefWrite(res.data);
      return res;
    }
    const d=res.data||{};
    // 미머지는 실패가 아니라 **선택**이다 (FR-GIT-254) — 이름 충돌의 3선택과 같은 규약.
    // FR-BMU-14: 선택지의 **결과**를 돌려준다. 옛 코드는 언제나 원래의 실패 응답을
    // 돌려주어, 강제 삭제가 실제로 성공했는지 호출자가 알 수 없었다 — `delBoth` 는
    // 그것을 알아야 원격을 이을지 판단한다. 기존 호출자(`del`)는 반환값을 쓰지
    // 않으므로 동작은 바뀌지 않는다.
    if(res.code===409&&d.error==='branch_not_merged'){
      const forced=await GitBranches._unmerged(panel,d);
      return forced||res;
    }
    panel.applyWriteFail(res);
    return res;
  }

  /**
   * 미머지 거부 뒤의 선택지는 **서버가 준 순서 그대로**다 — 목록을 프론트가
   * 복제하면 서버가 선택지를 줄여도(다중 삭제에는 `-D` 가 없다) 그것을 따르지
   * 못한다. 기본은 취소다 (O14).
   */
  static async _unmerged(panel,d){
    const ids=Array.isArray(d.options)?d.options:[];
    const options=ids.map(id=>({id,label:GIT_BR_UNMERGED_LABEL[id]||id,
      danger:id==='force_delete'}));
    const pick=await GitDialog.open({
      id:'git-choice',ns:'gch',action:'branch_not_merged',
      title:GIT_BR_UNMERGED_TITLE,body:d.message||'',
      choices:options,def:'cancel',
    });
    if(pick!=='force_delete') return;
    return GitBranches._delete(panel,[d.branch||''],true);
  }

  /**
   * FR-GIT-255: merge. 다이얼로그가 **영향 범위를 실행 전에 보인다** (G11) —
   * ff 로 끝나는지와 들어올 커밋 수다. 원격 ref 의 `Pull/Merge` 도 이 자리다.
   */
  static async merge(panel,ref){
    if(!panel||!panel.repo||!ref) return;
    const pv=await GitBranches._preview(panel,ref);
    return GitDialog.open({
      id:'git-br-merge',ns:'gbm',action:'branch_merge',
      title:GIT_BR_MERGE_TITLE,runLabel:GIT_BR_MERGE_RUN,
      body:GitBranches._impact(ref,pv),
      fields:GIT_BR_MERGE_FIELDS,
      run:async v=>{
        const res=await GitBranches._run(panel,'/api/git/branch/merge',
          {ref,mode:v.mode||''});
        if(res.ok) return {ok:true};
        // 충돌이면 화면은 이미 Changes 탭으로 옮겨 갔다 — 다이얼로그가 실패를
        // 되풀이해 보일 자리가 아니다 (FR-GIT-251).
        const st=(res.data&&res.data.status)||{};
        if((st.operation&&st.operation.kind)||'') return {ok:true};
        return {ok:false,reason:panel.writeReason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  // 영향 범위 조회. 실패해도 머지를 막지 않는다 — 그 사실을 문구로 알린다.
  static async _preview(panel,ref){
    const q=new URLSearchParams({repo:panel.repo,ref});
    const res=await gitFetch('/api/git/branch/merge-preview',Object.fromEntries(q),
      {echo:{repo:panel.repo,ref}});
    return res.ok?(res.data.preview||null):null;
  }

  // 사람이 읽는 영향 범위. 개수만 보이면 머지 커밋이 생기는지 알 수 없고, ff 여부만
  // 보이면 무엇이 들어오는지 알 수 없다 — 둘 다 적는다 (G11).
  static _impact(ref,pv){
    if(!pv) return ref+' · '+GIT_BR_MERGE_PREVIEW_FAIL;
    const parts=[ref];
    if(pv.upToDate) parts.push(GIT_BR_MERGE_UPTODATE);
    else parts.push(pv.ff?GIT_BR_MERGE_FF:GIT_BR_MERGE_NOFF);
    parts.push(GIT_BR_MERGE_INCOMING.replace('%n',String(pv.incoming||0)));
    if(pv.diverged>0) parts.push(GIT_BR_MERGE_DIVERGED.replace('%n',String(pv.diverged)));
    return parts.join(' · ');
  }

  // FR-GIT-256: rebase. 파괴적 확인과 hint 는 메뉴 프레임워크가 이미 거쳤으므로
  // 여기서는 `confirm` 을 실어 보낸다 — 서버도 그것을 요구한다.
  static rebase(panel,ref){
    if(!panel||!panel.repo||!ref) return;
    return GitBranches._run(panel,'/api/git/branch/rebase',{ref,confirm:true});
  }

  // FR-GIT-257: upstream 설정. 후보는 **이미 받아 둔 원격 ref 목록**에서 온다.
  static setUpstream(panel,target){
    if(!panel||!panel.repo||!target) return;
    return new GitBranchUpstream(panel,target)._show();
  }

  static unsetUpstream(panel,target){
    if(!panel||!panel.repo||!target) return;
    return GitBranches._run(panel,'/api/git/branch/upstream',
      {branch:target.short||'',unset:true});
  }

  /**
   * FR-GIT-258: 브랜치 push. upstream 이 없으면 publish 이며 **그 사실을 실행 전에**
   * 알린다 — 대상이 현재 브랜치가 아니어도 같다 (FR-GIT-100 의 규약을 넓힌 것).
   *
   * 목록의 upstream 이 낡았을 수 있으므로 서버의 거부(409)도 같은 자리로 받는다.
   */
  static async push(panel,target){
    if(!panel||!panel.repo||!target) return;
    const branch=target.short||'';
    if(!target.upstream) return GitBranches._publish(panel,branch,{});
    const res=await panel._remote().run('branch/push',{branch});
    const d=(res&&res.data)||{};
    if(!res.ok&&res.code===409&&d.error==='publish_required')
      return GitBranches._publish(panel,branch,d.plan||{});
    return res;
  }

  // 파괴적이 아니므로 1단계다 (FR-GIT-100). 무엇이 설정되는지는 계획이 있으면
  // 그것을 보인다 — 없어도 "publish 다" 라는 사실은 전해진다.
  static async _publish(panel,branch,plan){
    const target=(plan&&plan.remote)
      ?(plan.remote+GIT_BR_PREFIX_SEP+(plan.branch||branch)):branch;
    const ok=await GitDialog.confirm({
      action:GIT_ACT_PUBLISH,title:GIT_PUBLISH_TITLE,targets:[target],stages:1,
    });
    if(!ok) return;
    return panel._remote().run('branch/push',{branch,publish:true});
  }

  // FR-GIT-268: 원격 ref 를 같은 이름의 로컬 ref 로 갱신한다. 원격 작업이므로 기존
  // job 경로를 탄다 — 진행·취소·실패 사유가 그 자리에 있다.
  static fetchInto(panel,short){
    if(!panel||!panel.repo) return;
    const p=GitBranches._split(short);
    if(!p.branch) return;
    return panel._remote().run('branch/fetch',{remote:p.remote,branch:p.branch});
  }

  // FR-GIT-268: 원격 ref 삭제. 파괴적 확인은 메뉴 프레임워크가 거쳤다 (파괴적 목록에
  // `remote_ref_delete` 가 있다) — 여기서는 `confirm` 을 실어 보낸다.
  /**
   * FR-BMU-10~15: 로컬과 그 원격을 한 번에 지운다.
   *
   * 순서는 **로컬 먼저**다 (D-4). 로컬 삭제는 미머지면 거부되고 그때 사용자에게
   * 선택지가 뜨는데(FR-GIT-254), 원격을 먼저 지우면 그 거부를 만나기 전에 되돌리기
   * 어려운 쪽을 이미 잃는다.
   *
   * 원격 이름은 **지우기 전에** 확보한다 — 로컬이 사라지면 upstream 을 읽을 수 없다.
   */
  static async delBoth(panel,t){
    if(!panel||!panel.repo||!t) return;
    const up=((t.upstream||'')+'').trim();
    if(!up) return;
    const res=await GitBranches._delete(panel,GitBranches.targetsOf(panel,t),false);
    // FR-BMU-14: 로컬이 실패하면 원격은 건드리지 않는다.
    if(!res||!res.ok) return res;
    const rr=await GitBranches.deleteRemote(panel,up);
    // FR-BMU-15: 반쪽만 지워진 것을 조용히 성공으로 보이지 않는다.
    if(rr&&rr.ok===false) panel.branchNote(GIT_BR_DELETE_BOTH_FAIL);
    return rr;
  }

  static deleteRemote(panel,short){
    if(!panel||!panel.repo) return;
    const p=GitBranches._split(short);
    if(!p.branch) return;
    return panel._remote().run('branch/delete-remote',
      {remote:p.remote,branch:p.branch,confirm:true});
  }

  /**
   * 원격 ref 를 되살리는 push (FR-GIT-250.2). **지우기 전 oid** 를 싣는다 — 목록이
   * 그 값을 이미 준다 (/api/git/refs). 값이 없으면 명령을 만들지 않는다: 되살리지
   * 못하는 명령을 보이는 것이 빈 안내문보다 나쁘다.
   */
  static restoreRemoteCmd(t){
    const p=GitBranches._split((t&&t.short)||'');
    if(!p.branch||!t.oid) return '';
    return 'git push '+p.remote+' '+t.oid+':refs/heads/'+p.branch;
  }
}

/**
 * 브랜치 생성 다이얼로그 (FR-GIT-158, 검증 V68).
 *
 * 골격은 20단계의 `GitDialog` 다 (FR-GIT-171) — 이름 / 시작점 / 생성 후 checkout
 * 3필드를 그것에 선언하고, 이 클래스는 이름 검사와 실행만 안다.
 *
 * 이름은 입력 중 `/api/git/branch/validate` 로 검사하고 **위반이면 실행을 막는다**
 * (FR-GIT-159) — 서버도 같은 것을 막지만, 실행해 보고 알려 주면 사용자는 왜
 * 막혔는지 모른다.
 *
 * `exists:true` 는 규칙 위반이 아니다 (계약 §1.2.1) — "다른 이름을 쓰세요" 를
 * 보이려면 그 구분이 필요하다.
 *
 * `track` 이 주어지면 원격 ref 를 다른 이름의 로컬로 가져오는 것이므로(FR-GIT-156)
 * 시작점과 checkout 여부는 뜻이 없다 — 그 두 필드를 만들지 않는다.
 */
class GitBranchCreate {
  constructor(panel,o){
    this.panel=panel;
    this.repo=panel.repo;
    this.track=o.track||'';
    this.name0=o.name||'';
    this.start0=o.startRef||'';
    this.why='';      // 사람이 읽는 사유
    this.whyKind='';  // '' | empty | pending | invalid | exists | fail
    this._seq=0;
  }

  _show(){
    return GitDialog.open({
      id:'git-br-create',ns:'gbc',action:'branch_create',
      title:GIT_BR_CREATE_TITLE,runLabel:GIT_BR_CREATE_RUN,focus:'name',
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gbc-name',
         placeholder:GIT_BR_NAME_PLACEHOLDER,value:this.name0},
        {key:'startRef',type:GIT_DIALOG_TEXT,cls:'gbc-start',fieldCls:'gbc-startrow',
         placeholder:GIT_BR_START_PLACEHOLDER,value:this.start0,hidden:!!this.track},
        // 옵션의 기본값은 안전한 쪽이다 (FR-GIT-173) — 만든 뒤 옮겨 가지 않는다.
        {key:'checkout',type:GIT_DIALOG_CHECK,cls:'gbc-checkout',fieldCls:'gbc-checkoutrow',
         label:GIT_BR_CREATE_CHECKOUT,hidden:!!this.track},
      ],
      validate:(v,d,key)=>this._onName(v,d,key),
      run:v=>this._run(v),
    });
  }

  // 이름만 검사한다. 키 하나마다 보내지 않고 멈춘 뒤에 보낸다 — 이름은 짧지만
  // 검사는 git 실행이다.
  _onName(v,d,key){
    if(key&&key!=='name') return {kind:this.whyKind,why:this.why};
    if(this._t) clearTimeout(this._t);
    const name=(v.name||'').trim();
    if(!name) return this._set('empty',GIT_BR_WHY_EMPTY);
    this._t=setTimeout(()=>{this._t=null;this._validate(name,d)},GIT_BR_VALIDATE_DEBOUNCE_MS);
    // 검사 중에는 실행을 막는다 — 판정을 모르는 동안 실행을 열어 두면 규칙 위반이
    // 그대로 지나간다 (FR-GIT-159).
    return this._set(GIT_DIALOG_WHY_PENDING,'');
  }

  async _validate(name,d){
    if(!d.alive()) return;
    const seq=++this._seq;
    const q=new URLSearchParams({repo:this.repo,name});
    // 뒤늦게 온 이전 이름의 판정을 지금 이름의 것으로 읽지 않는다 — 그 가드가
    // 이제 echo 로 선다.
    const res=await gitFetch('/api/git/branch/validate',{repo:this.repo,name},
      {stale:()=>seq!==this._seq||!d.alive(),echo:{repo:this.repo,name}});
    if(res.stale) return;
    if(!res.ok){this._tell(d,'fail',GIT_BR_VALIDATE_FAIL); return}
    const dt=res.data;
    if(!dt.ok){this._tell(d,'invalid',dt.reason||GIT_BR_VALIDATE_FAIL);return}
    // 이미 있는 이름은 규칙 위반이 아니다 — 사유가 달라야 사용자가 무엇을 할지 안다.
    if(dt.exists){this._tell(d,'exists',GIT_BR_WHY_EXISTS);return}
    this._tell(d,'','');
  }

  _set(kind,why){this.whyKind=kind;this.why=why;return {kind,why}}

  _tell(d,kind,why){
    this._set(kind,why);
    d.setWhy(kind,why);
  }

  async _run(v){
    const name=(v.name||'').trim();
    const res=this.track
      ? await this.panel.post('/api/git/checkout',
          {repo:this.repo,ref:'',create:name,track:this.track})
      : await this.panel.post('/api/git/branch',{
          repo:this.repo,name,
          startRef:(v.startRef||'').trim(),
          checkout:!!v.checkout,
        });
    if(res.ok){
      // 조작 후 목록·상태를 갱신한다 (FR-GIT-160).
      this.panel.afterRefWrite(res.data);
      return {ok:true};
    }
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitBranches=GitBranches;

/**
 * 이름 변경 다이얼로그 (FR-GIT-253).
 *
 * 이름 검사는 생성 다이얼로그의 것을 **그대로 물려받는다** — 규칙 검사·중복 확인이
 * 두 벌이면 한쪽만 고쳐진다 (FR-GIT-159). 처음 값이 현재 이름이므로 그대로 두면
 * `exists` 로 실행이 막힌다: 바꾸지 않은 이름으로의 변경은 변경이 아니다.
 */
class GitBranchRename extends GitBranchCreate {
  constructor(panel,from){
    super(panel,{name:from});
    this.from=from;
  }

  _show(){
    return GitDialog.open({
      id:'git-br-rename',ns:'gbr',action:'branch_rename',
      title:GIT_BR_RENAME_TITLE,runLabel:GIT_BR_RENAME_RUN,focus:'name',
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gbr-name',
         placeholder:GIT_BR_RENAME_PLACEHOLDER,value:this.from},
      ],
      validate:(v,d,key)=>this._onName(v,d,key),
      run:v=>this._run(v),
    });
  }

  async _run(v){
    const res=await this.panel.post('/api/git/branch/rename',
      {repo:this.repo,from:this.from,to:(v.name||'').trim()});
    if(res.ok){
      // 조작 후 목록·상태를 갱신한다 (FR-GIT-160) — 상태바의 브랜치 이름도 따라간다.
      this.panel.afterRefWrite(res.data);
      return {ok:true};
    }
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

/**
 * upstream 설정 다이얼로그 (FR-GIT-257).
 *
 * **후보 목록을 새로 받지 않는다** — Branches 탭이 이미 들고 있는 원격 ref 로
 * 검사한다 (FR-GIT-147). 목록을 얻을 수 없는 자리(History 의 refs 사이드바)에서는
 * 검사를 건너뛴다: 모르는 것을 틀렸다고 말하지 않는다.
 */
class GitBranchUpstream {
  constructor(panel,target){
    this.panel=panel;
    this.repo=panel.repo;
    this.branch=target.short||'';
    this.value=target.upstream||'';
  }

  _show(){
    return GitDialog.open({
      id:'git-br-upstream',ns:'gbu',action:'branch_upstream',
      title:GIT_BR_UPSTREAM_TITLE,runLabel:GIT_BR_UPSTREAM_RUN,focus:'upstream',
      fields:[
        {key:'upstream',type:GIT_DIALOG_TEXT,cls:'gbu-up',
         placeholder:GIT_BR_UPSTREAM_PLACEHOLDER,value:this.value},
      ],
      validate:v=>this._check(v),
      run:v=>this._run(v),
    });
  }

  _check(v){
    const up=(v.upstream||'').trim();
    if(!up) return {kind:'empty',why:GIT_BR_UPSTREAM_WHY_EMPTY};
    const known=this._remotes();
    if(known&&known.indexOf(up)<0) return {kind:'unknown',why:GIT_BR_UPSTREAM_WHY_UNKNOWN};
    return {kind:'',why:''};
  }

  // 알 수 없으면 null 이다 — 빈 배열로 답하면 모든 이름이 틀린 것이 된다.
  _remotes(){
    const v=this.panel._branchesView;
    if(!v||!Array.isArray(v._refs)||!v._refs.length) return null;
    return v._refs.filter(r=>r.kind===GIT_REF_KIND_REMOTE).map(r=>r.short);
  }

  async _run(v){
    const res=await this.panel.post('/api/git/branch/upstream',
      {repo:this.repo,branch:this.branch,upstream:(v.upstream||'').trim()});
    if(res.ok){
      this.panel.afterRefWrite(res.data);
      return {ok:true};
    }
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

window.GitBranchCreate=GitBranchCreate;
window.GitBranchRename=GitBranchRename;
window.GitBranchUpstream=GitBranchUpstream;
