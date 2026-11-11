# SRS: Activity 패널 Runs 구역의 갱신 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **확인**: JS 단위(TC-ARR-1~4)와 e2e(TC-ARR-5)가 통과했다(2026-11-11). 관련 e2e 10개 파일 111건이 통과했다. 이 변경으로 `tab-names.spec.ts` V-NAM-4 의 준비 순서를 바꿨다(패널을 먼저 열고 활동을 넣는다)
> **입력**: 2026-11-11 대화. 사용자 결정 — ① 패널이 열려 있는 동안 Runs 목록을 주기적으로 조회한다 ② 핸들·버튼으로 패널을 열 때도 구역 목록을 다시 받는다. 서버 쪽 `run_changed` 보강은 하지 않는다 (D-ARR-4)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

Activity 패널을 열어 둔 동안 Runs 구역의 행이 바뀌지 않는다. 이 SRS 는 패널이 열려 있는 동안 목록이 최신 상태를 따라가게 한다.

### 1.2 범위 (Scope)

- 클라이언트: Runs 목록(`GET /api/runs`)의 주기 조회, 패널을 여는 경로의 재조회
- 서버는 바꾸지 않는다.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **Runs 목록** | `RunsPanel._runsList`. `GET /api/runs` 응답의 `runs` 다. Activity 패널의 Runs 구역과 상태바가 이것을 읽는다 |
| **활동 주기** | 설정 `agentsPollMs`(기본 5초). `tool.activity` 의 조회 주기다 |
| **패널 열림** | `#agents-panel` 이 `open` 클래스를 가진 상태. `App._agentsPanelOpen()` 이 판정한다 |
| **구역 재조회** | `App._actRefresh()`. Background·Runs·활동 목록을 다시 받는다 |

### 1.4 참고 (References)

- `ORCHESTRATION_V2_SRS.md` FR-RVZ-3·16 — Runs 목록 종단과 SSE `run_changed`
- `UIUX_OVERHAUL_SRS.md` FR-ACT-* — Activity 패널의 구역
- `EVENT_TIMER_HUB_SRS.md` FR-HUB-1~3 — 상태 등록부(`state-registry.js`)
- `OPTIMIZE_REFACTOR_SRS.md` FR-OPT-4-6·4-10 — 읽는 곳이 있을 때만 도는 주기, 겹친 목록 재조회 합치기

### 1.5 개요 (Overview)

§2 는 지금의 사실, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험이다.

## 2. 현황 (Identified Issue)

### 2.1 목록을 다시 받는 계기

Runs 목록은 아래 두 경우에만 다시 받는다. 주기 조회는 없다.

1. `actPanelOpen(key)` 가 `_actRefresh()` 를 부를 때. 단축키(`Ctrl+Shift+O` 등)로 열 때의 경로다.
2. SSE `run_changed` 를 받을 때. `_onRunChanged` 가 `_runsRefreshSoon()` 으로 250ms 안의 신호를 모아 한 번 조회한다.

핸들·토글 버튼은 `agentsToggle()` 만 부른다. 이 함수는 다시 그리기만 하고 목록을 받지 않는다.

### 2.2 `run_changed` 가 오지 않는 변화

서버는 보고·배정·닫기·삭제·트리 조정·멤버 간 메시지에서만 `run_changed` 를 보낸다. 아래 변화에서는 보내지 않는다.

- Run 생성(`apiRunStart`), 멤버 추가(`apiRunMemberAdd`), `apiRunSucceed`, `apiRunHandoff`, 맥락 보고(`apiRunContext`)
- 조회 시점에 계산하는 값. 멤버 상태(`deriveMemberState`)와 Run 생존(`runLiveness`)은 저장하지 않고 `/api/runs` 를 부를 때마다 훅 상태와 프로세스 생존으로 계산한다. 그래서 이 값이 바뀌는 순간을 서버가 이벤트로 알지 못한다.

결과: 패널이 열린 채로 멤버가 일하거나 쉬거나 죽어도 행이 그대로다.

## 3. 요구 (Requirements)

### 3.1 주기 조회

- **FR-ARR-1** 패널이 열려 있는 동안 클라이언트는 Runs 목록을 활동 주기마다 다시 받는다.
- **FR-ARR-2** 패널이 닫혀 있으면 주기 조회를 하지 않는다. SSE `run_changed` 에 따른 재조회(FR-RVZ-16)는 지금과 같다.
- **FR-ARR-3** 주기 조회는 상태 등록부(`STATE_REGISTRY`)에 선언한다. 조회 본체는 기존 `RunsPanel._runsRefresh()` 다. 겹친 조회를 합치는 기존 규약(FR-OPT-4-10)을 그대로 따른다.

### 3.2 패널을 여는 경로

