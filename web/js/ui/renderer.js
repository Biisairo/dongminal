/**
 * Dongminal — layout → DOM renderer (클래스 본문)
 *
 * App 의 render / _rSidebar / _rTopbar / _rLayout / _buildNode / _buildPane
 * / _buildSp / _handle 책임을 분리. Renderer 내부 메서드 호출은 this.X 로,
 * App 상태·메서드는 this.app.X 로 접근한다. 동작은 1:1 보존.
 *
 * **2026-09-21: 넷으로 갈랐다** (`STRUCTURE_CLEANUP_SRS` FR-STR-44 ·
 * `FE_MODULE_BOUNDARY_SRS` N3 개정).
 *
 * `FE_MODULE_BOUNDARY_SRS` N3 이 이 파일을 분할 대상에서 뺀 근거는 *"응집도가
 * 있다"* 였고 그때는 옳았다. 다만 **근거가 줄 수가 아니라 응집도였으므로 줄이
 * 늘어도 판단이 자동으로 재검토되지 않았다** — 1,336 → 1,586(+19%). 실측으로
 * 이 파일은 넷을 하고 있었고(`AUDIT-fe-ui.md` M-9), 그 넷이 이제 파일이다:
 *
 *   renderer.js          클래스 본문 · 골격 캐시(`_keep`/`_place`/`_domGC`) · `render()`
 *   renderer-scroll.js   스크롤 갈무리·복원 · 터미널 시선
 *   renderer-chrome.js   사이드바 탭 · 목록 · 창 이름 · 탑바 · 창의 사이드와 손잡이
 *   renderer-layout.js   칸 · 창 · 편집기 창
 *   renderer-pane.js     노드 · pane · 탭 · 탭 조립 · 분할
 *
 * **증강 분할이다** — `Object.assign(Renderer.prototype, …)` 이므로 계약은 한
 * 글자도 바뀌지 않는다 (`FE_MODULE_BOUNDARY_SRS` 묶음 B·C 와 같은 절차).
 * `index.html` 의 순서는 `check-load-order.mjs` 가 지킨다 (C-2).
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
      // FR-PRF-30: 골격에 얹힌 관측자를 함께 끊는다. `_domGC` 가 이 저장소의
      // **유일한 골격 수거 지점**이므로 자리가 하나다 — 떼는 쪽이 여럿이면
      // 한 곳이 반드시 빠진다.
      if(el&&el._tabOverflowRo) el._tabOverflowRo.disconnect();
      if(el&&el.remove) el.remove();
    }
  }

  render(){
    const oldFocus=this.app.prevFocus;
    this.app.prevFocus=this.app.focused;
    if(oldFocus!==undefined&&oldFocus!==this.app.focused){
      this.app.clearAllSearchDecorations();
      this.app.researchIfOpen();
    }
    this.app.applyMobileMode();
    this._rSbTabs();this._rLists();this._rTopbar();this._rLayout();
    // UX_BATCH6_SRS FR-SCR-2: 갈무리해 둔 스크롤을 되돌린다. **여기여야 한다** —
    // 요소가 문서에 붙은 뒤에만 `scrollTop` 이 값을 받는다.
    this._restoreScroll();
    this.app.updateCwd();
    this.app.updateStatusBar();
    // Apply window focus overlay after every render so the DOM is
    // guaranteed to exist (BroadcastChannel may trigger applyFocusOverlay
    // before the first render completes).
    this.app.applyFocusOverlay();
    // UX_BATCH9_SRS FR-GLR-1: 그리고 난 자리에서 묻는다 — 지금 보이는 표면의
    // 관측이 멎어 있지는 않은가. 표면 판정이 정확하려면 레이아웃이 선 **뒤**여야
    // 한다.
    //
    // GIT_LIVE_TRIGGERS_SRS D-5: 이 훅은 이제 **둘 중 하나**다. 나머지 하나는
    // `_initGitSection` 의 주기 job 이고, 둘은 `_gitWdAt` 문턱을 공유하므로 합쳐도
    // 검사는 `GIT_WATCHDOG_CHECK_MS` 당 한 번을 넘지 않는다. 렌더 쪽을 남기는
    // 이유는 표면이 막 바뀐 직후를 가장 이르게 잡기 때문이다.
    this.app.gitWatchdogAll();
  }
}
