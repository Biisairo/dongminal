# SRS — Mobile RFC §7.2 Verification Automation

> `MOBILE_MODE_RFC.md` §7.2 모바일 신규 검증 체크리스트 중 자동화되지 않은 항목을 e2e 로 옮긴다.
> 본 SRS 는 **구현 변경 없음** — 검증만 추가한다.
>
> 본 문서는 IEEE 29148:2018 양식을 준수한다.
>
> 작업 대상: `e2e/mobile-keybar.spec.ts`
> 상위 문서: [MOBILE_MODE_RFC.md](MOBILE_MODE_RFC.md) §7.2
> 작성일: 2026-05-11

---

## 1. Introduction

### 1.1 Purpose

RFC §7.2 의 다음 4개 항목은 현재 수동 검증으로만 분류되어 회귀 추적이 불가능하다. e2e 로 옮긴다.

### 1.2 Scope

추가 대상 케이스:

1. **D-Modifier**: Ctrl/Alt 모디파이어 sticky/lock 토글 동작
2. **D-FocusGuard**: 키바 버튼 클릭 시 `mousedown`/`touchstart` `preventDefault` 로 xterm hidden textarea focus 가 유지됨
3. **D-PaneIndicator**: 단일 pane 세션에서 `#m-pane-indicator` 가 `1/1` 텍스트로 표시됨
4. **D-SplitHidden**: 모바일 모드에서 split 버튼(`#split-h`, `#split-v`) 과 split handle(`.sh`) 이 비노출

대상 파일: `e2e/mobile-keybar.spec.ts` (구현 코드 무변경).

### 1.3 References

- IEEE 29148:2018 §9
- `docs/internal/MOBILE_MODE_RFC.md` §7.2

---

## 2. Specific Requirements

### REQ-D1 (modifier toggle)

`Ctrl`/`Alt` 키바 버튼 1회 탭 시 해당 버튼이 `.sticky` 클래스를 가져야 한다. 같은 버튼을 350ms 이내 2회 탭(double-tap) 시 `.locked` 클래스로 전환되어야 한다. 다시 1회 탭 시 클래스가 제거되어야 한다.

- **수용 기준**: Playwright `click` 1회 → `.sticky` 클래스 존재. 빠르게 2회 클릭 (`{delay: 50}`) → `.locked` 클래스 존재. 추가 1회 클릭 → 두 클래스 모두 없음.

### REQ-D2 (focus guard)

키바 버튼의 `mousedown` 이벤트는 `preventDefault` 되어야 하며, 그 결과 클릭 후에도 `document.activeElement` 가 xterm hidden textarea 또는 키바 외 다른 입력 가능 요소여야 한다 (즉 키바 버튼 자체에 포커스 이동 없음).

- **수용 기준**: 사전에 `xterm-helper-textarea` 에 focus 를 둔 후 키바 임의 버튼 클릭 → `document.activeElement` 가 여전히 `xterm-helper-textarea` 또는 동등.

### REQ-D3 (pane indicator on single pane)

단일 pane 세션에서 `#m-pane-indicator` 의 textContent 는 `1/1` 이며 visible 이어야 한다.

- **수용 기준**: 모바일 모드 첫 로드 후 indicator `toHaveText('1/1')` + `toBeVisible()`.

### REQ-D4 (split controls hidden)

모바일 모드에서 `#split-h`, `#split-v` 버튼은 `display: none` 이어야 하며, 모든 `.sh` (split handle) 도 `display: none !important`.

- **수용 기준**: 두 버튼 모두 `toBeHidden()`. `.sh` 가 있을 경우(분할 0이라 없을 수 있음) 모두 hidden.

---

## 3. Verification

| ID | 케이스 |
|---|---|
| TC-D1 | REQ-D1 sticky/lock 토글 |
| TC-D2 | REQ-D2 focus 보존 |
| TC-D3 | REQ-D3 1/1 인디케이터 |
| TC-D4 | REQ-D4 split 컨트롤 비노출 |

### Definition of Done

- [ ] TC-D1~D4 통과
- [ ] 기존 e2e 89개 회귀 없음

---

## 4. Change Impact

| 파일 | 변경 |
|---|---|
| `e2e/mobile-keybar.spec.ts` | TC-D1~D4 추가 |
| `docs/internal/MOBILE_MODE_RFC.md` | §7.2 항목 4개에 "(자동화 완료)" 마킹 |

구현 코드 변경 0건.