- **FR-ARR-4** `agentsToggle()` 로 패널을 열면 구역 재조회를 한 번 한다. 닫을 때는 하지 않는다.
- **FR-ARR-5** `actPanelOpen(key)` 로 닫힌 패널을 열 때 구역 재조회는 한 번이다. 이미 열린 패널에서 다른 구역을 부를 때도 한 번이다.

### 3.3 비기능

- **NFR-ARR-1** 열린 패널에서 Runs 행의 변화가 보일 때까지의 지연은 활동 주기 한 번 이하다.
- **NFR-ARR-2** 바뀌지 않은 행은 다시 만들지 않는다. 기존 재조정(`outerHTML` 비교)을 그대로 쓴다.
- **NFR-ARR-3** 새 설정·새 API·새 SSE 이벤트를 만들지 않는다.

## 4. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-ARR-1 | 주기는 활동 주기(`agentsPollMs`)를 함께 쓴다 | 같은 패널의 다른 구역(에이전트 카드)이 이미 이 주기로 돈다. 설정을 하나 더 두면 같은 패널이 두 박자로 갱신된다 |
| D-ARR-2 | 주기 조회의 조건은 패널 열림 하나다. Runs 구역의 접힘과 주의 알림 유무는 보지 않는다 | 목록을 읽는 화면은 패널이다. 상태바의 Run 수는 `run_changed` 로 충분히 맞는다. 접힘까지 보면 조건이 늘지만 아끼는 요청은 패널이 열린 동안의 몇 건뿐이다 |
| D-ARR-3 | `run_changed` 구독은 `app-ws-sync.js` 에 그대로 둔다 | 그 처리기는 목록뿐 아니라 열린 대시보드의 `/graph` 도 다시 받는다. 등록부로 옮기는 것은 이 변경의 목적이 아니다 |
| D-ARR-4 | 서버의 `run_changed` 누락(§2.2)은 보강하지 않는다 | 주기 조회가 계산 값까지 함께 고친다. 즉시 반영이 필요해지면 따로 다룬다 |
| D-ARR-5 | 재연결(`sse:open`)·소프트 리로드 재검증은 더하지 않는다 | 패널이 열려 있으면 다음 주기가 고친다. 닫혀 있으면 열 때 다시 받는다 (FR-ARR-4·5) |

## 5. 검증 (Verification)

| TC | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-ARR-1 | FR-ARR-1·2·3 | JS 단위: `wireStateRegistry` 를 대역 앱에 배선 | `run.list` 주기가 있고, 주기는 `agentsPollMs`, `when` 은 패널 열림을 따르며, 실행하면 Runs 목록 재조회를 부른다 |
| TC-ARR-2 | FR-ARR-3 | JS 단위: `App._runsListRestore()` | `RunsPanel._runsRefresh()` 를 한 번 부른다 |
| TC-ARR-3 | FR-ARR-4 | JS 단위: 닫힌 패널에서 `agentsToggle()` 두 번 | 열 때 `_actRefresh` 가 한 번 불리고, 닫을 때는 불리지 않는다 |
| TC-ARR-4 | FR-ARR-5 | JS 단위: 닫힌 패널에서 `actPanelOpen('runs')` / 열린 패널에서 `actPanelOpen('bg')` | 두 경우 모두 `_actRefresh` 가 한 번이다 |
| TC-ARR-5 | FR-ARR-1·2·NFR-ARR-1 | e2e: 활동 주기를 줄이고 패널을 연 채 기다림 / 패널을 닫고 기다림 | 열린 동안 `/api/runs` 요청이 이어서 나가고, 닫힌 동안은 나가지 않는다 |

## 6. 비목표 (Non-goals)

- 서버의 `run_changed` 방송 계기 추가 (D-ARR-4)
- Run 대시보드(`/graph`)의 갱신 방식 변경. FR-RVZ-16 의 "폴링하지 않는다" 는 그대로다
- 새 주기 설정, Runs 구역 접힘에 따른 조건 (D-ARR-1·2)

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 패널이 열린 동안 `/api/runs` 가 활동 주기마다 나간다. 서버가 Run 마다 생존·훅 상태를 계산한다 | LOW | 패널이 열린 동안만 돈다 (FR-ARR-2). 주기는 사용자가 정한 활동 주기다 |
| R-2 | 5초마다 다시 그려 행의 hover·확인 버튼 상태가 풀린다 | MEDIUM | 바뀌지 않은 행은 다시 만들지 않는다 (NFR-ARR-2). 삭제 확인 상태는 `RunsPanel` 이 갖고 행을 만들 때 다시 싣는다 |
| R-3 | 핸들로 열 때 Background·활동 목록도 함께 받는다 | LOW | 단축키로 열 때와 같은 동작이다. 요청은 열 때 한 번이다 |
