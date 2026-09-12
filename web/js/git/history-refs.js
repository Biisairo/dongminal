/**
 * Dongminal — History 의 **refs 사이드바** (FE_MODULE_BOUNDARY_SRS FR-FMB-32).
 *
 * 로컬 · 원격 · 태그 3그룹과 ref 필터 (FR-GIT-122·123). 고른 ref 는 저장소마다
 * 기억된다 — 탭을 떠났다 돌아와도 보던 갈래가 그대로다.
 */
Object.assign(GitHistory.prototype, {
  // ── refs 사이드바 (FR-GIT-122·123) ──

  /**
   * refs 사이드바를 칠한다.
   *
   * **뼈대가 그대로면 요소를 다시 만들지 않는다.** 다시 만들면 더블클릭의 두 번째
   * 클릭이 새 요소에 떨어져 브라우저가 `dblclick` 을 만들지 않는다 — 단일 클릭의
   * 필터가 곧바로 목록을 다시 그리므로(`_setRef` → `_reload` → `paint`) 체크아웃이
   * 되다 말다 한다 (FR-GIT-222). 바뀌는 것이 선택뿐이면 선택만 고친다.
   */
  _paintRefs(){
    const box=this._el.querySelector('.git-refs');
    const sig=this._refsSig();
    if(box.dataset.sig===sig){this._paintRefSel(box);return}
    box.dataset.sig=sig;
    box.innerHTML='';
    const all=document.createElement('div');
    all.className='git-refs-all'+(this._ref?'':' sel');
    all.textContent=GIT_REF_ALL;
    all.addEventListener('click',()=>this._setRef(null));
    box.appendChild(all);
    for(const g of GIT_REF_GROUPS){
      const d=document.createElement('div');
      d.className='git-refs-group'; d.dataset.kind=g.kind;
      const h=document.createElement('div'); h.className='git-refs-head'; h.textContent=g.name;
      d.appendChild(h);
      for(const r of this._refs){
        if(r.kind!==g.kind) continue;
        d.appendChild(this._refEl(r,g.kind));
      }
      box.appendChild(d);
    }
  },

  // 뼈대를 이루는 값 전부다. 하나라도 바뀌면 다시 만든다 — 선택(`_ref`)은 여기
  // 없다: 그것만 바뀌는 것이 흔한 경우이고, 그때 다시 만들지 않는 것이 목적이다.
  _refsSig(){
    return (this._refs||[]).map(r=>[r.kind,r.name,r.short,r.ahead,r.behind,
      r.isHead?1:0,r.gone?1:0,r.subject||''].join('\u0001')).join('\u0000');
  },

  /**
   * 뼈대를 다시 만들지 않고 고치는 것들. 선택과 **HEAD 표식**이다.
   *
   * FR-GIT-248: 표식은 관측에서 파생하므로 refs 응답이 그대로여도 움직인다 —
   * 창 밖(터미널)에서 체크아웃하면 refs 를 다시 받는 계기가 없다.
   */
  _paintRefSel(box){
    if(!box) return;
    const all=box.querySelector('.git-refs-all');
    if(all) all.classList.toggle('sel',!this._ref);
    for(const d of box.querySelectorAll('.git-ref')){
      d.classList.toggle('sel',this._ref===d.dataset.ref);
      d.classList.toggle('head',
        this._isHeadRef(d.dataset.kind,d.dataset.short,d.dataset.head==='1'));
    }
  },

  _refEl(r,kind){
    const d=document.createElement('div');
    // FR-GIT-248: 표식도 판정도 관측에서 온다. decoration/for-each-ref 의 값은
    // 관측이 아직 없을 때의 폴백으로만 쓰이므로 요소에 남겨 둔다.
    d.className='git-ref'+(this._ref===r.name?' sel':'')+
      (this._isHeadRef(r.kind,r.short,r.isHead)?' head':'');
    d.dataset.ref=r.name; d.dataset.kind=r.kind; d.dataset.short=r.short;
    d.dataset.head=r.isHead?'1':'';
    const s=document.createElement('span'); s.className='git-ref-short'; s.textContent=r.short;
    const ab=document.createElement('span'); ab.className='git-ref-ab';
    const parts=[];
    if(r.ahead>0) parts.push('↑'+r.ahead);
    if(r.behind>0) parts.push('↓'+r.behind);
    ab.textContent=parts.join(' ');
    d.appendChild(s); d.appendChild(ab);
    // upstream 이 사라진 것은 ahead/behind 0 과 **다르다** — 구분하지 않으면
    // 사용자가 동기화된 브랜치로 읽는다.
    if(r.gone){
      const g=document.createElement('span'); g.className='git-ref-gone';
      g.textContent=GIT_REF_GONE; d.appendChild(g);
    }
    d.title=r.name+(r.upstream?' → '+r.upstream:'')+(r.subject?'\n'+r.subject:'');
    // 더블클릭의 두 번째 클릭이 선택을 다시 토글하면 필터가 원래대로 돌아간다 —
    // MouseEvent.detail 이 클릭 횟수다 (FR-GIT-222).
    d.addEventListener('click',ev=>{
      if(ev.detail>1) return;
      this._setRef(this._ref===r.name?null:r.name);
    });
    const mkind=kind==='tag'?'tag':'branch';
    // FR-GIT-248: 배지와 같은 규약이다 — 대상은 누를 때 만들고 HEAD 여부는 관측에서
    // 파생한다. 나머지 필드는 서버가 준 Ref 그대로다.
    const target=()=>Object.assign({},r,
      {isHead:this._isHeadRef(r.kind,r.short,r.isHead)});
    d.addEventListener('contextmenu',ev=>{
      ev.preventDefault();
      GitMenu.open(mkind,target(),ev);
    });
    // FR-GIT-222: Branches 탭과 **같은 제스처가 같은 뜻**을 갖는다.
    d.addEventListener('dblclick',()=>GitMenu.runPrimary(mkind,target()));
    return d;
  },

  // 선택은 리포별 취향이라 localStorage 에 남는다.
  _refKey(){return GIT_HIST_REF_KEY+':'+(this._repo||'')},

  _savedRef(){
    let v=null;
    try{v=localStorage.getItem(this._refKey())}catch{}
    return v||null;
  },

  _setRef(name){
    if(this._ref===name) return;
    this._ref=name||null;
    try{
      if(this._ref) localStorage.setItem(this._refKey(),this._ref);
      else localStorage.removeItem(this._refKey());
    }catch{}
    this._reload();
  },
});
