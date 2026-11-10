# SRS: dongminal 노드 간 통신 (Peer Network) — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: §8 단계 3~6. 단계 1(N)·2(P)는 끝났다. FR-PNW-28(`node.info` 로 회복)과 `dmctl peers` 의 마지막 응답 시각은 단계 3, 사유·승인 대기의 화면 표시는 단계 5 에서 붙인다

## 1. 개요

### 1.1 목적

접수한 요청은 다음과 같습니다.

> **"다른 dongminal 로 메시지를 보내거나 할 수 있게끔, 특히 다른 dongminal 의 에이전트에게 메시지를 보낼 수 있게 하면 dongminal 을 설치한 pc 의 에이전트끼리 소통을 해서 여러 pc 를 망으로 이을 수 있잖아."**

이 SRS는 짝맞춘(paired) dongminal끼리 **정해진 프로토콜 명령**으로 통신하게 합니다. 한 PC의 에이전트는 다른 PC의 에이전트 목록을 보고, 메시지를 보내고, 새 에이전트를 띄워 첫 프롬프트를 줄 수 있습니다.

### 1.2 범위

**포함**

| 묶음 | 내용 |
|---|---|
| N | 노드 신원(인증서·키)과 노드 전용 리스너 |
| P | 짝맞춤: 초대 코드, 등록 요청, 승인, 해제 |
| R | 프로토콜 명령 6개 (`node.info` · `agents.list` · `message.send` · `agent.spawn` · `agent.status` · `agent.close`) |
| C | 로컬 API와 `dmctl` 명령 |
| U | 설정 화면 `Peers` 탭 |
| S | 안전장치: 셸 보호, 폴더 제한, 원격 엔벨로프, 감사 로그, 상한 |

**미포함** — §6 비목표를 봅니다.

### 1.3 인터뷰 결정 (2026-11-10)

| # | 질문 | 결정 |
|---|---|---|
| D-1 | 다른 노드가 접속할 자리 | **노드 전용 포트**를 따로 연다. UI는 지금처럼 loopback에 둔다. 포트·듣는 주소·켜기/끄기는 사용자가 정한다. 기본은 꺼짐 |
| D-2 | 노드 전용 포트에 access(IP 목록)를 적용하는가 | 적용하지 않는다. 짝맞춤(인증서)만으로 지킨다 |
| D-3 | 인증 방식 | mTLS + 인증서 고정(pinning) |
| D-4 | 상대를 찾는 방법 | 사용자가 하나씩 직접 등록한다. 자동 탐색·스캔은 하지 않는다 |
| D-5 | 등록 절차 | B가 초대 코드를 만들고, A가 붙여 넣고, B가 한 번 더 승인한다. 화면과 dmctl 양쪽에서 할 수 있다. 한 번 등록하면 양방향이다 |
| D-6 | 수신 범위 | 짝맞춘 노드는 상대의 **모든 에이전트**와 주고받는다. 도구별 수신 허용은 두지 않는다 |
| D-7 | 상대가 닿지 않을 때 | 요청 1회에 결과를 바로 돌려준다. 큐·재시도는 없다 |
| D-8 | 원격 기능의 형태 | 원격으로는 정해진 프로토콜 명령만 오간다. 셸 문자열이나 임의 입력은 오가지 않는다 |
| D-9 | 프로토콜 명령 | 사용자 지정 3개(list·send·spawn) + `node.info` · `agent.status` · `agent.close` |
| D-10 | `agent.spawn` 제한 | 폴더만 제한한다(받는 노드가 정한 허용 폴더 안). 권한 모드는 받는 노드의 평소 설정을 따르며 보내는 쪽이 정할 수 없다 |

### 1.4 용어

