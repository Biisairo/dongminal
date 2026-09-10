/**
 * 공통 UI 키트 (UI_KIT_SRS 묶음 A).
 *
 * 버튼·탭·상자·메뉴·컨트롤을 **만드는 자리 하나**다. 지금까지 같은 것이
 * 열한 벌(버튼)·다섯 벌(탭)로 흩어져 있었고, 그래서 한쪽에만 있는 동작이
 * 생겼다 — 어떤 아이콘 버튼에는 툴팁이 없고, 어떤 메뉴는 Esc 로 닫히지 않았다.
 *
 * 계약 셋 (FR-UIK-28 / D-9):
 *   ① 팩토리는 **DOM 을 만들 뿐 상태를 갖지 않는다.** 어떤 레지스트리에도
 *      등록하지 않는다 — `reconcileList`(FR-RPT-3)가 요소를 재사용하므로,
 *      팩토리가 기억을 들면 재사용된 요소와 그 기억이 어긋난다.
 *   ② 클래스 이름은 **더한다.** 부르는 쪽이 `cls` 로 옛 이름을 함께 준다
 *      (FR-UIK-10 / D-5).
 *   ③ 아이콘만 있는 버튼은 `title` 이 필수다 (FR-UIK-21) — 이름 없는
 *      아이콘 버튼은 접근할 수 없다.
 *
 * 로드 순서 계약: repaint.js **뒤**, sidebar-tabs.js **앞** (FR-UIK-20).
 */
