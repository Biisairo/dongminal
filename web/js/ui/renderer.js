/**
 * Remote Terminal — layout → DOM renderer
 * App 의 render / _rSidebar / _rTopbar / _rLayout / _buildNode / _buildPane
 * / _buildSp / _handle 책임을 분리. Renderer 내부 메서드 호출은 this.X 로,
 * App 상태·메서드는 this.app.X 로 접근한다. 동작은 1:1 보존.
 */
// `#area` 에서 이 렌더러가 임자인 요소들. 나머지는 남의 것이므로 건드리지 않는다.
const LAYOUT_CLASSES=['sp','pn','ed-win','slot','slot-handle'];

class Renderer {
  constructor(app){
    this.app = app;
    /**
     * PANE_DOM_RECONCILE_SRS FR-PDR-1: 키 → 골격 요소.
     *
     * `render()` 는 레이아웃을 **다시 짓지 않는다.** 같은 자리에 같은 것이 다시
     * 오면 그때 만든 요소를 그대로 쓴다. 골격이 남으면 그 안의 라이브 위젯
     * (xterm·편집기·Git 패널·Run 뷰)이 DOM 에서 움직이지 않고, 움직이지 않으면
     * 스크롤을 갈무리했다 되돌릴 일 자체가 없다 (SRS §2.3 의 결함이 사라지는
     * 자리다).
     */
    this._dom = new Map();
    // 이번 그리기에서 쓰인 키. 쓰이지 않은 것은 끝에서 거둔다.
    this._domUsed = new Set();
    // 이번 그리기에서 pane 본문에 붙은 위젯 요소들 (FR-PDR-9).
    this._mounted = new Set();
    // 이번 그리기에서 **실제로 부모가 바뀐** 터미널 (FR-PDR-10). 사후 처리는
    // 이 목록에만 적용한다 — 재사용된 것은 건드리지 않는다.
    this._moved = [];
  }

  /**
   * FR-PDR-1: 키로 골격을 재사용한다. 없을 때만 `make()` 로 만든다.
   *
   * 이벤트 배선은 `make()` 안에서만 한다 (FR-PDR-7). 재사용할 때마다 다시 걸면
   * 클릭 한 번이 두 번 동작하고, 걸지 않으면 낡은 클로저를 본다 — 그래서
   * 핸들러가 읽는 가변 컨텍스트는 클로저가 아니라 요소에 붙인다 (FR-PDR-8).
   */
  _keep(key,make){
    let el=this._dom.get(key);
    if(!el){ el=make(); this._dom.set(key,el) }
    this._domUsed.add(key);
    return el;
  }

  /**
   * FR-PDR-1·3: `parent` 의 자식을 `list` 로 맞춘다.
   *
   * **이미 그 자리에 있는 것은 건드리지 않는다.** 같은 부모에 `appendChild` 를
   * 다시 부르는 것도 DOM 에서는 떼었다 붙이는 것이며, 그 한 번에 스크롤이
   * 사라진다 — 이 함수의 존재 이유가 그 한 줄을 없애는 것이다.
   */
  _place(parent,list){
    let ref=parent.firstChild;
    for(const el of list){
      if(ref===el){ ref=el.nextSibling; continue }
      parent.insertBefore(el,ref);
    }
    while(ref){ const next=ref.nextSibling; ref.remove(); ref=next }
  }

  /**
   * `#area` 전용 배치. 그 자리에는 레이아웃 말고도 남의 보관물이 온다 — Git 패널이
   * 창을 닫을 때 자기 뷰를 여기로 물린다 (`panel-life` 의 `detach`). `_place` 로
   * 쓸면 그것까지 지우므로, **레이아웃 요소만** 대상으로 삼는다.
   */
  _placeLayout(parent,list){
    const mine=el=>LAYOUT_CLASSES.some(c=>el.classList.contains(c));
    for(const c of [...parent.children]) if(mine(c)&&!list.includes(c)) c.remove();
    let prev=null;
    for(const el of list){
      const want=prev?prev.nextSibling:parent.firstChild;
      if(el!==want) parent.insertBefore(el,want);
      prev=el;
    }
  }

  // 이번 그리기에서 쓰이지 않은 골격을 거둔다. 그 안에 있던 라이브 위젯은
  // 인스턴스가 잡고 있으므로 사라지지 않는다 — 다시 쓰일 때 옮겨 붙는다.
  _domGC(){
    for(const [k,el] of [...this._dom]){
      if(this._domUsed.has(k)) continue;
      this._dom.delete(k);
      if(el&&el.remove) el.remove();
    }
  }

  /**
   * FR-PDR-11·12: 옮기기 **직전**의 시선. 절대 위치보다 먼저 "맨 아래에 붙어
   * 있었는가"를 적는다 — 출력이 흐르는 터미널에서는 그것만이 뜻을 잃지 않는다.
   */
  _grabScroll(p){
    const rec={p,atBottom:true,y:0,top:0,alt:false};
    try{
      const buf=p.term&&p.term.buffer.active;
      if(buf){
        rec.alt=buf.type==='alternate';
        rec.y=buf.viewportY;
        rec.atBottom=buf.viewportY>=buf.baseY;
      }
      const vp=p.el.querySelector('.xterm-viewport');
      if(vp) rec.top=vp.scrollTop;
    }catch{}
    return rec;
  }

  /**
   * FR-PDR-10~12: 옮겨진 터미널 하나의 시선을 되돌린다.
   *
   * 맨 아래에 있었으면 **맨 아래로** 보낸다. 그 사이 출력이 들어와 버퍼가 길어졌어도
   * 옳은 자리이며, 라인 번호로 되돌리면 그 순간 `ydisp !== ybase` 가 되어 xterm 이
   * 이후 출력을 따라가지 않는다 (§2.3).
   *
   * 대체 화면에는 되돌릴 스크롤이 없다. 그 위에 픽셀을 대입하면 해가 된다.
   */
  _restoreScrollOf(rec){
    const p=rec&&rec.p;
    if(!p||!p.term||!p.el.classList.contains('vis')) return;
    try{
      const buf=p.term.buffer.active;
      if(rec.alt||buf.type==='alternate') return;
      if(rec.atBottom){ p.term.scrollToBottom(); return }
      const max=Math.max(0,buf.length-p.term.rows);
      const target=Math.min(Math.max(0,rec.y),max);
      // xterm 은 `scrollToLine(ydisp)` 를 무시하므로(early return) 한 번 흔들어
      // `_onScroll` 을 깨운다 — 그래야 DOM 의 scrollTop 이 함께 맞는다.
      if(target>0){ p.term.scrollToTop(); p.term.scrollToLine(target) }
      else if(max>0){ p.term.scrollToBottom(); p.term.scrollToTop() }
      const vp=p.el.querySelector('.xterm-viewport');
      if(vp&&rec.top) vp.scrollTop=rec.top;
    }catch{}
  }

  render(){
    const oldFocus=this.app._prevFocus;
    this.app._prevFocus=this.app.focused;
    if(oldFocus!==undefined&&oldFocus!==this.app.focused){
      this.app._clearAllSearchDecorations();
      this.app._researchIfOpen();
    }
    this.app._applyMobileMode();
    this._rSbTabs();this._rLists();this._rTopbar();this._rLayout();
    // UX_BATCH6_SRS FR-SCR-2: 갈무리해 둔 스크롤을 되돌린다. **여기여야 한다** —
    // 요소가 문서에 붙은 뒤에만 `scrollTop` 이 값을 받는다.
    this._restoreScroll();
    this.app._updateCwd();
    this.app._updateStatusBar();
    // Apply window focus overlay after every render so the DOM is
    // guaranteed to exist (BroadcastChannel may trigger _applyFocusOverlay
    // before the first render completes).
    this.app._applyFocusOverlay();
    // UX_BATCH9_SRS FR-GLR-1: 그리고 난 자리에서 묻는다 — 지금 보이는 표면의
    // 관측이 멎어 있지는 않은가. 표면 판정이 정확하려면 레이아웃이 선 **뒤**여야
    // 한다.
    this.app._gitWatchdogAll();
  }

