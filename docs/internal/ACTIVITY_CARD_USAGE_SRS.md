# SRS: Activity 에이전트 카드의 사용량 줄 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **확인**: Go·JS 단위 시험과 e2e(TC-ACU-1~10)가 통과했다(2026-11-09). 실제 Claude Code 세션의 카드 표시는 사용자 확인이 남았다
> **입력**: 2026-11-09 대화. 사용자 결정 셋 — ① 맥락 사용률은 반드시 넣는다 ② 레이아웃은 "맥락 막대 + 모델·effort" 한 줄(1+2안, 사용량이 앞) ③ 한도 사용률 대시보드는 넣지 않는다 (D-ACU-3)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

Activity 패널의 에이전트 카드는 상태(`working`·도구 이름)와 detail 만 보인다. 그 세션이 맥락을 얼마나 썼는지, 어떤 모델로 돌고 있는지는 `dmctl status` 로만 볼 수 있다. 이 SRS 는 카드에 그 두 가지를 한 줄로 더한다.

### 1.2 범위 (Scope)

- 서버: `GET /api/tools/activity` 응답의 각 항목에 사용량 요약을 싣는다.
- 클라이언트: 에이전트 카드에 사용량 줄을 그린다.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **사용량 요약** | 카드가 그리는 값의 묶음. 맥락 사용률 · 맥락 등급 · 모델 이름 · effort (FR-ACU-2) |
| **맥락 등급** | 맥락 사용률을 맥락 정책의 경계로 나눈 값. `ok` · `warn` · `critical` (FR-ACU-3) |
| **맥락 정책** | `run.ContextPolicy`. 설정 `orchestration.contextWarnRatio`(기본 0.70) · `contextCriticalRatio`(기본 0.85) |
| **사용량 줄** | 카드의 상태 줄 아래에 서는 줄. 맥락 막대·백분율과 모델·effort 를 이 순서로 담는다 (FR-ACU-10) |

### 1.4 참고 (References)

- `ISSUE_AGENT_TREE_SRS.md` FR-SLP-* — statusLine 프록시와 `toolUsageView`
- `archive/AGENT_ACTIVITY_PANEL_SRS.md` FR-AAP-* — 활동 패널과 카드
- `UIUX_OVERHAUL_SRS.md` FR-ACT-* — Activity 패널의 구역
- `PANEL_SURFACE_SRS.md` FR-RPT-2 — 카드의 재조정 근거(`sig`)
- Claude Code 문서 "Customize your status line" — `context_window`·`model`·`effort` 필드

### 1.5 개요 (Overview)

§2 는 지금의 사실, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험이다.

## 2. 현황 (Identified Issue)

### 2.1 카드가 받는 값

- 카드는 `_activity` 맵의 `{state, tool, detail}` 만 읽는다 (`web/js/core/app-agents.js` `_agCardEl`).
- 그 맵은 두 경로로 채워진다. `GET /api/tools/activity` 를 `agentsPollMs`(기본 5초)마다 받아 차분으로 고치고(`_activityRestore`), SSE `tool_activity` 로 항목 하나를 덮어쓴다(`_onToolActivity`).
- 응답 항목은 `toolhub.ActivitySnap`(`toolId`·`state`·`tool`·`detail`·`updatedAt`)이다.

### 2.2 사용량은 서버에 이미 있다

- `dmctl statusline` 프록시가 보낸 값은 `usageStore` 에 도구별로 있다 (`handlers_usage.go`).
- `toolUsageView(toolID)` 가 그 값을 `context`(사용률·창 크기·토큰·출처)와 `usage`(모델·effort 등)로 돌려준다. statusLine 값이 없으면 Run 멤버에 한해 transcript 추정값으로 `context` 만 채운다.
- 이 값은 지금 `dmctl status` 로만 나간다. 브라우저로 가는 경로는 없다.

## 3. 요구 (Requirements)

### 3.1 서버

