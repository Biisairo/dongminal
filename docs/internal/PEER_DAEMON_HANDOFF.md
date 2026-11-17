# 인계: PEER_DAEMON → PEER_CHAT

> 진실은 `docs/internal/PEER_DAEMON_SRS.md` 다. 이 문서는 그 SRS 를 구현하는 세션의 착수 지시와 맥락이다.
> 다음 일감은 `docs/internal/PEER_CHAT_SRS.md` 다(§5).

## 1. 착수 블록 (단계 4 리뷰 수정 → 간선 맺기 단순화)

1. `git status` 로 작업 트리가 깨끗한지 확인한다. 브랜치는 `feat/peer-daemon`, 직전 커밋은 `HEAD` 다.
2. **사용자 지시(2026-11-17): 두 일을 끝까지 쭉 진행한다.** 단계마다 검사(`make gates`·`make lint`·`npm run typecheck`·`go test ./...`·`npm run unit`)를 통과하면 커밋한다. 적용(데몬·서버 재시작·설치·e2e)·push 는 하지 않는다. 커밋에 AI 서명을 넣지 않는다.
3. **일 1 — 단계 4 독립 리뷰 수정**: 진실은 `docs/internal/PEER_CHAT_SRS.md` §3.12a(R-1~R-10)다. 각 항목을 시험 먼저(RED) 고친다. 묶어서 커밋해도 된다.
4. **일 2 — 간선 맺기·지우기 단순화**: 진실은 `docs/internal/EDGE_PAIRING_SRS.md` 다. 미결은 없다. §8 단계 E1~E4 순서로 Spec → Test → Code. 조사 결과(이름이 쓰이는 자리·영향받는 시험 목록)는 아래 §4.6 에 있다.
5. 둘 다 끝나면 두 SRS 상태를 "승인·구현완료"로 고치고 사용자에게 보고한다. 조율 에이전트는 없다 — 사용자에게 직접 보고한다.

## 2. 사용자 지시

- 단계마다 검사를 통과하면 스스로 커밋하고 계속 진행한다. 구현상 결정이 필요할 때만 묻는다(권장 답과 함께, 한 번에 하나).
- **사용 중인 데몬과 서버를 절대 건드리지 않는다.** 재시작·종료·그 포트를 쓰는 실행(e2e 포함)을 하지 않는다. 사용자가 PEER_DAEMON 구현이 모두 끝난 뒤 직접 재시작하고 테스트한다.
- 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다. push 하지 않는다.
- 컨텍스트가 차면 `/dongminal:migration` 으로 넘긴다. 이 문서를 고쳐 넘긴다.
- 문서와 코드가 다르면 코드를 따르고, 끝난 뒤 보고한다.

## 3. 현재 상태

| 단계 | 상태 | 커밋 |
|---|---|---|
| SRS 두 개 | 초안 작성 | `a2aa00b5` (main) |
| 1. 패키지 이동 `internal/webserver/domain/peer` → `internal/shared/peer` | 끝 | `42611bb4` |
| 2. 통로 부품 `internal/shared/peerrelay` | 끝 | `f6f9c4ab` |
| 3. 간선 축소 (명령·원격 메시지·원격 기동 제거) | 끝 | `457b2d4e` |
| 4. 이름 변경 peer → edge | 끝 | (이 커밋) |
| 5. 데몬이 노드 (서버는 통로·위임, 서버도 `edgenode` 사용) | 끝 | 5a `771719d5`, 5b `6ecbae5d` |
| 6. 문서·e2e | 문서 끝. e2e 는 사용자가 재시작 뒤 확인 | `088dd549` |
| PEER_CHAT 미결 해소 | 끝 (D-PCH-21~35) | `f4e361f7`, `f2cc6743` |
| PEER_CHAT 단계 1 (데몬의 채팅 핵심) | 끝 | 설계 `c7753b43`, Upgrade `0f08acc1`, 핵심 `a9793300`, 보안 수정 `0ab24a2c`·`1e688ca6`·`544e1800` |
| PEER_CHAT 단계 2 (MCP·알림) | 끝 | 설계 `25c63c88`, 데몬 소켓 `2099d28a`, MCP·shim·훅 `1b0bf128` |
| PEER_CHAT 단계 3 (화면) | 끝 | 설계 `10ff68a8`, 데몬 쪽 `37e8868e`, IPC `7cd67213`, 서버 `dcca46b2`, 화면 `8bda595f` |
| PEER_CHAT 단계 4 (사람 명령) | 끝 | 설계 `ab8edaa7`, 도우미·TOTP `cf9e2d5b`, 채팅 핵심·API `722354fa`, 보안 수정 `cc7ecc2a`, 화면 `280b0a6d`, 문서 (이 커밋) |

