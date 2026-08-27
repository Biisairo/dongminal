# 모바일 TUI 스크롤·입력 결함 분석

대상 증상 (사용자 보고):
1. 모바일에서 TUI(Claude Code)를 쓰면 **스크롤이 안 먹힌다**.
2. 모바일에서 TUI를 쓰면 **글자 입력이 계속 씹히거나 이상하게 쳐진다**.

이 문서는 원인 규명만 한다. 수정 스펙은 별도.

---

## 0. 측정 환경

- 워크트리: `.claude/worktrees/mobile-scroll-analysis`
- 측정 수단: Pixel 7 / `hasTouch:true` 프로젝트(`mobile-touch`)에서 CDP 터치 이벤트와
  `TerminalTool._send` 후킹. 아래 수치는 그 관측값이다.
- 교정 후의 회귀 검증은 `e2e/mobile-tui-input-touch.spec.ts` / `e2e/mobile-tui-input.spec.ts`
  (`MOBILE_TUI_INPUT_SCROLL_SRS` §4)가 담당한다.
- xterm.js: `web/vendor/xterm.js` (v5 계열, `cancelEvents` 기본 false)

### 0.1 Claude Code TUI 가 실제로 켜는 터미널 모드 (실측)

PTY 로 `claude` 를 띄워 초기 출력 1216 B 를 캡처한 결과:

| 모드 | 값 |
|---|---|
| `?2004h` bracketed paste | **on** |
| `?1004h` focus reporting | **on** |
| `?2031h` unicode core | **on** |
| `?1049h` alternate screen | **off** |
| `?1000/1002/1003/1006h` 마우스 리포팅 | **off (전부)** |

→ 두 가지가 확정된다.
- Claude Code 는 **alt screen 을 쓰지 않는다** — 스크롤백이 존재하므로 원리상 스크롤 가능하다.
- Claude Code 는 **마우스 리포팅을 켜지 않는다** — 즉 `coreMouseService.areMouseEventsActive === false` 이고,
  xterm 의 터치 스크롤 경로가 살아 있다. (진단 로그의 `mouseEventsActive:false` 로 브라우저에서도 확인)

이 실측이 중요한 이유: "마우스 리포팅 때문에 터치가 죽는다" 는 흔한 가설이 **이 경우엔 오답**이다.

---

## 1. 스크롤

### 1.1 xterm 의 터치 스크롤 구현 (`web/vendor/xterm.js`)

```js
// Terminal._bindMouse
el.addEventListener('touchstart', e => {
  if (!coreMouseService.areMouseEventsActive) return viewport.handleTouchStart(e), this.cancel(e)
}, { passive: true })
el.addEventListener('touchmove', e => {
  if (!coreMouseService.areMouseEventsActive) return viewport.handleTouchMove(e) ? void 0 : this.cancel(e)
}, { passive: false })

// Viewport
handleTouchStart(e) { this._lastTouchY = e.touches[0].pageY }
handleTouchMove(e) {
  const d = this._lastTouchY - e.touches[0].pageY
  this._lastTouchY = e.touches[0].pageY
  return d !== 0 && (this._viewportElement.scrollTop += d, this._bubbleScroll(e, d))
}
```

**관성(fling/momentum)이 없다.** 손가락 이동 픽셀만큼 `scrollTop` 을 1:1 로 더하고, 손을 떼면 즉시 멈춘다.

### 1.2 실측 (DIAG-1)

300 줄 출력 후 `.xterm-screen` 중앙에서 아래로 200 px 드래그:

```
before: viewportY=266 baseY=266 rows=37 scrollTop=5066 clientHeight=705
after : viewportY=255 baseY=266 rows=37 scrollTop=4866
delta : viewportY -11,  scrollTop -200
```

→ 터치 스크롤 자체는 **동작한다**. 그러나 **200 px 드래그 = 11 행**. 화면이 37 행이므로
한 화면을 되감으려면 화면 높이의 3.4 배를 끌어야 한다. 관성도 없다.
실기기에서 이것은 "스크롤이 안 먹힌다" 로 체감된다 — 기능 부재가 아니라 **이득(gain) 부족 + 관성 부재**다.

