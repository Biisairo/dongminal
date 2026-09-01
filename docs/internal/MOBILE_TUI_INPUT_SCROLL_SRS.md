# SRS — 모바일 TUI 입력·스크롤 교정

문서 규격: IEEE 29148. 근거 문서: `docs/internal/MOBILE_TUI_SCROLL_INPUT_ANALYSIS.md`
요구사항 식별자 접두어: `FR-MTI-`

---

## 1. 서론

### 1.1 목적

모바일 브라우저에서 dongminal 의 터미널로 TUI(Claude Code 등)를 조작할 때 발생하는
두 결함을 제거한다.

- 터치 스크롤이 사실상 동작하지 않는다.
- 소프트 키보드로 입력한 문자가 유실되거나 잘못된 바이트로 전송된다.

### 1.2 범위

프론트엔드(`web/js/**`)와 상수(`web/js/core/constants.js`)에 한정한다.
서버·프로토콜·워크스페이스 스키마는 변경하지 않는다.

### 1.3 정의

| 용어 | 뜻 |
|---|---|
| 모바일 모드 | `App.isMobile === true` (`body.mobile`) |
| helper textarea | xterm 이 만드는 `.xterm-helper-textarea` — 실제 키 입력 수신부 |
| sticky modifier | 모바일 키바의 Ctrl/Alt 1회성(sticky) 또는 고정(lock) 상태 (`App._modKbd`) |
| 관성 스크롤 | 터치를 뗀 뒤 마지막 속도로 감쇠하며 이어지는 스크롤 |

---

## 2. 전체 설명

### 2.1 제약

- **C-1** `web/vendor/xterm.js` 를 포크·패치하지 않는다. 교정은 앱 계층에서만 한다.
- **C-2** 데스크톱 모드의 동작을 바꾸지 않는다.
- **C-3** 프론트엔드에 번들러가 없다. 새 전역은 로드 순서(`index.html`)를 지켜야 한다.
- **C-4** 상수를 코드에 하드코딩하지 않는다 (`constants.js` 에 둔다).

### 2.2 가정

- **A-1** ~~대상 TUI 는 마우스 리포팅을 켜지 않는다(실측).~~ **철회 — §7.2.**
  실기기 로그에서 SGR 마우스 리포트가 실제로 전송된다. 교정은 마우스 리포팅이
  켜져 있든 꺼져 있든 올바르게 동작해야 한다(FR-MTI-28).
- **A-2** 대상 TUI 는 alternate screen 을 쓰지 않으므로 스크롤백이 존재한다.
  alt screen TUI 는 스크롤할 대상이 없어 원리상 제외된다.

### 2.3 비목표

- alt screen TUI 의 스크롤 지원.
- 마우스 리포팅이 활성인 상태의 터치 → 마우스 리포트 변환.
- 데스크톱 휠 감도 변경.
- 가로 터치 스크롤(터미널은 가로 스크롤이 없다).

---

## 3. 요구사항

### 3.1 모바일 IME 입력 유실 (주원인)

근거: 분석 §2.1~2.2. 모바일 입력의 실제 전송 담당자는 xterm
`CompositionHelper._handleAnyTextareaChanges()` 이며, `setTimeout(0)` 지연과 누적 textarea 값의
`replace(old,'')` diff 를 쓴다. 그 결과 (1) 같은 tick 연타 시 n 번째 입력이 n 번 전송되고
(실측: `a,b,c` → `abc`,`bc`,`c`), (2) textarea 가 다른 경로(Enter 등)에서 비워지면
입력이 유실되거나 `DEL` 이 오전송된다 (실측: 소프트키+Enter → `\r` 만 전송).
`_inputEvent` 의 `(!composed || !_keyDownSeen)` 게이트는 이 입력을 버려 폴백을 없앤다.

- **FR-MTI-1** 모바일 모드에서 helper textarea 의 `beforeinput` 을 **capture 단계**로 가로채,
  `inputType === 'insertText'` 이고 `data` 가 비어 있지 않으면 그 문자열을 PTY 로 전송하고
  `preventDefault()` 한다. 취소로 textarea 값이 변하지 않으므로 `_handleAnyTextareaChanges` 의
  diff 는 항상 빈 값이 되고 xterm 의 `input` 리스너도 발화하지 않는다. 전송은 정확히 1 회다.
- **FR-MTI-2** composition 진행 중에는 FR-MTI-1 을 적용하지 않는다. 판정은
  `event.isComposing === true` 또는 `inputType` 이 `insertCompositionText` 인 경우다.
  한글·일본어 조합은 xterm 의 `CompositionHelper` 가 계속 담당한다.
- **FR-MTI-3** `inputType` 이 `insertText` 가 아닌 경우(삭제·서식 등)에는 개입하지 않는다.
- **FR-MTI-4** 데스크톱 모드에서는 개입하지 않는다. 판정은 이벤트 발생 시점의 `App.isMobile` 이다
  (리스너는 도구 생성 시 1회 등록하고, 모드 판정은 매 이벤트에서 한다).