  /**
   * UX_BATCH6_SRS FR-SCR-1: 다시 붙을 캐시 DOM 의 스크롤을 갈무리한다.
   *
   *   이전 동작: `_rSide` 가 `.ed-side-body` 를 매 render 마다 새로 만들고 캐시된
   *             `.git-view` 를 그리로 옮겼다. 문서에서 떼는 순간 그 하위의
   *             스크롤 위치는 브라우저가 버린다 — 변경 하나를 클릭할 때마다
   *             목록이 맨 위로 돌아간 자리가 그것이다 (SRS §2.6)
   *   새  동작: 옮기기 **전에** 재고, render 가 끝난 뒤 되돌린다
   *   이유:     터미널은 이미 같은 대비를 갖고 있다 (`_rLayout` 의
   *             `.xterm-viewport`). 없던 것이 git 뷰 쪽이다
   *
   * **어느 것이 스크롤러인지 묻지 않는다** — 하위 전부를 훑는다. 렌더러가
   * `.git-files` 같은 안쪽 이름을 알면 CSS 가 바뀔 때마다 여기가 낡는다.
   *
   * FR-SCR-4: 0 은 기록하지 않는다. 복원할 것이 없고, 새로 그려진 요소의 자연스러운
   * 자리를 0 으로 덮는 일도 없어야 한다.
   */
  _keepScrollAll(){
    const keep=this._scrollKeep=[];
    const push=n=>{
      const t=n.scrollTop,l=n.scrollLeft;
      if(t||l) keep.push([n,t,l]);
    };
    const take=el=>{
      // 이미 떼여 있으면 잴 것이 없다 — 떨어진 요소의 `scrollTop` 은 0 이다.
      if(!el||!el.isConnected) return;
      push(el);
      for(const n of el.querySelectorAll('*')) push(n);
    };
    const app=this.app;
    // git 뷰 — 사이드의 Changes 와 본문의 여섯 (FR-SCR-3).
    //
    // **탐색기와 터미널은 여기 없다.** 둘은 이미 자기 대비를 갖고 있다 —
    // `FileTree.mount` 의 `_scrollY`(FR-EDT-68)와 `_rLayout` 의
    // `.xterm-viewport`. 같은 일을 두 벌로 하면 어느 쪽이 이겼는지 말할 수 없다.
    if(app._gitPanels) for(const p of app._gitPanels.values()) for(const el of p._els.values()) take(el);
  }

  _restoreScroll(){
    const list=this._scrollKeep; this._scrollKeep=null;
    if(!list) return;
    for(const [n,t,l] of list){
      // 이번 render 에서 결국 붙지 않은 요소는 되돌릴 자리가 없다.
      if(!n.isConnected) continue;
      if(t) n.scrollTop=t;
      if(l) n.scrollLeft=l;
    }
  }

  /**
   * GIT_SIDEBAR_TABS_SRS FR-SBT-1·14: 사이드바 탭 바.
   *
   * 그리기 전에 **활성 창 → 탭**을 맞춘다 (FR-SBT-14). 반대 방향(탭 → 창)은
   * `SidebarTabs.setTab` 이 하며, 재진입 가드가 둘이 서로를 부르는 순환을 끊는다
   * (§3.9.2, V-SBT-10).
   */
  _rSbTabs(){
    this.app._sbSyncTabToWindow();
    SidebarTabs.paint(this.app);
  }

  /**
   * FR-RPT-3: 목록을 비우고 다시 만들지 않는다.
   *
   * `render()` 는 사용자 행동뿐 아니라 **SSE `workspace_changed`** 로도 불린다 —
   * 다른 브라우저나 다른 에이전트의 `dmctl` 이 워크스페이스를 고치면 사용자가
   * 아무것도 하지 않았는데 이 목록이 다시 만들어진다. 그러면 hover 로만 보이는
   * `×` 가 사라지고, 이름변경 더블클릭의 두 번째 클릭이 새 요소에 떨어지고,
   * 끌고 있던 창이 DOM 에서 빠져 재배치가 조용히 실패한다.
   */
  /**
   * EDITOR_TAB_SRS FR-EDT-4 / D-12: 목록 렌더는 **서술자 배열의 순회**다.
   *
   * 지금까지 탭 id 문자열이 두 번 하드코딩돼 있었고(§2.1), 셋째 탭이 목록을
   * 가지는 순간 걸렸다. 하드코딩으로 셋째를 더하면 넷째에서 같은 일이 반복되므로
   * 여기서 파생시킨다 — `list` 를 가진 서술자 전부를 그린다.
   */
  _rLists(){
    for(const d of SB_TAB_DEFS) if(d.list) SidebarList.paint(this.app,d);
  }

  // UX_REVISION_SRS FR-BLP-1: 두 이름이 남아 있는 이유는 호출처(SSE·알람·git 폴링)가
  // 이름으로 부르기 때문이다 — 그 배선을 바꾸는 것은 이 SRS 의 일이 아니다.
  // reconcile 이므로 값이 그대로면 DOM 은 손대지 않는다 (FR-RPT-3).
  _rSidebar(){ this._rLists() }
  // 리포 목록이 바뀌면 상단 이름의 근거도 바뀐다 — Git 창의 이름은 그 목록에서
  // 온다(`_rWinName`). 창이 먼저 뜨고 목록이 나중에 오는 순서가 흔하다.
  _rGitSection(){ this._rLists(); this._rTopbar() }

  /**
   * 상단에 적히는 창 이름.
   *
   * Window·Editor 는 창 자체가 대상이라 저장된 이름이 곧 목록의 이름이다. Git 만
   * 파생이다 — 창은 하나인데 리포를 갈아타므로, 저장된 이름(`Git`)은 지금 무엇을
   * 보고 있는지 말해 주지 않는다. 나머지 둘은 상단만 봐도 어느 것인지 아는데 Git
   * 만 그러지 못했다.
   *
   * 이름의 출처는 **사이드바 목록과 같은 자리**다 (`_gitRepos.pinned` 의 `name`).
   * 여기서 경로를 따로 잘라 쓰면 목록과 상단이 같은 리포를 다른 이름으로 부를 수
   * 있다. 목록이 아직 오지 않았을 때만 경로의 마지막 조각으로 대신한다.
   */
  _rWinName(w){
    const app=this.app;
    if(!w) return '';
    if(!app._isGitWin(w)) return w.name||'';
    const repo=(w.git&&w.git.repo)||'';
    if(!repo) return w.name||'';
    const pinned=((app._gitRepos||{}).pinned)||[];
    const hit=pinned.find(e=>e&&e.path===repo);
    return (hit&&hit.name)||app._edBase(repo)||w.name||'';
  }

  /**
   * 창의 표시 제목 — `<타입 라벨> · <창 이름>` (FR-STB-1).
   *
   * **조립하는 자리는 여기 하나다** (FR-STB-4). 토프바와 슬롯 머리글이 각자
   * 만들던 동안 Git 창은 두 자리에서 다른 이름으로 불렸다 — 토프바는 리포명,
   * 머리글은 저장된 `Git`. 형식을 바꾸는 이번에도 자리를 둘로 남기면 같은 결함이
   * 다시 자란다.
   *
   * 이름이 라벨과 같으면 겹쳐 적지 않는다 (`Git · Git` 이 되지 않도록).
   */
  _rWinTitle(w){
    if(!w) return '';
    const label=SidebarTabs.labelForWindow(this.app,w);
    const name=this._rWinName(w);
    if(!label) return name;                 // FR-STB-6: 모르는 타입이면 이름만
    if(!name||name===label) return label;
    return label+' · '+name;
  }

