/**
 * Remote Terminal — xterm + WebSocket pane
 */

class TerminalTool {
  constructor(id, name) {
    this.id=id; this.name=name;
    // WINDOW_SLOTS_SRS FR-WSL-14: 같은 도구가 두 슬롯에 서면 toolId 가 같다.
    // 크기 권한을 물을 때 **어느 칸의 인스턴스인지**를 함께 밝혀야 한다.
    this._slot=0;
    this.ws=null; this.term=null; this.fit=null; this._opened=false; this._buf=[]; this._reconnecting=false; this._destroyed=false; this._retryDelay=0;
    // FR-RCS-1: 도구가 사라졌다는 서버의 통보(OP.EXIT)를 받았는가. 서면 재연결을
    // 영구히 멈춘다. FR-RCS-3 의 healthy 타이머는 "이 연결이 유효했는가"의 근거다.
    this._exited=false; this._healthyTimer=null;
    this._sendQueue=[]; this._sendQueueMax=64; this._sendDropCount=0;
    this._decoder=new TextDecoder('utf-8',{fatal:false}); this._outputBuf=''; this._flushScheduled=false; this._carryTimer=null;
    // TERMINAL_RESUME_SRS FR-TRS-7: `_seq` 는 **마지막으로 본 바이트 오프셋**이고
    // 다음 접속의 `since` 다. -1 은 "모른다" — 그때는 서버가 전량을 뿌린다.
    //
    // `_seqLive` 가 따로 있는 이유: 재생분(스냅샷·델타)은 좌표 통보 **앞에** 오므로
    // 세면 안 된다 (FR-TRS-8). 통보를 받은 뒤의 OpOutput 만이 라이브 PTY 바이트다.
    this._seq=-1; this._seqLive=false;
    this.el=document.createElement('div');
    this.el.className='tp'; this.el.dataset.toolid=id;
    this.box=document.createElement('div');
    this.box.style.cssText='width:100%;height:100%';
    this.el.appendChild(this.box);
    // Drag & drop upload
    this.el.addEventListener('dragover',e=>{e.preventDefault();if([...e.dataTransfer.types].includes('Files')){e.stopPropagation();this.el.classList.add('dragover')}});
    this.el.addEventListener('dragleave',()=>this.el.classList.remove('dragover'));
    this.el.addEventListener('drop',e=>{if(!e.dataTransfer.files||!e.dataTransfer.files.length)return;e.preventDefault();e.stopPropagation();this.el.classList.remove('dragover');this._uploadFiles(e.dataTransfer.files)});
  }
  open() {
    if(this._opened) return; this._opened=true;
    this.term=new Terminal(TOPTS);
    this.fit=new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    try{this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e,uri)=>{
      window.open(uri,'_blank');
    }))}catch(e){}
    try{this.term.loadAddon(new Unicode11Addon.Unicode11Addon());this.term.unicode.activeVersion='11'}catch(e){}
    try{this.search=new SearchAddon.SearchAddon();this.term.loadAddon(this.search)}catch(e){}
    // FR-ETR-37: OSC 52(클립보드 쓰기). xterm 은 이것을 스스로 처리하지 않으므로
    // 붙이지 않으면 셸이 보낸 복사가 **받는 사람 없이 버려진다** — 그것이
    // "복사가 원격에서만 안 된다" 의 정체였다 (§2.5).
    try{TermClipboard.attach(this.term,this.id)}catch(e){}
    this.term.open(this.box);
    this.term.attachCustomKeyEventHandler(e=>{
      // UX_BATCH6_SRS FR-IME-1: 조합이 아직 끝나지 않았으면 이 키는 xterm 이
      // 보아서는 안 된다. 가장 앞에 둔다 — 뒤의 갈래들도 조합보다 앞서면 안 된다.
      if(!this._imeGate(e)) return false;
      if(e.key==='Enter'&&e.shiftKey&&!e.ctrlKey&&!e.altKey&&!e.metaKey){
        if(e.type==='keydown') this._send(new Uint8Array([OP.INPUT,0x1b,0x0d]));
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      return true;
    });
    // Block browser Ctrl+ shortcuts → let them go to terminal
    // Cmd+ shortcuts left for browser (copy/paste/tab close etc)
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
      // Cmd+Left/Right → Home/End
      if(e.metaKey&&!e.ctrlKey&&!e.altKey){
        if(e.key==='ArrowLeft'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x01]));return}
        if(e.key==='ArrowRight'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x05]));return}
      }
      // Alt+Left/Right → word jump
      if(e.altKey&&!e.ctrlKey&&!e.metaKey){
        if(e.key==='ArrowLeft'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x1b,0x62]));return}
        if(e.key==='ArrowRight'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x1b,0x66]));return}
      }
      // Ctrl+ shortcuts → bypass to terminal, block browser
      if(e.ctrlKey&&!e.metaKey) e.preventDefault();
    });
    this.term.onData(d=>{
      this._sendText(this._applyStickyMods(d));
    });
    this.term.onResize(({cols,rows})=>{
      // Only the OS-focused window that owns the pane's window may send resize.
      if(!window.app||!window.app._resizeCheck(this.id,this._slot)) return;
      this._sendResize(cols,rows);
    });
    // FR-MTI-1: 모바일 소프트 키보드 입력을 xterm 의 CompositionHelper 경로에서
    // 떼어낸다. 그 경로는 setTimeout(0) 뒤에 누적된 textarea 값을 diff 하므로,
    // 같은 tick 에 두 글자가 오면 중복 전송하고(a,b,c → "abc","bc","c"),
    // Enter 가 textarea 를 비우면 직전 글자를 잃는다. beforeinput 을 취소하면
    // textarea 값이 변하지 않아 그 diff 가 항상 빈 값이 된다.
    const ta=this.box.querySelector('.xterm-helper-textarea');
    // FR-MKB-1: 터치해도 소프트 키보드가 올라오지 않는다. 터미널이 서는 이 자리가
    // textarea 가 처음 존재하는 순간이다 — 늦게 걸면 첫 터치 한 번이 새어 나간다.
    this._kbApply();
    if(ta){
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
    }
    this._initTouchScroll();
    try{this.fit.fit()}catch{}
    for(const d of this._buf) try{this.term.write(d)}catch{}
    this._buf=[];
    if(this.term) this.term.scrollToBottom();
  }

  // ── 입력 (MOBILE_TUI_INPUT_SCROLL_SRS §3.1 / §3.5) ──

  _sendText(s){
    if(!s) return;
    const b=enc.encode(s);
    const m=new Uint8Array(1+b.length);m[0]=OP.INPUT;m.set(b,1);
    this._send(m);
  }

  // FR-MTI-15~17: sticky 는 입력 길이와 무관하게 첫 코드포인트로 판정하고,
  // 대상이 아니어도 소비한다 — 잔존하면 다음 입력을 오염시킨다.
  _applyStickyMods(s){
    // xterm 이 **스스로 내는 포커스 보고**(CSI `I`·`O`)는 사용자의 입력이 아니다.
    //
    // 그것도 `onData` 로 오므로 여기를 지나는데, sticky 는 대상이 아니어도
    // **소비된다**(그것이 FR-MTI-15~17 의 규약이다). 그래서 창이 포커스를 되찾는
    // 순간 사용자가 눌러 둔 Ctrl 이 조용히 사라진다 — 키바에서 Ctrl 을 누르고
    // 글자를 누르는 사이에 포커스가 오가는 것은 모바일에서 흔한 일이다.
    // (Windows CI 에서 실측: 그 OS 는 포커스 보고가 늦게 도착해 매번 재현됐다.)
    if(s==='\x1b[I'||s==='\x1b[O') return s;
    const A=window.app;
    if(!(A && A.isMobile && A._modKbd)) return s;
    const mk=A._modKbd;
    if(!mk.ctrl && !mk.alt) return s;
    let out=s;
    const c=out.codePointAt(0);
    if(mk.ctrl && c>=0x40 && c<=0x7e) out=String.fromCharCode(c & 0x1f)+out.slice(1);
    if(mk.alt && c>=0x20 && c<=0x7e) out='\x1b'+out;
    let changed=false;
    if(mk.ctrl===true){mk.ctrl=false;changed=true}
    if(mk.alt===true){mk.alt=false;changed=true}
    if(changed && A._mkbRefresh) A._mkbRefresh();
    return out;
  }

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
    this._sendText(this._applyStickyMods(e.data));
  }

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
  }

  // 다시 발행할 때 `evaluateKeyboardEvent` 가 읽는 값 전부다. 하나라도 빠지면
  // 그 키의 해석이 원본과 달라진다.
  _imeKeyInit(e){
    return {key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,
      location:e.location,repeat:e.repeat,
      ctrlKey:e.ctrlKey,altKey:e.altKey,shiftKey:e.shiftKey,metaKey:e.metaKey,
      bubbles:true,cancelable:true};
  }

  // 조합이 열려 있거나, 닫혔지만 xterm 의 전송이 아직 나가지 않았다.
  _imeBusy(){ return !!(this._imeOpen||this._imeSettling) }

  _imePush(item){ (this._imeQ||(this._imeQ=[])).push(item) }

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
  }

  _imeFlush(){
    // 다음 조합이 이미 열렸으면 아직 흘릴 때가 아니다 — 그 조합이 닫힐 때 다시
    // 이 자리로 온다. 순서는 도착 순 그대로 유지된다.
    if(this._imeOpen) return;
    this._imeSettling=false;
    const q=this._imeQ; this._imeQ=null;
    if(!q||!q.length) return;
    const ta=this.box&&this.box.querySelector('.xterm-helper-textarea');
    for(const it of q){
      if(it.t==='text'){ this._sendText(this._applyStickyMods(it.v)); continue }
      if(!ta) continue;
      const ev=new KeyboardEvent('keydown',it.v);
      // 게이트가 다시 잡지 않게 표식을 단다 — 이 시점에는 조합이 닫혀 있지만,
      // 다음 조합이 열린 뒤에 흘려 보내는 경우가 남는다.
      ev.__dmImeReplay=true;
      ta.dispatchEvent(ev);
    }
  }

  // ── 터치 스크롤 (MOBILE_TUI_INPUT_SCROLL_SRS §3.2) ──

  // FR-MTI-8: capture 단계에서 가로채 xterm 의 1:1 터치 경로와 선택 경로에
  // 도달하지 않게 한다. xterm 쪽은 감도 배율도 관성도 없다.
  _initTouchScroll(){
    const opt={capture:true,passive:false};
    this.el.addEventListener('touchstart',e=>this._tsStart(e),opt);
    this.el.addEventListener('touchmove',e=>this._tsMove(e),opt);
    this.el.addEventListener('touchend',e=>this._tsEnd(e),opt);
    this.el.addEventListener('touchcancel',e=>this._tsEnd(e),opt);
    // FR-MTI-29: Chrome 은 제스처가 끝난 뒤 합성 마우스 이벤트를 낸다. 마우스
    // 리포팅이 켜진 TUI 에는 그것이 클릭으로 전달된다 — 실기기 로그에서 스크롤
    // 제스처가 ESC[<0;32;22M/m 을 보내고 있었다. 스크롤한 것을 클릭으로 받으면
    // TUI 가 엉뚱하게 반응한다. 스크롤로 판정된 제스처의 합성분만 막는다.
    for(const t of ['mousedown','mouseup','click']){
      this.el.addEventListener(t,e=>{
        if(!this._tsSuppressUntil||Date.now()>this._tsSuppressUntil) return;
        e.preventDefault();e.stopPropagation();
      },true);
    }
  }

  _tsMobile(){return !!(window.app && window.app.isMobile)}

  _tsStart(e){
    this._flingStop();
    this._tsY0=null;
    if(!this._tsMobile()) return;
    if(!e.touches || e.touches.length!==1) return;
    this._tsY0=e.touches[0].clientY;
    this._tsY=this._tsY0;
    this._tsActive=false;this._tsResid=0;this._tsV=0;
  }

  _tsMove(e){
    if(this._tsY0===null||this._tsY0===undefined) return;
    if(!this._tsMobile()) return;
    if(!e.touches || e.touches.length!==1) return;
    const y=e.touches[0].clientY;
    if(!this._tsActive){
      // FR-MTI-9: slop 이내는 탭이다 — 그대로 통과시켜 포커스·선택을 남긴다.
      // 여기서 preventDefault 하면 Chrome 이 이 제스처의 합성 마우스 이벤트를
      // 억제해 탭 → 포커스 경로까지 죽는다 (FR-MTI-24 철회 근거).
      if(Math.abs(y-this._tsY0)<MTI_TOUCH_SLOP_PX) return;
      this._tsActive=true;
      this._tsY=y;   // slop 소진분은 버린다. 시작이 튀지 않는다
      // FR-MTI-22: Android Chrome 은 focus 된 입력 요소가 있는 동안 페이지를
      // 탭하면 키보드를 재표시한다. 스크롤하려고 만졌을 뿐인데 키보드가 올라오고,
      // 그것이 window resize → fit → 재렌더로 이어진다. 제스처가 스크롤로
      // 확정된 순간 포커스를 놓는다. 제스처가 끝나도 되돌리지 않는다 —
      // 되돌리면 키보드가 다시 올라온다.
      this._blurInput();
    }
    const dy=this._tsY-y;
    this._tsY=y;this._tsV=dy;
    e.preventDefault();e.stopPropagation();
    this._touchScrollBy(dy*MTI_TOUCH_GAIN);
  }

  _tsEnd(e){
    const wasActive=this._tsActive;
    this._tsY0=null;this._tsActive=false;
    if(!wasActive) return;
    e.preventDefault();e.stopPropagation();
    this._tsSuppressUntil=Date.now()+MTI_SYNTH_MOUSE_MS;   // FR-MTI-29
    // FR-MTI-7: 마지막 관측 속도에서 시작해 프레임마다 감쇠한다.
    let v=this._tsV*MTI_TOUCH_GAIN;
    if(Math.abs(v)>MTI_FLING_MAX_V) v=v<0?-MTI_FLING_MAX_V:MTI_FLING_MAX_V;
    if(Math.abs(v)<MTI_FLING_MIN_V) return;
    const step=()=>{
      this._flingId=null;
      this._touchScrollBy(v);
      v*=MTI_FLING_DECAY;
      if(Math.abs(v)<MTI_FLING_MIN_V) return;
      this._flingId=TIMERS.frame(step,{owner:this,label:'fling'});
    };
    this._flingId=TIMERS.frame(step,{owner:this,label:'fling'});
  }

  _flingStop(){
    if(this._flingId){TIMERS.cancel(this._flingId);this._flingId=null}
    if(this._wheelRaf){TIMERS.cancel(this._wheelRaf);this._wheelRaf=null;this._wheelPend=0}
  }

  // FR-MTI-22/26: 소프트 키보드를 내린다. 모바일에서만 의미가 있다.
  _blurInput(){
    const ta=this.el.querySelector('.xterm-helper-textarea');
    if(ta && document.activeElement===ta){try{ta.blur()}catch{}}
  }

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
  _kbTextarea(){ return this.el.querySelector('.xterm-helper-textarea') }

  // FR-MKB-13: 데스크톱은 영향을 받지 않는다. 모바일이 아니게 되면 속성을 걷는다 —
  // 남겨 두면 브라우저 폭을 넓힌 뒤 물리 키보드 사용자가 IME 를 잃는다.
  _kbApply(){
    const ta=this._kbTextarea();
    if(!ta) return;
    if(!document.body.classList.contains('mobile')){ta.removeAttribute('inputmode');return}
    ta.setAttribute('inputmode','none');
  }

  _kbSuppressed(){
    const ta=this._kbTextarea();
    return !!ta && ta.getAttribute('inputmode')==='none';
  }

  // FR-MKB-4: `⌨` 가 푸는 유일한 자리. 속성을 걷고 **포커스를 다시 준다** —
  // 이미 포커스가 있으면 브라우저가 키보드를 올리지 않으므로 한 번 놓았다 잡는다.
  _kbAllow(){
    const ta=this._kbTextarea();
    if(!ta) return;
    ta.removeAttribute('inputmode');
    try{ta.blur()}catch{}
    this.focus();
    try{ta.focus()}catch{}
  }

  // FR-MKB-5: 같은 버튼의 반대 방향. 속성을 되걸고 내린다.
  _kbSuppress(){
    const ta=this._kbTextarea();
    if(!ta) return;
    if(document.body.classList.contains('mobile')) ta.setAttribute('inputmode','none');
    this._blurInput();
  }

  // FR-MTI-28: 스크롤을 직접 처리하지 않고 xterm 의 wheel 경로로 넘긴다.
  //
  // scrollLines 로 직접 움직이던 이전 구현은 스크롤백이 있을 때만 동작했다.
  // 실기기 로그에서 이 TUI 는 마우스 리포팅을 켜고 있었고(SGR 리포트가 실제로
  // 전송됐다), 그런 TUI 는 스크롤을 스크롤백이 아니라 자기가 처리한다 — 화면을
  // 재렌더하므로 스크롤백은 rows 만큼밖에 없다(실측 len==rows, 제스처 내내 vY=0).
  //
  // 합성 wheel 을 넘기면 xterm 이 상태에 맞게 갈라준다:
  //   · 마우스 리포팅 ON  → 프로토콜(SGR/일반)에 맞는 휠 리포트 전송 → TUI 가 스크롤
  //   · OFF, 스크롤백 있음 → viewport 스크롤
  //   · OFF, alt screen    → 위/아래 방향키로 변환
  // 픽셀→행 누적도 xterm 의 getLinesScrolled 가 이미 한다(_wheelPartialScroll).
  // FR-MTI-32: 터치는 한 프레임에 여러 번 발화한다. 그때마다 wheel 을 보내면
  // 마우스 리포팅이 켜진 TUI 가 리포트 폭주를 받아 프레임을 따라 그리다 밀린다
  // — 실기기에서 "버벅인다" 로 나타난다. 프레임당 한 번, 누적 delta 로 보낸다.
  _touchScrollBy(px){
    if(!px) return;
    this._wheelPend=(this._wheelPend||0)+px;
    this._wheelRaf=TIMERS.frame(()=>{
      this._wheelRaf=null;
      const d=this._wheelPend; this._wheelPend=0;
      if(d) this._dispatchWheel(d);
    },{owner:this,coalesce:'wheel'});
  }

  _dispatchWheel(px){
    const el=this.term&&this.term.element;
    if(!el) return;
    const r=el.getBoundingClientRect();
    try{
      el.dispatchEvent(new WheelEvent('wheel',{
        deltaY:px, deltaX:0, deltaMode:0,
        clientX:r.left+r.width/2, clientY:r.top+r.height/2,
        bubbles:true, cancelable:true,
      }));
    }catch{}
  }
  _wsURL(){
    const p=location.protocol==='https:'?'wss:':'ws:';
    const cols=(this.term&&this.term.cols)||120;
    const rows=(this.term&&this.term.rows)||40;
    // FR-TRS-3: 좌표를 알면 **이어 붙여** 달라고 한다. 모르면 붙이지 않는다 —
    // 서버는 그것을 전량 재생으로 읽는다.
    const since=this._seq>=0?`&since=${this._seq}`:'';
    return `${p}//${location.host}/ws?cols=${cols}&rows=${rows}&tool=${encodeURIComponent(this.id)}${since}`;
  }
  // FR-RCS-1: 최초 연결과 재연결이 **같은 판정**을 하도록 수신 처리를 한 곳에
  // 둔다. 두 벌로 두었던 것이 OP.EXIT 처리가 한쪽에만 들어가는 사고의 자리였다.
  _onOp(d){
    if(d[0]===OP.OUTPUT){ this._handleOutput(d.subarray(1)); }
    else if(d[0]===OP.SEQ){ this._onSeq(d.subarray(1)); }
    else if(d[0]===OP.TOOLID){ this.id=dec.decode(d.subarray(1)); this.el.dataset.toolid=this.id; }
    else if(d[0]===OP.EXIT){ this._markExited(); }
    else if(d[0]===OP.ERROR){ this.write('\r\n\x1b[31m'+dec.decode(d.subarray(1))+'\x1b[0m\r\n'); }
  }
  // FR-RCS-1·2: 서버가 도구의 부재를 알렸다. 이 패널은 다시 연결하지 않으며,
  // 사실을 오버레이로 남긴다 — 본문 한 줄은 스크롤 밖으로 밀려 사라진다.
  _markExited(){
    if(this._exited) return;
    this._exited=true;
    this._clearHealthy();
    this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n');
    this.el.style.opacity='1'; this._reconnecting=false;
    this._showOverlay('도구 종료됨','이 탭을 닫아 주세요');
  }
  // FR-RCS-3: 연결이 WS_HEALTHY_MS 이상 유지되어야 백오프를 되돌린다.
  _markHealthy(){
    this._clearHealthy();
    this._healthyTimer=TIMERS.after(WS_HEALTHY_MS,()=>{this._healthyTimer=null;this._retryDelay=0},{owner:this,label:'ws-healthy'});
  }
  _clearHealthy(){
    if(this._healthyTimer){TIMERS.cancel(this._healthyTimer);this._healthyTimer=null}
  }
  _sendResize(cols,rows){
    const m=new Uint8Array(5);m[0]=OP.RESIZE;
    const dv=new DataView(m.buffer);
    dv.setUint16(1,cols,false);
    dv.setUint16(3,rows,false);
    this._send(m);
  }
  _onWsOpen(){
    this._markHealthy();
    // FR-TRS-7: 새 소켓이다. 좌표 통보를 받기 전까지는 세지 않는다 — 그 전에 오는
    // OpOutput 은 재생분이고, 그것을 더하면 좌표가 재생 길이만큼 앞질러 간다.
    this._seqLive=false;
    if(this.term && window.app && window.app._resizeCheck(this.id)){
      this._sendResize(this.term.cols,this.term.rows);
    }
    this._flushSendQueue();
  }

  /**
   * FR-TRS-6·7·18: 서버가 통보한 좌표를 세우고, 전량 재생이었으면 넛지를 건다.
   *
   * 오프셋은 8 바이트 빅엔디언이다. `getBigUint64` 를 쓰지 않는 이유는 BigInt 를
   * 끌어들이지 않기 위해서다 — 32 비트 둘로 읽으면 2^53 까지 정확하고, PTY 가
   * 그만큼을 내려면 페타바이트가 필요하다.
   */
  _onSeq(p){
    if(!p||p.length<9) return;
    const dv=new DataView(p.buffer,p.byteOffset,p.length);
    this._seq=dv.getUint32(0,false)*4294967296+dv.getUint32(4,false);
    this._seqLive=true;
    if(p[8]===1) this._redrawNudge();
  }

  /**
   * FR-TRS-18~21: **전량 재생 뒤에만** TUI 에 전체 재그리기를 시킨다.
   *
   * 전량 재생은 바이트 tail 을 되뿌린 것이고, tail 밖에서 켜진 모드(대체 화면
   * 따위)는 되살아나지 않는다 (SRS §2.4). claude 같은 TUI 는 델타만 보내므로
   * 어긋난 화면이 스스로 낫지 않는다 — 한 행 줄였다 되돌려 `SIGWINCH` 를 일으키면
   * 그쪽이 전체를 다시 그린다.
   *
   * 델타 재개에는 걸지 않는다. 화면이 이미 맞아 있고 리플로우만 만든다.
   */
  _redrawNudge(){
    if(!this.term) return;
    const cols=this.term.cols, rows=this.term.rows;
    if(!(rows>1)) return;
    // FR-TRS-19: 크기의 주인이 아닌 창이 PTY 를 흔들면 주인 창의 화면이 깨진다.
    if(!window.app||!window.app._resizeCheck(this.id,this._slot)) return;
    this._sendResize(cols,rows-1);
    TIMERS.defer(()=>{if(this.term)this._sendResize(cols,rows)},{owner:this,label:'trs-nudge'});
  }
  connect() {
    // 명시적인 connect 는 새 시도다 — 이전의 종료 판정을 지운다.
    this._exited=false;
    this.ws=new WebSocket(this._wsURL()); this.ws.binaryType='arraybuffer';
    this.ws.onopen=()=>{
      this._onWsOpen();
      if(this._reconnecting){
        // `_hideOverlay()` 가 여기 **있어야 한다.** 이 경로는 최초 연결 전용이라
        // 지울 오버레이가 없었고, 그래서 빠져 있었다. `reconnectNow()` 가
        // 오버레이를 띄운 채 이 함수를 부르게 되면서 그것이 결함이 됐다 —
        // 연결은 붙는데 "다시 연결" 화면이 영영 남는다 (실측).
        TIMERS.after(300,()=>{this._hideOverlay();this.el.style.opacity='1';this._reconnecting=false;if(this.term)this.term.scrollToBottom()},{owner:this,label:'overlay-hide'});
      }
    };
    this.ws.onmessage=e=>{
      const d=new Uint8Array(e.data); if(d.length) this._onOp(d);
    };
    this.ws.onclose=()=>{
      if(this._destroyed||this._exited) return;
      this._showOverlay('연결 끊김', '재연결 중...');
      this._scheduleReconnect();
    };
    this.ws.onerror=()=>{
      if(this._destroyed||this._exited) return;
      this._showOverlay('연결 오류', '재연결 중...');
      this._scheduleReconnect();
    };
  }
  /**
   * SOFT_RELOAD_SRS FR-SRL-5·6·7: 내부 새로고침이 부르는 재연결.
   *
   * **pane 을 다시 만들지 않는다** — 소켓만 다시 연다. xterm 인스턴스가 새로
   * 서면 페이지 새로고침과 다를 것이 없어진다 (D-3).
   *
   * `_exited` 는 되살리지 않는다 (FR-SRL-7). 그 판정은 서버의 통보로 선 것이며
   * (FR-RCS-1), 뒤집으면 RECONNECT_STORM 이 고친 폭주가 되살아난다.
   *
   * 붙었는지가 아니라 **시도했는지**를 답한다 — 부르는 쪽은 센 수를 보일 뿐이다.
   */
  reconnectNow(){
    if(this._destroyed||this._exited) return false;
    this._clearHealthy();
    this._reconnectPending=false;
    // 옛 소켓의 콜백을 먼저 끊는다 — 살려 두면 close 가 `_scheduleReconnect` 를
    // 불러 재연결이 두 벌로 돈다.
    for(const k of ['ws','_pendingWs']){
      const s=this[k];
      if(!s) continue;
      try{s.onclose=null;s.onerror=null;s.onmessage=null;s.onopen=null;s.close()}catch{}
      this[k]=null;
    }
    // 사용자가 부른 재연결이므로 즉시 시도한다 — 백오프는 실패가 이어질 때의 것이다.
    this._retryDelay=0;
    this._resetDecoderIfNoResume();
    this._reconnecting=true;
    this._showOverlay('다시 연결', '내부 새로고침...');
    this.connect();
    return true;
  }

  _scheduleReconnect(){
    // FR-RCS-1: 도구가 사라졌다는 통보를 받았으면 다시 붙지 않는다. 이 한 줄이
    // 없으면 없는 도구를 향해 지연 0 으로 무한히 재접속한다 (§2.1).
    if(this._destroyed||this._exited||this._reconnectPending) return;
    this._reconnectPending=true;
    this._clearHealthy();
    if(this.ws){try{this.ws.onclose=null;this.ws.onerror=null;this.ws.onmessage=null;this.ws.close()}catch{}this.ws=null}
    this._resetDecoderIfNoResume();
    this._reconnect();
  }
  /**
   * 끊긴 연결의 반쪽 멀티바이트가 새 연결의 바이트와 이어 붙는 것을 막는다.
   *
   * **재개할 좌표가 있으면 지우지 않는다** (FR-TRS-4). 그때 새 연결이 보내는
   * 것은 끊긴 자리 바로 다음 바이트이므로, 이어 붙는 것이 오히려 정확하다 —
   * 지우면 걸쳐 있던 글자 하나를 잃는다. 좌표가 없으면 전량 재생이 오고, 그것은
   * 다른 지점에서 시작하는 별개의 바이트열이므로 지운다.
   */
  _resetDecoderIfNoResume(){
    if(this._seq>=0) return;
    try{this._decoder=new TextDecoder('utf-8',{fatal:false});this._outputBuf=''}catch{}
  }
  write(s){if(this.term)try{this.term.write(s)}catch{}else this._buf.push(s)}
  doFit(){if(this.fit)try{this.fit.fit()}catch{}}
  focus(){if(this.term)try{this.term.focus()}catch{}}
  _reconnect(){
    if(this._destroyed||this._exited) return;
    // Instant first attempt, then fast backoff: 200, 500, 1s, 1.2x up to 10s.
    // FR-RCS-4: 이 값은 _markHealthy 의 타이머가 깨어날 때만 0 으로 돌아간다.
    let delay=this._retryDelay;
    if(this._retryDelay===0){ delay=0; this._retryDelay=200 }
    else if(this._retryDelay<=500){ this._retryDelay=Math.min(this._retryDelay*2.5,1000) }
    else{ this._retryDelay=Math.min(this._retryDelay*1.2,10000) }
    TIMERS.after(delay,()=>{
      // FR-RCS-5: 대기 중에 판정이 섰을 수 있다. 깨어난 뒤에 다시 본다.
      if(this._destroyed||this._exited) return;
      const ws=new WebSocket(this._wsURL()); ws.binaryType='arraybuffer';
      this._pendingWs=ws;
      this._reconnectPending=false;
      ws.onopen=()=>{
        this.ws=ws;
        this._pendingWs=null;
        this._onWsOpen();
        TIMERS.after(300,()=>{this._hideOverlay();this.el.style.opacity='1';this._reconnecting=false;if(this.term)this.term.scrollToBottom()},{owner:this,label:'overlay-hide'});
      };
      ws.onmessage=e=>{
        const d=new Uint8Array(e.data); if(d.length) this._onOp(d);
      };
      ws.onclose=()=>{
        if(this._destroyed||this._exited)return;
        if(this.ws&&this.ws!==ws) return;
        if(this.ws===ws) this.ws=null;
        this._showOverlay('연결 끊김','재연결 중...');
        this._scheduleReconnect();
      };
      ws.onerror=()=>{
        if(this._destroyed||this._exited)return;
        if(this.ws&&this.ws!==ws) return;
        this._showOverlay('연결 오류','재연결 중...');
        this._scheduleReconnect();
      };
    },{owner:this,label:'ws-retry'});
  }
  // 오버레이는 **DOM 으로 세운다** — `_confirmClose` 를 `GitConfirm` 규약으로
  // 옮긴 것과 같은 근거다 (M2 `UX-1`). `textContent` 는 이스케이프를 부를 필요가
  // 없고, 부를 함수가 이 파일의 스코프에 있는지도 묻지 않는다.
  //
  // 종전에는 `innerHTML` 에 `escHtml(...)` 을 끼워 넣었는데, `escHtml` 은
  // `helpers.js` 의 전역이라 그 파일을 싣지 않는 자리에서는 없다 — 패널이 종료될
  // 때마다 `ReferenceError` 로 터졌다 (`reconnect-storm.spec.ts` 가 그 자리다).
  _showOverlay(title,sub){
    let ov=this.el.querySelector('.tp-overlay');
    if(!ov){ov=document.createElement('div');ov.className='tp-overlay';this.el.appendChild(ov)}
    const t=document.createElement('div');t.className='tp-ov-title';t.textContent=title;
    const b=document.createElement('div');b.className='tp-ov-sub';b.textContent=sub;
    ov.replaceChildren(t,b);
    ov.classList.add('visible');
  }
  _hideOverlay(){
    const ov=this.el.querySelector('.tp-overlay');
    if(ov)ov.classList.remove('visible');
  }
  _handleOutput(data){
    // FR-TRS-7: 좌표 통보 뒤의 것만 센다. 길이는 **디코딩 전 바이트**다 —
    // 서버의 오프셋이 PTY 가 낸 raw 바이트의 수이기 때문이다.
    if(this._seqLive) this._seq+=data.length;
    // stream:true preserves UTF-8 multibyte state across WS chunk boundaries
    this._outputBuf+=this._decoder.decode(data,{stream:true});
    if(this._flushScheduled) return;
    this._flushScheduled=true;
    // 프레임이 아니라 매크로태스크다 — 숨은 탭에서도 출력이 흘러야 한다.
    // `frame` 은 탭이 백그라운드면 멎는다.
    TIMERS.defer(()=>this._doFlush(),{owner:this,label:'term-flush'});
  }

  /**
   * FR-FTR-8: 버퍼 끝에 **완성되지 않은 OSC 시퀀스**가 있으면 그 시작 자리를
   * 돌려준다. 없으면 -1 이다.
   *
   * 이것이 없으면 `\x1b]777;Download;/pa` 와 `th\x07` 로 갈린 청크에서 명령이
   * 통째로 사라진다 — 버퍼는 flush 마다 비고 정규식은 다음 회차에 앞부분을
   * 보지 못한다. `Cwd` 도 같은 경로를 타므로 cwd 표시와 git 신호까지 함께 잃는다.
   *
   * 종결자는 BEL 과 ST(`ESC \`) 둘 다 본다. `ESC` 하나만 걸친 경우도 보류한다 —
   * 다음 청크에 `]` 가 온다.
   */
  _oscCarryAt(text){
    const i=text.lastIndexOf('\x1b]');
    if(i>=0&&text.indexOf('\x07',i)<0&&text.indexOf('\x1b\\',i+2)<0){
      // 종결자 없는 입력에 화면이 영영 멈추지 않게 한다 — 상한을 넘으면 OSC 가
      // 아니라고 보고 그대로 흘려보낸다.
      return (text.length-i>OSC_CARRY_MAX)?-1:i;
    }
    if(text.endsWith('\x1b')) return text.length-1;
    return -1;
  }

  _doFlush(){
    this._flushScheduled=false;
    if(this._carryTimer){TIMERS.cancel(this._carryTimer);this._carryTimer=null}
    let text=this._outputBuf; this._outputBuf='';
    const cut=this._oscCarryAt(text);
    if(cut>=0){
      this._outputBuf=text.slice(cut); text=text.slice(0,cut);
      // 다음 청크가 언제 올지는 모른다 — 사용자가 키를 누를 때까지 안 올 수도
      // 있다. 보류한 것이 프롬프트의 일부이면 화면이 멈춘 것으로 보이므로,
      // 짧은 시간 뒤에는 그냥 내보낸다.
      this._carryTimer=TIMERS.after(OSC_CARRY_MS,()=>{this._carryTimer=null;this._doFlush()},{owner:this,label:'osc-carry'});
    }
    if(!text) return;
    const re=/\x1b\]777;(\w+);([^\x07]*)\x07/g;
    let m;
    while((m=re.exec(text))!==null){
      const cmd=m[1],val=m[2];
      if(cmd==='Download') this._downloadFile(val);
      else if(cmd==='Cwd') this._onCwd(val);
    }
    const clean=text.replace(/\x1b\]777;\w+;[^\x07]*\x07/g,'');
    if(this.term) try{this.term.write(clean||'')}catch{}
    else if(clean) this._buf.push(enc.encode(clean));
  }
  _onCwd(cwd){
    this._cwd=cwd;
    if(app)app._cwd=cwd;
    if(app)app._updateStatusBar();
    // precmd·에이전트 hook 은 같은 OSC 경로를 탄다 — 셸 명령 직후의 즉시 신호다 (FR-GIT-18).
    if(app)app._gitSignal('cwd');
  }
  // FR-TXN-1: 알림은 터미널 화면이 아니라 창 하단 팝업으로 간다 — 셸이 소유한
  // 화면에 남이 쓰면 프롬프트가 어긋나 명령이 도는 것처럼 보인다
  // (TERM_XFER_NOTICE_SRS §1.2). FR-TXN-10: 팝업을 만들다 실패해도 전송은
  // 계속된다 (옛 FR-FTR-9 와 같은 규약).
  _toast(text,kind,ms){ try{return Toast.show(text,kind,ms)}catch{return null} }

  _downloadFile(path){
    const a=document.createElement('a');
    a.href='/api/download?path='+encodeURIComponent(path);
    a.download='';document.body.appendChild(a);a.click();a.remove();
    // 앵커 클릭은 끝나는 시점을 알려 주지 않는다 — 진행 문구를 잠시 보이고
    // 스스로 사라진다 (FR-TXN-8).
    this._toast(TERM_DOWNLOAD_BUSY.replace('%s',path),'',TOAST_MS);
  }
  _uploadFiles(files){
    if(!files||!files.length)return;
    // Get cwd from server for this pane
    apiGet('/api/cwd',{query:{tool:this.id}}).then(res=>{
      const {cwd,source}=res.data||{};
      // FR-FTR-11: 서버의 cwd 는 이 도구의 폴더가 아니다 — 보고 있지 않은 곳에
      // 파일을 떨어뜨리지 않는다. `source` 는 그 구분을 위해 있다 (D-4).
      if(source!=='tool'||!cwd){this._toast(TERM_UPLOAD_NO_CWD,'err',TOAST_ERR_MS);return}
      let i=0;
      const uploadNext=()=>{
        // FR-FTR-10: 끝나도 셸에 엔터를 보내지 않는다 — 그 순간 돌고 있는 것이
        // 셸이 아니면 그 프로그램이 엔터를 받는다.
        if(i>=files.length) return;
        const f=files[i++];
        const fd=new FormData();fd.append('file',f);
        // FR-TXN-3·5: 파일 하나의 일은 팝업 하나에서 마친다. 진행 팝업은 스스로
        // 사라지지 않는다 — 전송이 소멸 시간보다 길면 시작한 일이 사라진다.
        const t=this._toast(TERM_UPLOAD_BUSY.replace('%s',f.name),'',0);
        apiPost('/api/upload',fd,{query:{dir:cwd}})
          .then(r=>(r.ok&&r.data)?r.data:Promise.reject(r))
          .then(d=>{
            if(t)t.update(TERM_UPLOAD_OK.replace('%s',d.name).replace('%z',this._fmtSize(d.size)),'ok');
            uploadNext();
          }).catch(()=>{
            if(t)t.update(TERM_UPLOAD_FAIL.replace('%s',f.name),'err',TOAST_ERR_MS);
            uploadNext();
          });
      };
      uploadNext();
    }).catch(()=>this._toast(TERM_UPLOAD_NO_CWD,'err',TOAST_ERR_MS));
  }
  _fmtSize(b){
    if(b<1024)return b+'B';
    if(b<1048576)return(b/1024).toFixed(1)+'KB';
    return(b/1048576).toFixed(1)+'MB';
  }
  destroy(){
    this._destroyed=true;
    this._flingStop();
    this._clearHealthy();
    if(this._carryTimer){TIMERS.cancel(this._carryTimer);this._carryTimer=null}
    if(this._pendingWs&&this._pendingWs!==this.ws){
      try{this._pendingWs.onopen=null;this._pendingWs.onclose=null;this._pendingWs.onerror=null;this._pendingWs.onmessage=null;this._pendingWs.close()}catch{}
      this._pendingWs=null;
    }
    if(this.ws){this.ws.onclose=null;this.ws.onerror=null;this.ws.close();this.ws=null}
    if(this.term){this.term.dispose();this.term=null}
    this.el.remove(); this._opened=false;
  }
  _send(m){
    const ws=this.ws;
    if(ws&&ws.readyState===1){ws.send(m);return}
    if(ws&&ws.readyState===0){
      if(this._sendQueue.length>=this._sendQueueMax){this._sendQueue.shift();this._sendDropCount++}
      this._sendQueue.push(m);
      return;
    }
    this._sendDropCount++;
  }
  _flushSendQueue(){
    if(!this.ws||this.ws.readyState!==1)return;
    const q=this._sendQueue;this._sendQueue=[];
    for(const m of q){this.ws.send(m)}
  }
}