- **FR-MTI-5** FR-MTI-1 의 전송에도 sticky modifier 규칙(§3.5)이 적용된다.
- **FR-MTI-19** xterm 이 이미 전송한 키에 딸린 `beforeinput` 은 가로채지 않는다.
  판정은 helper textarea 의 두 신호를 **버블 단계**에서 관측한 결과의 논리합이다.
  - `keydown` 의 `event.defaultPrevented` — xterm 이 `_keyDown` 에서 전송한 경우
    (xterm 의 keydown 리스너는 capture 단계에 있고 전송한 키를 `preventDefault` 한다).
  - `keypress` 의 발생 — xterm 이 `_keyPress` 에서 전송한 경우. **Space 가 이 경로이며
    `cancelEvents` 가 false 라 `preventDefault` 를 하지 않으므로 `beforeinput` 이 그대로 온다.**
    `defaultPrevented` 만 보면 공백이 두 번 전송된다(실측).

  플래그는 `beforeinput` 에서 1 회 소비하고 `keyup` 에서도 해제한다.
  소프트 키보드는 `keypress` 를 내지 않으므로 두 입력 경로가 정확히 갈린다.

### 3.2 터치 스크롤 (주원인)

근거: 분석 §1.1~1.2. xterm 의 터치 경로는 `scrollTop += dy` 1:1 이며 감도 배율과 관성이 없다.
실측: 200 px 드래그 = 11 행 (화면 37 행).

- **FR-MTI-6** 모바일 모드에서 터미널 영역의 터치 드래그는 세로 이동량에
  `MTI_TOUCH_GAIN` 을 곱한 픽셀만큼 스크롤한다.
- **FR-MTI-7** 터치를 뗀 뒤 관성 스크롤을 수행한다. 마지막 관측 속도(px/frame)에서 시작해
  프레임마다 `MTI_FLING_DECAY` 를 곱하고, 속도가 `MTI_FLING_MIN_V` 미만이면 멈춘다.
  상한은 `MTI_FLING_MAX_V` 다. 새 터치가 시작되면 진행 중인 관성은 즉시 취소된다.
- **FR-MTI-8** 스크롤로 판정된 터치는 xterm 의 터치·선택 경로에 도달하지 않는다
  (capture 단계 + `preventDefault()` + `stopPropagation()`).
- **FR-MTI-9** 터치 시작 후 세로 이동이 `MTI_TOUCH_SLOP_PX` 에 이르기 전에는 스크롤로 보지 않고
  이벤트를 통과시킨다. 짧은 탭은 기존대로 xterm 에 전달되어 포커스·선택이 동작한다.
- **FR-MTI-10** 스크롤은 `term.scrollLines()` 로 수행해 xterm 의 내부 `ydisp` 와 DOM `scrollTop` 이
  함께 갱신되게 한다. 행 단위 잔여 픽셀은 누적해 다음 이동에 반영한다(픽셀 손실 금지).
- **FR-MTI-11** 데스크톱 모드에서는 개입하지 않는다.

### 3.3 리사이즈 폭주

근거: 분석 §1.5 / §2.3(a). `visualViewport` 의 `resize`·`scroll` 마다 보이는 모든 pane 에
`doFit()` 이 걸려 PTY SIGWINCH 가 이벤트 수만큼 발생한다.

- **FR-MTI-12** `visualViewport` 핸들러의 `doFit` 호출은 `requestAnimationFrame` 으로 병합한다.
  한 프레임에 최대 1회만 실행한다.
- **FR-MTI-13** 직전 적용과 비교해 키보드 높이 변화가 `MTI_KB_EPS_PX` 미만이고
  `keyboard-up` 상태가 동일하면 fit 을 건너뛴다. 레이아웃 보정(padding·키바 위치)은
  값이 실제로 바뀔 때만 DOM 에 쓴다.

### 3.4 키바 포커스 왕복

근거: 분석 §2.3(b). `wasMoved` 경로가 `preventDefault` 없이 반환해 합성 click 이
버튼에 포커스를 주고 소프트 키보드가 내려간다.

- **FR-MTI-14** 키바 버튼은 포커스를 받지 않는다 (`tabIndex = -1`).
  스크롤 제스처로 판정된 터치에서도 포커스는 터미널에 남는다.

### 3.5 sticky modifier 오적용

근거: 분석 §2.3(c). `out.length === 1` 게이트 때문에 여러 문자 입력에서 sticky 가
적용도 소비도 되지 않고 잔존하며, Alt 는 코드포인트 검사가 없어 한글에도 `ESC` 가 붙는다.

- **FR-MTI-15** sticky modifier 의 적용·소비는 입력 문자열 길이와 무관하게 수행한다.
  판정 기준은 첫 코드포인트다. 적용 대상이 아니어도 sticky(1회성)는 소비된다 —
  잔존해 다음 입력을 오염시켜서는 안 된다.
- **FR-MTI-16** Ctrl 변환은 첫 코드포인트가 `0x40`~`0x7e` 일 때만, 그 한 문자에만 적용한다.
- **FR-MTI-17** Alt 프리픽스(`ESC`)는 첫 코드포인트가 ASCII 출력 범위(`0x20`~`0x7e`)일 때만 붙인다.
  한글 등 그 밖의 문자에는 붙이지 않는다(sticky 는 소비한다).

### 3.6 상수 (FR-MTI-18)

- **FR-MTI-18** 다음 상수를 `web/js/core/constants.js` 에 정의한다.