  _rTopbar(){
    const a=this.app._aw();
    // FR-STB-11·12: 칸이 하나면 토프바가 제목을 낸다. 칸이 여럿이면 머리글이 그
    // 자리를 이어받으므로 토프바는 **비운다** — 되풀이하면 그 값이 어느 칸의
    // 것인지 사용자가 매번 판정해야 한다 (D-1). 모바일에는 칸이 없다 (FR-STB-14).
    const multi=!this.app.isMobile&&this.app.slotCount()>1;
    document.getElementById('window-name').textContent=multi?'':this._rWinTitle(a);
    // FR-GIT-180: Git 창에서는 분할 진입점을 감춘다. (FR-GIT-183 의 `Close Git`
    // 은 폐기됐다 — 떠나는 길이 사이드바 탭으로 상시 존재한다, FR-SBT-34.)
    const isGit=this.app._isGitWin(a);
    // FR-EDT-50: Editor 창에서도 분할 진입점을 감춘다 — 분할이 생기는 유일한
    // 길은 드래그드롭이다 (FR-EDT-51). 눌리지만 아무 일도 하지 않는 버튼은
    // 고장으로 읽힌다.
    const noSplit=isGit||this.app._isEditorWin(a);
    for(const id of ['split-h','split-v']){
      const b=document.getElementById(id);
      if(b) b.classList.toggle('git-hidden',noSplit);
    }
    // FR-EDT-54: Editor 창에는 편집기 탭만 있다 — 새 탭 버튼의 대상이 없다.
    const mAdd=document.getElementById('m-add-tab');
    if(mAdd) mAdd.classList.toggle('git-hidden',noSplit);
    const ind=document.getElementById('m-pane-indicator');
    if(ind){
      const n=this.app._mobilePaneCount();
      if(n<=0){ind.textContent='0/0'}
      else{
        if(this.app._mPaneIdx>=n) this.app._mPaneIdx=n-1;
        if(this.app._mPaneIdx<0) this.app._mPaneIdx=0;
        ind.textContent=`${this.app._mPaneIdx+1}/${n}`;
      }
    }
    const dt=document.getElementById('m-drawer-toggle');
    // UI_KIT_SRS FR-GLY-4: 글자가 아니라 아이콘이므로 `textContent` 로 바꿀 수
    // 없다 — 그 대입은 `<svg>` 를 지운다.
    if(dt) dt.replaceChildren(UIKit.icon(this.app._drawerOpen?'x':'menu'));
    // FR-WSL-50·62: 칸 더하기·빼기. 모바일에는 칸을 만드는 길이 없다.
    // 한계에 닿은 버튼은 비활성이다 — 눌리지만 아무 일도 하지 않는 버튼은
    // 고장으로 읽힌다 (FR-GIT-180 이 세운 규약).
    const n=this.app.slotCount();
    const sa=document.getElementById('slot-add');
    if(sa){
      sa.classList.toggle('git-hidden',this.app.isMobile);
      sa.disabled=n>=SLOT_MAX;
    }
    const sr=document.getElementById('slot-remove');
    if(sr){
      sr.classList.toggle('git-hidden',this.app.isMobile);
      sr.disabled=n<=1;
    }
  }

  _rLayout(){
    const area=document.getElementById('area');
    const app=this.app;
    // FR-SCR-1: **무엇보다 먼저** 잰다 — git 뷰의 스크롤이다. 터미널은 이제
    // 움직이지 않으므로 여기 없다 (PANE_DOM_RECONCILE_SRS FR-PDR-20).
    this._keepScrollAll();
    // FR-PDR-1·9: 이번 그리기의 장부를 연다. `_moved` 는 여기서 비우지 않는다 —
    // 프레임이 오기 전에 다시 그려지면 그 이동이 장부에서 사라진다.
    this._domUsed=new Set();
    this._mounted=new Set();
    // WINDOW_SLOTS_SRS FR-WSL-4·60: 단일 슬롯 모드와 모바일에서는 슬롯 컨테이너를
    // 만들지 않는다. `.sp`·`.pn` 의 `inset:0` 이 딛는 조상이 바뀌면 기존 e2e 가
    // 전부 그 위에 서 있으므로(D-4), 슬롯이 1개일 때의 DOM 은 지금과 같아야 한다.
    const slots=(!app.isMobile&&app.slots)?app.slots:null;
    if(!slots){
      area.removeAttribute('data-slotdir');
      this._rSlot=0;
      this._rWindowInto(app._aw(),area);
    }else{
      area.dataset.slotdir=app.slotDir;
      const n=app.slotCount();
      // 골격을 먼저 세워 자리에 놓고, 본문은 그다음에 채운다 — 붙기 전에 채우면
      // 첫 그리기에서 문서 밖의 요소를 재는 코드가 생긴다.
      const kids=[],bodies=[];
      for(let i=0;i<n;i++){
        const el=this._keep('slot:'+i,()=>this._makeSlot(i));
        const win=app._slotWindow(i);
        el.classList.toggle('slot-focused',i===slots.focused);
        el.classList.toggle('slot-empty',!win);   // FR-WSL-6
        el.dataset.slot=String(i);
        // FR-WSL-35 / D-10: 칸이 둘을 넘으면 위치만으로는 어느 칸이 무슨 창인지
        // 읽히지 않는다. 이름을 적는다.
        const head=this._keep('slot:'+i+'/head',()=>{
          const h=document.createElement('div'); h.className='slot-head'; return h;
        });
        head.textContent=win?this._rWinTitle(win):'창 없음';
        // 분할 트리는 `inset:0` 으로 조상을 채우므로 머리글과 겹치지 않게 자기
        // 몫의 상자를 준다.
        const body=this._keep('slot:'+i+'/body',()=>{
          const b=document.createElement('div'); b.className='slot-body'; return b;
        });
        this._place(el,[head,body]);
        kids.push(el);
        bodies.push([i,win,body]);
        if(i<n-1){
          kids.push(this._keep('slot:'+i+'/handle',()=>{
            const h=document.createElement('div');
            h.className='slot-handle';
            h.dataset.slotHandle=String(i);
            app._slotHandleBind(h,i);            // FR-WSL-32 — 배선은 만들 때 한 번
            return h;
          }));
        }
      }
      this._placeLayout(area,kids);
      for(const [i,win,body] of bodies){ this._rSlot=i; this._rWindowInto(win,body) }
      app._slotApplySizes();
      this._rSlot=0;
    }
    const allTabIds=new Set();
    const walk=n=>{if(!n)return;if(n.type==='pane'&&n.tabs)n.tabs.forEach(t=>allTabIds.add(t.id));if(n.type==='split'&&n.children)n.children.forEach(walk)};
    for(const sess of app.ws.windows){if(sess&&sess.layout)walk(sess.layout)}
    // 편집기 Map 의 키는 복합키다 (FR-WSL-75) — 회수는 탭 id 로 판정한다.
    // FR-SVS-60: 파싱은 `_slotBase` 한 자리다. 여기서 `@1` 만 잘라 내던 동안
    // 칸 2·3 의 편집기는 살아 있는 탭인데도 매 render 마다 파괴됐다.
    for(const[k,v] of app.fileEditors){
      const tid=app._slotBase(k);
      if(!allTabIds.has(tid)){v.destroy();app.fileEditors.delete(k)}
    }
    // 옛 Git 창이 사라졌으면 그 창의 패널만 루트를 area 로 되돌린다. 인스턴스는
    // 유지 — 다시 열릴 수 있다. FR-SVS-42: 패널은 칸마다 있으므로 그 자리의
    // 것을 **전부** 되돌린다.
    //
    // **Repo 창의 패널(`root` 가 있는 것)은 건드리지 않는다** (FR-RTU-60).
    // 그쪽의 Changes 는 창의 사이드에 붙어 있고, 여기서 함께 떼면 방금 그린
    // 사이드가 비어 버린다 — 실측으로 확인한 결함이다.
    if(!app._gitWindow()&&app._gitPanels)
      for(const p of app._gitPanels.values()) if(!p.root) p.detach();
    // FR-PDR-9: 이번에 어디에도 붙지 못한 위젯만 물러난다. **떼지 않는다** —
    // 자리를 지키고 있어야 다시 보일 때 옮기지 않는다.
    for(const p of app.tools.values()) if(!this._mounted.has(p.el)) p.el.classList.remove('vis');
    for(const v of app.fileEditors.values()) if(!this._mounted.has(v.el)) v.el.classList.remove('vis');
    this._domGC();
    TIMERS.frame(()=>{
      for(const p of app.tools.values()){
        if(p.el.classList.contains('vis')){
          if(!p._opened)p.open();
          p.doFit();
        }
      }
      // FR-PDR-10: **옮겨진 것만** 되돌린다. 재사용된 pane 은 이 목록에 없고,
      // 그래서 어떤 스크롤 API 도 닿지 않는다 — 그것이 이 작업의 요점이다.
      const moved=this._moved; this._moved=[];
      for(const rec of moved) this._restoreScrollOf(rec);
      // FR-MTI-25: 모바일에서는 render 가 터미널에 focus 하지 않는다. focus 된
      // 입력 요소가 있으면 Android Chrome 이 탭마다 키보드를 재표시하므로, 첫
      // 로드와 모든 재렌더가 키보드를 불러들이게 된다. 모바일에서 키보드를
      // 올리는 길은 사용자가 터미널을 탭하는 것 하나뿐이다 (_buildPane 의
      // mousedown). 편집기는 그 대상이 아니다 — 자기 UI 를 가진다.
      // `s?.layout` 을 여기서도 본다 — pane 이 없는 Editor 창(FR-EDT-55)이
      // 활성일 때 이 블록에 도달하기 때문이다.
      const s=app._aw();
      if(app.focused && !app.isMobile && s?.layout){
        const pn=findPane(s.layout,app.focused);
        if(pn){const tab=pn.tabs.find(t=>t.id===app.paneTab(pn));if(tab){
          // 포커스 슬롯의 인스턴스를 focus 한다 (FR-WSL-20).
          const key=app._slotKey(tab.id,app._slotFocused());
          if(tab.type==='editor'){const v=app.fileEditors.get(key)||app.fileEditors.get(tab.id);if(v)v.el.focus()}
          else{const p=app._toolAny(tab.toolId);if(p)p.focus()}
        }}
      }
      // After fit, panes have correct dimensions. Re-send sizes for the
      // active window if this window owns it and has OS focus.
      if(app._windowFocused){
        app._resendWindowSizes(app.ws.activeWindow);
      }
    },{owner:this,label:'render-frame'});
  }