- **FR-ACU-1** `GET /api/tools/activity` 의 각 항목은 기존 필드를 그대로 두고, 사용량 요약이 있으면 `usage` 필드를 더한다. 사용량 요약이 없으면 `usage` 필드를 싣지 않는다.
- **FR-ACU-2** 사용량 요약의 필드는 아래와 같다. 값이 없는 필드는 싣지 않는다.

  | 필드 | 타입 | 출처 |
  |---|---|---|
  | `ctxPct` | number (0~100) | `toolUsageView` 의 `context.usedPct` |
  | `ctxLevel` | `"ok"`·`"warn"`·`"critical"` | FR-ACU-3. `ctxPct` 가 있을 때만 |
  | `model` | string | `usage.model.displayName`, 없으면 `usage.model.id` |
  | `effort` | string | `usage.effort` |

- **FR-ACU-3** `ctxLevel` 은 서버의 맥락 정책(`contextPolicy()`)으로 정한다. `ctxPct/100 ≥ CriticalRatio` 이면 `critical`, `≥ WarnRatio` 이면 `warn`, 그 밖은 `ok` 다. 클라이언트는 경계값을 갖지 않는다.
- **FR-ACU-4** 사용량 요약의 필드가 하나도 없으면 사용량 요약이 없는 것이다 (FR-ACU-1).
- **FR-ACU-5** 응답은 `toolUsageView` 의 허용 목록 밖의 값(경로·세션 id·비용 등)을 싣지 않는다.

### 3.2 클라이언트

- **FR-ACU-10** 사용량 요약이 있는 카드는 상태 줄 아래에 사용량 줄을 그린다. 왼쪽은 맥락 막대와 `NN%`, 오른쪽은 `모델·effort` 다. (2026-11-10 `ACTIVITY_STATE_SUBAGENT_SRS` FR-ASV-30 이 좌우를 바꿨다 — 왼쪽이 `모델·effort`, 오른쪽이 막대와 `NN%` 다)
- **FR-ACU-11** 사용량 줄의 각 부분은 값이 있을 때만 선다.
  - `model` 이 없으면 왼쪽 글자가 없다. `effort` 만 있으면 effort 만 보인다.
  - `ctxPct` 가 없으면 막대와 백분율이 없다.
  - 사용량 요약이 없으면 사용량 줄 자체가 없다. 카드는 지금과 같다.
- **FR-ACU-12** 백분율은 정수로 반올림한다. 막대 채움 폭은 `ctxPct` 를 0~100 으로 자른 값이다.
- **FR-ACU-13** 막대와 백분율의 색은 `ctxLevel` 을 따른다. `warn`·`critical` 은 기존 테마의 경고·위험 색 토큰을 쓴다. 새 색 값을 하드코딩하지 않는다.
- **FR-ACU-14** 사용량 줄의 툴팁(`title`)은 영어로 정확한 값을 보인다. 예: `Context 55% · Opus 5.5 · effort high` (FR-TIP-2 규약).
- **FR-ACU-15** 카드의 재조정 근거(`sig`)에 `ctxPct`(반올림한 값)·`ctxLevel`·`model`·`effort` 를 넣는다. 사용량이 바뀌면 카드가 다시 그려지고, 바뀌지 않으면 다시 그려지지 않는다 (FR-RPT-2).
- **FR-ACU-16** SSE `tool_activity` 는 사용량을 싣지 않는다. 그 이벤트로 항목을 덮어쓸 때 그 항목의 기존 `usage` 를 지우지 않는다. 사용량은 다음 `/api/tools/activity` 응답이 고친다.
- **FR-ACU-17** `_activityRestore` 는 응답 항목의 `usage` 를 맵 항목에 그대로 담는다. 응답에 `usage` 가 없으면 맵 항목에서도 `usage` 를 지운다.

### 3.3 비기능

- **NFR-ACU-1** 사용량이 바뀐 뒤 카드에 보일 때까지의 지연은 `agentsPollMs` 한 주기 이하다. 새 조회 주기나 새 SSE 이벤트를 만들지 않는다.
- **NFR-ACU-2** 사용량 줄은 패널의 최소 폭에서 카드 폭을 넘지 않는다. 넘치면 오른쪽 글자(모델·effort)가 말줄임(`…`)으로 줄고, 막대와 백분율은 줄지 않는다.