| 상수 | 값 | 근거 |
|---|---|---|
| `MTI_TOUCH_GAIN` | `2.5` | 실측 1:1 은 200 px = 11 행. 2.5 배로 200 px ≈ 27 행 ≈ 화면 3/4 |
| `MTI_TOUCH_SLOP_PX` | `8` | 탭과 스크롤 분리. 키바의 `MKB_TAP_SLOP_PX`(10) 보다 작게 — 터미널은 탭 오판의 대가가 작다 |
| `MTI_FLING_DECAY` | `0.93` | 프레임당 감쇠. 60 fps 에서 약 0.5 초 |
| `MTI_FLING_MIN_V` | `0.4` | px/frame. 이 밑은 정지 |
| `MTI_FLING_MAX_V` | `120` | px/frame 상한 |
| `MTI_KB_EPS_PX` | `4` | 키보드 높이 잡음 무시 임계 |
| `MOBILE_KB_UP_PX` | `80` | 키보드가 떠 있다고 보는 높이. 기존 인라인 값을 상수화 |

---

## 4. 검증

프로젝트는 `mobile-touch`(Pixel 7, `hasTouch:true`) 와 `chromium`(데스크톱 회귀) 둘을 쓴다.

| ID | 요구 | 검증 |
|---|---|---|
| TC-MTI-1 | FR-MTI-1 | `keydown(229)` + `beforeinput(insertText,'A')` → `A` 가 정확히 1 회 전송된다 |
| TC-MTI-2 | FR-MTI-1 | 같은 tick 안의 3 연타(`a`,`b`,`c`)가 중복 없이 `a`,`b`,`c` 로 전송된다 |
| TC-MTI-3 | FR-MTI-2 | `isComposing=true` 인 `beforeinput` 은 취소되지 않는다(가로채지 않는다) |
| TC-MTI-13 | FR-MTI-1 | 소프트키 1 글자 직후 같은 tick 의 Enter 에서 그 글자가 유실되지 않는다 |
| TC-MTI-14 | FR-MTI-19 | 모바일 폭 + 물리 키보드 입력이 중복 전송되지 않는다 (**공백 포함**) |
| TC-MTI-4 | FR-MTI-4 | 데스크톱 모드에서는 `beforeinput` 을 가로채지 않는다 |
| TC-MTI-5 | FR-MTI-6 | 200 px 터치 드래그가 1:1(11 행) 보다 유의하게 크게 스크롤한다 |
| TC-MTI-6 | FR-MTI-7 | 터치를 뗀 뒤에도 스크롤이 추가로 진행된다(관성) |
| TC-MTI-7 | FR-MTI-9 | slop 미만의 짧은 탭은 스크롤을 일으키지 않는다 |
| TC-MTI-8 | FR-MTI-11 | 데스크톱 모드의 터치는 개입되지 않는다 |
| TC-MTI-9 | FR-MTI-12 | 연속 `visualViewport` 이벤트 N 회에 대해 `doFit` 이 프레임당 1회로 병합된다 |
| TC-MTI-10 | FR-MTI-14 | 키바 버튼은 `tabindex="-1"` 이고, 스와이프 후에도 포커스가 터미널에 남는다 |
| TC-MTI-11 | FR-MTI-15 | Ctrl sticky 상태에서 여러 문자 입력 시 sticky 가 소비된다 |
| TC-MTI-12 | FR-MTI-17 | Alt sticky + 한글 입력에 `ESC` 가 붙지 않고 sticky 는 소비된다 |

회귀: `e2e/mobile-keybar.spec.ts`, `e2e/mobile-keybar-touch.spec.ts`,
`e2e/regression-pane-scroll.spec.ts`, `e2e/terminal.spec.ts` 가 그대로 통과해야 한다.

---

## 5. 동작 변경 기록

| 항목 | 이전 | 이후 | 이유 |
|---|---|---|---|
| 모바일 소프트 키보드 입력 | 연타 시 중복, Enter 직전 글자 유실, DEL 오전송 | `beforeinput` 가로채기로 정확히 1 회 전송 | FR-MTI-1 |
| 모바일 터치 스크롤 | 1:1 픽셀, 관성 없음 | 2.5 배 + 관성 | FR-MTI-6/7 |
| 키보드 등장 시 fit | 이벤트마다 | 프레임당 1회, 임계 미만 생략 | FR-MTI-12/13 |
| 키바 버튼 포커스 | 스와이프 시 포커스 탈취 가능 | 포커스 받지 않음 | FR-MTI-14 |
| sticky modifier | 여러 문자 입력 시 잔존 | 항상 소비 | FR-MTI-15 |
| Alt + 비 ASCII | `ESC` + 문자 | 프리픽스 없음 | FR-MTI-17 |

---

## 6. 개정 — Android Chrome 실기기 (FR-MTI-20~26)

§3 의 교정은 Chromium 모바일 에뮬레이션에서 검증했고 실기기(Android Chrome)에서는
증상이 남았다. 원인은 **에뮬레이션에 없는 두 요소**다 — 실제 소프트 키보드와,
터치가 합성하는 마우스 이벤트.

### 6.1 확정된 실책