| 용어 | 뜻 |
|---|---|
| 노드 | dongminal 서버 하나 |
| 노드 포트 | 다른 노드만 접속하는 전용 TCP 리스너. 기본 58147 |
| 노드 인증서 | 노드가 처음 켤 때 만드는 자기 서명 인증서와 그 개인키 |
| 지문 | 노드 인증서 공개키(SPKI)의 SHA-256. 노드의 신원이다 |
| 짝(peer) | 서로의 지문을 저장한 상대 노드 |
| 초대 코드 | 짝맞춤을 시작하는 일회용 문자열. 주소·포트·지문·일회용 토큰을 담는다 |
| 원격 주소 | `<노드 이름>/<도구 uuid>`. 예: `office/3f2a…` |
| 에이전트 도구 | 전경 프로그램이 에이전트 등록부(`agentadapter`)의 실행 파일인 도구 |
| 원격 엔벨로프 | 다른 노드에서 온 메시지를 감싸는 형식 (§3.6) |

### 1.5 참고

- `internal/webserver/httpapi/handlers_toolio.go:124-205` — `deliverToTool`, `apiToolMessage`, `agentEnvelope`
- `internal/webserver/httpapi/handlers_runs_headless.go` — 탭 없는 도구 생성 (`/api/tools/headless`)
- `internal/shared/agentadapter/adapter.go:143-330` — 에이전트 등록부, `LaunchLine`, `ExitCommand`
- `internal/webserver/hub/foreground.go` — 도구별 전경 프로그램 이름
- `internal/webserver/httpapi/server.go:396` — 지금의 유일한 리스너
- `docs/internal/ACCESS_ALLOWLIST_SRS.md`, `docs/internal/REQUEST_GATE_SRS.md` — 지금의 접근 제어

---

## 2. 현재 상태 (코드 근거)

- 서버는 리스너 하나만 연다(`server.go:396`). 기본 주소는 `127.0.0.1:58146`이다(`dmenv.go:66-67`). 다른 PC가 닿으려면 `--expose`로 **UI 전체**(터미널·파일·명령 실행)를 함께 열어야 한다.
- 접근 제어는 출발지 IP 목록(access)뿐이다. 인증 헤더·TLS가 없다(ACCESS_ALLOWLIST_SRS §1.2).
- `dmctl msg`는 `POST /api/tools/message`이고, 서버가 엔벨로프를 만들어 받는 도구의 터미널에 붙여 넣고 Enter를 친다(`handlers_toolio.go:131-180`). 받는 도구가 셸이면 그 글자가 명령으로 실행된다.
- 노드의 신원을 나타내는 값(키·인증서·노드 이름 설정)이 없다.

---

## 3. 요구사항

### 3.1 묶음 N — 노드 신원과 노드 포트

- **FR-PNW-1** 서버는 처음 시작할 때 노드 인증서(ECDSA P-256, 자기 서명, 유효 기간 10년)와 개인키를 만든다. 개인키 파일은 권한 `0600`으로 홈 폴더에 둔다. 이미 있으면 다시 만들지 않는다.
- **FR-PNW-2** 노드 설정은 서버가 소유하는 파일 `peers.json`에 둔다. 항목은 `enabled`(기본 false), `port`(기본 58147), `bind`(기본 `0.0.0.0`), `name`(기본 호스트 이름), `advertise`(다른 노드가 나에게 닿을 주소, 기본 빈 값), `allowedDirs`(기본 빈 목록), `peers`(짝 목록)이다.
- **FR-PNW-3** 노드 이름은 `[A-Za-z0-9._-]` 1~32자다. 다른 문자는 저장할 때 거절한다.
- **FR-PNW-4** `enabled`가 참일 때만 노드 포트를 연다. 거짓이면 그 포트에 아무것도 듣지 않는다.
- **FR-PNW-5** 노드 포트는 TLS 1.3만 받는다. 서버 인증서는 노드 인증서다. 클라이언트 인증서를 반드시 요구한다.
- **FR-PNW-6** 노드 포트의 경로는 `/peer/v1/*`뿐이다. UI·`/api/*`·`/ws`·정적 자산은 이 포트에서 404를 돌려준다.
- **FR-PNW-7** 노드 포트에는 access(IP 목록)와 요청 게이트의 Host/Origin 판정을 적용하지 않는다 (D-2).
- **FR-PNW-8** `port`·`bind`·`enabled`가 바뀌면 노드 포트를 다시 연다. UI 리스너와 진행 중인 UI 요청에는 영향이 없다.
- **FR-PNW-9** 노드 포트를 열지 못하면(포트 사용 중 등) 서버는 계속 동작하고, 설정 화면과 `dmctl peers`에 그 사유를 보인다.

