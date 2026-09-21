/**
 * Remote Terminal — App 포커스 동기화 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 11개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
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
  },

  // _focusWindow is the SINGLE entry point for claiming window ownership.
  // Applies the claim locally, posts it to the server (which broadcasts the
  // full map to every client), sends resize, and updates the overlay.
  //
  // FR-WSL-12: `slot` 을 생략하면 포커스 슬롯이다 — 단일 슬롯 모드의 호출부 여덟
  // 자리가 한 글자도 바뀌지 않아야 한다.
  _focusWindow(windowId,slot){
    if(!windowId) return;
    const si=(slot==null)?this.slotFocused():slot;
    const cid=this._slotIdentity(si);
    let changed=false;
    // Release other windows this SLOT owns (one slot → one window).
    for(const sid of Object.keys(this._windowFocusOwner)){
      if(sid!==windowId&&this._windowFocusOwner[sid]===cid){
        delete this._windowFocusOwner[sid];
        changed=true;
      }
    }
    if(this._windowFocusOwner[windowId]!==cid){
      this._windowFocusOwner[windowId]=cid;
      changed=true;
    }
    // Only post if ownership actually changes — otherwise every click on an
    // already-owned window would hit the server.
    if(changed) this._focusClaim(windowId,cid);
    // Send resize immediately (before render) so PTY matches this window's
    // size by the time the user sees the panes. Only if OS-focused.
    if(this.windowFocused) this.resendWindowSizes(windowId,si);
    this.applyFocusOverlay();
  },

  /**
   * FR-UXB-24: 이 창이 쥐어야 할 것을 **전부** 되찾는다.
   *
   * 자리가 셋이다 — 포커스 복귀·SSE 복귀(`_focusRestore`)·부팅. 셋이 같은 함수를
   * 부르지 않으면 칸 여럿의 재주장이 한 자리에서만 온전해진다 (실제로 그랬다).
   */
  _focusReclaim(){
    if(this._slots) this._slotClaimAll();
    else if(this.ws.activeWindow) this._focusWindow(this.ws.activeWindow,0);
  },

  /**
   * FR-UXB-20·23·29 / D-UXB-3: **blur 의 반납.**
   *
   * OS 포커스를 잃은 화면은 창을 붙들고 있을 이유가 없다. 반납이 없던 동안,
   * 창을 빼앗은 쪽이 떠나도 빼앗긴 쪽은 영영 dim 이었다 (SRS §2.4).
   *
   * 구독은 끊지 않는다 — 그것은 해제(FR-XDF-9)이고 다른 동사다.
   *
   * **놓을 것이 없으면 종단에 닿지 않는다** (FR-UXB-29). alt-tab 마다 요청이
   * 나가면 그것이 곧 폭주이고, 서버의 멱등성은 그 비용까지 덮어 주지 않는다.
   */
  _focusReleaseAll(){
    const mine=new Set(this._slots?this._slotIdentities():[this.clientId]);
    const drop=new Set();
    for(const sid of Object.keys(this._windowFocusOwner)){
      if(!mine.has(this._windowFocusOwner[sid])) continue;
      drop.add(this._windowFocusOwner[sid]);
      delete this._windowFocusOwner[sid];
    }
    if(!drop.size) return;
    for(const cid of drop) apiPost('/api/focus/release',{clientId:cid});
    this.applyFocusOverlay();
  },

  /**
   * FR-UXB-26·27: 돌아왔다. 화면과 관측을 함께 깨운다.
   *
   * 순서가 있다 — 먼저 그리고 그다음에 수집한다. 수집의 답은 비동기이고, 그
   * 답을 기다려 그리면 사용자는 돌아온 뒤에도 한 왕복만큼 옛 화면을 본다.
   */
  _onLifeResume(){
    this.render();
    TIMERS.revalidate();
  },

  // _focusClaim posts ownership to the server (FR-XDF-7). The server answers by
  // broadcasting the full owner map, which is what actually converges every
  // client — this POST is fire-and-forget.
  _focusClaim(windowId,clientId){
    apiPost('/api/focus/claim',{clientId:clientId||this.clientId,windowId});
  },

  // _focusRestore aligns local state with the server on SSE connect
  // (FR-XDF-11), then RE-CLAIMS if this client holds OS focus (FR-XDF-12).
  //
  // The re-claim is not optional. The server releases ownership the moment the
  // subscription drops (FR-XDF-9), so after a reconnect nobody owns the window
  // — and without re-claiming, _focusWindow's "only if ownership changes" guard
  // would never fire again for a client that still remembers owning it.
  // Re-claiming only when OS-focused keeps a backgrounded device from stealing
  // the PTY size back from the active one (FR-XDF-13).
  /**
   * FR-XDF-6: 서버가 미는 **전체 소유권 맵**. 증분이 아니므로 통째로 갈아치우면
   * 되고 자기 에코 필터가 필요 없다 (FR-XDF-14 — 멱등).
   *
   * 종전에는 이 배선이 `app-cmd.js` 의 `onmessage` 안에 익명으로 있었다. 이름을
   * 주는 이유는 `state-registry` 가 그것을 가리켜야 하기 때문이다 — 이름 없는
   * 핸들러는 등록부에 설 수 없다.
   */
  _onWindowFocus(a){
    this._windowFocusOwner=(a&&a.owners)||{};
    // FR-UXB-25: dim 이 **풀린** 칸은 그동안 사용자가 보지 못하던 화면이다 —
    // 클래스만 갈고 끝내면 되찾은 자리에 옛 그림이 남는다.
    if(this.applyFocusOverlay()) this.render();
  },

  /**
   * 합류·복귀 시의 스냅샷. `state-registry` 의 `merge:'latest'` — 추월만 막는다.
   */
  _focusRestore(){
    const t=this._restoreBegin('focus');
    apiGet('/api/focus').then(res=>{
      const j=res.ok?res.data:null;
      if(!j) return;
      if(!this._restoreLive('focus',t)) return;
      this._restoreEnd('focus',t);
      this._windowFocusOwner=j.owners||{};
      this.applyFocusOverlay();
      // FR-WSL-12: 슬롯이 둘이면 둘 다 재주장한다 — 각 슬롯의 구독이 따로 끊기고
      // 따로 해제되므로, 하나만 되찾으면 다른 칸이 영영 dim 된 채로 남는다.
      // (FR-UXB-24 가 그 규약을 포커스 복귀에도 세우면서 자리가 하나가 됐다.)
      if(this.windowFocused) this._focusReclaim();
    }).catch(()=>{});
  },

  // resizeCheck returns true if this window is allowed to send resize for
  // a given pane (has OS focus + owns the pane's window or it's unowned).
  //
  // FR-WSL-14: `slot` 은 **묻는 인스턴스가 선 슬롯**이다. 같은 창이 두 슬롯에 있으면
  // toolId 가 같으므로, 슬롯을 묻지 않으면 두 인스턴스가 모두 허가를 받아 서로
  // 다른 크기를 PTY 에 보낸다 — 크기는 하나뿐이다.
  resizeCheck(toolId,slot){
    if(!this.windowFocused) return false;
    const sid=this._toolWindowId(toolId);
    if(!sid) return true; // pane not in any window yet → allow
    const owner=this._windowFocusOwner[sid];
    if(!owner) return true;
    return owner===this._slotIdentity(slot||0);
  },

  // applyFocusOverlay syncs the DOM: panes whose window is owned by
  // another window get the dimmed overlay (pn-dimmed class).
  //
  // FR-WSL-14: 판정이 pane 마다 갈린다 — 같은 창이 두 슬롯에 있으면 한쪽만 소유하고
  // 다른 쪽은 흐려져야 한다. 그래서 "내 것인가" 를 앱 전체가 아니라 **그 pane 이
  // 선 슬롯의 신원**으로 묻는다.
  /**
   * FR-UXB-25: **dim 이 풀린 칸이 있었는지**를 돌려준다. 부르는 쪽이 그때
   * 다시 그린다 — 판정을 여기서 하는 이유는 이전 상태를 아는 자리가 여기뿐이기
   * 때문이다.
   */
  applyFocusOverlay(){
    let freed=false;
    for(const pn of document.querySelectorAll('.pn')){
      const slotEl=pn.closest?pn.closest('.slot'):null;
      const slot=slotEl?(parseInt(slotEl.dataset.slot,10)||0):0;
      const mine=this._slotIdentity(slot);
      let dim=false;
      for(const t of pn.querySelectorAll('.pn-tab[data-toolid]')){
        const sid=this._toolWindowId(t.dataset.toolid);
        if(!sid) continue;
        const owner=this._windowFocusOwner[sid];
        if(owner&&owner!==mine){dim=true;break}
      }
      if(pn.classList.contains('pn-dimmed')&&!dim) freed=true;
      pn.classList.toggle('pn-dimmed',dim);
    }
    return freed;
  },

  // _toolWindowId returns the window id containing a pane (by walking the
  // workspace layout tree). Returns null if the pane is not in any window.
  _toolWindowId(toolId){
    if(!toolId) return null;
    for(const s of this.ws.windows){
      if(!s||!s.layout) continue;
      let found=null;
      const walk=n=>{
        if(!n||found) return;
        if(n.type==='pane'&&n.tabs){
          for(const t of n.tabs) if(t.toolId===toolId){found=s.id;return}
        }
        if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
      };
      walk(s.layout);
      if(found) return found;
    }
    return null;
  },

  // resendWindowSizes sends resize for every pane in a window.
  // Sends even for hidden panes (they retain last-visible dimensions) so the
  // PTY is sized correctly BEFORE render, avoiding a one-frame glitch.
  resendWindowSizes(windowId,slot){
    if(!windowId) return;
    const si=(slot==null)?this.slotFocused():slot;
    // Don't send resize if another slot/client owns this window.
    const owner=this._windowFocusOwner[windowId];
    if(owner&&owner!==this._slotIdentity(si)) return;
    const s=this.ws.windows.find(x=>x.id===windowId);
    if(!s||!s.layout) return;
    const toolIds=new Set();
    const walk=n=>{
      if(!n) return;
      if(n.type==='pane'&&n.tabs){
        for(const t of n.tabs) if(t.toolId) toolIds.add(t.toolId);
      }
      if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
    };
    walk(s.layout);
    for(const pid of toolIds){
      const p=this.tools.get(this.slotKey(pid,si));
      // Send resize even if pane is hidden — the dimensions were set when
      // it was last visible and are still valid. This avoids a visible
      // glitch where the PTY renders at the wrong size for one frame.
      if(!p||!p.term) continue;
      // FR-M10-1: 보내는 값은 `term.cols` 가 아니라 pane 이 답하는 **자기 크기**다.
      // 비소유 동안 `term.cols` 는 PTY 폭으로 덮여 있고(FR-M9-3), 그것을 되보내면
      // 되찾아도 PTY 가 그대로다 — 그것이 M10-B1 이었다 (M10_SRS §2.2).
      const sz=p.ptySize&&p.ptySize();
      if(!sz) continue;
      const m=new Uint8Array(5);m[0]=0x01;
      new DataView(m.buffer).setUint16(1,sz.cols,false);
      new DataView(m.buffer).setUint16(3,sz.rows,false);
      p._send(m);
    }
  },
});
