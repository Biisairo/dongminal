# SRS: Run 대시보드의 즉시 갱신 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **확인**: Go(TC-RLV-1~3)·JS 단위(TC-RLV-4~6)·e2e(TC-RLV-7·8)가 통과했다(2026-11-11). 기존 `TestApiToolMessage_IgnoresTrafficOutsideAnyRun` 은 Run 시작이 신호를 보내게 되어 메시지 전후 차이만 보도록 고쳤다
> **입력**: 2026-11-11 대화. Run 탭이 새로고침해야 바뀐다는 보고. 사용자 결정 — 서버의 빠진 신호 보강과 열린 Run 탭의 주기 조회를 함께 한다(제시한 3안)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

열린 Run 탭(대시보드)이 멤버 상태·맥락 등급·새 멤버를 새로고침 전까지 보이지 않는다. 이 SRS 는 이 변화들이 대시보드와 Activity 패널의 Runs 구역에 곧바로 보이게 한다.

### 1.2 범위 (Scope)

- 서버: `run_changed` 를 보내는 계기를 더한다.
- 클라이언트: Run 멤버 도구의 활동 변화로 다시 받고, 열린 Run 탭을 주기로 다시 받는다.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **Run 뷰** | Run 탭 하나가 한 칸에 그리는 대시보드. `RunsPanel._runViewMap()` 의 항목이다. `GET /api/runs/<id>/graph` 로 그린다 |
| **살아 있는 Run 뷰** | 그 탭이 워크스페이스에 아직 있는 Run 뷰 (`_runLiveTabIds`) |
| **멤버 도구** | Run 뷰의 응답(`members[].toolId`) 또는 Runs 목록(`runs[].members[].toolId`)에 있는 도구 id |
| **활동 상태** | SSE `tool_activity` 의 `state`. `working`·`waiting`·`idle`·`done`·`ended` 등 |
| **활동 주기** | 설정 `agentsPollMs`(기본 5초) |

### 1.4 참고 (References)

- `ORCHESTRATION_V2_SRS.md` FR-RVZ-15·16 — `/graph` 종단과 `run_changed`
- `ACTIVITY_RUNS_REFRESH_SRS.md` FR-ARR-* — Runs 목록의 주기 조회
- `EVENT_TIMER_HUB_SRS.md` FR-HUB-1~3 — 상태 등록부

### 1.5 개요 (Overview)

§2 는 지금의 사실, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험이다.

## 2. 현황 (Identified Issue)

### 2.1 Run 뷰를 다시 받는 계기

- Run 뷰는 첫 마운트와 SSE `run_changed` 에서만 `/graph` 를 받는다. FR-RVZ-16 이 "폴링하지 않는다" 고 정했다.
- 서버는 보고·배정·닫기·삭제·트리 조정·멤버 간 메시지에서만 `run_changed` 를 보낸다.

### 2.2 신호가 없는 변화

| 화면 값 | 왜 신호가 없나 |
|---|---|
| 노드 상태 (`working`·`waiting`·`ready`·`lost` 등) | `/graph` 를 부를 때 훅 상태와 생존으로 계산한다(`graphMemberState`). 서버의 Run 계층은 이 값이 바뀐 순간을 모른다 |
| 맥락 사용률·등급 | `apiRunContext` 가 기록만 고친다 |
| 새 멤버 | `apiRunMemberAdd` 가 보내지 않는다 |
| 승계 | `apiRunSucceed` 가 보내지 않는다 |
| 새 Run (Runs 목록) | `apiRunStart` 가 보내지 않는다 |

### 2.3 브라우저가 이미 받는 것

- 활동 상태의 변화는 데몬 모드와 직접 모드 모두 SSE `tool_activity` 로 모든 브라우저에 온다.
- 서버에서 이 변화를 Run 계층에 잇는 길은 데몬 경유와 직접 경로 두 갈래다. 브라우저는 한 갈래로 받는다.

## 3. 요구 (Requirements)

### 3.1 서버

- **FR-RLV-1** `POST /api/runs` 가 Run 을 만들면 그 Run 의 `run_changed` 를 보낸다.
- **FR-RLV-2** `POST /api/runs/members` 가 멤버를 등록하면 그 Run 의 `run_changed` 를 보낸다.
- **FR-RLV-3** `POST /api/runs/succeed` 가 승계를 마치면 그 Run 의 `run_changed` 를 보낸다.
- **FR-RLV-4** `POST /api/runs/context` 의 관측이 멤버의 맥락 등급(`ContextLevel`)을 바꾸면 그 Run 의 `run_changed` 를 보낸다. 등급이 같으면 보내지 않는다. 조정자 자리의 관측은 보내지 않는다.

### 3.2 클라이언트 — 활동 변화

- **FR-RLV-5** SSE `tool_activity` 를 받으면, 그 도구의 활동 상태가 이 브라우저가 마지막으로 본 값과 다를 때만 아래를 한다. 처음 보는 도구는 다른 것으로 본다.
  - 그 도구가 살아 있는 Run 뷰의 멤버 도구이면 그 Run 뷰를 다시 받는다.
  - 그 도구가 Runs 목록의 멤버 도구이면 Runs 목록을 다시 받는다(`_runsRefreshSoon`).
