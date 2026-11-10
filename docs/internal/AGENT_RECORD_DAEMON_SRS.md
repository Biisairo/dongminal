# SRS: 에이전트 기록의 데몬 소유 · 생존 판정의 세 값 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **입력**: 2026-11-10 대화. 사용자 결정은 다섯이다.
> - D-ARD-1 에이전트 관련 기록은 **데몬이 먼저 받아 저장하고 서버로 보낸다**
> - D-ARD-2 데몬이 들 기록은 "전부"다 — 활동·알람 표시·서브에이전트·사용량·계정 한도
> - D-ARD-3 §2.3 표의 데몬 항목(알람 표시·재무장·`agentSeen`·턴 표시·마지막 출력 시각·migration 안내 표시)도 옮긴다
> - D-ARD-4 Run 기록은 파일(`runs.json`)에 두고, **열림 여부는 저장하지 않고 물을 때마다 데몬의 생존으로 계산한다**
> - D-ARD-5 `contextNotices` 는 Run 멤버 기록에 둔다 — **D-ARD-10 으로 철회**

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

데몬 모드에서 터미널(PTY)과 에이전트 프로세스는 데몬(`dongminald`)이 들고, 웹서버만 따로 다시 뜰 수 있다. 그런데 에이전트에 관한 기록은 웹서버 메모리에만 있다. 그래서 서버만 다시 띄우면 다음 일이 생긴다.

- Activity 카드가 사라진다.
- 알람이 사라지거나 가짜 알람이 생긴다.
- 사용량과 한도가 비어 있다.

또 생존 판정이 "모른다"를 "죽었다"로 읽어, 살아 있는 Run 이 닫히거나 제거된다. 이 SRS 는 기록의 주인을 데몬으로 옮기고, 생존 판정을 세 값으로 고친다.

### 1.2 범위 (Scope)

| 단계 | 묶음 | 내용 |
|---|---|---|
| 1 | D·P | 데몬의 기록 저장소, 서버→데몬 쓰기, 데몬→서버 push 와 스냅샷 |
| 2 | R·C | 데몬의 보고 소켓, `dmctl` 이 데몬에 먼저 보내기 |
| 3 | A | 알람 판정(출력 신호·유휴·재무장)을 데몬으로 옮기기 |
| 4 | L | 생존 판정의 세 값(산다·죽었다·모른다), Run 열림의 계산 |

순서는 D-ARD-9 다 — 이 SRS 의 목적은 서버가 들던 기록을 데몬으로 옮기는 것이다.

직접 모드(데몬 없음)는 바꾸지 않는다. 그때는 서버 프로세스가 곧 도구를 들고 있다.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **에이전트 기록** | 도구 하나에서 도는 에이전트에 관한 값. §3.2 FR-ARD-10 의 표가 전부다 |
| **생존 판정** | 도구가 지금 살아 있는가에 대한 답. 값은 `alive`·`dead`·`unknown` 셋이다 |
| **확인된 죽음** | 데몬이 목록 요청에 **답했고** 그 목록에 도구가 없는 상태 |
| **보고 소켓** | 데몬이 훅 보고만 받으려고 따로 여는 소켓. 서버 연결 소켓(`paned.sock`)과 다르다 |
| **거울** | 서버가 데몬의 기록을 받아 화면·알람에 쓰려고 두는 사본. 주인이 아니다 |
| **스냅샷** | 서버가 데몬에 (다시) 붙을 때 받는 에이전트 기록 전부 |

### 1.4 참고 (References)

- `ACTIVITY_STATE_SUBAGENT_SRS.md` — 훅 해석, 서브에이전트 활동, 계정 한도
- `ATTENTION_FIRING_SRS.md` FR-ATN-* — 알람 판정과 턴 표시
- `TOOL_LIST_UNKNOWN_SRS.md` FR-TLU-* — `ListOK` 의 "모른다"
- `RUN_ORCHESTRATION_SRS.md` FR-RUN-4·5, `FBE-03` — epoch 펜싱과 생존
- `internal/daemon/ipc/paned_server.go` IPC-24 — 데몬은 연결을 하나씩 받는다

### 1.5 개요 (Overview)

§2 는 현황, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험이다.

## 2. 현황 (Identified Issue)

### 2.1 기록이 서버 메모리에만 있다

| 기록 | 자리 | 서버만 다시 뜨면 |
|---|---|---|
| 활동 상태(state·tool·detail) | `hub/attn_tracker.go` | 카드가 다음 훅까지 사라진다 |
| `agentSeen` | 같은 파일 :58 | 거짓으로 돌아가, 에이전트의 알림 시퀀스(OSC)를 알람으로 오인한다 (:182) |
| 턴 표시(`AgentTurn`) | 같은 파일 :61 | 재시작 전에 시킨 일이 끝나도 done 알람이 울리지 않거나, waiting 알람이 한 번 더 운다 |
| 알람 표시·재무장 잠금(`attention`·`attnArmed`·`attnRearmLocked`) | 같은 파일 :55~57 | 알람 배지가 사라지고, 유휴 알람 판정이 달라진다 |
| 마지막 출력 시각(`lastOutputAt`) | 같은 파일 :54 | `dmctl status` 의 `quietMs` 가 비고, `wait --for ready` 의 조용함 판정이 다음 출력까지 서지 않는다 |
| statusLine 사용량 | `httpapi/handlers_usage.go` | 모델·맥락이 다음 statusLine 갱신까지 빈다 |
| 서브에이전트 목록·활동 | `handlers_subagents.go`·`handlers_subagent_activity.go` | 하위 카드가 빈다 |
| 계정 한도 | `handlers_limits.go` | Usage 바닥이 빈다 |
| "맥락 사용률 모름" 안내 표시(`migrationUnknownTold`) | `httpapi/server.go:92` | 같은 안내를 한 번 더 받는다 |
| 맥락 경고 통지 기록(`contextNotices`) | `server.go:189` | 같은 멤버·등급의 `[CONTEXT-ALERT]` 가 조정자에게 한 번 더 갈 수 있다. "영속하지 않는 이유" 주석(`handlers_runs_context.go:62`)은 `FBE-03` 뒤로 사실과 다르다 |

서버가 꺼져 있는 동안 온 훅은 보낼 곳이 없어 사라진다. 서버가 꺼져 있는 동안 도구가 죽으면 종료 push 를 받지 못해, 사용량·서브에이전트 기록이 수거 주기까지 남는다.

### 2.2 "모른다"를 "죽었다"로 읽는다

