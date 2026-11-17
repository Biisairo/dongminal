# SRS: 노드 역할의 데몬 이관과 간선 축소 (Edge Daemon) — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: e2e TC-PDM-12(`edges-settings.spec.ts`)와 실제 두 PC 의 간선 맺기 — 사용자가 데몬을 다시 띄운 뒤 확인한다. 단계 1~6 의 코드·문서는 끝났다.
> **입력**: 2026-11-17 대화. 사용자 결정은 여덟이다.
> - D-PDM-1 노드는 서버가 아니라 **데몬**이다. 연결의 주체도 데몬이다
> - D-PDM-2 서버는 **망이 통하게만** 한다. 들어오는 연결과 나가는 연결 모두 서버를 거치지만, 서버는 내용을 보지 않는다
> - D-PDM-3 일을 둘로 나눈다. 먼저 이 SRS 로 노드를 데몬으로 옮기고, 채팅은 `PEER_CHAT_SRS` 에서 그 위에 얹는다
> - D-PDM-4 이 SRS 는 §4.1 에 적은 것 말고는 **사용자가 보는 동작을 바꾸지 않는다**
> - D-PDM-5 디스크에 저장하는 내용을 늘리지 않는다
> - D-PDM-13 노드 사이 연결은 **망의 간선 하나**로만 동작한다. 짝맺기만 남기고, 프로토콜 명령(`node.info` 포함)과 원격 메시지·원격 기동을 모두 지운다
> - D-PDM-14 이름 `peer` 를 **`edge`** 로 바꾼다. 짝은 "친구"가 아니라 간선이다
> - D-PDM-15 서버도 데몬 이관과 같은 단계에서 공유 노드 패키지를 쓴다. 판정을 두 벌 두는 기간을 만들지 않는다
> - D-PDM-18 헷갈리지 않게 `peer` 라는 이름을 모두 없앤다. Run 동료 명부는 `team`, 신원 파일은 `edge-cert.pem`·`edge-key.pem` 이다

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

지금 peer 기능(`PEER_NETWORK_SRS`)은 웹서버 프로세스 안에 있다. 노드 신원, 짝 목록, 노드 포트, TLS, 프로토콜 명령을 모두 서버가 처리한다.

그런데 터미널과 에이전트는 데몬(`dongminald`)이 들고 있고, 서버는 업데이트할 때마다 다시 뜬다. 다음 SRS(`PEER_CHAT_SRS`)의 채팅 상태는 세션과 수명이 같아야 하므로, 노드의 주체가 데몬이어야 한다.

또 노드 사이 연결의 쓰임이 바뀌었다. 지금은 짝에게 명령을 보내 상대의 에이전트를 보고, 메시지를 넣고, 에이전트를 띄운다. 앞으로 노드 사이 연결은 **망의 간선**이다. 간선은 "이 두 노드가 서로를 믿고 TLS 로 이어진다"는 사실만 갖는다. 그 위에서 무엇을 주고받을지는 채팅(`PEER_CHAT_SRS`)이 정한다.

이 SRS 는 세 가지를 한다.

1. 프로토콜 명령과 원격 메시지·원격 기동을 지운다. 짝맺기만 남긴다.
2. 이름을 `peer` 에서 `edge` 로 바꾼다.
3. 노드 역할을 데몬으로 옮긴다. 서버에는 바이트를 잇는 통로와 화면만 남긴다.

### 1.2 범위 (Scope)

| 단계 | 묶음 | 내용 |
|---|---|---|
| 1 | M | peer 도메인 패키지를 공유 계층으로 옮긴다. 동작 변경 없음 (끝) |
| 2 | L | 서버의 바이트 통로와 데몬의 노드 소켓 부품 (끝) |
| 3 | R | 간선 축소: 프로토콜 명령·원격 메시지·원격 기동·마지막 응답 시각·허용 폴더를 지운다 |
| 4 | E | 이름 변경 `peer` → `edge` (코드·API·dmctl·화면·홈 파일·오류 코드·와이어) |
| 5 | N | 데몬이 노드가 된다. 서버는 통로와 로컬 API 위임만 한다. 직접 모드는 같은 패키지를 쓴다 |
| 6 | X | 문서·e2e |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **노드** | 짝맺기의 주체. 데몬 모드에서는 데몬, 직접 모드에서는 서버 프로세스다 (D-PDM-11) |
| **간선 (edge)** | 짝맺기를 마친 두 노드 사이의 관계. 서로의 인증서 지문을 저장하고, 그 지문으로만 TLS 연결을 받아들인다. 이 SRS 이전의 "짝(peer)"이다 |
| **노드 포트** | 다른 노드가 접속하는 TCP 포트. 기본 58147. 서버가 연다 |
| **노드 소켓** | 데몬이 여는 로컬 소켓 `node.sock`. 서버가 노드 포트로 받은 연결을 이 소켓으로 넘긴다 |
| **발신 소켓** | 서버가 여는 로컬 소켓 `dial.sock`. 데몬이 다른 노드에 연결할 때 서버에 TCP 연결을 부탁하는 자리다 |
| **바이트 통로** | 노드 포트 ↔ 노드 소켓, 발신 소켓 ↔ 원격 TCP 사이에서 바이트를 그대로 옮기는 서버의 기능. TLS 를 끝내지 않는다 |

### 1.4 참고 (References)

- `PEER_NETWORK_SRS.md` FR-PNW-* — 짝맺기 규칙의 기준. 묶음 R(명령)·원격 메시지·원격 기동은 이 SRS 가 지운다(§3.3)
- `AGENT_RECORD_DAEMON_SRS.md` — 데몬이 상태를 갖는 구조, 보고 소켓 선례(D-ARD-6)
- `internal/daemon/ipc/paned_server.go` IPC-24 — 데몬은 서버 연결을 하나씩 받는다
- `internal/shared/toolipc/protocol.go` — 요청 메서드, push, `hello` 기능 협상
- `docs/external/peers.md` — 사용자 문서 (단계 4 에서 `edges.md`)

### 1.5 개요 (Overview)

§2 현황, §3 요구, §4 결정, §5 검증, §6 비목표, §7 위험, §8 단계다.

## 2. 현황 (Identified Issue)