### 3.2 묶음 P — 짝맞춤

- **FR-PNW-20** 초대(`invite`)는 일회용 토큰(128비트 난수)을 만든다. 토큰은 10분 뒤 또는 한 번 쓰면 사라진다. 동시에 살아 있는 초대는 하나다. 새 초대를 만들면 이전 초대는 사라진다.
- **FR-PNW-21** 초대 코드는 `dmpeer1:` 접두어 + base64url(JSON `{addr, port, fp, token}`)이다. `addr`는 `advertise`가 있으면 그 값, 없으면 사용자가 초대를 만들 때 고른 이 노드의 주소다.
- **FR-PNW-22** 초대 코드를 받은 노드(A)는 B의 노드 포트에 연결하고, **B의 서버 인증서 지문이 코드의 `fp`와 같을 때만** 진행한다. 다르면 아무것도 보내지 않고 실패한다.
- **FR-PNW-23** A는 `POST /peer/v1/pair`로 `{token, name, addr, port, proto}`를 보낸다. A의 지문은 TLS 클라이언트 인증서에서 B가 직접 읽는다.
- **FR-PNW-24** `/peer/v1/pair`는 짝이 아닌 클라이언트 인증서도 받는 **유일한 경로**다. 살아 있는 초대가 없으면 무조건 거절한다. 틀린 토큰을 5번 받으면 그 초대를 폐기한다.
- **FR-PNW-25** 토큰이 맞으면 B는 토큰을 소비하고 **승인 대기** 항목을 만든다(A의 이름·주소·지문). 승인 대기는 10분 뒤 사라진다. A에는 `pending`을 돌려준다.
- **FR-PNW-26** A는 B를 `pending-out` 상태로 저장한다(B의 이름·주소·지문).
- **FR-PNW-27** B의 사용자가 승인하면 B는 A를 짝으로 저장하고 `POST /peer/v1/pair/confirm`을 A에 보낸다. A는 보낸 쪽 지문이 `pending-out`의 지문과 같으면 B를 짝으로 바꾼다.
- **FR-PNW-28** A가 confirm을 받지 못한 경우(그때 A의 노드 포트가 닫혀 있었음 등), A가 다음에 B에 `node.info`를 불러 성공하면 B를 짝으로 바꾼다.
- **FR-PNW-29** 거절하거나 승인 대기가 만료되면 B는 아무것도 저장하지 않는다. A의 `pending-out`은 10분 뒤 사라진다.
- **FR-PNW-30** 짝 이름은 **받는 쪽이 저장한 이름**이다. 같은 이름이 이미 있으면 승인할 때 사용자가 다른 이름을 정한다. 상대가 보낸 이름은 기본값으로만 쓴다.
- **FR-PNW-31** 짝 해제(`remove`)는 그 노드의 지문을 지운다. 그 뒤 그 노드의 요청은 TLS 단계에서 거절된다. 상대 쪽 기록은 지우지 않는다(상대가 따로 해제한다).
- **FR-PNW-32** 짝의 주소는 사용자가 고칠 수 있다. 신원은 지문이므로 주소를 바꿔도 짝은 유지된다.
- **FR-PNW-33** 등록할 때 A의 노드 포트가 꺼져 있으면, A의 화면과 dmctl은 "상대가 나에게 보낼 수 없다"고 미리 알린다. 등록 자체는 막지 않는다.