- 데몬 모드의 생존 질의(`ToolClient.IsLive` · `seam/adapters.Tool.Has`)는 `Get` → `List()` 를 딛는다.
- `List()` 는 데몬이 답하지 못해도 빈 목록을 준다(`client_toolhub.go:67`). 그 바로 아래 `ListOK` 주석이 이 위험을 적어 두었지만 생존 질의는 `ListOK` 를 쓰지 않는다.
- 그 결과 두 곳이 살아 있는 Run 을 닫는다.
  1. 15초 수거(`reapRuns` → `ReapTargets`, `store_write.go:379`)가 조정자를 "죽었다"고 보고 Run 을 **제거**한다.
  2. 서버 시작 때의 펜싱(`fenceStale`, `store.go:273`)이 멤버 전부를 "죽었다"고 보고 Run 을 `aborted` 로 **저장**한다.
- 사용자가 "살아 있어야 할 Run 이 죽었다"를 겪었다. 그때의 로그로 확인하지는 않았다.

### 2.3 데몬의 제약

- 데몬은 연결을 **하나씩** 받고, 그 하나는 서버가 쥔다(IPC-24). `dmctl` 이 같은 소켓에 붙으면 서버가 놓을 때까지 기다린다.
- 데몬의 도구 관리자는 직접 모드와 같은 `toolhub.ToolManager` 다. 직접 모드의 `Tool` 에는 활동·턴·알람 판정 코드가 이미 있다(`tool_attention.go`). 다만 데몬에서는 그 알림 콜백을 잇지 않아 돌지 않는다.
- 샌드박스 창의 `dmctl` 은 `host.docker.internal` 로 서버에 HTTP 로만 붙는다. 데몬 소켓에는 닿지 못한다.

## 3. 요구 (Requirements)

### 3.1 단계 1 — 데몬 저장소와 push (묶음 D·P)

- **FR-ARD-10** 데몬은 도구마다 아래 기록을 둔다. 도구가 죽으면 함께 지운다.

  | 기록 | 출처 | 비고 |
  |---|---|---|
  | 활동 상태 `{state, tool, detail, updatedAt}` | 활동 보고 | 직접 모드 `Tool.SetActivity` 를 쓴다 |
  | `agentSeen`, 턴 표시 | 활동 보고 | 같은 함수가 세운다 |
  | 알람 표시 `{attention, reason}` | 알람 판정 (단계 3 전에는 서버가 쓴다) | |
  | 마지막 출력 시각 | 데몬이 출력을 볼 때 | |
  | statusLine 사용량 | 사용량 보고 | `statusline.Usage` 그대로 |
  | 서브에이전트 목록 + 받은 시각 | 서브에이전트 보고 | 기한(15초) 판정은 서버가 한다 |
  | 서브에이전트 활동 | 활동 보고(`agentId` 있음) | 상한 32 · done 유지 30초 규칙은 그대로다 |
  | migration "모름" 안내 표시 | 서버가 쓴다 | |

  데몬 전체에 하나: 에이전트별 계정 한도 `{windows, observedAt}`. 데몬이 끝나면 함께 사라진다.
- **FR-ARD-11** 서버는 데몬이 `records` 기능을 말하면(`hello` 의 `Features`), 위 기록을 바꾸는 모든 쓰기를 **데몬에 먼저** 보낸다(새 IPC 메서드 `recordset`). 데몬이 받은 뒤에 서버가 거울과 화면·알람에 반영한다. 데몬이 실패를 답하면 서버는 거울에만 반영하고 로그를 남긴다.
- **FR-ARD-12** (철회 — D-ARD-11) 데몬은 기록이 바뀌면 서버 연결로 `record` push 를 보낸다. 본문은 `{tool, kind, value}` 다. 이 push 는 버리지 않는다(출력 push 와 달리 넘침에서 빼지 않는다).
- **FR-ARD-13** 서버는 데몬에 (다시) 붙을 때마다 새 IPC 메서드 `records` 로 스냅샷을 받아 거울을 **통째로 바꾼다**. 스냅샷을 반영할 때는 알람을 울리지 않고 SSE 로 바뀐 카드만 보낸다.
- **FR-ARD-14** 데몬이 `records` 를 말하지 않으면(옛 데몬) 서버는 지금처럼 거울만 쓴다.

### 3.1a 단계 1 설계

인계 문서가 묶음 설계를 구현 세션에 맡겼다. 아래는 그 결정이다.

**와이어** (`internal/shared/toolipc/protocol.go`)

| 이름 | 모양 | 뜻 |
|---|---|---|
| 기능 `records` | `DaemonFeatures` 에 더함 | 데몬이 아래 셋을 안다 |
| `recordset` | `{kind, tool, value}` → `{}` | 기록 하나를 바꾼다. `value` 가 `null` 이면 지운다 |
| `records` | `{}` → `{global, tools:[{tool, agent, records}]}` | 스냅샷. 살아 있는 도구는 기록이 없어도 모두 싣는다 |

**기록의 종류(`kind`)**

| kind | 자리 | 값 |
|---|---|---|
| `agent` | 데몬 `Tool` 의 필드 그대로 | `toolhub.AgentState` — 활동·`agentSeen`·턴 표시 셋·알람·무장·재무장 잠금·마지막 출력 시각 |
| `usage`·`subagents`·`subagentActs`·`migrationTold` | 데몬 `Tool` 에 매단 값 | 서버가 정한 JSON. 데몬은 해석하지 않는다 |
| `limits` | 데몬 전체에 하나 (`tool` 이 빔) | 에이전트별 한도 전부 |

- 도구별 기록은 `Tool` 에 매단다. 그래서 도구가 죽으면 기록도 함께 사라지고, 지우는 코드가 따로 없다 (FR-ARD-10).
- `agent` 를 `Tool` 의 필드에 두는 것은 D-ARD-8 을 따른 것이다. 단계 3 에서 데몬의 `Tool` 이 판정할 때 바로 그 상태를 읽는다.
- 마지막 출력 시각은 데몬 `Tool` 이 출력을 볼 때 스스로 적는다. 서버가 쓴 값은 무시한다.
- 알람 사유(`reason`)는 두지 않는다. 사유는 방송에만 실리고, 다시 붙은 브라우저가 알람을 받는 길(`AttentionIDs`)은 사유를 싣지 않는다.
- 없는 도구의 `recordset` 은 `CodeNotFound` 다. 서버는 그것을 "데몬이 실패를 답했다" 로 보고 거울에만 반영한다 (FR-ARD-11).

**서버의 쓰기 — 비동기 큐 (`internal/webserver/recordsync`)**

