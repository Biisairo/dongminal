# SRS: 직접 모드 제거 — 서버는 늘 데몬에 붙는다 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **남은 것**: 없음
> **입력**: 2026-11-18 사용자 지시와 결정. `CLEANUP_AFTER_EDGE_MESH_HANDOFF.md` 3단계.

## 1. 개요

### 1.1 목적

사용자 지시 (2026-11-18):

- *"직접 모드는 없는거야. 애초에 처음에 있던거 옮기면서 남아있는거잖아."*
- *"애초에 내가 직접모드, 데몬없는 서버만 가동하는걸 상정을 안했는데?"*

직접 모드(데몬 없이 웹 서버가 도구를 자기 프로세스에 두는 배선)는 지원 대상이 아니었다. 데몬을 나누기 전의 구조가
옮겨지며 남았고, 데몬에 붙지 못하면 서버가 조용히 그쪽으로 내려갔다. 이 문서는 그 경로를 전부 지운다.

### 1.2 범위

- 웹 서버(`cmd/dongminal`, `internal/webserver/**`)의 직접 모드 배선과 분기.
- 직접 모드를 표시하던 허브 표면(`toolhub.ToolHub.Daemon()`).
- 직접 모드 전제의 오류 코드·문구·문서.
- 서버 Go 시험의 배선 이전.

데몬(`internal/daemon/**`)은 범위 밖이다. 데몬은 `*toolhub.ToolManager` 를 구체 타입으로 쓰며 그대로 남는다.

### 1.3 용어

| 용어 | 뜻 |
|---|---|
| 데몬 | `dongminald`. 도구(PTY)를 소유한다 |
| 직접 모드 | 데몬 없이 웹 서버가 `ToolManager` 를 직접 들고 도구를 띄우던 배선. 이 문서로 없어진다 |
| 허브 | 웹 서버가 도구에 닿는 표면 `toolhub.ToolHub`. 구현은 `toolclient.ToolClient`(데몬 IPC) 하나다 |

## 2. 결정

| ID | 결정 | 근거 |
|---|---|---|
| D-DMR-1 | 데몬을 띄우지도 붙지도 못하면 서버는 원인을 로그에 남기고 종료 코드 1 로 끝난다 | 사용자 결정 2026-11-18 (권장안 "오류로 종료") |
| D-DMR-2 | 전면 제거다. in-process 허브 갈래와 `Daemon()==nil` 분기까지 지운다 | 사용자 결정 2026-11-18 ("전면 제거") |
| D-DMR-3 | `ToolHub` 는 `DaemonHub` 를 품고 `Daemon()` 을 없앤다. `ToolManager` 는 `ToolHub` 가 아니다 | 모드 판별 자리가 없어진다. 컴파일러가 남은 직접 배선을 찾아 준다 |
| D-DMR-4 | `Deps` 의 `EdgeDaemon`·`ChatDaemon`·`AttnTracker` 가 nil 이면 서버 안에서 대신하지 않는다 — 간선은 503, 채팅은 "데몬 준비 안 됨"과 같은 409, 주의·활동은 무동작이다 | nil 은 시험 배선뿐이다. 서버 안 노드와 도구 자신의 주의 상태(`directAttention`)가 직접 모드의 일부였다 |
| D-DMR-5 | 서버 시험은 시험 안에서 띄운 실제 데몬(`ipc.NewPanedServer` + `toolclient`)이나 가짜 허브로 배선한다 | 이미 `daemon_integration_test.go` 가 같은 배선을 쓴다 |

## 3. 요구

### 3.1 기동 (FR-DMR-1~3)

- **FR-DMR-1** 서버는 기동할 때 데몬에 붙는다. 붙지 못하면 데몬을 띄우고 기다린다(종전과 같다).
- **FR-DMR-2** 데몬을 띄우지 못했거나 기다림이 끝나도 붙지 못하면, 서버는 HTTP 리스너를 열지 않는다. 원인과 데몬 로그 위치를 로그에 남기고 종료 코드 1 로 끝난다.
- **FR-DMR-3** 직접 모드로 내려가는 갈래(`buildDeps`)는 없다.

