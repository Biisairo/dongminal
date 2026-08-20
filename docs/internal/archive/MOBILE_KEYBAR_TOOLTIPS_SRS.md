# SRS — Mobile Keybar Key Tooltips / Long-press Hints

> 모바일 보조 키바의 각 키에 풀네임 힌트를 부여한다. 데스크톱은 HTML `title` 속성 hover tooltip 으로, 모바일은 long-press popup 으로 노출한다.
>
> 본 SRS 는 README TODO "mobile mode 에서 ctrl, alt, 방향키 등 툴팁 안보임 이슈" 의 **잔여 부분(키 식별 도움말)** 을 처리한다.
>
> 본 문서는 IEEE 29148:2018 양식을 준수한다.
>
> 상위: [MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md](MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md), [MOBILE_MODE_RFC.md](MOBILE_MODE_RFC.md) §8 후속 항목
> 작성일: 2026-05-11

---

## 1. Introduction

### 1.1 Purpose

키바 각 키의 정체성(특히 `↑`/`↓`/`←`/`→`, `PgUp`/`PgDn` 등 축약 라벨)을 신규 사용자에게 즉시 식별 가능하게 한다.

### 1.2 Scope

- 대상: `web/app.js` `_initMobileKeybar` 의 키 생성 루프, `web/style.css` (popup 스타일).
- 데스크톱·모바일 양쪽에서 도움말 표시.

---

## 2. Specific Requirements

### REQ-T-1 (title / aria-label 부여)

각 `mkb-btn` 은 다음 풀네임을 `title` 과 `aria-label` 양쪽에 가져야 한다.

| label | 풀네임 |
|---|---|
| Esc | Escape |
| Tab | Tab |
| Ctrl | Control (modifier) |
| Alt | Alt (modifier) |
| ↑ | Arrow Up |
| ↓ | Arrow Down |
| ← | Arrow Left |
| → | Arrow Right |
| \| | Pipe |
| ~ | Tilde |
| / | Slash |
| - | Hyphen |
| Home | Home |
| End | End |
| PgUp | Page Up |
| PgDn | Page Down |

- **수용 기준**: 임의 키바 버튼의 `getAttribute('title')` 과 `getAttribute('aria-label')` 이 위 표 대로 일치.

### REQ-T-2 (long-press popup)

모바일에서 키바 버튼에 600ms 이상 touch 유지 시 풀네임 popup 이 버튼 위쪽에 표시되어야 한다. touch 종료(`touchend`) 또는 이동(`touchmove`) 시 popup 이 사라지고 키 입력은 트리거되지 않아야 한다 (long-press 후 release 는 "취소"로 간주).

- **수용 기준**: touch hold 600ms 후 `#mkb-tip` 요소가 DOM 에 존재하고 visible. textContent 가 풀네임. release 시 `#mkb-tip` 제거.

### REQ-T-3 (long-press 후 키 미발사)

long-press 가 트리거된 후 `touchend` 시점에 키 dispatch 가 발생하지 않아야 한다 (`_modKbd` 변경 없음 + xterm 입력 없음).

- **수용 기준**: long-press → release → `_modKbd.ctrl/alt` 변화 없음.

### REQ-T-4 (데스크톱 hover tooltip)

데스크톱 환경(`body:not(.mobile)`) 에서는 `title` 속성 hover tooltip 만 사용한다. (키바 자체가 비노출이라 normally 동작하지 않지만, mobileBreakpoint 강제 시 노출되며 hover 동작이 표준대로 작동).

---

## 3. Verification

| ID | 케이스 |
|---|---|
| TC-T1 | 모든 키 버튼이 `title`/`aria-label` 을 가짐 |
| TC-T2 | long-press 600ms 후 popup 노출 |
| TC-T3 | long-press 후 release 시 popup 제거 + 키 미발사 |
| TC-T4 | 짧은 tap (<600ms) 은 기존대로 키 발사 (회귀 없음) |

### Definition of Done

- [ ] TC-T1~T4 통과
- [ ] 기존 e2e 93개(89 + 4 RFC) 회귀 없음
- [ ] TC-D2 focus guard 동작 변화 없음

---

## 4. Change Impact

| 파일 | 변경 |
|---|---|
| `web/app.js` `_initMobileKeybar` | keys 정의에 `full` 추가, 버튼 생성 시 `title`/`aria-label` 부여, long-press 핸들러 추가 |
| `web/style.css` | `#mkb-tip` popup 스타일 |
| `web/index.html` | style.css 캐시 v=97 → v=98 |
| `e2e/mobile-keybar.spec.ts` | TC-T1~T4 추가 |

---

## 5. Decision Log

| Q | 결정 | 근거 |
|---|---|---|
| long-press 시간 | 600ms | Material Design / iOS 표준 (500~700ms 범위) |
| popup 위치 | 버튼 위쪽 (절대 위치) | 손가락에 가려지지 않음 |
| long-press 후 key dispatch | 미발사 (취소) | 표준 long-press 의미: "더 보기"; 의도치 않은 입력 방지 |
| modifier 버튼에도 long-press | 동일 적용 | 일관성 |
| aria-label | 같이 부여 | 스크린리더 접근성 |