  /**
   * FR-WSL-55 / FR-SVS-61 (FR-PDR-7): 칸 하나의 껍데기. **배선은 여기 한 번뿐이다** —
   * 칸의 자리(인덱스)가 곧 키이므로 `i` 는 이 요소에 대해 변하지 않는다.
   *
   * 포커스는 mousedown 에 옮기고 **그리기는 클릭이 끝난 뒤**로 미룬다. 여기서
   * 곧바로 그리면 이 클릭이 어떤 핸들러에도 닿지 못한다 (§2.11).
   */
  _makeSlot(i){
    const app=this.app;
    const el=document.createElement('div');
    el.className='slot';
    el.addEventListener('mousedown',()=>{if(app._slotFocused()!==i)app.slotFocusTo(i,{deferRender:true})});
    // 클릭이 자기 일로 render 를 돌면 `App.render` 가 플래그를 지우므로 이 자리는
    // 아무 일도 하지 않는다. 빈 자리를 눌렀을 때를 위한 자리다.
    el.addEventListener('click',()=>app._slotRenderFlush());
    return el;
  }

  /**
   * 슬롯 하나(또는 단일 슬롯 모드의 `#area`)에 창 하나를 그린다.
   *
   * `_rLayout` 에서 뽑아낸 것이며 동작은 그대로다 — 달라진 것은 **붙일 자리를
   * 인자로 받는다**는 것뿐이다 (FR-WSL-31). 그리는 동안 `this._rSlot` 이 지금
   * 어느 슬롯인지 말해 준다; 도구·편집기 인스턴스 조회가 그것을 딛는다.
   */
  _rWindowInto(s,host){
    const app=this.app;
    // FR-RTU-60: 지금 그리는 창. 탭 본문을 붙이는 자리(`_mountTabBody`)가 **그 탭이
    // 어느 창의 것인지** 알아야 패널을 고를 수 있다.
    this._rWin=s;
    // FR-EDT-46: Editor 창은 좌우 둘로 나뉜다 — 좌측 탐색기는 분할 트리 **밖**의
    // 고정 영역이므로 트리가 붙을 자리를 우측으로 바꾼다. 골격은 재사용한다.
    const ed=app._isEditorWin(s)?this._rEditorWin(s):null;
    if(ed) this._placeLayout(host,[ed.root]);
    const h=ed?ed.main:host;
    // FR-EDT-55: pane 이 하나도 없는 창이 있다. 그리기를 건너뛴다 — 죽은 편집기
    // 회수는 호출자(_rLayout)가 슬롯 바깥에서 한다.
    if(!s||!s.layout){
      // 옛 트리가 남아 있으면 거둔다. Editor 창은 `_rEditorWin` 이 안내문을 놓았다.
      if(!ed) this._placeLayout(host,[]);
      return;
    }
    // 포커스 보정은 **포커스 슬롯에서만** 한다. 비포커스 슬롯의 창을 그린다고
    // 해서 `app.focused`(포커스 슬롯의 pane)를 옮기면 안 된다.
    const isFocusedSlot=this._rSlot===app._slotFocused();
    if(isFocusedSlot&&!findPane(s.layout,app.focused)){
      app._setFocus(firstPane(s.layout)?.id||null,s);
    }
    let dom;
    if(app.isMobile){
      const regs=app._flattenPanes(s.layout);
      /**
       * FR-RTU-80·82: 순회의 첫 자리가 **사이드**다 (Repo 창일 때).
       *
       * 포커스 동기화는 그 자리를 건너뛴다 — 사이드는 분할 트리 밖이라 포커스된
       * pane 이 될 수 없고, 무조건 포커스를 따라가면 사이드에 설 수 없다.
       */
      const off=app._mobileSideSlots();
      const n=regs.length+off;
      if(app._mPaneIdx>=n) app._mPaneIdx=n-1;
      if(app._mPaneIdx<0) app._mPaneIdx=0;
      if(regs.length&&!(off&&app._mPaneIdx===0)){
        const fIdx=regs.findIndex(r=>r.id===app.focused);
        if(fIdx>=0) app._mPaneIdx=fIdx+off;
        const target=regs[app._mPaneIdx-off];
        if(target){app._setFocus(target.id,s);dom=this._buildPane(target,'m')}
      }
    }else{
      dom=this._buildNode(s.layout,'0');
    }
    if(h) this._placeLayout(h,dom?[dom]:[]);
  }

  /**
   * EDITOR_TAB_SRS FR-EDT-46·47·55: Editor 창의 골격.
   *
   * 좌측은 탐색기, 우측은 편집기 영역이다. 탐색기는 분할 트리 **밖**이므로
   * 어떤 드롭으로도 쪼개지지 않는다 — 트리는 우측(`.ed-area`) 안에만 산다.
   *
   * 탐색기의 내용은 M3 의 것이다. 여기서는 자리와 폭만 잡는다.
   * 분할 트리가 붙을 요소를 돌려준다.
   */
  _rEditorWin(s){
    const app=this.app, slot=this._rSlot||0;
    // FR-PDR-1: 골격은 창(과 칸)마다 하나다. 이것이 남아 있어야 `.ed-area` 안의
    // 분할 트리도, 그 안의 터미널도 제자리를 지킨다.
    const key='edwin:'+slot+':'+((s&&s.id)||'');
    const el=this._keep(key,()=>{
      const e=document.createElement('div'); e.className='ed-win'; return e;
    });
    /**
     * FR-RTU-80: **모바일은 사이드와 본문을 나란히 두지 않는다.**
     *
     * 폭이 없다 — 대신 순회의 자리 하나로 만들어 **한 번에 하나**를 전체 폭으로
     * 보인다 (D-RTU-11).
     */
    const mob=app.isMobile;
    const onSide=mob&&app._mobileOnSide();
    const kids=[];
    if(!mob||onSide){
      // REPO_TAB_UNIFY_SRS FR-RTU-12: 사이드는 `Explorer` 와 `Changes` 를 탭으로
      // 갈아 끼운다. 사이드 안쪽은 이 SRS 의 범위 밖이므로 종전대로 매번 세운다 —
      // 그 안의 스크롤은 `_keepScrollAll` 이 이미 지킨다 (FR-SCR-1).
      const side=this._rSide(s);
      // REPO_SIDE_WIDTH_SRS FR-RSW-2: 폭은 창의 것이 아니라 워크스페이스 하나다.
      if(!mob) side.style.width=app._edSideWidth()+'px';
      kids.push(side);
      if(!mob){
        const h=this._keep(key+'/exh',()=>{
          const x=document.createElement('div'); x.className='ed-ex-handle';
          this._rEdHandle(x);                    // FR-PDR-7: 배선은 한 번
          return x;
        });
        kids.push(h);
      }
    }
    if(onSide){
      // 본문은 그리지 않는다 — `_rWindowInto` 가 붙일 자리가 없다.
      this._place(el,kids);
      return {root:el,main:null};
    }
    const main=this._keep(key+'/main',()=>{
      const m=document.createElement('div'); m.className='ed-area'; return m;
    });
    kids.push(main);
    this._place(el,kids);
    // FR-EDT-55: pane 이 없는 것이지 빈 pane 이 있는 것이 아니다 — 안내문을 둔다.
    if(!s||!s.layout){
      const hint=this._keep(key+'/hint',()=>{
        const x=document.createElement('div'); x.className='ed-empty';
        x.textContent=EDITOR_EMPTY_HINT; return x;
      });
      this._place(main,[hint]);
    }
    return {root:el,main};
  }