### 3.2 허브 표면 (FR-DMR-10~12)

- **FR-DMR-10** `toolhub.ToolHub` 는 `DaemonHub` 의 메서드를 모두 가진다. `Daemon()` 메서드는 없다.
- **FR-DMR-11** `*toolhub.ToolManager` 는 `ToolHub` 를 구현하지 않는다. 웹 서버 프로덕션 코드는 `*toolhub.ToolManager` 를 쓰지 않는다.
- **FR-DMR-12** 직접 모드에서만 쓰이던 서버 쪽 배선은 없다: `hub.WireAttention`·`WireActivity`·`WireBackground`·`WireForeground`, 어댑터의 `PM` 갈래, `run.WithAbortOpenOnLoad`, 터미널 WS 의 직접 처리기(`handleWSDirect`·`directReplay`·`readWS`), 주의 서비스의 `directAttention`, 진단·헬스·전경 조회의 `Daemon()` nil 검사, 서버가 쓰던 `ToolManager.StartAttentionSweeper`·`SetBackgroundChanged`. 추적기가 없는 서버의 주의 서비스는 무동작(`noAttention`)이다.

### 3.3 간선·채팅·프로필 (FR-DMR-20~23)

- **FR-DMR-20** 서버는 자기 안에 간선 노드나 노드 포트를 세우지 않는다(`initEdge`·`edge_node.go` 의 직접 노드가 없다). 노드는 데몬이다.
- **FR-DMR-21** `/api/edges/*` 는 `EdgeDaemon` 이 없으면 503 `edge_unavailable` 이다. 데몬이 노드 기능을 모르면 종전대로 409 `edge_daemon_restart` 다.
- **FR-DMR-22** `/api/chat/*` 는 `ChatDaemon` 이 없거나 준비되지 않았으면 409 `chat_daemon_restart` 다. `chat_daemon_only` 코드는 없다.
- **FR-DMR-23** 프로필의 핸들은 `EdgeDaemon` 에게만 묻는다. 없거나 준비되지 않았으면 빈 값이다(종전 데몬 모드와 같다).

### 3.4 화면·문서 (FR-DMR-30~31)

- **FR-DMR-30** 웹 UI 에 직접 모드 안내(`chat.need_daemon`)는 없다.
- **FR-DMR-31** 직접 모드를 설계로 적은 문서(PEER_DAEMON_SRS D-PDM-11·FR-PDM-52 등)에 "지원 대상이 아니었다 — 2026-11-18 제거(이 문서)" 를 단다. 원문은 기록으로 남긴다.

## 4. 동작 변경

| 이전 | 새 | 이유 |
|---|---|---|
| 데몬에 붙지 못하면 로그 한 줄(`falling back to direct mode`) 뒤 서버가 도구를 직접 띄웠다 | 원인을 남기고 종료 코드 1 로 끝난다 | D-DMR-1 |
| 직접 모드에서 `/api/chat/*` 는 409 `chat_daemon_only` 였다 | 그 코드가 없다. 데몬이 준비되지 않으면 409 `chat_daemon_restart` | 직접 모드가 없다 |
| 직접 모드에서 재기동이 열린 Run 을 `aborted` 로 닫았다 | 닫지 않는다(데몬 모드의 종전 동작) | 직접 모드가 없다 |

데몬 모드의 사용자 동작은 바뀌지 않는다.

## 5. 검증