### 2.1 노드 역할이 서버에 있다

| 구성 | 지금 자리 |
|---|---|
| 신원(`node-cert.pem`·`node-key.pem`), 짝 목록(`peers.json`) | `httpapi/peer_node.go:40-58` → `domain/peer/identity.go`·`config.go` |
| 노드 포트, TLS 1.3, 지문 판정(`Admission`) | `domain/peer/listener.go:88-178`, 판정 클로저 `peer_node.go:61-78` |
| 짝맞춤 상태, 속도 제한, 마지막 응답 시각 | `domain/peer/pairing.go`·`limit.go` |
| 프로토콜 명령 6개와 짝맞춤 경로 | `httpapi/peer_commands.go`·`peer_spawn.go`·`peer_node.go:143-222` |
| 발신 클라이언트(지문 고정) | `domain/peer/client.go:82-148`. `/api/peers/call`·`add`·`approve` 가 쓴다 |
| 원격 기동 기록 | `peer-spawns.json` (`domain/peer/spawnlog.go`) |
| 화면 갱신 | SSE `peers_changed` (`peer_api.go:89-98`) |

### 2.2 간선 축소로 없어지는 것

| 구성 | 지금 자리 |
|---|---|
| 프로토콜 명령 6개(`node.info`·`agents.list`·`message.send`·`agent.spawn`·`agent.status`·`agent.close`) | `httpapi/peer_commands.go`·`peer_spawn.go` |
| 원격 글의 도구별 전달 상태, 원격 엔벨로프 `[DONGMINAL-PEER-MSG …]` | `httpapi/peer_gate.go`·`peer_envelope.go`, `quoteEnvelope` 의 PEER 표지 |
| 로컬 API `POST /api/peers/call` | `peer_commands.go` `apiPeersCall` |
| `dmctl peer info·tools·spawn·status·close`, `dmctl msg --to <노드>/<uuid>` | `runtimebin/dmctl_peer.go`·`dmctl_toolio.go` |
| 원격 기동 기록 `peer-spawns.json` | `peer/spawnlog.go`, `dmenv.PeerSpawnsFile`, 홈 표·백업 |
| 허용 폴더 `allowedDirs` (원격 기동 전용) | `peer/config.go`·`realdir*.go`, 설정 화면 |
| 마지막 응답 시각 `lastSeen` (명령 호출로만 갱신) | `peer/limit.go` `LastSeen`, 설정 화면·`dmctl peers` |
| 전경 확인 붙여넣기 `SendPasteIfForeground` (원격 글 전용) | `toolhub/bracketpaste.go`, `toolaccess`·`adapters`·`toolclient`·데몬 `paste` 의 `foreground` |
| `agentadapter.BareLaunchLine` (원격 기동 전용) | `agentadapter/adapter.go` |
| 에이전트 안내의 원격 절 | `agentmemory/CLAUDE.md`, `dmctl_agentcontext.go` (SessionStart 안내) |
| 오류 코드 `peer_unknown_op`·`peer_rate_limited`(명령 몫)·`peer_target_*`·`peer_agent_missing`·`peer_dir_not_allowed`·`peer_not_owner`·`peer_spawn_limit` | `apierr/codes_peer.go`·`codes_doc.go` |

남는 것: 신원, 짝 목록(`peers.json`), 노드 포트·TLS·지문 판정, 짝맞춤 경로 둘(`pair`·`pair/confirm`)과 그 속도 제한, 로컬 API(조회·노드 설정·초대·추가·승인 대기·승인·거절·해제·주소 수정), 설정 화면, `dmctl peers`·`peer invite·add·approve·reject·remove`, 이벤트 `peers_changed`.

**이름이 같지만 이 SRS 와 무관한 것:** Run 동료 명부(`/api/runs/peers`, `handlers_runs_peers.go`, `dmctl_run_peers.go`). 바꾸지도 지우지도 않는다.

### 2.3 데몬의 제약

- 데몬은 서버 연결을 **하나씩** 받는다(IPC-24). 다른 클라이언트는 별도 소켓이 필요하다(보고 소켓 선례).
- 느린 요청은 `goSlow` 로 따로 돌려 다른 요청을 막지 않는다(`paned.go:170-183`).
- 데몬에는 TCP 리스너와 `crypto/tls` 사용이 없다.
- 데몬 코드를 바꾸면 적용할 때 데몬을 다시 띄워야 하고, 그때 모든 터미널 세션이 끊긴다.

## 3. 요구 (Requirements)

### 3.1 묶음 M — 패키지 이동 (끝)

- **FR-PDM-1** `internal/webserver/domain/peer` 를 `internal/shared/peer` 로 옮긴다. 동작과 시험은 그대로다.

### 3.2 묶음 L — 바이트 통로

- **FR-PDM-10** 서버는 노드 설정의 `enabled`·`bind`·`port` 대로 노드 포트를 연다. 연결을 받으면 데몬의 노드 소켓에 연결하고, 출발지 주소 한 줄(프리앰블)을 보낸 뒤 양쪽 바이트를 그대로 잇는다. 서버는 TLS 를 끝내지 않고 내용을 읽지 않는다.
- **FR-PDM-11** 데몬은 노드 소켓 `node.sock` 을 연다. 권한은 소유자만이다. 연결을 여럿 동시에 받는다. 프리앰블의 출발지 주소는 짝맞춤에서 상대가 주소를 알리지 않았을 때 쓴다(PEER_NETWORK I-4).
- **FR-PDM-12** 서버는 발신 소켓 `dial.sock` 을 연다. 권한은 소유자만이다. 데몬이 `{addr, port}` 를 보내면 서버가 연결 시간 한도(5초) 안에 TCP 로 연결하고, 성공을 알린 뒤 양쪽 바이트를 그대로 잇는다. 실패하면 사유를 돌려주고 닫는다.
- **FR-PDM-13** 서버가 꺼져 있으면 노드 포트와 발신 소켓이 없다. 이때 다른 노드는 이 노드에 닿지 못하고, 데몬의 발신은 `edge_unreachable` 로 끝난다. 데몬의 간선 목록·짝맞춤 상태는 그대로 남는다.
- **FR-PDM-14** 노드 포트를 열지 못하면(포트 사용 중 등) 서버는 계속 동작하고, 그 사유를 데몬에 알린다. 데몬은 그 사유를 노드 상태에 실어 화면과 `dmctl edges` 에 보인다(FR-PNW-9).