> 2026-11-17 사용자 결정으로 범위가 바뀌었다(SRS D-PDM-13~17). 아래 §3.2·§3.3 의 명령 관련 조사·설계는 낡았다. 명령이 없어지므로 화면 요청(`peerui`)도 없다.

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

- **e2e 를 돌리지 않는다. 사용 중인 서버·데몬에 닿는 명령(`dongminal start`·`stop`, e2e, 포트를 쓰는 실행)을 하지 않는다.** e2e 워커의 기본 포트는 58147 이었고 노드 포트 기본값과 같았다(`42c49710` 에서 60147 로 옮겼다). e2e 의 `start` 는 격리 모드가 아니라서 그 포트를 쥔 프로세스를 종료한다(`ctl/cli/start.go` `killPort`). 2026-11-17 에 이 경로로 사용자의 운영 서버가 내려갔다. 검증은 Go·JS 단위 시험과 `make gates`·`make lint` 로 한다.
- 단계 3 에서 데몬 paste 의 전경 조건을 지우며, 그 조건으로 paste 를 붙잡던 `daemon/ipc/paste_async_test.go` 를 시험용 자리 `pasteInto` 로 바꿨다.

- 유닉스 소켓 경로는 104바이트 상한이 있다. 시험에서 `t.TempDir()` 은 이름이 길어 넘는다. `os.MkdirTemp("", "짧은접두어")` 를 쓴다(`peerrelay/relay_test.go` `shortDir`).
- 시험에서도 `net.Dial("unix", …)` 를 직접 쓰면 게이트가 막는다. `platform.Current().IPC.Dial` 을 쓴다.
- 새 Go 패키지는 `docs/internal/architecture.md` 패키지 표에 올려야 `make gates`(pkg-axis)가 통과한다. 공유 패키지는 실행하는 프로세스 표시(②③ 등)를 붙인다.
- import 경로를 sed 로 바꾸면 import 정렬이 깨진다. `gofmt -w` 를 함께 돌린다.
- 데몬 IPC 종단 폴더에 두는 소켓(`report.sock`·`node.sock`·`dial.sock`)은 `check-home-layout.sh` 의 대상이 아니다(`filepath.Join(home, …)` 가 아니다).
- 지금 이름과 구조(단계 5 이후): 노드 = `internal/shared/edgenode`(`New`·`Admission`·`Handler`·`Do(op)`·`Store`·`Identity`·`Pairing`). 데몬은 `daemon/boot/edge.go` 가 세우고 `daemon/ipc/paned_edge.go` 가 IPC(`edge`·`edgeport`, push `edges`, 기능 `edge`)를 처리한다. 서버는 데몬 모드에서 `httpapi/edge_relay.go`(노드 포트·발신 소켓·재조회 큐), 직접 모드에서 `edge_node.go`(`initEdge`). `/api/edges/*` 접착은 `edge_api.go` 한 곳. 공용 도우미 `codeFail`·`readJSONBody` 는 `httpapi/codefail.go`. `httpreq`·`httpresp` 는 `internal/shared` 로 옮겼다. 이 문서 §3.1~3.3 의 옛 이름은 이 줄로 읽는다.
- `edge_*` 오류 코드의 주인은 `shared/edge/codes.go` 다. `apierr/codes_edge.go` 는 그 값을 쓴다. 새 코드는 `codes_doc.go` 에도 넣고 `go run ./scripts/gen-errors` 로 `errors.md` 를 다시 만든다.
- SRS 의 결정(D-)을 고치면 `go run ./scripts/gen-decisions` 로 `decisions.md` 를 다시 만들어야 `make gates` 가 통과한다.
- 데몬 hello 기능 목록을 바꾸면 와이어 골든 두 곳(`daemon/ipc/wire_typed_test.go`, `webserver/toolclient/wire_typed_test.go`)을 같이 고친다.
- 본문 상한 게이트(`check-body-limit.sh`)는 이름이 `r` 인 변수의 `.Body` 도 잡는다. 변수 이름을 바꾼다.
- CHANGELOG 에 python 으로 줄을 넣을 때 다음 판 머리(`## [1.3.4]`) 아래로 들어간 적이 있다. 넣은 뒤 `grep -n '^## '` 으로 자리를 확인한다.
- 사용자 지시: **적용(데몬·서버 재시작, 설치)은 하지 않는다. 사용자가 한다.** 단계마다 검사를 통과하면 묻지 않고 커밋한다. 구현상 결정만 묻는다. push 하지 않는다. 커밋에 AI 서명을 넣지 않는다.
- `main` 에는 이 브랜치와 별개로 `b2bbf84f`(claude shim 주입 메모리를 `--append-system-prompt` 로)가 있다. 사용자가 적용해 확인을 마쳤다.
- 이름 변경은 BSD sed 대신 perl(`\b` 지원)과 `gopls rename` 으로 했다. 화면의 `pn-` 접두어는 판 클래스와 겹치므로 일괄 치환하지 않는다.
- `httpapi` 패키지 시험은 70초 넘게 걸린다. 바꾼 패키지만 먼저 돌리고 마지막에 `go test ./...` 를 돈다.