**§3.3 은 Android Chrome 이 타지 않는 경로를 고쳤다.** `index.html` 은
`interactive-widget=resizes-content` 를 선언하고 Chrome 은 이를 지원한다. 그래서
키보드가 뜰 때 layout viewport 가 함께 줄어 `window.innerHeight` 도 줄고,
`kbH = innerHeight - vv.height - vv.offsetTop` 은 0 에 수렴한다 — FR-MKV-3 이
의도한 자기 비활성이다. 실제로 발화하는 것은 `window` 의 `resize` 이고,
`web/js/core/main.js` 의 그 핸들러는 **디바운스 없이 즉시 `doFit()`** 한다.
FR-MTI-12 의 병합은 그 경로에 걸리지 않았다.

### 6.2 증상의 단일 사슬

Android Chrome 은 focus 된 입력 요소가 있는 동안 사용자가 페이지를 탭하면
키보드를 **재표시**한다. dongminal 은 최초 render 에서 `p.focus()` 로
helper textarea 에 포커스를 주고 그 포커스는 계속 유지되므로:

```
스크롤하려고 화면을 만진다
  → 키보드 재표시                          ("시도때도없이 키보드가 올라온다")
  → layout viewport 축소 → window resize
  → main.js 가 즉시 doFit → rows 급변(실측 37→19) → PTY SIGWINCH → TUI 전체 재렌더
  → 제스처가 끊기고 진행 중인 IME 조합이 깨진다   ("글씨가 불안하다")
```

스크롤이 듣지 않는 것은 그 위에 **경합**이 하나 더 겹친 결과다. `.xterm-viewport` 는
`overflow-y:scroll` 이고 터미널 영역의 `touch-action` 이 `auto` 이므로 Chrome 은
터치 드래그를 네이티브 스크롤로 선점한다. 선점된 뒤에는 `preventDefault` 가 무시되어
브라우저의 `scrollTop` 변경(→ xterm `_handleScroll` → `ydisp`)과 우리 핸들러의
`scrollLines` 가 같은 상태를 양쪽에서 밀며 서로 상쇄한다.

> **정정.** 이 절의 초안은 "리사이즈가 보던 위치를 날린다"를 사슬에 넣었다.
> TC-MTI-16/17 로 측정한 결과 xterm 은 rows 가 바뀔 때 **하단으로부터의 거리를 이미
> 보존**한다(40 행 위 → 40 행 위, 하단 → 하단). 절대 위치(`viewportY`)만 rows 만큼
> 달라지는 것이고 사용자가 보는 내용은 유지된다. 따라서 리사이즈는 재렌더·조합 파괴의
> 원인이지 스크롤 위치 손실의 원인이 아니다.

### 6.3 요구사항

- **FR-MTI-20** `window` 의 `resize` 핸들러가 부르는 fit 도 FR-MTI-12 와 같은
  rAF 병합을 거친다. 모바일·데스크톱 공통이다 — 창 드래그 리사이즈에서도
  프레임당 1회로 충분하다.
- **FR-MTI-21** fit 으로 `rows` 가 바뀔 때 **하단으로부터의 거리**가 보존되어야 한다.
  **xterm 이 이미 이를 보장한다(측정 확인).** 구현 없이 회귀 방지로만 검증한다 —
  FR-MTI-20 의 병합이 이 성질을 깨지 않아야 하기 때문이다.
- **FR-MTI-22** 스크롤 제스처로 판정된 터치는 **helper textarea 를 blur** 한다.
  제스처가 끝나도 자동으로 되돌리지 않는다 — 되돌리면 키보드가 다시 올라온다.
  입력 재개는 사용자가 터미널을 탭하는 명시적 조작이다.
- **FR-MTI-23** 모바일에서 터미널 영역의 `touch-action` 은 `none` 이다.
  브라우저가 네이티브 스크롤을 선점하면 이후 `preventDefault` 가 무시되어
  우리 핸들러와 이중으로 움직인다.
- **FR-MTI-24** ~~`touchmove` 를 slop 판정 이전에도 `preventDefault` 한다.~~ **철회.**
  FR-MTI-23 이 브라우저의 제스처 선점 자체를 없애므로 불필요하고, slop 이내를
  취소하면 Chrome 이 그 제스처의 합성 마우스 이벤트를 억제해 **탭 → 포커스 경로가
  함께 죽는다**(FR-MTI-25 와 충돌). slop 이내는 그대로 통과시킨다.
- **FR-MTI-25** 모바일에서 키보드를 올리는 경로는 **터미널을 탭하는 것 하나뿐이다.**
  - `.pn` 의 포커스 이동(`mousedown`)에서 그 pane 의 터미널에 focus 한다.
  - `render()` 의 자동 focus 는 모바일에서 수행하지 않는다. 그것이 없으면 첫 로드와
    모든 재렌더가 키보드를 올린다. 데스크톱은 기존대로 focus 한다.
- **FR-MTI-26** 모바일 키바에 키보드를 내리는 버튼을 둔다. 누르면 focus 된
  helper textarea 를 blur 한다. 키를 보내는 버튼이 아니므로 sticky modifier 를
  소비하지 않는다.

### 6.4 검증

