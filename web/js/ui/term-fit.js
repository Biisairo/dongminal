/**
 * TerminalTool — 크기 판정 (PTY 따르기 · 자기 폭 · 폭이 바뀐 뒤의 다시 그리기, M9_SRS FR-M9-3 · M10_SRS · M11_SRS · OWNER_TRANSFER_REPLAY_SRS).
 *
 * 부품 `TermFit`(터미널의 `sizer`) 이다 (REFACTOR3_FE_REST5_SRS D-FR5-9). 상태를 갖지 않는다 — 필드는 종전대로 터미널 인스턴스에
 * 있고 이 부품은 그것을 `this.pane` 으로 읽고 쓴다. 부르는 쪽은 이 부품을 소유 경로로 부른다
 * (`tool.sizer.doFit()`) — e2e·시험도 이 부품에 갈아 끼운다 (REFACTOR3_FE_DELEG_SRS D-DLG-6).
 */
class TermFit {
  constructor(pane){
    this.pane=pane;
  }

  /**
   * FR-M9-3: **크기의 주인이 아닌 창은 PTY 를 따른다** (D-M9-3).
   *
   * 주인은 `resizeCheck` 가 이미 가른다 (FR-WSL-14 — 슬롯까지 묻는다). 없던 것은
   * 판정이 아니라 **그 사실을 나머지에게 말하는 길**이었고, 이 값이 그것이다.
   *
   * 크기를 아직 못 받았으면 따르지 않는다 — 옛 서버에 붙은 탭은 종전대로 돈다.
   */
  _followsPty(){
    if(!(this.pane._ptyCols>0&&this.pane._ptyRows>0)) return false;
    if(!window.app||!window.app.focus?.owner.resizeCheck) return false;
    return !window.app.focus.owner.resizeCheck(this.pane.id,this.pane._slot);
  }

  /**
   * FR-M9-3: 받은 크기로 xterm 을 세운다. 남는 폭은 여백이다.
   *
   * 주인에게는 하지 않는다 — 그쪽의 진실은 자기 `fit()` 이고, 그 결과가 PTY 로
   * 가서 다시 이 통보가 되어 돌아온다. 주인까지 따르게 하면 그 고리가 자기를
   * 먹는다.
   */
  _applyPtySize(){
    if(!this.pane.term||!this._followsPty()) return;
    if(this.pane.term.cols===this.pane._ptyCols&&this.pane.term.rows===this.pane._ptyRows) return;
    const had=this.pane.term.cols;
    try{this.pane.term.resize(this.pane._ptyCols,this.pane._ptyRows)}catch{}
    // FR-M10-2 의 재생을 지금 받지 않는다 — dim 인 화면은 아무도 안 기다린다(FR-OTR-1·E-7).
    if(this.pane.term.cols!==had) this.pane._widthDebt=true;
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
    this.pane._ptyCols=cols; this.pane._ptyRows=rows;
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
    if(this.pane.fit)try{this.pane.fit.fit()}catch{}
    // FR-M10-1: 여기가 **자기 폭이 정해지는 유일한 자리**다. 소유자로서 잰 값만
    // 기록한다 — 비소유자의 경로는 위에서 이미 돌아갔다.
    if(this.pane.term&&this.pane.term.cols>0){ this.pane._ownCols=this.pane.term.cols; this.pane._ownRows=this.pane.term.rows }
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
    if(!this.pane.term) return;
    const px=termFontSizeNow();
    if(this.pane.term.options.fontSize===px) return;
    this.pane.term.options.fontSize=px;
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
    if(!this.pane.term) return null;
    const had=this.pane.term.cols;
    const vis=!!(this.pane.el&&this.pane.el.classList.contains('vis'));
    if(vis) this.doFit();
    const cols=this.pane._ownCols>0?this.pane._ownCols:this.pane.term.cols;
    const rows=this.pane._ownRows>0?this.pane._ownRows:this.pane.term.rows;
    if(!(cols>0&&rows>0)) return null;
    // FR-OTR-2·8: 빚은 라이브일 때만 근거다. FR-OTR-6·9: 서버가 대체 화면이라 하면 앱의 재그리기에 맡긴다.
    // FR-OTR-10: 숨은 칸은 fit 하지 않아 `cols!==had` 가 풀리지 않는다 — 보일 때 갚는다.
    if(cols!==had||(this.pane._widthDebt&&this.pane._seqLive)){ if(this.pane._srvAlt||!vis) this.pane._widthDebt=true; else this._refreshForWidth() }
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
    if(this.pane._destroyed||this.pane._exited) return false;
    // FR-M11-1: **좌표 버리기가 소켓 판정보다 앞선다.** 폭이 바뀐 것은 화면의
    // 사실이고 전송로의 사실이 아니다 — 재접속 대기·백오프 구간에서 물러나며
    // 좌표를 들고 있으면, 뒤이어 붙는 쪽이 `since` 를 달고 **델타**를 받는다
    // (`_wsURL`). 그러면 옛 폭의 그림은 영영 지워지지 않고, 폭은 이미 바뀌어
    // 있어 다음 `ptySize()` 도 `cols!==had` 를 보지 못한다 (M11_SRS §2.4c·d).
    this.pane._seq=-1; this.pane._seqLive=false;
    // 좌표를 버렸으므로 재개할 자리가 없다 — 반쪽 멀티바이트를 끊는다 (FR-TRS-4).
    // `reconnectNow` 안의 같은 판정은 아래 갈래에서만 지나간다.
    this.pane._resetDecoderIfNoResume();
    // 소켓이 없으면 **여기서 멈춘다.** 새로 걸지 않는 이유는 그 자리에 이미
    // 재접속이 백오프로 돌고 있기 때문이다 — 하나를 더 걸면 두 벌이 된다
    // (D-M11-1). 반환값의 뜻은 종전대로 "지금 다시 붙였는가" 다.
    if(!this.pane.ws) return false;
    return this.pane.reconnectNow({quiet:true});
  }
}
