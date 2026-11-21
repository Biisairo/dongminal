/**
 * SizeDrag — 크기 조절 핸들의 끌기 (FR-HSZ-1·7, REFACTOR3_FE_REST3_SRS FR-FR3-15).
 *
 * `UIKit.drag` 의 본체다 — 그 이름은 기존 호출처를 위한 입구로 남는다. 끄는 동안의 수치는 `SizeHud` 가 그린다.
 * 상태는 제스처 하나의 클로저가 들고, 클래스는 정적 메서드 하나뿐이다 (D-FR3-13). 타이머 주인 이름(`'ui-kit'`)과
 * 합치기 키(`'size-hud'`)는 옮기기 전 그대로다.
 */
class SizeDrag {
  /**
   * FR-HSZ-1: 크기 조절 핸들 하나의 제스처. `UIKit.drag` 가 이것에 맡긴다.
   *
   * 여섯 자리가 각자 `mousedown`→`mousemove`→`mouseup` 을 쓰고 있었고 여섯 중
   * 어느 것도 끄는 동안 수치를 보이지 않았다. 골격을 여기 두면 표시를 붙일
   * 자리도 하나다 (D-11).
   *
   * 부르는 쪽이 주는 것은 **무엇이 바뀌는가**뿐이다:
   *   axis   'x' | 'y'
   *   start(e)      → 이 제스처의 상태(px 기준값 등). 반환값이 ctx 다
   *   move(ctx,e)   → 실제로 크기를 바꾼다
   *   end(ctx,e)    → 확정(저장·fit)
   *   sides(ctx,e)  → [{px,cell,pct}, {px,cell,pct}] — HUD 두 벌 (FR-HSZ-3·4)
   */
  static bind(handle, opts) {
    if (!handle) return;
    const o = opts || {};
    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      let ctx = o.start ? o.start(e) : {};
      if (ctx === false) return;
      if (!ctx || typeof ctx !== 'object') ctx = {};
      // FR-HSZ-1: **시작 좌표는 골격의 것이다.** 여섯 자리가 저마다
      // `const sx=e.clientX` 를 다시 적을 이유가 없고, `sides` 도 그 값을
      // 기준으로 변화량을 낸다.
      ctx.sx0 = e.clientX;
      ctx.sy0 = e.clientY;
      // 좌표는 **누적 상태**로 든다. `TIMERS.frame` 의 coalesce 는 먼저 잡힌
      // 예약이 이기므로(timer-hub §frame), 콜백이 클로저의 옛 좌표를 읽으면
      // HUD 가 한 프레임 전 자리에 멎는다.
      let pt = { x: e.clientX, y: e.clientY };
      let frame = null;
      const paint = () => {
        if (!o.sides) return;
        // FR-HSZ-7: 프레임당 1회 (초당 수십 번의 레이아웃 읽기를 만들지 않는다).
        frame = TIMERS.frame(() => {
          frame = null;
          SizeHud.show(o.axis, pt.x, pt.y, o.sides(ctx, pt));
        }, { owner: 'ui-kit', coalesce: 'size-hud' });
      };
      const mv = ev => { pt = { x: ev.clientX, y: ev.clientY }; if (o.move) o.move(ctx, ev); paint() };
      const up = ev => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        if (frame) { TIMERS.cancel(frame); frame = null }
        SizeHud.hide();
        if (o.end) o.end(ctx, ev);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      paint();
    });
  }
}
