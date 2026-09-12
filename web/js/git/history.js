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
 *
 * **이 파일은 탭의 골격이다** (FE_MODULE_BOUNDARY_SRS FR-FMB-32) — 마운트 ·
 * 팔레트(FR-GIT-119) · 상태 · 옵션 바. 나머지 넷은 갈라져 나갔다:
 *
 *   history-refs.js     refs 사이드바 (FR-GIT-122·123) — 그리기와 ref 선택
 *   history-rows.js     행 창 (FR-GIT-116) · 배지 · 레인 SVG (FR-GIT-118·119) · 날짜 (O12)
 *   history-detail.js   인라인 커밋 상세 (FR-GIT-135~139)
 *   history-load.js     질의 · 검색 (FR-GIT-129) · jump (FR-GIT-131)
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
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitHistory=GitHistory;
