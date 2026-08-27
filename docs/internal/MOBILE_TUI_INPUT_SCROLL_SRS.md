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

- **A-1** 대상 TUI 는 마우스 리포팅을 켜지 않는다(실측). 마우스 리포팅을 켜는 TUI 는
  xterm 이 터치를 처리하지 않으므로 본 SRS 범위 밖이다.
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
