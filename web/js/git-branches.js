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
 * 강제는 `GitConfirm` 2단계를 거친다.
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
      '<div class="git-br-tree"></div>';
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
    // 골격이 새로 세워졌으므로 다음 paint 가 리포 상태를 다시 채운다.
    this._repo=undefined;
  }

  unmount(){
    this._el=null;
    this._repo=undefined;
  }

  // ── 칠하기 ──

  paint(){
    if(!this._el) return;
    if(this.panel.repo!==this._repo) this._adopt();
    if(!this._el) return;
    this._paintBar();
    this._paintTree();
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
    d.className='git-br-row'+(r.isHead?' current':'');
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
    d.title=(r.name||'')+(r.upstream?' → '+r.upstream:'')+(r.subject?'\n'+r.subject:'');
    d.addEventListener('contextmenu',ev=>{
      ev.preventDefault();
      GitMenu.open(r.kind===GIT_REF_KIND_TAG?'tag':'branch',r,ev);
    });
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
    let r=null,d=null;
    try{r=await fetch('/api/git/refs?repo='+encodeURIComponent(repo))}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(this.panel.isStale(tok)) return;
    this._loading=false;
    if(!d||!d.requested||d.requested.repo!==repo){
      // 사유를 보이고 **이미 받은 목록을 지우지 않는다.**
      this._err=GIT_BR_LOAD_FAIL;
      if(this._el) this.paint();
      return;
    }
    this._err=null;
    this._refs=Array.isArray(d.refs)?d.refs:[];
    if(this._el) this.paint();
  }

  // ── checkout (FR-GIT-155·156·157) ──

  /**
   * ref 하나로 옮겨 간다. dirty 면 무엇을 할지 먼저 고르게 한다 (FR-GIT-157).
   *
   * **기본은 취소다** (O14) — stash 도 사용자의 작업 상태를 옮기는 행위이므로
   * 기본이 아니고, 강제는 파괴적이므로 `GitConfirm` 2단계를 거친다.
   */
  static async checkout(panel,ref,o){
    if(!panel||!panel.repo) return;
    const opts=Object.assign({repo:panel.repo,ref:ref||''},o||{});
    if(!panel.isDirty()) return GitBranches._send(panel,opts);
    const pick=await GitChoice.open({
      action:'checkout_dirty',title:GIT_DIRTY_TITLE,note:GIT_DIRTY_NOTE,
      options:GIT_DIRTY_OPTS,def:GIT_DIRTY_OPT_CANCEL,
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
    return GitConfirm.open({
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
    const pick=await GitChoice.open({
      action:'branch_exists',title:GIT_BR_CONFLICT_TITLE,note:d.message||'',
      options,def:'cancel',
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
}

/**
 * 선택지가 셋 이상인 결정 (FR-GIT-157·156).
 *
 * `GitConfirm` 은 계속/취소 두 갈래이므로 여기 있는 것은 그것과 다른 것이다 —
 * **기본 선택은 제시 순서와 별개**다: dirty checkout 은 취소가 첫 항목이지만 이름
 * 충돌은 서버가 준 순서의 마지막이 취소다 (계약 §1.2.1).
 *
 * `Esc` 와 `Enter` 는 둘 다 기본 선택이다 — 기본은 항상 안전한 쪽이다 (O14,
 * FR-GIT-97·176). 20단계의 공통 다이얼로그 규약이 이것을 흡수한다.
 */
class GitChoice {
  static open({action,title,note,options,def}){
    // 한 번에 하나다 — 겹치면 어느 결정인지 알 수 없다.
    if(GitChoice._cur) return Promise.resolve(def||'');
    return new GitChoice({action,title,note,options,def})._show();
  }

  constructor(o){
    this.action=o.action||'';
    this.title=o.title||'';
    this.note=o.note||'';
    this.options=Array.isArray(o.options)?o.options:[];
    this.def=o.def||((this.options[0]||{}).id)||'';
  }

  _show(){
    const ov=document.createElement('div'); ov.id='git-choice'; ov.className='gch-modal';
    ov.innerHTML=
      '<div class="gch-box" role="dialog" aria-modal="true">'+
        '<div class="gch-head"></div>'+
        '<div class="gch-note"></div>'+
        '<div class="gch-opts"></div>'+
      '</div>';
    this.ov=ov;
    const box=ov.querySelector('.gch-box');
    box.dataset.action=this.action;
    box.querySelector('.gch-head').textContent=this.title;
    const n=box.querySelector('.gch-note');
    n.textContent=this.note; n.classList.toggle('vis',!!this.note);
    const opts=box.querySelector('.gch-opts');
    let defBtn=null;
    for(const o of this.options){
      const b=document.createElement('button');
      b.type='button';
      b.className='gch-opt'+(o.danger?' danger':'');
      b.dataset.opt=o.id;
      b.textContent=o.label||o.id;
      b.addEventListener('click',()=>this._close(o.id));
      opts.appendChild(b);
      if(o.id===this.def) defBtn=b;
    }
    document.body.appendChild(ov);
    // 기본 선택에 포커스가 있어야 한다 (O14) — 위험한 항목에 있으면 실패다.
    if(defBtn) defBtn.focus();
    this._key=e=>{
      if(e.key!=='Escape'&&e.key!=='Enter') return;
      e.preventDefault(); e.stopPropagation();
      this._close(this.def);
    };
    document.addEventListener('keydown',this._key,true);
    GitChoice._cur=this;
    return new Promise(res=>{this._resolve=res});
  }

  _close(id){
    document.removeEventListener('keydown',this._key,true);
    if(this.ov) this.ov.remove();
    this.ov=null;
    if(GitChoice._cur===this) GitChoice._cur=null;
    const r=this._resolve; this._resolve=null;
    if(r) r(id||'');
  }
}

GitChoice._cur=null;

/**
 * 브랜치 생성 다이얼로그 (FR-GIT-158, 검증 V68).
 *
 * 이름 / 시작점 / 생성 후 checkout 3필드다. 이름은 입력 중
 * `/api/git/branch/validate` 로 검사하고 **위반이면 실행을 막는다** (FR-GIT-159) —
 * 서버도 같은 것을 막지만, 실행해 보고 알려 주면 사용자는 왜 막혔는지 모른다.
 *
 * `exists:true` 는 규칙 위반이 아니다 (계약 §1.2.1) — "다른 이름을 쓰세요" 를
 * 보이려면 그 구분이 필요하다.
 *
 * `track` 이 주어지면 원격 ref 를 다른 이름의 로컬로 가져오는 것이므로(FR-GIT-156)
 * 시작점과 checkout 여부는 뜻이 없다 — 그 두 필드를 숨긴다.
 */
class GitBranchCreate {
  constructor(panel,o){
    this.panel=panel;
    this.repo=panel.repo;
    this.track=o.track||'';
    this.name0=o.name||'';
    this.start0=o.startRef||'';
    this.why='';      // 사람이 읽는 사유
    this.whyKind='';  // '' | empty | invalid | exists | fail
    this.busy=false;
    this._seq=0;
  }

  _show(){
    const ov=document.createElement('div'); ov.id='git-br-create'; ov.className='gbc-modal';
    ov.innerHTML=
      '<div class="gbc-box" role="dialog" aria-modal="true">'+
        '<div class="gbc-head"></div>'+
        '<input class="gbc-name" type="text">'+
        '<div class="gbc-why"></div>'+
        '<label class="gbc-startrow"><span></span>'+
          '<input class="gbc-start" type="text"></label>'+
        '<label class="gbc-checkoutrow">'+
          '<input class="gbc-checkout" type="checkbox"><span></span></label>'+
        '<div class="gbc-err"></div>'+
        '<div class="gbc-actions">'+
          '<span class="gbc-progress"></span>'+
          '<button type="button" class="gbc-cancel"></button>'+
          '<button type="button" class="gbc-go"></button>'+
        '</div>'+
      '</div>';
    document.body.appendChild(ov);
    this.ov=ov;
    const b=ov.querySelector('.gbc-box');
    this.box=b;
    b.querySelector('.gbc-head').textContent=GIT_BR_CREATE_TITLE;
    b.querySelector('.gbc-name').placeholder=GIT_BR_NAME_PLACEHOLDER;
    b.querySelector('.gbc-start').placeholder=GIT_BR_START_PLACEHOLDER;
    b.querySelector('.gbc-startrow span').textContent='';
    b.querySelector('.gbc-checkoutrow span').textContent=GIT_BR_CREATE_CHECKOUT;
    b.querySelector('.gbc-cancel').textContent=GIT_CONFIRM_CANCEL;
    b.querySelector('.gbc-go').textContent=GIT_BR_CREATE_RUN;
    b.querySelector('.gbc-name').value=this.name0;
    b.querySelector('.gbc-start').value=this.start0;
    // 옵션의 기본값은 안전한 쪽이다 (FR-GIT-97) — 만든 뒤 옮겨 가지 않는다.
    b.querySelector('.gbc-checkout').checked=false;
    b.classList.toggle('tracking',!!this.track);
    b.querySelector('.gbc-name').addEventListener('input',()=>this._onName());
    b.querySelector('.gbc-cancel').addEventListener('click',()=>this._close(false));
    b.querySelector('.gbc-go').addEventListener('click',()=>this._run());
    this._key=e=>{
      if(e.key!=='Escape') return;
      e.preventDefault(); e.stopPropagation();
      if(!this.busy) this._close(false);
    };
    document.addEventListener('keydown',this._key,true);
    b.querySelector('.gbc-name').focus();
    this._paint();
    this._onName();
    return new Promise(res=>{this._resolve=res});
  }

  _name(){return (this.box.querySelector('.gbc-name').value||'').trim()}

  // 입력 중 검사한다. 키 하나마다 보내지 않고 멈춘 뒤에 보낸다 — 이름은 짧지만
  // 검사는 git 실행이다.
  _onName(){
    if(this._t) clearTimeout(this._t);
    const name=this._name();
    if(!name){
      this._set('empty',GIT_BR_WHY_EMPTY);
      return;
    }
    // 검사 중에는 실행을 막는다 — 판정을 모르는 동안 실행을 열어 두면 규칙 위반이
    // 그대로 지나간다 (FR-GIT-159).
    this._set('pending','');
    this._t=setTimeout(()=>{this._t=null;this._validate(name)},GIT_BR_VALIDATE_DEBOUNCE_MS);
  }

  async _validate(name){
    const seq=++this._seq;
    const q=new URLSearchParams({repo:this.repo,name});
    let r=null,d=null;
    try{r=await fetch('/api/git/branch/validate?'+q.toString())}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    // 뒤늦게 온 이전 이름의 판정을 지금 이름의 것으로 읽지 않는다.
    if(seq!==this._seq||!this.box) return;
    const req=d&&d.requested;
    if(!d||!req||req.name!==name||req.repo!==this.repo){
      this._set('fail',GIT_BR_VALIDATE_FAIL);
      return;
    }
    if(!d.ok){this._set('invalid',d.reason||GIT_BR_VALIDATE_FAIL);return}
    // 이미 있는 이름은 규칙 위반이 아니다 — 사유가 달라야 사용자가 무엇을 할지 안다.
    if(d.exists){this._set('exists',GIT_BR_WHY_EXISTS);return}
    this._set('','');
  }

  _set(kind,why){
    this.whyKind=kind; this.why=why;
    this._paint();
  }

  _paint(){
    const b=this.box; if(!b) return;
    const why=b.querySelector('.gbc-why');
    // pending 은 사유가 없다 — 검사 중임을 문구로 떠들지 않고 실행만 막는다.
    why.textContent=this.why;
    why.dataset.why=this.whyKind==='pending'?'':this.whyKind;
    why.classList.toggle('vis',!!this.why);
    b.querySelector('.gbc-progress').textContent=this.busy?GIT_CONFIRM_RUNNING:'';
    const go=b.querySelector('.gbc-go'),cancel=b.querySelector('.gbc-cancel');
    go.disabled=this.busy||this.whyKind!=='';
    cancel.disabled=this.busy;
  }

  async _run(){
    if(this.busy||this.whyKind!=='') return;
    const name=this._name();
    this.busy=true; this._paint();
    const b=this.box;
    const res=this.track
      ? await this.panel.post('/api/git/checkout',
          {repo:this.repo,ref:'',create:name,track:this.track})
      : await this.panel.post('/api/git/branch',{
          repo:this.repo,name,
          startRef:(b.querySelector('.gbc-start').value||'').trim(),
          checkout:!!b.querySelector('.gbc-checkout').checked,
        });
    this.busy=false;
    if(res.ok){
      // 조작 후 목록·상태를 갱신한다 (FR-GIT-160).
      this.panel.afterRefWrite(res.data);
      this._close(true);
      return;
    }
    // 실패 사유는 다이얼로그 안에 남긴다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    const err=b.querySelector('.gbc-err');
    err.textContent=this.panel.writeError(res);
    err.classList.add('vis');
    this._paint();
  }

  _close(v){
    if(this._t){clearTimeout(this._t);this._t=null}
    document.removeEventListener('keydown',this._key,true);
    if(this.ov) this.ov.remove();
    this.ov=null; this.box=null;
    const r=this._resolve; this._resolve=null;
    if(r) r(!!v);
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitBranches=GitBranches;
window.GitChoice=GitChoice;