### 3.3 묶음 R — 간선 축소

- **FR-PDM-60** 노드 포트는 짝맞춤 경로 둘(`pair`·`pair/confirm`)만 받는다. 그 밖의 경로는 모두 404 `not_found` 다. 프로토콜 명령 6개를 지운다.
- **FR-PDM-61** 로컬 API `POST /api/peers/call` 을 지운다. 경로는 404 다.
- **FR-PDM-62** `dmctl peer info·tools·spawn·status·close` 를 지운다. `dmctl msg` 는 `--to` 에 `/` 가 있으면 원격으로 보내지 않고 다른 잘못된 대상과 같이 거절한다(로컬 규칙 FR-IDU 그대로).
- **FR-PDM-63** 원격 엔벨로프(`[DONGMINAL-PEER-MSG …]`)를 만들지 않는다. 원격 글의 도구별 전달 상태, 전경 확인 붙여넣기(`SendPasteIfForeground`, 데몬 `paste` 의 `foreground`), `BareLaunchLine` 을 지운다. 로컬 엔벨로프의 인용 규칙에서도 PEER 표지를 뺀다.
- **FR-PDM-64** 원격 기동 기록과 `peer-spawns.json` 을 지운다. 홈에 남은 `peer-spawns.json` 은 노드 계층이 처음 설 때 지운다. 홈 폴더 표·백업 목록에서도 뺀다.
- **FR-PDM-65** 노드 설정에서 허용 폴더(`allowedDirs`)를 지운다. 저장된 파일에 그 항목이 있으면 읽을 때 버리고, 다음 저장부터 쓰지 않는다. 노드 설정 PUT 이 그 항목을 보내도 무시한다.
- **FR-PDM-66** 마지막 응답 시각(`lastSeen`)을 지운다. 로컬 API 의 짝 항목, 설정 화면, `dmctl peers` 에서 뺀다.
- **FR-PDM-67** 에이전트 안내(`agentmemory/CLAUDE.md`, SessionStart 안내)에서 원격 명령·원격 엔벨로프 절을 지운다.
- **FR-PDM-68** 지운 명령에만 쓰이던 오류 코드를 카탈로그와 `errors.md` 에서 지운다. 짝맞춤과 로컬 API 가 쓰는 코드는 남긴다.

### 3.4 묶음 E — 이름 변경

- **FR-PDM-70** 이름 `peer` 를 `edge` 로 바꾼다. 대상과 새 이름은 다음과 같다.

  | 대상 | 이전 | 새 이름 |
  |---|---|---|
  | Go 패키지 | `shared/peer`, `shared/peerrelay` | `shared/edge`, `shared/edgerelay` |
  | 로컬 API | `/api/peers`, `/api/peers/*` | `/api/edges`, `/api/edges/*` |
  | 노드 포트 경로 | `/peer/v1/pair`, `/peer/v1/pair/confirm` | `/edge/v1/pair`, `/edge/v1/pair/confirm` |
  | 초대 코드 머리 | `dmpeer1:` | `dmedge1:` |
  | dmctl | `dmctl peers`, `dmctl peer <sub>` | `dmctl edges`, `dmctl edge <sub>` |
  | 홈 파일 | `peers.json` | `edges.json` |
  | 이벤트 | `peers_changed` | `edges_changed` |
  | 오류 코드 | `peer_*` | `edge_*` |
  | 설정 탭·화면 문구 | Peers, 짝 | Edges, 간선 |
  | 사용자 문서 | `docs/external/peers.md` | `docs/external/edges.md` |
  | 감사 로그 | `peer audit` | `edge audit` |

- **FR-PDM-71** 노드 계층이 처음 설 때 `edges.json` 이 없고 `peers.json` 이 있으면 `peers.json` 을 `edges.json` 으로 옮긴다(이름 바꾸기). 둘 다 있으면 `edges.json` 을 쓰고 `peers.json` 은 그대로 둔다. 신원 파일은 `edge-cert.pem`·`edge-key.pem` 이다. 옛 신원 파일 `node-cert.pem`·`node-key.pem` 은 옮기지 않고 지운다. 새 신원(새 지문)이 생기므로 옛 간선은 다시 맺어야 한다(D-PDM-18, 맺은 간선이 없다는 사용자 확인).
- **FR-PDM-72** Run 동료 명부를 `team` 으로 바꾼다. `GET /api/runs/peers` → `GET /api/runs/team`, `dmctl run peers` → `dmctl run team`, 응답 키 `peers` → `team`, 프리앰블 안내문도 `dmctl run team` 이다. 옛 경로와 옛 하위 명령은 없다(404·모르는 하위 명령).

### 3.4a 단계 4 설계 (이름 변경)

FR-PDM-70 의 표를 식별자 단위로 정한다. 사용자가 보는 이름이 모두 `edge` 가 되고, 코드의 이름도 같이 따른다. 일괄 치환을 쓰지 않는다(Run 동료 명부 보호, FR-PDM-72).

**Go**