  /**
   * FR-RTU-11·12: 사이드의 골격 — 탭 바와 그 본문.
   *
   * **내용을 소유하지 않는다.** 탐색기는 `FileTree` 가, Changes 는 `GitPanel` 이
   * 자기 DOM 을 들고 있고 여기서는 붙이기만 한다 — `_rLayout` 이 `.ed-win` 을 매
   * render 마다 새로 만들기 때문이며, 여기서 만들면 펼침·선택·스크롤이 그때마다
   * 사라진다 (FR-EDT-66·68, NFR-RTU-5).
   */
  _rSide(s){
    const app=this.app, slot=this._rSlot||0;
    const el=document.createElement('div'); el.className='ed-side';
    const active=app._edSideOf(s);
    const bar=document.createElement('div'); bar.className='ed-side-tabs';
    for(const d of REPO_SIDE_TABS){
      const b=document.createElement('button');
      b.className='ed-side-tab'+(d.id===active?' active':'');
      b.dataset.side=d.id; b.textContent=d.label;
      if(d.title) b.title=d.title;
      b.addEventListener('click',()=>app._edSetSide(s,d.id));
      bar.appendChild(b);
    }
    /**
     * GIT_CHANGES_CONTROLS_SRS FR-GCC-10 / D-7·D-8: 새로고침은 **창의 최상단**,
     * 탭 줄의 오른쪽 여백에 선다.
     *
     * 종전 자리는 브랜치 줄 안이었고, 목록을 다시 읽고 싶은 손이 세 번째 줄까지
     * 내려가야 했다. 진입점 줄에 넣어 봤더니 그쪽은 여섯 칸이 폭을 나눠 갖는
     * 자리라 일곱 번째가 **다음 줄로 밀렸다**(실측) — 탭 줄은 탭 둘뿐이라 오른쪽이
     * 비어 있고, 최상단이라는 뜻에도 그쪽이 더 맞는다.
     *
     * `Changes` 탭에서만 둔다: 새로고침하는 대상이 git 이고, Explorer 에서는
     * 그 자리가 뜻을 잃는다 (FR-RTU-22 와 같은 근거). 클래스 이름은 그대로다 —
     * 자리가 바뀌었을 뿐 같은 버튼이다.
     */
    if(active===REPO_SIDE_CHANGES){
      const rf=document.createElement('button');
      rf.className='ed-side-refresh git-head-refresh';
      // 요구 ③/⑤: 글자가 아니라 아이콘이다. 크기는 `.ui-icon` 이 정한다.
      rf.appendChild(UIKit.icon(GIT_REFRESH_LABEL)); rf.title=GIT_REFRESH_TITLE;
      rf.addEventListener('click',()=>app._gitPanel(app._edRootOf(s),slot).refresh());
      bar.appendChild(rf);
    }
    el.appendChild(bar);
    const body=document.createElement('div'); body.className='ed-side-body';
    if(active===REPO_SIDE_CHANGES){
      // FR-RTU-32: Changes 는 **사이드에만** 있다. 본문 탭이 되지 않으므로 그
      // 뷰의 DOM 을 여기로 가져온다 — 뷰를 만드는 자리는 패널 하나다.
      const p=app._gitPanel(app._edRootOf(s),slot);
      // FR-RTU-21·22: 나머지 여섯으로 가는 진입점. **Changes 탭에만** 둔다 —
      // Explorer 에서는 git 의 자리가 아니고, 파일 작업 중에 보일 이유가 없다.
      el.appendChild(this._rSideActions(p));
      const view=p.elFor(REPO_SIDE_CHANGES);
      view.classList.add('vis');
      body.appendChild(view);
    }else{
      body.appendChild(app._edTree(s,slot).mount());
    }
    el.appendChild(body);
    return el;
  }

  // FR-RTU-21: 진입점 여섯. 누르면 본문에 그 뷰의 탭이 열리고, 이미 있으면 그
  // 탭으로 옮긴다 — 판정은 `openView` 한 자리다 (FR-RTU-31).
  _rSideActions(panel){
    const bar=document.createElement('div'); bar.className='ed-side-acts';
    for(const a of GIT_SIDE_ACTIONS){
      // FR-GLY-4·6 / FR-UIK-10: 스프라이트로 바꾸되 기존 클래스는 그대로 둔다.
      const b=document.createElement('button');
      b.className='ui-btn ui-btn-icon ui-btn-ghost ed-side-act'; b.dataset.view=a.key;
      b.appendChild(UIKit.icon(a.icon));
      b.title=a.title; b.setAttribute('aria-label',a.title);
      b.addEventListener('click',()=>panel.openView(a.key));
      bar.appendChild(b);
    }
    return bar;
  }

  /**
   * FR-RSW-3: 폭은 워크스페이스 하나에 저장한다 — `sidebarWidth` 와 같은 규약이다
   * (§2.10). 드래그 중에는 화면만 바꾸고 확정은 mouseup 한 번이다.
   *
   * 끄는 동안 **보이는 사이드 전부**를 함께 움직인다 (D-5). 칸 둘이 나란히 Repo
   * 창을 보일 때 하나만 따라오면 확정 전까지 둘이 어긋나 보인다. 다시 그리지
   * 않는 이유는 `_rLayout` 이 매 render 마다 `.ed-win` 을 새로 만들기 때문이다 —
   * 드래그마다 트리와 편집기를 재조립할 이유가 없다 (NFR-RSW-1).
   */
  _rEdHandle(h){
    const clamp=w=>Math.max(REPO_SIDE_W_MIN,Math.min(REPO_SIDE_W_MAX,w));
    // FR-PDR-8: 핸들은 재사용되고 사이드는 매 그리기마다 새로 선다. 그때의 것을
    // **그때 찾는다** — 클로저로 잡으면 첫 그리기의 사이드를 영영 잰다.
    const ex=()=>h.previousElementSibling;
    // FR-HSZ-5: 양쪽 다 터미널이 아니다 — 사이드(탐색기·Changes)와 편집기이므로
    // `C×R` 줄이 붙지 않는다.
    UIKit.drag(h,{
      axis:'x',
      start:()=>({start:ex().offsetWidth,win:h.closest('.ed-win')}),
      move:(ctx,ev)=>{
        const w=clamp(ctx.start+(ev.clientX-ctx.sx0))+'px';
        for(const el of document.querySelectorAll('.ed-win>.ed-side')) el.style.width=w;
      },
      sides:(ctx)=>{
        const sw=ex().offsetWidth;
        const tot=ctx.win?ctx.win.offsetWidth:sw;
        return [
          {px:sw,pct:tot?sw/tot*100:null},
          {px:Math.max(0,tot-sw),pct:tot?(tot-sw)/tot*100:null},
        ];
      },
      end:(ctx,ev)=>{
        this.app._edSetSideWidth(clamp(ctx.start+(ev.clientX-ctx.sx0)));
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
      },
    });
  }

