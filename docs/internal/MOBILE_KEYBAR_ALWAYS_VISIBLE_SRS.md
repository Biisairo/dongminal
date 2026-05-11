# SRS — Mobile Keybar Always Visible

> 모바일 보조 키바(`#mobile-keybar`)의 표시 정책을 "가상 키보드 등장 시에만 표시"에서 "모바일 모드 진입 시 항상 표시"로 변경한다.
>
> 본 문서는 IEEE 29148:2018 (Systems and software engineering — Life cycle processes — Requirements engineering) 양식을 준수한다.
>
> 작업 대상 리포: `/Users/dykim/personal/dongminal`
> 상위 문서: [MOBILE_MODE_RFC.md](MOBILE_MODE_RFC.md) — §4.1 "가상 키보드 등장 시 표시" 결정을 본 SRS로 갱신한다.
> 작성일: 2026-05-11

---

## 1. Introduction

### 1.1 Purpose

본 SRS는 README TODO "mobile mode 에서 ctrl, alt, 방향키 등 툴팁 안보임 이슈" 항목 중 **보조 키바 자체가 미노출되는 1차 원인**을 제거하기 위한 요구사항을 정의한다. 사용자 피드백("모바일에서 ctrl/alt/방향키를 누를 방법이 없다")에 기반한 정책 변경이다.

### 1.2 Scope

- 대상 컴포넌트: `web/style.css` (모바일 키바 가시성 규칙), `web/index.html` (스타일시트 캐시 무효화), e2e 검증.
- 대상 상태: `body.mobile` 클래스가 부여된 모든 상황 — 자동(`displayMode='auto'` + viewport < `mobileBreakpoint`) 및 강제(`displayMode='mobile'`).
- 데스크톱(`body:not(.mobile)`) 동작은 변경하지 않는다.

### 1.3 Definitions, Acronyms, Abbreviations

| 용어 | 정의 |
|---|---|
| 키바(Keybar) | `#mobile-keybar` DOM. Esc/Tab/Ctrl/Alt/방향키/특수문자 16개 키를 가로 스크롤로 노출하는 보조 키 영역. |
| 모바일 모드 | `body.mobile` 클래스가 부여된 UI 상태. `App.isMobile` getter 결과와 동기화. |
| `keyboard-up` | visualViewport 높이가 80px 이상 줄어든 상태에 부여되는 `body` 클래스. 본 SRS 이후에도 위치 보정(`bottom`) 트리거로 유지된다. |
| 위치 보정 | 가상 키보드 등장 시 키바를 `bottom: <kbH>px` 로 sticky 시키는 JS 동작. |

### 1.4 References

- IEEE 29148:2018 §9 (Software Requirements Specification)
- 상위 RFC: `docs/internal/MOBILE_MODE_RFC.md` §4.1, §7.3
- 영향 코드: `web/style.css:387~394, 466~467, 440`, `web/app.js:2253~2270`, `web/index.html:8, 49`

### 1.5 Overview

§2 전체 설명 → §3 요구사항 → §4 검증 → §5 변경 영향 → §6 추적성.

---

## 2. Overall Description

### 2.1 Product Perspective

dongminal 단일 페이지 앱의 모바일 분기 표현 레이어 일부. 서버·워크스페이스 영속화·MCP 등 다른 모듈에는 영향 없음(프런트 전용).

### 2.2 Product Functions (Affected)

- **F-KB1**: 모바일 모드에서 보조 키바를 항상 노출한다.
- **F-KB2**: 가상 키보드 등장 시 키바를 키보드 바로 위에 sticky 시킨다 (기존 동작 유지).
- **F-KB3**: 데스크톱 모드에서 키바를 절대 노출하지 않는다 (기존 동작 유지).

### 2.3 Stakeholders

- 모바일 브라우저로 dongminal 에 접속하는 사용자 (Primary).
- RFC 작성·구현 담당자 (RFC §4.1 결정 갱신 추적).

### 2.4 Operating Environment

- 모바일 브라우저: iOS Safari 15+, Android Chrome 100+ (RFC §7.3 호환성 범위 그대로).
- visualViewport API 미지원 환경 (구형 Android WebView): 본 SRS 변경으로 **혜택을 받음** — 기존엔 `keyboard-up` 클래스 영원히 false 라 키바가 영원히 숨어 있었으나, 이제 항상 노출됨.

### 2.5 Design and Implementation Constraints

- **CSS-only 변경 원칙**: JS 가시성 분기를 추가하지 않는다. `body.mobile` 클래스 하나로 가시성 통제.
- **데스크톱 무손상**: `body:not(.mobile)` 셀렉터 경로는 변경 금지.
- **`keyboard-up` 클래스는 보존**: 위치 보정(`bottom`) 로직(`web/app.js:2253~2270`)이 의존하므로 토글 동작은 그대로 유지한다. 단, 가시성(`display`)과 분리한다.