| ID | 요구 | 검증 |
|---|---|---|
| TC-MTI-15 | FR-MTI-20 | `window resize` 이벤트 다수가 프레임당 fit 1 회로 병합된다 |
| TC-MTI-16 | FR-MTI-21 | 하단에서 40 행 위를 보던 상태에서 rows 가 바뀌어도 40 행 위를 본다 |
| TC-MTI-17 | FR-MTI-21 | 하단에 있었으면 리사이즈 후에도 하단에 있다 |
| TC-MTI-18 | FR-MTI-22 | 스크롤 제스처 후 activeElement 가 helper textarea 가 아니다 |
| TC-MTI-19 | FR-MTI-24 | (철회) |
| TC-MTI-23 | FR-MTI-25 | 모바일 첫 로드에서 helper textarea 가 focus 되지 않는다 |
| TC-MTI-20 | FR-MTI-25 | 터미널 탭(`.pn` mousedown) 후 helper textarea 가 focus 된다 |
| TC-MTI-21 | FR-MTI-26 | 키보드 내리기 버튼이 있고, 누르면 blur 되며 키를 보내지 않는다 |
| TC-MTI-22 | FR-MTI-23 | 모바일에서 터미널 영역의 `touch-action` 이 `none` 이다 |

### 6.5 동작 변경 기록

| 항목 | 이전 | 이후 | 이유 |
|---|---|---|---|
| `window resize` 시 fit | 이벤트마다 즉시 | 프레임당 1회 | FR-MTI-20 |
| 모바일 터미널 `touch-action` | `auto` — 네이티브 스크롤이 선점·경합 | `none` | FR-MTI-23 |
| 스크롤 제스처 중 포커스 | textarea 유지 → 키보드 재표시 | blur | FR-MTI-22 |
| 모바일 첫 로드/재렌더 | render 가 focus → 키보드 등장 | focus 하지 않음 | FR-MTI-25 |
| 모바일 터미널 탭 | 앱 포커스만 이동 | 터미널에 focus (키보드 등장) | FR-MTI-25 |
| 키보드 내리기 | 수단 없음 | 키바 버튼 | FR-MTI-26 |

---

## 7. 개정 2 — 실기기 로그가 지목한 근본 원인 (FR-MTI-27~29)

§3·§6 의 교정은 실기기에서 증상을 없애지 못했다. 세 번째 시도에서야 `?diag=1`
오버레이(`web/js/ui/diag.js`)로 **실기기 이벤트를 직접 받았고**, 그 로그가 앞선
두 판정을 모두 뒤집었다. 이 절의 근거는 전부 그 로그다
(Android 10 / Chrome 151 / 360×731 / dpr 3).

### 7.1 로그가 말한 것

**환경은 정상이었다.** 교정이 적용되지 않은 것이 아니다.

```
isMobile=true displayMode=auto bp=768   body.mobile=true
tp.touchAction=none                     ← FR-MTI-23 적용됨
hasTouchScrollHook=true hasBeforeInput=true
ver=js/ui/term-pane.js?v=149            ← 새 코드 로드됨
```

**터치 핸들러도 정상이었다.**

```
touchstart n=1 y=488 cancelable=true tsActive=false dp=false
touchmove  n=1 y=479 cancelable=true tsActive=false dp=true
touchmove  n=1 y=477 cancelable=true tsActive=true  dp=true
```

slop 을 넘기며 `tsActive=true` 가 되고 `preventDefault` 도 걸린다. 그런데
**제스처 내내 `vY=0` 이었다.** 스크롤이 실행되지 않은 것이 아니라, **스크롤할
내용이 없었다.**

```
term.onScroll  vY=14 baseY=14 len=28 rows=14
window.resize innerH=387 | vY=0 baseY=0 len=14 rows=14     ← 스크롤백 소멸
window.resize innerH=759 | vY=0 baseY=0 len=13 rows=13
window.resize innerH=759 | vY=0 baseY=0 len=33 rows=33
```

`window.resize` **17 회**, PTY `RESIZE` **17 회**. `innerH` 가
`731 ↔ 387 ↔ 759 ↔ 746 ↔ 402` 로 왕복하며 `rows` 가 `33 ↔ 13` 을 오간다.
그리고 **rows 가 늘어날 때 xterm 은 스크롤백을 화면으로 흡수한다** —
`baseY=14 len=28` 이 `baseY=0 len=33` 이 된다. 스크롤백이 사라진다.

**이 TUI 는 마우스 리포팅을 켜고 있었다.**

```
SEND "\u001b[<35;32;22M"      ← SGR motion 리포트
SEND "\u001b[<0;32;22M"       ← 버튼 press
SEND "\u001b[<0;32;22m"       ← release
```

**입력은 정상이었다.**

```
compositionstart data=""
compositionupdate data="ㄱ" → "가" → "간" → "가나" → …
```

한글 조합 중 전송은 없다. `SEND "cc"` 는 중복이 아니라 사용자가 실제로 입력한
두 글자이고, Enter 가 `_finalizeComposition` 을 통해 조합을 확정시킨 결과다.
사용자가 말한 "글씨가 불안하다" 는 입력 유실이 아니라, 17 회의 SIGWINCH 가
TUI 프레임 전체를 다시 그려 **화면이 요동친 것**이다.

### 7.2 정정 — 앞선 두 판정의 오류

- **§0.1 의 "대상 TUI 는 마우스 리포팅을 켜지 않는다" 는 틀렸다.** 그 근거는
  PTY 로 `claude` 를 6 초(뒤에 20 초로 재시도) 캡처한 것이었으나, 캡처는 초기
  화면(1216 B)에서 멈춰 TUI 가 완전히 초기화된 뒤의 DECSET 을 보지 못했다.
  실기기에서는 SGR 리포트가 실제로 전송된다. **가정 A-1 은 철회한다.**