  // FR-PDR-5: `path` 는 트리에서의 자리다. split 에는 id 가 없고, SSE 로 다시
  // 받은 layout 은 객체 동일성도 끊긴다 — 자리와 모양(방향·자식 수)이 그것을
  // 대신하는 키다 (D-5).
  _buildNode(n,path){
    if(!n) return null;
    if(n.type==='pane') return this._buildPane(n,path);
    if(n.type==='split'&&n.children) return this._buildSp(n,path);
    return null;
  }

  // 탭 하나가 탭 바에 **보이는 이름**이다. 단일 자리인 이유는 CONVENIENCE_SRS
  // FR-TAN-17 이다 — 전경 프로세스에서 파생한 이름이 붙을 때, 탭 바와 사이드바와
  // dmctl list-workspace 가 서로 다른 것을 말하면 안 된다.
  //
  // 판정과 파생은 `tabName` 한 곳에 있다 (helpers.js) — dmctl 이 같은 규칙을
  // Go 로 다시 쓰므로, 브라우저 안에서만이라도 자리가 둘이면 안 된다.
  _tabDisplayName(tab){
    // FR-DRV-11: 렌더 탭임을 알리는 표시. **여기서 붙인다** — `tabName` 은 dmctl 이
    // 같은 규칙을 Go 로 다시 쓰는 자리이며(helpers.js), 그쪽이 모르는 표시를 그
    // 함수에 넣으면 두 구현이 어긋난다.
    return (tab.dirty?'● ':'')+(tab.render?DOC_RENDER_TAB_MARK:'')+tabName(tab,this.app._fgNames);
  }

  // 활성 탭의 **본문**을 pane body 에 붙인다. 타입별로 실체가 다르다 — git 은
  // 싱글턴 패널의 view DOM, editor 는 FileEditor 인스턴스, terminal 은 PTY 를 든
  // Tool 의 DOM 이다.
  //
  // 분기를 함수로 뽑아 둔 이유는 ORCHESTRATION_V2_SRS FR-RVZ-6 의 네 번째 타입
  // ('run' — Run 대시보드)이 여기 들어오기 때문이다. 병렬 중 이 파일을 여럿이
  // 만지지 않도록 자리를 미리 갈라 둔다 (PARALLEL_DELIVERY_PLAN Step 0-4).
  // `slot` 은 지금 그리는 슬롯이다 (`_rSlot`). 도구·편집기 인스턴스는 슬롯마다
  // 서므로 (FR-WSL-20·23), 붙일 실체를 고를 때 그것을 딛는다.
  _mountTabBody(body,at){
    const slot=this._rSlot||0;
    let el=null,term=null;
    if(!at){
      this._hideOthers(body,null);
      return;
    }
    if(at.type===TAB_TYPE_GIT){
      // 패널은 **(루트, 칸)마다** 있다 (FR-SVS-40·42 + FR-RTU-60). 루트는 **이 탭이
      // 있는 창**의 것이다 — 그리는 중인 창이 활성 창이 아닐 수 있다(슬롯).
      const root=this.app._isEditorWin(this._rWin)?this.app._edRootOf(this._rWin):'';
      el=this.app._gitPanel(root,slot).elFor(at.gitView);
    }else if(at.type==='editor'){
      const key=this.app._slotKey(at.id,slot);
      let editor=this.app.fileEditors.get(key);
      // DOC_RENDER_VIEW_SRS D-1: 타입은 하나이고 **실체가 둘**이다.
      if(!editor){
        editor=at.render
          ? new DocRender(at.id,at.name,at.filePath)
          : new FileEditor(at.id,at.name,at.filePath);
        this.app.fileEditors.set(key,editor);
      }
      el=editor.el;
    }else if(at.type==='run'){
      // FR-RVZ-6: 네 번째 타입. 루트 DOM 은 탭마다 캐시된다 (NFR-RVZ-2).
      el=this.app._runViewEl(at,slot);
    }else{
      // 슬롯 1 의 인스턴스는 그 슬롯이 처음 이 도구를 그릴 때 선다 (FR-WSL-20).
      const p=at.toolId?this.app._mkTool(at.toolId,at.name||'',slot):null;
      if(p){ el=p.el; term=p }
    }
    if(!el) { this._hideOthers(body,null); return }
    if(el.parentNode!==body){
      // FR-PDR-10: **여기가 유일한 이동이다.** 그리고 이동한 것만 사후 처리를
      // 받는다 — 자리를 지킨 위젯에는 어떤 스크롤 API 도 닿지 않는다.
      if(term) this._moved.push(this._grabScroll(term));
      body.appendChild(el);
    }
    el.classList.add('vis');
    this._mounted.add(el);
    this._hideOthers(body,el);
  }

  /**
   * FR-PDR-3: 이 자리에 남아 있는 **옛 탭의 위젯**을 거둔다.
   *
   * `vis` 만 걷고 자리에 두면 되돌아올 때 옮기지 않아도 되지만, 그 클래스로
   * 숨겨진다는 보장이 위젯마다 다르다 — Git 뷰는 자기 수명 관리(`panel-life`)가
   * 따로 `vis` 를 만지고, 종전에는 `.pn-body` 가 매번 새로 만들어져 옛 뷰가
   * 저절로 문서에서 떨어졌다. 그 전제를 없애자 숨지 않은 뷰가 **본문 위를 덮어
   * 클릭을 가로챘다** (e2e: `.git-view.git-submodules` 가 Branches 의 행을 가림).
   *
   * 그래서 종전과 같게 뗀다. 이 SRS 가 지키려는 것은 "탭이 그대로일 때 움직이지
   * 않는 것" 이고, 탭이 실제로 바뀌는 순간의 이동은 FR-PDR-10~12 가 받는다.
   *
   * 드롭 표시는 위젯이 아니라 이 자리의 장식이다 (`app-dnd` 가 만들어 다시 쓴다).
   */
  _hideOthers(body,keep){
    for(const c of [...body.children]){
      if(c===keep||c.classList.contains('pn-drop-indicator')) continue;
      c.classList.remove('vis');
      c.remove();
    }
  }

  _buildPane(n,path){
    const app=this.app;
    const slot=this._rSlot||0;
    // FR-PDR-2: 같은 pane 이 같은 칸에 다시 오면 그 요소를 그대로 쓴다. 같은 창이
    // 두 칸에 설 때 pane id 가 같으므로(FR-WSL-14) 칸이 키에 함께 든다.
    const key='pane:'+slot+':'+n.id;
    const el=this._keep(key,()=>this._makePane());
    // FR-PDR-8: 핸들러가 읽는 지금의 문맥. 재사용되는 요소에 값을 클로저로
    // 가두면 두 번째 그리기부터 낡은 pane·낡은 칸을 가리킨다.
    el._ctx={node:n,slot};
    el.dataset.paneid=n.id;
    // FR-SVS-1: 이 pane 이 **이 칸에서** 보이는 탭.
    const shown=app.paneTab(n,slot);
    // FR-WSL-35: 포커스로 그리는 것은 포커스 칸 하나다.
    const focused=n.id===app.focused&&slot===app._slotFocused();
    const at=(n.tabs||[]).find(t=>t.id===shown);
    el.classList.toggle('focused',focused);
    // FR-ATV-1: 알람 표식은 포커스 여부와 **무관하게** 그려진다. 여기 남아 있던
    // 옛 FR-PAN-9 의 포커스 예외가 `_attnRefresh` 의 토글을 다음 render() 마다
    // 도로 떼고 있었다 — 포커스 칸에서 뜬 알람의 링이 보이지 않던 자리다.
    // 두 표식은 서로 다른 픽셀에 앉으므로 겹쳐도 서로를 가리지 않는다 (FR-ATV-2).
    el.classList.toggle('attn',!!at&&!!app._attnHas(at.toolId));
    this._rTabs(el.firstChild,n,shown,key);
    this._mountTabBody(el.lastChild,at);
    return el;
  }