### 2.6 Assumptions and Dependencies

- `App._applyMobileMode()` (`web/app.js:1301`)가 `body.mobile` 클래스를 정확히 토글한다고 가정한다 (기존 회귀 없음).
- 키바 높이는 CSS 변수가 아닌 하드코딩(`38px`, `web/style.css:449`); 본 SRS 변경 후에도 유지한다.

---

## 3. Specific Requirements

### 3.1 Functional Requirements

#### REQ-F-1 (키바 상시 노출)

`body.mobile` 클래스가 부여된 모든 상태에서 `#mobile-keybar` 의 computed style `display` 는 `flex` 여야 한다. 가상 키보드 등장 여부(`keyboard-up` 클래스)와 무관하다.

- **수용 기준**: 모바일 모드 진입 직후, `xterm` 에 포커스를 주지 않고 페이지 로드만 한 시점에 `#mobile-keybar` 가 `getBoundingClientRect().height > 0` 이며 `visibility: visible`.

#### REQ-F-2 (데스크톱 비노출)

`body.mobile` 클래스가 없는 모든 상태에서 `#mobile-keybar` 의 computed style `display` 는 `none` 이어야 한다.

- **수용 기준**: viewport width ≥ `mobileBreakpoint` (기본 768px) 인 상태에서 `#mobile-keybar` 가 `offsetParent === null`.

#### REQ-F-3 (위치 보정 유지)

가상 키보드 등장 시 키바는 키보드 바로 위로 이동해야 한다. 본 SRS 변경 후에도 `visualViewport.resize` 핸들러의 `bar.style.bottom = kbH + 'px'` 동작은 유지한다.

- **수용 기준**: visualViewport 시뮬레이션으로 `vv.height` 를 줄였을 때 `#mobile-keybar.style.bottom` 이 `(window.innerHeight - vv.height - vv.offsetTop)px` 와 일치.

#### REQ-F-4 (터미널 영역 보정)

키바가 상시 노출되므로 터미널 영역이 키바 아래로 숨지 않아야 한다. 모바일 모드에서 `#content` 또는 적절한 컨테이너에 `padding-bottom`(또는 동등한 margin) 으로 키바 높이(38px) 만큼 여백을 확보한다.

- **수용 기준**: 모바일 모드에서 status-bar 또는 터미널 최하단 행이 `#mobile-keybar` 의 `getBoundingClientRect().top` 보다 위에 위치.

### 3.2 Non-Functional Requirements

#### REQ-NF-1 (성능)

CSS 규칙 추가/삭제 외 변경 없음 → 렌더 비용 증가 없음. visualViewport 핸들러 호출 빈도·xterm refit 빈도 동일.

#### REQ-NF-2 (호환성)

- visualViewport API 미지원 환경에서도 REQ-F-1 충족 (가시성이 `keyboard-up` 에 의존하지 않으므로).
- iOS Safari safe-area-inset 와 충돌 없음 (`position:fixed; bottom:0` 그대로).

#### REQ-NF-3 (유지보수성)

키바 가시성·위치·키 구성이 한 곳에서 단순한 셀렉터로 명시되어야 한다(`body.mobile #mobile-keybar`). 중복 규칙 제거.

### 3.3 External Interface Requirements

- 사용자 인터페이스: 모바일 페이지 첫 로드 시점부터 화면 하단 38px 영역에 키바가 노출된다. 햄버거(`☰`)·검색(`🔍`)·새 탭(`+`) 버튼과 상호 배제 없음.
- 키보드/입력: 키바 버튼 동작(sticky/lock modifier, xterm dispatch) 변경 없음 (`web/app.js:2197~2252`).
- 영속화: 변경 없음. `displayMode`/`mobileBreakpoint` sessionStorage 키, workspace.json 모두 무영향.

---

## 4. Verification

### 4.1 Test Strategy

- **e2e (Playwright)** — 새 spec `e2e/mobile-keybar.spec.ts` 추가. 모바일 viewport(<768px) 로 페이지 로드 후 키바 가시성·치수 검증.
- **회귀** — `e2e/basic.spec.ts` 등 기존 데스크톱 spec 이 영향 없는지 확인.
- **수동** — Chrome DevTools 모바일 에뮬레이션 (iPhone 12 Pro) 으로 입력 전·후 키바 가시성 확인.

### 4.2 Test Cases