### 3.3 묶음 R — 프로토콜

공통

- **FR-PNW-40** 모든 프로토콜 명령은 `POST /peer/v1/<명령>`이고 본문과 응답은 JSON이다.
- **FR-PNW-41** 짝맞춤 경로(FR-PNW-24, 27)를 뺀 모든 명령은 **TLS 클라이언트 인증서의 지문이 짝 목록에 있을 때만** 처리한다. 없으면 TLS 단계에서 끊는다.
- **FR-PNW-42** 응답은 성공이면 200과 결과, 실패면 4xx/5xx와 `{code, message}`다. `code`는 기존 오류 카탈로그(`apierr`)에 등록한다.
- **FR-PNW-43** 요청 본문 상한은 64 KiB, `message`·`prompt` 상한은 16 KiB다. 짝마다 분당 60회를 넘으면 429를 돌려준다.
- **FR-PNW-44** 보내는 쪽의 연결 시간 한도는 5초, 요청 시간 한도는 15초다.

명령

| ID | 명령 | 입력 | 결과 |
|---|---|---|---|
| **FR-PNW-50** | `node.info` | 없음 | `name`, `version`, `proto`(정수, 이 SRS는 1), `commands`(지원 명령 목록), `agents`(이 노드에 설치된 에이전트 id 목록), `allowedDirs` |
| **FR-PNW-51** | `agents.list` | 없음 | 에이전트 도구 목록. 각 항목은 `toolId`, `agent`, `window`, `tab`, `state`, `cwd`, `spawnedByYou`(이 짝이 띄운 것인가) |
| **FR-PNW-52** | `message.send` | `to`(도구 uuid), `from`(보낸 도구 uuid), `message` | `{toolId, len}` |
| **FR-PNW-53** | `agent.spawn` | `agent`, `cwd`, `prompt`, `placement`(`window`·`tab`), `at`(placement=`tab`일 때 기준 도구 uuid), `name`(선택) | `{toolId, headless}` |
| **FR-PNW-54** | `agent.status` | `toolId` | `state`: `working` · `idle` · `waiting` · `ended` · `unknown` |
| **FR-PNW-55** | `agent.close` | `toolId` | `{closed:true}` |

명령별 규칙

- **FR-PNW-56** `agents.list`에는 에이전트 도구만 나온다. 셸만 도는 도구는 나오지 않는다.
- **FR-PNW-57** `message.send`는 대상이 에이전트 도구일 때만 전달한다. **전달 직전에 전경 프로그램을 다시 조회한다.** 대상이 없으면 404 `peer_target_not_found`, 에이전트가 아니면 409 `peer_target_not_agent`로 거절하고 아무것도 넣지 않는다.
- **FR-PNW-58** `agent.spawn`의 `agent`는 이 노드의 등록부에 있고 실행 파일이 설치된 것이어야 한다. 아니면 400 `peer_agent_unavailable`.
- **FR-PNW-59** `agent.spawn`의 `cwd`는 심볼릭 링크를 푼 실제 경로가 `allowedDirs` 중 하나와 같거나 그 아래여야 한다. 아니면 403 `peer_dir_not_allowed`. `allowedDirs`가 비어 있으면 모든 spawn을 이 코드로 거절한다.
- **FR-PNW-60** `agent.spawn`의 기동줄은 등록부의 `LaunchLine`으로 만든다. 첫 프롬프트는 원격 엔벨로프(§3.6)로 감싼다. **보내는 쪽은 인자·권한 모드·환경 변수를 정할 수 없다.**
- **FR-PNW-61** `agent.spawn`은 이 노드에 브라우저가 연결돼 있으면 `placement`대로 새 창이나 탭에 띄운다. 연결된 브라우저가 없으면 헤드리스 도구로 띄우고 `headless:true`를 돌려준다. 헤드리스 도구는 기존 부착 기능으로 나중에 화면에 붙일 수 있다.
- **FR-PNW-62** `agent.spawn`으로 만든 도구는 **띄운 짝의 지문**과 함께 기록한다. 이 기록은 서버를 다시 시작해도 남는다.
- **FR-PNW-63** `agent.close`는 FR-PNW-62 기록의 지문이 요청한 짝과 같을 때만 처리한다. 다르면 403 `peer_not_owner`. 처리는 등록부의 `ExitCommand`를 보낸 뒤 도구를 닫는다(Run 정리와 같은 순서).
- **FR-PNW-64** `agent.status`는 기존 활동 상태(`/api/tools/activity/get`)와 같은 값을 쓴다. 대상이 에이전트 도구가 아니면 `ended`다.