비교: 데스크톱 휠은 `getLinesScrolled()` 에서 `scrollSensitivity` / `fastScrollSensitivity` 배율과
`DOM_DELTA_PIXEL → 행` 환산을 거친다. **터치 경로에는 그 배율 계층이 아예 없다.**

### 1.3 리사이즈가 스크롤 위치를 흔든다 (DIAG-2)

50 행 위로 스크롤한 뒤, 소프트 키보드 등장과 같은 경로(뷰포트 축소 + `doFit()`)를 실행:

```
scrolled-up: viewportY=216 baseY=266 rows=37 clientHeight=705
after-fit  : viewportY=234 baseY=284 rows=19 clientHeight=362
```

→ `rows 37 → 19`, 보던 위치가 **18 행 어긋난다**. 키보드가 뜨고 내릴 때마다 발생한다.

### 1.4 TUI 재렌더 자체는 무해 (DIAG-3)

Ink 식 재렌더(커서를 위로 올려 `\x1b[0J` 로 지우고 다시 쓰기)를 20 회 반복해도
`viewportY=226`, `scrollTop=4305` 가 **완전히 유지**된다. 즉 "TUI 출력이 스크롤을 되돌린다" 는 원인이 아니다.

### 1.5 리사이즈 폭주 경로 (코드 근거)

`web/js/core/app-mobile.js` `_initMobileKeybar()` 내부:

```js
vv.addEventListener('resize', apply);
vv.addEventListener('scroll', apply);   // ← 디바운스 없음
...
const apply = () => {
  ...
  document.body.style.paddingTop = vv.offsetTop + 'px';        // 레이아웃 변경
  document.body.style.paddingBottom = (kbH + kbH_PX()) + 'px'; // 레이아웃 변경
  for (const p of this.tools.values()) { if (p.el.classList.contains('vis')) p.doFit() }  // 매회 fit
}
```

- `visualViewport.scroll` 은 WebKit 이 캐럿을 드러내려 뷰포트를 밀 때마다 **연속 발화**한다.
  그때마다 보이는 모든 pane 에 `fit()` → `term.resize()` → `onResize` → **RESIZE 프레임 전송 → PTY SIGWINCH**.
- `apply()` 가 `body` padding 을 바꾸므로 레이아웃이 변하고, 그것이 다시 vv 이벤트를 부를 수 있다(피드백).
- 같은 일을 하는 두 번째 경로가 `web/js/core/main.js` 의 `window resize` 핸들러에도 있다 (역시 디바운스 없음).

`web/js/ui/term-pane.js` 의 `onResize` 는 스로틀·병합이 없다. 즉 SIGWINCH 가 이벤트 수만큼 그대로 나간다.

### 1.6 스크롤 결론

| 원인 | 확정도 | 영향 |
|---|---|---|
| 터치 스크롤에 감도 배율·관성이 없다 (`scrollTop += dy` 1:1) | **실측 확정** | 주원인 |
| 키보드 등장/캐럿 추적마다 `doFit()` → rows 급변 → 보던 위치 어긋남 | **실측 확정**(리사이즈 영향) + 코드 확정(폭주 경로) | 부원인 |
| 마우스 리포팅으로 터치가 죽는다 | **반증됨** (Claude Code 는 안 켬) | — |
| TUI 재렌더가 스크롤을 되돌린다 | **반증됨** | — |

미확정으로 남는 실기기 요소 두 개(측정 환경에서 재현 불가):
- CDP 합성 터치는 브라우저의 **합성 마우스 이벤트**를 만들지 않는다. 실기기에서는 터치 드래그가
  xterm `SelectionService`(마우스 리포팅 off 이므로 enable 상태)의 텍스트 선택을 함께 발동시켜
  스크롤 대신 선택이 걸릴 수 있다. `cancelEvents` 가 false 이므로 `cancel(e)` 는 no-op 이고 이를 막지 않는다.
- 소프트 키보드가 실제로 떠 있는 상태의 vv 이벤트 빈도.

---

## 2. 입력

### 2.1 실제 전송 담당자는 `_inputEvent` 가 아니라 `CompositionHelper`

