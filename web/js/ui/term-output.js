/**
 * TerminalTool — 출력 파이프라인 (디코드 · OSC 보류 · flush · OSC 777 의 Cwd·Download, FR-TRS-7 · FR-FTR-8).
 *
 * 부품 `TermOutput`(터미널의 `output`) 이다 (REFACTOR3_FE_REST5_SRS D-FR5-9). 상태를 갖지 않는다 — 필드는 종전대로 터미널 인스턴스에
 * 있고 이 부품은 그것을 `this.pane` 으로 읽고 쓴다. 터미널의 이름은 전부 `this.pane.X` 로 부른다 — e2e·시험이 인스턴스에 갈아 끼운
 * 것을 부품도 본다. 파일 끝의 위임자 표가 이 부품의 이름을 `TerminalTool` 원형에 둔다.
 */
class TermOutput {
  constructor(pane){
    this.pane=pane;
  }

  _handleOutput(data){
    // FR-TRS-7: 좌표 통보 뒤의 것만 센다. 길이는 **디코딩 전 바이트**다 —
    // 서버의 오프셋이 PTY 가 낸 raw 바이트의 수이기 때문이다.
    if(this.pane._seqLive) this.pane._seq+=data.length;
    // stream:true preserves UTF-8 multibyte state across WS chunk boundaries
    this.pane._outputBuf+=this.pane._decoder.decode(data,{stream:true}); TermClipboard.arrive(this.pane);   // FR-CPO-1: 도착 때 판정
    if(this.pane._flushScheduled) return;
    this.pane._flushScheduled=true;
    // 프레임이 아니라 매크로태스크다 — 숨은 탭에서도 출력이 흘러야 한다.
    // `frame` 은 탭이 백그라운드면 멎는다.
    TIMERS.defer(()=>this._doFlush(),{owner:this.pane,label:'term-flush'});
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
    this.pane._flushScheduled=false;
    if(this.pane._carryTimer){TIMERS.cancel(this.pane._carryTimer);this.pane._carryTimer=null}
    let text=this.pane._outputBuf; this.pane._outputBuf='';
    const cut=this._oscCarryAt(text);
    if(cut>=0){
      this.pane._outputBuf=text.slice(cut); text=text.slice(0,cut);
      // 다음 청크가 언제 올지는 모른다 — 사용자가 키를 누를 때까지 안 올 수도
      // 있다. 보류한 것이 프롬프트의 일부이면 화면이 멈춘 것으로 보이므로,
      // 짧은 시간 뒤에는 그냥 내보낸다.
      this.pane._carryTimer=TIMERS.after(OSC_CARRY_MS,()=>{this.pane._carryTimer=null;this._doFlush()},{owner:this.pane,label:'osc-carry'});
    }
    if(!text) return;
    const re=/\x1b\]777;(\w+);([^\x07]*)\x07/g;
    let m;
    while((m=re.exec(text))!==null){
      const cmd=m[1],val=m[2];
      if(cmd==='Download') this.pane.xfer._downloadFile(val);
      else if(cmd==='Cwd') this._onCwd(val);
    }
    const clean=text.replace(/\x1b\]777;\w+;[^\x07]*\x07/g,'');
    if(this.pane.term) try{TermClipboard.feed(this.pane,clean)}catch{}   // FR-CPO-5: 쓰기마다 도착 판정을 싣는다
    else if(clean) this.pane._buf.push(enc.encode(clean));
  }
  _onCwd(cwd){
    this.pane._cwd=cwd;
    const f=app&&app.focusedTerminal();   // FR-OPT-4-10 (FEC-M1): 상태바는 포커스 터미널의 위치다
    if(f&&f.id===this.pane.id&&app.cwd!==cwd){app.cwd=cwd;app.updateStatusBar()}
    // precmd·에이전트 hook 은 같은 OSC 경로를 탄다 — 셸 명령 직후의 즉시 신호다 (FR-GIT-18).
    if(app)app.git.gitSignal('cwd');
    // CLAUDE_ACCOUNTS_SRS FR-CAC-95: 폴더 연결의 틴트는 cwd 를 따른다.
    if(app&&app.claudeOnCwd)app.claudeOnCwd();
  }
}
