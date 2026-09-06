/**
 * 부팅 화면 (BOOT_SCREEN_SRS 묶음 BTS).
 *
 * 화면을 만들지 않는다 — `#boot` 는 `index.html` 의 **정적 마크업**이다 (D-7).
 * 여기서 만들면 이 스크립트가 실행될 때까지 빈 골격이 노출되고, 그것이 이
 * 스펙이 없애려는 바로 그 장면이다.
 *
 * 이 모듈이 가진 것은 두 가지뿐이다: 단계 문구를 바꾸는 손잡이와, 걷는 손잡이.
 */
const BootScreen={
  _el:document.getElementById('boot'),
  _done:false,
  // FR-BTS-10: 걷힌 뒤의 호출은 아무 일도 하지 않는다 — 늦게 도착한 단계 보고가
  // 사라진 화면을 되살리지 않는다.
  step(text){
    if(this._done||!this._el) return;
    const s=document.getElementById('boot-step');
    if(s) s.textContent=text;
  },
  // FR-BTS-12: 두 번 불려도 한 번만 동작한다 — 준비 완료와 상한이 겹쳐 도착할 수 있다.
  done(){
    if(this._done) return;
    this._done=true;
    const el=this._el;
    if(!el) return;
    el.classList.add('gone');
    setTimeout(()=>el.remove(),BOOT_FADE_MS);
  },
};

// FR-BTS-14: 상한. 준비 신호가 오지 않아도 화면은 열린다 — 서버가 답하지 않는
// 것을 사용자가 볼 수 있어야 손쓸 방법도 생긴다.
setTimeout(()=>BootScreen.done(),BOOT_MAX_MS);