| ID | 요구 | 방법 |
|---|---|---|
| TC-DMR-1 | FR-DMR-2 | Go `cmd/dongminal/daemon_required_test.go`: 띄우기 실패·준비 안 됨 둘 다 `dialOrStartDaemonWith` 가 `errDaemonUnavailable` 을 낸다. `buildApp` 은 그 오류를 그대로 돌려주고 `serve` 는 리스너를 열기 전에 1 로 끝난다 |
| TC-DMR-2 | FR-DMR-10·11 | 컴파일: `var _ toolhub.ToolHub = (*toolclient.ToolClient)(nil)` 이 서고, `*toolhub.ToolManager` 는 `ToolHub` 가 아니다. 서버 프로덕션 코드의 `*toolhub.ToolManager` 참조는 0 이다 |
| TC-DMR-3 | FR-DMR-21 | Go `edge_node_test.go`: `EdgeDaemon` 없는 서버의 `GET /api/edges` 가 503 `edge_unavailable` |
| TC-DMR-4 | FR-DMR-22 | Go `chat_api_test.go`: `ChatDaemon` 없는 서버의 `/api/chat` 이 409 `chat_daemon_restart` |
| TC-DMR-5 | FR-DMR-20 | Go `edge_node_test.go`: 서버를 세워도 신원 파일·노드 포트가 없고, `StartEdge` 가 데몬 없이 곧바로 끝난다 |
| TC-DMR-6 | 전체 | `make test`·`make gates`·`make lint`·`make unit`·`typecheck`·e2e 전량 |

## 6. 진행 기록

- 2026-11-18 작성·구현. 시험 이전은 다음과 같다.
  - 서버 시험의 도구 배선은 시험 안에서 띄운 실제 데몬(`daemonPairAt` — `ipc.NewPanedServer` + `toolclient`)으로 옮겼다.
  - 간선 시험은 데몬 노드 위에 선다(`edgeDaemonNode`·`newEdgeNode` — 데몬 노드 + 그 데몬에 붙은 서버 + 노드 포트 통로).
    노드 처리기의 404 시험 둘은 `edgenode` 패키지로 옮겼다. 옛 파일 이전 시험은 `edge/migrate_test.go` 가 이미 지킨다.
  - 주의·활동·상태 시험은 도구(`Tool`) 대신 서버의 추적기로 상태를 세운다(`trackedTool`·`statusPane`). 다른 패키지의
    시험이 출력 시각을 정하도록 `hub.AttnTracker.SetClockForTesting` 을 더했다(NFR-5 의 주입 시계).
    시험 전용 공개 메서드이고 프로덕션 호출처는 없다. 공개로 남긴 이유: `httpapi` 의 상태 시험은 "몇 초 전 출력"이
    필요한데, `Server.attention()` 은 추적기를 바로 읽어 시계나 서비스를 바꿔 끼울 자리가 없고, `export_test.go` 는
    다른 패키지에서 보이지 않는다. 생성자 옵션으로 바꿔도 공개 표면은 같아서 바꾸지 않았다. 이름에 `ForTesting` 을
    붙여 시험 전용임을 드러낸다(사용자 결정 2026-11-18).
  - 지운 경로만 재던 시험은 지웠다: `directReplay` 여섯, 직접 모드 텔레그램 콜백, 헬스의 "데몬 없음", 상태의 직접·데몬
    동치, 직접 모드 Run 펜싱, 백그라운드 죽음 훅.
- 2026-11-18 시험 이전의 독립 리뷰(앞 판단에 묶이지 않은 리뷰어에게 diff 와 코드만 주었다). 지운 시험 26개 가운데 21개는
  코드와 함께 지워졌거나 다른 시험이 지킨다. 보호가 빠진 8건을 메웠다. 메운 시험마다 지키는 코드를 지워 보아 실패를 확인했다.
  - 도구 종료 push → 주의 버림·`tools_background_changed` 방송: `cmd/dongminal` `TestDaemonPushes_ExitForgetsAndBroadcastsBackground`
    (`wireDaemonPushes` 를 실제 데몬·클라이언트 위에서 부른다).
  - 텔레그램 알람 관찰자 배선: `TestTelegramWire_AttentionObserver` 를 추적기 위로 되살렸다.
  - `/api/health` 의 `daemon.connected`·`mismatch`: `TestHealthShape` 단언 + `TestHealthMismatch` 표 시험.
  - 서버가 멈추면 노드 포트가 닫힌다: `TestEdgeDaemonModeOpensPortAndReports` 끝 단언. 프로덕션 `boot.startEdge`(신원·노드
    소켓·닫기): `internal/daemon/boot` `TestStartEdge_IdentityAndNodeSocket`. 서버 시험의 데몬 노드 픽스처는 그 배선을 따로
    짜므로 프로덕션 배선은 이 시험이 잰다. `SetEdge`·`Mesh` 배선은 e2e `edges-settings` 가 실제 바이너리로 덮는다.
  - `edgenode.New` 의 peers.json 이전: `TestNewMigratesLegacyFile`.
  - 활동·주의 해제 방송의 내용(개수만 재던 단언을 `args` 로): `TestApiToolActivitySet`·`TestApiToolAttentionClear`.
  - 실제 데몬에 없는 도구의 `SendPaste`·`SnapshotTool` 오류: `toolclient` `TestToolClientUnknownToolErrors`.
  - 상태 시험의 `outputClock.Store` 가 유휴 무장도 세운다는 부작용을 주석에 적었다.
