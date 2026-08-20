# Split Serialization SRS

## 1. Introduction
### 1.1 Purpose
연속 split 단축키(Ctrl+Shift+H 또는 Ctrl+Shift+V) 입력 시 발생하는 race 를 제거한다.

### 1.2 Scope
`web/app.js` 의 `App.split` 메서드.

### 1.3 Problem
두 가지 race 가 결합되어 발생.

**Race A (serialization)**: `split(dir)` 는 내부에서 `await this._newPane(...)` 를 사용하는 async 메서드. 빠른 연속 호출 시 두 번째 호출이 첫 번째의 `_setFocus(R2)` 가 적용되기 전에 `this.focused` 를 읽어 동일 region 을 split.

**Race B (SSE echo overwrite)**: 첫 split 의 `_save()` 가 PUT /api/workspace 를 보내면 서버가 `workspace_changed` SSE 를 브로드캐스트. PUT 응답이 클라이언트에 도착하기 *전에* SSE 가 도착하면, `wsETag` 가 아직 옛 값이라 `rev > cur` 검사를 통과하고 `_applyRemoteWorkspace` 가 `this.ws` 전체를 서버 버전으로 교체. 두 번째 split 이 이미 `await _newPane` 중이라면, 잡고 있던 `s` (sessions[i]) 는 stale 객체. 이후 `doSplit(s.layout, ...)` 은 stale layout 을 변경하고 `_setFocus(R3)` 를 호출하지만, render 시점의 `this.ws.sessions` 에 는 R3 가 없어 `_rLayout` 의 fallback (`firstRg`) 으로 focus 가 **R1 으로 점프**.

사용자 인지: "두 번째는 분할이 안 되고 1번 pane 으로 포커스가 이동해."

## 2. Functional Requirements

### FR-SPLIT-1 직렬화
`split(dir, opts)` 호출은 직전 split 이 완료될 때까지 대기 후 시작한다. 결과적으로 N 번 연속 호출 시 N 번 모두 — 매번 *현재* 포커스 region 을 — 순차적으로 split 한다.

### FR-SPLIT-2 옵션 우선순위 보존
`opts.targetRegion` 이 지정된 경우 (외부 호출자, 예: workspace_command MCP) 는 `this.focused` 와 무관하게 그 값을 사용한다. 직렬화는 그대로 적용 (큐 순서로).

### FR-SPLIT-3 SSE echo deferral
로컬 `_save()` 가 in-flight 인 동안에는 `_onWorkspaceChanged` 의 `_applyRemoteWorkspace` 호출을 보류한다(`_wsApplyPending=true` 마킹 후 return). save 가 완료되면 보류된 apply 를 한 번 실행한다. 이로써 자기 PUT 의 echo 로 인한 `this.ws` 교체와 stale-reference 문제 차단.

## 3. Non-Functional Requirements
- NFR-1 e2e 회귀 없음.
- NFR-2 사용자 인지 지연 없음 — 각 split 내부 await 외에 추가 대기 없음.

## 4. Test Plan
- 신규 e2e 추가 (e2e/split.spec.ts 또는 layout.spec.ts 에 추가):
  - 빠른 연속 splitH 2회 호출 → 활성 세션의 layout 에 region 3 개가 가로로 나란히 존재해야 한다.
- 기존 e2e 그린 유지.

## 5. Done Criteria
- [ ] split 직렬화 구현
- [ ] 신규 e2e 그린
- [ ] `npx playwright test` 전체 그린
- [ ] 캐시 버스터 bump

## 6. Out of Scope
- split 외 다른 async layout 변경 (addTab, closeTab) 의 직렬화 — 별 보고 없으면 차후.
