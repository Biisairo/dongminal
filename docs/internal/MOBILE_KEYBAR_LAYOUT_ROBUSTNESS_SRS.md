# SRS — Mobile Keybar Layout Robustness

> 모바일 보조 키바 상시 표시 변경(`MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS`) 이후 발견된 두 가지 레이아웃 회귀를 제거한다.
>
> (A) 가상 키보드가 등장할 때 터미널 영역이 키보드 영역까지 차지하여 마지막 입력 행이 키보드 뒤에 가려지는 문제.
> (B) iOS Safari 의 safe-area-inset (홈 인디케이터) 에 키바가 가려지는 문제.
>
> 본 문서는 IEEE 29148:2018 양식을 준수한다.
>
> 작업 대상 리포: `/Users/dykim/personal/dongminal`
> 상위 문서: [MOBILE_MODE_RFC.md](MOBILE_MODE_RFC.md), [MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md](MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md)
> 작성일: 2026-05-11

---

## 1. Introduction

### 1.1 Purpose

상시 표시되는 키바가 키보드 등장 시·iOS 홈 인디케이터 영역과 충돌하지 않도록 레이아웃을 견고화한다.

### 1.2 Scope

- 대상 파일: `web/style.css`, `web/app.js` (visualViewport 핸들러), `web/index.html` (캐시 무효화), `e2e/mobile-keybar.spec.ts` (보강).
- 대상 상태: `body.mobile` 클래스 부여된 모든 환경. iOS Safari `env(safe-area-inset-bottom)` > 0 환경 + 가상 키보드 등장(`visualViewport.height` 축소) 상태 포함.

### 1.3 Definitions

| 용어 | 정의 |
|---|---|
| kbH | `window.innerHeight - vv.height - vv.offsetTop` 결과(px). 가상 키보드가 가린 layout viewport 영역의 높이. |
| safe-bottom | `env(safe-area-inset-bottom)` 값. iOS 홈 인디케이터 영역 px. iPhone X 이후 기본 34px. |
| 키바 높이 | `#mobile-keybar` 의 CSS `height` (현재 38px). |
| 보정 패딩 | `body.mobile` 에 부여되는 `padding-bottom`. 키바 높이 + (kbH 또는 safe-bottom) 으로 동적 계산. |

### 1.4 References

- IEEE 29148:2018 §9
- `docs/internal/MOBILE_MODE_RFC.md` §4.2 "가상 키보드 대응(visualViewport API)"
- `docs/internal/MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md` §3 REQ-F-4
- 영향 코드: `web/app.js:2253~2272` (`apply` 핸들러), `web/style.css:387~394, 446~470`, `e2e/mobile-keybar.spec.ts`

---

## 2. Overall Description

### 2.1 Background

직전 SRS 로 키바를 상시 표시하면서 `body.mobile{padding-bottom:38px}` 정적 보정을 도입했다. 두 가지 미흡점:

1. 키보드 등장 시 `bar.style.bottom = kbH px` 만 변경되고 `padding-bottom` 은 38px 그대로라, #app 의 content-box bottom 이 layout-viewport - 38px 에 고정된다. xterm refit 이 #app 영역 기준으로 cols/rows 를 계산하면 키보드 뒤(보이지 않는 영역)에 마지막 몇 행이 들어가 사용자에게 안 보임.
2. iPhone X 이후 단말은 화면 하단 ~34px 의 safe-area 가 있어 `bottom:0` 의 키바가 홈 인디케이터에 일부 가린다.

### 2.2 Operating Environment

- iOS Safari 15+, Android Chrome 100+ (RFC §7.3 그대로).
- visualViewport API 지원: 두 플랫폼 모두 지원. 미지원 구형 WebView 는 동작 변화 없음(키보드 미감지 → kbH 항상 0).

### 2.3 Constraints

- JS 핫패스(`apply`) 호출 빈도 증가 금지. 현재 visualViewport `resize`/`scroll` 이벤트로만 호출되며 본 SRS 도 이를 유지.
- `body.mobile` 클래스 외 다른 가시성·레이아웃 셀렉터 추가 금지(단순성 유지).
- 데스크톱 코드 경로 무영향.