모바일 소프트 키보드는 `keydown(keyCode=229, key='Unidentified')` → `input(insertText)` 를 보낸다.
`keyCode 229` 를 본 xterm 은 `CompositionHelper.keydown()` 에서 **`_handleAnyTextareaChanges()`** 를
호출하고 `_keyDown` 을 중단한다. 즉 모바일 입력은 이 함수가 전송한다.

```js
_handleAnyTextareaChanges() {
  const e = this._textarea.value;              // 캡처 시점 값
  setTimeout(() => {                           // ← 다음 tick
    if (!this._isComposing) {
      const t = this._textarea.value;
      const i = t.replace(e, '');              // ← 첫 일치만 제거한 diff
      this._dataAlreadySent = i;
      if (t.length > e.length) triggerDataEvent(i, true);
      else if (t.length < e.length) triggerDataEvent(DEL, true);   // 줄었으면 백스페이스로 간주
      else if (t !== e) triggerDataEvent(t, true);
    }
  }, 0);
}
```

`_inputEvent` 의 `(!composed || !_keyDownSeen)` 게이트는 확실히 이 입력을 버리지만,
**그것이 유일한 경로가 아니므로 게이트만으로는 유실이 설명되지 않는다.**
실패는 위 함수의 두 성질에서 나온다 — `setTimeout(0)` 지연과 **누적되는 textarea 값**에 대한 diff.

### 2.2 실측 — 중복과 유실

`_send` 를 후킹해 실제 전송 바이트를 관측했다.

**(1) 같은 tick 안의 3연타 (`a`, `b`, `c`)**

```
전송: ["abc", "bc", "c"]        textarea: "abc"
```

→ 터미널에는 `abcbcc` 즉 **6 글자**가 들어간다. pending 콜백 3 개가 각자 *최종* 누적값을
자기 시점의 옛 값과 비교하므로, n 번째 입력이 n 번 전송된다.
빠르게 타이핑할수록 폭발한다. **"이상하게 쳐진다" 의 원인이다.**

**(2) 소프트키 1 글자 직후 같은 tick 에 Enter**

```
전송: "\r"                      textarea: ""
```

→ `x` 가 **사라졌다**. `_keyDown` 이 Enter 를 처리하며 `textarea.value = ''` 로 비우고,
그 뒤 실행된 pending 콜백은 `t.length === e.length` (둘 다 빈 값) 로 판정해 아무것도 보내지 않는다.
입력하고 곧바로 Enter 를 치는 흔한 조작에서 **마지막 글자가 유실된다.**
값이 줄어든 타이밍이면 같은 경로가 `DEL` 을 보내 **입력하지 않은 백스페이스**가 나간다.

> 초기 측정에서는 `_inputEvent` 게이트만으로 유실을 설명했다. 그 측정은
> `page.evaluate` 안에서 동기적으로 관측해 `setTimeout(0)` 콜백의 전송을 보지 못한
> 관측 시점 오류였다. 위 (1)(2) 가 정정된 근거다.

### 2.3 씹힘을 악화시키는 dongminal 쪽 경로

**(a) 리사이즈 폭주 (§1.5 와 동일 원인)**
`vv.scroll` 마다 `doFit()` → `term.resize()` → PTY SIGWINCH. Claude Code 는 SIGWINCH 마다
프레임 전체를 다시 그린다. 입력 중 이것이 연속되면 에코가 지워지고 다시 그려져
"방금 친 글자가 사라졌다" 로 보인다. 진행 중인 IME 조합도 리사이즈에서 깨진다.

**(b) 키바 탭 → 포커스/키보드 왕복**
`web/js/core/app-mobile.js` 는 마우스 경로만 포커스 탈취를 막는다:

```js
b.addEventListener('mousedown', e => e.preventDefault());   // 마우스 경로 전용
...
b.addEventListener('touchend', e => {
  if (wasMoved) return;      // ← 스크롤 제스처로 판정되면 preventDefault 없이 반환
  e.preventDefault();
  activate();
});
```