### 3.4 묶음 C — 로컬 API와 dmctl

- **FR-PNW-70** 로컬 API는 UI 리스너(loopback)에만 둔다: `GET /api/peers`, `PUT /api/peers/node`, `POST /api/peers/invite`, `POST /api/peers/add`, `GET /api/peers/pending`, `POST /api/peers/approve`, `POST /api/peers/reject`, `POST /api/peers/remove`, `PUT /api/peers/address`, `POST /api/peers/call`.
- **FR-PNW-71** `POST /api/peers/call`은 `{peer, op, args}`를 받아 그 짝에 프로토콜 명령을 보내고 결과를 그대로 돌려준다. 보내는 쪽 서버가 TLS·지문 확인·시간 한도를 모두 처리한다.
- **FR-PNW-72** `message.send`의 `from`은 보내는 쪽 서버가 **호출한 도구**(`DONGMINAL_TOOL_ID`)로 채운다. 지금 `dmctl msg`의 `resolveSender`와 같은 규칙이다.
- **FR-PNW-73** dmctl 명령:

| 명령 | 하는 일 |
|---|---|
| `dmctl peers [--json]` | 노드 포트 상태, 짝 목록(이름·주소·상태·마지막 응답 시각), 승인 대기 |
| `dmctl peer invite [--addr <주소>]` | 초대 코드를 만들어 출력 |
| `dmctl peer add <코드> [--name <이름>]` | 초대 코드로 등록 요청 |
| `dmctl peer approve <요청 id> [--name <이름>]` / `peer reject <요청 id>` | 승인 대기 처리 |
| `dmctl peer remove <노드>` | 짝 해제 |
| `dmctl peer info <노드>` | `node.info` |
| `dmctl peer tools <노드> [--json]` | `agents.list` |
| `dmctl msg --to <노드>/<uuid> <메시지>` | `message.send`. `--to`에 `/`가 없으면 지금처럼 로컬 전달이다 |
| `dmctl peer spawn <노드> --agent <id> --cwd <경로> [--tab --at <uuid>] [--name <이름>] <프롬프트>` | `agent.spawn`. 성공하면 `<노드>/<uuid>`를 출력 |
| `dmctl peer status <노드>/<uuid> [--json]` | `agent.status` |
| `dmctl peer close <노드>/<uuid>` | `agent.close` |

- **FR-PNW-74** 짝이 닿지 않으면 dmctl은 `peer_unreachable` 사유를 출력하고 종료 코드 1로 끝난다 (D-7).

### 3.5 묶음 U — 설정 화면

- **FR-PNW-80** 설정에 `Peers` 탭을 둔다. 구역은 넷이다: **이 노드**(켜기/끄기, 이름, 포트, 듣는 주소, 알릴 주소, 허용 폴더, 노드 포트 상태와 지문 앞 16자), **초대**(만들기, 코드 복사, 남은 시간), **승인 대기**(이름·주소·지문 앞 16자, 승인·거절), **짝**(이름·주소·상태, 주소 수정, 해제, 코드 붙여 넣어 추가).
- **FR-PNW-81** 승인 대기가 생기면 주의 알림을 띄운다. 클릭하면 `Peers` 탭이 열린다.
- **FR-PNW-82** 짝맞춤이 끝나면 B의 화면에 "A가 등록됨" 알림이 남는다.