| 이전 | 새 이름 |
|---|---|
| 패키지 `shared/peer`, `shared/peerrelay` | `shared/edge`, `shared/edgerelay` (`git mv`) |
| `peer.Peer`, `Config.Peers`(json `peers`) | `edge.Edge`, `Config.Edges`(json `edges`) |
| `IsPeer`·`AddPeer`·`PeersOnly`·`ErrInvalidPeer`·`ErrPeerNotFound`·`PerPeerPerMinute` | `IsEdge`·`AddEdge`·`EdgesOnly`·`ErrInvalidEdge`·`ErrEdgeNotFound`·`PerKeyPerMinute` |
| `InvitePrefix = "dmpeer1:"` | `"dmedge1:"` |
| `dmenv.PeersFile = "peers.json"` | `dmenv.EdgesFile = "edges.json"`. 옛 이름은 이관에만 쓴다 |
| `httpapi/peer_*.go`, 메서드 `peer*`·`apiPeers*`, 필드 `s.peers`·`s.peerLn`·`s.peerID`·`s.peerClient`·`s.peerLimiter` | `httpapi/edge_*.go`, `edge*`·`apiEdges*`, `s.edges`·`s.edgeLn`·`s.edgeID`·`s.edgeClient`·`s.edgeLimiter` |
| 노드 포트 경로 `/peer/v1/` | `/edge/v1/` |
| `apierr/codes_peer.go`, `CodePeer*` = `peer_*` | `apierr/codes_edge.go`, `CodeEdge*` = `edge_*`. `errors.md` 는 다시 만든다 |
| 로그 `peer audit`, `peer listener`, `peer identity` | `edge audit`, `edge listener`, `edge identity` |
| `cmd/dongminal` 의 `startPeerScoped`·`StartPeer` | `startEdgeScoped`·`StartEdge` |
| dmctl `dmctl_peer.go`, `peers`·`peer <sub>`, 출력 줄 머리 `peer` | `dmctl_edge.go`, `edges`·`edge <sub>`, 줄 머리 `edge`. 공용 인자 해석기 `peerArgs`·`peerSub`·`parsePeerArgs`(account 도 씀)는 `subArgs`·`subSpec`·`parseSubArgs` 로 바꾼다 |

**파일 이관 (FR-PDM-71)**: 노드 계층이 설 때 `edges.json` 이 없고 `peers.json` 이 있으면 이름을 바꾼다. 읽을 때 json 키 `edges` 가 없고 `peers` 가 있으면 그 값을 쓴다. 저장은 `edges` 로만 한다. 홈 폴더 표(`homelayout.go`·`getting-started.md`)는 `edges.json` 으로 바꾼다.

**API·이벤트**: `/api/edges`, `/api/edges/{node,invite,add,pending,approve,reject,remove,address}`. 조회 응답은 `{node, edges, pending, invite}` 다. 이벤트는 `edges_changed`(`paired` 그대로). 상태 값 `pending-out` 과 승인 대기 항목 모양은 그대로다.

**화면**: `app-peers.js`·`app-settings-peers.js` → `app-edges.js`·`app-settings-edges.js`, 패널 `panel-peers` → `panel-edges`, 요소 id `pn-*` → `eg-*`, i18n `peer.*`·`html.pn_*` → `edge.*`·`html.eg_*`, 상태 키 `peers` → `edges`. 설정 탭 이름은 ko "간선", en "Edges". 화면 문구의 "짝"은 "간선"으로, "짝맞춤·짝맺기"는 "간선 맺기"로 바꾼다. 시험 `peers-notice.test.mjs` → `edges-notice.test.mjs`, e2e `peers-settings.spec.ts` → `edges-settings.spec.ts`(실행하지 않는다).

**문서**: `peers.md` → `edges.md`(`git mv`), `api.md`·`commands.md`·`features.md`·`getting-started.md`·`README.md`·`docs/external/README.md`·`agentmemory/CLAUDE.md`·`architecture.md` 를 새 이름으로 맞춘다. 옛 SRS 파일 이름(`PEER_*`)과 CHANGELOG 의 지난 항목은 바꾸지 않는다.

**바꾸지 않는 것**: 프리앰블 `DMRELAY1`, 소켓 이름.

**Run 동료 명부 (FR-PDM-72)**: `handlers_runs_peers.go`·`dmctl_run_peers.go` → `handlers_runs_team.go`·`dmctl_run_team.go`, `apiRunPeers` → `apiRunTeam`, `peerView` → `teamView`, `runPeer`·`runSubPeers` → `teamMate`·`runSubTeam`.

**신원 파일 (FR-PDM-71)**: `dmenv.NodeCertFile`·`NodeKeyFile` → `EdgeCertFile`·`EdgeKeyFile`(`edge-cert.pem`·`edge-key.pem`). 옛 이름은 `LegacyNodeCertFile`·`LegacyNodeKeyFile` 로 지우기에만 쓴다. 이관 함수는 `edge.MigrateLegacyFiles` 하나다.

**구현 중 정한 것 (2026-11-17)**

- 텔레그램·Claude 계정 API 도 쓰는 공용 도우미는 dmctl 공용 해석기와 같이 중립 이름으로 바꾼다. `peerFail` → `codeFail`, `peerReadJSON` → `readJSONBody`, `peerBodyLimit` → `jsonBodyLimit`, dmctl `printPeerRefusal` → `printRefusal`.
- 스냅숏 조각 이름도 상태 키를 따라 `peers` → `edges` 다(`/api/snapshot?parts=…,edges`).
- 화면의 `pn-*` 중 간선 패널만 쓰는 id·클래스를 `eg-*` 로 바꾼다. 간선 패널과 Claude 계정 설정이 같이 쓰는 `pn-row` 는 중립 이름 `set-row` 로 바꾼다(D-PDM-18). 판(pane) 클래스 `pn-tab`·`pn-body` 등은 무관하다. e2e 레이아웃 기준선(`e2e/baseline/ui-layout.*.json`)의 선택자 키도 같이 바꾼다.
- 설정 탭 이름은 다른 탭처럼 번역하지 않고 "Edges" 하나다. 패널 안의 문구는 ko "간선", en "edge" 다. "해제"는 "끊기"로 바꾼다.
- 옛 `dmctl peers`·`dmctl peer <sub>` 는 모르는 명령으로 실패하고 서버를 부르지 않는다.
- 이관(`edge.MigrateLegacyConfig`)은 `initEdge` 가 저장소를 열기 전에 부른다. 실패하면 로그만 남기고 계속한다.

### 3.5 묶음 N — 데몬의 노드 처리