- **§6.2 의 사슬은 순서가 틀렸다.** 키보드 재표시가 첫 고리가 아니다. 첫 고리는
  **layout viewport 축소**이고, 그것이 rows 왕복 → 스크롤백 소멸 → 재렌더를
  일으킨다. FR-MTI-22(스크롤 시 blur)와 FR-MTI-25(탭만 focus)는 유효한 개선이지만
  주원인이 아니었다.

### 7.3 요구사항

- **FR-MTI-27** `interactive-widget` 은 `resizes-visual` 이다.
  **이 요구는 `USER_CHECKLIST_FIXES_SRS` 의 FR-MKV-2 를 개정한다** — 그 문서가
  `resizes-content` 를 택한 근거는 "layout viewport 가 줄어 `height:100%` 사슬이
  그대로 옳아지고, `kbH≈0` 이 되어 JS 경로가 스스로 비활성된다" 였다. 그 부수
  효과가 터미널에는 해로웠다: rows 가 키보드와 함께 왕복하고, 늘어날 때마다
  스크롤백이 소멸한다. 검증 `TC-MKV-9` 도 함께 개정한다. `resizes-content` 는
  소프트 키보드가 layout viewport 를 줄여 `window resize` 를 연발하게 하고, 그
  fit 이 rows 를 왕복시켜 스크롤백을 소멸시킨다. `resizes-visual` 에서는
  `window.innerHeight` 가 유지되므로 rows 가 고정되고, 키보드 높이는
  `visualViewport` 로 관측된다 — FR-MKV-3/4 의 보정과 FR-MTI-12/13 의 병합·임계가
  비로소 실제로 작동하는 경로가 된다.
- **FR-MTI-28** 터치 스크롤은 **합성 `wheel` 이벤트를 xterm 의 `term.element` 에
  디스패치**하는 방식으로 수행한다. `scrollLines` 를 직접 호출하던 이전 구현은
  스크롤백이 있을 때만 동작했고, 화면을 재렌더하는 TUI 에는 스크롤백이 rows 만큼
  밖에 없다. wheel 로 넘기면 xterm 이 상태에 맞게 갈라준다.
  - 마우스 리포팅 ON → 프로토콜에 맞는 휠 리포트 전송 → **TUI 가 스크롤한다**
  - OFF + 스크롤백 → viewport 스크롤
  - OFF + alt screen → 위/아래 방향키로 변환

  픽셀→행 누적도 xterm 의 `getLinesScrolled`(`_wheelPartialScroll`)가 이미 한다.
  이동이 0 인 프레임은 보내지 않는다.
- **FR-MTI-29** 스크롤로 판정된 제스처가 만든 합성 마우스 이벤트
  (`mousedown`/`mouseup`/`click`)는 `MTI_SYNTH_MOUSE_MS` 동안 차단한다.
  마우스 리포팅이 켜진 TUI 는 그것을 클릭으로 받는다 — 로그에서 스크롤 제스처가
  실제로 `ESC[<0;32;22M/m` 을 보내고 있었다.

### 7.4 검증

| ID | 요구 | 검증 |
|---|---|---|
| TC-MTI-24 | FR-MTI-27 | viewport meta 가 `interactive-widget=resizes-visual` 이다 |
| TC-MTI-25 | FR-MTI-28 | 스크롤백이 없는 상태에서도 터치 드래그가 wheel 로 넘어가고, 감도 배율이 실린다 |
| TC-MTI-26 | FR-MTI-28 | 마우스 리포팅(1000+1006)이 켜지면 SGR 휠 리포트가 전송된다 |
| TC-MTI-27 | FR-MTI-29 | 제스처 직후의 `mousedown` 이 차단된다 |

### 7.5 동작 변경 기록

| 항목 | 이전 | 이후 | 이유 |
|---|---|---|---|
| `interactive-widget` | `resizes-content` — 키보드가 layout viewport 축소 | `resizes-visual` | FR-MTI-27 |
| 터치 스크롤 실행 | `term.scrollLines` — 스크롤백이 있어야 동작 | 합성 `wheel` → xterm 이 분기 | FR-MTI-28 |
| 스크롤 제스처의 합성 클릭 | TUI 에 클릭으로 전달 | 차단 | FR-MTI-29 |

---

## 8. 개정 3 — IME 전송 순서와 버벅임 (FR-MTI-30~33)

§7 의 교정(`resizes-visual` + wheel 경로)으로 **스크롤은 실기기에서 동작하기
시작했다.** 남은 두 증상의 근거는 두 번째 실기기 로그와 사용자 관찰이다.

### 8.1 전송 순서 뒤바뀜 — 반쪽 개입의 대가

로그가 잡은 것:

```
1964.44 SEND " "                          ← 우리 훅이 확정 문자를 먼저 보냈다
1964.45 compositionend data="여전히"
1964.45 SEND "여전히"                      ← xterm 이 조합 문자열을 나중에 보냈다
```

