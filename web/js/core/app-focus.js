/**
 * Remote Terminal — App 포커스 동기화 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 11개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // _setFocus is the single entry point for the focus invariant
  // (this.focused === active window.focusedPane). It accepts an optional
  // window reference; when omitted, the active window is used. When the
  // mutated window is not the active one, only its focusedPane is updated
  // (this.focused unchanged). REG-2~8 회귀 클래스 차단용 단일 진입점.
  _setFocus(rid, sess){
    const target = sess || this._aw();
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
       */
      if(moved && this.isMobile && this._mobileOnSide&&this._mobileOnSide()){
        const s=this._aw();
        const regs=(s&&s.layout)?this._flattenPanes(s.layout):[];
        const i=regs.findIndex(r=>r&&r.id===rid);
        if(i>=0) this._mPaneIdx=i+this._mobileSideSlots();
      }
      // ATTENTION_FIRING_SRS FR-ATA-1: 포커스는 더 이상 해제가 아니다. 여기
      // 있던 `_attnClearFocused()` 가 "사용자가 보기 전에 알람이 사라진다" 의
      // 마지막 고리였다 — 해제는 `_attnNoteInteraction` 한 자리에서만 온다.
    }
    this._agentsRender(); // 외부 포커스 변경도 카드 .focused 에 즉시 반영(render 미경유 경로 포함)
    this._persistFocusedPanes();
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
    this._clearAllSearchDecorations();
    this._setFocus(rid);
    this._prevFocus=rid;
    document.querySelectorAll('.pn').forEach(el=>{
      el.classList.toggle('focused',el.dataset.paneid===rid);
    });
    this._researchIfOpen();
    this._updateCwd();
    // FR-FLW-3: 목록은 핀에서만 오므로 포커스와 무관하다 — 여기서 새로 조회하지
    // 않는다. `+ Add` 가 딛는 마지막 터미널만 갱신한다 (D-FLW-6).
    this._gitTermToolId();
    this._updateStatusBar();
    this._save();
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
  //    _windowFocused      : boolean (OS focus on this client)
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
  //    Called from: setFocus, switchWindow, _focusLocation, _jumpToTool,
  //                 _mkWindow, addTab(existing), window.focus, split.
  // ═══════════════════════════════════════════════════════════════════════

  // _initFocusSync wires the OS focus listeners. Ownership transport lives in
  // _focusClaim (out) and the `window_focus` SSE branch (in).
  _initFocusSync(){
    window.addEventListener('focus',()=>{
      this._windowFocused=true;
      if(this.ws.activeWindow) this._focusWindow(this.ws.activeWindow);
    });
    window.addEventListener('blur',()=>{this._windowFocused=false});
  },

  // _focusWindow is the SINGLE entry point for claiming window ownership.
  // Applies the claim locally, posts it to the server (which broadcasts the
  // full map to every client), sends resize, and updates the overlay.
  //
  // FR-WSL-12: `slot` 을 생략하면 포커스 슬롯이다 — 단일 슬롯 모드의 호출부 여덟
  // 자리가 한 글자도 바뀌지 않아야 한다.
  _focusWindow(windowId,slot){
    if(!windowId) return;
    const si=(slot==null)?this._slotFocused():slot;
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
    if(this._windowFocused) this._resendWindowSizes(windowId,si);
    this._applyFocusOverlay();
  },

  // _focusClaim posts ownership to the server (FR-XDF-7). The server answers by
  // broadcasting the full owner map, which is what actually converges every
  // client — this POST is fire-and-forget.
  _focusClaim(windowId,clientId){
    fetch('/api/focus/claim',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({clientId:clientId||this.clientId,windowId})}).catch(()=>{});
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
  _focusRestore(){
    fetch('/api/focus').then(r=>r.ok?r.json():null).then(j=>{
      if(!j) return;
      this._windowFocusOwner=j.owners||{};
      this._applyFocusOverlay();
      // FR-WSL-12: 슬롯이 둘이면 둘 다 재주장한다 — 각 슬롯의 구독이 따로 끊기고
      // 따로 해제되므로, 하나만 되찾으면 다른 칸이 영영 dim 된 채로 남는다.
      if(this._windowFocused){
        if(this._slots) this._slotClaimAll();
        else if(this.ws.activeWindow) this._focusWindow(this.ws.activeWindow,0);
      }
    }).catch(()=>{});
  },

  // _resizeCheck returns true if this window is allowed to send resize for
  // a given pane (has OS focus + owns the pane's window or it's unowned).
  //
  // FR-WSL-14: `slot` 은 **묻는 인스턴스가 선 슬롯**이다. 같은 창이 두 슬롯에 있으면
  // toolId 가 같으므로, 슬롯을 묻지 않으면 두 인스턴스가 모두 허가를 받아 서로
  // 다른 크기를 PTY 에 보낸다 — 크기는 하나뿐이다.
  _resizeCheck(toolId,slot){
    if(!this._windowFocused) return false;
    const sid=this._toolWindowId(toolId);
    if(!sid) return true; // pane not in any window yet → allow
    const owner=this._windowFocusOwner[sid];
    if(!owner) return true;
    return owner===this._slotIdentity(slot||0);
  },

  // _applyFocusOverlay syncs the DOM: panes whose window is owned by
  // another window get the dimmed overlay (pn-dimmed class).
  //
  // FR-WSL-14: 판정이 pane 마다 갈린다 — 같은 창이 두 슬롯에 있으면 한쪽만 소유하고
  // 다른 쪽은 흐려져야 한다. 그래서 "내 것인가" 를 앱 전체가 아니라 **그 pane 이
  // 선 슬롯의 신원**으로 묻는다.
  _applyFocusOverlay(){
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
      pn.classList.toggle('pn-dimmed',dim);
    }
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

  // _resendWindowSizes sends resize for every pane in a window.
  // Sends even for hidden panes (they retain last-visible dimensions) so the
  // PTY is sized correctly BEFORE render, avoiding a one-frame glitch.
  _resendWindowSizes(windowId,slot){
    if(!windowId) return;
    const si=(slot==null)?this._slotFocused():slot;
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
      const p=this.tools.get(this._slotKey(pid,si));
      // Send resize even if pane is hidden — the dimensions were set when
      // it was last visible and are still valid. This avoids a visible
      // glitch where the PTY renders at the wrong size for one frame.
      if(!p||!p.term||!p.term.cols||!p.term.rows) continue;
      const m=new Uint8Array(5);m[0]=0x01;
      new DataView(m.buffer).setUint16(1,p.term.cols,false);
      new DataView(m.buffer).setUint16(3,p.term.rows,false);
      p._send(m);
    }
  },
});