- 단계 1 에서 알람 판정은 서버의 `AttnTracker` 가 한다. 그래서 `agent` 기록은 서버가 판정한 **뒤의** 상태를 데몬에 쓴다. 턴 표시의 소비(`AllowSignal`)가 그 예다.
- `AttnTracker` 의 출력 판정은 toolclient 읽기 루프 안에서 돈다. 그 자리에서 데몬 응답을 기다리면 응답을 읽을 고루틴이 자기 자신이라 교착이 생긴다. 그래서 쓰기는 큐에 넣고 고루틴 하나가 보낸다.
- 큐는 `(kind, tool)` 마다 마지막 값 하나만 둔다.
  - 연결 오류로 실패하면 값을 두었다가 다시 붙을 때 보낸다.
  - 데몬이 오류로 답하면(`RPCError`) 값을 버리고 로그를 남긴다.
- **FR-ARD-11 의 "데몬에 먼저" 와 다른 점:** 거울이 먼저 바뀌고, 데몬 쓰기는 곧바로 뒤따른다. 그 틈에 서버가 죽으면 마지막 변화 하나를 잃을 수 있다. 판정이 서버에 있는 한 피할 수 없다. 단계 3 에서 판정이 데몬으로 가면 이 틈이 없어진다.

**서버의 스냅샷 반영**

- 처음 붙을 때: 서버 조립이 끝나고 HTTP 를 열기 **전에** `records` 를 받아 거울을 바꾼다.
- 다시 붙을 때: 큐에 남은 쓰기를 먼저 보낸 뒤 `records` 를 받는다. 끊긴 동안 거울에만 반영된 값을 낡은 스냅샷이 덮지 않게 하기 위해서다.
- 반영은 통째다. 스냅샷에 없는 도구는 추적기에서 지우고, 값 저장소(사용량·서브에이전트·활동·안내 표시·한도)는 스냅샷 내용으로 바꾼다.
- 반영할 때 알람 방송은 없다. 활동이 바뀐 카드만 `tool_activity` 로 방송한다 (FR-ARD-13).

**옛 데몬 (FR-ARD-14):** 큐는 보낼 때마다 데몬이 `records` 를 말하는지 본다. 말하지 않으면 보내지 않고 스냅샷도 받지 않는다. 서버가 붙어 있는 동안 데몬이 바뀌어도(새 판 ↔ 옛 판) 그 데몬에 맞게 동작한다.

**끝난 도구:** 도구가 끝날 때 서버가 쓰는 `ended` 활동은 데몬이 이미 도구를 지운 뒤라 `CodeNotFound` 를 받는다. 정상이므로 로그를 남기지 않는다.

### 3.2 단계 2 — 보고 소켓과 dmctl (묶음 R·C)

- **FR-ARD-20** 데몬은 서버 연결 소켓과 **다른** 보고 소켓(`report.sock`, 같은 0700 폴더)을 연다. 이 소켓은 연결을 동시에 받고, 연결마다 요청 하나를 처리한 뒤 닫는다.
- **FR-ARD-21** 보고 소켓이 받는 메서드는 넷뿐이다: `report.activity`·`report.usage`·`report.subagents`·`report.notify`. 그 밖은 오류로 답한다. 본문은 지금의 HTTP 본문과 같다.
- **FR-ARD-22** 보고의 `toolId` 가 데몬의 살아 있는 도구가 아니면 거절한다. 받은 보고는 FR-ARD-10 의 기록에 쓰고, **보고 자체**를 push `report` 로 서버에 넘긴다. 보고로 바뀐 기록을 따로 push 하지 않는다 — 그 이유는 §3.2a 에 있다. 알람 판정(done·waiting 파생)은 단계 3 전에는 서버가 push 를 받고 한다.
- **FR-ARD-23** `dmctl activity`·`statusline`·`subagent-statusline`·`notify` 는 보고 소켓에 **먼저** 보낸다. 보고 소켓이 없거나(직접 모드·샌드박스·옛 데몬) 실패하면 지금처럼 서버 HTTP 로 보낸다. 두 시도의 합이 종전 시한(`hookBudget`·`slReportBudget`)을 넘지 않는다.
- **FR-ARD-24** 서버의 HTTP 보고 종단(`/api/tools/activity/set`·`usage`·`subagents`·`attention/set`)은 그대로 둔다. 데몬이 `records` 를 말하면 FR-ARD-11 로 데몬에 먼저 쓴다. 샌드박스 창의 보고가 이 길로 데몬에 닿는다.
- **FR-ARD-25** 서버가 꺼져 있어도 데몬은 보고를 받아 기록한다. 서버가 다시 붙으면 FR-ARD-13 의 스냅샷이 그 결과를 싣는다. 그동안의 알람은 울리지 않는다.

### 3.2a 단계 2 설계

**값의 모양을 `internal/shared/agentrec` 로 내린다.** 데몬은 서버가 꺼져 있어도 보고를 기록해야 한다 (FR-ARD-25). 그래서 데몬이 보고를 직접 해석해야 하는데, 데몬은 `webserver` 를 import 할 수 없다. 아래 것을 새 패키지로 옮기고, httpapi 는 그 패키지를 쓴다. 동작은 바뀌지 않는다.

| 옮기는 것 | 종전 자리 |
|---|---|
| 보고 본문 넷의 타입(`ActivityReport`·`UsageReport`·`SubagentsReport`·`NotifyReport`) | httpapi 처리기 안의 익명 구조체 |
| 기록 값의 모양: `Usage`·`SubagentList`·`SubagentActivity`·`LimitRecord` | `toolUsage`·`subagentRecord`·`subagentActivity`·`limitRecord` |
| 서브에이전트 활동 넣기(상한 32, 가장 오래된 것부터 버림)·done 유지 30초·상태 검사 | `subagentActivityStore.put`·`subagentDoneKeep`·`validSubagentState` |
| 문자열 정리와 상한(64·512) | `hub.SanitizeActivityField`·`ActivityToolMax`·`ActivityDetailMax` |
| 턴 출처를 말하는 에이전트인가 | `agentReportsUserTurn` |
| 보고 소켓의 이름·메서드·요청·응답 모양 | 새것 |

**main 활동 반영을 `toolhub.Tool.ReportActivity` 하나로 둔다.** 사용자 프롬프트 표시 → 활동 → done·waiting 이면 알람 파생의 순서다. 직접 모드(`directAttention`)와 데몬이 이 함수를 함께 쓴다 (D-ARD-8).

**보고 소켓 (FR-ARD-20·21)**

