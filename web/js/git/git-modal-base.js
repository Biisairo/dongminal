/**
 * Dongminal — Git 확인·다이얼로그의 공통 칠하기 (OPTIMIZE_REFACTOR_SRS FR-OPT-12-2 · FEU-12)
 *
 * 수명·키·실행 상태기계·앞으로 가져오기·복사는 `Dialog` 의 것이다(REFACTOR3_FE_DIALOG_SRS FR-FED-7). 여기
 * 남는 것은 git 문자열(`GIT_CONFIRM_*`)을 쓰는 조각뿐이다 — 오류 블록·실행 행·"바뀌었다" 알림.
 *
 * 하위 클래스가 주는 것:
 *   `_pfx`            요소 클래스 접두어 (`gc` · `git-dialog`)
 *   `_build()`        골격 DOM (`this.ov`·`this.box`)
 *   `_paint()`        본문 칠하기 — 공통 조각은 `_paintChanged`·`_paintErr`·`_paintActions`
 *   `_focus()`        기본 포커스 (FR-PDA-1·5)
 *   `_onKey(e)`       Esc 말고 다른 키 — 대화상자 스택의 맨 위일 때만 온다
 *   `_escape()`       Esc — `EscapeStack` 이 준다(REFACTOR3_FE_ESC_SRS FR-FEE-4)
 *
 * 한 번에 하나라는 규약(`_cur`)은 하위 클래스마다 따로 선다 — 확인과 다이얼로그는 서로를 막지 않는다.
 */
class GitModalBase extends Dialog {
  _el(part){ return this.box&&this.box.querySelector('.'+this._pfx+'-'+part) }

  _nameEl(){ return this._el('head') }

  _failText(){ return GIT_CONFIRM_FAIL }

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
}
