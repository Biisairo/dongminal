/**
 * Dongminal — Git History 탭 (GIT_SRS §3C / FR-GIT-113~139)
 *
 * 목록은 **가상 스크롤**이다 (FR-GIT-116). 고정 행 높이로 계산하고 보이는 구간만
 * DOM 에 둔다 — DOM 노드 수는 로드된 커밋 수가 아니라 화면 행 수에 비례한다.
 * 인라인 상세(FR-GIT-135)는 **한 번에 하나만** 펼친다: 그래야 오프셋 계산이 행
 * 하나의 높이 예외만 알면 되고, 가변 높이 문제가 되돌아오지 않는다.
 *
 * 그래프는 행별 인라인 SVG 다 (FR-GIT-118). 캔버스를 쓰지 않는다 — 가상 스크롤에서
 * 캔버스는 좌표를 다시 계산해야 하고 테마 연동이 되지 않는다.
 *
 * 레인 색은 **현재 테마의 팔레트에서 파생**한다 (FR-GIT-119). 색을 만드는 곳은
 * `palette()` 하나이고, 테마 전환은 `applyTheme()` 이 받는다.
 *
 * 레인 배치는 `git-lanes.js` 의 순수 함수가 한다. 그 입력은 `{hash,parents}` 이고
 * `/api/git/log` 는 `{oid,parents}` 를 주므로 **여기서 명시적으로 옮긴다** — 순수
 * 함수의 입력이 서버 응답 형태에 묶이면 다음 형태 변경마다 알고리즘을 건드려야 한다.
 */
class GitHistory {
  constructor(panel){
    this.panel=panel;
    this.app=panel.app;
    this._el=null;
    this._repo=undefined; // 화면에 채워 둔 리포. 바뀌면 전부 되돌린다 (FR-GIT-133)
    this.reset();
  }

  // 리포에 붙은 것은 전부 여기서 지운다. 뷰의 성질(정렬·검색 모드)도 함께
  // 되돌린다 — 이전 리포의 필터가 새 리포의 목록을 조용히 걸러내면 사용자는
  // 커밋이 없다고 읽는다.
  reset(){
    this._commits=[];
    this._view=[];        // 로드 범위 검색이 걸러낸 목록. 그래프의 입력이다
    this._graph=null;
    this._refs=[];
    this._end=false;
    this._loading=false;
    this._loadP=null;
    this._err=null;
    this._note='';
    this._ref=null;        // 선택된 ref. _adopt 가 리포별 저장값으로 채운다
    this._order=GIT_HIST_ORDERS[0].key;
    this._filters={};
    this._q='';
    this._mode=GIT_SEARCH_LOADED;
    this._open=null;      // 펼친 커밋의 oid. 한 번에 하나다
    this._detail=null;
    this._detailErr=null;
    this._parentIdx=0;
    this._jumped=null;
    this._dirtyN=0;
    // FR-GIT-233: 마지막으로 그린 HEAD. 바뀌면 표식을 다시 그린다.
    this._headName=null; this._headOid='';
    this._ver=0;          // 목록이 바뀐 세대. 행 창을 다시 그릴 판단에 쓴다
    this._winKey=null;
    this._top=0;          // 마지막 스크롤 위치. 탭을 떠났다 돌아올 때 되돌린다
    this._noLayout=false; // 목록에 높이가 없는 동안 행 창을 잡지 않았다
    this._barRepo=null;
    this._pal=null;
  }

  // ── 테마 (FR-GIT-119, 검증 V47) ──

  /**
   * 레인 색 배열. **색을 만드는 곳은 여기 하나다** — 리터럴을 코드에 두면 테마를
   * 바꿔도 그래프가 따라오지 않는다. 값은 현재 테마의 터미널 팔레트에서 온다.
   */
  static palette(){
    const t=(typeof getCurrentTheme==='function'&&getCurrentTheme())||null;
    const term=(t&&t.terminal)||{};
    const out=[];
    for(const k of GIT_LANE_COLOR_KEYS){
      const c=term[k];
      if(c&&!out.includes(c)) out.push(c);
    }
    // 팔레트를 얻지 못하면 본문색으로 그린다 — 없는 색을 발명하지 않는다.
    if(!out.length){
      const c=getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
      if(c) out.push(c);
    }
    return out;
  }

  // 테마 전환 훅 (helpers.js applyThemeObj). 살아 있는 목록의 색을 다시 계산한다.
  static applyTheme(){
    const h=window.app&&app.gitPanel&&app.gitPanel._historyView;
    if(!h||!h._el) return;
    h._pal=null; h._ver++; h._paintRows();
  }

  // ── 골격 ──