- 자리: 데몬 소켓(`paned.sock`) 폴더의 `report.sock` 이다. 경로는 `agentrec.SocketPath(home)` 한 곳에서 만든다. 데몬과 dmctl 이 같은 함수를 쓴다.
- 요청 하나: `{"method":"report.activity","body":{…}}` → `{"ok":true}` 또는 `{"ok":false,"error":"…"}`. 연결마다 한 줄을 받고 답한 뒤 닫는다. 읽기·쓰기 시한은 2초다.
- `body` 는 지금의 HTTP 본문과 같다. `toolId` 는 본문에서 읽는다. 데몬은 HTTP 의 PID 역추적을 할 수 없다. dmctl 은 이미 모든 본문에 `toolId`(`DONGMINAL_TOOL_ID`)를 싣는다.
- 거절하는 경우:
  - 넷이 아닌 메서드
  - 본문이 깨짐, `toolId` 가 빔, 상태 어휘가 틀림
  - `toolId` 가 살아 있는 도구가 아님 (FR-ARD-22)
  - **붙은 서버가 보고 push 를 모름**(아래 「옛 서버」)

**데몬의 반영 (FR-ARD-22·25)**

| 메서드 | 데몬 기록 |
|---|---|
| `report.activity` (main) | `Tool.ReportActivity`. `ended` 면 `subagentActs` 를 지운다 |
| `report.activity` (`agentId` 있음) | `subagentActs` 에 넣는다(상한 규칙 그대로) |
| `report.usage` | `usage` = 본문 + 받은 시각. 한도가 있으면 statusLine 보고 에이전트의 몫을 전역 `limits` 에 합친다 |
| `report.subagents` | `subagents` = 목록 + 받은 시각 |
| `report.notify` | `Tool.SignalAttention(reason)`. 사유가 비면 `signaled` |

데몬에는 알림 콜백이 없으므로 알람 판정은 상태만 바꾼다 (FR-ARD-25 의 "상태만 맞춘다").

**서버로 넘기기 — 기록이 아니라 보고 자체를 push 한다.** 서버가 붙어 있으면 데몬은 반영한 뒤 push `report {method, body}` 를 보낸다. 이 push 는 버리지 않는다.

- 서버는 그 push 를 HTTP 처리기와 **같은 함수**로 처리한다. 처리기의 본체를 `applyActivityReport` 등으로 떼어 낸다.
- 그래서 알람 방송, SSE, Run 맥락 관측(`observeUsageContext`), 서브에이전트 활동 방송이 한 자리에 남는다. 판정 뒤 상태는 단계 1 의 쓰기 큐가 데몬에 되쓴다.
- **보고를 `record` push 로 보내지 않는 이유 (FR-ARD-22):** 데몬이 기록 push 를 먼저 보내면 서버 거울의 상태가 먼저 `done` 이 된다. 그 뒤 서버가 같은 보고를 처리하면 상태가 바뀌지 않은 것으로 보여 알람이 울리지 않는다. 그래서 보고로 바뀐 기록은 `record` push 로 보내지 않는다. 데몬과 서버가 같은 보고를 두 번 반영하지만, 서버의 되쓰기가 마지막에 덮으므로 결과는 같다.
- 서버는 push 를 읽기 루프에서 처리하지 않는다. 처리 중 데몬 RPC(맥락 경고 전달의 입력 등)를 기다리면 교착이 생긴다. 고루틴 하나가 받은 순서대로 처리한다. 줄(1024)이 차면 버리고 로그를 남긴다. 버린 보고도 데몬 기록에는 남는다.

**옛 서버 (NFR-ARD-3):** 서버는 `hello` 에서 새 기능 `reports` 를 말한다. 붙은 서버가 그것을 말하지 않으면 데몬은 보고를 거절한다. 그러면 dmctl 이 HTTP 로 보낸다. 받아 버리면 옛 서버가 push 를 모른 채 버려 카드·알람이 사라진다. 서버가 붙어 있지 않으면 받는다 (FR-ARD-25).

**dmctl (FR-ARD-23)**

- `DONGMINAL_HOME` 이 있으면 보고 소켓에 먼저 보낸다. 소켓 시도의 시한은 예산의 절반이다. 성공이면 HTTP 를 보내지 않는다.
- 소켓이 없거나 실패하면, 남은 예산으로 지금과 같은 HTTP 요청을 보낸다. 두 시도의 합은 예산(`hookBudget` 2초·`slReportBudget` 100ms)을 넘지 않는다.
- 소켓으로 성공하면 호출자에게 HTTP 200 `{"ok":true}` 와 같은 결과를 준다. `dmctl notify` 의 종료 코드가 바뀌지 않는다.
- 직접 모드·옛 데몬은 소켓 파일이 없다. 샌드박스 창은 컨테이너 안에 그 경로가 없다. 그래서 곧바로 HTTP 로 간다 (D-ARD-7).
- `dmctl activity` 의 맥락 관측(`/api/runs/context`)은 넷에 들지 않으므로 HTTP 에 둔다.

### 3.3 단계 3 — 알람 판정의 데몬 이관 (묶음 A)

- **FR-ARD-30** 데몬 모드의 알람 판정(출력의 알림 시퀀스, BEL, 유휴 알람, 재무장, done·waiting 파생)은 데몬의 `Tool` 이 직접 모드 코드로 한다. 서버의 `AttnTracker` 는 판정하지 않고 거울과 방송만 한다.
- **FR-ARD-31** 판정에 쓰는 설정(유휴 기준·BEL 허용)은 서버가 붙을 때와 바뀔 때 새 IPC 메서드 `attnconfig` 로 데몬에 보낸다.
- **FR-ARD-32** 브라우저의 알람 해제(`/api/tools/attention/clear`, 키 입력 해제)는 데몬에 보내고, 데몬의 판정이 바뀐 결과를 push 로 받는다.
- **FR-ARD-33** 알람 동작은 직접 모드와 같아야 한다. 기존 알람 시험(`ATTENTION_*`)이 데몬 모드에서 그대로 통과한다.

### 3.3a 단계 3 설계

**판정은 데몬 `Tool` 한 곳에서 한다 (D-ARD-8).** 단계 2 까지는 데몬과 서버가 같은 보고를 두 번 판정했다. 서버의 판정이 쓰기 큐로 데몬을 덮었다. 단계 3 은 서버의 판정을 끄고, 데몬 판정의 결과를 push 로 받는다.

**와이어** (`internal/shared/toolipc`)

