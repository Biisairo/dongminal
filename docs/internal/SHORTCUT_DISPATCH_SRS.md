# Shortcut Dispatch SRS (L2)

## 1. Introduction
### 1.1 Purpose
`web/app.js` 의 `InputBinding.bind` 안에 남아 있는 단일 ad-hoc 단축키 분기(Ctrl/Cmd+F → toggleSearch) 를 dispatch 테이블에 통합하여 단축키 처리 경로를 단일 구조로 통일한다.

### 1.2 Scope
- 변경 대상: `web/app.js` 의 `InputBinding.bind` (keydown 핸들러), `App.executeAction` 의 action map.
- 변경 *없음*: 사용자가 등록한 `shortcuts{}` 키맵, 직렬화 형식, 기존 액션 동작.

### 1.3 Background
디자인 리뷰 시점(`web/app.js:1676+`) 의 if-else 사슬은 이미 (a) `shortcuts` 객체에 대한 `for...of` 루프 + `executeAction(action)` 호출로 테이블화 완료된 상태였다. 단 한 가지 잔여 분기:
```js
if (e.key === 'f' && (e.ctrlKey || e.metaKey)) { toggleSearch(); }
```
이 분기는 사용자 재바인딩 대상이 아니며 macOS Cmd 변형도 함께 처리해야 하므로 `shortcuts{}` 한 슬롯으로 표현하기 어려웠다. 본 SRS 는 이를 별도 *built-in* 디스패치 테이블로 정형화한다.

## 2. Stakeholders / Sources
- DESIGN_REVIEW_FOLLOWUP §3 L2.

## 3. Functional Requirements

### FR-L2-1 Built-in shortcut 테이블
`InputBinding` 에 사용자 재바인딩 불가능한 hotkey 를 위한 built-in 테이블을 정의한다. 각 항목은 `{match: (KeyboardEvent)=>boolean, action: string}` 형태.

기본 항목:
```
{ match: e => e.code === 'KeyF' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey, action: 'toggleSearch' }
```

### FR-L2-2 단일 dispatch 루프
`bind` 의 keydown 핸들러는 다음 순서로 동작한다:
1. recording 모드 처리 (변경 없음)
2. INPUT/TEXTAREA 무시 (변경 없음)
3. **built-in 테이블** 매칭 → 매칭 시 `executeAction(action)`
4. **사용자 shortcuts** 매칭 → 매칭 시 `executeAction(action)`

### FR-L2-3 executeAction 확장
`executeAction` 의 action map 에 `toggleSearch:()=>this.toggleSearch()` 항목을 추가한다.

### FR-L2-4 동작 보존
Ctrl+F / Cmd+F 키 입력 결과는 본 변경 전후 동일 (search bar toggle).

## 4. Non-Functional Requirements
- NFR-1 e2e 회귀 없음 (search 관련 spec 그린 유지).
- NFR-2 새 함수/클래스 추가 없음 — 기존 `InputBinding` 안에 데이터 한 줄 추가.

## 5. Test Plan
- 기존 e2e (`focus.spec.ts`, `basic.spec.ts`) 가 search bar 동작에 의존한다면 그린 확인.
- 신규 테스트 불필요 — 변경은 dispatch 경로 통일이며 외부 동작 0 변경.

## 6. Done Criteria
- [ ] FR-L2-1, FR-L2-2, FR-L2-3 구현
- [ ] `npx playwright test` 그린
- [ ] `web/index.html` 의 `?v=` 캐시 버스터 bump

## 7. Out of Scope
- 단축키 multi-binding (예: 한 action 에 Ctrl+X / Cmd+X 동시 매핑) 지원 — 차후 enhancement.
- toggleSearch 를 사용자 재바인딩 가능한 shortcut 으로 노출 (built-in 으로 유지).
