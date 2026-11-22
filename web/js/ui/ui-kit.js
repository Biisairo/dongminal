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
   *   iconSize  아이콘 치수 (`UIKit.icon` 의 size)
   *   cls       함께 붙일 기존 클래스 (D-5)
   *
   * FR-UIK-22 (개정, OPTIMIZE_REFACTOR_SRS FR-OPT-12-3): aria-label 은 **보이는 글자(label)가
   * 없을 때만** title 에서 온다. 글자가 있으면 그 글자가 이름이다 — 영어 툴팁(FR-TIP-2)이
   * 한국어 라벨을 덮어 읽히면 보이는 것과 읽히는 것이 갈린다.
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
    if (s.title) { b.title = s.title; if (!s.label) b.setAttribute('aria-label', s.title) }
    if (s.icon) b.appendChild(this.icon(s.icon, { fill: s.iconFill, size: s.iconSize }));
    if (s.label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'ui-btn-label';
      labelEl.textContent = s.label;
      b.appendChild(labelEl);
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

  // UX_AUDIT_FIX_SRS FR-UXF-100 (D-36): 펼침 꺾쇠. 글자(`▸`·`▾`) 대신 아이콘을 다시 채우고, 상태는 `data-open` 이 말한다.
  caret(el, open) {
    if (!el) return;
    el.replaceChildren(this.icon(open ? 'chevron-down' : 'chevron-right', { size: 'sm' }));
    el.dataset.open = open ? '1' : '0';
  },

  /**
   * UX_AUDIT_FIX_SRS FR-UXF-121 (D-41): 감췄다 보이거나 떼었다 붙이는 영역의 스크롤 자리. 값은 요소에 둔다 — 그 안에 스크롤
   * 컨테이너가 몇 개인지 부르는 쪽이 알 필요가 없다. 0 으로 돌아온 자리도 적는다(옛 값으로 되돌아가지 않는다).
   */
  scrollSave(root) {
    if (root) for (const el of root.querySelectorAll('*')) if (el.scrollTop || el.__uiTop) el.__uiTop = el.scrollTop;
  },
  scrollRestore(root) {
    if (root) for (const el of root.querySelectorAll('*')) if (el.__uiTop) el.scrollTop = el.__uiTop;
  },

  /**
   * UX_AUDIT_FIX_SRS FR-UXF-98·99 (D-35): 패널 탭 줄은 라벨이 **다 들어가면** 아이콘 + 라벨(`labeled`), 하나라도 잘리면 아이콘만이다.
   * 라벨을 세운 상태에서 재므로 같은 폭에서는 늘 같은 답이다. `sel` 을 주면 `host` 안의 탭 줄을 찾는다(다시 그려지는 줄).
   */
  tabsFit(host, sel) {
    const bar = host && (sel ? host.querySelector(sel) : host);
    if (!bar) return;
    bar.classList.add('labeled');
    // 잰 라벨이 없으면(레일처럼 CSS 가 라벨을 숨긴 자리) 들어간다고 말하지 않는다.
    let seen = 0, ok = true;
    for (const l of bar.querySelectorAll('.ui-tab-label')) {
      if (!l.offsetParent) continue;
      seen++;
      if (l.scrollWidth > l.clientWidth + 1) { ok = false; break }
    }
    bar.classList.toggle('labeled', ok && seen > 0);
  },

  /**
   * ACCESSIBILITY_BASELINE_SRS FR-A11Y-16 (`UX-4`) — **목록·탭 줄의 키보드 계약이
   * 한 자리에 있다** (roving tabindex, D-A11Y-11).
   *
   * 컨테이너 하나에 리스너 하나다. 항목은 그리기마다 다시 만들어질 수 있으므로
   * (`reconcileList`) 항목에 걸지 않는다 — 탐색기가 같은 이유로 컨테이너에 건다
   * (FR-EXR-51).
   *
   * spec:
   *   items()        지금의 항목들, 보이는 순서. 컨테이너 여럿에 걸쳐도 된다
   *                  (Repo 목록의 고정 행은 다른 컨테이너에 산다)
   *   horizontal     탭 줄이면 ←→, 목록이면 ↑↓
   *   activate(el)   Enter/Space. **클릭과 같은 일**이어야 한다 (D-A11Y-12).
   *                  없으면 그 키를 흘린다 — `<button>` 은 스스로 눌린다
   *   remove(el)     Delete/Backspace. `×` 가 하는 일이다 (D-A11Y-10). 없으면 무시
   *   keepTabStops   `tabindex` 를 옮기지 않는다 (D-A11Y-13). 항목이 **각각**
   *                  탭 정지점으로 남아야 하는 자리 — 대화상자의 액션 버튼이다.
   *                  목록·탭·트리는 이것을 주지 않는다: 그쪽은 `Tab` 한 자리가
   *                  표준이다 (D-A11Y-11)
   *
   * 끝에서 감싸지 않는다 — 탐색기의 `_moveSel` 이 잡는 것과 같은 규약이다.
   */
  roving(container, spec) {
    // renderer 의 재포커스가 **키보드로 들어온** 포커스를 빼앗지 않는 표식.
    container.classList.add('kb-nav');
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      // 인라인 입력(이름 변경)의 키는 그 입력의 것이다 — `Enter` 가 확정이 아니라
      // 활성화가 되고 `Backspace` 가 글자가 아니라 **행을 지운다** (FR-EXR-55 와
      // 같은 규약; 실측으로 `V-TAN-6` 이 이렇게 빨개졌다).
      if (e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return;
      const items = spec.items();
      const cur = items.find((it) => it === e.target || it.contains(e.target));
      if (!cur) return;
      const i = items.indexOf(cur);
      const [prev, next] = spec.horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      let to = null;
      switch (e.key) {
        case next: to = items[Math.min(items.length - 1, i + 1)]; break;
        case prev: to = items[Math.max(0, i - 1)]; break;
        case 'Home': to = items[0]; break;
        case 'End': to = items[items.length - 1]; break;
        case 'Enter': case ' ':
          // 활성화를 맡은 자리가 없으면 **기본 동작이 옳다** — `<button>` 은 이
          // 두 키로 스스로 눌린다. 여기서 막으면 버튼이 죽는다.
          if (!spec.activate) return;
          e.preventDefault(); spec.activate(cur); return;
        case 'Delete': case 'Backspace':
          if (!spec.remove) return;
          e.preventDefault(); spec.remove(cur); return;
        default: return;
      }
      e.preventDefault();
      if (to && to !== cur) { if (!spec.keepTabStops) UIKit.rove(items, to); to.focus() }
    };
    container.addEventListener('keydown', onKey);
    // FR-FEB-3: 리스너를 떼는 함수를 돌려준다.
    return () => container.removeEventListener('keydown', onKey);
  },

  /**
   * `Tab` 에 닿는 항목은 **하나**다 — `current` 가 항목이면 그것, 아니면 첫 항목.
   * 그리기마다 부른다: 다시 만들어진 항목은 `tabindex=-1` 로 태어나므로 세우지
   * 않으면 목록 전체가 `Tab` 에서 사라진다.
   */
  rove(items, current) {
    const cur = current && items.includes(current) ? current : items[0];
    for (const it of items) it.tabIndex = it === cur ? 0 : -1;
  },

  /**
   * KIT_COMPONENTS_SRS FR-CMP-84 — **넘친 쪽을 흐려 잘린 것이 있음을 알린다.**
   *
   * 순수 CSS 로는 "지금 넘치는가" 를 알 수 없어 늘 흐려지고, **늘 흐리면 그것은
   * 정보가 아니라 장식이다.** 그래서 표식(`data-overflow`)을 여기서 세운다 —
   * 이 저장소가 가로축에서 이미 쓰는 방법이다 (`renderer.js` 의 `markOverflow`,
   * UX-24).
   *
   * 스크롤·크기 변화 둘 다에 반응해야 한다: 탭을 옮기면 스크롤은 그대로인데
   * 내용 높이가 바뀐다. `ResizeObserver` 는 **내용**도 봐야 하므로 자식까지 건다.
   *
   * 돌려주는 것은 **끊는 함수**다. 안 끊으면 관찰자가 남는다 (`renderer.js` 의
   * 미수거 `ResizeObserver` 가 성능 목록 P-6 에 올라 있다 — 같은 자리를 만들지
   * 않는다).
   */
  fadeWatch(el) {
    if (!el) return () => {};
    el.classList.add('ui-fade-y');
    const mark = () => {
      const top = el.scrollTop > 0;
      // 1px 여유는 소수점 높이의 반올림 때문이다 — 없으면 안 넘치는 표면이
      // 회차마다 깜빡인다.
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      const v = top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : '';
      if (v) el.dataset.overflow = v; else delete el.dataset.overflow;
    };
    el.addEventListener('scroll', mark, { passive: true });
    const ro = new ResizeObserver(mark);
    const watch = () => { ro.disconnect(); ro.observe(el); for (const c of el.children) ro.observe(c) };
    watch();
    /**
     * 자식이 갈리는 것도 본다. 설정 모달은 탭마다 **패널을 갈아 끼우므로**,
     * 처음 본 자식만 관찰하면 탭을 옮겨도 아무 일이 나지 않는다 (첫 판이 그랬다).
     * `attributes` 까지 보는 것은 패널을 지우지 않고 `hidden` 으로 감추는 자리가
     * 있기 때문이다.
     */
    const mo = new MutationObserver(() => { watch(); mark() });
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    mark();
    return () => { el.removeEventListener('scroll', mark); ro.disconnect(); mo.disconnect() };
  },

  // 대화상자 스택과 그 접근성 계약은 `DialogStack`(`ui/dialog-stack.js`)이다 (REFACTOR3_FE_REST5_SRS FR-FR5-21).
  // 이 둘은 기존 호출처를 위한 입구다 — `dialog.js` 가 `_dlgStack` 의 맨 위를 읽고, 시험이 `dialogOpen` 을 갈아 끼운다.
  get _dlgStack() { return DialogStack.stack },
  /** UX_AUDIT_FIX_SRS FR-UXF-4: 마지막 입력이 포인터였는가 — 문서 끝의 두 수신기가 적는다. */
  _ptrInput: false,
  dialogOpen(box, spec) { return DialogStack.open(box, spec) },

  /**
   * FR-UIK-25: 오버레이 + 상자. 본체는 `KitModal`(`ui/kit-modal.js`)이다 (REFACTOR3_FE_DIALOG_SRS FR-FED-8) —
   * 이 이름은 기존 호출처를 위한 입구로 남는다. 돌려주는 것은 `{el, box, body, foot, close, defBtn}` 이다.
   */
  modal(spec) {
    return new KitModal(spec).open();
  },

  /**
   * FR-OPT-11-5 (FEC-27): 머리 없는 확인·알림 상자. 고른 버튼의 `value` 로 풀리는
   * 약속을 돌려준다 — Escape·바깥 클릭은 `escValue` 다.
   *
   * spec: `{msg | body, labelledBy, label, cls, actions, escValue, focus, onOpen}`
   *   msg     본문 글자 (`textContent` — 마크업으로 해석되지 않는다). `.confirm-msg` 가 된다
   *   body    글자 대신 세운 본문. 이름을 줄 요소는 `labelledBy` 로 준다
   *   onOpen  `(m, done)` — 붙인 뒤 부른다. `done(v)` 는 그 값으로 닫는다
   *
   * 옛 골격의 클래스(`.confirm-overlay`·`.confirm-box`·`.confirm-btns`)는 그대로 붙는다 —
   * 모양과 e2e 선택자가 그것을 딛는다. `returnTo` 는 부르는 순간의 포커스다 (FR-KIT-24).
   */
  ask(spec) {
    const s = spec || {};
    const returnTo = document.activeElement;
    let body = s.body, lab = s.labelledBy;
    if (!body) {
      body = document.createElement('div');
      body.className = 'confirm-msg';
      body.textContent = s.msg == null ? '' : String(s.msg);
      lab = lab || body;
    }
    return new Promise((resolve) => {
      const m = this.modal({
        head: false, cls: ['confirm-overlay', s.cls || ''].filter(Boolean).join(' '),
        boxCls: ['confirm-box', s.boxCls || ''].filter(Boolean).join(' '),
        bodyCls: 'confirm-body', footCls: ['confirm-btns', s.footCls || ''].filter(Boolean).join(' '),
        body, labelledBy: lab, label: s.label || s.msg || '', returnTo, focus: s.focus,
        actions: s.actions,
        onClose: (v) => resolve(v === undefined ? s.escValue : v),
      });
      document.body.appendChild(m.el);
      // 목적 버튼은 붙인 즉시 포커스를 받는다 — 여는 즉시 `Enter` 를 치는 손이 있다.
      const want = s.focus || m.defBtn;
      if (want) want.focus();
      if (s.onOpen) s.onOpen(m, (v) => m.close(v));
    });
  },

  /**
   * FR-UIK-26: 드롭다운·컨텍스트 메뉴. 본체는 `Menu`(`ui/menu.js`)다 (REFACTOR3_FE_ESC_SRS FR-FEE-3) —
   * 세 이름은 기존 호출처를 위한 입구로 남는다. `menu()` 는 메뉴 요소를 돌려준다.
   */
  menu(items, opts) {
    return Menu.open(items, opts).el;
  },

  closeMenu() {
    Menu.close();
  },

  get _menu() {
    return Menu._cur ? Menu._cur.el : null;
  },

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
   * FR-HSZ-1: 크기 조절 핸들 하나의 제스처. 본체는 `SizeDrag`(`ui/size-drag.js`)이고 끄는 동안의 크기 표시는
   * `SizeHud`(`ui/size-hud.js`)다 (REFACTOR3_FE_REST3_SRS FR-FR3-15) — 이 이름은 기존 호출처를 위한 입구로 남는다.
   */
  drag(handle, opts) {
    SizeDrag.bind(handle, opts);
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

// UX_AUDIT_FIX_SRS FR-UXF-4: 입력 방식을 적는다. 키를 누르면 링을 끈 표식을 걷는다 — 다음 포커스부터 링이 선다.
// 단위 시험 하네스의 `document` 에는 수신기가 없다 — 그때는 적지 않는다.
if (typeof document.addEventListener === 'function') {
  document.addEventListener('pointerdown', () => { UIKit._ptrInput = true }, true);
  document.addEventListener('keydown', () => {
    UIKit._ptrInput = false;
    const a = document.activeElement;
    if (a && a.classList) a.classList.remove('ui-focus-quiet');
  }, true);
}
