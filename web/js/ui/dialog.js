/**
 * Dialog — 대화상자의 기반 (REFACTOR3_FE_DIALOG_SRS FR-FED-1~6). 킷 모달(`KitModal`)·Git 모달(`GitModalBase` 아래)·
 * 설정 모달(`SettingsModal`)이 이것의 하위다.
 *
 * 세 골격이 각자 적던 것을 한 벌로 둔다: 접근성 계약(`UIKit.dialogOpen`) 걸기·풀기, 키는 대화상자 스택의 맨 위만
 * 받기(FR-OPT-16-4), 한 번만 닫기, 실행 상태기계, 앞으로 가져오기, 복사. Esc 는 `EscapeStack` 이 맨 위 하나에만
 * 준다(REFACTOR3_FE_ESC_SRS FR-FEE-4).
 *
 * 수명이 둘이다(D-FED-3). `_attach`/`_detach` 는 **한 번 여는 동안**의 것이고 `dispose` 는 인스턴스의 끝이다 —
 * 설정 모달은 한 인스턴스를 여러 번 연다.
 *
 * 한 번 쓰고 버리는 하위가 주는 것:
 *   `_build()`        골격 DOM (`this.ov`·`this.box`). 붙이는 것까지 한다
 *   `_paint()`        본문 칠하기 · `_focus()` 기본 포커스 · `_beforePaint()` 첫 칠하기 앞의 일(선택)
 *   `_nameEl()`       이름을 주는 요소(선택) · `_result(v)` 닫을 때 돌려줄 값(기본: boolean)
 *   `_onKey(e)`       Esc 말고 다른 키(선택). 대화상자 스택의 맨 위일 때만 온다
 *   `_escape()`       Esc(선택). 기본은 `_dismiss()` — 닫지 않으면 스택에 남는다
 */
class Dialog extends View {
  constructor(opts){
    super(opts);
    this.ov=null;
    this.box=null;
    this.busy=false;
    this.err=null;
    /** Esc 의 층. 거짓이면 버블이고 전파를 끊지 않는다(설정 모달, D-FED-5). */
    this._escCapture=true;
    this._openOff=[];
    this._resolve=null;
  }

  /** 대화상자 스택이 비었거나 맨 위가 자기 상자다. */
  isTop(){
    const st=UIKit._dlgStack, top=st[st.length-1];
    return !top||top.box===this.box;
  }

  /** 접근성 계약을 걸고 키를 듣는다. 이번 열기에만 쌓는다. */
  _attach(spec){
    const onKey=e=>{ if(this.isTop()) this._onKey(e) };
    const cap=this._escCapture;
    document.addEventListener('keydown',onKey,cap);
    this._openOff.push(()=>document.removeEventListener('keydown',onKey,cap));
    // FR-FEE-4: 닫지 않은 Esc(실행 중)는 항목을 그 자리에 되돌린다 — 끝난 뒤의 Esc 가 닫는다.
    const esc={phase:cap?'capture':'bubble',propagate:!cap,close:()=>{
      this._escape();
      if(this._openOff.length) EscapeStack.push(esc);
    }};
    EscapeStack.push(esc);
    this._openOff.push(()=>EscapeStack.remove(esc));
    this._openOff.push(UIKit.dialogOpen(this.box,spec));
  }

  /** 이번 열기에 쌓은 것을 거꾸로 푼다. 두 번 불러도 안전하다. */
  _detach(){
    const off=this._openOff;
    this._openOff=[];
    for(let i=off.length-1;i>=0;i--) off[i]();
  }

  _onKey(){}

  _escape(){ this._dismiss() }

  _dismiss(){ this._close() }

  _nameEl(){ return null }

  _beforePaint(){}

  /**
   * FR-KIT-24: 돌아갈 자리는 `_focus()` **전에** 잡는다 — 뒤에 잡으면 창을 연 컨트롤이 아니라 창 **안의** 버튼이
   * `returnTo` 가 된다. FR-KIT-24·25: 이름은 `_paint` 가 머리 글자를 세운 뒤에 건다 — 빈 요소를 가리키면 접근
   * 이름은 여전히 없다.
   */
  _show(){
    const returnTo=document.activeElement;
    this._build();
    this.el=this.ov;
    this.constructor._cur=this;
    this._beforePaint();
    this._paint();
    this._focus();
    this._attach({labelledBy:this._nameEl(),label:this.title||'',returnTo,focus:document.activeElement});
    return new Promise(res=>{this._resolve=res});
  }

  _result(v){ return !!v }

  _close(v){
    if(!this._resolve&&!this.ov) return;
    this._detach();
    if(this.ov) this.ov.remove();
    this.ov=null; this.box=null; this.el=null; this._defBtn=null;   // _defBtn: 선택지 모드의 기본 버튼(GitDialog)
    if(this.constructor._cur===this) this.constructor._cur=null;
    this.dispose();
    const r=this._resolve; this._resolve=null;
    if(r) r(this._result(v));
  }

  // F-9.3: 겹쳐 온 요청에 열린 창을 보인다 — 맨 위로 올리고 포커스를 되돌린다.
  _front(){
    if(this.ov&&this.ov.parentNode) document.body.appendChild(this.ov);
    this._focus();
  }

  /**
   * 실행 상태기계. `fn` 은 `{ok:true}` 또는 `{ok:false,reason,stderrTail}` 를 준다 — 던지면 그 사유를 실패로
   * 싣는다. 성공이면 닫고, 실패면 사유를 남긴 채 포커스를 되돌린다.
   */
  async _exec(fn){
    this.busy=true; this.err=null; this._paint();
    const res=await new Promise(ok=>ok(fn())).then(r=>r,e=>({ok:false,reason:String(e)}));
    this.busy=false;
    if(res&&res.ok){this._close(true);return}
    this.err={reason:(res&&res.reason)||this._failText(),tail:(res&&res.stderrTail)||''};
    this._paint(); this._focus();
  }

  /** 사유 없는 실패의 글자. 하위가 덮어쓴다. */
  _failText(){ return '' }

  // 클립보드 접근이 막힌 환경에서도 동작해야 한다 — 그 3단은 한 자리에 있다(FR-STR-10·14·15).
  _copy(text){
    if(!text) return;
    ClipboardWriter.write(text);
  }
}
