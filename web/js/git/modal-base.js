/**
 * Dongminal — Git 확인·다이얼로그의 공통 골격 (OPTIMIZE_REFACTOR_SRS FR-OPT-12-2 · FEU-12)
 *
 * `GitConfirm`(파괴적 확인)과 `GitDialog`(옵션 폼)가 같은 것을 두 벌 갖고 있었다 — 여는 순서,
 * 실행 상태기계(busy → run → ok 면 닫기, 아니면 err={reason,tail}), 오류 블록·actions 행
 * 칠하기, 닫기, 앞으로 가져오기, 복사. 다른 것은 CSS 접두어와 본문뿐이다.
 *
 * 하위 클래스가 주는 것:
 *   `_pfx`            요소 클래스 접두어 (`gc` · `git-dialog`)
 *   `_build()`        골격 DOM · 키 배선 (`this.ov`·`this.box`)
 *   `_paint()`        본문 칠하기 — 공통 조각은 `_paintChanged`·`_paintErr`·`_paintActions`
 *   `_focus()`        기본 포커스 (FR-PDA-1·5)
 *   `_beforePaint()`  첫 칠하기 앞의 일 (선택)
 *   `_result(v)`      닫을 때 돌려줄 값 (기본: boolean)
 *
 * 한 번에 하나라는 규약(`_cur`)은 하위 클래스마다 따로 선다 — 확인과 다이얼로그는 서로를
 * 막지 않는다.
 */
class GitModalBase {
  _el(part){ return this.box&&this.box.querySelector('.'+this._pfx+'-'+part) }

  _show(){
    // FR-KIT-24: 돌아갈 자리는 `_focus()` **전에** 잡는다 — 뒤에 잡으면 창을 연
    // 컨트롤이 아니라 창 **안의** 버튼이 `returnTo` 가 된다.
    const returnTo=document.activeElement;
    this._build();
    this.constructor._cur=this;
    this._beforePaint();
    this._paint();
    this._focus();
    // FR-KIT-24·25: 이름은 머리(`-head`)가 준다. `_paint` 가 그 글자를 세운
    // 뒤라야 한다 — 빈 요소를 가리키면 접근 이름은 여전히 없다.
    this._releaseDlg=UIKit.dialogOpen(this.box,{
      labelledBy:this._el('head'), label:this.title||'',
      returnTo, focus:document.activeElement,
    });
    return new Promise(res=>{this._resolve=res});
  }

  _beforePaint(){}

  _listenKeys(fn){
    this._key=fn;
    document.addEventListener('keydown',this._key,true);
  }

  // FR-GIT-178: 열린 동안 대상이 움직였으면 알린다 — 실행은 막지 않는다.
  _paintChanged(){
    const ch=this._el('changed');
    ch.textContent=this.changed?GIT_CONFIRM_CHANGED:'';
    ch.classList.toggle('vis',this.changed);
  }

  /**
   * FR-GIT-96·175: 사유와 stderr tail 을 남기고 닫지 않는다 — 닫아 버리면 복사할 자리가
   * 사라진다. `tailVis` 면 tail 이 비었을 때 그 자리를 접는다.
   */
  _paintErr(copyBtn,tailVis){
    const err=this._el('err');
    err.classList.toggle('vis',!!this.err);
    this._el('err-reason').textContent=(this.err&&this.err.reason)||'';
    const tail=this._el('err-tail');
    tail.textContent=(this.err&&this.err.tail)||'';
    if(tailVis) tail.classList.toggle('vis',!!tail.textContent);
    copyBtn.textContent=GIT_CONFIRM_COPY; copyBtn.title=GIT_CONFIRM_COPY_TITLE;
  }

  // FR-GIT-174: 실행 중에는 진행을 보이고 두 버튼을 막는다.
  _paintActions(goLabel,goTitle,goDisabled){
    this._el('progress').textContent=this.busy?GIT_CONFIRM_RUNNING:'';
    const cancel=this._el('cancel'),go=this._el('go');
    cancel.textContent=GIT_CONFIRM_CANCEL; cancel.title=GIT_CONFIRM_CANCEL_TITLE;
    go.textContent=goLabel; go.title=goTitle;
    cancel.disabled=this.busy;
    go.disabled=this.busy||!!goDisabled;
  }

  // F-9.3: 겹쳐 온 요청에 열린 창을 보인다 — 맨 위로 올리고 포커스를 되돌린다.
  _front(){
    if(this.ov&&this.ov.parentNode) document.body.appendChild(this.ov);
    this._focus();
  }

  /**
   * 실행 상태기계. `fn` 은 `{ok:true}` 또는 `{ok:false,reason,stderrTail}` 를 준다 — 던지면
   * 그 사유를 실패로 싣는다. 성공이면 닫고, 실패면 사유를 남긴 채 포커스를 되돌린다.
   */
  async _exec(fn){
    this.busy=true; this.err=null; this._paint();
    const res=await new Promise(ok=>ok(fn())).then(r=>r,e=>({ok:false,reason:String(e)}));
    this.busy=false;
    if(res&&res.ok){this._close(true);return}
    this.err={reason:(res&&res.reason)||GIT_CONFIRM_FAIL,tail:(res&&res.stderrTail)||''};
    this._paint(); this._focus();
  }

  _result(v){ return !!v }

  _close(v){
    document.removeEventListener('keydown',this._key,true);
    if(this._releaseDlg){this._releaseDlg();this._releaseDlg=null}
    if(this.ov) this.ov.remove();
    this.ov=null; this.box=null; this._defBtn=null;   // _defBtn: 선택지 모드의 기본 버튼(GitDialog)
    if(this.constructor._cur===this) this.constructor._cur=null;
    const r=this._resolve; this._resolve=null;
    if(r) r(this._result(v));
  }

  // 클립보드 접근이 막힌 환경에서도 동작해야 한다 — 그 3단은 한 자리에 있다
  // (FR-STR-10). 종전에는 2단만 여기 복사돼 있었고, 그래서 제스처가 거부되면
  // 조용히 실패했다 (FR-STR-14·15).
  _copy(text){
    if(!text) return;
    ClipboardWriter.write(text);
  }
}