| 이름 | 모양 | 뜻 |
|---|---|---|
| 기능 `attention` | 데몬과 서버가 **함께** 말한다 | 데몬: 아래 넷과 push 를 안다. 서버: push `attn` 을 안다 |
| `attnconfig` | `{idleMs, allowBell}` → `{}` | 판정 설정 (FR-ARD-31) |
| `attend` | `{tool, typed}` → `{}` | 도구 하나의 알람 해제 (FR-ARD-32). 없는 도구는 무동작이다 |
| `attendall` | `{}` → `{cleared}` | 알람 전부 해제 (FR-PAN-17) |
| `report` | `{method, body}` → `{}` | 서버 HTTP 로 온 보고를 데몬에 넘긴다. 보고 소켓과 같은 반영·push 를 탄다 |
| push `attn` | `{tool, kind, reason, agent}` | 데몬이 판정한 결과. `kind` 는 `attention`·`clear`·`activity` 다. `agent` 는 알린 뒤의 `AgentState` 다 |

**데몬**

- `NewPanedServer` 가 `ToolManager.SetAttentionNotifier`·`SetActivityNotifier` 를 건다. 알림은 부를 때의 현재 연결로 push `attn` 을 보낸다. 전경·크기 알림과 같은 방식이다. 이 push 는 버리지 않는다.
- 알림은 도구를 만들 때 실린다. 그래서 `boot.Run` 은 `PanedServer` 를 `pm.LoadAll` **앞에서** 만든다.
- 붙은 서버가 `attention` 을 말하지 않으면 push 를 보내지 않는다. 서버가 없을 때도 같다. 판정은 그래도 하고, 상태만 바뀐다 (FR-ARD-25).
- 유휴 스위퍼를 데몬에서 돌린다. 문턱이 0 이라도 돌린다 — `attnconfig` 가 나중에 문턱을 줄 수 있다. 0 이면 틱마다 아무것도 하지 않는다. 바쁨 검사는 데몬이 PTY 를 직접 본다.
- `attnconfig` 는 `ToolManager.SetAttentionConfig` 다. 문턱은 다음 틱부터, BEL 허용은 **이미 있는 도구에도** 바로 적용한다. 그래서 `Tool` 의 BEL 허용 값은 원자값이 된다.
- `report` 는 보고 소켓의 `handleReport` 와 같은 반영을 하고 push `report` 를 보낸다. 다만 요청한 연결이 곧 서버이므로 옛 서버 검사는 하지 않는다.

**서버 — 거울 모드.** 데몬이 `attention` 을 말하면 `AttnTracker` 는 거울이다. 이 판단은 부를 때마다 한다. 다시 붙은 데몬이 옛 판일 수 있기 때문이다.

| 자리 | 거울 모드 | 옛 데몬 (종전) |
|---|---|---|
| 출력(`FeedOutput`) | 마지막 출력 시각만 적는다 | 판정한다 |
| 유휴 스위퍼 | 아무것도 하지 않는다 | 판정한다 |
| 판정 뒤 데몬 되쓰기(`onChange`) | 하지 않는다 | 쓰기 큐로 쓴다 |
| push `attn` | 상태를 되세우고 `kind` 대로 방송한다 | 오지 않는다 |
| HTTP 활동·알람 보고 | 검사한 뒤 `report` 로 데몬에 넘긴다 | 서버가 판정한다 |
| push `report` 의 활동·알람 | 판정하지 않는다. 나머지(서브에이전트·SSE 정리·대기 깨우기)만 한다 | 판정한다 |
| 알람 해제·전부 해제 | `attend`·`attendall` 로 데몬에 보낸다 | 서버가 해제한다 |

- push `attn` 은 읽기 루프에서 바로 반영한다. 반영은 데몬 RPC 를 하지 않는다. 데몬은 보고를 반영하며 `attn` 을 먼저 보내고 `report` 를 뒤에 보낸다. 그래서 서버가 보고를 처리할 때 거울은 이미 바뀌어 있다.
- `activity` 는 카드가 같아도 방송한다. 직접 모드의 `onActivity` 가 보고마다 방송하는 것과 같다.
- 마지막 출력 시각은 서버가 계속 적는다. 데몬은 출력마다 push 하지 않는다. `quietMs` 와 준비 판정이 그 값을 읽는다.
- HTTP 보고를 데몬에 넘기지 못하면 로그를 남기고 서버가 판정하지 않는다. 도구가 없다는 답은 종전처럼 200 무동작이다. 연결 오류는 503 이다.
- `attnconfig` 는 서버가 (다시) 붙을 때 기록 스냅샷보다 먼저 보낸다. 값은 서버가 읽은 환경변수(`DONGMINAL_ATTENTION_IDLE_MS`·`DONGMINAL_ATTENTION_BELL`)다.
  - FR-ARD-31 의 "바뀔 때" 는 없다. 두 값은 설정 화면이 없고, 서버가 뜰 때 한 번 읽는다.
  - 붙을 때마다 보내므로, 다른 환경으로 다시 뜬 서버의 값이 데몬에 간다.

**옛 서버 (NFR-ARD-3):** 새 데몬은 판정하지만 push 를 보내지 않는다. 단계 2 의 서버는 지금처럼 스스로 판정하고 그 결과를 `recordset` 으로 데몬에 덮어쓴다. 지금보다 나빠지지 않는다.

**단계 1 의 틈 (§3.1a) 이 닫힌다.** 거울 모드에서 `agent` 기록은 서버가 쓰지 않는다. 데몬이 먼저 바뀌고 서버가 그 결과를 받는다 (FR-ARD-11 의 순서).

**시험용 표면** (`toolhub`): 데몬 시험이 PTY 없이 판정을 재려면 두 가지가 필요하다.

- `ToolManager.AdoptDetached(id)`: 관리자의 알림을 실은 PTY 없는 도구
- `Tool.ObserveOutput(chunk)`: readPTY 가 하는 관측 그대로

### 3.4 단계 4 — 생존 판정 (묶음 L)

- **FR-ARD-1** 데몬 모드의 생존 질의는 `alive`·`dead`·`unknown` 셋 중 하나로 답한다. `dead` 는 확인된 죽음일 때만이다. 데몬이 목록에 답하지 못하면 `unknown` 이다 (`ListOK` 의 ok).
- **FR-ARD-2** 생존을 묻는 자리는 `unknown` 을 아래와 같이 다룬다.

  | 자리 | `unknown` 일 때 |
  |---|---|
  | Run 수거(`ReapTargets`·`reapRuns`) | 그 Run 을 대상에서 뺀다 |
  | 사용량·서브에이전트 수거(`prune`) | 지우지 않는다 |
  | 알람 생존 검사(`SetLiveProbe`) | 알람을 거르지 않는다. 종전에는 `unknown` 을 죽음으로 읽어 걸렀다 |
  | `dmctl status` 의 `live` | `false` 로 답하되 `liveUnknown: true` 를 더한다 |