- **FR-RLV-6** 활동 상태가 같고 도구 이름·detail 만 바뀐 `tool_activity` 는 다시 받지 않는다.

### 3.3 클라이언트 — 주기 조회

- **FR-RLV-7** 살아 있는 Run 뷰가 하나 이상 있으면 활동 주기마다 모든 살아 있는 Run 뷰를 다시 받는다. 없으면 돌지 않는다. 주기는 상태 등록부에 선언한다.
- **FR-RLV-8** 탭이 사라진 Run 뷰는 다시 받지 않고 지금처럼 정리한다(`_runDisposeView`).
- **FR-RLV-9** 겹친 조회는 기존 규약(`_runFetch` 의 `busy`·`pending`)으로 합친다.

### 3.4 비기능

- **NFR-RLV-1** 활동 상태 변화와 FR-RLV-1~4 의 변화는 다음 응답 한 번 안에 보인다. 그 밖의 변화(프로세스의 조용한 죽음 등)는 활동 주기 한 번 안에 보인다.
- **NFR-RLV-2** 새 API·새 SSE 이벤트·새 설정을 만들지 않는다.

## 4. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-RLV-1 | FR-RVZ-16 의 "폴링하지 않는다" 를 거둔다. 열린 Run 뷰는 활동 주기로 다시 받는다 | 노드 상태는 서버가 물을 때 계산하는 값이라 신호만으로는 모든 변화를 잡지 못한다. 사용자가 즉시성과 누락 없는 갱신을 함께 골랐다 |
| D-RLV-2 | 멤버의 활동 변화는 브라우저가 SSE `tool_activity` 로 감지한다. 서버에 `run_changed` 를 더하지 않는다 | 서버에서 잇는 길은 데몬 경유·직접 경로 두 갈래이고, 브라우저는 이미 한 갈래로 같은 사실을 받는다 |
| D-RLV-3 | 맥락 보고는 등급이 바뀔 때만 신호를 보낸다 | 맥락 보고는 훅마다 온다. 매번 보내면 모든 브라우저가 도구 호출마다 다시 받는다. 사용률 숫자는 주기 조회가 고친다 |
| D-RLV-4 | handoff 는 신호를 보내지 않는다 | 대시보드와 Runs 목록에 보이는 값을 바꾸지 않는다 |
| D-RLV-5 | 주기 조회는 살아 있는 모든 Run 뷰가 대상이다. 화면에 보이는지는 묻지 않는다 | 탭은 보통 한두 개다. 가시성 판정을 더하면 칸·창 판정이 하나 더 생긴다. 페이지가 숨으면 TimerHub 가 멈춘다 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-RLV-1 | FR-RLV-1·2 | Go: Run 시작, 멤버 등록 | 각각 `run_changed` 가 한 번 나가고 `runId` 를 싣는다 |
| TC-RLV-2 | FR-RLV-3 | Go: 승계 | `run_changed` 가 한 번 나간다 |
| TC-RLV-3 | FR-RLV-4 | Go: 처음 관측(등급 없음→ok) 뒤 ok→warn→warn→ok, 조정자 관측 | 등급이 바뀐 세 번만 나간다. 조정자 관측은 나가지 않는다 |
| TC-RLV-4 | FR-RLV-5·6 | JS 단위: 멤버 도구의 상태 변화 / 같은 상태 반복 / 멤버가 아닌 도구 | 앞은 그 뷰와 목록을 다시 받고, 뒤 둘은 받지 않는다 |
| TC-RLV-5 | FR-RLV-7·8 | JS 단위: 살아 있는 뷰와 탭이 사라진 뷰가 있는 상태에서 주기 실행 | 살아 있는 뷰만 받고, 사라진 뷰는 정리된다 |
| TC-RLV-6 | FR-RLV-7 | JS 단위: 상태 등록부 배선 | `run.views` 주기가 있고, 주기는 `agentsPollMs`, `when` 은 Run 뷰 유무를 따른다 |
| TC-RLV-7 | FR-RVZ-16 회귀 | 기존 e2e `runs.spec.ts`·`run-tree.spec.ts`·`slot-run-view.spec.ts` | 통과한다 |
| TC-RLV-8 | FR-RLV-7 · NFR-RLV-1 | e2e: 활동 주기를 줄이고 Run 탭을 연 채 기다림 | `/graph` 요청이 이어서 나간다 |

## 6. 비목표 (Non-goals)

- 서버가 멤버의 활동 변화로 `run_changed` 를 보내는 것 (D-RLV-2)
- handoff 의 신호 (D-RLV-4)
- 보이지 않는 Run 뷰를 주기 조회에서 빼는 것 (D-RLV-5)
- 새 주기 설정

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 멤버가 많은 Run 에서 활동 변화마다 `/graph` 를 다시 받는다 | MEDIUM | 상태가 바뀔 때만 받는다(FR-RLV-6). 겹친 조회는 합친다(FR-RLV-9) |
| R-2 | 주기로 다시 그려 hover·선택이 풀린다 | LOW | 기존 다시 그리기 보존 규약(NFR-RVZ-2)을 따른다. SSE 갱신과 같은 경로다 |
| R-3 | 여러 브라우저가 열려 있으면 주기 조회가 브라우저 수만큼 는다 | LOW | Run 탭이 열린 브라우저만 돈다 |
