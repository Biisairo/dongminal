# SRS: App 클래스 3분할 (S1) — IEEE 29148

## 1. 개요

### 1.1 목적
`web/app.js` 의 거대 `App` 클래스 (∼1700줄, _bind 단독 700줄) 를 phase 단위로 안전하게 분해. 본 세션은 **Phase 1 — focus 불변식 단일 진입점 (`_setFocus`)** 만 다루며, Phase 2 (Renderer) 와 Phase 3 (InputBinding) 는 별도 세션으로 분리한다.

### 1.2 범위
- Phase 1: focus 갱신을 단일 메서드(`App._setFocus(rid)`) 로 통합. 기존 42개의 `this.focused=...` / `s.focusedRegion=...` 직접 대입 사이트를 모두 위임으로 치환.
- 기존 동작 1:1 보존 (회귀 금지).
- e2e 테스트 (`focus.spec.ts`, `regression-md.spec.ts`) 그린 유지.

### 1.3 정의
- **focus 불변식**: `this.focused === a.focusedRegion`. 여기서 `a` 는 활성 세션. MD_VIEWER_REGRESSION_FIX_SRS 의 FR-2~FR-8 의 핵심 약속.

## 2. 현황
- focused 갱신이 42 사이트에서 발생 (`grep "this\.focused\s*=" + ".focusedRegion\s*=" web/app.js`).
- 일부 사이트는 `this.focused=X; s.focusedRegion=X` 페어로 묶여 있고, 일부는 한쪽만 갱신.
- 동일 불변식 위반이 REG-2~8 회귀의 직접 원인이 됐다.

## 3. 요구사항

### 3.1 기능
| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| FR-S1P1-1 | `App._setFocus(rid, opts={})` 는 `this.focused = rid` 와 활성 세션의 `focusedRegion = rid` 를 단일 호출로 동기화한다. `rid === null` 도 허용. | 필수 |
| FR-S1P1-2 | `opts.session` 이 명시되면 해당 세션의 `focusedRegion` 만 갱신하고 `this.focused` 는 활성 세션일 때만 변경. | 필수 |
| FR-S1P1-3 | 모든 `this.focused = ...` 직접 대입은 `_setFocus` 호출로 치환 (단, 초기화 `this.focused=null` 은 생성자 내부에서만 허용). | 필수 |
| FR-S1P1-4 | 기존 e2e 테스트 (focus / regression-md / layout / session / tab) 모두 그린 유지. | 필수 |

### 3.2 비기능
| ID | 요구사항 |
|----|----------|
| NFR-S1P1-1 | 외과적 변경. App 클래스 분할이나 별도 모듈 추출은 본 phase 범위 외. |
| NFR-S1P1-2 | `web/index.html` `?v=` 캐시 버스터 bump. |

## 4. 검증
- e2e: `focus.spec.ts`, `regression-md.spec.ts`, `layout.spec.ts`, `tab.spec.ts`, `session.spec.ts` 모두 통과.
- 코드 grep: 직접 대입 잔존 시 fail (CI 단계 외 수동 확인).

## 5. DoD (Phase 1)
- [ ] `_setFocus` 도입.
- [ ] 모든 `this.focused = ...` 사이트 치환.
- [ ] e2e 5종 그린.
- [ ] cache buster bump.
- [ ] DESIGN_REVIEW_FOLLOWUP §4 의 S1-Phase1 ✅ 표시.

## 6. Phase 2/3 (deferred)
- **Phase 2 (Renderer)**: `_rLayout`, `_buildRg`, `_rTabBar`, `render()` 의 DOM 조작 책임을 별도 `Renderer` 클래스로 추출. 인터페이스: `Renderer.render(layoutModel)`. 본 세션 비대상.
- **Phase 3 (InputBinding)**: `_bind` 의 700줄 단축키·키보드 dispatch 를 `InputBinding` 모듈로 추출. 본 세션 비대상.

## 7. 비목표
- 모듈 분할 (Phase 2/3 의 영역).
- 신규 동작 추가.
