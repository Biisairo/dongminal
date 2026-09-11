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
    this._again=false;     // 받는 도중에 온 다시 받기 (FR-SVS-39d)
    this._loadedSig=null;  // 지금 목록이 받아진 시각의 저장소 signature (FR-GVR-8a)
    this._err=null;
    this._note='';
    this._ref=null;        // 선택된 ref. _adopt 가 리포별 저장값으로 채운다
    this._order=GIT_HIST_ORDERS[0].key;
    this._filters={};
    this._reflog=false;
    this._q='';
    // FR-HSU-4·5: 지금 **서버에 실어 보낸** 검색어. `_q`(치는 중인 것)와 다르면
    // 아직 확장 전이고, 같으면 목록이 곧 저장소 전체의 답이다.
    this._grep='';
    // 디바운스 (FR-HSU-14). 리포가 바뀌면 함께 끈다 — 옛 검색어의 확장이 새
    // 저장소로 나가면 사용자가 치지 않은 질의가 목록을 거른다.
    TIMERS.cancel(this._qT);
    this._qT=null;
    this._expanding=false;
    this._rev=null;       // 입력이 해석된 리비전 (FR-HSU-6)
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
    this._layoutT=null;   // 높이가 서기를 기다리는 프레임 대기
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
      // FR-GHM-3: Changes 와 **같은 머리**다. 마크업도 배선도 GitPanel 이 한 자리에서
      // 만든다 — History 가 자기 것을 만들면 두 탭의 머리가 갈린다.
      // FR-GHM-3a (U-6, 2026-09-11): **원격 버튼은 싣지 않는다.** Changes 와
      // History 를 이제 함께 보므로 같은 버튼이 두 벌이었다 — 같은 일을 하는 자리가
      // 둘이면 어느 쪽을 눌렀는지가 결과와 무관해도 사용자는 그것을 모른다.
      GitPanel.headHTML({remote:false})+
      /**
       * FR-HSU-1·9: 바에 남는 것은 **검색 입력 · 옵션 버튼 · `+ Branch`** 셋이다.
       * 정렬·필터 넷·reflog·Apply 는 드롭다운으로 들어갔고, `.git-hist-jump` 와
       * `Go` 는 사라졌다 — 그 일은 검색이 흡수했다 (FR-HSU-6).
       */
      '<div class="git-hist-bar">'+
        '<span class="git-hist-search-box">'+
          '<input class="git-hist-search" type="text">'+
        '</span>'+
        '<button class="git-hist-opts"><span class="git-hist-opts-badge"></span></button>'+
        '<span class="git-hist-spacer"></span>'+
        // FR-HBB-1·2: 브랜치 생성 진입점. 여백 **뒤**다 — 왼쪽 무리는 목록을
        // 거르는 것들이고 이 버튼은 거기 속하지 않는다. 공용 머리(.git-head)에
        // 두지 않는 이유는 §2.2 다 — 그 자리는 Changes 와 공유한다.
        '<button class="git-hist-branch"></button>'+
      '</div>'+
      // FR-HSU-6: 입력이 실재하는 리비전이면 **결과 맨 위**에 그 줄이 선다.
      // 가상 목록 안에 끼우지 않고 목록 바로 위의 줄로 둔다 — 행 창의 좌표 계산이
      // 항목 수와 1:1 이어서, 목록에 없는 항목을 끼우면 그 계약이 깨진다.
      '<div class="git-hist-rev"></div>'+
      '<div class="git-hist-note">'+
        '<span class="git-hist-note-msg"></span>'+
        '<button class="git-hist-retry"></button>'+
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
        // FR-HSU-8: 지금 어느 범위를 보고 있는가.
        '<span class="git-hist-scope"></span>'+
        '<span class="git-hist-state"></span>'+
      '</div>';
    this.panel._wireHead(el);
    this._list=el.querySelector('.git-hist-list');
    this._spTop=el.querySelector('.git-hist-sp-top');
    this._spBot=el.querySelector('.git-hist-sp-bot');
    el.querySelector('.git-hist-search').placeholder=GIT_SEARCH_PLACEHOLDER;
    const brb=el.querySelector('.git-hist-branch');
    brb.textContent=GIT_HIST_BRANCH; brb.title=GIT_HIST_BRANCH_TITLE;
    const histRetry=el.querySelector('.git-hist-retry');
    histRetry.textContent=GIT_HIST_APPLY; histRetry.title=GIT_TIP_RETRY;
    const opts=el.querySelector('.git-hist-opts');
    opts.title=GIT_HIST_OPTS_TITLE;
    opts.insertBefore(UIKit.icon('sliders'),opts.firstChild);
    opts.addEventListener('click',ev=>this._openOpts(ev));
    // FR-HBB-4·6: 인자 없이 부르면 startRef 가 빈 값이고 서버가 HEAD 를 쓴다.
    // 커밋·ref 를 시작점으로 삼는 길은 우클릭 메뉴가 그대로 갖는다 (§2.3).
    brb.addEventListener('click',()=>this.panel.createBranchFrom());
    el.querySelector('.git-hist-retry').addEventListener('click',()=>{this._err=null;this._reload()});
    el.querySelector('.git-hist-search').addEventListener('input',ev=>this._search(ev.target.value));
    el.querySelector('.git-hist-search').addEventListener('keydown',ev=>{
      // Enter 는 디바운스를 기다리지 않겠다는 뜻이다 — 손을 멈춘 것과 같다.
      if(ev.key==='Enter'){TIMERS.cancel(this._qT);this._qT=null;this._expand()}
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
    this._stopLayout();
    if(this._ro){this._ro.disconnect();this._ro=null}
    this._el=null; this._list=null; this._detailEl=null;
    this._repo=undefined;
  }

  // ── 칠하기 ──

  paint(){
    if(!this._el) return;
    if(this.panel.repo!==this._repo) this._adopt();
    if(!this._el) return;
    // FR-DSP-1d: 뷰가 관측보다 늦게 서면 여기가 그 관측을 처음 읽는 자리다.
    this._syncStatus();
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
    if(!this._syncStatus()) return;
    // FR-GIT-248: 사이드바의 HEAD 표식도 같은 관측에서 파생한다. 이 경로는 refs 를
    // 다시 받지 않으므로(`_paintRefs` 의 뼈대가 그대로다) 표식만 고친다 —
    // 창 밖에서 체크아웃한 경우가 이 자리다.
    this._paintRefSel(this._el.querySelector('.git-refs'));
    this._paintRows();
  }

  /**
   * UX_BATCH6_SRS FR-DSP-1d: 관측에서 파생하는 값을 **지금의 관측**으로 맞춘다.
   * 바뀌었으면 true 다.
   *
   *   이전 동작: 이 파생은 `paintStatus` 안에만 있었고, 그것은 관측이 **바뀐**
   *             회차에만 불렸다 (`_applyStatus` 의 `_obsSig` 가드)
   *   새  동작: `paint()` 도 같은 자리를 지난다 — 뷰가 서는 순간 지금의 관측에서
   *             파생한다
   *   이유:     뷰는 관측보다 **늦게 설 수 있다.** 첫 관측 뒤에 History 를 열면
   *             `_dirtyN` 이 0 인 채로 남고, 저장소가 그대로면 관측도 그대로라
   *             다시 그릴 계기가 영영 오지 않는다 — 미커밋 행이 없는 채로 굳는다.
   *             사이드의 기본이 Changes 가 되며(FR-DSP-1) 첫 관측이 창을 여는
   *             즉시 나가게 되어 그 순서가 뒤집혔다 (ubuntu 러너 실측)
   */
  _syncStatus(){
    const n=this.panel.dirtyCount();
    // FR-GIT-233: HEAD 표식을 관측에서 파생하므로 HEAD 가 움직이면 행을 다시 그려야
    // 한다 — 미커밋 개수만 보면 체크아웃 직후의 표식이 낡은 채로 남는다.
    const h=this.panel.headName();
    const o=(this.panel.statusOf()||{}).oid||'';
    if(n===this._dirtyN&&h===this._headName&&o===this._headOid) return false;
    this._dirtyN=n; this._headName=h; this._headOid=o; this._ver++;
    return true;
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
    }
    /**
     * FR-HSU-10·13: 걸린 필터의 개수를 배지로 보인다.
     *
     * 접힌 채로도 목록이 걸러져 있음이 보여야 한다 — `filterPath` 로 들어온
     * 파일 히스토리가 바로 그 자리다. 드롭다운을 열지 않아도 그 사실이 보인다.
     */
    const b=el.querySelector('.git-hist-opts-badge');
    const n=this._optCount();
    b.textContent=n?String(n):'';
    b.hidden=!n;
    el.querySelector('.git-hist-opts').classList.toggle('on',!!n);
    // FR-GIT-132: 사유를 보이고 목록은 지우지 않는다.
    const note=el.querySelector('.git-hist-note');
    const msg=this._err||this._note;
    note.classList.toggle('vis',!!msg);
    note.querySelector('.git-hist-note-msg').textContent=msg||'';
    note.querySelector('.git-hist-retry').classList.toggle('vis',!!this._err);
    this._paintRev();
  }

  /**
   * FR-HSU-10: 걸린 필터의 수. 정렬은 세지 않는다 — 목록을 **거르는** 것이 아니라
   * 늘어놓는 방식이다. reflog 는 목록에 없던 것을 들여오므로 센다.
   */
  _optCount(){
    let n=0;
    for(const f of GIT_HIST_FILTERS) if((this._filters[f.key]||'').trim()) n++;
    if(this._reflog) n++;
    return n;
  }

  /**
   * FR-HSU-6·7: 입력이 실재하는 리비전이면 결과 위에 한 줄이 뜬다. 누르면 그리로
   * 간다 — `Go` 가 하던 일이 이 줄로 옮겨 왔다 (D-12).
   */
  _paintRev(){
    const box=this._el&&this._el.querySelector('.git-hist-rev'); if(!box) return;
    const c=this._rev;
    box.classList.toggle('vis',!!c);
    if(!c){box.innerHTML='';box.onclick=null;return}
    const sig=c.oid+'\u0001'+(c.subject||'');
    if(box.dataset.sig===sig) return;
    box.dataset.sig=sig;
    box.innerHTML='';
    const mark=document.createElement('span');
    mark.className='git-hist-rev-mark'; mark.textContent=GIT_SEARCH_REV_MARK;
    const oid=document.createElement('span');
    oid.className='git-hist-rev-oid'; oid.textContent=(c.oid||'').slice(0,7);
    const sub=document.createElement('span');
    sub.className='git-hist-rev-subject'; sub.textContent=c.subject||'';
    box.appendChild(mark); box.appendChild(oid); box.appendChild(sub);
    box.title=GIT_SEARCH_REV_TITLE;
    box.onclick=()=>this._jumpTo(c.oid);
  }

  /**
   * FR-HSU-9·11·12: 정렬·필터 넷·reflog·Apply 를 담는 드롭다운.
   *
   * `UIKit.menu` 규약을 쓴다 — 바깥 클릭·`Esc` 로 닫히는 자리가 한 곳이다
   * (FR-UIK-8·26). 컨트롤은 열 때마다 **새로 만든다**: 팩토리는 상태를 갖지
   * 않는다는 계약(FR-UIK-28 ①)을 지키고, 값의 진실은 `this._filters` 다.
   */
  _openOpts(ev){
    const rows=[];
    const ord=document.createElement('select');
    ord.className='ui-select git-hist-order';
    for(const o of GIT_HIST_ORDERS){
      const op=document.createElement('option'); op.value=o.key; op.textContent=o.label;
      ord.appendChild(op);
    }
    ord.value=this._order;
    ord.addEventListener('change',e=>{this._order=e.target.value;this._reload()});
    rows.push({el:UIKit.field({label:GIT_HIST_OPTS_ORDER,control:ord})});
    rows.push({sep:true});
    const inputs=[];
    for(const f of GIT_HIST_FILTERS){
      const i=document.createElement('input');
      i.type='text'; i.className='ui-input git-hist-f'; i.dataset.f=f.key;
      i.value=this._filters[f.key]||'';
      // FR-HSU-12: 드롭다운 안의 `Enter` 는 `Apply` 와 같다 (현행 유지).
      i.addEventListener('keydown',e=>{if(e.key==='Enter')this._applyOpts(inputs)});
      inputs.push(i);
      rows.push({el:UIKit.field({label:f.label,control:i})});
    }
    rows.push({sep:true});
    const rf=document.createElement('input');
    rf.type='checkbox'; rf.checked=this._reflog;
    rf.addEventListener('change',e=>{this._reflog=e.target.checked;this._reload()});
    const rfRow=UIKit.field({label:GIT_HIST_REFLOG,control:rf});
    rfRow.title=GIT_HIST_REFLOG_TITLE;
    rows.push({el:rfRow});
    const apply=UIKit.button({label:GIT_HIST_APPLY,title:GIT_HIST_APPLY_TITLE,
      kind:'primary',cls:'git-hist-apply',onClick:()=>this._applyOpts(inputs)});
    const wrap=document.createElement('div');
    wrap.className='git-hist-opts-foot'; wrap.appendChild(apply);
    rows.push({el:wrap});
    const r=ev.currentTarget.getBoundingClientRect();
    UIKit.menu(rows,{at:{x:r.left,y:r.bottom+2},cls:'git-hist-optsmenu'});
  }

  _applyOpts(inputs){
    for(const i of inputs) this._filters[i.dataset.f]=i.value.trim();
    UIKit.closeMenu();
    this._err=null;
    this._reload();
  }

  _paintFoot(){
    const el=this._el;
    const n=el.querySelector('.git-hist-loaded');
    n.dataset.n=String(this._commits.length);
    n.textContent=GIT_HIST_LOADED_N.replace('%n',String(this._commits.length));
    // FR-HSU-8: **지금 무엇을 보고 있는가.** 확장 전에는 불러온 범위를 거른
    // 결과이고, 확장 뒤에는 저장소 전체의 답이다 — 그 둘이 구분되지 않으면
    // "없다" 와 "아직 안 받았다" 가 같은 화면이 된다.
    const q=this._q.trim();
    const sc=el.querySelector('.git-hist-scope');
    sc.textContent=!q?''
      :this._expanding?GIT_SEARCH_SCOPE_WIDENING
      :this._grep===q?GIT_SEARCH_SCOPE_REPO.replace('%m',String(this._view.length))
      :GIT_SEARCH_SCOPE_LOADED.replace('%n',String(this._commits.length))
        .replace('%m',String(this._view.length));
    sc.classList.toggle('vis',!!sc.textContent);
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
  }

  _stopLayout(){
    if(this._layoutT){this._layoutT.stop();this._layoutT=null}
  }

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
    const r=await apiGet(path+'?'+q.toString());
    if(!r.ok) return null;
    return r.data;
  }

  // 응답이 내 요청의 짝인지 본다 (FR-GIT-133·145). isStale 과 두 겹이다 — 세대만
  // 보면 같은 리포에서 필터를 바꿨을 때 뒤늦게 온 이전 응답을 자기 것으로 읽는다.
  _sameReq(got,sent){
    for(const k of Object.keys(sent))
      if(String(got[k]===undefined?'':got[k])!==String(sent[k])) return false;
    return true;
  }

  /**
   * FR-SVS-39d: 받는 도중에 온 **전체 다시 받기**는 버리지 않는다 — 끝난 뒤 한 번
   * 더 받는다.
   *
   * 단순히 `_loadP` 를 돌려주면 그 요청은 **앞선 요청의 결과**를 받는데, 그것은
   * 요청 이전의 저장소다. 폴링이 새 커밋을 잡아 `reload()` 를 불렀는데 첫 로드가
   * 아직 오는 중이면 새 커밋은 화면에 오지 않고, 다음 계기는 없다 — 저장소는 이미
   * 그 상태라 관측이 다시 움직이지 않는다 (TC-SVS-60 · Windows 러너 실측: 첫 로드가
   * 느린 곳에서 결정적으로 났다). 추가 로드(`more`)는 대상이 아니다 — 그것은 같은
   * 목록의 뒷장이다.
   */
  _load(more){
    if(this._loading){ if(!more) this._again=true; return this._loadP }
    this._loadP=this._doLoad(more).then(()=>this._drain(),()=>this._drain());
    return this._loadP;
  }

  // 미룬 다시 받기 하나, 또는 받는 사이에 관측이 지나간 경우 (FR-GVR-8a: 기준선이
  // 이 로드 중에 도착했으면 `_reloadStaleViews` 는 아직 모른다고 보고 지나갔다).
  // 리포가 바뀌었거나 뷰가 내려갔으면 뜻이 없다 — `_adopt` 가 새 리포를 처음부터
  // 받는다.
  _drain(){
    if(!this._again&&!this.staleFor(this.panel._lastSig)) return;
    this._again=false;
    if(!this._el||this.panel.repo!==this._repo) return;
    return this._load(false);
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
      // FR-HSU-5: 저장소 전체 확장은 `--grep` 갈래다 (D-13). 작성자로 전체를
      // 찾는 일은 옵션의 `Author` 가 정확히 한다.
      grep:this._grep,
      // 꺼졌을 때도 보낸다 — requested 로 되돌아와야 늦게 온 응답이 어느 토글의
      // 것인지 _sameReq 가 가른다.
      reflog:this._reflog,
    };
    // 받는 동안은 모른다 — 낡음 판정(`staleFor`)이 이전 목록의 값으로 이 로드를
    // 또 부르지 않게 한다. 뒷장(`more`)은 같은 목록이라 값을 바꾸지 않는다.
    if(!more) this._loadedSig=null;
    this._loading=true; this._err=null;
    this._paintBar(); this._paintFoot();
    /**
     * FR-SVS-39c: 응답이 어떻게 끝나든 **잠금은 푼다.**
     *
     * `_load` 는 `if(this._loading) return this._loadP` 로 시작한다. 낡은 응답을
     * 버리면서 잠금까지 들고 나가면 그 뒤의 모든 로드가 삼켜져 **커밋 목록이 영영
     * 멎는다** — 그때도 왼쪽 refs 는 `_loadRefs()` 라는 별도 경로라 계속 갱신되므로,
     * 화면에는 "한쪽만 살아 있는" 모양으로 나타난다 (접수한 관찰).
     */
    let d=null;
    try{ d=await this._get('/api/git/log',sent) }
    finally{ this._loading=false }
    if(this.panel.isStale(tok)) return;
    if(!d||!d.requested||!this._sameReq(d.requested,sent)){
      // FR-GIT-132: 사유를 보이고 **이미 로드된 목록을 지우지 않는다.**
      this._err=GIT_HIST_LOAD_FAIL; this.paint(); return;
    }
    const got=Array.isArray(d.commits)?d.commits:[];
    // limit 은 실효값이다 — 요청값으로 끝을 판정하면 상한 클램프에서 어긋난다.
    const eff=d.limit||sent.limit;
    this._commits=more?this._commits.concat(got):got;
    this._end=got.length<eff;
    // FR-GVR-8a: 이 목록은 서버가 `git log` 직후에 읽은 저장소의 것이다.
    if(!more) this._loadedSig=(typeof d.signature==='string'&&d.signature)||null;
    this._rebuild();
    this.paint();
  }

  /**
   * FR-GVR-8a: 이 목록이 관측보다 **낡았는가.** 목록이 받아진 시각의 signature 와
   * 관측의 signature 가 다르면 그 사이에 저장소가 움직였다. 둘 중 하나를 모르면
   * (받는 중이거나 관측이 아직 없으면) 판정하지 않는다.
   */
  staleFor(sig){
    return !!this._loadedSig&&!!sig&&this._loadedSig!==sig;
  }

  // ref 를 바꾼 쓰기 뒤에 사이드바를 다시 채운다 (FR-GIT-160). 목록은 _adopt 에서만
  // 받으므로 이것이 없으면 checkout 한 브랜치가 사이드바에 나타나지 않는다.
  reloadRefs(){
    if(this._el&&this.panel.repo===this._repo) this._loadRefs();
  }

  /**
   * FR-GIT-267: 비교 기준으로 표시한 커밋을 바에 적는다. 표시가 보이지 않으면
   * 사용자는 자기가 무엇을 골랐는지 모른 채 Compare with 를 연다.
   *
   * `_note` 를 쓴다 — 그것이 이미 "목록을 지우지 않고 사실을 보이는" 자리이고
   * (FR-GIT-132), 같은 뜻의 자리를 두 벌로 만들면 한쪽만 고쳐진다.
   */
  noteCompareMark(label){
    if(!this._el) return;
    this._note=label?GIT_CO_COMPARE_MARKED.replace('%s',label):'';
    this._paintBar();
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

  /**
   * FR-GIT-275: 그 경로의 커밋만 보인다 (File history).
   *
   * **새 조회를 만들지 않는다** — path 필터가 이미 있으므로(FR-GIT-129) 그것을
   * 채워 다시 받는 것이 전부다. 입력에도 값을 넣는 이유는 사용자가 왜 목록이
   * 좁아졌는지 보고 지울 수 있어야 하기 때문이다.
   */
  filterPath(path){
    if(!path) return;
    // **_adopt 의 reset 이 필터를 지운다.** 아직 이 리포를 받지 않았다면 여기서
    // 받아들이되 거르지 않은 목록을 먼저 받지는 않는다 — 두 요청이 겹치면 나중에
    // 온 쪽이 이겨 필터가 무시된 목록이 남는다.
    if(this.panel.repo!==this._repo){
      this._repo=this.panel.repo;
      this.reset();
      if(!this._repo) return;
      this._ref=this._savedRef();
      this._loadRefs();
    }
    this._filters.path=path;
    this._barRepo=null;   // _paintBar 가 입력값을 필터에서 다시 채운다
    this._err=null;
    return this._reload();
  }

  // ── 검색 (FR-GIT-129, 검증 V49) ──

  /**
   * FR-HSU-3·4·14: 치는 동안은 **불러온 범위**를 즉시 거르고, 손이 멎으면 한 번만
   * 저장소 전체로 넓힌다. 사용자가 모드를 고르는 손잡이는 없다 (D-6).
   */
  _search(v){
    this._q=v;
    this._rebuild();
    this._paintBar(); this._paintFoot(); this._paintRows();
    TIMERS.cancel(this._qT);
    this._qT=TIMERS.after(GIT_SEARCH_DEBOUNCE_MS,()=>{this._qT=null;this._expand()},
      {owner:this,label:'hist-search'});
  }

  /**
   * 손이 멎었다. 둘을 한다 — 리비전으로 해석해 보고(FR-HSU-6), 아직 그 말로 묻지
   * 않았으면 저장소 전체로 넓힌다(FR-HSU-4).
   *
   * 넓히기가 **한 번**인 근거가 `_grep===q` 다 (FR-HSU-14): 같은 물음을 다시
   * 보내지 않으므로, 글자를 지웠다 같은 말로 되돌아와도 왕복이 생기지 않는다.
   */
  async _expand(){
    if(!this._el||!this._repo) return;
    const q=this._q.trim();
    await this._revLookup(q);
    if(!this._el||this._q.trim()!==q) return;
    /**
     * **리비전으로 해석된 말은 넓히지 않는다.**
     *
     * `--grep` 은 커밋 **메시지**를 찾는다 (D-13). 해시나 ref 이름을 그 갈래로
     * 보내면 서버는 0건을 돌려주고, 그 0건이 목록을 비워 방금 뜬 리비전 줄이
     * 가리키는 커밋조차 목록에서 사라진다 — 누를 곳으로 갈 수 없게 된다
     * (실측: 로드 범위 밖 해시로 이동하는 e2e 가 여기서 멎었다).
     *
     * 리비전 줄이 곧 그 물음의 답이므로 넓힐 이유도 없다.
     */
    if(this._rev) return;
    if(this._grep===q) return;
    this._grep=q;
    this._err=null;
    this._expanding=true; this._paintFoot();
    try{ await this._reload() }
    finally{
      this._expanding=false;
      if(this._el) this._paintFoot();
    }
  }

  /**
   * FR-HSU-6 / D-12: **리비전 해석은 검색을 대신하지 않고 얹힌다.**
   *
   * rev-parse 전용 라우트가 없다 — `/api/git/log?ref=<rev>&limit=1` 이 해석과
   * 검증을 함께 하고, 없는 리비전은 404 라 `_get` 이 null 을 준다. 그러므로
   * "없다" 는 오류가 아니며 사유를 화면에 적지 않는다.
   */
  async _revLookup(q){
    if(!q||!this._repo){this._rev=null;this._paintRev();return}
    const tok=this.panel.token();
    const d=await this._get('/api/git/log',{repo:this._repo,ref:q,limit:1});
    if(this.panel.isStale(tok)||!this._el) return;
    // 늦게 온 응답이 지금 치고 있는 말을 덮지 않는다.
    if(this._q.trim()!==q) return;
    const c=(d&&Array.isArray(d.commits)&&d.commits.length)?d.commits[0]:null;
    this._rev=c||null;
    this._paintRev();
  }

  // 로드 범위 검색이 걸러낸 목록으로 레인을 다시 잡는다. 걸러낸 목록의 부모는
  // 목록 밖에 있을 수 있으므로 그래프는 그 범위 안에서만 뜻을 갖는다.
  _rebuild(){
    // 확장이 끝난 뒤에는 목록 자체가 그 물음의 답이다 — 그 위에 다시 거르면
    // 서버가 찾아 준 것을 클라이언트의 좁은 규칙이 도로 걸러낸다.
    const q=(this._grep===this._q.trim())?'':this._q.trim().toLowerCase();
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

  /**
   * FR-HSU-7: 그 커밋으로 간다. 로드 범위 밖이면 나올 때까지 받는다 — `_jump` 의
   * 로직은 남고, 대상을 **입력이 아니라 oid** 로 받는 것만 달라졌다.
   */
  async _jumpTo(oid){
    if(!oid||!this._repo) return;
    const tok=this.panel.token();
    this._note=GIT_JUMP_SEARCHING; this._err=null; this._paintBar();
    // 상한을 둔다 — 없는 것을 끝없이 받아 오지 않는다.
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
    TIMERS.cancel(this._flashT);
    this._flashT=TIMERS.after(GIT_JUMP_FLASH_MS,()=>{
      this._flashT=null;
      if(this._jumped!==oid) return;
      this._jumped=null; this._ver++; this._paintRows();
    },{owner:this,label:'jump-flash'});
  }

  // ── 스크롤·반응형 ──

  _onScroll(){
    this._paintRows();
    if(this._end||this._loading||this._err) return;
    // 로드 범위를 거르는 동안에는 늘리지 않는다 — 걸러낸 목록의 끝은 로드의 끝이
    // 아니다. 확장이 끝났으면 목록이 곧 서버의 답이므로 뒷장을 이어 받는다.
    if(this._q.trim()&&this._grep!==this._q.trim()) return;
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