### 4.1 PEER_CHAT 단계 1 에서 배운 것

- 채팅 핵심은 `internal/daemon/chat`(errors·frame·service·link·view·limit). 노드 포트 경로 `/edge/v1/chat` 는 `edge.AcceptUpgrade`(받는 쪽)·`edge.Client.Upgrade`(거는 쪽)·`edgenode.Options.Chat` 으로 끼웠다. 데몬 배선은 `daemon/boot/edge.go` `startChat` 이다. 지금 `Options.Deliver` 는 nil 이다 — 단계 2 에서 MCP 연결로 잇는다. `chat.Service` 는 `PanedServer` 에 아직 넘기지 않았다.
- 시험은 `chat_test.go` 의 `net.Pipe` 메모리 연결과 `fakePeer`(서명한 프레임을 손으로 넣음)로 한다. 가짜 참가자 id 는 `f.pid("x")` 로 노드 접두어를 붙인다.
- 참가자 id 는 `<노드 지문 전체 64자리>-<무작위 32자리>` 다(`idPrefix`). MCP·화면에서 id 를 줄여 보일 때는 접두어 뒤를 보여야 구분된다.
- **자동 보안 검토(플러그인)가 커밋마다 돈다.** 단계 1 에서 두 번 지적을 받아 고쳤다: 개인채팅에 제3 노드가 끼어듦, 참가자 id 사칭·선점, 재전송, 본문 제어 문자, 아는 노드 상한과 그 부작용. 새 경로를 만들 때 "망의 아무 노드나 악의적일 수 있다"를 먼저 따진다. 단, 개인채팅 글이 망 전체로 퍼지는 것은 사용자 결정(D-PCH-21, FR-PCH-15)이라 고치지 않는다.
- 상태 알림은 자기 내용이 바뀔 때만 낸다. 처음에는 남의 알림을 받을 때마다 다시 알려 노드끼리 끝없이 주고받았다(시험이 못 잡았다 — `TestStateAnnouncementsSettle` 로 잡는다).
- IRC 방식의 경합: 들어가기 직전에 보낸 글이 들어간 뒤 도착하면 받는다. 시험에서는 같은 연결로 뒤따르는 상태 알림을 기다려 순서를 맞춘다.
- `make gates | tail` 처럼 파이프로 이으면 실패해도 `&&` 가 이어진다. 검사 결과는 `make gates > /tmp/g.log; echo $?` 로 본다(한 번 실패한 채 커밋했다가 amend 했다).
- `http.Error` 를 직접 부르면 게이트(FR-ERR-3)에 걸린다. `{code,message}` 를 `httpresp.JSON` 으로 쓴다.
- python 으로 여러 곳을 고칠 때 앞 단계의 gofmt 로 필드 정렬이 바뀌면 다음 치환이 어긋난다. 정렬이 바뀌는 자리는 정규식으로 맞춘다.

