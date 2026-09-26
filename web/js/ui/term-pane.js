/**
 * Remote Terminal — xterm + WebSocket pane
 */

class TerminalTool {
  constructor(id, name) {
    this.id=id; this.name=name;
    // WINDOW_SLOTS_SRS FR-WSL-14: 같은 도구가 두 슬롯에 서면 toolId 가 같다.
    // 크기 권한을 물을 때 **어느 칸의 인스턴스인지**를 함께 밝혀야 한다.
    this._slot=0;
    // FR-OPT-12-1: 연결·재접속·송신 큐는 `TermSocket` 이 갖는다.
    this._sock=new TermSocket(this);
    this.term=null; this.fit=null; this._opened=false; this._buf=[]; this._reconnecting=false; this._destroyed=false;
    // FR-RCS-1: 도구가 사라졌다는 서버의 통보(OP.EXIT)를 받았는가. 서면 재연결을
    // 영구히 멈춘다.
    this._exited=false;
    // M9_SRS FR-M9-3: 서버가 통보한 **PTY 의 크기**. 0 은 "아직 모른다" 이며,
    // 그때는 종전대로 자기 `fit()` 이 화면을 정한다 — 옛 서버에 붙은 탭의 동작이
    // 그대로여야 한다 (FR-TRS-9 와 같은 규약).
    this._ptyCols=0; this._ptyRows=0;
    this._decoder=new TextDecoder('utf-8',{fatal:false}); this._outputBuf=''; this._flushScheduled=false; this._carryTimer=null;
    // TERMINAL_RESUME_SRS FR-TRS-7: `_seq` 는 **마지막으로 본 바이트 오프셋**이고
    // 다음 접속의 `since` 다. -1 은 "모른다" — 그때는 서버가 전량을 뿌린다.
    //
    // `_seqLive` 가 따로 있는 이유: 재생분(스냅샷·델타)은 좌표 통보 **앞에** 오므로
    // 세면 안 된다 (FR-TRS-8). 통보를 받은 뒤의 OpOutput 만이 라이브 PTY 바이트다.
    this._seq=-1; this._seqLive=false;
    // TERM_REPLY_SEAT_SRS FR-RPS-9: **통보를 받기 전에는 주인이다.** 좌석을 모르는
    // 서버에 붙은 탭은 종전 그대로 돌아야 하고, 그때의 최악은 **종전 동작**이다.
    this._replySeat=true;
    // M10_SRS FR-M10-1: **소유자로서 마지막으로 잰 자기 크기.** `term.cols` 와 따로
    // 두는 이유는 그 칸에 두 진실이 담기기 때문이다 — 비소유가 되면 `_applyPtySize`
    // 가 `term.cols` 를 PTY 폭으로 덮고, 그러면 되찾을 때 되보낼 자기 폭이 없다
    // (D-M10-1). 0 은 "소유자였던 적이 없다" 이고 그때는 `term` 의 값을 쓴다.
    this._ownCols=0; this._ownRows=0; this._widthDebt=false; this._srvAlt=false;   // 빚·서버 대체 화면: OWNER_TRANSFER_REPLAY_SRS
    this.el=document.createElement('div');
    this.el.className='tp'; this.el.dataset.toolid=id;
    this.box=document.createElement('div');
    this.box.style.cssText='width:100%;height:100%';
    this.el.appendChild(this.box);
    // FR-B-6 (UX-11): 드롭 안내는 DOM 텍스트다. `.dragover` 일 때만 CSS 가 보인다.
    const drop=document.createElement('div'); drop.className='tp-drop-hint'; drop.textContent=DROP_FILES_HINT;
    this.el.appendChild(drop);
    this._wireDnd();
    this._wireContextMenu();
  }
  // 파일·폴더 드롭 업로드.
  _wireDnd(){
    // FR-M9-30: 아래 `drop` 과 **같은 판정**이다. 두 문장이 갈리면 그 차이가 곧 결함이다.
    this.el.addEventListener('dragover',e=>{e.preventDefault();if(isFileDrag(e)){e.stopPropagation();this.el.classList.add('dragover')}});
    this.el.addEventListener('dragleave',()=>this.el.classList.remove('dragover'));
    /**
     * TERMINAL_FOLDER_DROP_SRS FR-TFD-10: **폴더도 받는다.**
     *
     * `dataTransfer.files` 만 보면 폴더는 오지 않거나 크기 0 의 실패가 된다 —
     * 그런데 README·features.md 는 "폴더를 놓으면 하위 구조가 그대로 올라간다"
     * 고 두 표면을 함께 말해 왔다. 없던 것은 기능이 아니라 이음매다.
     *
     * `items` 를 **먼저** 본다 (`dropEntries`). entry API 가 없는 브라우저에서만
     * `files` 로 내려가며, 그때는 지금까지와 같은 동작이다 (파일만 올라간다).
     *
     * 한계(`EDITOR_UPLOAD_MAX_ENTRIES`)는 탐색기와 **같은 값**을 쓴다 — 같은
     * 한 가지 사실을 두 벌로 적으면 한쪽만 바뀐다.
     */
    this.el.addEventListener('drop',e=>{
      /**
       * M9_SRS FR-M9-30 (사용자 접수 2026-09-14): **판정은 `dragover` 와 같은
       * 문장이어야 한다.**
       *
       *   이전 동작: `files` 나 `items` 가 하나라도 있으면 파일 드롭으로 보고
       *             `stopPropagation()` 했다
       *   새  동작: `types` 에 `Files` 가 있을 때만. 바로 위 `dragover` 가 쓰는
       *             그 판정이다
       *   이유:     **탭 드래그에도 `items` 가 실리는 판이 있다.** 그때 터미널이
       *             그 드롭을 삼켜 `.pn-body` 의 drop 이 영영 돌지 않고, 분할이
       *             조용히 사라진다. 사용자 콘솔 로그가 그 자리다 —
       *             `ZONE right` · `DROP` 발생 · `app.drag='tab'` 인데
       *             `splitPaneWithTab` 은 불리지 않았다
       *
       * 두 핸들러가 같은 물음에 다른 문장으로 답하면 그 차이가 곧 결함이다.
       * 파일·폴더 드롭은 둘 다 `types` 에 `Files` 를 싣는다 (폴더는 `items` 의
       * `webkitGetAsEntry` 로 읽지만 `types` 는 같다).
       */
      if(!isFileDrag(e)) return;
      const hasFiles=e.dataTransfer.files&&e.dataTransfer.files.length;
      e.preventDefault();e.stopPropagation();
      this.el.classList.remove('dragover');
      walkDrop(e,EDITOR_UPLOAD_MAX_ENTRIES).then(r=>{
        if(!r){ if(hasFiles) this._uploadFiles(e.dataTransfer.files); return }
        // FR-TFD-14: 상한을 넘으면 **하나도** 올리지 않는다. 절반만 올라간
        // 폴더는 되돌릴 길이 없다.
        if(r.over){
          this._toast(EDITOR_UPLOAD_TOO_MANY.replace('%n',EDITOR_UPLOAD_MAX_ENTRIES),'err',TOAST_ERR_MS);
          return;
        }
        if(r.items.length) this._uploadFiles(r.items);
      });
    });
  }
  _wireContextMenu(){
    /**
     * CONTEXT_MENU_UNIFY_SRS FR-CMU-10 (`FUI-17`): 본문의 컨텍스트 메뉴. 복사는
     * `TermClipboard.write`(세 단 폴백), 붙여넣기는 xterm 의 `paste`. 못 하는 것은
     * 감추지 않고 사유를 든다 — 권한이 없는 붙여넣기는 조용히 실패하지 않는다
     * (D-CMU-3).
     */
    this.el.addEventListener('contextmenu',e=>{
      if(!this.term||this._exited) return;
      e.preventDefault(); e.stopPropagation();
      const sel=this.term.hasSelection()?this.term.getSelection():'';
      const canRead=!!(navigator.clipboard&&navigator.clipboard.readText);
      UIKit.menu([
        {id:'copy',label:TERM_MENU_COPY,disabled:sel?false:TERM_MENU_COPY_NO,onClick:()=>TermClipboard.write(sel,this.id)},
        {id:'paste',label:TERM_MENU_PASTE,disabled:canRead?false:TERM_MENU_PASTE_NO,onClick:()=>{
          navigator.clipboard.readText().then(t=>{if(t)this.term.paste(t)},()=>Toast.show(TERM_MENU_PASTE_DENIED,'err'));
        }},
        {id:'selectAll',label:TERM_MENU_SELECT_ALL,onClick:()=>this.term.selectAll()},
        {sep:true},
        {id:'find',label:TERM_MENU_FIND,onClick:()=>{if(window.app&&app.toggleSearch)app.toggleSearch()}},
        {id:'newTab',label:TAB_MENU_NEW,onClick:()=>{if(window.app&&app.addTabFocused)app.addTabFocused()}},
      ],{at:{x:e.clientX,y:e.clientY},cls:'term-menu'});
    });
  }
  open() {
    if(this._opened) return; this._opened=true;
    /**
     * FONT_SIZE_SETTING_SRS FR-FSS-13 — **글꼴 크기는 자기 설정에서 온다.**
     *
     * `FR-M11-15` 의 개정이다. 그때는 `--fs-lg` 를 읽었다: 하단 대시보드
     * (`.agp-dash`)와 터미널이 같은 값을 써야 했고, 값이 두 벌이 되지 않게
     * CSS 토큰을 진실로 삼았다. **그 대시보드는 에이전트 GUI 와 함께 사라졌고**
     * (`AGENT_GUI_REMOVAL_SRS`), 남은 것은 짝을 잃은 결합이었다 — 그 결합이
     * 있는 한 UI 를 키우면 터미널이 따라 커진다.
     *
     * 진실이 여전히 한 자리인 것은 같다. 그 자리가 CSS 토큰에서 설정 키로 옮겼다.
     */
    this.term=new Terminal(Object.assign({},TOPTS,{fontSize:termFontSizeNow()}));
    this.fit=new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this._loadAddons();
    this.term.open(this.box);
    for(const f of ['h','l']) this.term.parser.registerCsiHandler({prefix:'?',final:f},ps=>this._onAltMode(ps,f==='h'));
    this.term.parser.registerCsiHandler({final:'J'},ps=>this._onEraseDisplay(ps));
    this._wireKeys();
    this.term.onData(d=>this._onTermData(d));
    this.term.onResize(({cols,rows})=>{
      // Only the OS-focused window that owns the pane's window may send resize.
      if(!window.app||!window.app.resizeCheck(this.id,this._slot)) return;
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
    if(ta) this._wireIme(ta);
    this._initTouchScroll();
    try{this.fit.fit()}catch{}
    for(const d of this._buf) try{this.term.write(d)}catch{}
    this._buf=[];
    if(this.term) this.term.scrollToBottom();
  }

  /**
   * 선택 애드온. 하나가 없거나 실패해도 터미널은 선다 — 그래서 하나씩 따로 싣는다.
   *
   * FR-ETR-37: OSC 52(클립보드 쓰기). xterm 은 이것을 스스로 처리하지 않으므로 붙이지 않으면
   * 셸이 보낸 복사가 **받는 사람 없이 버려진다** — 그것이 "복사가 원격에서만 안 된다" 의
   * 정체였다 (§2.5).
   */
  _loadAddons(){
    const steps=[
      ()=>this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e,uri)=>{window.open(uri,'_blank')})),
      ()=>{this.term.loadAddon(new Unicode11Addon.Unicode11Addon());this.term.unicode.activeVersion='11'},
      ()=>{this.search=new SearchAddon.SearchAddon();this.term.loadAddon(this.search)},
      ()=>TermClipboard.attach(this.term,this.id,this),
    ];
    for(const step of steps){
      try{ step() }catch{ /* 애드온이 없는 판 — 그 기능만 빠진다 */ }
    }
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
    else if(d[0]===OP.SIZE){ this._onSize(d.subarray(1)); }
    // FR-RPS-3: 페이로드 1 바이트 — 이 연결이 답장을 보낼 자격을 쥐었는가.
    else if(d[0]===OP.REPLY_SEAT){ this._replySeat=d[1]===1; }
    else if(d[0]===OP.TOOLID){ this.id=dec.decode(d.subarray(1)); this.el.dataset.toolid=this.id; }
    else if(d[0]===OP.EXIT){ this._markExited(); }
    else if(d[0]===OP.ERROR){ this.write('\r\n\x1b[31m'+dec.decode(d.subarray(1))+'\x1b[0m\r\n'); }
  }
  // FR-RCS-1·2: 서버가 도구의 부재를 알렸다. 이 패널은 다시 연결하지 않으며,
  // 사실을 오버레이로 남긴다 — 본문 한 줄은 스크롤 밖으로 밀려 사라진다.
  _markExited(){
    if(this._exited) return;
    this._exited=true;
    this._sock.clearHealthy();
    this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n');
    this.el.style.opacity='1'; this._reconnecting=false;
    /**
     * FUI-14: **출구를 함께 놓는다.**
     *
     * 이 오버레이는 종전에 "이 탭을 닫아 주세요" 로 끝났다 — 안내가 사용자에게
     * 일을 넘기고 그 일의 자리를 말하지 않으면 그것은 출구가 아니다.
     *
     * 두 동작 다 앱이 이미 갖고 있다. 여기서는 **자리만** 준다.
     */
    this._showOverlay(TERM_EXITED_TITLE,TERM_EXITED_SUB,[
      {label:TERM_EXITED_CLOSE,cls:'tp-ov-close',run:()=>this._exitClose()},
      {label:TERM_EXITED_NEW,cls:'tp-ov-new',run:()=>this._exitNewShell()},
    ]);
  }

  // 이 패널이 든 탭의 자리. 슬롯 복합키(`id@1`)를 지나야 남의 칸을 닫지 않는다.
  _exitSpot(){
    const app=window.app;
    if(!app||!app.findToolLocation) return null;
    return app.findToolLocation(this.id);
  }

  // FUI-14: 탭 닫기. `closeTab` 이 확인·정리 규약을 이미 든다.
  _exitClose(){
    const loc=this._exitSpot();
    if(!loc) return;
    window.app.closeTab(loc.pane.id,loc.tab.id,loc.win.id);
  }

  /**
   * FUI-14: **같은 자리에 새 셸.**
   *
   * 순서가 요점이다 — 먼저 열고 나서 닫는다. 반대로 하면 그 칸의 마지막 탭이
   * 닫히는 순간 칸이 붕괴해(`closeTab` 의 규약) 새 탭이 갈 자리가 사라진다.
   */
  async _exitNewShell(){
    const loc=this._exitSpot();
    if(!loc) return;
    const app=window.app;
    await app.addTab(loc.pane.id,'terminal',{windowId:loc.win.id});
    app.closeTab(loc.pane.id,loc.tab.id,loc.win.id);
  }
  _sendResize(cols,rows){
    const m=new Uint8Array(5);m[0]=OP.RESIZE;
    const dv=new DataView(m.buffer);
    dv.setUint16(1,cols,false);
    dv.setUint16(3,rows,false);
    this._send(m);
  }
  _onWsOpen(){
    this._sock.markHealthy();
    // FR-TRS-7: 새 소켓이다. 좌표 통보를 받기 전까지는 세지 않는다 — 그 전에 오는
    // OpOutput 은 재생분이고, 그것을 더하면 좌표가 재생 길이만큼 앞질러 간다.
    this._seqLive=false;
    if(this.term && window.app && window.app.resizeCheck(this.id)){
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
    /**
     * FR-TRS-18·18a: 넛지는 **전량 재생이고, 앱이 alt screen 안일 때만** 건다.
     *
     * 플래그는 이제 비트다 — bit0 전량, bit1 alt screen. 종전에는 값 `1` 하나만
     * 보고 전량이면 무조건 걸었고, 그것이 접수된 렌더 잔재의 원인이었다
     * (`M11_SRS` §2.4f): 넛지는 `SIGWINCH` 를 두 번 일으켜 앱을 두 번 그리게
     * 하는데, **화면을 지우지 않고 커서만 올려 덮어쓰는 앱**은 그때마다 어긋난
     * 그림을 하나씩 더 쌓는다. claude 가 그 방식이다.
     *
     * 넛지가 막는 영구 desync 는 alt screen 앱에서만 일어나므로(§2.4), 약을
     * 버리는 것이 아니라 필요한 곳에만 남기는 것이다.
     */
    const flag=p[8];
    this._srvAlt=!!(flag&SEQ_FLAG_ALT); if(flag&SEQ_FLAG_FULL){ this._widthDebt=false; if(this._srvAlt) this._redrawNudge() }   // FR-OTR-3·9
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
    if(!window.app||!window.app.resizeCheck(this.id,this._slot)) return;
    this._sendResize(cols,rows-1);
    TIMERS.defer(()=>{if(this.term)this._sendResize(cols,rows)},{owner:this,label:'trs-nudge'});
  }
  connect() {
    // 명시적인 connect 는 새 시도다 — 이전의 종료 판정을 지운다.
    this._exited=false;
    this._sock.open();
  }
  // ── TermSocket 의 주인 쪽 (FR-OPT-12-1) ──
  _wsStopped(){ return this._destroyed||this._exited }
  /**
   * 소켓이 열렸다. 재시도로 붙었거나 `reconnectNow()` 가 오버레이를 띄웠으면 걷는다 —
   * 걷지 않으면 연결은 붙는데 "다시 연결" 화면이 영영 남는다 (실측).
   */
  _wsOpened(viaRetry){
    this._onWsOpen();
    if(viaRetry||this._reconnecting) TIMERS.after(TERM_OVERLAY_HIDE_MS,()=>this._onWsReady(),{owner:this,label:'overlay-hide'});
  }
  _onWsReady(){
    this._hideOverlay(); this.el.style.opacity='1'; this._reconnecting=false;
    if(this.term) this.term.scrollToBottom();
  }
  _wsLost(kind){
    if(kind==='close') this._showOverlay(t('term.disconnected'),t('term.reconnecting'));
    else this._showOverlay(t('term.conn_error'),t('term.reconnecting'));
    this._scheduleReconnect();
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
  reconnectNow(opts){
    if(this._destroyed||this._exited) return false;
    // FR-M10-2: `quiet` 는 **우리가 거는 갱신**이다 — 사용자가 고른 일이 아니므로
    // "다시 연결" 화면을 띄우지 않는다. 연결 자체의 절차는 완전히 같다.
    const quiet=!!(opts&&opts.quiet);
    // 옛 소켓의 콜백을 먼저 끊는다 — 살려 두면 close 가 `_scheduleReconnect` 를
    // 불러 재연결이 두 벌로 돈다. 사용자가 부른 재연결이므로 즉시 시도한다 —
    // 백오프는 실패가 이어질 때의 것이다.
    this._sock.reset();
    this._resetDecoderIfNoResume();
    this._reconnecting=!quiet;
    if(!quiet) this._showOverlay(t('term.reconnect'), t('term.soft_reload'));
    this.connect();
    return true;
  }

  _scheduleReconnect(){
    // FR-RCS-1: 도구가 사라졌다는 통보를 받았으면 다시 붙지 않는다. 이 한 줄이
    // 없으면 없는 도구를 향해 지연 0 으로 무한히 재접속한다 (§2.1).
    if(!this._sock.arm()) return;
    this._resetDecoderIfNoResume();
    this._sock.retry();
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
  /**
   * FR-M9-3: **크기의 주인이 아닌 창은 PTY 를 따른다** (D-M9-3).
   *
   * 주인은 `resizeCheck` 가 이미 가른다 (FR-WSL-14 — 슬롯까지 묻는다). 없던 것은
   * 판정이 아니라 **그 사실을 나머지에게 말하는 길**이었고, 이 값이 그것이다.
   *
   * 크기를 아직 못 받았으면 따르지 않는다 — 옛 서버에 붙은 탭은 종전대로 돈다.
   */
  _followsPty(){
    if(!(this._ptyCols>0&&this._ptyRows>0)) return false;
    if(!window.app||!window.app.resizeCheck) return false;
    return !window.app.resizeCheck(this.id,this._slot);
  }

  /**
   * FR-M9-3: 받은 크기로 xterm 을 세운다. 남는 폭은 여백이다.
   *
   * 주인에게는 하지 않는다 — 그쪽의 진실은 자기 `fit()` 이고, 그 결과가 PTY 로
   * 가서 다시 이 통보가 되어 돌아온다. 주인까지 따르게 하면 그 고리가 자기를
   * 먹는다.
   */
  _applyPtySize(){
    if(!this.term||!this._followsPty()) return;
    if(this.term.cols===this._ptyCols&&this.term.rows===this._ptyRows) return;
    const had=this.term.cols;
    try{this.term.resize(this._ptyCols,this._ptyRows)}catch{}
    // FR-M10-2 의 재생을 지금 받지 않는다 — dim 인 화면은 아무도 안 기다린다(FR-OTR-1·E-7).
    if(this.term.cols!==had) this._widthDebt=true;
  }

  /**
   * FR-M9-3: 서버가 통보한 PTY 크기 (4 바이트 — cols 2 + rows 2, 빅엔디언).
   *
   * 0 은 "모른다" 이고 서버는 그것을 보내지 않는다. 그래도 막는 것은, 0 을 그대로
   * 쓰면 `term.resize(0,0)` 이 화면을 잃기 때문이다.
   */
  _onSize(p){
    if(!p||p.length<4) return;
    const dv=new DataView(p.buffer,p.byteOffset,p.length);
    const cols=dv.getUint16(0,false), rows=dv.getUint16(2,false);
    if(!(cols>0&&rows>0)) return;
    this._ptyCols=cols; this._ptyRows=rows;
    this._applyPtySize();
  }

  /**
   * FR-M9-3: 비소유자의 `fit()` 은 **자기 폭으로 되돌리는 일**이다.
   *
   * `doFit` 은 렌더·레이아웃·키보드 등 여러 자리가 조건 없이 부른다. 그 전부에
   * 판정을 심는 대신 여기 하나에 둔다 — 판정 자리가 둘이면 한쪽만 고쳐진다.
   * 소유자의 동작은 종전과 완전히 같다.
   */
  doFit(){
    if(this._followsPty()){ this._applyPtySize(); return }
    if(this.fit)try{this.fit.fit()}catch{}
    // FR-M10-1: 여기가 **자기 폭이 정해지는 유일한 자리**다. 소유자로서 잰 값만
    // 기록한다 — 비소유자의 경로는 위에서 이미 돌아갔다.
    if(this.term&&this.term.cols>0){ this._ownCols=this.term.cols; this._ownRows=this.term.rows }
  }

  /**
   * FR-FSS-15·16: 지금 값을 얹고 **다시 잰다**.
   *
   * 값만 얹으면 화면이 어긋난 채 남는다 — 글자가 커지면 같은 픽셀 상자에 들어가는
   * `cols`·`rows` 가 줄고, PTY 는 옛 크기를 믿은 채 줄을 나눈다. `doFit` 이
   * `fit()` → `onResize` → `_sendResize` 의 길을 이미 갖고 있으므로 그것을 딛는다
   * (보낼 자격은 `resizeCheck` 가 종전대로 가린다, M10_SRS FR-M10-1).
   */
  applyFontSize(){
    if(!this.term) return;
    const px=termFontSizeNow();
    if(this.term.options.fontSize===px) return;
    this.term.options.fontSize=px;
    this.doFit();
  }

  /**
   * FR-M10-1: 소유자가 PTY 에 보낼 **자기 크기**.
   *
   * `resendWindowSizes` 가 `term.cols` 를 그대로 보내던 것이 M10-B1 이었다 — 비소유
   * 동안 그 칸이 PTY 폭으로 덮여 있어, 되찾아도 물려받은 폭이 되돌아갔다 (§2.2).
   *
   * 보이는 pane 은 상자가 있으므로 **다시 잰다**. 숨은 pane 은 상자가 0 이라 `fit`
   * 을 걸면 폭을 잃으므로 기억한 값을 쓴다 — 그것이 `_ownCols` 가 있는 이유다.
   *
   * 폭이 바뀌었으면 전량 재생을 건다 (FR-M10-2). **이 자리에만 건다** — `doFit` 에
   * 걸면 창을 드래그할 때마다 tail 을 통째로 다시 받는다 (D-M10-3).
   */
  ptySize(){
    if(!this.term) return null;
    const had=this.term.cols;
    if(this.el&&this.el.classList.contains('vis')) this.doFit();
    const cols=this._ownCols>0?this._ownCols:this.term.cols;
    const rows=this._ownRows>0?this._ownRows:this.term.rows;
    if(!(cols>0&&rows>0)) return null;
    // FR-OTR-2·8: 빚은 라이브일 때만 근거다. FR-OTR-6·9: 서버가 대체 화면이라 하면 앱의 재그리기에 맡긴다.
    if(cols!==had||(this._widthDebt&&this._seqLive)){ if(this._srvAlt) this._widthDebt=true; else this._refreshForWidth() }
    return {cols,rows};
  }

  /**
   * FR-M10-2: 스크롤백을 **지금 폭으로 다시 그린다.**
   *
   * 좌표를 버리면 다음 접속의 `since` 가 없고, 서버는 그것을 전량 재생으로 읽는다
   * (FR-TRS-3). 전량 재생은 `termHardClear` 로 화면과 **스크롤백까지**(`\x1b[3J`)
   * 지운 뒤 tail 을 되뿌리므로, 받는 xterm 이 그것을 지금 폭으로 다시 파싱한다.
   * 사용자가 새로고침으로 하던 일이 이것이다 (M10_SRS §2.3).
   *
   * 와이어에 "재생 요청" op 를 더하지 않은 이유는 동시성이다 — `relayOutput` 이
   * `sent` 오프셋으로 겹침을 자르는 중에 재생을 끼우면 그 오프셋을 되감아야 한다
   * (D-M10-2). 소켓을 다시 열면 서버는 **새 연결**로 다루므로 그 물음이 없다.
   */
  _refreshForWidth(){
    if(this._destroyed||this._exited) return false;
    // FR-M11-1: **좌표 버리기가 소켓 판정보다 앞선다.** 폭이 바뀐 것은 화면의
    // 사실이고 전송로의 사실이 아니다 — 재접속 대기·백오프 구간에서 물러나며
    // 좌표를 들고 있으면, 뒤이어 붙는 쪽이 `since` 를 달고 **델타**를 받는다
    // (`_wsURL`). 그러면 옛 폭의 그림은 영영 지워지지 않고, 폭은 이미 바뀌어
    // 있어 다음 `ptySize()` 도 `cols!==had` 를 보지 못한다 (M11_SRS §2.4c·d).
    this._seq=-1; this._seqLive=false;
    // 좌표를 버렸으므로 재개할 자리가 없다 — 반쪽 멀티바이트를 끊는다 (FR-TRS-4).
    // `reconnectNow` 안의 같은 판정은 아래 갈래에서만 지나간다.
    this._resetDecoderIfNoResume();
    // 소켓이 없으면 **여기서 멈춘다.** 새로 걸지 않는 이유는 그 자리에 이미
    // 재접속이 백오프로 돌고 있기 때문이다 — 하나를 더 걸면 두 벌이 된다
    // (D-M11-1). 반환값의 뜻은 종전대로 "지금 다시 붙였는가" 다.
    if(!this.ws) return false;
    return this.reconnectNow({quiet:true});
  }
  focus(){if(this.term)try{this.term.focus()}catch{}}
  // FR-ESF-1~5: 스크롤백을 지운(ED3) 뒤에는 바닥을 따른다.
  _onEraseDisplay(ps){
    if(ps[0]===3&&!this._ed3Follow&&this.term.buffer.active.type!=='alternate'){
      const d=this.term.onWriteParsed(()=>{d.dispose();this._ed3Follow=false;if(this.term)this.term.scrollToBottom()});
      this._ed3Follow=true;
    }
    return false;
  }
  // FR-OTR-7·9: 대체 화면을 나오면 미뤄 둔 폭 빚을 갚는다.
  _onAltMode(ps,on){
    if(ps.some(v=>v===1049||v===47||v===1047)){
      this._srvAlt=on;
      if(!on&&this._widthDebt&&this._seqLive&&!this._followsPty()) this._refreshForWidth();
    }
    return false;
  }
  // 오버레이는 **DOM 으로 세운다** — `_confirmClose` 를 `GitConfirm` 규약으로
  // 옮긴 것과 같은 근거다 (M2 `UX-1`). `textContent` 는 이스케이프를 부를 필요가
  // 없고, 부를 함수가 이 파일의 스코프에 있는지도 묻지 않는다.
  //
  // 종전에는 `innerHTML` 에 `escHtml(...)` 을 끼워 넣었는데, `escHtml` 은
  // `helpers.js` 의 전역이라 그 파일을 싣지 않는 자리에서는 없다 — 패널이 종료될
  // 때마다 `ReferenceError` 로 터졌다 (`reconnect-storm.spec.ts` 가 그 자리다).
  /**
   * `acts` 는 오버레이가 주는 출구다 (FUI-14). 없으면 종전과 같이 글 둘뿐이다 —
   * 재연결 중의 오버레이에는 누를 것이 없다.
   */
  _showOverlay(title,sub,acts){
    let ov=this.el.querySelector('.tp-overlay');
    if(!ov){
      ov=document.createElement('div');ov.className='tp-overlay';
      // FR-A11Y-19 (`UX-8`): 연결이 끊긴 것과 다시 붙는 것은 **읽혀야 하는
      // 사실**이다 — 터미널을 보고 있지 않은 사용자에게는 화면만으로 전달되지
      // 않는다. 리전은 내용이 바뀌기 전에 서야 하므로 만들 때 붙인다.
      ov.setAttribute('role','status');
      this.el.appendChild(ov);
    }
    const t=document.createElement('div');t.className='tp-ov-title';t.textContent=title;
    const b=document.createElement('div');b.className='tp-ov-sub';b.textContent=sub;
    const kids=[t,b];
    if(acts&&acts.length){
      const bar=document.createElement('div');bar.className='tp-ov-acts';
      for(const a of acts){
        bar.appendChild(UIKit.button({label:a.label,cls:a.cls,onClick:ev=>{ev.stopPropagation();a.run()}}));
      }
      kids.push(bar);
    }
    ov.replaceChildren(...kids);
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
    this._outputBuf+=this._decoder.decode(data,{stream:true}); TermClipboard.arrive(this);   // FR-CPO-1: 도착 때 판정
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
    if(this.term) try{TermClipboard.feed(this,clean)}catch{}   // FR-CPO-5: 쓰기마다 도착 판정을 싣는다
    else if(clean) this._buf.push(enc.encode(clean));
  }
  _onCwd(cwd){
    this._cwd=cwd;
    const f=app&&app.focusedTerminal();   // FR-OPT-4-10 (FEC-M1): 상태바는 포커스 터미널의 위치다
    if(f&&f.id===this.id&&app.cwd!==cwd){app.cwd=cwd;app.updateStatusBar()}
    // precmd·에이전트 hook 은 같은 OSC 경로를 탄다 — 셸 명령 직후의 즉시 신호다 (FR-GIT-18).
    if(app)app.gitSignal('cwd');
  }
  // FR-TXN-1: 알림은 터미널 화면이 아니라 창 하단 팝업으로 간다 — 셸이 소유한
  // 화면에 남이 쓰면 프롬프트가 어긋나 명령이 도는 것처럼 보인다
  // (TERM_XFER_NOTICE_SRS §1.2). FR-TXN-10: 팝업을 만들다 실패해도 전송은
  // 계속된다 (옛 FR-FTR-9 와 같은 규약).
  _toast(text,kind,ms){ try{return Toast.show(text,kind,ms)}catch{return null} }

  _downloadFile(path){
    const a=document.createElement('a');
    a.href=FILE_DOWNLOAD_API+'?path='+encodeURIComponent(path);
    a.download='';document.body.appendChild(a);a.click();a.remove();
    // 앵커 클릭은 끝나는 시점을 알려 주지 않는다 — 진행 문구를 잠시 보이고
    // 스스로 사라진다 (FR-TXN-8).
    this._toast(TERM_DOWNLOAD_BUSY.replace('%s',path),'',TOAST_MS);
  }
  _uploadFiles(files){
    if(!files||!files.length)return;
    // Get cwd from server for this pane
    apiGet(CWD_API,{query:{tool:this.id}}).then(res=>{
      const {cwd,source}=res.data||{};
      // FR-FTR-11: 서버의 cwd 는 이 도구의 폴더가 아니다 — 보고 있지 않은 곳에
      // 파일을 떨어뜨리지 않는다. `source` 는 그 구분을 위해 있다 (D-4).
      if(source!=='tool'||!cwd){this._toast(TERM_UPLOAD_NO_CWD,'err',TOAST_ERR_MS);return}
      let i=0;
      const uploadNext=()=>{
        // FR-FTR-10: 끝나도 셸에 엔터를 보내지 않는다 — 그 순간 돌고 있는 것이
        // 셸이 아니면 그 프로그램이 엔터를 받는다.
        if(i>=files.length) return;
        // FR-TFD-12: `{file, relPath}` 도 받는다. `relPath` 가 있으면 서버가 그
        // 아래 폴더를 만든다 — `file` 보다 **먼저** 실어야 한다. 서버가 스트림으로
        // 파싱하므로 순서가 계약이다 (`file-tree-xfer.js` 의 근거와 같다).
        const it=files[i++];
        const f=it&&it.file?it.file:it;
        const rel=(it&&it.relPath)||'';
        const fd=new FormData();
        if(rel) fd.append('relPath',rel);
        fd.append('file',f);
        // FR-TXN-3·5: 파일 하나의 일은 팝업 하나에서 마친다. 진행 팝업은 스스로
        // 사라지지 않는다 — 전송이 소멸 시간보다 길면 시작한 일이 사라진다.
        // FR-TFD-13: 보이는 이름은 `relPath` 다 — `a/b/c.txt` 를 `c.txt` 로만
        // 보이면 어느 것이 끝났는지 알 수 없다.
        const label=rel||f.name;
        const t=this._toast(TERM_UPLOAD_BUSY.replace('%s',label),'',0);
        apiPost(UPLOAD_API,fd,{query:{dir:cwd}})
          .then(r=>(r.ok&&r.data)?r.data:Promise.reject(r))
          .then(d=>{
            // FR-TFD-13: 폴더 맥락과 **실제 저장된 이름**을 함께 보인다. 서버는
            // 충돌 시 개명하므로(`c (1).txt`) 그 사실이 보여야 하고, 그렇다고
            // 마지막 조각만 보이면 어느 폴더의 것인지 알 수 없다.
            const at=rel?rel.replace(/[^/]*$/,'')+d.name:d.name;
            if(t)t.update(TERM_UPLOAD_OK.replace('%s',at).replace('%z',this._fmtSize(d.size)),'ok');
            uploadNext();
          }).catch(()=>{
            if(t)t.update(TERM_UPLOAD_FAIL.replace('%s',label),'err',TOAST_ERR_MS);
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
    if(this._carryTimer){TIMERS.cancel(this._carryTimer);this._carryTimer=null}
    this._sock.close();
    if(this.term){this.term.dispose();this.term=null}
    this.el.remove(); this._opened=false;
  }
  _send(m){ this._sock.send(m) }
  _flushSendQueue(){ this._sock.flush() }
  // 옛 필드 이름 — e2e(terminal·reconnect-storm)와 진단(main.js `sendDropCount`)이 읽는다.
  // 값은 TermSocket 이 갖는다.
  get ws(){ return this._sock.ws }
  set ws(v){ this._sock.ws=v }
  get _retryDelay(){ return this._sock.retryDelay }
  set _retryDelay(v){ this._sock.retryDelay=v }
  get _sendQueue(){ return this._sock.queue }
  set _sendQueue(v){ this._sock.queue=v }
  get _sendQueueMax(){ return TERM_SEND_QUEUE_MAX }
  get _sendDropCount(){ return this._sock.dropCount }
}