---

## 3. Specific Requirements

### 3.1 Functional Requirements

#### REQ-A-1 (키보드 등장 시 #app 영역 보정)

가상 키보드 등장 (`kbH > 80`) 시 `body` 의 `padding-bottom` 은 `(키바 높이 + kbH) px` 이어야 한다. 키보드 미등장 시(`kbH <= 80`) `padding-bottom` 은 `키바 높이 + safe-bottom` 이어야 한다.

- **수용 기준**: visualViewport.height 를 300px 줄인 후 `getComputedStyle(document.body).paddingBottom` ≥ 338px (= 38 + 300). #app 의 boundingBox bottom ≤ `window.innerHeight - kbH - keybar_height + 1`.

#### REQ-A-2 (키바 위치 보정 유지)

키보드 등장 시 `#mobile-keybar.style.bottom` 은 `kbH px` 이어야 한다 (기존 동작 유지). 미등장 시 `safe-bottom px` 이어야 한다.

- **수용 기준**: 키보드 시뮬 후 `keybar.style.bottom` 이 `${kbH}px`. 시뮬 해제 후 `keybar.style.bottom` 이 `0px` 또는 `${safe-bottom}px`.

#### REQ-A-3 (xterm refit 트리거)

`padding-bottom` 또는 키바 `bottom` 변경 시 `p.doFit()` 호출이 이뤄져야 한다 (기존 코드 유지).

- **수용 기준**: 키보드 시뮬 후 200ms 이내에 활성 pane 의 xterm `cols`/`rows` 가 새 컨테이너 크기에 맞춰 재계산됨.

#### REQ-B-1 (iOS safe-area-inset 보정)

`#mobile-keybar` 의 시각적 위치는 iPhone 홈 인디케이터 위에 위치해야 한다. CSS `env(safe-area-inset-bottom)` 를 사용해 키보드 미등장 시 키바 bottom 을 `safe-bottom` 으로 설정한다.

- **수용 기준**: safe-bottom > 0 인 환경에서 키바 `getBoundingClientRect().bottom` ≤ `window.innerHeight - safe-bottom + 1`.

#### REQ-B-2 (HTML viewport-fit=cover)

`<meta name="viewport" ...>` 에 `viewport-fit=cover` 를 추가하여 iOS 가 `env(safe-area-inset-*)` 값을 보고하도록 한다.

- **수용 기준**: `index.html` 의 viewport meta 에 `viewport-fit=cover` 토큰 포함.

### 3.2 Non-Functional Requirements

#### REQ-NF-A (성능)

`apply` 핸들러 1회 호출당 추가 DOM 쓰기 1건 (`document.body.style.paddingBottom`). 호출 빈도는 기존과 동일.

#### REQ-NF-B (호환성)

- visualViewport 미지원 환경: REQ-A-1 의 키보드 등장 시 분기가 동작 안 함. 기존(직전 SRS 도입) 정적 `padding-bottom: 38px` 와 동등 동작. 회귀 없음.
- safe-area-inset 미지원 환경: `env(...)` 의 fallback 값(0) 으로 동작. 회귀 없음.

#### REQ-NF-C (유지보수성)

키바 높이를 매직넘버 38 로 두 곳 (`#mobile-keybar.height`, `body.mobile padding-bottom`) 에 중복 기재하지 않도록 CSS 변수 `--m-kb-h: 38px` 도입.

---

## 4. Verification

### 4.1 Test Cases (Playwright)