- 2026-11-18 §8 구현. `tool_clients.go` 와 `SafeConn` 송신 큐를 지웠다. `kill` 은 클라이언트 `OpExit` 을,
  `notifySize` 는 `broadcast` 를 더 하지 않는다. `feedAndDeliver` 는 릴레이용 사본만 만든다(할당 수 그대로: 릴레이 없음 0,
  있음 1). 함께 지운 무호출 표면(FR-DMR-47): `ToolManager.AttentionIDs`·`SetOutputObserver`·`SetExitObserver`,
  `ToolHooks.OnOutput`. 지운 시험: 클라이언트 프레임 순서·`SafeConn` 큐만 재던 여덟(`concurrency_invariants_test.go` 는
  통째로). 옮긴 불변식: "느린 소비자가 읽기 루프를 세우지 못한다" → `ipc` `TestPushOutputDropsWhenQueueFull`(`droppable`
  을 false 로 바꾸면 실패함을 확인). 패닉 시험은 릴레이 `onExit` 로 남겼다. `toolhub`·`internal/daemon`·서버 시험의 "직접 모드"
  주석을 고쳤다(남은 것은 제거 기록 둘).
- 바꾼 로그 문구: 조립 실패의 기본 갈래 `buildDeps: …` → `buildApp: …` (`buildDeps` 는 지워졌다).
- 바꾼 사용자 문구: `dongminal health` 의 소켓 부재 안내 `(direct mode 이거나 미기동)` → `(미기동)` (CLI_CONSOLIDATION_SRS FR-ACT-10 개정).

## 7. 범위 밖으로 남긴 것

| 항목 | 상태 | 까닭 |
|---|---|---|
| `toolhub.Tool` 의 프로세스 안 클라이언트 팬아웃(`AddClientAt`·`RemoveClient`·`broadcast`·`cls`, `SafeConn` 송신 큐·`StartSender`) | §8 에서 지웠다(2026-11-18) | 데몬 쪽 PTY 출력의 뜨거운 경로(`feedAndDeliver`·`kill`·크기 통보)와 성능 시험(`readpty_hotpath_test` 등)에 얽혀 있다. 서버의 직접 모드 제거와 따로 검증해야 하는 데몬 내부 정리라 별도 작업으로 두었다 |

## 8. 후속 — `toolhub.Tool` 의 프로세스 안 팬아웃 제거

> 2026-11-18 사용자 지시(`CLEANUP_FOLLOWUP_HANDOFF.md` 할 일 3).

### 8.1 범위

`internal/shared/toolhub` 의 `Tool`·`SafeConn`, 그리고 그 둘을 서술하는 주석(`internal/daemon/ipc` 포함).
데몬의 IPC 출력 경로(`WireRelayOnce`·`panedConn.enqueue`)의 동작은 바꾸지 않는다.

### 8.2 요구 (FR-DMR-40~45·47)

- **FR-DMR-40** `Tool` 은 클라이언트 목록을 갖지 않는다. `AddClient`·`AddClientAt`·`RemoveClient`·`broadcast`·
  `enqueueAll`·`removeClients`·`cls` 가 없다.
- **FR-DMR-41** `readPTY` 의 청크 처리는 스트림 적재와 릴레이(`OnOutput`)만 한다. 릴레이가 없으면 청크 사본을 만들지
  않는다(할당 0). 릴레이가 있으면 청크당 사본은 하나다(종전 `TestHandleChunk_Allocs` 의 수치 유지).