## 4. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-ACU-1 | 전달 경로는 `/api/tools/activity` 응답에 필드를 더하는 것이다 | 이미 5초마다 받는 응답이다. 새 API·새 주기·새 SSE 이벤트가 필요 없다. 맥락 사용률은 초 단위로 다툴 값이 아니다 |
| D-ACU-2 | 등급은 서버가 정한다 | 경계값이 서버 설정(`orchestration.contextWarnRatio`·`contextCriticalRatio`)에 있다. 클라이언트에 같은 값을 두면 두 벌이 된다 |
| D-ACU-3 | 계정 한도(5시간·7일) 대시보드는 넣지 않는다 | statusLine 값은 세션이 API 요청을 보낼 때만 갱신된다. 쉬는 동안의 실시간 값은 구독 자격증명으로 직접 조회해야 하고, 그 방식은 사내 규정상 정보보호팀 승인 대상이다 |
| D-ACU-4 | 바꾼 줄 수(`cost.totalLinesAdded/Removed`)는 넣지 않는다 | 사용자가 1+2안을 골랐다 |
| D-ACU-5 | 맥락 값이 오래됐다는 표시는 두지 않는다 | 맥락 사용률은 세션이 쉬는 동안 바뀌지 않는다. 마지막 값이 곧 지금 값이다 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-ACU-1 | FR-ACU-1·2·5 | Go: statusLine 사용량이 있는 도구로 `/api/tools/activity` 호출 | 항목에 `usage.ctxPct`·`ctxLevel`·`model`·`effort` 가 있고, 그 밖의 키는 없다 |
| TC-ACU-2 | FR-ACU-1·4 | Go: 사용량이 없는 도구 | 항목에 `usage` 키가 없다. 기존 필드는 그대로다 |
| TC-ACU-3 | FR-ACU-3 | Go: `ctxPct` 69.9 · 70 · 84.9 · 85 · 100, 기본 정책 | `ok`·`warn`·`warn`·`critical`·`critical` |
| TC-ACU-4 | FR-ACU-3 | Go: 설정의 경계를 0.5·0.6 으로 바꿈 | `ctxPct` 55 → `warn`, 60 → `critical` |
| TC-ACU-5 | FR-ACU-2 | Go: `model.displayName` 없음, `model.id` 있음 / transcript 출처만 있음 | `model` 은 id / `ctxPct` 만 있고 `model`·`effort` 는 없다 |
| TC-ACU-6 | FR-ACU-10·11·12 | JS 단위: 사용량 요약 조합별 카드 생성 | 각 부분이 값이 있을 때만 서고, 백분율은 정수다. 요약이 없으면 사용량 줄이 없다 |
| TC-ACU-7 | FR-ACU-13 | JS 단위: `ctxLevel` 별 카드 | 등급 클래스가 붙는다 |
| TC-ACU-8 | FR-ACU-15 | JS 단위: `ctxPct` 55.2→55.4 / 55→56 | 앞은 `sig` 가 같고, 뒤는 다르다 |
| TC-ACU-9 | FR-ACU-16·17 | JS 단위: 복원 후 SSE 덮어쓰기 / `usage` 없는 응답으로 복원 | 앞은 `usage` 가 남고, 뒤는 지워진다 |
| TC-ACU-10 | FR-ACU-10·NFR-ACU-2 | e2e: 사용량을 넣은 도구로 패널을 열고 최소 폭으로 줄임 | 사용량 줄이 보이고 카드 폭을 넘지 않는다 |

## 6. 비목표 (Non-goals)

- 계정 한도 사용률 표시, 여러 계정 등록, 계정 전환 (D-ACU-3)
- 비용·바꾼 줄 수·세션 시간 표시 (D-ACU-4)
- 사용량을 위한 새 API·새 SSE 이벤트·새 조회 주기 (D-ACU-1)
- Activity 패널 밖(사이드바·표시줄)의 표시
- statusLine 프록시와 `toolUsageView` 의 동작 변경

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 카드가 한 줄 늘어 한 화면에 보이는 카드 수가 준다 | LOW | 사용량 요약이 없는 카드는 늘지 않는다 (FR-ACU-11) |
| R-2 | SSE 덮어쓰기가 `usage` 를 지워 막대가 깜빡인다 | MEDIUM | FR-ACU-16 · TC-ACU-9 |
| R-3 | statusLine 프록시를 쓰지 않는 에이전트(codex 등)는 Run 멤버가 아니면 사용량 줄이 없다 | LOW | 의도한 동작이다. 값이 없으면 그리지 않는다 |