### 4.2 PEER_CHAT 단계 2 에서 배운 것

- 채팅 소켓은 데몬의 `chat.sock`(`chatwire.SocketPath`)이다. 데몬 쪽은 `internal/daemon/chatsock`, 와이어는 `internal/shared/chatwire`, MCP 는 `runtimebin/dmctl_chatmcp.go`, 주입은 `claude_shim.go` `shimChatArgs`, 훅은 `dmctl_ctxhook.go` `chatUnreadText`. 배선은 `daemon/boot/edge.go` `startChat`(채팅 소켓을 열고 `Deliver` 를 잇는다).
- **세션 신원은 세션 id 하나다(D-PCH-37, 사용자 결정 "세션 id 만이 절대적이다").** MCP 는 claude 가 넘긴 `CLAUDE_CODE_SESSION_ID` 를 쓴다. `/clear` 를 메우려고 프로세스 번호·shim 표식·도구 id 를 더하자고 했다가 거절됐다. 신원에 다른 값을 섞자고 다시 제안하지 않는다.
- 도구 여덟 개는 허락 없이 쓴다(D-PCH-36, `--allowedTools=mcp__dongminal`).
- **보안 검토가 지적했다: 망에서 온 문자열(방 이름)을 터미널에 붙여 넣고 제출하면 프롬프트 주입 통로가 된다.** 붙여넣기와 훅 맥락에는 개수만 싣고, 방 이름·본문은 MCP 도구 결과(JSON)로만 보인다. 화면(단계 3)에서도 남의 값은 텍스트로만 그리고 HTML 로 넣지 않는다.
- 보안 검토(단계 3 데몬 쪽): 탭 이름이 `User` 인 에이전트가 사람 참가자 `<노드>/User` 인 척할 수 있었다. 에이전트 표시 이름에서 `User` 를 막고(`tab-User`), 글에 `fromKind` 를 싣는다(`8d3842a8`). **화면은 사람/에이전트를 표시 이름이 아니라 `fromKind`·`kind` 로 가린다.**
- 쉬는 중은 활동 상태 `idle`·`done` 뿐이다(`boot.resting`). `waiting`·보고 없음은 쉬는 중이 아니다.
- 에이전트 참가자 상한은 `chat.MaxParticipants`(64) − 1(사람 몫)이다. 사람 참가자를 붙일 때 이 몫을 쓴다.
- 시험의 유닉스 소켓은 `os.MkdirTemp("", "짧은접두어")` 홈을 쓴다(shim·훅 시험의 `chatHome`).

### 4.3 화면 조사 결과 (2026-11-17, 단계 3 용)