- **FR-PDM-20** 데몬이 신원 파일과 `edges.json` 을 읽고 쓴다. 서버는 이 파일을 읽지도 쓰지도 않는다.
- **FR-PDM-21** 데몬이 노드 소켓으로 들어온 연결의 TLS 를 끝내고, 지문 판정(`Admission`)·경로 판정·짝맞춤 경로를 처리한다. 판정 규칙은 FR-PNW-5~7·24·41 그대로다.
- **FR-PDM-22** 데몬이 발신 클라이언트를 갖는다. 발신 소켓으로 얻은 연결 위에서 TLS 를 맺고 상대 지문을 고정한다(FR-PNW-22).
- **FR-PDM-2** 노드 로직(판정·짝맞춤 경로·로컬 API 연산)은 공유 패키지 `internal/shared/edgenode` 에 둔다. 데몬과 직접 모드의 서버가 같은 코드를 쓴다(D-PDM-15).
- **FR-PDM-26** 감사 로그(`edge audit`)는 노드를 처리하는 프로세스의 로그에 남긴다. 데몬 모드에서는 데몬 로그다.
- **FR-PDM-27** 간선·초대·승인 대기·노드 포트 상태가 바뀌면 데몬이 push `edges` 를 보낸다. 본문은 `edges_changed` 의 인자와 같다(`paired` 선택 인자 포함). 서버는 받은 그대로 SSE 로 방송한다.
- **FR-PDM-30** 로컬 API(`/api/edges/*`)의 응답 모양은 단계 4 이후와 같다. 서버는 요청을 IPC 메서드 `edge`(`{op, args, ifMatch}`)로 데몬에 넘기고, 데몬의 답(상태·본문·오류 코드·ETag)을 그대로 돌려준다. `dmctl` 은 바꾸지 않는다.
- **FR-PDM-31** `edge` 메서드는 느린 요청으로 처리한다(`goSlow`). 상대 노드 호출(추가·승인)이 걸리는 동안 같은 연결의 다른 요청을 막지 않는다.
- **FR-PDM-33** 서버가 데몬에 (다시) 붙으면 `edge` 의 조회(`get`)로 노드 설정을 받아 노드 포트를 연다(`Port.Apply`). 노드 설정이 바뀌면 데몬의 push `edges` 를 받고 다시 조회한다.
- **FR-PDM-50** 데몬은 `hello` 의 기능 목록에 `edge` 를 싣는다. 서버는 `edge` 를 말하는 데몬과만 노드 기능을 켠다.
- **FR-PDM-51** 데몬이 `edge` 를 말하지 않으면(옛 데몬) 서버는 노드 포트를 열지 않는다. 로컬 API 는 409 `edge_daemon_restart` 로 답하고, 화면과 `dmctl edges` 는 "데몬을 다시 시작해야 노드 기능을 쓸 수 있다"고 알린다. 서버가 노드 역할을 대신하지 않는다.
- **FR-PDM-52** 직접 모드(데몬 없음)에서는 서버 프로세스가 노드다. 같은 `edgenode` 코드를 쓰고, 바이트 통로 대신 노드 포트를 직접 처리한다.
- **FR-PDM-53** 묶음 N 이 끝나면 서버에는 노드 판정 코드가 없다. 서버의 노드 관련 코드는 통로·`edge` 위임·SSE 방송뿐이다.

### 3.5a 단계 5 설계 (데몬이 노드)

근거 조사: 2026-11-17 (데몬 IPC·서버 생명주기·httpapi 노드 코드). 아래 이름은 단계 4 이후 이름이다.

**공유 패키지 `internal/shared/edgenode` (FR-PDM-2)**

노드 하나의 상태와 연산을 갖는다. 데몬과 직접 모드의 서버가 같은 코드를 쓴다. webserver 축을 가져오지 않는다(축 게이트).

| 요소 | 내용 |
|---|---|
| `New(Options) (*Node, error)` | `Options{Home, Hostname, Dial, PortStatus, Notify, Now}`. `edge.MigrateLegacyFiles`·`peer-spawns.json` 삭제·저장소·신원·발신 클라이언트·짝맞춤 상태·속도 제한을 세운다. 신원을 읽지 못하면 오류다 |
| `Dial` | 발신 연결. 데몬은 `edgerelay.Dialer(dial.sock)`, 직접 모드는 nil(TCP) |
| `PortStatus func() PortStatus` | 노드 포트의 `{Listening, Addr, Error}`. 데몬은 서버가 알린 마지막 값, 직접 모드는 자기 리스너 |
| `Notify func(paired string)` | 간선·초대·승인 대기·노드 설정이 바뀐 뒤 부른다. 데몬은 push `edges`, 직접 모드는 SSE `edges_changed` |
| `Admission()`·`Handler()` | 노드 포트의 두 단계 판정과 짝맞춤 경로 둘의 핸들러. 판정 규칙은 지금 httpapi 의 것을 그대로 옮긴다 |
| `Do(ctx, Request) Response` | 로컬 API 연산 하나. `Request{Op, Args, IfMatch}`, `Response{Status, Code, Message, Body, ETag}` |
| `Config()` | 노드 설정. 서버(데몬 모드)는 이것으로 노드 포트를 연다 |

연산(`Op`)은 `get`·`node`·`invite`·`add`·`pending`·`approve`·`reject`·`remove`·`address` 다. 응답 모양·상태·오류 코드·ETag 는 지금의 `/api/edges/*` 와 같다(FR-PDM-30). 설정 잠금(지금의 `settingsMu` 몫)은 Node 가 갖는다. 상대 노드를 부르는 `add`·`approve` 는 잠금 밖에서 부른다.

- 오류 코드: `edge_*` 상수는 `shared/edge` 로 내리고 `apierr` 는 그 값을 쓴다. Node 가 내는 일반 코드(`save_failed`·`stale_revision`·`invalid_json`·`body_too_large`·`bad_request`·`not_found`·`internal`)는 Node 의 상수로 두고, 값이 `apierr` 카탈로그에 있는지는 httpapi 시험이 확인한다. 상대가 보낸 코드를 옮기는 `remoteCode` 는 Node 가 아는 코드 집합으로 거른다.
- ETag: GET 의 ETag 계산과 PUT 의 If-Match 비교를 Node 가 함께 하므로 Node 가 갖는다(계산식은 지금의 `settingsTag` 와 같다).
- 본문 읽기: 노드 포트 핸들러는 공유 본문 읽기를 거친다(본문 상한 게이트). `httpreq`·`httpresp` 를 shared 로 내린다(표준 라이브러리만 쓰는 패키지다).
- 상대가 보낸 코드는 Node 가 낼 수 있는 코드(`edgenode.Codes`)일 때만 옮긴다. 전에는 오류 카탈로그 전체였다. 정상 노드는 이 코드만 내므로 동작은 같다.

