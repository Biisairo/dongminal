# SRS: 직접 모드 제거 — 서버는 늘 데몬에 붙는다 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **남은 것**: 없음. 범위 밖으로 남긴 정리 하나는 §7 이다 (데몬 쪽 `toolhub.Tool` 의 프로세스 안 클라이언트 팬아웃)
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
- 바꾼 사용자 문구: `dongminal health` 의 소켓 부재 안내 `(direct mode 이거나 미기동)` → `(미기동)` (CLI_CONSOLIDATION_SRS FR-ACT-10 개정).

## 7. 범위 밖으로 남긴 것

| 항목 | 상태 | 까닭 |
|---|---|---|
| `toolhub.Tool` 의 프로세스 안 클라이언트 팬아웃(`AddClientAt`·`RemoveClient`·`broadcast`·`cls`, `SafeConn` 송신 큐·`StartSender`) | 프로덕션 호출처가 없어졌다(유일한 호출처가 `handleWSDirect` 였다). 데몬 안에서는 구독자가 없어 빈 갈래로 돈다 | 데몬 쪽 PTY 출력의 뜨거운 경로(`feedAndDeliver`·`kill`·크기 통보)와 성능 시험(`readpty_hotpath_test` 등)에 얽혀 있다. 서버의 직접 모드 제거와 따로 검증해야 하는 데몬 내부 정리라 별도 작업으로 둔다. `toolhub` 의 남은 "직접 모드" 주석도 그때 함께 고친다 |
