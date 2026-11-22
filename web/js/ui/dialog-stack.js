/**
 * DialogStack — 대화상자 스택: 접근성 계약 (REFACTOR3_FE_REST5_SRS FR-FR5-21 — 옛 `UIKit._dlg*`·`dialogOpen`·`_focusMaybeQuiet`).
 *
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
 * `Escape` 는 이 스택이 아니라 `EscapeStack` 이 맨 위 하나에만 준다 — 대화상자는
 * 열 때 그 스택에 넣는다(REFACTOR3_FE_ESC_SRS FR-FEE-4). 킷 모달은 **캡처** 층이고
 * 설정 모달은 **버블** 층이라, 안쪽 킷 모달이 먼저 먹는다 (`TC-A11Y-9`·FR-OPT-16-4).
 *
 * ## 왜 `Tab` 을 캡처에서 잡나
 *
 * 트랩은 **다른 누가 처리하기 전에** 걸려야 한다. 그리고 리스너는 하나다 —
 * 모달마다 하나씩 달면 중첩에서 둘이 같은 키를 두 번 처리한다.
 *
 * `UIKit.dialogOpen` 은 이것에 맡기는 입구로 남고(`UIKit.menu`→`Menu` 와 같은 꼴), `UIKit._dlgStack` 은 이 스택을 가리키는
 * 접근자로 남는다(`dialog.js` 가 맨 위를 읽는다). 포인터 입력 표식(`UIKit._ptrInput`)은 킷 파일 끝의 수신기가 적는다.
 */
class DialogStack {
  /** 상자 안에서 `Tab` 이 닿을 수 있는 것들. 보이지 않는 것은 닿지 않는다. */
  static focusables(box) {
    const sel = 'a[href],button,input,select,textarea,summary,[tabindex]';
    return [...box.querySelectorAll(sel)].filter((e) => {
      if (e.disabled || e.getAttribute('tabindex') === '-1') return false;
      // `.mpanel` 은 `[hidden]` 으로 숨으므로 상자를 뜨지 않아도 걸러진다.
      return e.getClientRects().length > 0;
    });
  }

  static onKey(e) {
    if (e.key !== 'Tab') return;
    const st = DialogStack.stack;
    const top = st[st.length - 1];
    if (!top || !top.box.isConnected) return;
    const f = DialogStack.focusables(top.box);
    if (!f.length) { e.preventDefault(); top.box.focus(); return }
    const a = document.activeElement;
    const inside = top.box.contains(a);
    const first = f[0], last = f[f.length - 1];
    // 밖에 있으면 방향에 맞는 끝으로 데려온다 — 바깥에서 들어오는 `Tab` 도 트랩의
    // 일이다. 안에 있으면 경계에서만 감싼다.
    if (e.shiftKey && (!inside || a === first)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && (!inside || a === last)) { e.preventDefault(); first.focus() }
  }

  /**
   * 상자를 모달로 연다. 돌려주는 것은 **닫을 때 부를 함수** 하나다.
   *
   * spec: `{labelledBy, label, returnTo, focus}`
   *   labelledBy  이름을 주는 요소(또는 상자 안의 선택자). id 가 없으면 붙여 준다.
   *   label       이름을 줄 요소가 없을 때의 `aria-label`.
   *   returnTo    닫을 때 포커스를 돌려줄 자리. 기본은 **여는 순간의 포커스**.
   *   focus       열 때 포커스를 줄 자리. 기본은 첫 번째로 닿을 수 있는 것.
   */
  static open(box, spec) {
    const s = spec || {};
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    // **이름이 뜻을 가져야 한다.** `aria-labelledby` 가 빈 요소를 가리키면 접근
    // 이름은 여전히 없고, axe 도 그것을 잡지 못한다 (`TC-A11Y-8a` 가 글자를 본다).
    const labelEl = typeof s.labelledBy === 'string' ? box.querySelector(s.labelledBy) : s.labelledBy;
    if (labelEl && (labelEl.textContent || '').trim()) {
      if (!labelEl.id) labelEl.id = 'ui-dlg-title-' + (++DialogStack.seq);
      box.setAttribute('aria-labelledby', labelEl.id);
    } else if (s.label) {
      box.setAttribute('aria-label', s.label);
    }
    // 상자 자신이 포커스를 받을 수 있어야 한다 — 안에 닿을 것이 없는 모달도 있다.
    if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');

    if (!DialogStack.bound) {
      document.addEventListener('keydown', DialogStack.onKey, true);
      DialogStack.bound = true;
    }
    // FR-UXF-4: 포인터로 열었으면 열 때·닫을 때 스크립트가 주는 포커스는 링을 그리지 않는다.
    const entry = { box, returnTo: s.returnTo || document.activeElement, quiet: UIKit._ptrInput };
    DialogStack.stack.push(entry);

    /**
     * 포커스는 **다음 프레임**에 준다. 부르는 쪽이 상자를 붙이는 것은 이 함수가
     * 돌아간 뒤이고, 붙기 전의 `focus()` 는 아무 일도 하지 않는다 (`modal()` 의
     * 기존 주석이 같은 이유를 적어 뒀다).
     */
    TIMERS.frame(() => {
      if (!box.isConnected) return;
      // 그 사이 창 안으로 포커스가 이미 들어왔으면(부른 쪽이 먼저 줬거나 사용자가 옮겼다)
      // 덮지 않는다 — 느린 기기에서 취소로 옮긴 포커스가 실행으로 되돌아갔다(CI 실측).
      const cur = document.activeElement;
      if (cur && cur !== box && box.contains && box.contains(cur)) return;
      const want = s.focus && s.focus.isConnected ? s.focus : DialogStack.focusables(box)[0];
      DialogStack.focusQuiet(want || box, entry.quiet);
    }, { label: 'dialog-focus' });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const i = DialogStack.stack.indexOf(entry);
      if (i >= 0) DialogStack.stack.splice(i, 1);
      // **돌아갈 자리가 아직 있는가**를 본다. 없으면 아무 데도 주지 않는다 —
      // 사라진 요소에 `focus()` 하면 포커스가 `<body>` 로 떨어지고, 그러면 다음
      // `Tab` 이 문서 맨 앞에서 시작한다.
      const r = entry.returnTo;
      if (r && r.isConnected && typeof r.focus === 'function') DialogStack.focusQuiet(r, entry.quiet);
    };
  }

  /**
   * FR-UXF-4: 포커스의 **자리**는 그대로 두고 링만 끈다. 표식(`.ui-focus-quiet`)은 포커스를 잃거나
   * 키를 누르면 걷힌다 — 키보드 사용자의 링은 종전과 같다.
   */
  static focusQuiet(el, quiet) {
    if (quiet && el.classList) {
      el.classList.add('ui-focus-quiet');
      el.addEventListener('blur', () => el.classList.remove('ui-focus-quiet'), { once: true });
    }
    el.focus();
  }
}
/** 열린 대화상자 — 맨 뒤가 맨 위다. */
DialogStack.stack = [];
DialogStack.seq = 0;
DialogStack.bound = false;