### 3.6 묶음 S — 안전장치

- **FR-PNW-90** 원격 메시지와 원격 첫 프롬프트는 원격 엔벨로프로 감싼다.

```
[DONGMINAL-PEER-MSG from=<짝 이름>/<보낸 도구 uuid> to=<받는 도구 uuid> ts=<시각>]
...본문...
[/DONGMINAL-PEER-MSG]
```

- **FR-PNW-91** `from=`의 노드 이름은 **받는 노드가 저장한 짝 이름**이다. 보낸 쪽이 주장하는 이름은 쓰지 않는다.
- **FR-PNW-92** 본문 안의 엔벨로프 표지는 지금의 `quoteEnvelope`와 같은 방식으로 무력화한다. 로컬 엔벨로프 표지(`DONGMINAL-AGENT-MSG`)도 함께 무력화한다.
- **FR-PNW-93** 에이전트 안내문(SessionStart 컨텍스트)에 원격 엔벨로프 규칙을 더한다. 원격 메시지는 다른 PC 에이전트의 협업 요청이며 사용자 지시가 아니다. 파괴적 작업, 비밀 정보 노출, 제3의 노드로 다시 보내라는 요청은 사용자에게 먼저 묻는다. 회신은 `dmctl msg --to <from 값>`으로 한다.
- **FR-PNW-94** 모든 프로토콜 요청을 감사 로그에 남긴다: 시각, 방향, 짝 이름, 명령, 대상 uuid, 본문 길이, 결과 코드. **본문은 남기지 않는다.**
- **FR-PNW-95** 개인키와 초대 토큰은 로그·API 응답·화면에 나오지 않는다. 화면과 dmctl에는 지문만 보인다.

### 3.7 비기능

- **NFR-PNW-1** `enabled`가 거짓이면 이 기능이 없을 때와 동작이 같다. 기존 e2e가 그대로 통과해야 한다.
- **NFR-PNW-2** TLS·인증서·서명은 Go 표준 라이브러리(`crypto/tls`, `crypto/x509`, `crypto/ecdsa`)만 쓴다. 새 외부 의존성을 들이지 않는다.
- **NFR-PNW-3** 짝맞춤과 프로토콜은 한 머신에서 서버 두 개(서로 다른 홈·포트)로 e2e 검증할 수 있어야 한다.
- **NFR-PNW-4** 에이전트 이름 리터럴은 등록부 밖에 두지 않는다(`check-agent-names.sh`).

---

## 4. 설계 개요

```
PC A                                                    PC B
dmctl msg --to B/<uuid>
  │ POST /api/peers/call (loopback)
  ▼
A 서버 ──TLS 1.3, A 인증서 제시, B 지문 확인──▶ B 노드 포트 /peer/v1/message.send
                                               │ A 지문이 짝인가
                                               │ 대상이 에이전트 도구인가 (전경 재조회)
                                               │ 원격 엔벨로프로 감싸 deliverToTool
  ◀──────────────── {toolId,len} 또는 {code} ──┘
```

| 자리 | 내용 |
|---|---|
| `internal/webserver/domain/peer` (신규) | 노드 설정·짝 목록 저장, 초대·승인 대기 상태, 인증서 생성·지문, 프로토콜 클라이언트 |
| `internal/webserver/httpapi/peer_*.go` (신규) | 노드 포트 핸들러(`/peer/v1/*`)와 로컬 API(`/api/peers/*`) |
| `server.go` | 노드 리스너를 UI 리스너와 따로 열고 닫는다 |
| `handlers_toolio.go` | `deliverToTool`·엔벨로프 무력화를 원격 경로와 함께 쓴다 |
| `internal/helper/runtimebin` | dmctl `peers`·`peer *`·`msg --to <노드>/<uuid>` |
| `web/js` | 설정 `Peers` 탭 |
| `docs/external` | `peers.md`(새 문서), `commands.md`, API 문서, 오류 카탈로그 |