- **FR-ARD-3** **데몬 모드에서** Run 의 **열림**은 저장하지 않는다. 서버 시작 때 Run 을 `aborted` 로 바꾸는 펜싱(`fenceStale`)을 없앤다. 직접 모드는 서버가 다시 뜨면 에이전트도 끝났으므로 종전처럼 열린 Run 을 `aborted` 로 닫는다 (§1.2, §3.4a). 명시적으로 닫힌 상태(`run close`·성공·실패 보고·사용자 삭제)만 `runs.json` 에 저장한다.
- **FR-ARD-4** 응답(`/api/runs`·`run status`)의 Run 마다 `liveness` 를 계산해 싣는다.
  - 명시적으로 닫혔으면 싣지 않는다.
  - 멤버나 조정자 중 하나라도 `alive` 면 `open` 이다.
  - 모두 확인된 죽음이면 `gone` 이다.
  - 그 밖에는 `unknown` 이다.
- **FR-ARD-5** 수거의 자동 제거는 조정자가 **확인된 죽음**일 때만 한다.
- **FR-ARD-6** (철회 — D-ARD-10) 맥락 경고 통지 기록(`contextNotices`)은 멤버 기록의 필드(`contextNotified []string`, 등급 목록)로 `runs.json` 에 둔다. 조정자 몫은 Run 의 조정자 맥락 상태에 같은 필드로 둔다.
- **FR-ARD-7** 옛 `runs.json` 의 `epoch` 와 `aborted`(`AbortDaemonRestart`)는 읽을 수 있어야 한다. `epoch` 는 새로 쓰지 않는다. `aborted`(`AbortDaemonRestart`)는 직접 모드만 새로 쓴다 (FR-ARD-3).

### 3.4a 단계 4 설계

**서버 코드만 바꾼다.** 데몬과 와이어는 바뀌지 않는다. 그래서 데몬을 다시 띄우지 않아도 적용된다.

**세 값의 계산 (FR-ARD-1).** 새 인터페이스는 만들지 않는다. `ToolHub.ListOK()` 가 이미 "아는가"를 답한다(FR-TLU-2).

| 자리 | 계산 |
|---|---|
| httpapi `Server.toolLiveness(id)` | `Tools.ListOK()` 의 ok 가 거짓이면 `unknown`. 아니면 종전 `toolLive`(`ToolIO.Has`)가 참이면 `alive`, 거짓이면 `dead` |
| 조립 `attnLiveProbe(hub)` (알람 생존 검사) | `ListOK()` 의 ok 가 거짓이면 참(막지 않는다). 아니면 목록에 있으면 참 |

- 직접 모드의 `ListOK` 는 언제나 ok 다. 그래서 직접 모드에서는 `unknown` 이 나오지 않고 동작이 같다.
- `ListOK` 는 200ms 캐시를 딛는다(GO-6). 같은 요청 안의 반복 질의는 RPC 를 다시 하지 않는다 (R-5).

**FR-ARD-2 의 네 자리**

| 자리 | 바꾸는 것 |
|---|---|
| Run 수거 | `Store.ReapTargets(dead)` 로 바꾼다. 인자는 "확인된 죽음인가"다. 열린 Run 은 `dead(조정자)` 일 때만 대상이다 (FR-ARD-5). `dead` 가 nil 이면 열린 Run 은 대상이 아니다. 끝난 Run(closed·aborted)은 종전처럼 대상이다 |
| `prune` 셋 | 함수 모양은 그대로다. 넘기는 질의를 `toolLive` 에서 "`dead` 가 아니다"로 바꾼다. 수거 틱의 몸은 `reapTick` 으로 떼어 시험한다 |
| 알람 생존 검사 | `SetLiveProbe(attnLiveProbe(toolHub))`. `unknown` 이면 알람을 거르지 않는다. 종전에는 `IsLive` 가 거짓이라 걸렀다 |
| `dmctl status` | 응답 `toolStatus` 에 `liveUnknown` 을 더한다(`omitempty`). `unknown` 이면 `live:false, liveUnknown:true` 다. `dmctl status` 의 글 출력은 그때 `live=unknown` 이라 쓴다 |

- `dmctl wait`(`/api/tools/activity/wait`)는 같은 `toolStatus` 를 쓴다. `liveUnknown` 이면 `gone` 으로 끝내지 않고 계속 기다린다. 다음 생존 확인(1초)에서 다시 판정한다. 시한이 지나면 종전처럼 `timeout` 이다.
- 나머지 `toolLive` 자리는 표에 없으므로 그대로 둔다. 예: 멤버 상태 판정(`lost`), 헤드리스·close·tree·assign·peer.

**펜싱을 없앤다 (FR-ARD-3·7) — 데몬 모드만**

- `Store.Load` 는 파일을 읽기만 한다. `fenceStale`·`runHasLiveMember`·`WithLiveness`·`Store.alive` 를 지운다.
- `Store.epoch` 와 `NewStore` 의 `epoch` 인자를 지운다. 쓰는 곳이 `Start` 가 새 Run 에 `Epoch` 를 적는 것뿐이고, FR-ARD-7 은 새로 쓰지 말라고 한다.
- `Record.Epoch` 필드와 `AbortDaemonRestart` 상수는 남긴다. 옛 기록을 읽고, 다시 저장할 때 그 값을 지우지 않기 위해서다.
- **직접 모드는 종전 결과를 지킨다 (§1.2).** 새 옵션 `run.WithAbortOpenOnLoad()` 를 직접 모드만 쓴다(`newRunStore` 가 `toolHub.Daemon() == nil` 로 가른다). `Load` 가 열린 Run 을 모두 `aborted`(`AbortDaemonRestart`)로 저장한다.
  - 근거: 직접 모드에서는 서버가 곧 도구를 들고 있어, 서버가 다시 뜨면 에이전트가 실제로 죽는다. 도구는 `LoadAll` 로 빈 셸만 되살아난다. 펜싱을 없애면 그 빈 셸이 `alive` 로 보여 Run 이 `open`, 멤버가 `starting` 으로 영원히 남는다.
  - 종전 펜싱도 직접 모드에서는 Run 을 모두 닫았다. `Load` 가 `LoadAll` 보다 먼저 돌아 생존 질의가 언제나 거짓이었기 때문이다. 그래서 epoch 없이 "열린 것 전부"로 같은 결과를 낸다.
  - FR-ARD-3·7 은 이 구분을 따라 고쳤다 (2026-11-10, 사용자 확인).
- **데몬 모드의 결과.** 서버가 다시 떠도 열린 Run 은 열린 채다. 조정자가 확인된 죽음이면 15초 수거가 지운다. 조정자가 없는 Run(`CoordinatorToolID` 가 빈 값)은 수거 대상이 아니므로(FR-DEL-15) 열린 채 남는다. 목록에는 `liveness` 로 보이고, 사용자가 닫거나 지운다 (D-ARD-4).

