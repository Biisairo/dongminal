/**
 * 부팅 화면 (BOOT_SCREEN_SRS 묶음 BTS · BOOT_SCREEN_REUSE_SRS 묶음 BTR).
 *
 * 화면을 만들지 않는다 — `#boot` 는 `index.html` 의 **정적 마크업**이다 (D-7).
 * 여기서 만들면 이 스크립트가 실행될 때까지 빈 골격이 노출되고, 그것이 이
 * 스펙이 없애려는 바로 그 장면이다.
 *
 * 이 모듈이 가진 것은 셋이다: 단계 문구를 바꾸는 손잡이, 걷는 손잡이, 그리고
 * **다시 세우는 손잡이**. 마지막 것이 있는 이유는 화면을 처음부터 다시 세우는
 * 동작이 첫 부팅 말고도 셋이기 때문이다 — 내부 새로고침 · 새 버전 자동
 * 새로고침 · 설정 되돌리기 (BOOT_SCREEN_REUSE_SRS D-BTR-2).
 */
const BootScreen={
  // D-BTR-3: `done()` 이 노드를 떼도 이 참조는 살아 있다. 다시 세우는 것은
  // 이 노드를 되붙이는 일이지 새로 짓는 일이 아니다.
  _el:document.getElementById('boot'),
  _done:false,
  _timer:0,
  // FR-BTS-10: 걷힌 뒤의 호출은 아무 일도 하지 않는다 — 늦게 도착한 단계 보고가
  // 사라진 화면을 되살리지 않는다.
  step(text){
    if(this._done||!this._el) return;
    const s=document.getElementById('boot-step');
    if(s) s.textContent=text;
  },
  /**
   * FR-BTR-1·2·3: 다시 세운다.
   *
   * 이미 서 있으면 문구만 바꾼다 — 붙어 있는 노드를 다시 붙일 이유가 없다.
   * 되붙이는 자리는 **원래 자리(첫 자식)** 다: z-index 로도 가려지지만, 떼어
   * 낸 것을 다른 자리에 돌려놓으면 다음 사람이 마크업과 화면을 견주지 못한다.
   */
  show(text){
    const el=this._el;
    if(!el) return; // FR-BTR-6: 세울 것이 없으면 부른 동작만 진행된다.
    this._done=false;
    el.classList.remove('gone');
    if(!el.isConnected) document.body.insertBefore(el,document.body.firstChild);
    if(text) this.step(text);
    this._arm();
  },
  // FR-BTS-14 / D-BTR-4: 상한은 **세울 때마다** 다시 건다. 한 번만 걸면 두 번째
  // 표시에는 잠김 방어가 없다.
  _arm(){
    clearTimeout(this._timer);
    this._timer=setTimeout(()=>this.done(),BOOT_MAX_MS);
  },
  // FR-BTS-12: 두 번 불려도 한 번만 동작한다 — 준비 완료와 상한이 겹쳐 도착할 수 있다.
  done(){
    if(this._done) return;
    this._done=true;
    // D-BTR-5: 남겨 두면 이번 상한이 뒤늦게 도착해 **다음에 세운 화면**을 걷는다.
    clearTimeout(this._timer);
    this._timer=0;
    const el=this._el;
    if(!el) return;
    el.classList.add('gone');
    // FR-BTR-5 / D-BTR-6: 페이드가 도는 동안 다시 세워졌을 수 있다. 그때의
    // 제거는 방금 붙인 노드를 떼어 가는 일이다.
    setTimeout(()=>{if(this._done) el.remove()},BOOT_FADE_MS);
  },
};

// FR-BTS-14: 첫 부팅의 상한. 준비 신호가 오지 않아도 화면은 열린다 — 서버가
// 답하지 않는 것을 사용자가 볼 수 있어야 손쓸 방법도 생긴다.
BootScreen._arm();
