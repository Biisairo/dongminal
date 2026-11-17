# 인계: PEER_DAEMON 단계 3~5

> 진실은 `docs/internal/PEER_DAEMON_SRS.md` 다. 이 문서는 그 SRS 를 구현하는 세션의 착수 지시와 맥락이다.
> 다음 일감은 `docs/internal/PEER_CHAT_SRS.md` 다(§5).

## 1. 착수 블록

1. `git status` 로 작업 트리가 깨끗한지 확인한다. 브랜치는 `feat/peer-daemon` 이다.
2. `PEER_DAEMON_SRS.md` 전체와 이 문서 §3(조사 결과)·§4(배운 것)를 읽는다.
3. **단계 3(묶음 N) 설계를 SRS §3.3 아래에 "§3.3a 단계 3 설계"로 먼저 적는다.** 그다음 Spec → Test(RED 확인) → Code → `make gates`·`make lint`·`go test ./...` 순서로 진행한다.
4. 단계 3 → 4 → 5 순서로 진행한다. 단계마다 검사가 통과하면 **묻지 말고 커밋**한다.

## 2. 사용자 지시

- 단계마다 검사를 통과하면 스스로 커밋하고 계속 진행한다. 구현상 결정이 필요할 때만 묻는다(권장 답과 함께, 한 번에 하나).
- **데몬과 서버를 재시작하지 않는다.** 사용자가 PEER_DAEMON 구현이 모두 끝난 뒤 직접 재시작하고 테스트한다.
- 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다. push 하지 않는다.
- 컨텍스트가 차면 `/dongminal:migration` 으로 넘긴다. 이 문서를 고쳐 넘긴다.
- 문서와 코드가 다르면 코드를 따르고, 끝난 뒤 보고한다.

## 3. 현재 상태

| 단계 | 상태 | 커밋 |
|---|---|---|
| SRS 두 개 | 초안 작성 | `a2aa00b5` (main) |
| 1. 패키지 이동 `internal/webserver/domain/peer` → `internal/shared/peer` | 끝 | `42611bb4` |
| 2. 통로 부품 `internal/shared/peerrelay` | 끝 | `f6f9c4ab` |
| 3. 데몬의 노드 처리 | **다음** | |
| 4. 서버 ↔ 데몬 요청 | | |
| 5. 옛 코드 제거·문서 | | |

### 3.1 단계 2 에서 만든 것

- `peerrelay.NewPort(nodeSock)` — 서버의 노드 포트. `Apply(enabled, bind, port)`·`Status()`·`Close()`. 받은 TCP 연결 앞에 프리앰블(`DMRELAY1 <출발지>\n`)을 붙여 노드 소켓에 잇는다. 노드 소켓이 없으면 연결을 닫는다.
- `peerrelay.ListenNode(path)` — 데몬의 노드 소켓 `net.Listener`. 프리앰블을 연결마다 따로 읽고, `RemoteAddr()` 를 원래 출발지로 바꾼 연결만 낸다.
- `peerrelay.ListenDial(path)` + `ServeDial(ln)` — 서버의 발신 소켓. `peerrelay.Dialer(path)` 는 `peer.Client` 에 넣는 `DialContext` 다.
- `peerrelay.NodeSocketPath(home)`·`DialSocketPath(home)` — 데몬 IPC 종단과 같은 폴더(0700).
- `peer.Listener.UseListen(f)` — TCP 대신 f 가 연 자리를 듣는다(데몬: `ListenNode`).
- `peer.NewClientVia(id, dial)` — 발신 소켓을 지나는 클라이언트.
- 종단 시험 `peerrelay/e2e_test.go`: 두 노드(서버 통로 + 데몬 리스너)로 실제 TLS 짝 판정·지문 고정을 확인한다.

**아직 하지 않은 배선**: 서버가 `Port`·발신 소켓을 기동하는 일, 데몬이 노드 소켓 위에 `peer.Listener` 를 띄우는 일. 노드 설정(`peers.json`)이 데몬에 있어야 하므로 단계 3·4 에서 한다. 서버는 노드 설정의 `enabled·bind·port` 를 데몬에게 받아(`peer` IPC 조회 또는 push) `Port.Apply` 에 넣는다.

### 3.2 의존성 조사 (2026-11-17, 분석 에이전트)

