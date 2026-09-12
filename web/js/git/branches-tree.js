/**
 * Dongminal — Branches 탭의 **트리** (FE_MODULE_BOUNDARY_SRS FR-FMB-30).
 *
 * 즐겨찾기 / 로컬 / 원격 / 태그 4그룹, 이름의 `/` 로 다시 묶는 접두어 그룹, 그
 * 아래 행 하나 (FR-GIT-148~153). 접힘(FR-GIT-150)과 즐겨찾기(FR-GIT-149, O13)가
 * 여기 함께 있는 이유는 둘 다 **무엇을 보일 것인가**를 정하는 상태이기 때문이다.
 *
 * 검색 중에는 접힘을 무시한다 — 일치하는 이름이 접힌 그룹 안에 숨어 있으면
 * 사용자는 없다고 읽는다 (FR-GIT-151).
 */
Object.assign(GitBranches.prototype, {
  // ── 트리 (FR-GIT-148~153) ──

  /**
   * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-17~20 (`GP-9`): **목록을 비우지 않는다.**
   *
   *   이전 동작: `box.innerHTML=''` 후 전부 다시 만들었다
   *   새  동작: 세 겹(그룹 → 접두사 → 행)이 각자 `reconcileList` 를 지난다
   *   이유:     이 뷰는 **바깥 계기로** 다시 그려진다 — `paintStatus()` 가
   *             HEAD 변화에서 `_load()`→`paint()` 를 부른다. 전면 교체는
   *             hover, 더블클릭의 첫 클릭, 우클릭 메뉴의 앵커 행, 글자 선택,
   *             다중 선택 표시를 갱신 회차마다 끊었다 (FR-RPT-1~7 이 그것을
   *             금하고 있었는데 이 뷰만 적용 밖이었다)
   *
   * 겹의 껍데기는 **자기 신원만**으로 판정한다 (FR-GRF-18) — 개수를 근거에
   * 넣으면 브랜치 하나가 늘 때 그룹 전체가 다시 만들어져 얻는 것이 없다.
   * 개수·펼침은 껍데기를 되쓴다.
   */
  _paintTree(){
    const box=this._el&&this._el.querySelector('.git-br-tree');
    if(!box) return;
    const q=this._q.trim().toLowerCase();
    const searching=!!q;
    const favs=this._favs();
    const groups=GIT_BR_GROUPS.map(g=>({
      g,
      list:this._members(g.key,favs).filter(r=>!q||(r.short||'').toLowerCase().includes(q)),
    }));
    const n=groups.reduce((a,x)=>a+x.list.length,0);
    // FR-GRF-20: 빈 목록 안내도 **같은 목록의 한 항목**이다. 따로 붙이면 다음
    // 조정이 그것을 "규약을 지키지 않는 자식" 으로 지운다 (repaint.js 의 계약).
    const empty=n?null:{empty:(this._loading&&!this._refs.length)?GIT_HIST_LOADING:GIT_BR_EMPTY};
    const items=empty?[...groups,empty]:groups;
    reconcileList(box,items,{
      key:it=>it.empty!==undefined?'__empty':('g:'+it.g.key),
      sig:it=>it.empty!==undefined?('e:'+it.empty):'',
      build:it=>it.empty!==undefined?this._emptyEl(it.empty):this._groupShell(it.g),
    });
    for(const it of groups) this._fillGroup(box,it.g,it.list,searching);
  },

  _emptyEl(text){
    const d=document.createElement('div'); d.className='git-br-empty';
    d.textContent=text;
    return d;
  },

  // 그룹의 **껍데기**. 내용(개수·펼침·본문)은 `_fillGroup` 이 되쓴다.
  _groupShell(g){
    const d=document.createElement('div');
    d.className='git-br-group'; d.dataset.group=g.key;
    const h=document.createElement('div'); h.className='git-br-group-head';
    h.appendChild(this._twist(true));
    const nm=document.createElement('span'); nm.className='git-br-group-name'; nm.textContent=g.name;
    const c=document.createElement('span'); c.className='git-br-group-count';
    h.appendChild(nm); h.appendChild(c);
    h.addEventListener('click',()=>this._toggleCollapse('g:'+g.key));
    d.appendChild(h);
    const body=document.createElement('div'); body.className='git-br-group-body';
    d.appendChild(body);
    return d;
  },

  _fillGroup(box,g,list,searching){
    const d=box.querySelector('.git-br-group[data-group="'+g.key+'"]');
    if(!d) return;
    const open=searching||!this._collapsed('g:'+g.key);
    d.classList.toggle('open',open);
    d.querySelector('.git-br-twist').textContent=open?'▾':'▸';
    d.querySelector('.git-br-group-count').textContent='('+list.length+')';
    const body=d.querySelector('.git-br-group-body');
    // 접힌 그룹은 본문이 비어야 한다 — 빈 목록으로 조정하면 요소만 걷힌다.
    this._fill(body,g.key,open?list:[],searching);
  },

  // 즐겨찾기는 로컬·원격 브랜치에서만 뽑는다 (FR-GIT-149) — 태그는 고정 대상이
  // 아니다.
  _members(key,favs){
    if(key===GIT_BR_GROUP_FAV)
      return this._refs.filter(r=>r.kind!==GIT_REF_KIND_TAG&&favs.indexOf(r.short)>=0);
    return this._refs.filter(r=>r.kind===key);
  },

  /**
   * 접두사 그룹핑 (FR-GIT-150). 이름에 `/` 가 있으면 첫 조각으로 묶는다 — 원격의
   * `origin/` 도 같은 규칙으로 묶이므로 원격을 위한 별도 코드가 없다.
   *
   * 즐겨찾기는 묶지 않는다 — 사용자가 골라 둔 짧은 목록이고, 한 겹 더 접으면
   * 고정의 뜻이 사라진다.
   */
  _fill(body,key,list,searching){
    // 접두사 없는 행과 접두사 묶음이 **한 목록에 섞인다** — 순서가 뜻을 가지므로
    // 둘을 나눠 붙이지 않고 하나로 조정한다.
    const items=[];
    if(key===GIT_BR_GROUP_FAV){
      for(const r of list) items.push({row:r});
    }else{
      const groups=new Map();
      for(const r of list){
        const i=(r.short||'').indexOf(GIT_BR_PREFIX_SEP);
        if(i<=0){items.push({row:r});continue}
        const pfx=r.short.slice(0,i+1);
        let g=groups.get(pfx);
        if(!g){g={pfx,list:[]};groups.set(pfx,g);items.push(g)}
        g.list.push(r);
      }
    }
    reconcileList(body,items,{
      key:it=>it.row?('r:'+(it.row.kind||'')+':'+(it.row.name||it.row.short||'')):('p:'+it.pfx),
      // FR-GRF-19: 행의 근거는 **보이는 값 전부**다. 묶음의 근거는 신원뿐이다.
      sig:it=>it.row?this._rowSig(it.row):'',
      build:it=>it.row?this._rowEl(it.row):this._pfxShell(key,it.pfx),
    });
    for(const it of items) if(!it.row) this._fillPfx(body,key,it.pfx,it.list,searching);
  },

  // 행의 보이는 값 전부 (FR-RPT-2). 좁히면 갱신이 조용히 멈춘다.
  _rowSig(r){
    const picked=r.kind===GIT_REF_KIND_LOCAL&&this._sel.has(r.short);
    const fav=this._favs().indexOf(r.short)>=0;
    return [r.short||'',r.name||'',r.kind||'',r.isHead?1:0,picked?1:0,fav?1:0,
      r.ahead||0,r.behind||0,r.upstream||'',r.gone?1:0,r.subject||''].join('\u0000');
  },

  _pfxShell(key,pfx){
    const d=document.createElement('div');
    d.className='git-br-pfx'; d.dataset.prefix=pfx;
    const ck='p:'+key+':'+pfx;
    const h=document.createElement('div'); h.className='git-br-pfx-head';
    h.appendChild(this._twist(true));
    const nm=document.createElement('span'); nm.className='git-br-pfx-name'; nm.textContent=pfx;
    const c=document.createElement('span'); c.className='git-br-pfx-count';
    h.appendChild(nm); h.appendChild(c);
    h.addEventListener('click',()=>this._toggleCollapse(ck));
    d.appendChild(h);
    const body=document.createElement('div'); body.className='git-br-pfx-body';
    d.appendChild(body);
    return d;
  },

  _fillPfx(box,key,pfx,list,searching){
    const d=[...box.children].find(e=>e.dataset&&e.dataset.prefix===pfx);
    if(!d) return;
    const open=searching||!this._collapsed('p:'+key+':'+pfx);
    d.classList.toggle('open',open);
    d.querySelector('.git-br-twist').textContent=open?'▾':'▸';
    d.querySelector('.git-br-pfx-count').textContent='('+list.length+')';
    const body=d.querySelector('.git-br-pfx-body');
    reconcileList(body,open?list:[],{
      key:r=>'r:'+(r.kind||'')+':'+(r.name||r.short||''),
      sig:r=>this._rowSig(r),
      build:r=>this._rowEl(r),
    });
  },

  _twist(open){
    const t=document.createElement('span'); t.className='git-br-twist';
    t.textContent=open?'▾':'▸';
    return t;
  },

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
  },

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
  },

  _favs(){
    const g=this.app.ws.git, m=g&&g[GIT_BR_FAV_FIELD];
    const a=m&&m[this._repo];
    return Array.isArray(a)?a:[];
  },

  _toggleFav(short){
    if(!short||!this._repo) return;
    const b=this._favBucket();
    const cur=this._favs().slice();
    const i=cur.indexOf(short);
    if(i<0) cur.push(short); else cur.splice(i,1);
    if(cur.length) b[this._repo]=cur; else delete b[this._repo];
    this.app.save();
    this._paintTree();
  },

  // ── 접힘 (FR-GIT-150) ──

  // 접힘은 기기별 취향이라 localStorage 다. 리포별로 나눈다 — 다른 저장소의 접힘이
  // 이 저장소의 그룹을 접으면 사용자는 브랜치가 사라졌다고 읽는다.
  _collapseKey(){return GIT_BR_COLLAPSE_KEY+':'+(this._repo||'')},

  _collapsedSet(){
    if(this._cset&&this._csetRepo===this._repo) return this._cset;
    let raw=null;
    try{raw=localStorage.getItem(this._collapseKey())}catch{}
    let arr=[];
    if(raw){try{const v=JSON.parse(raw);if(Array.isArray(v))arr=v}catch{}}
    this._csetRepo=this._repo; this._cset=new Set(arr);
    return this._cset;
  },

  _collapsed(key){return this._collapsedSet().has(key)},

  _toggleCollapse(key){
    const s=this._collapsedSet();
    if(s.has(key)) s.delete(key); else s.add(key);
    try{localStorage.setItem(this._collapseKey(),JSON.stringify([...s]))}catch{}
    this._paintTree();
  },
});