`wasMoved` (이동 > `MKB_TAP_SLOP_PX`) 인 경우 `preventDefault` 를 하지 않으므로 합성 click 이 발생하고
버튼이 포커스를 가져간다 → 소프트 키보드가 내려간다. 이어서 `sendToFocused()` 가
`p.term.focus()` 를 호출해 키보드를 다시 올린다 → vv 이벤트 폭주(§1.5)로 이어진다.

**(c) sticky modifier 누수** — `web/js/ui/term-pane.js` `onData`:

```js
if (A && A.isMobile && A._modKbd && out.length === 1) {   // ← 1글자일 때만
  if (mk.ctrl && c >= 0x40 && c <= 0x7e) out = String.fromCharCode(c & 0x1f);
  if (mk.alt) out = '\x1b' + out;
  ... // sticky 소비
}
```

- `out.length !== 1` 이면 modifier 가 **적용도 소비도 되지 않는다**. IME 조합 결과나 붙여넣기가
  여러 문자로 오면 sticky 가 잔존하고, 그 다음 한 글자 입력이 갑자기 제어문자로 나간다.
- 한글은 `out.length === 1` 이지만 코드포인트가 `0x40~0x7e` 밖이라 Ctrl 변환은 걸리지 않는 반면,
  **Alt 는 코드포인트 검사가 없어 `\x1b` + 한글** 로 전송된다. TUI 는 이를 Alt 조합으로 해석한다.

이 둘이 "이상하게 쳐진다" 의 재현 가능한 경로다.

### 2.4 입력 결론

| 원인 | 확정도 | 영향 |
|---|---|---|
| `_handleAnyTextareaChanges` 의 `setTimeout(0)` + 누적값 diff → 같은 tick 연타 시 **중복 전송** | **실측 확정** | 주원인 |
| textarea 가 다른 경로(Enter 등)에서 비워질 때 pending 콜백이 **입력 유실 / DEL 오전송** | **실측 확정** | 주원인 |
| `_inputEvent` 의 `!composed \|\| !_keyDownSeen` 게이트가 이 입력을 버림 | 코드 확정 | 위 경로의 폴백을 없애 단일 실패점으로 만듦 |
| vv 이벤트당 `doFit()` → SIGWINCH 폭주 → 재렌더/조합 파괴 | 코드 확정 | 부원인 |
| 키바 터치 → 포커스/키보드 왕복 | 코드 확정 | 부원인 |
| sticky modifier 누수 (`length===1` 게이트, Alt 코드포인트 미검사) | 코드 확정 | 산발적 오입력 |

---

## 3. 수정 방향 (요약, 스펙 아님)

1. **입력 (주원인)** — xterm 을 포크하지 않고 앱 계층에서 해결 가능하다.
   `.xterm-helper-textarea` 의 `beforeinput` 을 **capture 단계**로 가로채
   `inputType==='insertText'` 데이터를 우리가 전송하고 `preventDefault()` 한다.
   textarea 값이 변하지 않으므로 `_handleAnyTextareaChanges` 의 diff 는 항상 빈 값이 되어
   중복·유실·DEL 오전송이 모두 사라지고, 전송은 정확히 1 회가 된다. 모바일에서만 활성화한다.
2. **스크롤 (주원인)** — 터치 감도 배율 + 관성(플링)을 앱 계층에서 구현한다.
   `touchstart/touchmove/touchend` 를 capture 로 가로채 `term.scrollLines()` 를 호출하고,
   xterm 의 1:1 경로로는 전달하지 않는다.
3. **리사이즈 폭주** — `apply()` 의 `doFit` 을 rAF/디바운스로 묶고, `kbH` 변화가 임계 미만이면 fit 을 건너뛴다.
   `term-pane.onResize` 의 RESIZE 전송에도 병합을 넣는다.
4. **키바 포커스** — `touchend` 의 `wasMoved` 경로에서도 포커스 이동을 막거나, 버튼에 `tabindex="-1"` 을 준다.
5. **sticky modifier** — `length===1` 게이트를 제거하고 첫 코드포인트 기준으로 판정·소비하며,
   Alt 도 ASCII 범위에서만 `\x1b` 프리픽스를 붙인다.
