/**
 * SizeHud — 핸들을 끄는 동안의 크기 표시 (FR-HSZ-2·3·4·8, REFACTOR3_FE_REST3_SRS FR-FR3-15).
 *
 * 문서에 하나뿐인 겹(`#ui-size-hud`)에 상자 둘(`.ui-size-box`)을 둔다. 만들고 지우지 않는다 (D-10) — 끄는 동안
 * 수십 번 그리므로 매번 겹을 세우지 않는다. 부르는 쪽은 `SizeDrag` 하나다. 상태를 갖지 않으므로 정적 메서드뿐이다
 * (D-FR3-13). 옛 이름은 `UIKit._hudEl`·`_hud`·`_hudHide` 다.
 */
// OPTIMIZE_REFACTOR_SRS FR-OPT-12-6 (FEU-19): 화면 가장자리 여백. 리사이즈 HUD 는 가운데 정렬된 자기 크기의
// 반쯤(가로 48 · 세로 28)을 남긴다. 메뉴의 것은 `ui/menu.js` 에 있다.
const UIK_HUD_EDGE_X_PX = 48;
const UIK_HUD_EDGE_Y_PX = 28;
/** `v` 를 [lo, hi] 로 자른다 — 가장자리 여백을 지키는 한 자리. */
function uikClamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi) }

class SizeHud {
  // FR-HSZ-2·8: 문서에 하나뿐인 겹. 만들고 지우지 않는다 (D-10).
  static el() {
    let el = document.getElementById('ui-size-hud');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ui-size-hud';
    el.innerHTML = '<div class="ui-size-box"></div><div class="ui-size-box"></div>';
    document.body.appendChild(el);
    return el;
  }

  static show(axis, px, py, sides) {
    if (!sides || sides.length !== 2) return;
    const el = SizeHud.el();
    const boxes = el.querySelectorAll('.ui-size-box');
    const gapX = 62, gapY = 40;
    for (let i = 0; i < 2; i++) {
      const s = sides[i] || {};
      const b = boxes[i];
      // FR-HSZ-4: px → (터미널이면) C×R → % 를 **세로로** 쌓는다.
      // FR-HSZ-5: 터미널이 아닌 칸에는 그 줄이 없다 — 없는 값을 0 으로 적지 않는다.
      b.innerHTML = '';
      const n = document.createElement('b');
      n.textContent = s.px == null ? '' : Math.round(s.px) + 'px';
      b.appendChild(n);
      if (s.cell) { const c = document.createElement('i'); c.textContent = s.cell; b.appendChild(c) }
      if (s.pct != null) { const p = document.createElement('i'); p.textContent = Math.round(s.pct) + '%'; b.appendChild(p) }
      const sign = i === 0 ? -1 : 1;
      // FR-HSZ-4b: 핸들에 **붙는 변**을 가지런히 한다 — 왼쪽 상자는 오른쪽
      // 정렬, 오른쪽 상자는 왼쪽 정렬. 세로 핸들에서는 붙는 변이 상하이므로
      // 좌우 정렬에 뜻이 없다 (가운데로 둔다).
      b.classList.toggle('to-r', axis !== 'y' && i === 0);
      b.classList.toggle('to-l', axis !== 'y' && i === 1);
      let x = axis === 'y' ? px : px + sign * gapX;
      let y = axis === 'y' ? py + sign * gapY : py;
      // 화면 밖으로 나가면 안쪽으로 민다.
      x = uikClamp(x, UIK_HUD_EDGE_X_PX, innerWidth - UIK_HUD_EDGE_X_PX);
      y = uikClamp(y, UIK_HUD_EDGE_Y_PX, innerHeight - UIK_HUD_EDGE_Y_PX);
      b.style.left = x + 'px';
      b.style.top = y + 'px';
    }
    el.classList.add('on');
  }

  static hide() {
    const el = document.getElementById('ui-size-hud');
    if (el) el.classList.remove('on');
  }
}