터미널에는 `" 여전히"` 가 들어간다. 다음 단어는 `".안되는데"` 가 된다. 지웠다
다시 친 경우엔 더 나빠진다 — 사용자 관찰: "여전해" 를 지우고 "여전한거같아" 를
쳤더니 **`거같아야전해`** 가 나왔다.

원인은 **전송 시점을 두 주체가 나눠 가진 것**이다. FR-MTI-1 은 `insertText` 만
가로챘고, 조합 문자열은 xterm 의 `CompositionHelper` 가 `setTimeout(0)` 뒤에
보낸다. 확정 문자(`isComposing=false` 로 오지만 `compositionend` 보다 앞선다)는
우리가 즉시 보내므로 항상 조합보다 먼저 나간다. 순서를 보장할 방법이 없다.

- **FR-MTI-30** 모바일의 IME 경로는 **한 주체가 전담한다.** `CompositionHelper` 의
  `compositionstart`/`update`/`end` 를 끄고, `keydown` 은 `keyCode 229` 만 차단해
  일반 키(Enter·방향키)는 xterm 이 계속 처리하게 한다. 전송은 `compositionend`
  한 곳에서 한다 — 확정 문자열을 먼저, 보류된 확정 문자를 그 뒤에.
  조합 중(`compositionstart`~`compositionend`)에는 아무것도 보내지 않는다.

  비공개 필드(`term._core._compositionHelper`)에 손대는 대신 실패를 감당한다.
  구조가 바뀌어 찾지 못하면 `_imeMuted` 가 false 로 남고 기존 xterm 경로가
  그대로 동작한다.
- **FR-MTI-31** 조합을 전담하면 삭제도 우리 몫이다. 조합 **밖**의
  `deleteContentBackward` 는 `DEL(0x7f)`, `deleteWordBackward` 는 `0x17` 로 보낸다.
  조합 **중**의 삭제는 조합 갱신이므로 보내지 않는다 — `compositionend` 가 결과를 낸다.

### 8.2 버벅임 — 리포트 폭주

사용자 관찰: 스크롤이 되지만 "버벅인다". 터치는 한 프레임에 여러 번 발화하고,
그때마다 wheel 을 보내면 마우스 리포팅이 켜진 TUI 가 리포트 폭주를 받아 프레임을
따라 그리다 밀린다.

- **FR-MTI-32** wheel 디스패치는 `requestAnimationFrame` 으로 병합한다.
  프레임당 한 번, 그 프레임에 누적된 delta 로 보낸다. 관성 종료·도구 파괴 시
  대기 중인 프레임도 함께 취소한다.

### 8.3 옛 페이지로 검증한 사고 — 재발 방지

세 번째 검증이 실패로 보인 것은 교정이 틀려서가 아니라 **폰이 32분 전에 로드한
페이지를 쓰고 있었기 때문**이다. 로그의 타임스탬프가 전부 `1939~1982초` 였고,
`innerH` 가 `387↔759` 로 변한다는 것(= `resizes-content` 동작)과 wheel 리포트가
0 개라는 것이 그 증거였다. 서버 재시작은 WebSocket 만 끊고 문서는 살려둔다.

- **FR-MTI-33** 열려 있는 페이지가 옛 코드를 돌리고 있으면 **그것을 바로잡는다.**
  판정의 근거는 `index.html` 의 `core/main.js?v=` 다.
  > **개정 (RELOAD_CONTINUITY_SRS 묶음 P·S).** 이 조항은 원래 "배너를 띄우고 자동
  > 새로고침은 하지 않는다" 였다. 배너는 사용자가 누르지 않으면 이 조항이 막으려던
  > 상태를 그대로 남겼으므로 지금은 **곧바로 다시 연다** (FR-RLC-1). 계기도 주기가
  > 아니라 **서버가 SSE 로 건네는 인사**다 (FR-RLC-2) — `VERSION_CHECK_MS` 는 그와
  > 함께 사라졌다. 터미널 스크롤백은 서버가 들고 있어 "화면이 갈리는" 대가는 실제로
  > 없다 (RELOAD_CONTINUITY_SRS §2.1).
- **FR-MTI-34** HTML 응답에 `Cache-Control: no-cache` 를 붙여 항상 재검증하게 한다.
  ETag 만 있고 `Cache-Control` 이 없으면 브라우저가 heuristic freshness 로 재검증을
  건너뛸 수 있고, 그러면 새 빌드를 띄워도 `index.html` 이 옛 `?v=` 를 가리킨다.
  나머지 자산은 `?v=` 로 무효화되므로 ETag 만으로 충분하다.

### 8.4 검증

| ID | 요구 | 검증 |
|---|---|---|
| TC-MTI-28 | FR-MTI-30 | 조합 문자열이 확정 문자보다 먼저 전송된다 (`"여전히 "`, 이전 결함은 `" 여전히"`) |
| TC-MTI-29 | FR-MTI-30 | 조합 중에는 아무것도 전송하지 않는다 |
| TC-MTI-30 | FR-MTI-31 | 조합 밖의 백스페이스가 `DEL` 로 전송된다 |
| TC-MTI-31 | FR-MTI-32 | `_touchScrollBy` 10 회가 wheel 1 회(누적 delta)로 병합된다 |
| TC-MTI-32 | FR-MTI-33 | 새 버전이 감지되면 배너가 뜬다 |

### 8.5 동작 변경 기록

