/**
 * Remote Terminal — 창 소유권 (UX_BATCH10_SRS 묶음 F · CROSS_DEVICE_FOCUS)
 *
 * 한 창을 여러 화면이 함께 본다. 누가 그것을 쥐고 있는지는 **서버가 가진 맵
 * 하나**이고, 화면은 그 맵을 받아 자기 dim 을 칠한다.
 *
 *   나가는 길   `_focusClaim` — 주장을 POST 한다 (fire-and-forget)
 *   들어오는 길 `_onWindowFocus` — `window_focus` SSE 가 **전체 맵**을 싣는다
 *
 * `app-focus.js` 에서 갈라져 나왔다 (FR-STR-40). 그 파일의 머리 주석이 이미
 * *"Ownership transport lives in `_focusClaim` (out) and the `window_focus` SSE
 * branch (in)"* 로 이 경계를 적고 있었다 — 가른 것이 아니라 **적혀 있던 선을
 * 그은 것**이다.
 *
 * 로드 순서 계약: `app.js` 뒤, `app-focus.js` 뒤.
 */

/** 소유권 맵 둘이 같은가 (FR-UXB-27b). 값이 문자열이라 얕은 비교로 충분하다. */
function ownersEq(a,b){
  const x=a||{},y=b||{},k=Object.keys(x);
  if(k.length!==Object.keys(y).length) return false;
  return k.every(n=>x[n]===y[n]);
}

Object.assign(App.prototype, {

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
    // size by the time the user sees the panes.
    // FR-OHB-12: 자격은 `resendWindowSizes` 가 스스로 묻는다 — 여기서 한 번 더
    // 물으면 판정이 두 벌이 되고, 돌려받은(포커스 없는) 주인이 그 사본에 걸린다.
    this.resendWindowSizes(windowId,si);
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
  /**
   * FR-UXB-27b (D-UXB-10): **판정은 소유권 맵으로 한다.**
   *
   *   이전 동작: `applyFocusOverlay()` 의 *"dim 이 풀렸나"* 로 갈랐다 — 그 값은
   *             **DOM 의 `pn-dimmed`** 를 훑어 얻은 것이라, 클래스가 기대대로
   *             붙어 있지 않으면 되찾고도 거짓이 되어 조용히 넘어갔다 (실배포)
   *   새  동작: 맵이 바뀌었으면 돈다. dim 이 걸렸는지는 묻지 않는다
   *   이유:     화면에 보이는 사실을 DOM 에 되물어 확인하면 그 되물음이 틀릴 때
   *             아무 일도 일어나지 않는다
   *
   * 같은 맵의 재전송에는 돌지 않는다 — 서버는 어느 화면의 이동에도 전체 맵을
   * 뿌리므로, 내 쪽이 달라진 것이 없으면 되살릴 이유도 없다.
   */
  _onWindowFocus(a){
    const next=(a&&a.owners)||{};
    const same=ownersEq(this._windowFocusOwner,next);
    this._windowFocusOwner=next;
    this.applyFocusOverlay();   // FR-UXB-25: dim 은 판정과 무관하게 늘 따라간다
    // FR-UXB-27a: 그리기와 되살림이 함께다 — 여긴 `focus` 도 `visibilitychange`
    // 도 오지 않으므로 다른 계기가 이 둘을 대신해 주지 않는다.
    if(!same) this._onLifeResume();
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
    // 아직 어느 창에도 없는 pane 은 주인을 물을 대상이 없다 — `_mayDriveSize`
    // 의 "주인 없음" 갈래가 그것을 종전과 같이 다룬다.
    return this._mayDriveSize(this._toolWindowId(toolId),slot);
  },

  /**
   * OWNER_HANDBACK_SRS FR-OHB-9·12: **크기를 정할 자격을 답하는 한 자리.**
   *
   *   이전 동작: `if(!this.windowFocused) return false` 가 맨 앞이었다 — 주인이
   *             누구냐를 **묻기도 전에** 죽었다
   *   새  동작: 주인을 먼저 묻는다. 내가 주인이면 OS 포커스가 없어도 참이고,
   *             남이 주인이면 거짓이며, **주인이 없을 때만** 포커스를 묻는다
   *   이유:     한 판정이 두 물음을 겸하고 있었다. 그래서 내가 주인인데도 크기를
   *             못 보내고, 주인이 아무도 없는데도 떠난 화면이 남긴 PTY 폭을
   *             계속 따랐다 (SRS §2.2 실측 — `owner:(none) rc:false cols:201`)
   *
   * OS 포커스 조건을 **없애는 것이 아니라 자리를 옮기는 것**이다 (D-OHB-2).
   * `FR-XDF-13` 이 막으려던 것은 *배경 기기가 활성 기기에게서 뺏기* 이고, 그것은
   * 그대로 막힌다 — 활성 주인이 있는 동안에는 애초에 주인이 되지 못하므로.
   *
   * `resizeCheck`(pane 별)과 `resendWindowSizes`(창 전체)가 이 하나를 딛는다
   * (FR-OHB-12). 자리가 둘이면 한쪽만 고쳐진다.
   */
  _mayDriveSize(windowId,slot){
    const owner=windowId?this._windowFocusOwner[windowId]:'';
    if(owner) return owner===this._slotIdentity(slot||0);
    return !!this.windowFocused;
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
    // FR-OHB-12: 자격의 판정은 `resizeCheck` 와 **같은 자리**다. 종전에는 여기가
    // "남이 쥐지 않았으면 보낸다" 만 물었고, 그래서 주인도 포커스도 없는 배경
    // 화면이 PTY 를 흔들 수 있었다.
    if(!this._mayDriveSize(windowId,si)) return;
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