**IPC (`toolipc`)**

| 이름 | 방향 | 모양 |
|---|---|---|
| 메서드 `edge` | 서버 → 데몬 | `EdgeParams{Args, IfMatch, Op}` → `EdgeResult{Body, Code, ETag, Message, Status}`. 데몬은 따로 둔 느린 풀(동시 2)에서 돌린다. 도구 생성 풀과 나눈다 (FR-PDM-31) |
| 메서드 `edgeport` | 서버 → 데몬 | `EdgePortParams{Addr, Error, Listening}`. 노드 포트를 연 뒤·닫은 뒤·열지 못했을 때·다시 붙었을 때 보낸다 (FR-PDM-14) |
| push `edges` | 데몬 → 서버 | `EdgesEvent{Paired}`. 본문은 `edges_changed` 의 인자와 같다 (FR-PDM-27) |
| 기능 `edge` | 양쪽 | 데몬은 `DaemonFeatures` 에, 서버는 `ServerFeatures` 에 싣는다 (FR-PDM-50) |

와이어 구조체의 필드는 JSON 키 사전순이고 `TestWireGolden` 을 갱신한다. 판(`ProtocolVersion`)은 올리지 않는다.

**데몬**

- 부팅 때 `edgenode.New` 로 노드를 세우고, `edge.NewListener(…).UseListen(edgerelay.ListenNode(node.sock))` 로 노드 소켓을 듣는다. 노드 설정의 `enabled` 가 거짓이면 듣지 않는다. 설정이 바뀌면 다시 적용한다.
- 노드를 세우지 못하면(신원 오류) 데몬은 계속 뜨고, `edge` 는 503 `edge_unavailable` 로 답한다.
- 종료 때 노드 소켓을 닫고 그 파일을 지운다(보고 소켓과 같은 자리).
- 감사 로그(`edge audit`)는 데몬 로그(`daemon.log`)에 남는다 (FR-PDM-26).

**서버 — 데몬 모드 (`Deps.EdgeDaemon != nil`)**

- 신원·`edges.json` 을 열지 않는다 (FR-PDM-20). `initEdge` 는 직접 모드에서만 돈다.
- `/api/edges/*` 는 `EdgeDaemon.Do` 로 넘기고 답을 그대로 쓴다. 시한은 30초다(상대 호출 15초 + 연결·핸드셰이크). 시한을 넘기면 502 `edge_unreachable` 이다.
- 데몬이 `edge` 를 말하지 않으면 409 `edge_daemon_restart` 다. 노드 포트와 발신 소켓을 열지 않는다 (FR-PDM-51).
- `StartEdge` 가 발신 소켓(`ListenDial`+`ServeDial`)과 노드 포트(`edgerelay.NewPort`)를 띄운다. 데몬에 붙거나 다시 붙을 때, push `edges` 를 받을 때 `edge get` 으로 노드 설정을 받아 `Port.Apply` 하고, 결과를 `edgeport` 로 알린다 (FR-PDM-33). 재조회는 push 콜백 밖의 큐에서 한다(읽기 루프에서 RPC 를 기다리지 않는다).
- push `edges` 를 받으면 `edges_changed` 를 같은 인자로 방송한다. 다시 붙은 뒤에는 한 번 방송해 화면이 다시 읽게 한다.

**서버 — 직접 모드 (`Deps.EdgeDaemon == nil`)**

- 서버가 `edgenode.New` 로 노드를 세운다(Dial nil). 노드 포트는 지금처럼 `edge.Listener` 가 TCP 로 직접 듣는다. `/api/edges/*` 는 같은 HTTP 접착 코드로 `Node.Do` 를 부른다 (FR-PDM-52).

**httpapi 에 남는 것 (FR-PDM-53)**: `/api/edges/*` 접착(요청 → `Do` → 응답), SSE 방송, 데몬 모드의 통로 기동. 판정·짝맞춤·저장 코드는 없다.

**시험**

| TC | 자리 | 방법 |
|---|---|---|
| TC-PDM-4 | `edgenode` | 노드 둘을 통로(서버 `Port` + 데몬 `ListenNode`, `Dialer`)로 이어 짝맞춤 전 과정 |
| TC-PDM-7 | httpapi `daemon_integration_test` | 실제 `ipc.NewPanedServer` 위에서 `/api/edges/*` 전부. 응답 모양이 직접 모드와 같다 |
| TC-PDM-9 | 같은 자리 | 짝맞춤 중 push `edges` → `edges_changed` |
| TC-PDM-10 | httpapi | `edge` 없는 가짜 데몬: 409 `edge_daemon_restart`, 노드 포트 닫힘 |
| TC-PDM-11 | httpapi | 지금의 짝맞춤 시험(직접 모드)이 그대로 통과한다 |

**데몬 재시작**: 필요하다. 커밋 메시지와 보고에 적는다 (NFR-PDM-5).

### 3.6 비기능 (Non-functional)

- **NFR-PDM-1** `PEER_NETWORK_SRS` 의 짝맺기 시험(축소 후 남은 것)이 모두 통과해야 한다. 시험이 서버 내부를 직접 부르던 곳은 같은 동작을 `edgenode` 쪽에서 확인하도록 옮긴다.
- **NFR-PDM-2** 짝맞춤은 한 머신에서 노드 둘(서로 다른 홈)로 검증한다(NFR-PNW-3 승계).
- **NFR-PDM-3** 새 외부 의존성을 들이지 않는다(NFR-PNW-2 승계).
- **NFR-PDM-4** 디스크에 새로 쓰는 파일은 소켓 둘(`node.sock`·`dial.sock`)뿐이다. `peer-spawns.json` 은 없어진다(D-PDM-5).
- **NFR-PDM-5** 데몬을 다시 띄워야 하는 단계는 커밋 메시지와 보고에 그 사실을 적는다(NFR-ARD-5 와 같다).

### 3.7 지운 요구

D-PDM-13 으로 다음 요구를 지운다. 번호는 다시 쓰지 않는다.