| 항목 | 이전 | 이후 | 이유 |
|---|---|---|---|
| 모바일 IME 전송 주체 | 우리(insertText) + xterm(조합) 분할 | 우리가 전담, xterm 조합 경로 정지 | FR-MTI-30 |
| 조합 확정 문자 순서 | 조합 문자열보다 먼저 | 나중 | FR-MTI-30 |
| 모바일 백스페이스 | xterm 의 textarea diff | `DEL` 직접 전송 | FR-MTI-31 |
| wheel 디스패치 | 터치 발화마다 | 프레임당 1회 누적 | FR-MTI-32 |
| 새 버전 | 알 수 없음 | 배너로 알림 | FR-MTI-33 |
| HTML 캐시 | 검증자만(ETag) | `no-cache` 로 항상 재검증 | FR-MTI-34 |

---

## 9. 개정 4 — §8 이 낸 회귀의 철회 (FR-MTI-35)

§8 의 FR-MTI-30 은 "IME 경로를 한 주체가 전담한다"며 xterm 의
`CompositionHelper` 를 껐다. **그것이 두 가지를 망가뜨렸다.**

- **조합 미리보기가 사라졌다.** 조합 중인 글자는 xterm 이 `.composition-view`
  오버레이에 그린다. `compositionstart`/`update` 를 끄면 그 오버레이가 갱신되지
  않아 **치는 과정이 화면에 보이지 않는다.**
- **확정마다 누적 전체가 다시 전송됐다.** Android GBoard 는 textarea 전체를 하나의
  조합으로 유지하므로 `compositionend.data` 가 누적 문자열이다. xterm 의
  `_finalizeComposition` 은 `_dataAlreadySent` 와 `_compositionPosition` 으로
  **이미 보낸 부분을 제외**하는데, 그 계산을 함께 껐다.

  사용자 관찰이 정확히 그것이었다 — "안녕하세요 테스트중입니다 저는 지금 …" 을
  치면 `안녕하세요` / `안녕하세요테스트` / `안녕하세요테스트중이빈다` … 로
  확정마다 전체가 다시 나갔다.

무엇보다 **`_muteXtermComposition()` 을 `isMobile` 게이트 없이 호출**해 데스크톱까지
같은 피해를 입었다. 사용자가 "모바일과 웹 모두 치는 과정이 보이지 않는다" 고 한
것이 이 회귀다.

### 9.1 요구사항

- **FR-MTI-35** xterm 의 `CompositionHelper` 는 **건드리지 않는다.** 조합의 전송과
  미리보기는 그쪽 책임이다 — 증분 계산(`_dataAlreadySent`)과 `.composition-view`
  갱신이 거기 있다.

  FR-MTI-30 은 그 범위를 좁혀 유지한다: **조합을 확정시키는 문자(`insertText`)만
  조합이 닫힐 때까지 보류**하고, `compositionend` 뒤(한 틱 더 미뤄 xterm 의
  `setTimeout(0)` 다음)에 보낸다. 그것만으로 순서 뒤바뀜은 해소된다.
  FR-MTI-31(백스페이스 직접 전송)도 함께 철회한다 — 삭제 역시 조합 상태를 아는
  쪽이 다뤄야 한다.

### 9.2 교훈

내부 구현을 끄는 개입은 그 구현이 **함께 책임지던 다른 일**까지 끈다. 이 경우
`CompositionHelper` 는 전송·증분계산·미리보기 셋을 겸하고 있었고, 전송만 떼어낼
수 없었다. 개입은 관측 가능한 최소 지점(여기서는 확정 문자의 순서)에 두는 것이 옳다.

또한 모바일 전용 교정에 `isMobile` 게이트를 빠뜨리면 데스크톱이 함께 깨진다.
게이트 누락은 `web/js/ui/term-pane.js` 의 `open()` 경로에서 특히 쉽다 — 그 경로는
모드와 무관하게 모든 도구에서 한 번씩 실행된다.

### 9.3 검증

| ID | 요구 | 검증 |
|---|---|---|
| TC-MTI-28 | FR-MTI-30 | 확정 문자가 조합 문자열 뒤에 나간다 (앞서지 않는다) |
| TC-MTI-29 | FR-MTI-30 | 조합이 열려 있는 동안 확정 문자를 보내지 않는다 |
| TC-MTI-33 | FR-MTI-35 | 조합 중 `.composition-view` 가 active 이고 조합 문자열을 보여준다 |
| TC-MTI-34 | FR-MTI-35 | **데스크톱**에서 미리보기가 살아 있고, 두 번째 조합이 누적 전체가 아닌 증분으로 전송된다 |

### 9.4 동작 변경 기록

| 항목 | §8 (회귀) | §9 (현재) | 이유 |
|---|---|---|---|
| xterm CompositionHelper | composition* 를 끔 | 건드리지 않음 | FR-MTI-35 |
| 조합 미리보기 | 사라짐 (데스크톱 포함) | 정상 | FR-MTI-35 |
| 확정마다 전송량 | 누적 전체 | 증분 (xterm 계산) | FR-MTI-35 |
| 모바일 백스페이스 | `DEL` 직접 전송 | xterm 담당 | FR-MTI-31 철회 |
| 확정 문자 순서 | 조합 뒤 (유지) | 조합 뒤 (유지) | FR-MTI-30 |