  // 골격은 History 루트가 다시 만들어질 때마다 한 번 세운다. 리스너도 그때 한 번만
  // 붙는다 — paint 는 칠하기만 한다.
  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-hist-bar">'+
        '<span class="git-hist-search-box">'+
          '<input class="git-hist-search" type="text">'+
          '<button class="git-hist-smode"></button>'+
        '</span>'+
        '<select class="git-hist-order"></select>'+
        '<span class="git-hist-filters"></span>'+
        '<button class="git-hist-apply"></button>'+
        '<span class="git-hist-spacer"></span>'+
        '<input class="git-hist-jump" type="text">'+
        '<button class="git-hist-jump-go"></button>'+
      '</div>'+
      '<div class="git-hist-note">'+
        '<span class="git-hist-note-msg"></span>'+
        '<button class="git-hist-retry"></button>'+
      '</div>'+
      '<div class="git-hist-searchnone">'+
        '<span class="git-hist-searchnone-msg"></span>'+
        '<button class="git-hist-searchrepo"></button>'+
      '</div>'+
      '<div class="git-hist-main">'+
        '<div class="git-refs"></div>'+
        '<div class="git-hist-list">'+
          '<div class="git-hist-sp-top"></div>'+
          '<div class="git-hist-sp-bot"></div>'+
        '</div>'+
      '</div>'+
      '<div class="git-hist-foot">'+
        '<span class="git-hist-loaded" data-n="0"></span>'+
        '<span class="git-hist-state"></span>'+
      '</div>';
    this._list=el.querySelector('.git-hist-list');
    this._spTop=el.querySelector('.git-hist-sp-top');
    this._spBot=el.querySelector('.git-hist-sp-bot');
    el.querySelector('.git-hist-search').placeholder=GIT_SEARCH_PLACEHOLDER;
    el.querySelector('.git-hist-jump').placeholder=GIT_JUMP_PLACEHOLDER;
    el.querySelector('.git-hist-jump-go').textContent=GIT_JUMP_GO;
    el.querySelector('.git-hist-apply').textContent=GIT_HIST_APPLY;
    el.querySelector('.git-hist-searchrepo').textContent=GIT_SEARCH_TRY_REPO;
    el.querySelector('.git-hist-retry').textContent=GIT_HIST_APPLY;
    const ord=el.querySelector('.git-hist-order');
    for(const o of GIT_HIST_ORDERS){
      const op=document.createElement('option'); op.value=o.key; op.textContent=o.label;
      ord.appendChild(op);
    }
    const fbox=el.querySelector('.git-hist-filters');
    for(const f of GIT_HIST_FILTERS){
      const i=document.createElement('input');
      i.type='text'; i.className='git-hist-f'; i.dataset.f=f.key; i.placeholder=f.label;
      i.addEventListener('keydown',ev=>{if(ev.key==='Enter')this._applyFilters()});
      fbox.appendChild(i);
    }
    ord.addEventListener('change',ev=>{this._order=ev.target.value;this._reload()});
    el.querySelector('.git-hist-apply').addEventListener('click',()=>this._applyFilters());
    el.querySelector('.git-hist-retry').addEventListener('click',()=>{this._err=null;this._reload()});
    el.querySelector('.git-hist-search').addEventListener('input',ev=>this._search(ev.target.value));
    el.querySelector('.git-hist-search').addEventListener('keydown',ev=>{
      // 저장소 전체 질의는 느리다 — 키 하나마다 보내지 않고 Enter 로 받는다.
      if(ev.key==='Enter'&&this._mode===GIT_SEARCH_REPO) this._reload();
    });
    el.querySelector('.git-hist-smode').addEventListener('click',()=>this._setMode(
      this._mode===GIT_SEARCH_LOADED?GIT_SEARCH_REPO:GIT_SEARCH_LOADED));
    el.querySelector('.git-hist-searchrepo').addEventListener('click',()=>this._setMode(GIT_SEARCH_REPO));
    el.querySelector('.git-hist-jump-go').addEventListener('click',()=>this._jump());
    el.querySelector('.git-hist-jump').addEventListener('keydown',ev=>{
      if(ev.key==='Enter') this._jump();
    });
    this._list.addEventListener('scroll',()=>this._onScroll());
    // FR-GIT-125: 컬럼 숨김은 **목록 폭**을 보고 정한다. 미디어 쿼리는 창 폭이라
    // 분할 안에 있는 Git 창에서는 쓸 수 없다.
    if(this._ro) this._ro.disconnect();
    if(typeof ResizeObserver!=='undefined'){
      this._ro=new ResizeObserver(es=>{for(const e of es) this._fit(e.contentRect.width)});
      this._ro.observe(this._list);
    }
    // 상세는 노드 하나를 계속 쓴다 — 행 창을 다시 그릴 때마다 새로 만들면 안쪽
    // 스크롤과 부모 선택이 매 스크롤마다 초기화된다.
    this._detailEl=this._buildDetail();
    // 골격이 새로 세워졌으므로 다음 paint 가 리포 상태를 다시 채운다.
    this._repo=undefined;
  }

  unmount(){
    if(this._ro){this._ro.disconnect();this._ro=null}
    this._el=null; this._list=null; this._detailEl=null;
    this._repo=undefined;
  }

  // ── 칠하기 ──

  paint(){
    if(!this._el) return;
    if(this.panel.repo!==this._repo) this._adopt();
    if(!this._el) return;
    this._paintBar();
    this._paintRefs();
    this._paintFoot();
    this._paintRows();
  }

  /**
   * 폴링이 새 status 를 얻을 때마다 불린다. 목록에 영향을 주는 것은 미커밋 변경
   * 행의 개수뿐이다 (FR-GIT-127) — 그 밖의 것으로 목록을 다시 그리면 스크롤이
   * 매초 흔들린다.
   */
  paintStatus(){
    if(!this._el||this.panel.repo!==this._repo) return;
    const n=this.panel.dirtyCount();
    // FR-GIT-233: HEAD 표식을 관측에서 파생하므로 HEAD 가 움직이면 행을 다시 그려야
    // 한다 — 미커밋 개수만 보면 체크아웃 직후의 표식이 낡은 채로 남는다.
    const h=this.panel.headName();
    const o=(this.panel.statusOf()||{}).oid||'';
    if(n===this._dirtyN&&h===this._headName&&o===this._headOid) return;
    this._dirtyN=n; this._headName=h; this._headOid=o; this._ver++;
    // FR-GIT-248: 사이드바의 HEAD 표식도 같은 관측에서 파생한다. 이 경로는 refs 를
    // 다시 받지 않으므로(`_paintRefs` 의 뼈대가 그대로다) 표식만 고친다 —
    // 창 밖에서 체크아웃한 경우가 이 자리다.
    this._paintRefSel(this._el.querySelector('.git-refs'));
    this._paintRows();
  }

  _adopt(){
    this._repo=this.panel.repo;
    this.reset();
    if(!this._repo) return;
    // ref 선택은 리포에 붙은 것이다 — 리포를 정한 뒤에 읽는다.
    this._ref=this._savedRef();
    this._load(false);
    this._loadRefs();
  }

  _paintBar(){
    const el=this._el;
    // 입력값은 사용자가 치는 중일 수 있다 — 리포가 바뀔 때만 되돌린다.
    if(this._barRepo!==this._repo){
      this._barRepo=this._repo;
      el.querySelector('.git-hist-search').value=this._q;
      el.querySelector('.git-hist-order').value=this._order;
      el.querySelector('.git-hist-jump').value='';
      for(const i of el.querySelectorAll('.git-hist-f')) i.value=this._filters[i.dataset.f]||'';
    }
    // FR-GIT-129: 현재 모드를 라벨로 보인다. 두 결과가 다를 수 있음이 드러나야 한다.
    const m=el.querySelector('.git-hist-smode');
    m.dataset.mode=this._mode;
    m.textContent=GIT_SEARCH_MODE_LABEL[this._mode];
    m.title=GIT_SEARCH_MODE_TITLE[this._mode];
    // FR-GIT-132: 사유를 보이고 목록은 지우지 않는다.
    const note=el.querySelector('.git-hist-note');
    const msg=this._err||this._note;
    note.classList.toggle('vis',!!msg);
    note.querySelector('.git-hist-note-msg').textContent=msg||'';
    note.querySelector('.git-hist-retry').classList.toggle('vis',!!this._err);
    // 로드 범위에서 0건이면 저장소 전체를 권한다 — 권하지 않으면 "없다"와
    // "아직 안 받았다"가 구분되지 않는다 (FR-GIT-129).
    const none=el.querySelector('.git-hist-searchnone');
    const show=this._mode===GIT_SEARCH_LOADED&&!!this._q.trim()&&
      !this._view.length&&!!this._commits.length;
    none.classList.toggle('vis',show);
    none.querySelector('.git-hist-searchnone-msg').textContent=
      show?GIT_SEARCH_NONE.replace('%n',String(this._commits.length)):'';
  }

  _paintFoot(){
    const el=this._el;
    const n=el.querySelector('.git-hist-loaded');
    n.dataset.n=String(this._commits.length);
    n.textContent=GIT_HIST_LOADED_N.replace('%n',String(this._commits.length));
    el.querySelector('.git-hist-state').textContent=
      this._loading?GIT_HIST_LOADING:(this._end?GIT_HIST_END:'');
  }

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
  }

  // 뼈대를 이루는 값 전부다. 하나라도 바뀌면 다시 만든다 — 선택(`_ref`)은 여기
  // 없다: 그것만 바뀌는 것이 흔한 경우이고, 그때 다시 만들지 않는 것이 목적이다.
  _refsSig(){
    return (this._refs||[]).map(r=>[r.kind,r.name,r.short,r.ahead,r.behind,
      r.isHead?1:0,r.gone?1:0,r.subject||''].join('\u0001')).join('\u0000');
  }

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
  }

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
  }

  // 선택은 리포별 취향이라 localStorage 에 남는다.
  _refKey(){return GIT_HIST_REF_KEY+':'+(this._repo||'')}
  _savedRef(){
    let v=null;
    try{v=localStorage.getItem(this._refKey())}catch{}
    return v||null;
  }

  _setRef(name){
    if(this._ref===name) return;
    this._ref=name||null;
    try{
      if(this._ref) localStorage.setItem(this._refKey(),this._ref);
      else localStorage.removeItem(this._refKey());
    }catch{}
    this._reload();
  }

  // ── 행 창 (FR-GIT-116, 검증 V48) ──

  _rowH(){return this.app.isMobile?GIT_HIST_ROW_H_MOBILE:GIT_HIST_ROW_H}

  // 목록 항목. 미커밋 변경 행은 최상단이다 (FR-GIT-127).
  _items(){
    const out=[];
    if(this._dirtyN>0) out.push({unc:true});
    for(let i=0;i<this._view.length;i++) out.push({i});
    return out;
  }

  _expIndex(items){
    if(!this._open) return -1;
    return items.findIndex(it=>it.i!==undefined&&this._view[it.i].oid===this._open);
  }

  _paintRows(){
    const list=this._list; if(!list) return;
    // 탭이 비활성인 사이에는 목록에 높이가 없다. 그 상태로 행 창을 잡으면 화면
    // 한 줄만 남기고 **펼친 상세와 스크롤 위치를 잃는다** — 다시 칠할 때까지 손대지
    // 않는다 (elFor 가 루트를 붙인 뒤 한 번 더 부른다).
    if(!list.clientHeight){this._noLayout=true;return}
    // 루트가 DOM 에서 떼였다 붙는 사이 브라우저가 스크롤 위치를 잃는다.
    if(this._noLayout){
      this._noLayout=false;
      if(this._top) list.scrollTop=this._top;
    }
    const items=this._items();
    const rowH=this._rowH();
    list.style.setProperty('--git-row-h',rowH+'px');
    list.style.setProperty('--git-detail-h',GIT_HIST_DETAIL_H+'px');
    const expIdx=this._expIndex(items);
    const detailH=expIdx>=0?GIT_HIST_DETAIL_H:0;
    const total=items.length*rowH+detailH;
    const offset=i=>i*rowH+(expIdx>=0&&i>expIdx?detailH:0);
    const view=list.clientHeight;
    const top=list.scrollTop;
    this._top=top;
    let first;
    if(expIdx<0) first=Math.floor(top/rowH);
    else{
      const before=(expIdx+1)*rowH;
      first=top<before?Math.floor(top/rowH):Math.max(expIdx,Math.floor((top-detailH)/rowH));
    }
    first=Math.max(0,first-GIT_HIST_OVERSCAN);
    const last=Math.min(items.length,first+Math.ceil(view/rowH)+GIT_HIST_OVERSCAN*2);
    const key=[first,last,items.length,expIdx,rowH,this._ver].join(':');
    if(key===this._winKey) return;
    this._winKey=key;
    this._pal=this._pal||GitHistory.palette();
    const frag=document.createDocumentFragment();
    const maxLanes=Math.max(1,(this._graph&&this._graph.maxLanes)||1);
    for(let i=first;i<last;i++){
      const it=items[i];
      frag.appendChild(it.unc?this._uncEl():this._rowEl(it.i,maxLanes,rowH));
      if(i===expIdx){this._paintDetail();frag.appendChild(this._detailEl)}
    }
    // 스페이서 두 개 사이만 바꾼다 (§3.1).
    while(this._spTop.nextSibling!==this._spBot) list.removeChild(this._spTop.nextSibling);
    list.insertBefore(frag,this._spBot);
    this._spTop.style.height=offset(first)+'px';
    this._spBot.style.height=Math.max(0,total-offset(last))+'px';
    // 목록이 비었으면 사실을 알린다 — 빈 화면은 실패와 구분되지 않는다.
    let empty=this._el.querySelector('.git-hist-empty');
    const showEmpty=!items.length&&!this._loading&&!this._err;
    if(showEmpty&&!empty){
      empty=document.createElement('div'); empty.className='git-hist-empty';
      empty.textContent=GIT_HIST_EMPTY;
      list.appendChild(empty);
    }else if(!showEmpty&&empty) empty.remove();
  }

  _uncEl(){
    const d=document.createElement('div');
    d.className='git-hist-row uncommitted';
    const g=document.createElement('span'); g.className='git-hist-graph';
    const m=document.createElement('span'); m.className='git-hist-msg';
    const s=document.createElement('span'); s.className='git-hist-subject';
    s.textContent=GIT_HIST_UNCOMMITTED+' ('+this._dirtyN+')';
    m.appendChild(s);
    d.appendChild(g); d.appendChild(m);
    d.addEventListener('click',()=>this.panel.openView('changes'));
    d.addEventListener('contextmenu',ev=>{ev.preventDefault();GitMenu.open('uncommitted',{},ev)});
    return d;
  }

  /**
   * FR-GIT-233: HEAD 표식은 **살아 있는 관측에서 파생한다.**
   *
   * `git log` 의 decoration 은 목록을 받은 시점의 사실이다. 체크아웃은 refs 사이드바만
   * 다시 받으므로(`afterRefWrite` → `reloadRefs`) 커밋 목록의 표식은 그대로 낡는다 —
   * 눌러서 체크아웃한 배지의 표식이 움직이지 않는 것이 그것이었다.
   *
   * 목록을 다시 받는 대신 파생한다. 요청이 늘지 않고, 스크롤과 펼친 상세가 맨 위로
   * 돌아가지 않는다.
   *
   * 관측이 아직 없으면 decoration 을 그대로 쓴다 — 첫 그리기가 표식 없이 보이지
   * 않게 한다.
   */
  _commitIsHead(c){
    const s=this.panel.statusOf();
    if(!s||!s.oid) return !!c.isHead;
    return c.oid===s.oid;
  }

  /**
   * FR-GIT-248: ref 가 HEAD 인지는 **한 근거에서만** 온다 — 살아 있는 관측이다.
   *
   * 표식이든 동작 대상이든 이 값을 쓴다. 두 벌이면 보이는 것과 되는 것이 갈린다 —
   * 배지의 대상이 decoration 의 낡은 `isHead` 를 실어 **떠나온 브랜치로 돌아오는
   * 체크아웃이 실행되지 않았다** (E5). 요청이 나가지 않으므로 실패도 아니었다.
   *
   * short 는 배지의 이름이자 사이드바 Ref 의 `short` 다 — 사이드바의 `name` 은 전체
   * refname 이라 `status.branch` 와 비교할 수 없다.
   */
  _isHeadRef(kind,short,fallback){
    const s=this.panel.statusOf();
    if(!s) return !!fallback;
    // detached 는 어느 브랜치도 HEAD 가 아니다 (FR-GIT-144 의 상태와 맞는다).
    if(s.detached) return false;
    return kind===GIT_REF_KIND_LOCAL&&!!s.branch&&short===s.branch;
  }

  // 배지의 ref 는 `name` 이 곧 짧은 이름이다 (`shortRefName` 이 이미 뗐다).
  _refIsHead(r){return this._isHeadRef(r.kind,r.name,r.isHead)}

  /**
   * FR-GIT-126 의 배지이면서 **그 ref 를 대상으로 하는 자리**다 (FR-GIT-232).
   *
   * Branches 탭·refs 사이드바와 같은 경로를 탄다 — 더블클릭은 `GitMenu.runPrimary`,
   * 우클릭은 그 ref 의 메뉴다. 조건을 여기 다시 적으면 세 진입점의 뜻이 갈라진다.
   *
   * **클릭을 행으로 올리지 않는다.** 올리면 첫 클릭이 상세를 여닫아 행 창이 다시
   * 만들어지고(`_ver` → `_paintRows`), 두 번째 클릭이 새 요소에 떨어져 브라우저가
   * `dblclick` 을 만들지 않는다. 그래서 배지의 단일 클릭은 아무 일도 하지 않는다.
   */
  _badgeEl(r){
    const b=document.createElement('span');
    b.className='git-hist-badge '+(r.kind||'unknown')+(this._refIsHead(r)?' head':'');
    b.textContent=r.name; b.title=r.name;
    const mkind=r.kind===GIT_REF_KIND_TAG?'tag'
      :(r.kind===GIT_REF_KIND_LOCAL||r.kind===GIT_REF_KIND_REMOTE)?'branch':'';
    // 종류를 모르는 ref(`shortRefName` 이 네임스페이스를 모를 때)로 저장소를 바꾸지
    // 않는다 — 배지는 보이되 대상이 아니다.
    if(!mkind) return b;
    // 메뉴가 보는 모양은 refs 사이드바의 Ref 와 같다 — `short` 가 그 이름이다.
    //
    // FR-GIT-248: 대상은 **누를 때** 만든다. 그릴 때 굳혀 두면 그 뒤 도착한 관측이
    // 반영되지 않는다 — 커밋 목록은 체크아웃 뒤에도 다시 받지 않으므로(FR-GIT-233)
    // decoration 의 `isHead` 는 떠나온 브랜치에 그대로 남는다.
    const target=()=>({short:r.name,name:r.name,kind:r.kind,isHead:this._refIsHead(r)});
    b.addEventListener('click',ev=>ev.stopPropagation());
    b.addEventListener('dblclick',ev=>{ev.stopPropagation();GitMenu.runPrimary(mkind,target())});
    b.addEventListener('contextmenu',ev=>{
      ev.preventDefault(); ev.stopPropagation();
      GitMenu.open(mkind,target(),ev);
    });
    return b;
  }

  _rowEl(idx,maxLanes,rowH){
    const c=this._view[idx];
    const row=this._graph&&this._graph.rows[idx];
    const d=document.createElement('div');
    d.className='git-hist-row'+(this._commitIsHead(c)?' head':'')+
      (this._open===c.oid?' open':'')+(this._jumped===c.oid?' jumped':'');
    d.dataset.oid=c.oid;
    const g=document.createElement('span'); g.className='git-hist-graph';
    // 숫자와 팔레트 색만 들어간다 — 커밋 문자열은 이 문자열에 닿지 않는다.
    if(row) g.innerHTML=this._svg(row,maxLanes,rowH);
    if(row&&row.compressed) g.title=GIT_HIST_COMPRESSED;
    const m=document.createElement('span'); m.className='git-hist-msg';
    // FR-GIT-126: 배지는 종류를 구분하고, HEAD 표식은 따로 붙는다.
    for(const r of c.refs||[]) m.appendChild(this._badgeEl(r));
    const s=document.createElement('span'); s.className='git-hist-subject';
    s.textContent=c.subject; s.title=c.subject;
    m.appendChild(s);
    const a=document.createElement('span'); a.className='git-hist-author';
    a.textContent=c.authorName; a.title=c.authorName+' <'+c.authorMail+'>';
    // O12: 상대시간이 기본이고 절대시간은 title 로 항상 닿는다.
    const t=document.createElement('span'); t.className='git-hist-date';
    const abs=GitHistory.absTime(c.authorAtUnixMs);
    t.textContent=this._dateFmt()===GIT_DATE_ABSOLUTE?abs:GitHistory.relTime(c.authorAtUnixMs);
    t.title=abs;
    const h=document.createElement('span'); h.className='git-hist-hash';
    h.textContent=c.abbrev; h.title=c.oid;
    d.appendChild(g); d.appendChild(m); d.appendChild(a); d.appendChild(t); d.appendChild(h);
    // FR-GIT-232: 두 번째 클릭으로 상세를 여닫지 않는다 — 더블클릭이 제스처로 쓰이는
    // 자리에서 첫 클릭의 되돌림이 되면 목록이 두 번 다시 그려진다 (refs 사이드바와
    // 같은 규약. MouseEvent.detail 이 클릭 횟수다).
    d.addEventListener('click',ev=>{if(ev.detail>1)return; this._toggle(c)});
    d.addEventListener('contextmenu',ev=>{ev.preventDefault();GitMenu.open('commit',c,ev)});
    return d;
  }

  // ── 행별 인라인 SVG (FR-GIT-118·119) ──

  _svg(row,maxLanes,rowH){
    const pal=this._pal, W=GIT_HIST_LANE_W, R=GIT_HIST_DOT_R;
    const w=Math.max(1,maxLanes)*W, mid=rowH/2;
    const x=l=>l*W+W/2;
    const col=l=>pal[l%pal.length]||'';
    const p=[];
    // 세그먼트의 위 끝은 이 행의 공간, 아래 끝은 다음 행의 공간이다 — 갈래가 왼쪽으로
    // 당겨지면 그 이동을 **이 행 안에서** 이어 그린다 (FR-GIT-228·229).
    const line=(x1,y1,x2,y2,c)=>x1===x2
      ?'<line class="git-lane-line" x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+
        '" stroke="'+c+'"/>'
      :'<path class="git-lane-line" fill="none" d="M'+x1+' '+y1+' C'+x1+' '+y2+' '+
        x2+' '+y1+' '+x2+' '+y2+'" stroke="'+c+'"/>';
    // 통과 레인은 이 행을 지나가는 선이다.
    for(const s of row.passThrough)
      p.push(line(x(s.top),0,x(s.bottom),rowH,col(s.color)));
    // FR-GIT-121: 어느 자식도 예약하지 않은 커밋은 위쪽 진입선을 갖지 않는다.
    // 진입선은 위 끝과 점이 같은 공간이라 늘 곧다.
    if(!row.isNewHead)
      p.push(line(x(row.lane),0,x(row.lane),mid,col(row.color)));
    for(const pl of row.parentLanes)
      p.push(line(x(row.lane),mid,x(pl.col),rowH,col(pl.color)));
    p.push('<circle class="git-lane-dot" cx="'+x(row.lane)+'" cy="'+mid+'" r="'+R+
      '" fill="'+col(row.color)+'"/>');
    // FR-GIT-120: 접힌 행에는 표식을 세운다 — 표식 없이 접으면 그래프가 조용히
    // 틀려 보인다. 색은 CSS 가 테마 변수로 준다.
    if(row.compressed)
      p.push('<rect class="git-lane-compressed" x="'+(w-2)+'" y="0" width="2" height="'+rowH+'"/>');
    return '<svg width="'+w+'" height="'+rowH+'" viewBox="0 0 '+w+' '+rowH+'">'+p.join('')+'</svg>';
  }

  // ── 인라인 상세 (FR-GIT-135~139) ──

  _buildDetail(){
    const el=document.createElement('div');
    el.className='git-hist-detail';
    el.innerHTML=
      '<div class="git-hist-d-head">'+
        '<code class="git-hist-d-oid"></code>'+
        '<span class="git-hist-d-parents"></span>'+
      '</div>'+
      '<div class="git-hist-d-who"></div>'+
      '<pre class="git-hist-d-body"></pre>'+
      '<div class="git-hist-d-filehead">'+
        '<span class="git-hist-d-filelabel"></span>'+
        '<label class="git-hist-d-pick">'+
          '<span></span><select class="git-hist-d-parentpick"></select>'+
        '</label>'+
      '</div>'+
      '<div class="git-hist-d-files"></div>';
    el.querySelector('.git-hist-d-pick span').textContent=GIT_DETAIL_PARENT_PICK;
    el.querySelector('.git-hist-d-parentpick').addEventListener('change',ev=>{
      this._parentIdx=Number(ev.target.value)||0;
      this._loadDetail();
    });
    // 상세 안의 클릭이 행 클릭(접기)으로 새지 않게 막는다.
    el.addEventListener('click',ev=>ev.stopPropagation());
    return el;
  }

  _paintDetail(){
    const el=this._detailEl; if(!el) return;
    const d=this._detail;
    el.dataset.oid=this._open||'';
    el.classList.toggle('loading',!d&&!this._detailErr);
    el.querySelector('.git-hist-d-oid').textContent=(d&&d.oid)||this._open||'';
    const ps=el.querySelector('.git-hist-d-parents'); ps.innerHTML='';
    const parents=(d&&d.parents)||[];
    const lab=document.createElement('span');
    lab.className='git-hist-d-plabel';
    lab.textContent=parents.length?GIT_DETAIL_PARENTS:GIT_DETAIL_ROOT;
    ps.appendChild(lab);
    for(const p of parents){
      const a=document.createElement('code');
      a.className='git-hist-d-parent'; a.dataset.oid=p;
      a.textContent=p.slice(0,8); a.title=p;
      a.addEventListener('click',()=>this._goto(p));
      ps.appendChild(a);
    }
    const who=el.querySelector('.git-hist-d-who');
    if(d){
      who.textContent=
        'author '+d.authorName+' <'+d.authorMail+'> '+GitHistory.absTime(d.authorAtUnixMs)+
        ' · committer '+d.committerName+' <'+d.committerMail+'> '+
        GitHistory.absTime(d.commitAtUnixMs);
    }else who.textContent=this._detailErr||GIT_HIST_LOADING;
    el.querySelector('.git-hist-d-body').textContent=(d&&d.body)||'';
    // FR-GIT-139: 머지 커밋만 부모를 고른다. 기본은 첫 부모다.
    const pick=el.querySelector('.git-hist-d-pick');
    pick.classList.toggle('vis',parents.length>1);
    const sel=el.querySelector('.git-hist-d-parentpick');
    if(sel.dataset.for!==(el.dataset.oid+':'+parents.length)){
      sel.dataset.for=el.dataset.oid+':'+parents.length;
      sel.innerHTML='';
      for(let i=0;i<parents.length;i++){
        const op=document.createElement('option');
        op.value=String(i); op.textContent='#'+(i+1)+' '+parents[i].slice(0,8);
        sel.appendChild(op);
      }
    }
    sel.value=String(this._parentIdx);
    const files=(d&&d.files)||[];
    el.querySelector('.git-hist-d-filelabel').textContent=
      d?(files.length?GIT_DETAIL_FILES+' ('+files.length+')':GIT_DETAIL_NO_FILES):'';
    const box=el.querySelector('.git-hist-d-files'); box.innerHTML='';
    for(const f of files) box.appendChild(this._fileEl(d,f));
  }

  _fileEl(d,f){
    const row=document.createElement('div');
    row.className='git-hist-file'; row.dataset.path=f.path;
    const st=document.createElement('span'); st.className='git-hist-file-st';
    st.textContent=f.status;
    const p=document.createElement('span'); p.className='git-hist-file-path';
    p.textContent=f.origPath?f.origPath+' → '+f.path:f.path;
    row.title=p.textContent+(f.score?' ('+f.score+'%)':'');
    row.appendChild(st); row.appendChild(p);
    row.addEventListener('click',()=>this.panel.showCommitDiff({
      repo:this._repo,axis:GIT_AXIS.COMMIT,oid:d.oid,
      parentOid:(d.parents||[])[d.parentIndex]||'',
      path:f.path,origPath:f.origPath||'',
    }));
    return row;
  }

  // 펼침은 한 번에 하나만이다 (§3.1) — 여러 개를 허용하면 가변 높이 문제가
  // 되돌아온다.
  _toggle(c){
    if(this._open===c.oid){this._open=null;this._detail=null;this._detailErr=null}
    else{this._open=c.oid;this._detail=null;this._detailErr=null;this._parentIdx=0;this._loadDetail()}
    this._ver++;
    this._paintRows();
  }

  // ── 질의 ──

  async _get(path,params){
    const q=new URLSearchParams();
    for(const k of Object.keys(params)){
      const v=params[k];
      if(v===''||v==null) continue;
      q.set(k,String(v));
    }
    let r=null,d=null;
    try{r=await fetch(path+'?'+q.toString())}catch{return null}
    if(!r.ok) return null;
    try{d=await r.json()}catch{return null}
    return d;
  }

  // 응답이 내 요청의 짝인지 본다 (FR-GIT-133·145). isStale 과 두 겹이다 — 세대만
  // 보면 같은 리포에서 필터를 바꿨을 때 뒤늦게 온 이전 응답을 자기 것으로 읽는다.
  _sameReq(got,sent){
    for(const k of Object.keys(sent))
      if(String(got[k]===undefined?'':got[k])!==String(sent[k])) return false;
    return true;
  }

  _load(more){
    if(this._loading) return this._loadP;
    this._loadP=this._doLoad(more);
    return this._loadP;
  }

  async _doLoad(more){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    const sent={
      repo,ref:this._ref||'',
      // 추가 로드의 skip 은 실제로 받은 개수다 — 요청한 limit 으로 세면 상한
      // 클램프가 걸린 페이지에서 목록이 어긋난다 (계약 §2.5).
      skip:more?this._commits.length:0,
      limit:more?GIT_LOG_PAGE:GIT_LOG_INITIAL,
      order:this._order,
      author:this._filters.author||'',since:this._filters.since||'',
      until:this._filters.until||'',path:this._filters.path||'',
      grep:this._mode===GIT_SEARCH_REPO?this._q.trim():'',
    };
    this._loading=true; this._err=null;
    this._paintBar(); this._paintFoot();
    const d=await this._get('/api/git/log',sent);
    if(this.panel.isStale(tok)) return;
    this._loading=false;
    if(!d||!d.requested||!this._sameReq(d.requested,sent)){
      // FR-GIT-132: 사유를 보이고 **이미 로드된 목록을 지우지 않는다.**
      this._err=GIT_HIST_LOAD_FAIL; this.paint(); return;
    }
    const got=Array.isArray(d.commits)?d.commits:[];
    // limit 은 실효값이다 — 요청값으로 끝을 판정하면 상한 클램프에서 어긋난다.
    const eff=d.limit||sent.limit;
    this._commits=more?this._commits.concat(got):got;
    this._end=got.length<eff;
    this._rebuild();
    this.paint();
  }

  // ref 를 바꾼 쓰기 뒤에 사이드바를 다시 채운다 (FR-GIT-160). 목록은 _adopt 에서만
  // 받으므로 이것이 없으면 checkout 한 브랜치가 사이드바에 나타나지 않는다.
  reloadRefs(){
    if(this._el&&this.panel.repo===this._repo) this._loadRefs();
  }

  async _loadRefs(){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    const d=await this._get('/api/git/refs',{repo});
    if(this.panel.isStale(tok)) return;
    if(!d||!d.requested||d.requested.repo!==repo) return;
    this._refs=Array.isArray(d.refs)?d.refs:[];
    this.paint();
  }

  async _loadDetail(){
    const repo=this._repo,oid=this._open; if(!repo||!oid) return;
    const tok=this.panel.token();
    const sent={repo,oid,parent:this._parentIdx};
    this._detail=null; this._detailErr=null;
    this._ver++; this._paintRows();
    const d=await this._get('/api/git/commit',sent);
    // FR-GIT-145: 리포가 바뀌었거나 대상이 바뀌었으면 버린다.
    if(this.panel.isStale(tok)) return;
    if(this._open!==oid||this._parentIdx!==sent.parent) return;
    if(!d||!d.requested||!this._sameReq(d.requested,sent)){
      this._detailErr=GIT_HIST_DETAIL_FAIL;
    }else this._detail=d;
    this._ver++; this._paintRows();
  }

  /**
   * FR-GIT-238: 새로고침이 부르는 **공개** 진입점. 목록과 refs 를 함께 다시 받는다 —
   * refs 만 받으면 커밋 목록의 HEAD 표식이 낡는다 (FR-GIT-233 과 같은 자리).
   *
   * `_reload` 를 밖에서 부르지 않기 위해 있다. 경계를 넘는 호출은 다음 변경에서
   * 조용히 깨진다.
   *
   * **스크롤과 펼친 상세가 맨 위로 돌아간다** — "전부 다시 받는다" 의 값이며
   * 사용자가 그것을 골랐다 (GIT_REVIEW4_SRS §3.6 결정 표).
   */
  reload(){
    if(!this._el||this.panel.repo!==this._repo) return;
    return Promise.all([this._loadRefs(),this._reload()]);
  }

  // 목록을 처음부터 다시 받는다. 실패해도 이전 목록은 화면에 남는다.
  _reload(){
    this._open=null; this._detail=null; this._detailErr=null;
    this._jumped=null; this._note='';
    return this._load(false);
  }

  _applyFilters(){
    for(const i of this._el.querySelectorAll('.git-hist-f')) this._filters[i.dataset.f]=i.value.trim();
    this._err=null;
    this._reload();
  }

  // ── 검색 (FR-GIT-129, 검증 V49) ──

  _search(v){
    this._q=v;
    if(this._mode===GIT_SEARCH_REPO) return; // Enter 로 보낸다 — 느린 질의다
    this._rebuild();
    this._paintBar(); this._paintFoot(); this._paintRows();
  }

  _setMode(mode){
    if(this._mode===mode){return}
    this._mode=mode;
    if(mode===GIT_SEARCH_REPO){this._err=null;this._reload();return}
    this._rebuild();
    this.paint();
  }

  // 로드 범위 검색이 걸러낸 목록으로 레인을 다시 잡는다. 걸러낸 목록의 부모는
  // 목록 밖에 있을 수 있으므로 그래프는 그 범위 안에서만 뜻을 갖는다.
  _rebuild(){
    const q=this._mode===GIT_SEARCH_LOADED?this._q.trim().toLowerCase():'';
    this._view=q?this._commits.filter(c=>this._match(c,q)):this._commits;
    // buildLaneGraph 의 입력은 {hash,parents} 이고 응답은 {oid,parents} 다 —
    // 명시적으로 옮긴다 (계약 §3.1.1).
    this._graph=clampLanes(
      buildLaneGraph(this._view.map(c=>({hash:c.oid,parents:c.parents||[]}))),
      this.app.isMobile?GIT_LANE_MAX_MOBILE:GIT_LANE_MAX_DESKTOP);
    this._ver++;
  }

  _match(c,q){
    return (c.subject||'').toLowerCase().includes(q)||
      (c.authorName||'').toLowerCase().includes(q)||
      (c.authorMail||'').toLowerCase().includes(q)||
      (c.oid||'').startsWith(q);
  }

  // ── jump (FR-GIT-131) ──

  async _jump(){
    const inp=this._el.querySelector('.git-hist-jump');
    const rev=inp.value.trim(); if(!rev) return;
    const tok=this.panel.token();
    this._note=GIT_JUMP_SEARCHING; this._err=null; this._paintBar();
    // rev-parse 전용 라우트가 없다 — /api/git/log?ref=<rev>&limit=1 이 해석과
    // 검증을 함께 한다 (없는 리비전은 404 다).
    const d=await this._get('/api/git/log',{repo:this._repo,ref:rev,limit:1});
    if(this.panel.isStale(tok)) return;
    const oid=d&&Array.isArray(d.commits)&&d.commits.length?d.commits[0].oid:'';
    if(!oid){this._note=GIT_JUMP_NOT_FOUND;this._paintBar();return}
    // 로드 범위 밖이면 나올 때까지 받는다. 상한을 둔다 — 없는 것을 끝없이 받아
    // 오지 않는다.
    for(let p=0;p<GIT_JUMP_MAX_PAGES;p++){
      if(this._commits.some(c=>c.oid===oid)) break;
      if(this._end||this._err) break;
      await this._load(true);
      if(this.panel.isStale(tok)) return;
    }
    const i=this._view.findIndex(c=>c.oid===oid);
    if(i<0){this._note=GIT_JUMP_NOT_FOUND;this._paintBar();return}
    this._note='';
    this._goto(oid);
  }

  // 목록 안의 커밋으로 스크롤한다. 찾은 행은 잠깐 강조한다 — 스크롤만 하면 어느
  // 줄로 갔는지 알 수 없다.
  _goto(oid){
    const i=this._view.findIndex(c=>c.oid===oid);
    if(i<0) return;
    this._jumped=oid; this._ver++;
    const items=this._items();
    const idx=items.findIndex(it=>it.i===i);
    this._list.scrollTop=Math.max(0,idx*this._rowH());
    this._paintBar(); this._paintRows();
    if(this._flashT) clearTimeout(this._flashT);
    this._flashT=setTimeout(()=>{
      this._flashT=null;
      if(this._jumped!==oid) return;
      this._jumped=null; this._ver++; this._paintRows();
    },GIT_JUMP_FLASH_MS);
  }

  // ── 스크롤·반응형 ──

  _onScroll(){
    this._paintRows();
    if(this._end||this._loading||this._err) return;
    // 로드 범위 검색 중에는 늘리지 않는다 — 걸러낸 목록의 끝은 로드의 끝이 아니다.
    if(this._mode===GIT_SEARCH_LOADED&&this._q.trim()) return;
    const l=this._list;
    if(l.scrollTop+l.clientHeight>=l.scrollHeight-GIT_LOG_NEAR_END_PX) this._load(true);
  }

  // FR-GIT-125: 그래프와 메시지는 항상 남는다.
  _fit(w){
    // 떼여 있는 동안의 폭 0 으로 컬럼을 전부 숨기지 않는다.
    if(!w) return;
    for(const b of GIT_HIST_BREAKS) this._list.classList.toggle(b.cls,w<b.w);
    this._paintRows();
  }

  // ── 날짜 (O12) ──

  _dateFmt(){
    if(this._df==null){
      let v=null; try{v=localStorage.getItem(GIT_DATE_FORMAT_KEY)}catch{}
      this._df=v===GIT_DATE_ABSOLUTE?GIT_DATE_ABSOLUTE:GIT_DATE_RELATIVE;
    }
    return this._df;
  }

  static relTime(ms,now){
    const d=Math.max(0,(now||Date.now())-ms);
    for(const u of GIT_REL_UNITS){
      const n=Math.floor(d/u[0]);
      if(n>=1) return n+u[1]+' 전';
    }
    return GIT_REL_NOW;
  }

  static absTime(ms){
    const d=new Date(ms), p=n=>String(n).padStart(2,'0');
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+
      p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitHistory=GitHistory;