| ID | 케이스 | 절차 | 기대 |
|---|---|---|---|
| TC-1 | 모바일 진입 직후 키바 가시 | viewport 375x667 로 페이지 로드, 어떤 입력도 하지 않음 | `#mobile-keybar` `display: flex`, height ≈ 38px |
| TC-2 | 모바일 강제 모드 키바 가시 | sessionStorage `displayMode='mobile'` 설정 후 viewport 1024x768 로 로드 | 키바 가시 |
| TC-3 | 데스크톱 모드 키바 비노출 | viewport 1024x768, displayMode='auto' | 키바 `display: none`, offsetParent === null |
| TC-4 | 위치 보정 유지 | 모바일 모드에서 visualViewport 시뮬 (height -300px) | 키바 `bottom > 0`, keyboard-up 클래스 부여 |
| TC-5 | 모드 동적 전환 | resize 로 viewport 1024→375 전환 | 키바 즉시 가시화 (페이지 새로고침 불필요) |
| TC-6 | 터미널 영역 미잠식 | 모바일 모드 진입 후 status-bar 또는 터미널 최하단 행의 bottom < 키바 top | 충돌 없음 |

### 4.3 Definition of Done

- [ ] `e2e/mobile-keybar.spec.ts` TC-1, TC-3 통과 (필수)
- [ ] TC-4, TC-5 통과 (회귀 확인용)
- [ ] `go build ./... && go vet ./... && go test ./...` 통과 (서버 회귀 없음 확인)
- [ ] 기존 e2e 전체 통과
- [ ] `web/style.css` 의 `#mobile-keybar` 가시성 규칙이 단일 셀렉터(`body.mobile #mobile-keybar`)로 단순화됨

---

## 5. Change Impact

### 5.1 Code Changes

| 파일 | 라인 | 변경 |
|---|---|---|
| `web/style.css` | 392~394 | `body.mobile #mobile-keybar{display:none}` + `body.mobile.keyboard-up #mobile-keybar{display:flex}` → `body.mobile #mobile-keybar{display:flex}` 한 줄 |
| `web/style.css` | 466~467 | 중복 `keyboard-up` 규칙 제거 |
| `web/style.css` | 440 | `body.mobile #content{width:100%}` → `body.mobile #content{width:100%;padding-bottom:38px}` (REQ-F-4) |
| `web/index.html` | 8 | `style.css?v=95` → `style.css?v=96` (캐시 무효화) |
| `e2e/mobile-keybar.spec.ts` | NEW | TC-1~TC-5 |
| `docs/internal/MOBILE_MODE_RFC.md` | §4.1 | 본 SRS 링크 추가 (footnote 형태로 결정 갱신 기록) |

### 5.2 Backward Compatibility

- `displayMode='desktop'` 강제: 키바 노출 안 됨 (REQ-F-2). 변경 없음.
- 기존 `keyboard-up` 클래스 의존 코드: `web/app.js:2253~2270` 위치 보정 로직만 사용 중. 클래스는 그대로 토글되므로 회귀 없음.

### 5.3 Rollback Plan

CSS 3줄 reverting 으로 즉시 롤백 가능. e2e spec 만 별도 제거.

---

## 6. Traceability

| 요구 | 구현 위치 | 검증 |
|---|---|---|
| REQ-F-1 | `web/style.css` L392 | TC-1, TC-2 |
| REQ-F-2 | 기본 `.mobile-only{display:none !important}` (L388) + REQ-F-1 셀렉터 한정 | TC-3 |
| REQ-F-3 | `web/app.js` L2253~2270 (변경 없음) | TC-4 |
| REQ-F-4 | `web/style.css` L440 | TC-6 |
| REQ-NF-1 | CSS 규칙 수만 비교 (감소) | 코드 리뷰 |
| REQ-NF-2 | 셀렉터에서 `keyboard-up` 제거 | TC-1 (visualViewport 없는 환경 가정) |
| REQ-NF-3 | 셀렉터 단일화 후 grep `#mobile-keybar` 결과 ≤ 3개 | 코드 리뷰 |

---

## 7. Decision Log

| Q | 결정 | 근거 |
|---|---|---|
| 가시성 토글 방식 | CSS 단일 셀렉터 (`body.mobile`) | JS 분기 최소화 원칙 (RFC §5.1) |
| 토글 버튼 추가 | 없음 | 사용자 선택: "항상 표시"; UI 단순성 |
| 키보드 등장 시 동작 | 기존 위치 보정 그대로 | RFC §4.2 호환 유지 |
| 키바 높이 변수화 | 미수행 (YAGNI) | 본 SRS 범위 외; 38px 하드코딩 유지 |
| 터미널 영역 보정 방식 | `#content padding-bottom: 38px` | flex column 맨 아래에 status-bar 가 있고 그 아래에 키바가 있으므로 padding 한 줄로 해결 |