| ID | 케이스 | 절차 | 기대 |
|---|---|---|---|
| TC-A1 | 키보드 등장 시 body padding 동적 확장 | 모바일 모드 로드, visualViewport.height stub 으로 300px 축소 + `resize` 이벤트 dispatch | `body` paddingBottom = `(38 + 300)px` |
| TC-A2 | 키보드 미등장 시 body padding 기본 | 모바일 모드 로드, 시뮬 없음 | `body` paddingBottom = `38px` (safe-bottom 0 환경) |
| TC-A3 | 키바 bottom 위치 변화 | TC-A1 직후 `#mobile-keybar.style.bottom` | `'300px'` |
| TC-A4 | 키보드 해제 후 복원 | TC-A1 → vv.height 복원 + `resize` dispatch | `body` paddingBottom = `38px`, keybar bottom = `0px` |
| TC-B1 | viewport meta 에 viewport-fit=cover | `<meta name='viewport'>` content 검사 | `viewport-fit=cover` 토큰 존재 |
| TC-B2 | CSS 변수 `--m-kb-h` 정의 | 모바일 모드 로드 후 `getComputedStyle(document.documentElement).getPropertyValue('--m-kb-h')` | `38px` |

### 4.2 Definition of Done

- [ ] TC-A1~A4, TC-B1~B2 통과
- [ ] 기존 e2e 84개 회귀 없음
- [ ] `go build ./...` 통과
- [ ] 직전 SRS 의 TC-1~TC-6 여전히 통과

---

## 5. Change Impact

### 5.1 Code Changes

| 파일 | 변경 |
|---|---|
| `web/style.css` | `:root` 에 `--m-kb-h: 38px` 추가. `#mobile-keybar{height:var(--m-kb-h)}`, `body.mobile{padding-bottom: calc(var(--m-kb-h) + env(safe-area-inset-bottom, 0px))}`, `#mobile-keybar{bottom: env(safe-area-inset-bottom, 0px)}` |
| `web/app.js` | `apply` 핸들러에 `document.body.style.paddingBottom = (kbH + 38 + safe) + 'px'` 동적 분기 추가. 키보드 미등장 시 inline style 제거하여 CSS 기본값 복원 |
| `web/index.html` | viewport meta 에 `viewport-fit=cover`. style.css 캐시 토큰 v=96 → v=97 |
| `e2e/mobile-keybar.spec.ts` | TC-A1~A4, TC-B1~B2 추가 |

### 5.2 Backward Compatibility

직전 SRS 의 TC-1~TC-6 는 그대로 통과해야 한다. body padding 기본값이 `calc(38 + 0)px = 38px` 이라 결과 동일.

### 5.3 Rollback

JS apply 핸들러의 padding 동적 분기 1줄 + CSS `env()` 사용 3곳 + viewport meta 토큰 제거로 즉시 롤백 가능.

---

## 6. Traceability

| 요구 | 구현 | 검증 |
|---|---|---|
| REQ-A-1 | `web/app.js` apply 핸들러 + CSS body padding | TC-A1, A2, A4 |
| REQ-A-2 | `web/app.js` apply 핸들러 (기존 유지) | TC-A3, A4 |
| REQ-A-3 | `web/app.js` `p.doFit()` 호출 (기존 유지) | 수동 (xterm fit 사이드이펙트) |
| REQ-B-1 | `web/style.css` `bottom: env(safe-area-inset-bottom)` | 수동 (iOS 디바이스 또는 DevTools 시뮬) |
| REQ-B-2 | `web/index.html` viewport meta | TC-B1 |
| REQ-NF-A | apply 핸들러 1줄 추가 | 코드 리뷰 |
| REQ-NF-B | env() fallback + visualViewport guard | 코드 리뷰 |
| REQ-NF-C | `--m-kb-h` CSS 변수 | TC-B2 |

---

## 7. Decision Log

| Q | 결정 | 근거 |
|---|---|---|
| 키보드 등장 시 padding 조정 위치 | `body` 인라인 스타일 (JS) | CSS-only 로는 visualViewport 값을 못 받음 |
| 미등장 시 padding 복원 방식 | inline `paddingBottom = ''` 으로 CSS calc 으로 복귀 | 단순성 |
| safe-area-inset 적용 위치 | `bottom: env(...)` (키바) + `padding-bottom: calc(... + env(...))` (body) | 표준 패턴 |
| `--m-kb-h` 변수화 범위 | 키바 height 와 body padding 만 | 다른 곳 없음, YAGNI |
| viewport-fit 토큰 | `cover` | iOS safe-area-inset 보고 활성화 표준 값 |
