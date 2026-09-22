/**
 * Remote Terminal — App 포커스 동기화 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드들. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 *
 * **창 소유권은 이 파일에 없다** — `app-focus-owner.js` 가 갖는다 (FR-STR-40 이
 * 이 파일을 500줄 위로 밀었고, 가른 자리가 이미 있던 경계와 같다). 여기 남은
 * 것은 *이 화면 안의* 포커스다: 이력·이동·가장자리·복귀의 계기.
 */
Object.assign(App.prototype, {
  // setFocusState is the single entry point for the focus invariant
  // (this.focused === active window.focusedPane). It accepts an optional
  // window reference; when omitted, the active window is used. When the
  // mutated window is not the active one, only its focusedPane is updated
  // (this.focused unchanged). REG-2~8 회귀 클래스 차단용 단일 진입점.
  setFocusState(rid, sess){
    const target = sess || this.aw();
    const moved = !!rid && this.focused !== rid;
    if(target) target.focusedPane = rid;
    if(!sess || (target && target.id === this.ws.activeWindow)){
      this.focused = rid;
      /**
       * REPO_TAB_UNIFY_SRS FR-RTU-80: **포커스가 옮겨 갔으면 모바일도 그 자리로.**
       *
       * 모바일 순회의 첫 자리는 사이드이고(FR-RTU-80) 사이드는 분할 트리 밖이라
       * 포커스의 대상이 아니다. 그래서 사이드에 서 있는 동안 렌더는 포커스를
       * 따라가지 않는다 — 그러지 않으면 사이드에 설 수 없다.
       *
       * 그런데 파일을 열거나 뷰 탭을 여는 일은 **포커스를 옮기는 일**이고, 그때는
       * 그 자리를 보여야 한다: 열었는데 보이지 않으면 사용자는 실패로 읽는다
       * (FR-EDT-102 와 같은 근거). 그 구분이 여기서 난다 — 포커스가 실제로
       * 바뀐 부름만 사이드를 떠난다.
       *
       * FR-RTU-83: **이 자리만으로는 모자라다.** 이미 포커스인 pane 에 여는
       * 부름은 `moved` 가 거짓이라 여기를 지나지 않는다 — 그래서 여는 쪽이
       * `mobileShowPane` 을 직접 부른다 (`edOpenFile`·`openView`·
       * `_docRenderOpen`). 여기는 그 함수의 **포커스 경로**일 뿐이다.
       */
      if(moved && this.isMobile && this.mobileOnSide&&this.mobileOnSide()){
        this.mobileShowPane(rid);
      }
      // ATTENTION_FIRING_SRS FR-ATA-1: 포커스는 더 이상 해제가 아니다. 여기
      // 있던 `_attnClearFocused()` 가 "사용자가 보기 전에 알람이 사라진다" 의
      // 마지막 고리였다 — 해제는 `_attnNoteInteraction` 한 자리에서만 온다.
    }
    this.agentsRender(); // 외부 포커스 변경도 카드 .focused 에 즉시 반영(render 미경유 경로 포함)
    this._persistFocusedPanes();
    // M9_SRS FR-M9-24: **보던 자리의 기록은 여기 한 자리에서 난다.** 창 전환도
    // 탭 전환도 칸 포커스도 전부 이 함수를 지난다 — 진입점마다 적으면 한쪽만
    // 고쳐진다 (이 저장소가 반복해 겪은 형태다).
    this._navNote();
  },

  // ── 보던 자리 오가기 (M9_SRS FR-M9-24 · D-M9-17) ──────────

  /**
   * 지금 자리. **(창, 칸, 탭) 셋**이다 (D-M9-17).
   *
   * 탭까지 보는 것은 같은 칸 안의 탭 전환이 사용자에게는 "다른 도구로 갔다" 이기
   * 때문이다 — 창·칸만으로는 그것을 되돌릴 수 없다. 커서는 이 밖이다: 편집기
   * 안의 점프는 `_lspBack`(FR-LSP-27)이 자기 스택으로 갖고 있고 성격이 다르다.
   */
  _navPlace(){
    const s=this.aw(); if(!s||!s.layout) return null;
    const rid=this.focused; if(!rid) return null;
    const pn=findPane(s.layout,rid); if(!pn) return null;
    return {win:s.id,pane:rid,tab:this.paneTab(pn,this.slotFocused())||null};
  },

  _navSame(a,b){ return !!a&&!!b&&a.win===b.win&&a.pane===b.pane&&a.tab===b.tab },

  /**
   * 자리가 바뀌었으면 **앞 자리를** 기록에 넣는다.
   *
   * 오가는 중에는 적지 않는다 (`_navMoving`) — 그러지 않으면 뒤로 한 번이 새
   * 기록을 만들어 앞으로가 영영 서지 않는다.
   */
  _navNote(){
    if(this._navMoving) return;
    const p=this._navPlace();
    if(!p||this._navSame(p,this._navCur)) return;
    if(this._navCur){
      this._navBack=this._navBack||[];
      this._navBack.push(this._navCur);
      // 무한히 쌓으면 그 자체가 새는 자리다 (`_lspBack` 과 같은 근거).
      while(this._navBack.length>FOCUS_NAV_MAX) this._navBack.shift();
      // 새 자리로 간 순간 앞길은 사라진다 — 브라우저 히스토리와 같은 규약이다.
      this._navFwd=[];
    }
    this._navCur=p;
  },

  /** 그 자리가 아직 있는가. 창·칸·탭 셋 다 있어야 갈 수 있다. */
  _navAlive(p){
    if(!p) return false;
    const s=this.ws.windows.find(x=>x&&x.id===p.win); if(!s||!s.layout) return false;
    const pn=findPane(s.layout,p.pane); if(!pn) return false;
    return !p.tab||(pn.tabs||[]).some(t=>t&&t.id===p.tab);
  },

  /**
   * 그 자리로 간다. 창이 다르면 창부터 옮기고, 그 다음 칸·탭이다 —
   * `switchTab` 이 비활성 창의 칸도 다루지만 사용자가 보는 창이 따라가야 한다.
   */
  _navGo(p){
    this._navMoving=true;
    try{
      if(this.ws.activeWindow!==p.win) this.switchWindow(p.win);
      if(p.tab) this.switchTab(p.pane,p.tab);
      else this.setFocusState(p.pane);
      this._navCur=this._navPlace()||p;
    } finally { this._navMoving=false }
  },

  /**
   * 뒤로·앞으로. `d` 는 -1(뒤로)·+1(앞으로)다.
   *
   * **사라진 자리는 건너뛴다** (FR-M9-24). 창을 닫거나 탭을 지운 뒤에도 기록은
   * 남아 있고, 그 자리로 가려 들면 아무 일도 일어나지 않은 채 기록만 줄어든다 —
   * 사용자에게는 "키가 안 듣는다" 로 보인다.
   */
  _navMove(d){
    const from=d<0?(this._navBack=this._navBack||[]):(this._navFwd=this._navFwd||[]);
    const to=d<0?(this._navFwd=this._navFwd||[]):(this._navBack=this._navBack||[]);
    while(from.length){
      const p=from.pop();
      if(!this._navAlive(p)) continue;
      if(this._navCur) to.push(this._navCur);
      this._navGo(p);
      return true;
    }
    return false;
  },

  navBack(){ return this._navMove(-1) },
  navForward(){ return this._navMove(1) },

  /** 두 더미의 길이. 검사가 "돌아갔다" 와 "새로 갔다" 를 가르는 근거다. */
  _navCounts(){
    return {back:(this._navBack||[]).length,fwd:(this._navFwd||[]).length};
  },

  // Persist per-window focusedPane map to sessionStorage so a refresh
  // restores the same view (multi-window: each window owns its viewport).
  _persistFocusedPanes(){
    try{
      const map={};
      for(const s of this.ws.windows){
        if(s.focusedPane) map[s.id]=s.focusedPane;
      }
      sessionStorage.setItem('focusedPanes', JSON.stringify(map));
    }catch{}
  },

  setFocus(rid){
    // Claim window ownership on every click — even if focus doesn't change,
    // the user is asserting "I want this window" (multi-window).
    this._focusWindow(this.ws.activeWindow);
    if(this.focused===rid) return;
    this.clearAllSearchDecorations();
    this.setFocusState(rid);
    this.prevFocus=rid;
    document.querySelectorAll('.pn').forEach(el=>{
      el.classList.toggle('focused',el.dataset.paneid===rid);
    });
    this.researchIfOpen();
    this.updateCwd();
    // FR-FLW-3: 목록은 핀에서만 오므로 포커스와 무관하다 — 여기서 새로 조회하지
    // 않는다. `+ Add` 가 딛는 마지막 터미널만 갱신한다 (D-FLW-6).
    this._gitTermToolId();
    this.updateStatusBar();
    this.save();
  },

  // ═══════════════════════════════════════════════════════════════════════
  //  Window Focus Ownership (multi-window)
  // ═══════════════════════════════════════════════════════════════════════
  //
  //  Rules:
  //    • Each window has ONE focus owner — the last window that focused on it.
  //    • The owner controls PTY size for that window's panes.
  //    • All other windows see that window dimmed (pn-dimmed overlay).
  //    • If no window owns a window, all windows see it bright.
  //
  //  State:
  //    _windowFocusOwner : { windowId → clientId } — server-authoritative
  //    windowFocused      : boolean (OS focus on this client)
  //
  //  Transport (FR-XDF-5/6): the server owns the map. Claims go out as
  //  POST /api/focus/claim; every change comes back over the existing command
  //  SSE as a `window_focus` event carrying the FULL map. The previous
  //  BroadcastChannel('dongminal-focus') path is gone — it was same-browser
  //  same-origin only, so it never reached another device, and under --expose
  //  even localhost:PORT and <host-ip>:PORT were isolated (SRS §2.7).
  //
  //  Release (FR-XDF-9): the server releases when the SSE subscription drops.
  //  There is no `beforeunload` handler — it does not fire on a remote device's
  //  force-quit or network loss, which left ownership stuck forever.
  //
  //  Single entry point:
  //    _focusWindow(sid)  — claim ownership, POST, resize, overlay.
  //    Called from: setFocus, switchWindow, _focusLocation, jumpToTool,
  //                 _mkWindow, addTab(existing), window.focus, split.
  // ═══════════════════════════════════════════════════════════════════════

  // _initFocusSync wires the OS focus listeners. Ownership transport lives in
  // _focusClaim (out) and the `window_focus` SSE branch (in).
  _initFocusSync(){
    window.addEventListener('focus',()=>{
      this.windowFocused=true;
      this._paintFocusEdge();
      this._paintAttnEdge();
      // UX_BATCH10_SRS FR-UXB-24: **모든 칸**을 되찾는다. 칸마다 신원이 다르므로
      // (FR-WSL-10) 포커스 칸 하나만 주장하면 나머지 칸은 dim 인 채로 남는다 —
      // 접수된 "포커스를 다시 가져오지 못한다" 의 절반이 이것이었다.
      this._focusReclaim();
    });
    window.addEventListener('blur',()=>{
      this.windowFocused=false;
      this._paintFocusEdge();
      this._focusReleaseAll();
    });
    /**
     * FR-UXB-26 / D-UXB-5: **복귀의 계기는 버스 한 자리다.**
     *
     * 돌아온 화면이 옛 그림인 것은 두 가지가 겹친 결과다 — 렌더가 돌지 않고,
     * 폴링도 다시 돌지 않는다. 둘 다 여기서 한 번에 푼다. 문서에 리스너를 새로
     * 달지 않는 것은 FR-BUS-8 의 규약이다.
     */
    for(const topic of [LIFE_FOCUS,LIFE_VISIBLE])
      this.bus.subscribe(topic,()=>this._onLifeResume(),{owner:'focus:resume'});
    // FR-UFE-8: 첫 화면도 실제 상태를 말한다 — 배경 탭에서 연 창은 이벤트가 한
    // 번도 오지 않으므로, 여기서 한 번 칠하지 않으면 포커스가 없는 채로 포커스
    // 있는 얼굴을 하고 있다. (`windowFocused` 의 초기값은 `document.hasFocus()`)
    this._paintFocusEdge();
  },

  /**
   * UNFOCUSED_EDGE_SRS FR-UFE-6·7: 가장자리 표시의 유일한 스위치.
   *
   * 조건이 둘인 것이 요점이다 — **설정이 켜져 있고, 포커스가 없을 때**만 붙는다.
   * 포커스 상태는 `windowFocused` 하나에서 읽는다 (D-8): 여기서 `hasFocus()` 를
   * 다시 물으면 이벤트가 아직 안 온 순간에 두 값이 갈린다.
   */
  _paintFocusEdge(){
    const ds=document.documentElement;
    // FR-UFE-17 / D-8b·D-8c·D-8e: 레벨 하나에서 두 값을 편다. 파생을 CSS 의
    // `calc()` 로 미루지 않는 이유는 그 관계가 곡선의 성질이지 표현이 아니어서다.
    const a=focusEdgeLevel*UFE_ALPHA_PER_LEVEL;
    ds.style.setProperty('--ufe-alpha',a);
    ds.style.setProperty('--ufe-alpha-mid',+(a*UFE_ALPHA_MID_RATIO).toFixed(4));
    // 0 은 곧 끔이다 (D-4a) — 스위치를 따로 묻지 않는다.
    ds.classList.toggle(WIN_UNFOCUSED_CLASS, focusEdgeLevel>0 && !this.windowFocused);
  },

  /**
   * ALERT_MOBILE_CONTEXT_SRS FR-AED-13: 알림 가장자리의 세기.
   *
   * 포커스 표시와 같은 규약이다 — 레벨 하나에서 알파를 펴고, 0 이면 켜지지
   * 않는다. 보일지의 판정(`attn-edge-on`)은 여기 없다: 그것은 알림의 유무이고
   * `_attnRefresh` 가 이미 그 자리에서 결정한다 (FR-AED-6, 진실을 둘로 만들지
   * 않는다).
   */
  _paintAttnEdge(){
    document.documentElement.style.setProperty('--ae-alpha',
      attnEdgeLevel*ATTN_EDGE_ALPHA_PER_LEVEL);
  }
});