- Activity: 구역 서술자 `ACTIVITY_SECTIONS`(`web/js/core/app-activity.js:48-55`, 항목 `{key, icon, title(), empty(), hint?(), items(app), count?(its), act?(app)}`, "새 구역 = 배열 한 줄"). 렌더는 `App.prototype.agentsRender()`(`app-agents.js:177-224`)가 `[{t:'head'}] + _actItems()` 를 `reconcileList` 로 차분 갱신한다. `_actItems()`(`app-activity.js:159-176`)가 구역마다 `{t:'sec',sec,n,folded}` 를 넣는다. 구역 머리 `_actSecEl`(`:179-210`, `.ag-sec`·`.ag-sec-icon`·`.ag-sec-name`·`.ag-sec-n.ui-badge`), 접기 `_actFoldToggle`(`:225`), 접힘 저장 `PrefStore.local` `STORE_KEYS.agentsGroupFold`(`pref-store.js:45`). Usage 는 `foot` 항목으로 `#agents-foot` 에 따로(`_actUsageFootEl` `:280`). DOM 골격 `web/index.html:264-265`.
- 레일: `#agents-panel` 에 `.open` 이 없는 상태(`setAgentsPanelOpen` `app-agents.js:81-91`, sessionStorage). CSS 만으로 줄인다(`web/style.css:824-853`) — 레일에서 `.ag-sec-icon` 만 크게, `.ag-sec-n` 은 귀퉁이 absolute. head 항목 sig 에 `'open'|'rail'` 이 있다(`app-agents.js:201`). 갱신 계기는 SSE `tool_activity` → `_onToolActivity`(`app-agents.js:31`).
- 칸 탭 종류: `web/js/core/constants.js:610-614`(`TAB_TYPE_GIT`·`TERMINAL`·`EDITOR`·`RUN`). 열기 `TAB_OPENERS`(`app-layout.js:11-16`) → `addTab`(`:411`) → `_addRunTab`(~`:466`, 레코드 `{id,name,type:'run',runId}` `:480`) 이 베낄 틀이다. 마운트 `_mountTabBody`(`ui/renderer-pane.js:47-95`) if-체인. 함께 볼 곳: `normalizeTab`·`TOOL_CAPABILITIES`·이름 출처(`layout-tree.js:10-24`, `:300`, `:340`), 닫기 분기(`app-layout.js:578,652,675,707`), 탭 메뉴(`ui/renderer-pane-wire.js:53,69,288`), `app-tab-reopen.js`·`app-dnd.js`·`app-search.js`·`app-presets.js`. 창 타입 제약 `app-layout.js:434-438`. run 뷰 `runViewEl(tab, slot)`(`ui/runs-panel.js:376-391`, `slotKey` 로 루트 DOM 캐시). 서버는 탭 종류를 모르고 blob 을 그대로 저장한다(`workspace/manager.go:272-299`). `dmctl_listworkspace.go:236-243` 이 `Type` 을 읽는다.
- SSE: `EventSource('/api/commands/sse')`(`app-ws-sync.js:139`), `EventBus`(`event-bus.js:169-253`). 새 이벤트는 `STATE_REGISTRY`(`state-registry.js`, edges 예 `:240-246`: `{id, restore, merge, flight, part, events:{edges_changed:'_onEdgesChanged'}, revalidateOn:['sse:open','softreload']}`), 핸들러는 `App.prototype`(`app-edges.js`). `part` 를 쓰면 서버 `/api/snapshot?parts=` 에도 조각을 더해야 한다 — 쓰지 않아도 된다.
- 시험: `node:test`, `web/js/test/*.test.mjs`, 하네스 `web/js/test/harness.mjs` `load([...files], {expose, globals})`. `npm run unit`.
- 게이트: 새 파일은 `index.html` 의 `<script>` 순서에 넣는다(`check-load-order.mjs`). i18n(`t()`·ko/en 키 일치·조사·합쇼체 문장/명사형 라벨), 저장소는 `PrefStore` 만, 템플릿 리터럴에 `${}` 금지(`check-html.sh`), UIKit 버튼(`check-button-kit`), 타이머는 TIMERS·TimerHub, CSS 변수·색·폰트 크기·z-index 게이트, 툴팁(title)은 영어(FR-TIP-2), API·SSE action 은 문서(`check-api-docs.sh`·`check-commands-docs.sh`). 파일 크기 기준선(`check-file-size.mjs`).
- i18n: `t(key, params)`·`tn`(`web/js/core/i18n.js:163,169`), 카탈로그 `web/js/i18n/ko.js`·`en.js`(네임스페이스 순 정렬, 예 `'panel.sec_agents'`).

### 4.4 PEER_CHAT 단계 3 에서 배운 것

