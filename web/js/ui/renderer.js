/**
 * Remote Terminal — layout → DOM renderer
 * App 의 render / _rSidebar / _rTopbar / _rLayout / _buildNode / _buildPane
 * / _buildSp / _handle 책임을 분리. Renderer 내부 메서드 호출은 this.X 로,
 * App 상태·메서드는 this.app.X 로 접근한다. 동작은 1:1 보존.
 */
class Renderer {
  constructor(app){ this.app = app; }

  render(){
    const oldFocus=this.app._prevFocus;
    this.app._prevFocus=this.app.focused;
    if(oldFocus!==undefined&&oldFocus!==this.app.focused){
      this.app._clearAllSearchDecorations();
      this.app._researchIfOpen();
    }
    this.app._applyMobileMode();
    this._rSbTabs();this._rLists();this._rTopbar();this._rLayout();
    this.app._updateCwd();
    this.app._updateStatusBar();
    // Apply window focus overlay after every render so the DOM is
    // guaranteed to exist (BroadcastChannel may trigger _applyFocusOverlay
    // before the first render completes).
    this.app._applyFocusOverlay();
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
    if(dt) dt.textContent = this.app._drawerOpen ? '✕' : '☰';
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
    for(const p of app.tools.values()){
      if(p.el.classList.contains('vis')){
        const vp=p.el.querySelector('.xterm-viewport');
        if(vp) p._scrollTop=vp.scrollTop;
        if(p.term){try{p._viewportY=p.term.buffer.active.viewportY}catch{}}
      }
      p.el.classList.remove('vis');area.appendChild(p.el);
    }
    for(const v of app.fileEditors.values()){
      v.el.classList.remove('vis');area.appendChild(v.el);
    }
    for(const c of [...area.children]){
      if(c.classList.contains('sp')||c.classList.contains('pn')||c.classList.contains('ed-win')
        ||c.classList.contains('slot')||c.classList.contains('slot-handle'))c.remove();
    }
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
      for(let i=0;i<n;i++){
        const el=document.createElement('div');
        el.className='slot'+(i===slots.focused?' slot-focused':'');
        el.dataset.slot=String(i);
        const win=app._slotWindow(i);
        if(!win) el.classList.add('slot-empty');   // FR-WSL-6
        // FR-WSL-55 / FR-SVS-61: 포커스는 mousedown 에 옮기고 **그리기는 클릭이
        // 끝난 뒤**로 미룬다. 여기서 곧바로 그리면 이 클릭이 어떤 핸들러에도
        // 닿지 못한다 (§2.11).
        el.addEventListener('mousedown',()=>{if(app._slotFocused()!==i)app.slotFocusTo(i,{deferRender:true})});
        // 클릭이 자기 일로 render 를 돌면 `App.render` 가 플래그를 지우므로 이
        // 자리는 아무 일도 하지 않는다. 빈 자리를 눌러 아무 핸들러도 걸리지
        // 않았을 때를 위한 자리다 — 그때도 사이드바의 활성 표시는 따라와야 한다.
        el.addEventListener('click',()=>app._slotRenderFlush());
        // FR-WSL-35: 칸이 둘을 넘으면 위치만으로는 어느 칸이 무슨 창인지 읽히지
        // 않는다. 이름을 적는다 (D-10). 흐리게 하는 방식은 쓸 수 없다 — 그것은
        // 이미 소유권 없음(`.pn-dimmed`)의 뜻이다.
        const head=document.createElement('div');
        head.className='slot-head';
        head.textContent=win?this._rWinTitle(win):'창 없음';
        el.appendChild(head);
        // 분할 트리는 `inset:0` 으로 조상을 채우므로(§2.2) 머리글과 겹치지 않게
        // 자기 몫의 상자를 준다.
        const body=document.createElement('div');
        body.className='slot-body';
        el.appendChild(body);
        area.appendChild(el);
        if(i<n-1){
          const h=document.createElement('div');
          h.className='slot-handle';
          h.dataset.slotHandle=String(i);
          area.appendChild(h);
          app._slotHandleBind(h,i);               // FR-WSL-32
        }
        this._rSlot=i;
        this._rWindowInto(win,body);
      }
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
    requestAnimationFrame(()=>{
      for(const p of app.tools.values()){
        if(p.el.classList.contains('vis')){
          if(!p._opened)p.open();
          p.doFit();
          // Restore scrollback after DOM detach.
          //
          // xterm v5 keeps two states: internal `buffer.ydisp` (drives row
          // rendering) and DOM `.xterm-viewport.scrollTop` (drives scrollbar
          // and scroll events). Detach + display:none + reattach via
          // appendChild fires scroll events which `_handleScroll` either
          // ignores (offsetParent null) or applies (offsetParent non-null).
          // The exact timing is browser-dependent, leaving us in any of:
          //   (a) ydisp preserved, scrollTop reset → scrollbar at top, content correct
          //   (b) ydisp reset, scrollTop preserved → scrollbar at original, content at top
          //   (c) both reset → both at top  (the user-reported case)
          //   (d) both preserved → no fix needed
          // `term.scrollLines(delta)` early-returns when delta==0, so the
          // case where ydisp matches our target is a no-op and leaves the
          // DOM unsynced. We force a guaranteed resync by toggling ydisp
          // through 0 (or away from target if target==0) before scrolling
          // back, which always fires `_onScroll` → `syncScrollArea` →
          // `_innerRefresh`. _innerRefresh then sets scrollTop = ydisp *
          // rowHeight authoritatively. As a safety net we also write the
          // captured pixel value directly.
          if(p.term&&typeof p._viewportY==='number'){
            try{
              const buf=p.term.buffer.active;
              const max=Math.max(0,buf.length-p.term.rows);
              const target=Math.min(Math.max(0,p._viewportY),max);
              if(target>0){
                p.term.scrollToTop();
                p.term.scrollToLine(target);
              }else if(max>0){
                p.term.scrollToBottom();
                p.term.scrollToTop();
              }else{
                p.term.scrollToTop();
              }
            }catch{}
          }
          if(typeof p._scrollTop==='number'){
            const vp=p.el.querySelector('.xterm-viewport');
            if(vp){try{vp.scrollTop=p._scrollTop}catch{}}
          }
        }
      }
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
    });
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
    // FR-RTU-60: 지금 그리는 창. `_rSlot` 과 같은 규약이다 — 탭 본문을 붙이는
    // 자리(`_mountTabBody`)가 **그 탭이 어느 창의 것인지** 알아야 패널을 고를
    // 수 있고, 슬롯이 여럿이면 그 창은 활성 창이 아닐 수 있다.
    this._rWin=s;
    // FR-EDT-46: Editor 창은 좌우 둘로 나뉜다 — 좌측 탐색기는 분할 트리 **밖**의
    // 고정 영역이므로 트리가 붙을 자리를 우측으로 바꾼다.
    const h=app._isEditorWin(s)?this._rEditorWin(s,host):host;
    // FR-EDT-55: pane 이 하나도 없는 창이 있다. 그리기를 건너뛴다 — 죽은 편집기
    // 회수는 호출자(_rLayout)가 슬롯 바깥에서 한다.
    if(!s||!s.layout) return;
    // 포커스 보정은 **포커스 슬롯에서만** 한다. 비포커스 슬롯의 창을 그린다고
    // 해서 `app.focused`(포커스 슬롯의 pane)를 옮기면 안 된다.
    const isFocusedSlot=this._rSlot===app._slotFocused();
    if(isFocusedSlot&&!findPane(s.layout,app.focused)){
      app._setFocus(firstPane(s.layout)?.id||null,s);
    }
    let dom;
    if(app.isMobile){
      const regs=app._flattenPanes(s.layout);
      if(regs.length){
        const fIdx=regs.findIndex(r=>r.id===app.focused);
        if(fIdx>=0) app._mPaneIdx=fIdx;
        else if(app._mPaneIdx>=regs.length) app._mPaneIdx=regs.length-1;
        const target=regs[app._mPaneIdx];
        if(target){app._setFocus(target.id,s);dom=this._buildPane(target)}
      }
    }else{
      dom=this._buildNode(s.layout);
    }
    if(dom) h.appendChild(dom);
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
  _rEditorWin(s,area){
    const el=document.createElement('div'); el.className='ed-win';
    // REPO_TAB_UNIFY_SRS FR-RTU-12: 사이드는 `Explorer` 와 `Changes` 를 **탭으로
    // 갈아 끼운다** — 한 번에 하나만 보인다 (D-RTU-3).
    const side=this._rSide(s);
    side.style.width=this.app._edExplorerWidth(s)+'px';
    el.appendChild(side);
    const h=document.createElement('div'); h.className='ed-ex-handle';
    this._rEdHandle(h,s,side);
    el.appendChild(h);
    const main=document.createElement('div'); main.className='ed-area';
    // FR-EDT-55: pane 이 없는 것이지 빈 pane 이 있는 것이 아니다 — 안내문을 둔다.
    if(!s.layout){
      const hint=document.createElement('div'); hint.className='ed-empty';
      hint.textContent=EDITOR_EMPTY_HINT;
      main.appendChild(hint);
    }
    el.appendChild(main);
    area.appendChild(el);
    return main;
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
      b.addEventListener('click',()=>app._edSetSide(s,d.id));
      bar.appendChild(b);
    }
    el.appendChild(bar);
    const body=document.createElement('div'); body.className='ed-side-body';
    if(active===REPO_SIDE_CHANGES){
      // FR-RTU-32: Changes 는 **사이드에만** 있다. 본문 탭이 되지 않으므로 그
      // 뷰의 DOM 을 여기로 가져온다 — 뷰를 만드는 자리는 패널 하나다.
      const p=app._gitPanel(app._edRootOf(s),slot);
      // FR-RTU-21·22: 나머지 다섯으로 가는 진입점. **Changes 탭에만** 둔다 —
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

  // FR-RTU-21: 진입점 다섯. 누르면 본문에 그 뷰의 탭이 열리고, 이미 있으면 그
  // 탭으로 옮긴다 — 판정은 `openView` 한 자리다 (FR-RTU-31).
  _rSideActions(panel){
    const bar=document.createElement('div'); bar.className='ed-side-acts';
    for(const a of GIT_SIDE_ACTIONS){
      const b=document.createElement('button');
      b.className='ed-side-act'; b.dataset.view=a.key;
      b.textContent=a.icon; b.title=a.title;
      b.addEventListener('click',()=>panel.openView(a.key));
      bar.appendChild(b);
    }
    return bar;
  }

  // FR-EDT-47 / D-18: 폭은 워크스페이스에 저장한다 — `sidebarWidth` 와 같은
  // 규약이다 (§2.10). 드래그 중에는 화면만 바꾸고 확정은 mouseup 한 번이다.
  _rEdHandle(h,s,ex){
    h.addEventListener('mousedown',e=>{
      e.preventDefault();
      const sx=e.clientX, start=ex.offsetWidth;
      const clamp=w=>Math.max(EDITOR_EXPLORER_W_MIN,Math.min(EDITOR_EXPLORER_W_MAX,w));
      const mv=ev=>{ex.style.width=clamp(start+(ev.clientX-sx))+'px'};
      const up=ev=>{
        document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
        this.app._edSetExplorerWidth(s,clamp(start+(ev.clientX-sx)));
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
      };
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
  }

  _buildNode(n){
    if(!n) return null;
    if(n.type==='pane') return this._buildPane(n);
    if(n.type==='split'&&n.children) return this._buildSp(n);
    return null;
  }

  // 탭 하나가 탭 바에 **보이는 이름**이다. 단일 자리인 이유는 CONVENIENCE_SRS
  // FR-TAN-17 이다 — 전경 프로세스에서 파생한 이름이 붙을 때, 탭 바와 사이드바와
  // dmctl list-workspace 가 서로 다른 것을 말하면 안 된다.
  //
  // 판정과 파생은 `tabName` 한 곳에 있다 (helpers.js) — dmctl 이 같은 규칙을
  // Go 로 다시 쓰므로, 브라우저 안에서만이라도 자리가 둘이면 안 된다.
  _tabDisplayName(tab){
    return (tab.dirty?'● ':'')+tabName(tab,this.app._fgNames);
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
    if(at.type===TAB_TYPE_GIT){
      // 패널은 **(루트, 칸)마다** 있다 (FR-SVS-40·42 + FR-RTU-60) — 그래야 두
      // 칸이 같은 뷰를 볼 때 뒤 칸이 앞 칸에서 DOM 을 떼어 가지 않고, 두 Repo
      // 창이 같은 diff 대상을 다투지 않는다. 관측은 그 패널들이 함께 쓰는
      // `GitObserver` 에 하나로 있다 (FR-SVS-30).
      //
      // 루트는 **이 탭이 있는 창**의 것이다 — 그리는 중인 창이 활성 창이 아닐
      // 수 있으므로(슬롯) `_gitRootOfActive` 를 쓰지 않는다.
      const root=this.app._isEditorWin(this._rWin)?this.app._edRootOf(this._rWin):'';
      const el=this.app._gitPanel(root,slot).elFor(at.gitView);
      body.appendChild(el); el.classList.add('vis');
      return;
    }
    if(at.type==='editor'){
      const key=this.app._slotKey(at.id,slot);
      let editor=this.app.fileEditors.get(key);
      if(!editor){editor=new FileEditor(at.id,at.name,at.filePath);this.app.fileEditors.set(key,editor)}
      body.appendChild(editor.el);editor.el.classList.add('vis');
      return;
    }
    if(at.type==='run'){
      // FR-RVZ-6: 네 번째 타입. editor 와 같은 비-PTY 탭이며 at.runId 를 요구한다.
      // 루트 DOM 은 탭마다 하나로 캐시된다 — pane 을 다시 그려도 SVG 가 새로
      // 만들어지지 않아야 hover 가 살아남는다 (NFR-RVZ-2). 구현은 app-runs.js.
      const el=this.app._runViewEl(at,slot);
      body.appendChild(el); el.classList.add('vis');
      return;
    }
    // 슬롯 1 의 인스턴스는 그 슬롯이 처음 이 도구를 그릴 때 선다 — 서버 도구
    // 목록으로 미리 만들어 두는 것은 슬롯 0 뿐이다 (app.js init).
    const p=at.toolId?this.app._mkTool(at.toolId,at.name||'',slot):null;
    if(p){body.appendChild(p.el);p.el.classList.add('vis')}
  }

  _buildPane(n){
    const el=document.createElement('div');
    // FR-SVS-1: 이 pane 이 **이 칸에서** 보이는 탭. 렌더 시점의 슬롯을 클로저에
    // 붙잡아 둔다 — 이벤트 핸들러가 나중에 `_rSlot` 을 읽으면 그때의 렌더 대상을
    // 보게 된다.
    const slot=this._rSlot||0;
    const shown=this.app.paneTab(n,slot);
    // FR-PAN-9: 활성탭 pane 이 주의 상태이고 pane 이 포커스 안 됐을 때만 pane 강조
    // FR-WSL-35: 같은 창이 두 슬롯에 있으면 pane id 가 같다 — 포커스 슬롯에서만
    // 포커스로 그린다. 그러지 않으면 양쪽이 다 포커스로 보인다.
    const focused=n.id===this.app.focused&&(this._rSlot||0)===this.app._slotFocused();
    const at0=(n.tabs||[]).find(t=>t.id===shown);
    const paneAttn=!focused&&at0&&this.app._attnHas(at0.toolId);
    el.className='pn'+(focused?' focused':'')+(paneAttn?' attn':'');
    el.dataset.paneid=n.id;
    const tabs=document.createElement('div'); tabs.className='pn-tabs';
    for(const tab of(n.tabs||[])){
      const t=document.createElement('div');
      // FR-PAN-9/TC-PAN-17: 사용자가 지금 보고 있는 탭(포커스+활성)은 강조하지 않음
      const tabActive=tab.id===shown;
      const tabAttn=this.app._attnHas(tab.toolId)&&!(focused&&tabActive);
      // FR-GIT-28: git 탭은 고정이다 — 닫기·이름변경·드래그를 달지 않는다.
      // 자리가 항상 같아야 근육 기억이 선다.
      const isGit=tab.type===TAB_TYPE_GIT;
      t.className='pn-tab'+(tabActive?' active':'')+(tabAttn?' attn':'')+(isGit?' git':'');
      t.dataset.tabId=tab.id;
      if(tab.toolId) t.dataset.toolid=tab.toolId;
      if(isGit) t.dataset.gitView=tab.gitView;
      t.innerHTML='<span class="pn-tab-label"></span>'+(isGit?'':'<span class="pn-tab-x">×</span>');
      t.querySelector('.pn-tab-label').textContent=this._tabDisplayName(tab);
      // REPO_TAB_UNIFY_SRS FR-RTU-41: 미리보기 탭은 기울임이다 — "이 자리는 곧
      // 대체된다" 를 눈으로 알리는 유일한 표시다.
      if(tab.preview){ t.classList.add(REPO_PREVIEW_CLASS); t.title=REPO_PREVIEW_TITLE }
      t.addEventListener('click',e=>{
        e.stopPropagation();
        if(e.target.classList.contains('pn-tab-x')) this.app.closeTab(n.id,tab.id,null,{slot});
        else this.app.switchTab(n.id,tab.id,slot);
      });
      // FR-RTU-42: 탭 자체의 더블클릭이 고정한다. 이름 더블클릭(아래)은 이름
      // 변경이므로 그쪽이 먼저 잡히고, 그 경우도 고정으로 친다.
      t.addEventListener('dblclick',e=>{
        if(!tab.preview) return;
        e.stopPropagation();
        this.app._pinPreviewTab(tab);
      });
      // 탭은 `_renameTab` 이다 — 창의 `_rename` 과 달리 빈 문자열에 뜻이 있다
      // (FR-TAN-21).
      // FR-RTU-42: **미리보기 탭의 더블클릭은 고정이 먼저다.** 이름 변경은 그
      // 다음이다 — 곧 대체될 탭의 이름을 고치는 것은 뜻이 없고, 사용자가 기대하는
      // 것은 "이 탭을 남긴다" 이다 (VSCode 와 같은 어휘).
      if(!isGit) t.querySelector('.pn-tab-label').addEventListener('dblclick',e=>{
        e.stopPropagation();
        if(tab.preview){this.app._pinPreviewTab(tab);return}
        this.app._renameTab(tab,e.target);
      });
      t.draggable=!isGit;
      t.addEventListener('dragstart',e=>{this.app._drag={type:'tab',srcPaneId:n.id,tabId:tab.id};e.dataTransfer.effectAllowed='move';e.stopPropagation();setTimeout(()=>t.classList.add('dragging'),0)});
      t.addEventListener('dragend',()=>{this.app._drag=null;t.classList.remove('dragging');tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none')});
      t.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));const rect=t.getBoundingClientRect();t.classList.add(e.clientX<rect.left+rect.width/2?'drag-left':'drag-right');document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none')});
      t.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='tab')return;const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));const s=this.app._aw();if(!s)return;if(srcPaneId===n.id){const pn=findPane(s.layout,n.id);if(!pn)return;const si=pn.tabs.findIndex(tt=>tt.id===tabId);const di=pn.tabs.findIndex(tt=>tt.id===tab.id);if(si<0||di<0||si===di)return;const rect=t.getBoundingClientRect();const insBefore=e.clientX<rect.left+rect.width/2;const[moved]=pn.tabs.splice(si,1);let ins=pn.tabs.findIndex(tt=>tt.id===tab.id);if(!insBefore)ins++;pn.tabs.splice(ins,0,moved);this.app.paneTabSet(pn,tabId,slot);this.app._save();this.app.render()}else{const rect=t.getBoundingClientRect();this.app._moveTabToPane(srcPaneId,tabId,n.id,tab.id,e.clientX<rect.left+rect.width/2)}});
      tabs.appendChild(t);
    }
    // FR-GIT-180: Git 창에는 `+` 자리를 만들지 않는다 — 눌리지만 아무 일도 하지
    // 않는 버튼은 고장으로 읽힌다.
    // FR-EDT-54: Editor 창의 탭은 편집기뿐이고 `+` 가 만들 수 있는 것이 없다 —
    // Git 창과 같은 이유로 자리를 만들지 않는다.
    const aw=this.app._aw();
    const noAdd=this.app._isGitWin(aw)||this.app._isEditorWin(aw);
    if(!noAdd){
      const add=document.createElement('button'); add.className='pn-tab-add'; add.textContent='+';
      add.addEventListener('click',e=>{e.stopPropagation();this.app.addTab(n.id)});
      tabs.appendChild(add);
    }
    tabs.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();if(this.app._drag.srcPaneId!==n.id)tabs.classList.add('drag-target')});
    tabs.addEventListener('dragleave',e=>{if(!tabs.contains(e.relatedTarget))tabs.classList.remove('drag-target')});
    tabs.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();tabs.classList.remove('drag-target');tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));if(!this.app._drag||this.app._drag.type!=='tab')return;const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;const s=this.app._aw();if(!s)return;if(srcPaneId===n.id){const pn=findPane(s.layout,n.id);if(!pn)return;const si=pn.tabs.findIndex(t=>t.id===tabId);if(si<0)return;const[moved]=pn.tabs.splice(si,1);pn.tabs.push(moved);this.app.paneTabSet(pn,tabId,slot);this.app._save();this.app.render()}else{this.app._moveTabToPane(srcPaneId,tabId,n.id,null,false)}});
    el.appendChild(tabs);
    const body=document.createElement('div'); body.className='pn-body';
    const at=(n.tabs||[]).find(t=>t.id===shown);
    if(at) this._mountTabBody(body,at);
    body.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));this.app._showBodyDropIndicator(body,this.app._getDragZone(body,e))});
    body.addEventListener('dragleave',e=>{if(!body.contains(e.relatedTarget))this.app._clearBodyDropIndicator(body)});
    body.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='tab')return;const zone=this.app._getDragZone(body,e);const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;this.app._clearBodyDropIndicator(body);if(zone==='center'){if(srcPaneId===n.id)return;this.app._moveTabToPane(srcPaneId,tabId,n.id,null,false)}else{this.app._splitPaneWithTab(srcPaneId,tabId,n.id,zone)}});
    el.appendChild(body);
    el.addEventListener('mousedown',()=>{
      this.app.setFocus(n.id);
      // FR-MTI-25: 모바일에서 키보드를 올리는 유일한 경로. render 는 focus 하지
      // 않으므로(위) 여기서 하지 않으면 모바일에서 입력을 시작할 길이 없다.
      // 스크롤 제스처는 touchmove 가 blur 하고 합성 mousedown 도 만들지 않는다.
      if(this.app.isMobile){
        const pn=findPane(this.app._aw()?.layout,n.id);
        const tab=pn&&(pn.tabs||[]).find(t=>t.id===this.app.paneTab(pn,slot));
        if(tab&&tab.type!=='editor'){
          const p=this.app._toolAny(tab.toolId);
          if(p) p.focus();
        }
      }
    });
    return el;
  }

  _buildSp(n){
    const el=document.createElement('div'); el.className='sp'; el.dataset.d=n.direction; el._node=n;
    for(let i=0;i<n.children.length;i++){
      const sc=document.createElement('div'); sc.className='sc';
      if(n.sizes&&n.sizes[i]!=null) sc.style.flex=n.sizes[i];
      const built=this._buildNode(n.children[i]);
      if(built) sc.appendChild(built);
      el.appendChild(sc);
      if(i<n.children.length-1){const h=document.createElement('div');h.className='sh';el.appendChild(h);this._handle(h,el)}
    }
    return el;
  }

  _handle(h,sp){
    h.addEventListener('mousedown',e=>{
      e.preventDefault();
      const dir=sp.dataset.d, prev=h.previousElementSibling, next=h.nextElementSibling;
      const sx=e.clientX, sy=e.clientY;
      const tot=dir==='horizontal'?prev.offsetWidth+next.offsetWidth:prev.offsetHeight+next.offsetHeight;
      const start=dir==='horizontal'?prev.offsetWidth:prev.offsetHeight;
      const mv=e=>{
        if(dir==='horizontal'){
          const nw=start+(e.clientX-sx);if(nw<60||tot-nw<60)return;
          prev.style.flex=`${nw/tot}`;next.style.flex=`${(tot-nw)/tot}`;
        }else{
          const nh=start+(e.clientY-sy);if(nh<60||tot-nh<60)return;
          prev.style.flex=`${nh/tot}`;next.style.flex=`${(tot-nh)/tot}`;
        }
      };
      const up=()=>{
        document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
        const nd=sp._node;
        if(nd){nd.sizes=[];for(const c of sp.children){if(c.classList.contains('sc'))nd.sizes.push(parseFloat(c.style.flex)||1)}this.app._save()}
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
      };
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
  }
}