**Run 의 liveness (FR-ARD-4).** `runView` 에 `liveness` 를 싣는다(`omitempty`). `viewOf` 가 계산하므로 `/api/runs`·`/api/runs/{id}`·`run status` 가 함께 받는다.

- `State != open` 이면 비운다.
- 조정자와 멤버의 도구 id 를 모은다(빈 값은 뺀다). 하나라도 `alive` 면 `open` 이다.
- 모두 `dead` 면 `gone` 이다.
- 그 밖은 `unknown` 이다. **도구 id 가 하나도 없으면 `unknown`** 이다. 근거 없이 죽음으로 읽지 않는다 (FR-DEL-15 와 같은 원칙).

**contextNotices 는 영속하지 않는다 (FR-ARD-6 철회, D-ARD-10)**

- 통지 기록은 종전처럼 서버 메모리(`contextNoticeLog`)에 둔다. `runs.json` 에 쌓지 않는다.
- 서버가 다시 떠도 멤버의 등급(`contextLevel`)은 저장돼 있다. 경고는 등급이 저장된 값보다 오를 때만 가므로, 재기동만으로는 다시 가지 않는다. 다시 가는 것은 재기동 뒤 등급이 내려갔다 다시 오른 경우뿐이다.
- `handlers_runs_context.go` 의 "영속하지 않는 이유" 주석은 펜싱을 근거로 들었다. 데몬 모드에서는 틀린 말이 되므로 D-ARD-10 으로 고친다.

**시험 (TC-ARD-1~4)**

| TC | 자리 | 내용 |
|---|---|---|
| TC-ARD-1 | httpapi `toolLiveness`, 조립 `attnLiveProbe` | 목록 답함(있음·없음)·답하지 않음(`fakeUnknownHub`) → `alive`·`dead`·`unknown`. 알람 검사는 `unknown` 에서 참 |
| TC-ARD-2 | run `ReapTargets`, httpapi `reapTick` | `unknown` 동안 Run·사용량·서브에이전트가 남는다. `dead` 가 되면 지워진다 |
| TC-ARD-3 | run `Load` | 지난 epoch 의 열린 Run 이 열린 채고 파일이 바뀌지 않는다. 옛 `aborted`·`epoch` 가 그대로 읽힌다. 새 Run 은 `epoch` 를 쓰지 않는다. 직접 모드(`WithAbortOpenOnLoad`)는 열린 Run 을 `aborted` 로 저장한다 |
| TC-ARD-4 | httpapi `/api/runs`·status·wait | `open`·`gone`·`unknown`·닫힌 Run 은 필드 없음. status 의 `liveUnknown`. wait 가 `unknown` 에서 `gone` 을 내지 않는다 |

### 3.5 비기능

- **NFR-ARD-1** 훅 보고 한 번은 종전 시한 안에 끝난다. 보고 소켓은 에이전트를 막지 않는다.
- **NFR-ARD-2** 보고 소켓은 PTY 를 조작하는 메서드를 받지 않는다 (FR-ARD-21). 권한은 서버 연결 소켓과 같은 0700 폴더다.
- **NFR-ARD-3** 옛 데몬·옛 서버와 섞여도 지금 동작보다 나빠지지 않는다 (FR-ARD-14 · FR-ARD-23).
- **NFR-ARD-4** 단계마다 따로 커밋하고, 단계마다 Go·JS 시험·`make gates`·lint·관련 e2e 를 통과한다.
- **NFR-ARD-5** 데몬을 다시 띄워야 하는 단계(1·2·3)는 커밋 메시지와 보고에 그 사실을 적는다.

## 4. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-ARD-1 | 에이전트 기록은 데몬이 먼저 받아 저장하고 서버로 보낸다 | 사용자 결정. 터미널과 에이전트를 가진 것이 데몬이므로 기록의 수명이 에이전트와 같아진다 |
| D-ARD-2 | 데몬이 드는 기록은 FR-ARD-10 전부다 | 사용자 결정 ("전부") |
| D-ARD-3 | 알람 판정도 데몬으로 옮긴다 (단계 3) | 사용자 결정. 출력을 가장 먼저 보는 것이 데몬이다 |
| D-ARD-4 | Run 기록은 `runs.json` 에 두고, 열림은 저장하지 않고 물을 때마다 계산한다 | 사용자 결정. 저장하면 순간의 오판이 영구가 된다 (§2.2). 보고·메시지·worktree 는 에이전트가 죽은 뒤에도 필요하다 |
| D-ARD-5 | `contextNotices` 는 Run 멤버 기록에 둔다 — **D-ARD-10 으로 철회** | 사용자 결정. 그 수명은 도구가 아니라 Run 이다 |
| D-ARD-6 | 훅 보고는 서버 연결과 다른 보고 소켓으로 받는다 | 데몬은 연결을 하나씩 받는다 (IPC-24). 받는 메서드를 넷으로 좁혀 PTY 권한을 열지 않는다 |
| D-ARD-7 | 샌드박스 창은 서버 HTTP 를 거쳐 데몬에 닿는다 | 데몬 소켓을 컨테이너에 열면 모든 터미널을 조작할 수 있다 |
| D-ARD-8 | 데몬 판정은 직접 모드의 `toolhub.Tool` 코드를 그대로 쓴다 | 같은 판정을 두 벌(`Tool`·`AttnTracker`)로 두면 한쪽만 고쳐진다 (FR-ATN-14 의 같은 근거) |
| D-ARD-9 | 데몬 이관(단계 1~3)을 먼저 하고 생존 판정(단계 4)을 마지막에 한다 | 사용자 결정 (2026-11-10): "기존 서버 저장이 데몬으로 간 것이 중요하다" |
| D-ARD-10 | `contextNotices` 는 영속하지 않는다 (D-ARD-5·FR-ARD-6 철회) | 사용자 결정 (2026-11-10): "컨텍스트 사용량 경고는 중요한 로그가 아니다". `runs.json` 에 쓸데없는 기록이 쌓인다. 등급은 이미 저장되므로 재기동만으로는 경고가 다시 가지 않는다 |
| D-ARD-11 | push `record` 를 없앤다 (FR-ARD-12 철회) | 단계 2 는 보고를 push `report` 로, 단계 3 은 판정 결과를 push `attn` 으로 넘긴다. 데몬 안에서 기록을 바꾸는 다른 쓰기가 없어 보내는 곳이 없었다(`PutRecord` 는 부르는 곳이 없었다). 받는 코드(`SetOnRecord`·`ApplyRecord`)와 와이어(`EventRecord`·`RecordEvent`)를 함께 지운다 (2026-11-10, 사용자 확인) |