- FR-PDM-23·24·25 (명령의 활동 상태·주소 해석·원격 기동 기록) — 명령이 없다.
- FR-PDM-32 (`/api/peers/call` 의 `from`) — 경로가 없다.
- FR-PDM-40~43 (데몬 → 서버 화면 요청) — 화면 배치가 필요한 명령이 없다.

## 4. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-PDM-1 | 노드는 데몬이다 | 사용자 결정 (2026-11-17). 터미널과 에이전트를 가진 것이 데몬이다 |
| D-PDM-2 | 서버는 바이트 통로다. TLS 는 데몬이 끝낸다 | 사용자 결정. 서버가 TLS 를 끝내고 지문을 데몬에 알리면, 그 알림을 꾸밀 수 있는 자리가 하나 더 생긴다 |
| D-PDM-3 | 노드 이관과 채팅을 SRS 둘로 나눈다 | 사용자 결정. 옮기기와 기능 추가가 섞이면 문제의 원인을 가르기 어렵다 |
| D-PDM-4 | §4.1 밖의 사용자가 보는 동작은 바꾸지 않는다 | 사용자 결정 |
| D-PDM-5 | 디스크 저장을 늘리지 않는다 | 사용자 결정 |
| D-PDM-6 | 나가는 연결도 서버가 대행한다(`dial.sock`) | D-PDM-2. 서버가 꺼져 있으면 노드는 들어오지도 나가지도 않는다는 한 규칙이 된다 |
| D-PDM-7 | 들어오는 연결은 데몬의 별도 소켓으로 받는다 | 서버 연결 소켓은 하나만 받는다(IPC-24). 원격 연결은 여럿이 동시에 온다 |
| D-PDM-10 | 옛 데몬과는 노드 기능을 끈다. 서버가 대신하지 않는다 | 서버에 노드 코드를 남기면 같은 판정이 두 벌이 된다 |
| D-PDM-11 | 직접 모드에서는 서버 프로세스가 노드다 | 직접 모드에서는 서버가 곧 도구를 가진 프로세스다. 같은 `edgenode` 코드를 쓴다 |
| D-PDM-13 | 노드 사이 연결은 간선 하나다. 짝맺기만 남긴다 | 사용자 결정 (2026-11-17). 상대 노드에 무엇을 하는가는 채팅(`PEER_CHAT_SRS`)이 정한다 |
| D-PDM-14 | 이름을 `edge` 로 바꾼다 | 사용자 결정. 짝은 친구가 아니라 망의 간선이다 |
| D-PDM-15 | 서버도 같은 단계에서 `edgenode` 를 쓴다 | 사용자 결정. 판정이 두 벌인 기간을 만들지 않고, 기존 짝맺기 시험이 바뀐 코드를 그대로 검증한다 |
| D-PDM-16 | 축소(단계 3)를 이름 변경(단계 4)과 이관(단계 5)보다 먼저 한다 | 지울 코드의 이름을 바꾸거나 옮기는 일을 하지 않는다 |
| D-PDM-18 | `peer` 라는 이름을 모두 없앤다. Run 동료 명부는 `team`, 신원 파일은 `edge-*.pem`, `pn-row` 는 `set-row` | 사용자 결정 (2026-11-17). 이름이 같으면 헷갈린다. 맺은 간선이 없으므로 신원을 옮기지 않는다 |
| D-PDM-17 | 노드 포트 경로·초대 코드 머리도 `edge` 로 바꾼다. 옛 경로를 받지 않는다 | 이름을 한 벌로 둔다. 초대는 10분만 살고, 이미 맺은 간선은 지문으로 저장돼 있어 경로가 바뀌어도 남는다 |

### 4.1 동작 변경 (D-PDM-4 의 예외)

