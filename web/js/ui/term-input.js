/**
 * 터미널 입력 — 키 배선·IME 조합·모바일 소프트 키보드·터치 스크롤
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-12-4 · FEU-25). `term-pane.js` 의 증강 분할이다 —
 * 계약은 `TerminalTool` 한 클래스에 남고 주제만 이 파일로 옮겼다 (FE_MODULE_BOUNDARY 규약).
 */
Object.assign(TerminalTool.prototype, {
  // 키 배선. Ctrl+ 조합은 브라우저 대신 터미널로, Cmd+ 조합은 브라우저에 남긴다(복사·붙여넣기·탭 닫기).
  _wireKeys(){
    this.term.attachCustomKeyEventHandler(e=>{
      // UX_BATCH6_SRS FR-IME-1: 조합이 아직 끝나지 않았으면 이 키는 xterm 이
      // 보아서는 안 된다. 가장 앞에 둔다 — 뒤의 갈래들도 조합보다 앞서면 안 된다.
      if(!this._imeGate(e)) return false;
      // UX_BATCH11_SRS FR-TCP-1·6: 선택이 있을 때의 Ctrl+C 는 복사다. 비-mac 의 Ctrl+V 는 xterm 이
      // 보지 않고 기본 동작도 막지 않는다 — 브라우저의 `paste` 가 xterm 의 붙여넣기 경로로 간다.
      const clip=this._clipKey(e);
      if(clip==='copy'){
        if(e.type==='keydown') this._copySelection();
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      if(clip==='paste') return false;
      if(e.key==='Enter'&&e.shiftKey&&!e.ctrlKey&&!e.altKey&&!e.metaKey){
        if(e.type==='keydown') this._sendKey('shiftEnter');
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      return true;
    });
    this.box.addEventListener('keydown',e=>{
      /**
       * UX_BATCH9_SRS FR-IMK-1·2: **조합이 정리되기 전에는 이 자리도 지나지 않는다.**
       *
       * 이 리스너는 xterm 의 `attachCustomKeyEventHandler` 밖이다. 게이트가 거기서
       * `false` 를 돌려줘도 `stopPropagation` 은 하지 않으므로 keydown 은 그대로
       * 여기까지 버블하고, 그때 이 자리가 커서 이동을 **즉시** 보내 왔다 —
       * 조합 문자가 그다음에 나가므로 옮겨진 자리에 글자가 찍힌다 (SRS §2.7).
       *
       * 게이트를 여기서 다시 부르지 않는다. 그것은 보류 큐에 넣는 일이고, 이미
       * 넣은 키를 한 번 더 넣으면 재생 때 두 번 움직인다 (FR-IMK-2). 상태만 묻고
       * 물러난다 — 보류분은 `_imeFlush` 가 되발행하며, 그 이벤트는 `__dmImeReplay`
       * 를 달고 오므로 이 자리를 정상적으로 지난다.
       */
      if(this._imeBusy()&&!e.__dmImeReplay) return;
      // Cmd+←/→ → 줄 처음/끝, Alt+←/→ → 단어 이동 (TERM_KEY_MAP)
      const k=this._mappedKey(e);
      if(k){e.preventDefault();this._sendKey(k);return}
      // Ctrl+ shortcuts → bypass to terminal, block browser
      if(e.ctrlKey&&!e.metaKey&&this._clipKey(e)!=='paste') e.preventDefault();
    });
  },

  /**
   * 사용자 입력의 한 자리 (FR-TCP-9 · FR-HIN-1). 선택이 있을 때의 `0x03` 은 복사가 되고, 끊긴 동안의
   * 입력은 보류된다. 보고 응답은 이 자리를 지나지 않는다 (D-14).
   */
  _userInput(s){
    if(s==='\x03'&&this.term&&this.term.hasSelection()){ this._copySelection(); return }
    this._sendText(s,true);
  },

  // FR-HIN-1: 사용자 입력 프레임. 끊긴 동안은 보내지 않고 보류함에 넣는다.
  _sendUserFrame(m){
    if(this._sock.holding()){ this._sock.hold(m); return }
    this._send(m);
  },

  /** FEU-15: 수식키 조합 하나(다른 수식키 없이)가 `TERM_KEY_MAP` 에 있으면 그 이름. */
  _mappedKey(e){
    const mod=e.metaKey&&!e.ctrlKey&&!e.altKey?'meta':e.altKey&&!e.ctrlKey&&!e.metaKey?'alt':'';
    return (mod&&TERM_KEY_MAP[mod][e.key])||null;
  },

  _sendKey(name){
    const seq=TERM_KEY_SEQ[name];
    const m=new Uint8Array(1+seq.length); m[0]=OP.INPUT; m.set(seq,1);
    this._sendUserFrame(m);
  },

  // IME 조합 배선 — 조합은 xterm 에 맡기고 확정 문자만 그 뒤로 미룬다 (FR-MTI-19·30 · FR-IME-5).
  _wireIme(ta){
    // FR-MTI-19: 물리 키보드로 들어온 키는 xterm 이 이미 전송한다. 그 키에
    // 딸린 beforeinput 까지 우리가 보내면 글자가 두 번 들어간다. 두 신호로
    // 판정한다 — 둘 중 하나만으로는 새지 않는 경로가 남는다:
    //   · keydown 이 preventDefault 됐다 → xterm 이 _keyDown 에서 전송했다
    //   · keypress 가 왔다 → xterm 이 _keyPress 에서 전송했다. Space 가 이
    //     경로이며 preventDefault 를 하지 않아 beforeinput 이 그대로 온다
    // 소프트 키보드는 keypress 를 내지 않으므로 두 경로가 정확히 갈린다.
    ta.addEventListener('keydown',e=>{this._xtHandledKey=e.defaultPrevented},false);
    ta.addEventListener('keypress',()=>{this._xtHandledKey=true},false);
    ta.addEventListener('keyup',()=>{this._xtHandledKey=false},false);
    ta.addEventListener('beforeinput',e=>this._onBeforeInput(e),true);
    // FR-MTI-30(개정): 조합 자체는 xterm 에 맡기고, 조합을 확정시키는 문자만
    // 그 뒤로 미룬다.
    //
    // 확정 문자(스페이스·마침표)는 isComposing=false 로 오지만 compositionend
    // 보다 앞선다. 즉시 보내면 조합 문자열보다 먼저 나가 순서가 뒤집힌다 —
    //     SEND " " → compositionend "여전히" → SEND "여전히"   ⇒ " 여전히"
    // 그래서 조합이 닫힐 때까지 보류한다.
    //
    // 조합의 전송·미리보기는 건드리지 않는다. CompositionHelper 를 끄면
    // .composition-view 가 죽어 조합 중인 글자가 보이지 않고(데스크톱까지),
    // 증분 계산(_dataAlreadySent)도 사라져 확정마다 누적 전체가 다시 나간다.
    ta.addEventListener('compositionstart',()=>{this._imeOpen=true},true);
    ta.addEventListener('compositionend',()=>this._imeClose(),true);
    // FR-IME-5: `compositionend` 가 오지 않는 경로(포커스 상실)에서 보류분이
    // 영영 갇히지 않게 하는 그물이다. 이미 정리됐으면 아무 일도 하지 않는다.
    ta.addEventListener('blur',()=>{if(this._imeBusy())this._imeClose()},true);
  },

  // ── 입력 (MOBILE_TUI_INPUT_SCROLL_SRS §3.1 / §3.5) ──

  /**
   * `onData` 로 오는 것은 두 종류다 — 사용자가 친 키와, 터미널이 **스스로 내는
   * 보고**(`TERM_REPORT_RE`)다. 여기서 가른다.
   *
   * 갈라야 하는 이유는 sticky 다. 그것은 대상이 아니어도 **소비된다**(그것이
   * FR-MTI-15~17 의 규약이다). 보고가 그 그물을 지나면 사용자가 눌러 둔 Ctrl 이
   * 조용히 사라진다 — 키바에서 Ctrl 을 누르고 글자를 누르는 사이에 포커스가
   * 오가거나 앱이 터미널에 질의를 내는 것은 모바일에서 흔한 일이다.
   * (Windows CI 에서 실측: 그 OS 는 포커스 보고가 늦게 도착해 매번 재현됐다.)
   *
   * 종전에는 포커스 보고(`ESC[I`·`ESC[O`) **하나만** `_applyStickyMods` 안에서
   * 특례로 빠져 있었다. 색·모드 질의의 답은 그 그물을 그대로 지났고, 앱이
   * 기동하며 내는 질의가 정확히 그것이다.
   */
  _onTermData(d){
    if(TERM_REPORT_RE.test(d)){
      // TERM_REPLY_SEAT_SRS FR-RPS-7: 질의의 **답**은 좌석의 주인만 보낸다. 같은
      // 도구에 창이 둘 붙으면 질의 하나를 두 xterm 이 다 보고 각자 답하는데,
      // 앱은 답을 하나만 먹으므로 나머지가 입력 줄에 남는다.
      //
      // 포커스 보고는 예외다 (FR-RPS-8) — 그것은 질의의 답이 아니라 **그 창
      // 고유의 사실**이다.
      if(!this._replySeat && !TERM_FOCUS_RE.test(d)) return;
      this._sendText(d);
      return;
    }
    this._userInput(this._applyStickyMods(d));
  },

  // `user` 면 사용자 입력이다 — 끊긴 동안 보류된다 (FR-HIN-1).
  _sendText(s,user){
    if(!s) return;
    const b=enc.encode(s);
    const m=new Uint8Array(1+b.length);m[0]=OP.INPUT;m.set(b,1);
    if(user) this._sendUserFrame(m);
    else this._send(m);
  },

  // FR-MTI-15~17: sticky 는 입력 길이와 무관하게 첫 코드포인트로 판정하고,
  // 대상이 아니어도 소비한다 — 잔존하면 다음 입력을 오염시킨다.
  _applyStickyMods(s){
    // 보고는 여기 오지 않는다 — `_onTermData` 가 앞에서 갈랐다.
    const A=window.app;
    if(!(A && A.isMobile && A.modKbd)) return s;
    const mk=A.modKbd;
    if(!mk.ctrl && !mk.alt) return s;
    let out=s;
    const c=out.codePointAt(0);
    if(mk.ctrl && c>=0x40 && c<=0x7e) out=String.fromCharCode(c & 0x1f)+out.slice(1);
    if(mk.alt && c>=0x20 && c<=0x7e) out='\x1b'+out;
    let changed=false;
    if(mk.ctrl===true){mk.ctrl=false;changed=true}
    if(mk.alt===true){mk.alt=false;changed=true}
    if(changed && A.mkbRefresh) A.mkbRefresh();
    return out;
  },

  _onBeforeInput(e){
    const handled=this._xtHandledKey;
    this._xtHandledKey=false;                     // 일회 소비
    const A=window.app;
    if(!A || !A.isMobile) return;                 // FR-MTI-4
    if(e.inputType!=='insertText') return;        // FR-MTI-3
    if(e.isComposing) return;                     // FR-MTI-2
    if(handled) return;                           // FR-MTI-19
    if(!e.data) return;
    e.preventDefault();
    // FR-MTI-30 / UX_BATCH6_SRS FR-IME-6: 조합이 아직 정리되지 않았으면 보류한다.
    if(this._imeBusy()){
      this._imePush({t:'text',v:e.data});
      return;
    }
    this._userInput(this._applyStickyMods(e.data));
  },

  /**
   * UX_BATCH6_SRS FR-IME-1·4: 조합이 정리되기 전에 들어온 키를 붙잡는다.
   *
   * `false` 를 돌려주면 xterm 은 이 키를 보지 않는다. 그것이 요점이다 —
   * `CompositionHelper.keydown` 은 조합 중에 다른 키를 보면 그 자리에서
   * `_finalizeComposition(false)` 로 **아직 낡은** 조합 조각을 내보내고
   * (`_compositionPosition.end` 가 `setTimeout` 으로 갱신되므로 한 글자 뒤진다),
   * 이어서 그 키의 데이터를 보낸다. 그래서 "마지막 글자 전에 엔터" 가 된다
   * (SRS §2.2).
   *
   * 제외 목록은 `CompositionHelper.keydown` 이 쓰는 것과 **같은 것**이다 —
   * IME 가 나르는 229 와 수식키 셋. 다른 목록을 두면 어느 한쪽만 고쳐질 때
   * 조합 자체가 깨진다.
   *
   * 보류하는 형태가 둘인 이유는 xterm 의 전송 경로가 둘이기 때문이다 (FR-IME-2).
   * 인쇄 가능한 한 글자는 `_keyPress` 가 보내므로 키다운만 다시 발행해서는
   * 되살아나지 않는다 — 그것은 **글자로** 보류한다. 나머지(Enter·Tab·Esc·커서·
   * Ctrl 조합)는 `_keyDown` 이 표를 보고 만들며, 그 표는 xterm 의 것이므로
   * **이벤트를 다시 발행**해 그쪽이 만들게 한다.
   */
  _imeGate(e){
    if(e.type!=='keydown') return true;
    if(e.__dmImeReplay) return true;
    if(!this._imeBusy()) return true;
    const kc=e.keyCode;
    if(kc===229||kc===16||kc===17||kc===18) return true;
    const one=!!e.key&&[...e.key].length===1;
    this._imePush(one&&!e.ctrlKey&&!e.altKey&&!e.metaKey
      ?{t:'text',v:e.key}
      :{t:'key',v:this._imeKeyInit(e)});
    // 기본 동작을 막지 않으면 이 키가 textarea 를 고쳐 xterm 의 조합 계산을
    // 어긋나게 하고, `keypress`·`beforeinput` 으로 같은 글자가 한 번 더 나간다.
    e.preventDefault();
    return false;
  },

  // 다시 발행할 때 `evaluateKeyboardEvent` 가 읽는 값 전부다. 하나라도 빠지면
  // 그 키의 해석이 원본과 달라진다.
  _imeKeyInit(e){
    return {key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,
      location:e.location,repeat:e.repeat,
      ctrlKey:e.ctrlKey,altKey:e.altKey,shiftKey:e.shiftKey,metaKey:e.metaKey,
      bubbles:true,cancelable:true};
  },

  // 조합이 열려 있거나, 닫혔지만 xterm 의 전송이 아직 나가지 않았다.
  _imeBusy(){ return !!(this._imeOpen||this._imeSettling) },

  _imePush(item){ (this._imeQ||(this._imeQ=[])).push(item) },

  /**
   * FR-MTI-30 / UX_BATCH6_SRS FR-IME-3: 조합이 닫혔다. 보류분은 **xterm 이 조합
   * 문자열을 보낸 뒤**에 나간다.
   *
   *   이전 동작: `compositionend` 를 보면 곧바로 `_imeOpen` 을 내렸다
   *   새  동작: 내리되 **정리 중**(`_imeSettling`)으로 들어가고, 두 tick 뒤에
   *             보류분을 흘려 보내며 그 창을 닫는다
   *   이유:     xterm 은 자기 `compositionend`(bubble) 안에서 `setTimeout(0)` 으로
   *             조합을 보낸다. 우리 캡처 핸들러가 먼저 도므로, 그 사이에 도착한
   *             확정 문자를 즉시 보내면 조합보다 앞선다 — 접수한 모바일 증상이
   *             그것이다(" 여전히"). 종전 가드는 `compositionend` **앞에** 온
   *             문자만 잡았고, 뒤에 온 문자는 그대로 새 나갔다 (SRS §2.2)
   */
  _imeClose(){
    this._imeOpen=false;
    this._imeSettling=true;
    // 중첩이 계약이다 — xterm 이 자기 `compositionend`(bubble) 안에서 거는
    // `setTimeout(0)` **뒤에** 서야 한다. `defer` 는 큐잉도 병합도 하지 않고
    // 원시 호출을 그대로 쓴다 (FR-SCH-13).
    TIMERS.defer(()=>TIMERS.defer(()=>this._imeFlush(),{owner:this}),{owner:this,label:'ime-flush'});
  },

  _imeFlush(){
    // 다음 조합이 이미 열렸으면 아직 흘릴 때가 아니다 — 그 조합이 닫힐 때 다시
    // 이 자리로 온다. 순서는 도착 순 그대로 유지된다.
    if(this._imeOpen) return;
    this._imeSettling=false;
    const q=this._imeQ; this._imeQ=null;
    if(!q||!q.length) return;
    const ta=this.box&&this.box.querySelector('.xterm-helper-textarea');
    for(const it of q){
      if(it.t==='text'){ this._userInput(this._applyStickyMods(it.v)); continue }
      if(!ta) continue;
      const ev=new KeyboardEvent('keydown',it.v);
      // 게이트가 다시 잡지 않게 표식을 단다 — 이 시점에는 조합이 닫혀 있지만,
      // 다음 조합이 열린 뒤에 흘려 보내는 경우가 남는다.
      ev.__dmImeReplay=true;
      ta.dispatchEvent(ev);
    }
  },

  // FR-MTI-22/26: 소프트 키보드를 내린다. 모바일에서만 의미가 있다.
  _blurInput(){
    const ta=this.el.querySelector('.xterm-helper-textarea');
    if(ta && document.activeElement===ta){try{ta.blur()}catch{}}
  },

  /**
   * ALERT_MOBILE_CONTEXT_SRS FR-MKB-2·3 / D-10 — **`inputmode` 의 주인은 여기다.**
   *
   * 접수한 말은 "`⌨` 눌렀을때만 키보드가 올라오게" 다. 지금은 터미널을 터치하면
   * xterm 이 `.xterm-helper-textarea` 에 포커스를 주고 소프트 키보드가 따라
   * 올라온다 — 화면의 절반이 사라지고, 그것을 내리려면 `⌨` 를 눌러야 한다.
   *
   * **포커스를 막지 않는다.** 막으면 물리 키보드·선택·붙여넣기·키바 전송이 함께
   * 죽는다. 막는 것은 소프트 키보드뿐이며 그 손잡이가 `inputmode='none'` 이다.
   *
   * 키바가 이 메서드를 부르고 속성을 직접 쓰지 않는다 (D-10) — 두 곳이 쓰면
   * "올라와 있는데 none" 같은 상태가 생기고, 그때 어느 쪽이 맞는지 알 수 없다.
   */
  _kbTextarea(){ return this.el.querySelector('.xterm-helper-textarea') },

  // FR-MKB-13: 데스크톱은 영향을 받지 않는다. 모바일이 아니게 되면 속성을 걷는다 —
  // 남겨 두면 브라우저 폭을 넓힌 뒤 물리 키보드 사용자가 IME 를 잃는다.
  _kbApply(){
    const ta=this._kbTextarea();
    if(!ta) return;
    if(!document.body.classList.contains('mobile')){ta.removeAttribute('inputmode');return}
    ta.setAttribute('inputmode','none');
  },

  _kbSuppressed(){
    const ta=this._kbTextarea();
    return !!ta && ta.getAttribute('inputmode')==='none';
  },

  // FR-MKB-4: `⌨` 가 푸는 유일한 자리. 속성을 걷고 **포커스를 다시 준다** —
  // 이미 포커스가 있으면 브라우저가 키보드를 올리지 않으므로 한 번 놓았다 잡는다.
  _kbAllow(){
    const ta=this._kbTextarea();
    if(!ta) return;
    ta.removeAttribute('inputmode');
    try{ta.blur()}catch{}
    this.focus();
    try{ta.focus()}catch{}
  },

  // FR-MKB-5: 같은 버튼의 반대 방향. 속성을 되걸고 내린다.
  _kbSuppress(){
    const ta=this._kbTextarea();
    if(!ta) return;
    if(document.body.classList.contains('mobile')) ta.setAttribute('inputmode','none');
    this._blurInput();
  },
});