  /**
   * FR-PDR-4: 탭 바를 다시 짓지 않는다. 남은 탭은 그 요소 그대로 두고 라벨과
   * 클래스만 고치며, 사라진 것만 거두고 새것만 만든다.
   */
  _rTabs(tabs,n,shown,key){
    const app=this.app;
    const kids=[];
    for(const tab of(n.tabs||[])){
      const tkey=key+'/tab:'+tab.id;
      let t=this._keep(tkey,()=>this._makeTab());
      /**
       * 이름 변경은 라벨을 **input 으로 갈아 끼운다** (`_renameTab` 의
       * `el.replaceWith(input)`). 그 경로는 확정 뒤의 다시 그리기가 DOM 을 새로
       * 만들어 그 자리를 되돌리는 것에 기대고 있었다 — 재사용하는 지금은 라벨이
       * 영영 돌아오지 않고, 그다음 갱신이 없는 요소를 만진다 (e2e: V-TAN-5·6,
       * `tab can be renamed via double-click`).
       *
       * 그 탭만 다시 만든다. 되돌릴 상태가 없는 요소이므로 값이 싸다.
       */
      if(!t.querySelector('.pn-tab-label')){
        this._dom.delete(tkey);
        t=this._keep(tkey,()=>this._makeTab());
      }
      t._ctx={tab};
      t.dataset.tabId=tab.id;
      if(tab.toolId) t.dataset.toolid=tab.toolId; else delete t.dataset.toolid;
      const isGit=tab.type===TAB_TYPE_GIT;
      if(isGit) t.dataset.gitView=tab.gitView; else delete t.dataset.gitView;
      // FR-ATV-1·3: 보고 있는 탭도 알람을 그린다. 활성 배경은 활성 색에 머물고
      // 밑줄만 맥박하므로(`.pn-tab.active.attn`) 알람이 활성 표시를 빼앗지 않는다.
      const active=tab.id===shown;
      const attn=app._attnHas(tab.toolId);
      // FR-RTU-41: 미리보기 탭은 기울임이다 — "이 자리는 곧 대체된다".
      t.className='pn-tab'+(active?' active':'')+(attn?' attn':'')+(isGit?' git':'')
        +(tab.preview?' '+REPO_PREVIEW_CLASS:'');
      const name=this._tabDisplayName(tab);
      const lab=t.querySelector('.pn-tab-label');
      if(lab.textContent!==name) lab.textContent=name;
      // TAB_WIDTH_SRS FR-TBW-6 / D-5: **언제나** 붙인다 — 잘리지 않는 폭에서는
      // 보이지 않을 뿐이므로 해가 없다.
      t.title=tab.preview?REPO_PREVIEW_TITLE:name;
      kids.push(t);
    }
    // FR-GIT-180 / FR-EDT-54: Git·Editor 창에는 `+` 자리를 만들지 않는다 —
    // 눌리지만 아무 일도 하지 않는 버튼은 고장으로 읽힌다.
    const aw=app._aw();
    if(!(app._isGitWin(aw)||app._isEditorWin(aw))) kids.push(this._keep(key+'/add',()=>this._makeTabAdd()));
    this._place(tabs,kids);
  }