const UIKit = {
  /**
   * FR-UIK-23 / FR-GLY-2: 스프라이트의 심볼 하나를 참조하는 `<svg>`.
   *
   * 모양만 스프라이트에서 오고 색·굵기는 `.ui-icon` 이 준다 — 그래서 44개
   * 테마 어디서나 글자색을 그대로 따른다.
   *
   * 없는 이름은 **화면을 깨지 않는다.** 경고를 남기고 빈 자리를 돌려준다:
   * 아이콘 하나가 빠졌다고 그 버튼이 사라지면 손잡이 자체를 잃는다.
   */
  icon(name, opts) {
    const o = opts || {};
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', ['ui-icon', o.size ? 'ui-icon-' + o.size : '',
      o.fill ? 'ui-icon-fill' : '', o.cls || ''].filter(Boolean).join(' '));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (name && !document.getElementById('i-' + name)) {
      console.warn('[ui-kit] 아이콘이 스프라이트에 없다: ' + name);
      return svg;
    }
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  },

  /**
   * 같은 아이콘의 **문자열 형태**. 골격을 `innerHTML` 로 한 번에 세우는 자리를
   * 위한 것이다 (git 패널·편집기가 그렇게 만든다) — 그 자리에 노드를 끼우려면
   * 골격을 세운 뒤 다시 찾아 붙여야 하고, 그러면 만드는 순서가 두 걸음이 된다.
   *
   * 이름이 스프라이트에 없어도 여기서는 검사하지 않는다 — 문자열을 만드는 시점에
   * 문서가 아직 없을 수 있다. 빈 `<use>` 는 아무것도 그리지 않으므로 화면은 깨지지
   * 않고, 개발 중에는 `icon()` 쪽 경고가 같은 오타를 잡는다.
   */
  iconHTML(name, cls) {
    return '<svg class="ui-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">'
      + '<use href="#i-' + name + '"/></svg>';
  },

  /**
   * FR-UIK-21·22: 버튼 하나.
   *
   *   icon      스프라이트의 이름. 주면 `<svg>` 가 라벨 앞에 붙는다
   *   label     글자. 없으면 아이콘 버튼이 되어 정사각이 된다
   *   title     툴팁. 아이콘만인 버튼에는 **필수**이며 aria-label 도 여기서 온다
   *   kind      'primary' | 'danger' | 'ghost' | 'attn' (없으면 기본)
   *   size      'sm' | 'lg' (없으면 표준)
   *   cls       함께 붙일 기존 클래스 (D-5)
   */
  button(spec) {
    const s = spec || {};
    if (!s.label && !s.title) throw new Error('[ui-kit] 이름 없는 버튼은 만들 수 없다 (label 또는 title 필요)');
    const b = document.createElement('button');
    b.type = 'button';
    const iconOnly = !!s.icon && !s.label;
    b.className = ['ui-btn',
      iconOnly ? 'ui-btn-icon' : '',
      s.kind ? 'ui-btn-' + s.kind : '',
      s.size ? 'ui-btn-' + s.size : '',
      s.cls || ''].filter(Boolean).join(' ');
    if (s.id) b.id = s.id;
    if (s.title) { b.title = s.title; b.setAttribute('aria-label', s.title) }
    if (s.icon) b.appendChild(this.icon(s.icon, { fill: s.iconFill }));
    if (s.label) {
      const t = document.createElement('span');
      t.className = 'ui-btn-label';
      t.textContent = s.label;
      b.appendChild(t);
    }
    if (s.dataset) for (const k in s.dataset) if (s.dataset[k] != null) b.dataset[k] = s.dataset[k];
    if (s.disabled) b.disabled = true;
    if (s.onClick) b.addEventListener('click', s.onClick);
    return b;
  },

  /**
   * FR-UIK-24: 탭 버튼 하나. 필드 이름은 `SB_TAB_DEFS` 의 서술자와 같다 —
   * 두 어휘를 만들지 않는다 (FR-SBT-19).
   */
  tab(spec) {
    const s = spec || {};
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.className = ['ui-tab', s.active ? 'active' : '', s.cls || ''].filter(Boolean).join(' ');
    b.setAttribute('aria-selected', s.active ? 'true' : 'false');
    if (s.id) b.dataset.panel = s.id;
    if (s.title) b.title = s.title;
    // 아이콘은 스프라이트 이름이 원칙이고, 이름이 없으면 글자 하나로 떨어진다
    // (`SB_TAB_DEFS` 의 "필드가 없으면 라벨의 첫 글자" 규약, FR-SBC-13).
    if (s.icon || s.iconText) {
      const w = document.createElement('span');
      w.className = ['ui-tab-icon', s.iconCls || ''].filter(Boolean).join(' ');
      if (s.icon) w.appendChild(this.icon(s.icon));
      else w.textContent = s.iconText;
      b.appendChild(w);
    }
    if (s.label) {
      const l = document.createElement('span');
      l.className = ['ui-tab-label', s.labelCls || ''].filter(Boolean).join(' ');
      l.textContent = s.label;
      b.appendChild(l);
    }
    const g = document.createElement('span');
    g.className = ['ui-tab-badge', s.badgeCls || ''].filter(Boolean).join(' ');
    g.hidden = !(s.badge > 0);
    if (s.badge > 0) g.textContent = String(s.badge);
    b.appendChild(g);
    if (s.onClick) b.addEventListener('click', s.onClick);
    return b;
  },

  /**
   * FR-UIK-25: 오버레이 + 상자. 닫는 길 셋(닫기 버튼·바깥 클릭·Esc)이 **같은
   * onClose 로 간다** — 지금까지 셋 중 둘만 있는 상자가 있었다.
   *
   * 돌려주는 것은 `{el, close}` 다. 붙이고 지우는 것은 부르는 쪽의 일이다.
   */
  modal(spec) {
    const s = spec || {};
    const ov = document.createElement('div');
    ov.className = ['ui-modal', s.cls || ''].filter(Boolean).join(' ');
    const box = document.createElement('div');
    box.className = 'ui-modal-box';
    if (s.width) box.style.width = s.width;
    ov.appendChild(box);

    const head = document.createElement('div');
    head.className = 'ui-modal-head';
    const t = document.createElement('span');
    t.className = 'ui-modal-title';
    t.textContent = s.title || '';
    head.appendChild(t);
    const sp = document.createElement('span');
    sp.className = 'ui-modal-spacer';
    head.appendChild(sp);
    box.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ui-modal-body';
    if (s.body) body.appendChild(s.body);
    box.appendChild(body);

    let foot = null;
    if (s.actions && s.actions.length) {
      foot = document.createElement('div');
      foot.className = 'ui-modal-foot';
      box.appendChild(foot);
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      if (s.onClose) s.onClose();
    };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close() } };
    document.addEventListener('keydown', onKey, true);
    head.appendChild(this.button({ icon: 'x', title: s.closeTitle || 'Close', kind: 'ghost', cls: 'ui-modal-close', onClick: close }));
    ov.addEventListener('mousedown', e => { if (e.target === ov) close() });
    /**
     * FR-PDA-1·11: 목적 버튼은 **기제가 정한다** — `kind` 가 `primary` 또는
     * `danger` 인 마지막 action 이고, 없으면 마지막 action 이다.
     *
     * 종전에는 호출자가 `foot.querySelector()` 로 찾아 `focus()` 했고, 그래서
     * **두 호출자 중 하나에만** 있었다 (`open-url` 에는 있고 ACL 경고에는
     * 없었다). 여기 두면 앞으로 생길 호출자도 자동으로 덮인다.
     *
     * 붙기 전에는 `focus()` 가 아무 일도 하지 않는다 — 호출자가 `el` 을 붙이는
     * 것은 이 함수가 돌아간 **뒤**다. 그래서 다음 프레임에 준다. 호출자에게
     * `focusDefault()` 를 부르게 하면 그것이 곧 종전의 "호출자마다 각자" 이고,
     * 한 자리가 빠지는 것이 지금 고치는 결함이다.
     */
    let primary = null, last = null;
    for (const a of (s.actions || [])) {
      const b = this.button(Object.assign({}, a, {
        onClick: () => { if (!a.keepOpen) close(); if (a.onClick) a.onClick() },
      }));
      foot.appendChild(b);
      last = b;
      if (a.kind === 'primary' || a.kind === 'danger') primary = b;
    }
    const defBtn = primary || last;
    if (defBtn) {
      TIMERS.frame(() => { if (defBtn.isConnected && !closed) defBtn.focus() },
        { label: 'modal-focus' });
    }
    return { el: ov, box, body, foot, close, defBtn };
  },

  /**
   * FR-UIK-26: 드롭다운·컨텍스트 메뉴.
   *
   * 닫는 규약은 `GitMenu` 가 쓰던 것을 옮긴 것이다 — 바깥 `mousedown`(캡처)·
   * `Esc`·스크롤. 한 번에 하나만 열린다.
   *
   * items: {label, icon, onClick, disabled, danger} | {sep:true} | {el:<HTMLElement>}
   */
  menu(items, opts) {
    const o = opts || {};
    this.closeMenu();
    const m = document.createElement('div');
    m.className = ['ui-menu', o.cls || ''].filter(Boolean).join(' ');
    for (const it of (items || [])) {
      if (!it) continue;
      if (it.sep) { const d = document.createElement('div'); d.className = 'ui-menu-sep'; m.appendChild(d); continue }
      if (it.el) { m.appendChild(it.el); continue }
      if (it.label != null && it.static) {
        const d = document.createElement('div'); d.className = 'ui-menu-label'; d.textContent = it.label; m.appendChild(d); continue;
      }
      const d = document.createElement('div');
      d.className = ['ui-menu-item', it.disabled ? 'disabled' : '', it.danger ? 'danger' : ''].filter(Boolean).join(' ');
      if (it.icon) d.appendChild(this.icon(it.icon, { size: 'sm' }));
      const l = document.createElement('span');
      l.textContent = it.label || '';
      d.appendChild(l);
      if (it.title) d.title = it.title;
      if (!it.disabled && it.onClick) d.addEventListener('click', () => { UIKit.closeMenu(); it.onClick() });
      m.appendChild(d);
    }
    document.body.appendChild(m);
    // 자리는 붙인 뒤에 잡는다 — 크기를 알아야 화면 밖으로 나가지 않게 밀 수 있다.
    const at = o.at || { x: 0, y: 0 };
    const r = m.getBoundingClientRect();
    let x = at.x, y = at.y;
    if (o.align === 'right') x = at.x - r.width;
    if (x + r.width > innerWidth - 4) x = innerWidth - r.width - 4;
    if (y + r.height > innerHeight - 4) y = Math.max(4, at.y - r.height - (o.flipGap || 0));
    m.style.left = Math.max(4, x) + 'px';
    m.style.top = Math.max(4, y) + 'px';
    this._menu = m;
    this._menuOff = e => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && m.contains(e.target)) return;
      UIKit.closeMenu();
    };
    /**
     * `Esc` 는 **즉시** 걸고, 바깥 `mousedown` 만 다음 태스크로 미룬다.
     *
     * 미루는 이유는 하나뿐이다 — 이 메뉴를 연 그 클릭의 `mousedown` 이 아직
     * 전파 중이면 메뉴가 뜨자마자 자기 자신을 닫는다. 그 사유는 키에는 없다:
     * `Esc` 로 메뉴를 여는 길이 없으므로 방금의 키가 이 리스너를 깨울 수 없다
     * (전파 중에 같은 노드·같은 단계에 더한 리스너는 그 이벤트에 불리지 않는다).
     *
     * 둘을 함께 미뤘더니 **메뉴가 뜬 뒤 한 태스크 동안 `Esc` 가 죽어 있었다.**
     * 그 사이의 `Esc` 는 아무 일도 하지 않고, 한 번 놓친 키는 다시 오지 않으므로
     * 메뉴가 열린 채로 남는다 — e2e 가 그 창을 실제로 맞았고(H14 · F9), 빠르게
     * 누르는 사용자도 같은 창을 맞는다.
     */
    document.addEventListener('keydown', UIKit._menuOff, true);
    TIMERS.defer(() => {
      document.addEventListener('mousedown', UIKit._menuOff, true);
    }, { label: 'ui-menu-open' });
    return m;
  },

  closeMenu() {
    if (!this._menu) return;
    document.removeEventListener('mousedown', this._menuOff, true);
    document.removeEventListener('keydown', this._menuOff, true);
    if (this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
    this._menu = null;
    this._menuOff = null;
  },

  menuOpen() { return !!this._menu },

  // FR-UIK-27: 설정 행 하나. `.ds-row` 의 구조와 1:1 이다.
  field(spec) {
    const s = spec || {};
    const row = document.createElement('div');
    row.className = ['ui-field', s.cls || ''].filter(Boolean).join(' ');
    const l = document.createElement('span');
    l.className = 'ui-field-label';
    l.textContent = s.label || '';
    row.appendChild(l);
    if (s.control) row.appendChild(s.control);
    if (!s.hint) return row;
    const wrap = document.createElement('div');
    wrap.appendChild(row);
    const h = document.createElement('div');
    h.className = 'ui-hint';
    h.textContent = s.hint;
    wrap.appendChild(h);
    return wrap;
  },

  // ── 핸들 (FR-HSZ-1~11) ──────────────────────────────────────────────

  /**
   * FR-HSZ-1: 크기 조절 핸들 하나의 제스처.
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
  drag(handle, opts) {
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
          UIKit._hud(o.axis, pt.x, pt.y, o.sides(ctx, pt));
        }, { owner: 'ui-kit', coalesce: 'size-hud' });
      };
      const mv = ev => { pt = { x: ev.clientX, y: ev.clientY }; if (o.move) o.move(ctx, ev); paint() };
      const up = ev => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        if (frame) { TIMERS.cancel(frame); frame = null }
        UIKit._hudHide();
        if (o.end) o.end(ctx, ev);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      paint();
    });
  },

  // FR-HSZ-2·8: 문서에 하나뿐인 겹. 만들고 지우지 않는다 (D-10).
  _hudEl() {
    let el = document.getElementById('ui-size-hud');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ui-size-hud';
    el.innerHTML = '<div class="ui-size-box"></div><div class="ui-size-box"></div>';
    document.body.appendChild(el);
    return el;
  },

  _hud(axis, px, py, sides) {
    if (!sides || sides.length !== 2) return;
    const el = this._hudEl();
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
      x = Math.min(Math.max(x, 48), innerWidth - 48);
      y = Math.min(Math.max(y, 28), innerHeight - 28);
      b.style.left = x + 'px';
      b.style.top = y + 'px';
    }
    el.classList.add('on');
  },

  _hudHide() {
    const el = document.getElementById('ui-size-hud');
    if (el) el.classList.remove('on');
  },

  /**
   * FR-HSZ-5·9: 지금 화면의 **셀 크기**. 드래그 시작에서 한 번 잰다.
   *
   * **fit 을 돌리지 않는다** — 끄는 동안의 fit 은 SIGWINCH 를 이벤트 수만큼
   * 내보내고 TUI 가 매번 프레임 전체를 다시 그린다 (FR-MTI-12 와 같은 근거).
   * 대신 지금의 셀 크기로 새 칸 수를 **계산한다**.
   *
   * 터미널이 아니거나 아직 그려지지 않았으면 `null` — 부르는 쪽은 그때 그 줄을
   * 적지 않는다 ("모른다" 를 0 으로 적지 않는다).
   */
  cellSize(term, el) {
    if (!term || !term.cols || !term.rows || !el) return null;
    const screen = el.querySelector('.xterm-screen');
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return { w: r.width / term.cols, h: r.height / term.rows };
  },

  // 셀 크기와 픽셀 크기에서 `C×R`. 셀을 재지 못했으면 빈 문자열이다.
  /**
   * FR-HSZ-5·9: 어떤 영역이 **터미널이면** 거기서 예상되는 `C×R`.
   *
   * 끄는 동안 fit 을 돌리지 않는다 — SIGWINCH 가 이벤트 수만큼 나가고 TUI 가
   * 매번 프레임 전체를 다시 그린다 (FR-MTI-12 와 같은 근거). 그래서 이 값은
   * **예상값**이다.
   *
   * 셀 크기는 폭·높이와 무관하므로 지금 값이 그대로 유효하다. 반면
   * `.xterm-screen` 은 fit 이 돌기 전까지 **옛 크기**이므로, 그 크기에 이 칸이
   * 얻거나 잃을 양(`dw`·`dh`)을 더해서 나눈다.
   *
   * 터미널이 아니면 빈 문자열이다 — 없는 값을 0 으로 적지 않는다 (FR-HSZ-5).
   */
  grid(pane, axis, dw, dh) {
    if (!pane || !pane.term || !pane.el) return '';
    const scr = pane.el.querySelector('.xterm-screen');
    if (!scr) return '';
    const cell = this.cellSize(pane.term, pane.el);
    if (!cell) return '';
    const r = scr.getBoundingClientRect();
    return this.cellFit(cell, axis, r.width + (dw || 0), r.height + (dh || 0));
  },
  /**
   * FR-HSZ-4a (2026-09-08 개정): **끄는 축의 값만 낸다.**
   *
   *   이전 동작: 언제나 `C×R`
   *   새  동작: 가로 핸들이면 `NN cols`, 세로 핸들이면 `NN rows`
   *   이유:     같은 상자의 `px` 와 `%` 는 **끌어서 바뀌는 값**인데 가운데 줄만
   *             축 밖의 값을 함께 실었다. 가로 핸들에서 rows 는 아무리 끌어도
   *             변하지 않으므로, 변하지 않는 숫자가 변하는 숫자들 사이에 앉아
   *             있었다 (사용자 지적). 세 줄이 한 축을 말해야 상자가 한 가지를
   *             말한다.
   *
   * 단위를 붙이는 이유는 숫자 하나만 남으면 그것이 무엇인지 알 수 없기 때문이다 —
   * `71×33` 은 표기가 곧 설명이었지만 `71` 은 아니다.
   */
  cellFit(cell, axis, w, h) {
    if (!cell || !(cell.w > 0) || !(cell.h > 0)) return '';
    if (axis === 'y') return Math.max(1, Math.floor(h / cell.h)) + ' rows';
    return Math.max(1, Math.floor(w / cell.w)) + ' cols';
  },
};