| 항목 | 이전 | 새 동작 | 이유 |
|---|---|---|---|
| 프로토콜 명령 | 짝에게 6개 명령을 보낸다 | 없다. 노드 포트는 짝맞춤만 받는다 | D-PDM-13 |
| `dmctl msg --to <노드>/<uuid>` | 다른 노드의 에이전트에 보낸다 | 잘못된 대상으로 거절한다 | D-PDM-13 |
| 허용 폴더·마지막 응답 시각 | 설정 화면과 `dmctl peers` 에 보인다 | 없다 | 원격 기동·명령에만 쓰였다 |
| 짝 확인(pending-out → paired) | `pair/confirm` 또는 그 짝에 명령이 성공하면 확정 | `pair/confirm` 으로만 확정. 놓치면 만료 뒤 다시 짝맺는다 | 명령이 없다 |
| 이름 | peer, `/api/peers`, `peers.json`, `dmctl peers` | edge, `/api/edges`, `edges.json`, `dmctl edges` | D-PDM-14. 파일은 옮긴다(FR-PDM-71) |
| 옛 판과의 짝맞춤 | 된다 | 경로가 달라 되지 않는다. 양쪽을 새 판으로 올린 뒤 짝맺는다 | D-PDM-17 |
| 감사 로그 자리 | `server.log` 의 `peer audit` 줄 | 데몬 로그의 `edge audit` 줄 | 짝맞춤을 처리하는 프로세스가 데몬이다 |
| `peer-spawns.json` | 홈에 파일로 남는다 | 없다 | 원격 기동이 없다 |
| 서버만 다시 뜰 때 | 노드도 함께 내려갔다 올라온다. 짝맞춤 대기(메모리)가 사라진다 | 노드 포트만 잠깐 닫힌다. 짝맞춤 대기·속도 제한이 그대로 남는다 | D-PDM-1 |
| 옛 데몬과 새 서버 | 노드 기능이 동작한다 | 데몬을 다시 시작할 때까지 노드 기능이 꺼진다 | D-PDM-10 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-PDM-1 | FR-PDM-1 | Go: 옮긴 패키지의 기존 시험 | 모두 통과 (끝) |
| TC-PDM-2 | FR-PDM-10·11 | Go: 서버 통로 + 데몬 노드 소켓, 실제 TLS 연결 | 서버는 바이트를 그대로 옮기고, TLS 판정은 데몬이 한다 (끝) |
| TC-PDM-3 | FR-PDM-12·13 | Go: 발신 소켓으로 연결 성공·실패, 서버 없음 | 성공이면 지문 고정 TLS, 실패·서버 없음은 unreachable (끝) |
| TC-PDM-20 | FR-PDM-60·61 | Go: 짝인 노드가 옛 명령 경로 6개와 `/api/peers/call` 을 부름 | 모두 404 |
| TC-PDM-21 | FR-PDM-62 | Go(dmctl): `peer tools` 등 지운 하위 명령, `msg --to a/b` | 모르는 명령·잘못된 대상으로 실패, 원격 호출 없음 |
| TC-PDM-22 | FR-PDM-64 | Go: `peer-spawns.json` 이 있는 홈으로 노드 계층 기동 | 파일이 지워진다 |
| TC-PDM-23 | FR-PDM-65·66 | Go: `allowedDirs` 가 든 설정 파일 읽기·PUT, 조회 응답 | 항목이 응답·파일에 없다. `lastSeen` 이 없다 |
| TC-PDM-24 | FR-PDM-63·67·68 | Go: 엔벨로프 인용 시험, 안내문 시험, 오류 카탈로그 시험 | PEER 표지·원격 절·지운 코드가 없다 |
| TC-PDM-25 | FR-PDM-70 | Go: 짝맞춤 시험을 새 경로·초대 머리로 | 통과. 옛 경로는 404 |
| TC-PDM-26 | FR-PDM-71 | Go: `peers.json` 만 있음 / 둘 다 있음 / 둘 다 없음, 옛 `node-*.pem` 있음 | 옮김 / `edges.json` 사용·옛 파일 유지 / 빈 설정, 옛 신원 파일 지움·`edge-*.pem` 생성 |
| TC-PDM-27 | FR-PDM-72 | Go(서버·dmctl): `/api/runs/team`, `dmctl run team`, 옛 경로·옛 하위 명령, 프리앰블 | 새 이름으로 동작, 옛 이름은 404·실패, 프리앰블이 `dmctl run team` 을 안내 |
| TC-PDM-4 | FR-PDM-20~22·2 | Go: 노드 둘(서버 통로+데몬 노드 쌍 둘)로 짝맞춤 전 과정 | PEER_NETWORK 짝맞춤 시험 기대와 같다 |
| TC-PDM-7 | FR-PDM-30·31·33 | Go + dmctl: 로컬 API 전부를 데몬 경유로 | 응답 모양이 직접 모드와 같다 |
| TC-PDM-9 | FR-PDM-27 | Go: 짝맞춤 중 push `edges` | 서버가 `edges_changed` 를 같은 본문으로 방송한다 |
| TC-PDM-10 | FR-PDM-50·51 | Go: `edge` 기능 없는 가짜 데몬 | 노드 포트 닫힘, 로컬 API 409 `edge_daemon_restart` |
| TC-PDM-11 | FR-PDM-52 | Go: 직접 모드로 짝맞춤 시험 | 모두 통과 |
| TC-PDM-12 | NFR-PDM-1 | 설정 화면 e2e(`edges-settings.spec.ts`) | 통과 |

## 6. 비목표 (Non-goals)

1. 채팅, 망 이웃, 사람 확인 도우미. `PEER_CHAT_SRS` 에서 다룬다 (D-PDM-3).
2. 지운 명령(원격 메시지·원격 기동·에이전트 목록)을 다른 모양으로 되살리는 일.
3. 옛 판(`/peer/v1/`)과의 호환.
4. 데몬을 다시 띄우지 않고 이 변경을 적용하는 방법.
5. 서버가 꺼져 있는 동안 원격 연결을 받는 방법(데몬이 노드 포트를 직접 여는 방식).

## 7. 위험 (Risks)

| 위험 | 등급 | 대응 |
|---|---|---|
| 노드 코드를 고칠 때마다 데몬을 다시 띄워야 하고, 그때 모든 터미널 세션이 끊긴다 | MEDIUM | 사용자가 받아들인 대가(D-PDM-1). 단계마다 보고에 적는다(NFR-PDM-5) |
| 서버가 꺼져 있는 동안 노드에 닿을 수 없다 | LOW | D-PDM-2·6 의 결과. 데몬의 상태는 남으므로 서버가 돌아오면 바로 이어진다 |
| Run 동료 명부 이름이 바뀌어 이미 떠 있는 에이전트가 옛 `dmctl run peers` 를 부른다 | LOW | FR-PDM-72. 새 Run 부터 프리앰블이 `dmctl run team` 을 안내한다. 옛 명령은 모르는 하위 명령으로 바로 실패한다 |
| 승인 확인(confirm)을 놓친 쪽이 대기로 남는다 | LOW | §4.1. 만료 뒤 다시 짝맺는다. 화면은 지금처럼 대기 상태를 보인다 |
| 같은 사용자의 다른 프로세스가 `node.sock` 에 붙어 프리앰블의 출발지 주소를 꾸민다 | LOW | 프리앰블은 주소 기본값에만 쓴다. 신원 판정은 TLS 클라이언트 인증서로만 한다 |
| 같은 사용자의 다른 프로세스가 `dial.sock` 으로 임의 TCP 연결을 연다 | LOW | 그 프로세스가 스스로 열 수 있는 연결과 같다. 권한이 늘지 않는다 |

## 8. 단계 (Phases)

| 단계 | 묶음 | 완료 조건 | 데몬 재시작 |
|---|---|---|---|
| 1 | M | 패키지 이동, 기존 시험 통과 | 필요 없음 (끝) |
| 2 | L | 통로 부품, TC-PDM-2·3 | 필요 없음 (부품만, 끝) |
| 3 | R | 간선 축소, TC-PDM-20~24 | 필요 (데몬 `paste` 의 `foreground` 를 지운다. 새 서버는 옛 데몬과도 동작한다) |
| 4 | E | 이름 변경, TC-PDM-25·26 | 필요 없음 (데몬은 아직 노드 코드를 쓰지 않는다, 끝) |
| 5 | N | 데몬이 노드, 서버는 통로·위임, TC-PDM-4·7·9~11 | 필요 (끝) |
| 6 | X | `edges.md`·`api.md`·`errors.md`·`architecture.md`·홈 폴더 표, e2e TC-PDM-12 | 필요 (문서 끝, e2e 는 사용자 확인) |