  // 탭 요소 하나와 그 배선. **여기서만 배선한다** (FR-PDR-7) — 지금 어느 pane 의
  // 어느 탭인지는 `_ctx` 가 답한다 (FR-PDR-8).
  _makeTab(){
    const app=this.app;
    const t=document.createElement('div');
    t.innerHTML='<span class="pn-tab-label"></span>'
      +'<span class="pn-tab-x" title="'+TAB_CLOSE_TITLE+'">'+UIKit.iconHTML('x','ui-icon-sm')+'</span>';
    t.draggable=true;
    const ctx=()=>{
      const pn=t.closest('.pn');
      const c=(pn&&pn._ctx)||{};
      return {pane:c.node||null,slot:c.slot||0,tab:(t._ctx&&t._ctx.tab)||null};
    };
    const clearMarks=()=>{
      const bar=t.parentNode;
      if(bar) bar.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));
    };
    t.addEventListener('click',e=>{
      e.stopPropagation();
      const c=ctx(); if(!c.pane||!c.tab) return;
      if(e.target.classList.contains('pn-tab-x')) app.closeTab(c.pane.id,c.tab.id,null,{slot:c.slot});
      else app.switchTab(c.pane.id,c.tab.id,c.slot);
    });
    // FR-RTU-42: 탭 자체의 더블클릭이 고정한다.
    t.addEventListener('dblclick',e=>{
      const c=ctx(); if(!c.tab||!c.tab.preview) return;
      e.stopPropagation();
      app._pinPreviewTab(c.tab);
    });
    // 탭은 `_renameTab` 이다 — 창의 `_rename` 과 달리 빈 문자열에 뜻이 있다
    // (FR-TAN-21). git 뷰 탭의 이름은 뷰에서 파생하므로 고쳐도 다음 그리기가
    // 되돌린다 — 그래서 그 타입에서는 아무 일도 하지 않는다 (FR-RTU-33).
    t.querySelector('.pn-tab-label').addEventListener('dblclick',e=>{
      const c=ctx(); if(!c.tab||c.tab.type===TAB_TYPE_GIT) return;
      e.stopPropagation();
      if(c.tab.preview){app._pinPreviewTab(c.tab);return}
      app._renameTab(c.tab,e.target);
    });
    t.addEventListener('dragstart',e=>{
      const c=ctx(); if(!c.pane||!c.tab) return;
      app._drag={type:'tab',srcPaneId:c.pane.id,tabId:c.tab.id};
      e.dataTransfer.effectAllowed='move';
      e.stopPropagation();
      TIMERS.defer(()=>t.classList.add('dragging'),{label:'drag-class'});
    });
    t.addEventListener('dragend',()=>{
      app._drag=null; t.classList.remove('dragging'); clearMarks();
      document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none');
    });
    t.addEventListener('dragover',e=>{
      if(!app._drag||app._drag.type!=='tab')return;
      e.preventDefault(); e.stopPropagation();
      clearMarks();
      const rect=t.getBoundingClientRect();
      t.classList.add(e.clientX<rect.left+rect.width/2?'drag-left':'drag-right');
      document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none');
    });
    t.addEventListener('drop',e=>{
      e.preventDefault(); e.stopPropagation();
      if(!app._drag||app._drag.type!=='tab')return;
      const c=ctx(); if(!c.pane||!c.tab) return;
      const{srcPaneId,tabId}=app._drag;
      app._drag=null;
      clearMarks();
      const s=app._aw(); if(!s)return;
      const rect=t.getBoundingClientRect();
      const insBefore=e.clientX<rect.left+rect.width/2;
      if(srcPaneId===c.pane.id){
        const pn=findPane(s.layout,c.pane.id); if(!pn)return;
        const si=pn.tabs.findIndex(tt=>tt.id===tabId);
        const di=pn.tabs.findIndex(tt=>tt.id===c.tab.id);
        if(si<0||di<0||si===di)return;
        const[moved]=pn.tabs.splice(si,1);
        let ins=pn.tabs.findIndex(tt=>tt.id===c.tab.id);
        if(!insBefore)ins++;
        pn.tabs.splice(ins,0,moved);
        app.paneTabSet(pn,tabId,c.slot);
        app._save();
        app.render();
      }else{
        app._moveTabToPane(srcPaneId,tabId,c.pane.id,c.tab.id,insBefore);
      }
    });
    return t;
  }

  _makeTabAdd(){
    const app=this.app;
    const add=document.createElement('button'); add.className='pn-tab-add';
    add.appendChild(UIKit.icon('plus',{size:'sm'}));
    add.title=TAB_ADD_TITLE;
    add.addEventListener('click',e=>{
      e.stopPropagation();
      const pn=add.closest('.pn');
      if(pn&&pn._ctx&&pn._ctx.node) app.addTab(pn._ctx.node.id);
    });
    return add;
  }

  // pane 의 껍데기와 그 배선. 탭 바와 본문 상자는 이 요소의 수명 동안 같은
  // 것이며, 본문에 붙은 위젯이 움직이지 않는 것이 이 SRS 의 전부다.
  _makePane(){
    const app=this.app;
    const el=document.createElement('div');
    el.className='pn';
    const tabs=document.createElement('div'); tabs.className='pn-tabs';
    const body=document.createElement('div'); body.className='pn-body';
    el.appendChild(tabs); el.appendChild(body);
    const node=()=>(el._ctx&&el._ctx.node)||null;
    const slotOf=()=>(el._ctx&&el._ctx.slot)||0;
    tabs.addEventListener('dragover',e=>{
      if(!app._drag||app._drag.type!=='tab')return;
      e.preventDefault(); e.stopPropagation();
      const n=node();
      if(n&&app._drag.srcPaneId!==n.id) tabs.classList.add('drag-target');
    });
    tabs.addEventListener('dragleave',e=>{
      if(!tabs.contains(e.relatedTarget)) tabs.classList.remove('drag-target');
    });
    tabs.addEventListener('drop',e=>{
      e.preventDefault(); e.stopPropagation();
      tabs.classList.remove('drag-target');
      tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));
      if(!app._drag||app._drag.type!=='tab')return;
      const n=node(); if(!n) return;
      const{srcPaneId,tabId}=app._drag;
      app._drag=null;
      const s=app._aw(); if(!s)return;
      if(srcPaneId===n.id){
        const pn=findPane(s.layout,n.id); if(!pn)return;
        const si=pn.tabs.findIndex(t=>t.id===tabId); if(si<0)return;
        const[moved]=pn.tabs.splice(si,1);
        pn.tabs.push(moved);
        app.paneTabSet(pn,tabId,slotOf());
        app._save();
        app.render();
      }else{
        app._moveTabToPane(srcPaneId,tabId,n.id,null,false);
      }
    });
    body.addEventListener('dragover',e=>{
      if(!app._drag||app._drag.type!=='tab')return;
      e.preventDefault(); e.stopPropagation();
      tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));
      app._showBodyDropIndicator(body,app._getDragZone(body,e));
    });
    body.addEventListener('dragleave',e=>{
      if(!body.contains(e.relatedTarget)) app._clearBodyDropIndicator(body);
    });
    body.addEventListener('drop',e=>{
      e.preventDefault(); e.stopPropagation();
      if(!app._drag||app._drag.type!=='tab')return;
      const n=node(); if(!n) return;
      const zone=app._getDragZone(body,e);
      const{srcPaneId,tabId}=app._drag;
      app._drag=null;
      app._clearBodyDropIndicator(body);
      if(zone==='center'){
        if(srcPaneId===n.id)return;
        app._moveTabToPane(srcPaneId,tabId,n.id,null,false);
      }else{
        app._splitPaneWithTab(srcPaneId,tabId,n.id,zone);
      }
    });
    el.addEventListener('mousedown',()=>{
      const n=node(); if(!n) return;
      /**
       * FR-SVS-63 (§2.13): **칸이 먼저, pane 이 그 다음이다.**
       *
       *   이전 동작: pane 이 먼저 포커스를 정했고, 그 대상이 **이전 칸의 창**이었다
       *   새  동작: 누른 pane 이 있는 칸으로 포커스를 옮긴 뒤 그 pane 을 정한다
       *   이유:     이 리스너는 칸의 것보다 **먼저** 돈다(버블은 안에서 밖으로).
       *             `setFocus` 는 창을 인자로 받지 않으므로 대상이 늘 그 순간의
       *             활성 창이고, 순서가 뒤집혀 있으면 이전 칸의 창이 누른 칸의
       *             pane id 를 자기 `focusedPane` 으로 받는다 — 그 창으로
       *             돌아갈 때 보던 분할 칸을 잃었다 (실측)
       *
       * 가드는 칸 리스너(`_makeSlot`)와 **같은 판정**이다. 같은 칸이면 부르지
       * 않으므로 단일 슬롯 모드와 칸 안의 클릭은 종전과 한 글자도 다르지 않다.
       * 그리기는 여전히 미룬다 (FR-SVS-61).
       */
      if(app._slotFocused()!==slotOf()) app.slotFocusTo(slotOf(),{deferRender:true});
      app.setFocus(n.id);
      // FR-MTI-25: 모바일에서 키보드를 올리는 유일한 경로. render 는 focus 하지
      // 않으므로 여기서 하지 않으면 모바일에서 입력을 시작할 길이 없다.
      if(app.isMobile){
        const pn=findPane(app._aw()?.layout,n.id);
        const tab=pn&&(pn.tabs||[]).find(t=>t.id===app.paneTab(pn,slotOf()));
        if(tab&&tab.type!=='editor'){
          const p=app._toolAny(tab.toolId);
          if(p) p.focus();
        }
      }
    });
    return el;
  }

  _buildSp(n,path){
    const slot=this._rSlot||0, win=(this._rWin&&this._rWin.id)||'';
    // 모양이 바뀌면 키가 달라진다 — 그 서브트리만 새로 서고 옛것은 거둬진다.
    const key='sp:'+slot+':'+win+':'+path+':'+n.direction+':'+n.children.length;
    const el=this._keep(key,()=>{
      const e=document.createElement('div'); e.className='sp'; return e;
    });
    el.dataset.d=n.direction;
    // 크기 확정(`_handle` 의 end)이 **지금의** 노드에 적히도록 매번 갱신한다.
    el._node=n;
    const kids=[];
    for(let i=0;i<n.children.length;i++){
      const sc=this._keep(key+'/sc'+i,()=>{
        const c=document.createElement('div'); c.className='sc'; return c;
      });
      if(n.sizes&&n.sizes[i]!=null) sc.style.flex=n.sizes[i];
      const built=this._buildNode(n.children[i],path+'.'+i);
      this._place(sc,built?[built]:[]);
      kids.push(sc);
      if(i<n.children.length-1){
        kids.push(this._keep(key+'/sh'+i,()=>{
          const h=document.createElement('div'); h.className='sh';
          this._handle(h,el);                    // FR-PDR-7: 배선은 만들 때 한 번
          return h;
        }));
      }
    }
    this._place(el,kids);
    return el;
  }

  _handle(h,sp){
    /**
     * UI_KIT_SRS FR-HSZ-1·10: 여섯 핸들이 `UIKit.drag` 한 골격을 쓴다.
     *
     * 이 핸들은 양쪽이 **둘 다 터미널일 수 있는** 유일한 자리다 (분할 칸).
     * `_termIn` 이 각 칸에서 그것을 찾고, 없으면 `C×R` 줄이 붙지 않는다.
     */
    const dirOf=()=>sp.dataset.d;
    UIKit.drag(h,{
      axis:dirOf()==='horizontal'?'x':'y',
      start:()=>{
        const prev=h.previousElementSibling, next=h.nextElementSibling;
        const horiz=dirOf()==='horizontal';
        return {
          prev,next,horiz,
          tot:horiz?prev.offsetWidth+next.offsetWidth:prev.offsetHeight+next.offsetHeight,
          p0:horiz?prev.offsetWidth:prev.offsetHeight,
        };
      },
      move:(ctx,ev)=>{
        const {prev,next,horiz,tot,p0}=ctx;
        const n=p0+(horiz?ev.clientX-ctx.sx0:ev.clientY-ctx.sy0);
        if(n<60||tot-n<60) return;
        prev.style.flex=`${n/tot}`;next.style.flex=`${(tot-n)/tot}`;
      },
      sides:(ctx)=>{
        const {prev,next,horiz,tot,p0}=ctx;
        const pw=horiz?prev.offsetWidth:prev.offsetHeight;
        const nw=tot-pw, d=pw-p0;
        const cell=(el,delta)=>UIKit.grid(this.app._termIn(el),horiz?'x':'y',horiz?delta:0,horiz?0:delta);
        return [
          {px:pw,cell:cell(prev,d),pct:tot?pw/tot*100:null},
          {px:nw,cell:cell(next,-d),pct:tot?nw/tot*100:null},
        ];
      },
      end:()=>{
        const nd=sp._node;
        if(nd){nd.sizes=[];for(const c of sp.children){if(c.classList.contains('sc'))nd.sizes.push(parseFloat(c.style.flex)||1)}this.app._save()}
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
      },
    });
  }
}
