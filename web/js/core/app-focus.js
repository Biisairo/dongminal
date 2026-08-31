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
    if(target) target.focusedPane = rid;
    if(!sess || (target && target.id === this.ws.activeWindow)){
      this.focused = rid;
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
  _focusWindow(windowId){
    if(!windowId) return;
    let changed=false;
    // Release other windows this client owns (one client → one window).
    for(const sid of Object.keys(this._windowFocusOwner)){
      if(sid!==windowId&&this._windowFocusOwner[sid]===this.clientId){
        delete this._windowFocusOwner[sid];
        changed=true;
      }
    }
    if(this._windowFocusOwner[windowId]!==this.clientId){
      this._windowFocusOwner[windowId]=this.clientId;
      changed=true;
    }
    // Only post if ownership actually changes — otherwise every click on an
    // already-owned window would hit the server.
    if(changed) this._focusClaim(windowId);
    // Send resize immediately (before render) so PTY matches this window's
    // size by the time the user sees the panes. Only if OS-focused.
    if(this._windowFocused) this._resendWindowSizes(windowId);
    this._applyFocusOverlay();
  },

  // _focusClaim posts ownership to the server (FR-XDF-7). The server answers by
  // broadcasting the full owner map, which is what actually converges every
  // client — this POST is fire-and-forget.
  _focusClaim(windowId){
    fetch('/api/focus/claim',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({clientId:this.clientId,windowId})}).catch(()=>{});
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
      if(this._windowFocused&&this.ws.activeWindow) this._focusWindow(this.ws.activeWindow);
    }).catch(()=>{});
  },

  // _resizeCheck returns true if this window is allowed to send resize for
  // a given pane (has OS focus + owns the pane's window or it's unowned).
  _resizeCheck(toolId){
    if(!this._windowFocused) return false;
    const sid=this._toolWindowId(toolId);
    if(!sid) return true; // pane not in any window yet → allow
    const owner=this._windowFocusOwner[sid];
    return !owner||owner===this.clientId;
  },

  // _applyFocusOverlay syncs the DOM: panes whose window is owned by
  // another window get the dimmed overlay (pn-dimmed class).
  _applyFocusOverlay(){
    const otherOwned=new Set();
    for(const[sid,owner] of Object.entries(this._windowFocusOwner)){
      if(owner&&owner!==this.clientId) otherOwned.add(sid);
    }
    for(const pn of document.querySelectorAll('.pn')){
      let dim=false;
      for(const t of pn.querySelectorAll('.pn-tab[data-toolid]')){
        const sid=this._toolWindowId(t.dataset.toolid);
        if(sid&&otherOwned.has(sid)){dim=true;break}
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
  _resendWindowSizes(windowId){
    if(!windowId) return;
    // Don't send resize if another window owns this window.
    const owner=this._windowFocusOwner[windowId];
    if(owner&&owner!==this.clientId) return;
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
      const p=this.tools.get(pid);
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