- **FR-DMR-42** `kill` 은 클라이언트에 `OpExit` 을 보내지 않는다. 종료 통보는 릴레이의 `onExit`(데몬 push) 하나다.
- **FR-DMR-43** 크기 변화 통보(`notifySize`)는 `onSize` 훅만 부른다.
- **FR-DMR-44** `SafeConn` 은 동기 송신(`Send`·`WriteMsg`·`WritePing`)만 갖는다. 송신 큐(`Enqueue`·`StartSender`·
  `sendQueueCap`)는 없다. 서버의 터미널 WS 는 이미 `Send` 만 쓴다.
- **FR-DMR-45** `toolhub`·`internal/daemon` 의 주석에 직접 모드를 현재 배선으로 서술하는 문장이 없다. 판정을 두 곳이
  나눠 쓰는 서술은 "데몬의 `Tool`" 과 "서버의 `hub.AttnTracker`" 로 적는다.
- **FR-DMR-47** 호출처가 없는 직접 모드의 남은 표면은 없다: `ToolManager.AttentionIDs`(서버의 주의 목록은 `hub.AttnTracker` 가 답한다)·
  `SetOutputObserver`·`SetExitObserver`, `ToolHooks.OnOutput`(출력 릴레이는 데몬의 `WireRelayOnce` 하나다).

### 8.3 불변식의 이전 (FR-DMR-46)

- **FR-DMR-46** 팬아웃과 함께 지우는 시험이 지키던 불변식 가운데 데몬 경로에도 걸린 것은 데몬 쪽 시험으로 옮긴다.
  - "느린 소비자가 PTY 읽기 루프를 세우지 못한다"(`TestDeliver_SlowClientDoesNotBlockReadLoop`) → 데몬에서는
    `panedConn.enqueue(…, droppable=true)` 가 그 보장이다. 송신 큐가 찬 연결에 `pushOutputData` 가 막히지 않고 버린 수를
    센다는 시험을 `internal/daemon/ipc` 에 둔다(현재 그 시험이 없다).
  - 읽기 패닉이 도구를 죽이고 종료를 알린다(`TestTool_ReadPTYPanic_KillsAndSignalsExit`) → 클라이언트 단언을 빼고 릴레이의
    `onExit` 단언으로 남긴다.
  - 릴레이 쪽 시험(`TestHandleChunk_RelayDataNotOverwritten`·할당 시험의 relay 갈래·탐지기 참조 시험)은 남긴다.
  - 클라이언트 프레임 순서만 재던 시험(`TestKill_ExitFollowsQueuedOutput`·`TestHandleChunk_ConcurrentKillKeepsExitLast`·
    `TestTool_AddClientRejectedAfterExit`·`TestTool_BroadcastAddRemoveRace`·`SafeConn` 큐 시험 넷·`BenchmarkSafeConnSend` 의
    큐 갈래)은 지킬 동작이 없어지므로 지운다.

### 8.4 동작 변경

없다. 지우는 갈래는 데몬 안에서 구독자가 없어 늘 비어 있었다.

### 8.5 검증

| ID | 요구 | 방법 |
|---|---|---|
| TC-DMR-40 | FR-DMR-40·44 | 컴파일. `grep` 으로 지운 심볼의 참조 0 |
| TC-DMR-41 | FR-DMR-41 | `TestHandleChunk_Allocs`(plain·tui × relay 유무)·`TestFeedAndDeliver_NoClientsNoFrame` 통과 |
| TC-DMR-42 | FR-DMR-46 | 새 `internal/daemon/ipc` 시험: 큐가 찬 `panedConn` 에 `pushOutputData` 가 시한 안에 돌아오고 `dropped` 가 는다. 구현 전 시험 코드가 컴파일·통과하는지(동작은 이미 있음)와, `droppable` 을 false 로 바꾸면 실패하는지 확인한다 |
| TC-DMR-43 | FR-DMR-42 | `TestTool_ReadPTYPanic_KillsAndSignalsExit` 가 릴레이 `onExit` 로 통과 |
| TC-DMR-44 | 전체 | `go test ./...`, e2e `term-resume`·`term-held-input`·`reply-seat` 뒤 전량 |
