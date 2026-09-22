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
    container.addEventListener('keydown', (e) => {
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
    });
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

  /**
   * ACCESSIBILITY_BASELINE_SRS FR-A11Y-18 (`UX-3`) — **모달의 접근성 계약이 한
   * 자리에 있다.**
   *
   * 이것이 골격 수렴(`UX-16` 의 나머지)과 **다른 일**인 것이 요점이다. 요구는
   * "일곱 모달이 같은 DOM 을 쓴다" 가 아니라 "열면 포커스가 안으로 들어가고 `Tab`
   * 이 밖으로 나가지 않으며 닫으면 연 컨트롤로 돌아간다" 다. 그것은 **컨테이너
   * 하나를 받는 함수**로 충분하고, 그래서 골격이 일곱이어도 계약은 한 벌이다.
   *
   * ## 왜 스택인가
   *
   * 중첩이 실재한다 — 설정 모달의 Access 탭에서 자기 주소를 자르는 목록을
   * 저장하면 `.acl-confirm` 이 그 위에 뜬다. `Tab` 트랩은 **맨 위 것**만 걸려야
   * 하고, 닫을 때 포커스는 **그 아래 것**으로 돌아가야 한다.
   *
   * `Escape` 순서는 여기서 다루지 않는다. 실측으로 이미 맞다: `modal()` 의
   * Escape 리스너는 **캡처**이고 `stopPropagation()` 하며, 설정 모달의 것은
   * **버블**이다 — 그래서 안쪽이 먼저 먹고 바깥은 못 받는다. 맞는 것을 옮기면
   * 옮기는 동안만 틀릴 수 있으므로 그대로 둔다 (`TC-A11Y-9` 가 고정한다).
   *
   * ## 왜 `Tab` 을 캡처에서 잡나
   *
   * 트랩은 **다른 누가 처리하기 전에** 걸려야 한다. 그리고 리스너는 하나다 —
   * 모달마다 하나씩 달면 중첩에서 둘이 같은 키를 두 번 처리한다.
   */
  _dlgStack: [],
  _dlgSeq: 0,
  _dlgBound: false,

  /** 상자 안에서 `Tab` 이 닿을 수 있는 것들. 보이지 않는 것은 닿지 않는다. */
  _dlgFocusables(box) {
    const sel = 'a[href],button,input,select,textarea,summary,[tabindex]';
    return [...box.querySelectorAll(sel)].filter((e) => {
      if (e.disabled || e.getAttribute('tabindex') === '-1') return false;
      // `.mpanel` 은 `display:none` 으로 숨으므로 상자를 뜨지 않아도 걸러진다.
      return e.getClientRects().length > 0;
    });
  },

  _dlgOnKey(e) {
    if (e.key !== 'Tab') return;
    const st = UIKit._dlgStack;
    const top = st[st.length - 1];
    if (!top || !top.box.isConnected) return;
    const f = UIKit._dlgFocusables(top.box);
    if (!f.length) { e.preventDefault(); top.box.focus(); return }
    const a = document.activeElement;
    const inside = top.box.contains(a);
    const first = f[0], last = f[f.length - 1];
    // 밖에 있으면 방향에 맞는 끝으로 데려온다 — 바깥에서 들어오는 `Tab` 도 트랩의
    // 일이다. 안에 있으면 경계에서만 감싼다.
    if (e.shiftKey && (!inside || a === first)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && (!inside || a === last)) { e.preventDefault(); first.focus() }
  },

  /**
   * 상자를 모달로 연다. 돌려주는 것은 **닫을 때 부를 함수** 하나다.
   *
   * spec: `{labelledBy, label, returnTo, focus}`
   *   labelledBy  이름을 주는 요소(또는 상자 안의 선택자). id 가 없으면 붙여 준다.
   *   label       이름을 줄 요소가 없을 때의 `aria-label`.
   *   returnTo    닫을 때 포커스를 돌려줄 자리. 기본은 **여는 순간의 포커스**.
   *   focus       열 때 포커스를 줄 자리. 기본은 첫 번째로 닿을 수 있는 것.
   */
  dialogOpen(box, spec) {
    const s = spec || {};
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    // **이름이 뜻을 가져야 한다.** `aria-labelledby` 가 빈 요소를 가리키면 접근
    // 이름은 여전히 없고, axe 도 그것을 잡지 못한다 (`TC-A11Y-8a` 가 글자를 본다).
    const t = typeof s.labelledBy === 'string' ? box.querySelector(s.labelledBy) : s.labelledBy;
    if (t && (t.textContent || '').trim()) {
      if (!t.id) t.id = 'ui-dlg-title-' + (++this._dlgSeq);
      box.setAttribute('aria-labelledby', t.id);
    } else if (s.label) {
      box.setAttribute('aria-label', s.label);
    }
    // 상자 자신이 포커스를 받을 수 있어야 한다 — 안에 닿을 것이 없는 모달도 있다.
    if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');

    if (!this._dlgBound) {
      document.addEventListener('keydown', this._dlgOnKey, true);
      this._dlgBound = true;
    }
    const entry = { box, returnTo: s.returnTo || document.activeElement };
    this._dlgStack.push(entry);

    /**
     * 포커스는 **다음 프레임**에 준다. 부르는 쪽이 상자를 붙이는 것은 이 함수가
     * 돌아간 뒤이고, 붙기 전의 `focus()` 는 아무 일도 하지 않는다 (`modal()` 의
     * 기존 주석이 같은 이유를 적어 뒀다).
     */
    TIMERS.frame(() => {
      if (!box.isConnected) return;
      const want = s.focus && s.focus.isConnected ? s.focus : this._dlgFocusables(box)[0];
      (want || box).focus();
    }, { label: 'dialog-focus' });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const i = this._dlgStack.indexOf(entry);
      if (i >= 0) this._dlgStack.splice(i, 1);
      // **돌아갈 자리가 아직 있는가**를 본다. 없으면 아무 데도 주지 않는다 —
      // 사라진 요소에 `focus()` 하면 포커스가 `<body>` 로 떨어지고, 그러면 다음
      // `Tab` 이 문서 맨 앞에서 시작한다.
      const r = entry.returnTo;
      if (r && r.isConnected && typeof r.focus === 'function') r.focus();
    };
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
    // FR-A11Y-18: 접근성 계약은 `dialogOpen` 이 갖는다. `defBtn` 을 알아야
    // 포커스를 줄 수 있으므로 아래에서 열고, 여기서는 닫을 손잡이만 잡아 둔다.
    let releaseDlg = null;
    const close = () => {
      if (closed) return;
      closed = true;
      if (releaseDlg) releaseDlg();
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
    /**
     * FR-A11Y-30 / D-A11Y-13: 액션 줄을 `←`/`→` 로도 옮긴다.
     *
     * `keepTabStops` 다 — 버튼은 **각각** 탭 정지점으로 남는다. 취소와 확인 사이를
     * `Tab` 으로 오가는 것은 오래된 관용이고, 요구는 **길을 더하는 것**이지 다른
     * 길로 바꾸는 것이 아니다.
     *
     * 비활성 버튼은 목록에서 빠진다 — 닿아도 아무 일이 없는 자리에 포커스를
     * 세우면 키보드 사용자는 그것을 고장으로 읽는다.
     */
    if (foot) {
      this.roving(foot, {
        horizontal: true,
        keepTabStops: true,
        items: () => [...foot.querySelectorAll('.ui-btn')].filter((b) => !b.disabled),
      });
    }
    const defBtn = primary || last;
    // 어느 버튼에 포커스를 주는지는 여전히 여기가 정한다(위 FR-PDA-1·11) — 옮긴
    // 것은 **주는 방법**이고, 그것이 트랩·복귀와 한 벌이어야 한다 (FR-A11Y-18).
    releaseDlg = UIKit.dialogOpen(box, { labelledBy: t, label: s.title || '', focus: defBtn });
    return { el: ov, box, body, foot, close, defBtn };
  },

  /**
   * FR-UIK-26: 드롭다운·컨텍스트 메뉴 — **한 벌**이다 (CONTEXT_MENU_UNIFY_SRS).
   *
   * `GitMenu` 가 갖던 것이 여기로 왔다 (FR-CMU-1~4): ↑↓ 이동(비활성 건너뜀,
   * 끝에서 감김) · Enter 실행 · Home/End · 비활성의 **사유가 `title`** · `cur` ·
   * `role=menu`/`menuitem`. 닫힘은 `Esc`·바깥 `mousedown`·스크롤·리사이즈.
   * 한 번에 하나만 열린다. 활성 항목이 포커스를 갖고(D-CMU-2) 닫으면 연 자리로
   * 돌아간다.
   *
   * items: {id, label, icon, onClick, disabled:boolean|string, danger, cur, title}
   *        | {sep:true} | {el:<HTMLElement>} | {label, static:true}
   * opts:  {at, align, cls, itemCls, sepCls, flipGap} — `itemCls`·`sepCls` 는 옛
   *        이름을 함께 붙이는 자리다 (D-5, `GitMenu` 의 `.git-menu-item`).
   */
  menu(items, opts) {
    const o = opts || {};
    this.closeMenu();
    const m = document.createElement('div');
    m.className = ['ui-menu', o.cls || ''].filter(Boolean).join(' ');
    m.setAttribute('role', 'menu');
    const returnTo = document.activeElement;
    for (const it of (items || [])) {
      if (!it) continue;
      if (it.sep) {
        const d = document.createElement('div');
        d.className = ['ui-menu-sep', o.sepCls || ''].filter(Boolean).join(' ');
        d.setAttribute('role', 'separator');
        m.appendChild(d); continue;
      }
      if (it.el) { m.appendChild(it.el); continue }
      if (it.label != null && it.static) {
        const d = document.createElement('div'); d.className = 'ui-menu-label'; d.textContent = it.label; m.appendChild(d); continue;
      }
      // FR-CMU-1: 문자열 disabled 는 사유다 — 색만으로는 사용자가 고장으로 읽는다.
      const why = typeof it.disabled === 'string' ? it.disabled : '';
      const off = !!it.disabled;
      const d = document.createElement('div');
      d.className = ['ui-menu-item', o.itemCls || '', off ? 'disabled' : '', it.danger ? 'danger' : '', it.cur ? 'cur' : ''].filter(Boolean).join(' ');
      d.setAttribute('role', 'menuitem');
      d.tabIndex = -1;
      if (it.id != null) d.dataset.id = it.id;
      if (it.icon) d.appendChild(this.icon(it.icon, { size: 'sm' }));
      const l = document.createElement('span');
      l.textContent = it.label || '';
      d.appendChild(l);
      if (why) d.title = why; else if (it.title) d.title = it.title;
      if (off) d.setAttribute('aria-disabled', 'true');
      if (!off && it.onClick) d.addEventListener('click', () => { UIKit.closeMenu(); it.onClick() });
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
    this._menuReturnTo = returnTo;
    /**
     * FR-CMU-2: 키 이동. 활성 가능한 항목만 돌고, 처음에는 아무것도 활성이
     * 아니다 — 첫 ↓ 가 첫 항목이다 (`GitMenu` N2 의 계약 그대로).
     */
    const live = () => [...m.querySelectorAll('.ui-menu-item:not(.disabled)')];
    const mark = el => {
      for (const x of m.querySelectorAll('.ui-menu-item')) x.classList.toggle('active', x === el);
      if (el) el.focus();
    };
    this._menuOff = e => {
      if (e.type === 'mousedown') { if (!m.contains(e.target)) UIKit.closeMenu(); return }
      if (e.type !== 'keydown') { UIKit.closeMenu(); return }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); UIKit.closeMenu(); return }
      const list = live(); if (!list.length) return;
      const cur = list.indexOf(m.querySelector('.ui-menu-item.active'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault(); e.stopPropagation();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
          : e.key === 'ArrowDown' ? (cur + 1) % list.length : (cur <= 0 ? list.length - 1 : cur - 1);
        mark(list[next]); return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const el = list[cur]; if (!el) return;
        e.preventDefault(); e.stopPropagation();
        el.click();
      }
    };
    window.addEventListener('scroll', UIKit._menuOff, true);   // FR-CMU-3
    window.addEventListener('resize', UIKit._menuOff, true);
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
    window.removeEventListener('scroll', this._menuOff, true);
    window.removeEventListener('resize', this._menuOff, true);
    const hadFocus = this._menu.contains(document.activeElement);
    if (this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
    this._menu = null;
    this._menuOff = null;
    // D-CMU-2: 키로 옮겨 온 포커스는 연 자리로 돌려준다.
    const r = this._menuReturnTo; this._menuReturnTo = null;
    if (hadFocus && r && r.isConnected && typeof r.focus === 'function') r.focus();
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