---

## 5. 검증

| 요구 | 방법 |
|---|---|
| FR-PNW-1~3 | Go 단위: 인증서 생성·재사용, 키 파일 권한, 이름 검증 |
| FR-PNW-4~9 | Go 단위: 꺼짐이면 듣지 않음, `/api/*` 404, 클라이언트 인증서 없으면 거절, 재설정 시 다시 엶 |
| FR-PNW-20~33 | Go 단위 + 서버 둘 e2e: 정상 짝맞춤, 지문 불일치, 만료, 토큰 5회 오류, 거절, confirm 유실 후 `node.info`로 회복, 이름 충돌 |
| FR-PNW-40~44 | Go 단위: 짝 아닌 인증서 거절, 본문 상한, 분당 상한 |
| FR-PNW-50~64 | Go 단위(가짜 도구 허브): 명령별 성공·실패 코드, 셸 도구 거절, 폴더 밖 거절, 남이 띄운 도구 close 거절 |
| FR-PNW-70~74 | dmctl 단위: 인자 해석, `--to` 주소 분기, 닿지 않을 때 종료 코드 |
| FR-PNW-80~82 | e2e: Peers 탭에서 초대·승인·해제 |
| FR-PNW-90~95 | Go 단위: 엔벨로프 형식, 이름은 받는 쪽 값, 표지 무력화, 로그에 본문·토큰 없음 |
| NFR-PNW-1 | 기존 e2e 전체 통과 |

---

## 6. 비목표

1. 자동 탐색·주소 대역 스캔 (D-4).
2. 원격 화면·출력 읽기, 원격 입력 넣기, 원격 셸 실행 (D-8).
3. 보내지 못한 메시지의 큐·재시도 (D-7).
4. 도구별 수신 허용 (D-6).
5. 중계 서버·인터넷 직접 노출을 위한 기능.
6. 메시지 자동 재전달(A→B→C).
7. 원격 노드를 Run·issue-tree의 멤버로 두는 것. 후속 SRS에서 다룬다.
8. 에이전트에게 메시지를 넣는 방식 자체의 교체(터미널 붙여넣기 → 다른 경로). 이 SRS는 지금의 `deliverToTool`을 쓴다.

---

## 7. 위험

| 위험 | 등급 | 대응 |
|---|---|---|
| 짝 하나가 털리면 짝맞춘 모든 노드의 모든 에이전트에 메시지를 넣을 수 있다 (D-6) | HIGH | 짝 해제가 즉시 효력을 가진다(FR-PNW-31). 감사 로그(FR-PNW-94). 원격 엔벨로프와 안내문(FR-PNW-90~93) |
| 원격으로 띄운 에이전트가 받는 노드의 다른 터미널을 `dmctl send-input`으로 조작할 수 있다 | HIGH | 받는 노드의 평소 권한 모드를 따르므로, 그 노드에서 dmctl이 승인 없이 돌게 설정했다면 막을 수 없다. 이 사실을 `peers.md`에 적는다. 서버가 호출 도구를 강제로 판별할 수단(`DONGMINAL_TOOL_ID`는 자기 신고)이 없다 |
| 에이전트가 끝난 직후의 틈에 메시지가 셸로 들어간다 | MEDIUM | 전달 직전에 전경을 다시 조회한다(FR-PNW-57). 조회와 붙여넣기 사이의 아주 짧은 틈은 남는다 |
| 초대 코드가 새면 제3자가 승인 대기에 올라온다 | LOW | 일회용, 10분 만료, B의 승인 필요(D-5) |
| 노드 포트가 같은 망에 보인다 | LOW | 짝 아닌 상대는 TLS 단계에서 끊긴다. 초대가 살아 있는 10분 동안만 `/peer/v1/pair`가 토큰을 받는다 |
| 서로 다른 버전의 노드 | LOW | `node.info`의 `proto`·`commands`로 확인한다. 모르는 명령은 404 |