- IPC: `toolipc/chat.go`(`ChatParams`·`ChatResult`·`ChatEvent`), 데몬 `daemon/ipc/paned_chat.go`(`SetChat`·`PushChatMsg`·`PushChatChanged`, op 는 읽기 루프에서 바로 돈다 — 채팅 핵심은 메모리 연산뿐). boot `startChat` 이 `cs.StartUser()`·`ps.SetChat(cs)`·`OnUser`·`Changed` 를 잇는다.
- 서버: `toolclient/client_chat.go`, `httpapi/chat_api.go`(`ChatDaemon` 접합면, 오류 대응표 `chatErrors`), 배선 `cmd/dongminal/app.go`. 오류 코드 `apierr/codes_chat.go`.
- 화면: 탭 줄은 `app-activity.js` 의 `ACTIVITY_SECTIONS`(항목 `badge`·`shownOnly`), `_actTab`·`_actTabSelect`·`_actTabsEl`(UIKit.tab). 채팅은 `core/chat-store.js`(ChatStore·chatRoomTitle·chatShortId), `core/app-chat.js`(상태·Chats 항목·동작·`_addChatTab`), `ui/chat-view.js`(채팅 탭). 탭 종류 `TAB_TYPE_CHAT`.
- 게이트에서 배운 것: 버튼은 `createElement('button')` 대신 `UIKit.button`·`UIKit.tab`. 스크롤 표면 클래스는 `className=` 대입으로 써야 검사가 만든 자리로 본다. outline 을 지우면 `:focus-visible` 을 둔다. 영어 툴팁은 `constants.js` 의 `TIP_*` 상수로. `app-layout.js` 는 크기 기준선에 닿아 있다 — 새 메서드는 다른 파일에 둔다.
- e2e 의 `.ag-sec` 선택자를 `.ag-tab[data-sec].active` 로 바꿨다. **`e2e/baseline/ui-layout.linux.json` 에 `.ag-sec` 요소가 남아 있다** — e2e 를 돌릴 때 기준선을 다시 만들어야 한다(사용자 몫).
- 아직 안 한 것: 서버 snapshot 조각(`part`)은 쓰지 않았다(등록부가 `GET /api/chat` 를 직접 부른다).

### 4.5 PEER_CHAT 단계 4 에서 배운 것

- 도우미는 `dongminal helper <install|uninstall|run|status>`(`internal/ctl/privhelper`, D-PCH-38). 와이어·서명은 `internal/shared/humancmd`(②④). 채팅 쪽은 `daemon/chat/human.go`(프레임 `cmd`, `SetHelper`·`Command`·`trustedKeyLocked`), `chatsock/human.go`(사람 참가자 op `kill`·`kick`), boot `watchHelper`(30초마다 `info`). 화면은 `web/js/core/chat-human.js`.
- `runtime.GOOS` 분기는 게이트(OS 이음매)에 걸린다. OS 별 능력은 빌드 태그 파일의 상수(`supported`)로 가른다.
- CLI 액션 표에 액션을 더하면 `dispatch_test` 가 `<액션> --bogus` 의 stderr 에 `--bogus` 가 있기를 요구한다.
- **보안 검토가 지적했다: 망 이웃의 도우미 키 보증을 아무 노드의 `pins` 로 받으면 이웃 하나가 믿음을 흔든다.** 그 노드와 서로 이어진(양쪽 `links`) 간선 상대의 고정값만 세고, 그 노드 자신의 `helper` 와 같아야 믿는다(`cc7ecc2a`). 처음 본 값을 고정하는 방식(TOFU)은 SRS §7 의 LOW 위험으로 남겼다.
- `make gates` 는 작업 트리 전체를 본다. 커밋하지 않은 화면 파일 때문에 실패한 채 데몬 수정을 커밋한 적이 있다(그 커밋 자체는 문제없었다). 커밋 전 검사는 `git stash -u` 없이 돌리면 작업 중 파일이 섞인다는 것을 기억한다.

### 4.6 간선 맺기 조사 (2026-11-17, EDGE_PAIRING 용)