노드 명령이 기대는 서버 상태와 분류. a = 데몬에 이미 있음, b = 서버 전용(화면 요청으로 바꿔야 함), c = 순수 로직(옮기면 됨).

| 명령 | 쓰는 것 | 분류 |
|---|---|---|
| node.info (`httpapi/peer_commands.go:86-99`) | agentadapter, `peers.Config`, `s.cfg.Version` | a, c |
| agents.list (`:126-156`) | `ToolIO.List`, `Tools.Cwd`, `peerSpawns.Owner`; 창·탭 이름 `WorkIndex.Entries`; state `toolStatusOf` | a, c, **b**(이름) |
| message.send (`:159-212`) | `WorkIndex.ResolveStrict`(to·from), `ToolIO.Has`, `SendPasteIfForeground`, `peerGate`, `agentOfTool`, `peerEnvelope` | a, c, **b**(주소 해석 → 데몬 도구 목록으로 바꾼다, FR-PDM-24) |
| agent.spawn (`peer_spawn.go:36-139`) | agentadapter, `peer.DirAllowed`, `Tools.ListOK`, `peerSpawns` | a, c |
| └ 창 배치 | `Commands.BroadcastAndAwait("newWindow")`, `Focus.Executor` (`peer_spawn.go:201-220`) | **b** → 화면 요청 `window` |
| └ 헤드리스 | `createHeadlessTool` (`handlers_runs_headless.go:105-120`): `Tools.Create`·`SetBackground`(a), `broadcastLayout`(b) | a, b |
| └ 탭 배치 | `tabIDOfTool`, `broadcastLayout("restoreTool"/"renameTab")`, `awaitTab` (`:254`) | **b** → 화면 요청 `tab` |
| └ 첫 프롬프트 | `peerDeliverPrompt` (`:145-179`): `activityChanged`, `toolStatusOf`, `SendPasteIfForeground` | a, **b** → 데몬 `Tool` 활동으로 (FR-PDM-23) |
| agent.status (`:246-273`) | `toolLive`, `agentOfTool`, `toolStatusOf` → `attention()` | a, **b** → 데몬 `Tool` 활동 |
| agent.close (`:276-316`) | `peerSpawns`, `peerGate.close`, `Tools.Busy`, ExitCommand; `peerCloseTool`(`:320-336`) = `closeTab` 방송 + `Tools.Delete` | a, c, **b** → 화면 요청 `closeTab` |
| pair / pair/confirm (`peer_node.go:143-222`) | `pairing`, `peers.Store`, `peersChanged`(SSE), 속도 제한·lastSeen | c, **b** → push `peers` |

- 기동·종료: `Server.New` → `initPeer` (`server.go:301`, `peer_node.go:40-58`); `cmd/dongminal/app.go:229` `startPeerScoped` → `Server.StartPeer` (`peer_node.go:226-239`); 종료 `app.go:278` `closePeer()`.
- 설정 변경: `PUT /api/peers/node` → `apiPeersNodePut` (`peer_api.go:109-136`) → `peers.SetNode` + `peerLn.Apply`.
- 발신: dmctl → `/api/peers/call` (`peer_commands.go:215-273`), `/api/peers/add`·`approve` (`peer_api.go:220`, `:306`) 가 `peerClient.Call` 을 쓴다.
- 화면: 이벤트는 `peers_changed` 하나 (`peer_api.go:89-98`, 인자 `paired`). 소비는 `web/js/core/app-peers.js`, `app-settings-peers.js`, `state-registry.js:240-246`.
- 데몬 IPC: 메서드 목록 `shared/toolipc/protocol.go:20-52`, push `:55-62`, 기능 협상 `ServerFeatures`·`DaemonFeatures` (`:113-126`), 데몬 응답 `daemon/ipc/paned_handlers.go:63-84`. 느린 요청은 `goSlow` (`daemon/ipc/paned.go:170-183`). 서버 쪽 push 소비 `webserver/toolclient/client_push.go:19-34`.
- 데몬에 이미 있는 것: agentadapter, `pm.Create`(`paned_handlers.go:91`), 헤드리스 생성·백그라운드, `SendPasteIfForeground`(`paned_handlers.go:165-179`), 전경 티커(`boot.go:136-138`), 활동 상태(`daemon/ipc/report.go:115-127` `applyActivityReport`). 홈 파일 접근(`boot.go:33-34`, `:91-92`).
- `handlers_runs_peers.go` (`/api/runs/peers`)는 로컬 Run 동료 명부이며 원격과 무관하다. **옮기지 않는다.**
- 시험: `httpapi/peer_call_test.go`·`peer_pair_test.go`·`peer_notify_test.go`·`peer_node_test.go` 는 한 프로세스에 `newPeerNode` 둘(실 TLS). `peer_spawn_test.go`(875줄)·`peer_agents_test.go` 는 `peerFakeTools`·`newHeadlessHub`·`fakeWorkIndex`·`fakeCommandBroker`·가짜 에이전트 바이너리. `httpapi/daemon_integration_test.go` 가 실제 `ipc.NewPanedServer` 를 띄우는 하네스다.