## 5. 검증 (Verification)

| TC | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-ARD-1 | FR-ARD-1 | Go: 가짜 데몬이 목록에 답함(도구 있음/없음)·답하지 않음 | `alive`·`dead`·`unknown` |
| TC-ARD-2 | FR-ARD-2·5 | Go: 생존이 `unknown` 인 동안 수거 실행 | Run·사용량·서브에이전트가 남는다. `dead` 가 되면 그때 정리된다 |
| TC-ARD-3 | FR-ARD-3·7 | Go: 지난 epoch 의 열린 Run 이 든 `runs.json` 을 읽음 | `aborted` 로 바뀌지 않고 저장도 바뀌지 않는다. 옛 `aborted` 레코드는 그대로 읽힌다 |
| TC-ARD-4 | FR-ARD-4 | Go: 멤버 생존 조합별 `/api/runs` | `open`·`gone`·`unknown`, 닫힌 Run 은 필드 없음 |
| TC-ARD-5 | FR-ARD-6 | 철회 (D-ARD-10). 시험하지 않는다 | — |
| TC-ARD-10 | FR-ARD-10 | Go(데몬): 기록 쓰기·도구 종료 | 종료 뒤 기록이 없다. push `record` 는 철회했다 (D-ARD-11) |
| TC-ARD-11 | FR-ARD-11·13 | Go: 서버가 쓰기 → 연결을 끊고 새 서버가 붙음 | 새 서버의 거울이 같은 값이다. 스냅샷 반영 때 알람 방송이 없다 |
| TC-ARD-12 | FR-ARD-14 | Go: `records` 를 말하지 않는 데몬 | 종전 동작 그대로 |
| TC-ARD-20 | FR-ARD-20·21·22 | Go(데몬): 보고 소켓에 넷과 다른 메서드, 없는 도구 | 넷만 받고 나머지와 없는 도구는 거절. 서버 연결이 있어도 동시에 받는다 |
| TC-ARD-21 | FR-ARD-23 | Go: 보고 소켓 있음/없음/실패 | 소켓 → 성공 / HTTP 로 감 / HTTP 로 감. 시한을 넘지 않는다 |
| TC-ARD-22 | FR-ARD-25 | Go: 서버 없이 보고 → 서버 붙음 | 스냅샷에 그 보고가 반영돼 있다 |
| TC-ARD-23 | §3.2a | Go: 서버가 `report` push 를 받음 | HTTP 로 받은 것과 같은 거울·방송이다. done 보고는 알람을 울린다 |
| TC-ARD-24 | §3.2a 옛 서버 | Go(데몬): `reports` 를 말하지 않는 서버가 붙은 채 보고 | 거절한다. 데몬 기록은 바뀌지 않는다 |
| TC-ARD-30 | FR-ARD-30~33 | Go: 실제 데몬·클라이언트·거울 추적기. 출력의 알림 시퀀스, 보고 소켓의 done, 해제, 유휴 | 직접 모드와 같은 알람·사유·해제가 서버에서 방송된다. 서버는 판정하지 않는다 |
| TC-ARD-31 | §3.3a 데몬 | Go(데몬): push `attn` 의 조건, `attend`·`attendall`·`attnconfig`·`report` | `attention` 을 말한 서버에만 보낸다. 해제·설정·보고가 데몬 `Tool` 에 반영된다 |
| TC-ARD-32 | §3.3a 설정 | Go(toolhub): `SetAttentionConfig` 뒤 기존 도구, 문턱 0 으로 시작한 스위퍼 | BEL 허용이 기존 도구에 적용되고, 문턱을 준 뒤 유휴가 판정된다 |
| TC-ARD-33 | §3.3a 거울 | Go(hub): 거울 모드의 출력·스위퍼·push `attn` | 판정과 되쓰기가 없고, push 대로 방송한다 |
| TC-ARD-34 | §3.3a 서버 | Go(httpapi): 거울 모드의 HTTP 활동·알람 보고, 해제, push `report` | 보고·해제는 데몬으로 가고 서버는 판정하지 않는다. 옛 데몬이면 종전 그대로다 |
| TC-ARD-40 | 전체 | 수동: 에이전트가 도는 중 서버만 다시 시작 | 카드·알람·사용량·서브에이전트·Usage 바닥이 그대로 보이고, Run 이 열린 채다. 서버가 꺼진 동안 끝난 턴은 done 으로 보인다 |

## 6. 비목표 (Non-goals)

- 데몬이 다시 뜰 때 기록 보존. 데몬이 끝나면 에이전트도 끝나므로 기록도 함께 사라지는 것이 옳다
- 서버가 꺼져 있던 동안의 알람을 나중에 울리기 (FR-ARD-25)
- 직접 모드의 구조 변경
- Run 기록을 데몬으로 옮기기 (D-ARD-4)
- 브라우저 조정 상태(`attnSeq`·`attnClaims`)와 원격 요청 잠금(`peerGate`)의 보존. 에이전트 기록이 아니다
- 샌드박스 창의 보고를 서버 없이 데몬에 닿게 하기 (D-ARD-7)

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 단계 3 은 알람 판정의 자리를 옮긴다. 미묘한 동작 차이가 생길 수 있다 | HIGH | D-ARD-8 로 한 벌의 코드만 쓴다. 기존 알람 시험을 데몬 모드로 함께 돌린다 (TC-ARD-30). 단계 3 은 따로 커밋한다 |
| R-2 | 단계 1·2·3 은 데몬을 다시 띄워야 적용된다. 그때 터미널 세션이 끊긴다 | MEDIUM | 기능 협상으로 옛 데몬과도 동작한다 (NFR-ARD-3). 단계마다 알린다 |
| R-3 | 보고 소켓이 새 진입점이 된다 | MEDIUM | 메서드 넷만 받고 PTY 권한이 없다. 0700 폴더다. 살아 있는 도구의 보고만 받는다 |
| R-4 | push 가 늘어 서버 연결이 붐빈다 | LOW | 기록 push 는 작고 드물다(훅·statusLine 주기). 출력 push 와 같은 큐를 쓰되 버리지 않는다 |
| R-5 | Run 의 열림을 계산하면 `/api/runs` 가 생존을 묻는다 | LOW | 목록은 짧은 TTL 캐시를 딛는다 (`GO-6`). 요청 하나에 list RPC 하나다 |
| R-6 | 사용자가 겪은 "Run 이 죽음" 의 원인이 §2.2 가 아닐 수 있다 | LOW | 단계 4 뒤에도 재현되면 로그(`[run] 자동 제거`)로 다시 본다 |
