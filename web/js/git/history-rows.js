/**
 * Dongminal — History 의 **행** (FE_MODULE_BOUNDARY_SRS FR-FMB-32).
 *
 * 가상 스크롤의 행 창 (FR-GIT-116, 검증 V48) · 미커밋 행 · ref 배지 · 행별 인라인
 * 레인 SVG (FR-GIT-118·119) · 날짜 표기 (O12).
 *
 * 날짜가 여기 있는 이유는 **행이 그것을 그리는 유일한 자리**이기 때문이다.
 * `relTime`·`absTime` 은 `static` 이라 클래스 객체 자신에 얹는다 — 행 밖에서도
 * 같은 표기를 쓰는 곳이 있다.
 */
Object.assign(GitHistory.prototype, {
  // ── 행 창 (FR-GIT-116, 검증 V48) ──

  _rowH(){return this.app.isMobile?GIT_HIST_ROW_H_MOBILE:GIT_HIST_ROW_H},

  // 목록 항목. 미커밋 변경 행은 최상단이다 (FR-GIT-127).
  _items(){
    const out=[];
    if(this._dirtyN>0) out.push({unc:true});
    for(let i=0;i<this._view.length;i++) out.push({i});
    return out;
  },

  _expIndex(items){
    if(!this._open) return -1;
    return items.findIndex(it=>it.i!==undefined&&this._view[it.i].oid===this._open);
  },

  /**
   * 목록에 높이가 설 때까지 프레임마다 다시 본다 (FR-DRC-14).
   *
   * **프레임이 맞는 계기다.** 높이는 브라우저가 레이아웃을 한 뒤에 생기고, 그
   * 시점을 아는 것은 타이머가 아니라 rAF 다. 탭이 숨으면 rAF 가 아예 멎으므로
   * 대기가 저절로 멈추고, 다시 보이면 그 자리에서 이어진다 — 숨은 탭을 위해
   * 도는 타이머가 남지 않는다.
   *
   * 상한을 두는 이유는 **영영 서지 않는 경우**다. 뷰가 마운트된 채로 높이가 0
   * 인 화면(접힌 칸)이 있으면 이 사슬이 끝나지 않는다.
   */
  _awaitLayout(n){
    if(this._layoutT) return;
    this._layoutT=TIMERS.frame(()=>{
      this._layoutT=null;
      if(!this._el||!this._list) return;
      if(!this._list.clientHeight){
        if(n<GIT_HIST_LAYOUT_FRAMES) this._awaitLayout(n+1);
        return;
      }
      // 높이가 섰다. `_paintRows` 가 `_noLayout` 을 풀며 스크롤을 되돌린다.
      this._paintRows();
    },{owner:this,label:'git.hist.layout'});
  },

  _stopLayout(){
    if(this._layoutT){this._layoutT.stop();this._layoutT=null}
  },

  _paintRows(){
    const list=this._list; if(!list) return;
    // 탭이 비활성인 사이에는 목록에 높이가 없다. 그 상태로 행 창을 잡으면 화면
    // 한 줄만 남기고 **펼친 상세와 스크롤 위치를 잃는다** — 높이가 설 때까지
    // 손대지 않는다.
    //
    // **되찾는 일을 바깥에 맡기지 않는다** (DRIFT_RECLAIM_SRS FR-DRC-14).
    // 종전에는 "elFor 가 루트를 붙인 뒤 한 번 더 부른다" 에 걸려 있었다 — 복구가
    // 바깥의 **두 번째 호출 하나**에 달려 있었고, 그 호출이 레이아웃보다 먼저
    // 닿으면 여기서 다시 돌아간다. 세 번째를 부를 사람은 없으므로 스크롤 위치와
    // 펼친 상세를 잃은 채로 남는다 — 탭을 떠났다 돌아온 사용자가 보던 자리를
    // 잃는 것이며, e2e H22 가 그 자리를 간헐로 잡아 왔다.
    if(!list.clientHeight){this._noLayout=true;this._awaitLayout(0);return}
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
      // FR-GDT-21: 커밋이 아직 없는 것과 필터에 걸리는 것이 없는 것은 **다른
      // 사실**이다. 서버가 그 둘을 가른다.
      empty.textContent=this._initial?GIT_HIST_NO_COMMITS:GIT_HIST_EMPTY;
      list.appendChild(empty);
    }else if(!showEmpty&&empty) empty.remove();
  },

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
  },

  /**
   * FR-GIT-233: HEAD 표식은 **살아 있는 관측에서 파생한다.**
   *
   * `git log` 의 decoration 은 목록을 받은 시점의 사실이다. 폴링이 물어 오는 HEAD
   * 변화(터미널에서 친 체크아웃)는 목록을 다시 받지 않으므로 그 표식이 그대로 낡는다 —
   * 눌러서 체크아웃한 배지의 표식이 움직이지 않는 것이 그것이었다.
   *
   * (ref 를 바꾼 **우리 쓰기**는 이제 목록까지 다시 받는다 — FR-GVR-20. 그래도 이
   * 파생은 남는다: 폴링으로 오는 변화가 그 경로를 지나지 않기 때문이다.)
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
  },

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
  },

  // 배지의 ref 는 `name` 이 곧 짧은 이름이다 (`shortRefName` 이 이미 뗐다).
  _refIsHead(r){return this._isHeadRef(r.kind,r.name,r.isHead)},

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
    //
    // FR-BMU-18: `upstream` 과 `oid` 는 **decoration 에 없다** — `git log` 는 ref 의
    // 이름과 종류만 싣는다. 그 둘은 refs 관측에서 가져온다. 없으면 이 진입점에서만
    // `delete-both` 가 늘 죽고(FR-BMU-11 이 upstream 을 본다) `delete` 의 hint 가
    // `git branch <이름> ` — 되살릴 수 없는 명령 — 이 된다 (FR-GIT-250.2).
    const target=()=>{
      const full=(this._refs||[]).find(x=>x&&x.kind===r.kind&&x.short===r.name)||{};
      return {short:r.name,name:r.name,kind:r.kind,isHead:this._refIsHead(r),
        upstream:full.upstream||'',oid:full.oid||''};
    };
    b.addEventListener('click',ev=>ev.stopPropagation());
    b.addEventListener('dblclick',ev=>{ev.stopPropagation();GitMenu.runPrimary(mkind,target())});
    b.addEventListener('contextmenu',ev=>{
      ev.preventDefault(); ev.stopPropagation();
      GitMenu.open(mkind,target(),ev);
    });
    return b;
  },

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
  },

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
  },

  // ── 스크롤·반응형 ──

  _onScroll(){
    this._paintRows();
    if(this._end||this._loading||this._err) return;
    // 로드 범위를 거르는 동안에는 늘리지 않는다 — 걸러낸 목록의 끝은 로드의 끝이
    // 아니다. 확장이 끝났으면 목록이 곧 서버의 답이므로 뒷장을 이어 받는다.
    if(this._q.trim()&&this._grep!==this._q.trim()) return;
    const l=this._list;
    if(l.scrollTop+l.clientHeight>=l.scrollHeight-GIT_LOG_NEAR_END_PX) this._load(true);
  },

  // FR-GIT-125: 그래프와 메시지는 항상 남는다.
  _fit(w){
    // 떼여 있는 동안의 폭 0 으로 컬럼을 전부 숨기지 않는다.
    if(!w) return;
    for(const b of GIT_HIST_BREAKS) this._list.classList.toggle(b.cls,w<b.w);
    this._paintRows();
  },

  // ── 날짜 (O12) ──

  _dateFmt(){
    if(this._df==null){
      let v=null; try{v=localStorage.getItem(GIT_DATE_FORMAT_KEY)}catch{}
      this._df=v===GIT_DATE_ABSOLUTE?GIT_DATE_ABSOLUTE:GIT_DATE_RELATIVE;
    }
    return this._df;
  },
});

Object.assign(GitHistory, {
  relTime(ms,now){
    const d=Math.max(0,(now||Date.now())-ms);
    for(const u of GIT_REL_UNITS){
      const n=Math.floor(d/u[0]);
      if(n>=1) return n+u[1]+' 전';
    }
    return GIT_REL_NOW;
  },

  absTime(ms){
    const d=new Date(ms), p=n=>String(n).padStart(2,'0');
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+
      p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  },
});