- 맺기 코드: `edgenode/ops.go` `opInvite`(:176)·`opAdd`(:218, 이름 검사 :230-236, 상대 이름 고르기 :253-260)·`opApprove`(:282)·`opReject`(:323)·`opRemove`(:351, 이름으로 찾음)·`opAddress`(:366, 이름으로 찾음). 노드 포트 `node.go` `pair`(:218, 승인 대기 :273, 응답 이름 :276)·`pairConfirm`(:280)·`Admission`(:141, TLS 단계에서 간선 아닌 것을 끊음).
- 저장: `edge/config.go` `Edge{Name,Addr,Port,Fingerprint,State,Expires,HelperKey}`, `ValidName`(:83)·`validate` 의 이름 유일성(:155-167)·`AddEdge`(:395, 같은 지문이면 항목을 통째로 바꿔 `helperKey` 를 잃는다 — R-2)·`Remove(name)`·`SetAddress(name…)`·`NameOf`·`ByName`·`FreeNameFor`·`NameTakenExcept`. 승인 대기 `edge/pairing.go` `Pending`·`AddPending`·`TakePending`·`PutBack`.
- 클라이언트 오류: `edge/client.go` `RemoteError`(:44, 코드를 싣는다). 채팅 다시 걸기 `daemon/chat/link.go` `dial`.
- API 경로 `httpapi/handlers_api.go:250-257`, 접착 `edge_api.go`, 데몬 IPC `daemon/ipc/paned_edge.go`, dmctl `runtimebin/dmctl_edge.go`(invite :253, add :269, approve :290, remove :321), 화면 `web/js/core/app-settings-edges.js`(이름 칸 :291, 승인 :100-129·:198, 지우기 :189·:229, 주소 :178, 줄 키 `data-name` :140-153), 알림 `app-edges.js:48`.
- 영향받는 시험: `edge/config_test.go`·`limit_test.go`·`migrate_test.go`·`pairing_test.go`·`listener_test.go`, `edgenode/node_test.go`·`fail_test.go`, `httpapi/edge_pair_test.go`(28곳)·`edge_notify_test.go`·`edge_daemon_test.go`·`edge_node_test.go`·`edge_reduce_test.go`·`edge_rename_test.go`, `daemon/ipc/edge_test.go`, `runtimebin/dmctl_edge_test.go`, `web/js/test/edges-notice.test.mjs`, `e2e/edges-settings.spec.ts`(돌리지 않는다), e2e 기준선의 `eg-add-name`.
- 문서: `docs/external/edges.md`·`api.md`·`errors.md`·`commands.md`, `PEER_NETWORK_SRS` FR-PNW-23~33·41·80~82, I-1·I-5·I-37.

## 5. 그다음: PEER_CHAT_SRS

`PEER_DAEMON` 이 끝나면 `PEER_CHAT_SRS.md` 로 넘어간다. **§9 미결은 2026-11-17 에 모두 정했다(D-PCH-21~34).** 단계 1(데몬의 채팅 핵심, SRS §3.9)은 끝났다: `internal/daemon/chat`, 노드 포트 `/edge/v1/chat` Upgrade(`edge.Client.Upgrade`·`edge.AcceptUpgrade`, `edgenode.Options.Chat`), 배선 `daemon/boot/edge.go` `startChat`. 다음은 단계 2(MCP·알림) 설계를 SRS §3.10 으로 적는 것이다.

사용자가 정한 큰 원칙(다시 묻지 않는다):
- 노드 = 데몬. 채팅의 모든 상태는 데몬 메모리. 디스크 저장을 늘리지 않는다.
- 참가자 = 세션(`노드 + session_id + claude 프로세스`). MCP 연결이 끊기면 바로 퇴장, 다시 연결하면 새 참가자. 세션별로 아무것도 저장하지 않는다.
- 같은 노드 안의 세션끼리도 방을 만든다(FR-PCH-45).
- 사람 명령(강제 삭제·강퇴)은 관리자 권한 도우미 + TOTP, 매번 입력. 앱은 Ente Auth 권장. macOS 부터.