---

## 8. 단계

| 단계 | 묶음 | 완료 조건 |
|---|---|---|
| 1 | N | 인증서·설정 파일·노드 리스너. 꺼짐이면 영향 없음 |
| 2 | P | 짝맞춤 전 과정 (dmctl 기준) |
| 3 | R 일부 + C | `node.info` · `agents.list` · `message.send`, `dmctl msg --to <노드>/<uuid>`, 원격 엔벨로프·안내문 |
| 4 | R 나머지 | `agent.spawn` · `agent.status` · `agent.close` |
| 5 | U | 설정 `Peers` 탭, 승인 알림 |
| 6 | 문서 | `docs/external/peers.md`, 명령·API·오류 문서 |

---

## 9. 구현 메모

### 9.1 단계 2 (묶음 P) — 스펙이 비운 자리를 채운 값

| # | 자리 | 정한 값 | 근거 |
|---|---|---|---|
| I-1 | 짝이 아닌 인증서를 TLS 단계에서 받는 때 | 살아 있는 초대가 있을 때, 또는 그 지문이 `pending-out` 일 때만 받는다. 요청 단계에서 `/peer/v1/pair` 는 아무 인증서나, `/peer/v1/pair/confirm` 은 짝·`pending-out` 지문만, 나머지는 짝만 받는다 | FR-PNW-24·27·41. TLS 단계는 경로를 모른다 |
| I-2 | `pending-out` 의 자리 | `peers.json` 의 짝 항목에 `state:"pending-out"` 과 `expires` 로 둔다. 만료된 항목은 짝으로도 `pending-out` 으로도 세지 않는다 | FR-PNW-26 "저장한다", FR-PNW-29 10분 |
| I-3 | 초대 코드와 FR-PNW-95 | 토큰은 초대를 **만든 응답**에만 코드 안에 담겨 나간다. 조회(`GET /api/peers`)·로그에는 나오지 않는다 | FR-PNW-21 의 코드가 토큰을 담아야 짝맞춤이 된다 |
| I-4 | A 가 보내는 `addr` | A 의 `advertise`. 비어 있으면 빈 값을 보내고, B 는 그 연결의 출발지 IP 를 쓴다 | 사용자가 알릴 주소를 정하지 않은 흔한 경우 |
| I-5 | A 쪽 이름 충돌 | `--name` 을 주지 않았고 B 가 알린 이름이 이미 있으면 `-2`·`-3` … 을 붙인다. `--name` 이 이미 있으면 B 에 연결하기 전에 409 `peer_name_taken` | 토큰을 쓴 뒤에 실패하면 되돌릴 수 없다 |
| I-6 | 초대를 만들 조건 | 노드 포트가 열려 있어야 한다(409 `peer_port_closed`). 주소는 요청의 `addr`, 없으면 `advertise`, 둘 다 없으면 400 `peer_addr_required` | 닫힌 포트의 초대는 쓸 수 없다 |
| I-7 | 로컬 API 오류 본문 | 노드 포트와 같은 fs 방언 `{code,message}` | 원격 오류를 그대로 옮길 수 있다 (FR-PNW-71) |
| I-8 | 노드 설정 변경 진입점 | `PUT /api/peers/node` 를 단계 2 에 넣는다. 저장 뒤 노드 포트에 바로 적용한다(FR-PNW-8). dmctl 명령은 FR-PNW-73 에 없으므로 만들지 않는다 | 짝맞춤을 하려면 포트를 켤 수 있어야 한다 |
| I-9 | 승인 뒤 confirm 이 실패하면 | 승인은 성공으로 끝내고 `confirmed:false` 와 사유를 돌려준다 | FR-PNW-27·28. B 에는 이미 저장됐다 |
| I-10 | FR-PNW-28 (`node.info` 로 회복) | 단계 3 에서 `node.info` 와 함께 만든다 | §8 단계 3 |