### 3.3 단계 3 설계 방향 (제안 — SRS §3.3a 에 확정해 적는다)

- 명령 로직을 `internal/shared/peernode` 로 옮긴다(FR-PDM-2). 서버 전용 의존은 인터페이스로 받는다.
  - `Tools`: 목록·존재·cwd·busy·헤드리스 생성·삭제·전경 확인 붙여넣기·활동 상태·에이전트 판정. 데몬은 `toolhub.ToolManager` 로, 직접 모드는 서버의 도구 계층으로 구현한다(FR-PDM-52).
  - `Screen`: 화면 요청 넷(`names`·`window`·`tab`·`closeTab`). 데몬은 push `peerui` + `peeruidone`, 직접 모드는 함수 호출.
  - `Notify`: `peers` 변경 알림. 데몬은 push `peers`, 직접 모드는 SSE 방송.
- 원격 기동 기록은 메모리로 바꾸고 `peer-spawns.json` 은 처음 시작할 때 지운다(FR-PDM-25). `check-home-layout.sh`·`getting-started.md` 표·`backup` 에서도 뺀다.
- 감사 로그는 데몬 로그로 간다(FR-PDM-26).
- 시험은 지금 httpapi 의 시험을 peernode 쪽으로 옮겨, 가짜 `Tools`·`Screen` 으로 같은 기대를 확인한다(NFR-PDM-1).

## 4. 배운 것

- 유닉스 소켓 경로는 104바이트 상한이 있다. 시험에서 `t.TempDir()` 은 이름이 길어 넘는다. `os.MkdirTemp("", "짧은접두어")` 를 쓴다(`peerrelay/relay_test.go` `shortDir`).
- 시험에서도 `net.Dial("unix", …)` 를 직접 쓰면 게이트가 막는다. `platform.Current().IPC.Dial` 을 쓴다.
- 새 Go 패키지는 `docs/internal/architecture.md` 패키지 표에 올려야 `make gates`(pkg-axis)가 통과한다. 공유 패키지는 실행하는 프로세스 표시(②③ 등)를 붙인다.
- import 경로를 sed 로 바꾸면 import 정렬이 깨진다. `gofmt -w` 를 함께 돌린다.
- 데몬 IPC 종단 폴더에 두는 소켓(`report.sock`·`node.sock`·`dial.sock`)은 `check-home-layout.sh` 의 대상이 아니다(`filepath.Join(home, …)` 가 아니다).
- `httpapi` 패키지 시험은 70초 넘게 걸린다. 바꾼 패키지만 먼저 돌리고 마지막에 `go test ./...` 를 돈다.

## 5. 그다음: PEER_CHAT_SRS

`PEER_DAEMON` 이 끝나면 `PEER_CHAT_SRS.md` 로 넘어간다. **구현 전에 §9 미결(G-1·G-2·D-1·M-1~3·U-1·H-1·H-2)을 사용자와 하나씩 정해야 한다.** 미결을 정하기 전에는 구현하지 않는다. 결정은 SRS §4 에 D-PCH-21 부터 이어 적는다.

사용자가 정한 큰 원칙(다시 묻지 않는다):
- 노드 = 데몬. 채팅의 모든 상태는 데몬 메모리. 디스크 저장을 늘리지 않는다.
- 참가자 = 세션(`노드 + session_id + claude 프로세스`). MCP 연결이 끊기면 바로 퇴장, 다시 연결하면 새 참가자. 세션별로 아무것도 저장하지 않는다.
- 같은 노드 안의 세션끼리도 방을 만든다(FR-PCH-45).
- 사람 명령(강제 삭제·강퇴)은 관리자 권한 도우미 + TOTP, 매번 입력. 앱은 Ente Auth 권장. macOS 부터.
