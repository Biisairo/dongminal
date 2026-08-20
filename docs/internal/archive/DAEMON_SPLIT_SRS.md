# SRS: 데몬 분리 — dongminald + dongminal (IEEE 29148 준수)

**상태**: IMPLEMENTED — Phase 1~5 구현 완료(`dongminald` 서브커맨드 `dongminal d`, `internal/server/paned.go`·`pane_client.go`·`attn_tracker.go`). 본 개정판은 실제 구현 동작과 견고성 보강(§4.4)을 반영한다.

**관련 문서**: `HOT_RELOAD_SRS.md`의 Option B를 본 문서로 대체·구체화.

**개정 이력**:
- rev.1 (PLANNED): 초기 계획서.
- rev.2 (IMPLEMENTED): 구현 반영 + 코드 리뷰 결함(동시성 레이스, FR-7 재연결, RPC 타임아웃, L2 idle, whoami, reattach 순서, 출력 백프레셔) 보강 요구사항(§4.4) 추가.

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

dongminal 서버 재시작 시 활성 PTY 셸 세션이 전부 소멸하는 문제를 해결한다. 셸 프로세스를 보유·관리하는 장수명 데몬(`dongminald`)과 브라우저·MCP·CLI와 통신하는 단수명 웹 서버(`dongminal`)를 분리하여, 웹 서버 코드 변경 후 재시작에도 셸 세션이 무중단 유지되도록 한다.

### 1.2 범위 (Scope)

- 대상: `cmd/dongminal/main.go`, `cmd/dongminald/main.go`(신설), `internal/server/pane.go`, `internal/outbuf/`, `internal/server/deps.go`, `internal/runtime/`
- 비대상: 프론트엔드(`web/`) — 변경 없음. 브라우저 새로고침은 기존 자동 재연결로 충분.
- 비대상: 머신 재부팅, SIGKILL, `dongminald` 자체 재시작.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **dongminald** | PTY 셸 프로세스를 보유·관리하는 장수명 백그라운드 데몬. 기능을 극도로 최소화하여(raw I/O relay + outbuf 버퍼링) 변경될 일이 거의 없도록 설계한다. 이름 관례는 `sshd`·`dockerd`·`launchd`를 따름. |
| **dongminal** | 사용자가 실행하는 메인 바이너리. HTTP/WS/SSE/MCP 핸들러, workspace 관리, code-server 관리, 설정, attention/activity 감지 등 **모든 지능**을 담당. `dongminald` 소켓에 연결하여 PTY I/O를 중계한다. |
| **paned.sock** | `$DONGMINAL_HOME/paned.sock` 경로의 Unix domain socket. dongminald가 listen, dongminal이 dial. |
| **Push Event** | dongminald가 연결된 dongminal에 일방향으로 전송하는 이벤트(output, exit). 응답을 기대하지 않는다. |
| **Reattach** | dongminal 재시작 후 dongminald 소켓에 재연결하여 기존 pane들의 outbuf snapshot + 실시간 스트림을 재수신하는 과정. |

### 1.4 참조

- `HOT_RELOAD_SRS.md`: 기존 분석 문서. 본 문서가 Option B를 구체화.
- `PANE_ATTENTION_NOTIFY_SRS.md`: 주의 알림 사양.
- `AGENT_ACTIVITY_PANEL_SRS.md`: 에이전트 활동 사양.
- `internal/server/pane.go`: 현재 Pane·PaneManager 구현.
- `internal/server/attention.go`: L1 OSC / L2 idle 감지 로직.
- `internal/server/activity.go`: 활동 감지 및 SSE broadcast.
- `internal/outbuf/stream.go`: 스크롤백 ring buffer.
- `internal/server/deps.go`: 인터페이스 정의.
- POSIX: `forkpty(3)`, `openpty(3)`, `setsid(2)`, `unix(7)`.

## 2. 배경 (Background)

### 2.1 현재 구조

```
dongminal (단일 프로세스)
 ├── HTTP/WS/SSE/MCP
 ├── workspace.Manager
 ├── CodeServerManager
 ├── CommandHub
 └── PaneManager
      ├── PTY fd → zsh #1
      ├── PTY fd → zsh #2
      └── PTY fd → bash #3
```

서버 종료(SIGTERM/HUP) → PaneManager 소멸 → PTY master fd close → 셸 프로세스들이 EIO를 받고 종료 → 모든 세션 소실.

`panes.json`에 메타데이터(ID, 이름, cwd)는 영속되나, 재시작 시 `LoadAll()`이 **완전히 새로운** 셸을 spawn 할 뿐 기존 셸에 재연결하지 못한다. PTY master fd는 프로세스 생명주기에 종속되므로, fd를 보유한 프로세스가 죽으면 원천적으로 복구가 불가능하다.

### 2.2 제약

- Go 단일 바이너리 배포 유지 (사용자에게 보이는 건 `dongminal` 하나). `dongminald`는 내부 서브커맨드로만 존재.
- OS = darwin / linux. Windows 비대상.
- 외부 데몬 의존성 금지. `dongminald`는 동일 바이너리의 서브프로세스로 실행.
- 기존 `panes.json` + `workspace.json` 호환성 유지.

### 2.3 핵심 통찰

POSIX의 한계상 **PTY fd를 쥔 프로세스가 죽으면 세션은 반드시 소멸한다**. 따라서 "완전한 세션 보존"은 이론적으로 불가능하다. 대신 본 설계의 전략은 이중이다:

1. **PTY fd를 쥐는 프로세스(dongminald)를 아주 작게 만들어서 변경 빈도를 0으로 수렴시킨다.** dongminald의 책임은 오직 `forkpty` + `read` + `write` + outbuf 버퍼링. 이 이상의 **어떤 지능도 넣지 않는다**.
2. **attention, activity, SSE, MCP 등 모든 지능은 dongminal에 둔다.** dongminal은 자주 바뀌어도 되고, 재시작해도 dongminald의 셸은 무사하다.

> 99%의 재시작은 dongminal 코드 변경 때문에 발생한다. dongminald는 거의 바뀌지 않는다. 결과적으로 **99%의 재시작에서 세션이 살아남는다**.

## 3. 아키텍처

### 3.1 목표 구조

```
dongminald (수명: months — 거의 재시작 없음)
 ├── PaneManager (셸 spawn·kill·resize)
 │    ├── PTY fd → zsh #1
 │    ├── PTY fd → zsh #2
 │    └── PTY fd → bash #3
 ├── outbuf.Stream (per pane — scrollback ring buffer)
 ├── readPTY: raw bytes → outbuf → push to dongminal
 └── Unix socket listen → paned.sock
      │
      │ JSON-Lines: output push + request/response
      │
dongminal (수명: hours/days — 자주 재시작)
 ├── PaneClient (Unix socket client, PaneHub 구현)
 ├── Attention 감지: 수신한 output bytes → L1 OSC / L2 idle
 ├── Activity 상태: dmctl activity → HTTP handler → in-memory
 ├── HTTP/WS/SSE/MCP 핸들러
 ├── workspace.Manager
 ├── CodeServerManager
 ├── CommandHub (SSE broadcast)
 └── settings
```

### 3.2 책임 경계

| 책임 | dongminald | dongminal |
|------|-----------|-----------|
| PTY spawn / kill / resize | ✅ | |
| readPTY (raw bytes 읽기) | ✅ | |
| outbuf 버퍼링 (scrollback) | ✅ | |
| raw output → dongminal push | ✅ | |
| PTY 입력 relay (write) | ✅ | |
| cwd 조회 | ✅ | |
| foreground process busy 확인 | ✅ | |
| panes.json LoadAll / SaveAll | ✅ | |
| L1 OSC attention 감지 | | ✅ |
| L2 idle attention 감지 | | ✅ |
| `dmctl notify` 수신·처리 | | ✅ |
| Activity 상태 관리 | | ✅ |
| `dmctl activity` 수신·처리 | | ✅ |
| HTTP / WebSocket / SSE / MCP | | ✅ |
| workspace.json 관리 | | ✅ |
| code-server 관리 | | ✅ |
| settings.json 관리 | | ✅ |
| runtime helper 설치 (bin/) | | ✅ |
| `dongminald` 생명주기 관리 | | ✅ |
| WS fan-out (output → 브라우저) | | ✅ |
| SSE broadcast | | ✅ |

### 3.3 왜 attention/activity를 dongminal에 두는가

**dongminald의 설계 원칙: "똑똑한 dtach".** 오직 터미널 raw I/O만 relay하고, 그 이상의 해석은 하지 않는다.

| 이유 | 설명 |
|------|------|
| **dongminald가 없을 땐 브라우저도 없다** | dongminal이 다운된 동안 attention 감지를 해도 알림을 받을 SSE 클라이언트가 존재하지 않는다. 감지는 무의미하다. |
| **dongminald 코드 변경 0을 향해** | attention 감지 로직(`detectAttentionSignal`, OSC 9/99/777, BEL 규칙, L2 threshold)은 시간이 지나면서 튜닝될 가능성이 높다. dongminal에 두면 dongminal만 재시작하고 셸은 유지된다. |
| **dmctl은 이미 HTTP를 탄다** | `dmctl notify`, `dmctl activity`는 현재도 HTTP POST를 통해 dongminal에 도달한다. 이걸 굳이 dongminald까지 relay 할 이유가 없다. |
| **아키텍처 단순화** | dongminald의 IPC 프로토콜이 method 6개 + push event 2개로 최소화된다. 구현·테스트·디버깅이 획기적으로 단순해진다. |

### 3.4 프로세스 생명주기

```
# 최초 실행 (콜드 스타트)
$ ./dongminal
  ├─ paned.sock 없음 → dongminald 서브프로세스 spawn
  │    dongminald ── 소켓 bind, panes.json 있으면 LoadAll()
  ├─ 소켓 bind 완료까지 폴링 (최대 2초)
  ├─ 연결 → hello → list → 기존 pane 확인
  └─ 정상 서비스 시작

# 정상 종료 (Ctrl+C, SIGTERM)
  ├─ workspace.Manager.Close()
  ├─ PaneClient 연결 close
  └─ dongminal 종료
       dongminald ── 계속 실행. 셸 유지, outbuf 계속 축적.

# 재시작 (코드 변경 후)
$ go build && ./dongminal
  ├─ paned.sock 이미 있음 → dial
  ├─ hello → dongminald가 모든 기존 pane의 outbuf snapshot을 output push로 전송
  ├─ list 로 기존 pane 확인 → workspace.json 복원
  └─ 정상 서비스 시작 (셸은 그대로, scrollback 복원됨)

# dongminald 비정상 종료 (crash, kill -9)
  dongminal ── 연결 끊김 감지 (readLoop EOF)
  ├─ dongminald 재시작 시도 (spawn)
  │    dongminald ── panes.json 기반 LoadAll (신규 셸, 기존 세션 소실)
  └─ 재연결 시도 (지수 백오프)
```

## 4. 요구사항 (Requirements)

### 4.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-1 | `dongminal`을 재시작해도 기존 PTY 셸 세션이 종료되지 않아야 한다. | 필수 |
| FR-2 | `dongminal` 재시작 후 WebSocket 클라이언트는 자동 재연결되며, dongminald outbuf에 보존된 스크롤백이 브라우저에 복원돼야 한다. | 필수 |
| FR-3 | `dongminald`는 `dongminal`이 연결되지 않은 상태에서도 셸을 계속 실행하고, outbuf를 축적해야 한다. | 필수 |
| FR-4 | `dongminal`이 `dongminald` 소켓에 재연결 시, 모든 기존 pane의 outbuf snapshot + 실시간 output이 수신돼야 한다. | 필수 |
| FR-5 | `dongminald`가 존재하지 않으면 `dongminal`이 자동으로 `dongminald`를 spawn하고 `panes.json` 기반으로 pane을 복원해야 한다. (콜드 스타트) | 필수 |
| FR-6 | `dongminal` 종료(Ctrl+C/SIGTERM)는 `dongminald`에 영향을 주지 않아야 한다. | 필수 |
| FR-7 | `dongminal`이 `dongminald`와의 연결이 끊기면 지수 백오프로 재연결을 시도하고, 실패 시 `dongminald`를 재시작해야 한다. | 필수 |
| FR-8 | 기존 `dongminal` 바이너리 하나만으로도 동작해야 한다 (`dongminald` 자동 실행). 사용자가 별도로 `dongminald`를 실행할 필요는 없다. | 필수 |
| FR-9 | `dongminald`는 자신의 PID를 `$DONGMINAL_HOME/paned.pid`에 기록해야 한다. | 권장 |
| FR-10 | attention/activity 감지는 dongminald가 push한 raw output을 dongminal이 해석하여 수행한다. dmctl notify/activity는 기존 HTTP handler가 직접 처리한다. | 필수 |

### 4.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|---------|
| NFR-1 | dongminal 재시작 후 reattach 소요시간 < 1초 (로컬, pane ≤20개). |
| NFR-2 | IPC 레이턴시: PTY 출력이 브라우저까지 도달하는 추가 지연 < 5ms (기존 대비). |
| NFR-3 | `dongminald` 추가 메모리: PaneManager + outbuf만. 추가 오버헤드 < 3MB. |
| NFR-4 | `dongminal`은 `dongminald`가 없는 콜드 스타트에서도 기존과 동일한 사용자 경험을 제공해야 한다. |

### 4.4 견고성 보강 요구사항 (Robustness — rev.2)

코드 리뷰에서 식별된 결함을 해소하기 위한 추가 요구사항. 모두 **필수**이며 §9 검증 대상이다.

| ID | 요구사항 | 근거 |
|----|---------|------|
| FR-11 | `dongminald`의 IPC 소켓 쓰기(응답 + push event)는 단일 직렬화 지점을 통해야 하며, 여러 goroutine의 동시 `Encode`로 인한 데이터 레이스·스트림 파손이 없어야 한다. | IPC 무결성 |
| FR-12 | `Pane`의 출력/종료 relay 콜백(`onOutput`/`onExit`)은 `readPTY` goroutine과 연결 wiring goroutine 간 데이터 레이스 없이 갱신·호출돼야 한다. | 메모리 안전성 |
| FR-13 | `dongminal`은 `dongminald` 연결 끊김을 감지하면 지수 백오프(1s→2s→…→max 30s)로 재연결하고, 소켓이 사라졌으면 `dongminald`를 재spawn 후 재연결해야 한다. 재연결 성공 시 활성 WS 구독은 자동 복구돼야 한다. | FR-7 구체화 |
| FR-14 | RPC `call`은 응답이 5초를 초과하면 에러를 반환하고 연결을 close하여 재연결 경로로 전이해야 한다. 무한 블록이 없어야 한다. | 실패 모드(hang) |
| FR-15 | 데몬 모드에서 L2 idle attention 감지가 동작해야 하며, idle 판정 전 `busy` RPC로 foreground 프로세스 실행 여부를 확인하여 busy pane은 idle로 보고하지 않아야 한다. | FR-10 / §6.5 |
| FR-16 | 데몬 모드에서 `/api/whoami`·MCP `who_am_i`의 RemoteAddr 기반 자동 pane 해석이 `dongminald`의 pane 목록(shell PID)을 이용해 동작해야 한다. | whoami 회귀 방지 |
| FR-17 | reattach 시 라이브 출력 구독 등록은 outbuf 스냅샷 취득보다 **먼저** 이뤄져, 스냅샷 시점과 구독 시점 사이의 출력이 유실되지 않아야 한다. | 데이터 무결성 |
| FR-18 | `output` push 전달 시 구독 채널이 가득 차면 출력을 무음 드롭하지 않고 블로킹 전달 또는 드롭 카운트 로깅으로 손실을 가시화해야 한다. | 데이터 무결성 |

### 4.3 제약 (Constraints)

- Go 표준 라이브러리 + `creack/pty`, `gorilla/websocket` 범위 내. 신규 외부 의존성 금지.
- `dongminal`과 `dongminald`는 동일 바이너리에서 파생된다(`dongminal d` 또는 `dongminald` 심링크).
- `panes.json`과 `workspace.json` 형식은 변경하지 않는다.
- 기존 테스트가 깨지지 않아야 한다.

## 5. IPC 프로토콜 상세

### 5.1 Transport

- **매체**: Unix domain socket, `SOCK_STREAM`
- **경로**: `$DONGMINAL_HOME/paned.sock`
- **Framing**: JSON-Lines — 각 메시지는 하나의 JSON 객체이며 `\n`(0x0A)로 구분된다.
- **인코딩**: UTF-8. 바이너리 데이터(PTY 출력)는 base64(RFC 4648, standard)로 인코딩하여 JSON 문자열 필드에 실는다.
- **연결 모델**: 1:1 — dongminald는 한 번에 하나의 dongminal 연결만 수용한다. 신규 연결 수립 시 기존 연결은 close.

### 5.2 메시지 형식

#### Request (dongminal → dongminald)

```jsonc
{ "id": 1, "method": "<name>", "params": { ... } }
```
- `id`: int64, monotonically increasing per connection. 응답 매칭.
- `method`: string, 호출할 메서드 이름.
- `params`: object, 메서드별 파라미터.

#### Response (dongminald → dongminal)

```jsonc
{ "id": 1, "result": { ... } }
{ "id": 1, "error": { "code": -32600, "message": "..." } }
```
- `id`: 요청의 id와 일치.
- `error`: 실패 시. code는 JSON-RPC 2.0 에러 코드를 따른다.

#### Push Event (dongminald → dongminal, no `id`)

```jsonc
{ "event": "<name>", "pane": "<pane_id>", ... }
```
- `id` 필드가 없다. 일방향 전송. 응답 없음.

### 5.3 메서드 정의 (총 6개)

#### `hello`

연결 초기화. dongminald는 hello 수신 시 version과 살아있는 pane id 목록을 반환하고, 연결된 모든 pane의 실시간 `output`/`exit` push 스트리밍을 시작한다.

```
→ {"id":1,"method":"hello","params":{"server_pid":98765}}
← {"id":1,"result":{"version":1,"pane_ids":["1","2","3"]}}
```

> **구현 주(rev.2)**: scrollback 복원은 hello 시 일괄 push가 아니라, dongminal이 WS 연결 시점에 pane별 `snapshot` RPC로 취득하는 방식으로 구현되었다(§6.2, FR-17). hello는 실시간 스트림만 개시한다.

#### `create`

새 pane 생성.

```
→ {"id":2,"method":"create","params":{"cwd":"/home/user","cols":120,"rows":40}}
← {"id":2,"result":{"id":"1","name":"Shell #1","pid":12345,"cols":120,"rows":40}}
```

#### `restore`

메타데이터로 pane 복원 (콜드 스타트 LoadAll).

```
→ {"id":3,"method":"restore","params":{"id":"1","name":"Shell #1","cwd":"/home/user","cols":120,"rows":40}}
← {"id":3,"result":{"id":"1","pid":12345,"cols":120,"rows":40}}
```

#### `kill`

pane 종료.

```
→ {"id":4,"method":"kill","params":{"id":"1"}}
← {"id":4,"result":{}}
```

#### `write`

PTY에 입력 전송.

```
→ {"id":5,"method":"write","params":{"id":"1","data":"ZWNobyBoZWxsbwo="}}
← {"id":5,"result":{}}
```

#### `resize`

PTY 크기 변경.

```
→ {"id":6,"method":"resize","params":{"id":"1","cols":120,"rows":40}}
← {"id":6,"result":{}}
```

#### `list`

살아있는 모든 pane 목록.

```
→ {"id":7,"method":"list"}
← {"id":7,"result":{"panes":[
    {"id":"1","name":"Shell #1","pid":12345,"cols":120,"rows":40},
    {"id":"2","name":"Shell #2","pid":12346,"cols":120,"rows":40}
]}}
```

#### `snapshot`

특정 pane의 outbuf snapshot. 재연결 시 scrollback 복원용.

```
→ {"id":8,"method":"snapshot","params":{"id":"1"}}
← {"id":8,"result":{"data":"<base64>","totalBytesIn":4096,"totalBytesDrop":0,"retained":2048}}
```

#### `cwd`

pane의 현재 작업 디렉토리.

```
→ {"id":9,"method":"cwd","params":{"id":"1"}}
← {"id":9,"result":{"cwd":"/home/user/project"}}
```

#### `busy`

pane에 실행 중인 foreground 프로세스가 있는지. (dongminal의 L2 idle 감지가 판단용으로 호출)

```
→ {"id":10,"method":"busy","params":{"id":"1"}}
← {"id":10,"result":{"busy":true}}
```

### 5.4 Push Event 정의 (총 2개)

#### `output`

PTY 출력 데이터. **이것이 유일한 데이터 스트림이다.** dongminal은 이 bytes를 받아서:
1. WS client에 fan-out
2. 자체 outbuf에 기록
3. `observeOutput()` → L1 OSC attention 감지
4. `lastOutputAt` 갱신 → L2 idle sweeper가 참조

```jsonc
{"event":"output","pane":"1","data":"<base64>"}
```

#### `exit`

pane 종료.

```jsonc
{"event":"exit","pane":"1","code":0}
```
- dongminal은 WS client에 OpExit 전송, workspace invalidation 수행.

### 5.5 의도적으로 제외된 것

| 제외된 메서드/이벤트 | 이유 |
|-------------------|------|
| `signal_attention` | dmctl notify → HTTP POST `/api/panes/:id/attention/set` → dongminal handler가 직접 처리. dongminald는 모른다. |
| `attend` | 사용자 focus → dongminal이 attention state 직접 해제. dongminald는 모른다. |
| `set_activity` | dmctl activity → HTTP POST `/api/panes/activity/set` → dongminal handler가 직접 처리. |
| `attention` push | dongminald는 raw bytes만 push. OSC/BEL 해석은 dongminal이 한다. |
| `attention_clear` push | 동일. |
| `activity` push | 동일. |

## 6. 상세 설계

### 6.1 dongminald (`cmd/dongminald/main.go` 신설)

dongminald는 기존 `PaneManager`를 그대로 사용하되, **attention/activity 관련 코드는 제거하거나 무력화**한다. `PaneManager`의 `attnHooks`, `SetAttentionNotifier`, `SetActivityNotifier`, `sweepIdle`, `StartAttentionSweeper`는 dongminald에서 사용되지 않는다.

```go
func main() {
    // 1. DONGMINAL_HOME 확인, pidfile 기록
    // 2. PaneManager 생성 (attention/activity 관련 필드는 nil)
    // 3. panes.json 있으면 LoadAll() — 콜드 스타트
    // 4. Unix socket listen (paned.sock)
    // 5. 연결 accept → handleConn(conn, pm)
}
```

**handleConn**:
- `hello` 수신 → 모든 pane의 outbuf를 `output` push로 snapshot 전송 → 이후 실시간 스트리밍 시작
- readPTY goroutine: PTY read → outbuf.Feed → `output` push event
- pane 종료 시: `exit` push event
- request dispatch: method → PaneManager 메서드 호출 → 응답
- 연결 종료 시: push 중단, PaneManager 파괴하지 않음
- 신규 연결: 이전 연결 close → 새 연결로 hello + snapshot push 재개

### 6.2 PaneClient (`internal/server/pane_client.go` 신설)

`PaneHub` 인터페이스를 구현하는 dongminald 연결 클라이언트:

```go
type PaneClient struct {
    conn    net.Conn
    mu      sync.Mutex
    pending map[int64]chan json.RawMessage
    nextID  int64

    // push event handlers (dongminal이 주입)
    OnOutput func(paneID string, data []byte)   // WS fan-out + attention 감지
    OnExit   func(paneID string, code int)       // WS OpExit + workspace invalidation
}
```

**핵심 동작**:
- `Dial(sockPath)`: Unix socket 연결 → `hello` → return `*PaneClient`
- `ReadLoop()`: goroutine. JSON-Lines 파싱. `id` 있으면 `pending[ID]` 채널에 응답 전달, 없으면 push handler 호출.
- 모든 `PaneHub` 메서드(`Create`, `Get`, `List`, `Delete`, `IsLive` 등)를 RPC로 구현.
- `Snapshot()` 메서드 추가 — 재연결 시 outbuf 확보. `PaneHub`에는 없던 신규 메서드.
- `Busy()` 메서드 추가 — L2 idle 감지가 판단용으로 호출.

### 6.3 기존 코드 재배치

#### dongminald가 가져가는 것 (변경 없이 그대로 사용)

- `internal/server/pane.go` 전체 (`Pane`, `PaneManager`, `StartPane`, `readPTY`, `kill`, `safeConn` 제외한 WS 부분)
- `internal/outbuf/` 전체
- `PaneManager`의 `Create`, `Restore`, `Get`, `List`, `Delete`, `IsLive`, `SaveAll`, `LoadAll`
- `Pane`의 `Cwd`, `IsBusy`, `CmdProcessPID`, `Stream`

#### dongminald에서 제거·무력화하는 것

- `Pane.observeOutput`, `Pane.observeOutputAt`, `Pane.setAttention`, `Pane.signalAttention`, `Pane.clearAttention`, `Pane.attend`, `Pane.maybeIdle`, `Pane.Attention`
- `Pane.attnArmed`, `Pane.attention`, `Pane.attnCarry`, `Pane.allowBell`, `Pane.onAttention`, `Pane.onAttentionClear`
- `Pane.setActivity`, `Pane.Activity`, `Pane.onActivity`, `Pane.activity`
- `PaneManager.SetAttentionNotifier`, `PaneManager.SetActivityNotifier`, `PaneManager.attnHooks`
- `PaneManager.sweepIdle`, `PaneManager.StartAttentionSweeper`, `PaneManager.AttentionIDs`, `PaneManager.ClearAllAttention`
- `PaneManager.ActivitySnapshot`
- `PaneHooks` 전체
- `attnBusyProbe` 변수
- `internal/server/attention.go` 전체 (dongminal이 가져감)
- `internal/server/activity.go` 전체 (dongminal이 가져감)

> **주의**: 위 코드는 `Pane` struct에 필드/메서드로 녹아 있다. dongminald가 `PaneManager`를 그대로 사용하려면 이 필드들을 제거하거나, dongminald 빌드 시 태그로 제외하거나, 공통 `PaneCore` + dongminal 쪽 `PaneExt`(attention/activity 필드 포함)로 분리하는 전략이 필요하다.

#### dongminal이 가져가는 것

- `internal/server/attention.go` (L1 OSC 감지, `detectAttentionSignal`, `isAttentionOSC`, `WireAttention` 등)
- `internal/server/activity.go` (`paneActivityPayload`, `WireActivity` 등)
- attention/activity 상태를 in-memory로 관리하는 경량 구조체 (현재 `Pane` struct에 있던 attention/activity 필드를 별도 map으로)

### 6.4 main.go 변경

```go
func main() {
    // ...
    sockPath := filepath.Join(home, "paned.sock")

    // dongminald 연결 또는 spawn
    pc, err := dialOrStartDaemon(sockPath, home)
    if err != nil { log.Fatalf(...) }

    // PaneClient에 push handler wiring
    // (output → WS broadcast + attention 감지, exit → cleanup)
    wirePaneClient(pc, hub, pm)

    deps := server.Deps{Panes: pc, ...}
    // ...
}
```

**`dialOrStartDaemon`**:
1. `net.Dial("unix", sockPath)` 시도
2. 실패 → `dongminald` spawn (`exec.Command`). pidfile 폴링 → 재시도 (최대 2초)
3. 성공 → `hello` 호출 → `*PaneClient` 반환

### 6.5 Attention 감지 흐름 (변경 후)

```
dongminald                       dongminal
    │                                │
    │── output push (raw base64) ──▶│
    │                                ├─ WS fan-out (기존 broadcast)
    │                                ├─ observeOutput(bytes) → L1 OSC 감지
    │                                │   └─ attention 감지 → CommandHub → SSE
    │                                └─ lastOutputAt 갱신
    │
    │                              (dongminal의 L2 idle sweeper)
    │                                ├─ tick → lastOutputAt > threshold?
    │                                ├─ busy? (→ dongminald에 busy RPC)
    │                                └─ idle 감지 → CommandHub → SSE
    │
    │                              (HTTP: dmctl notify)
    │   (관여 안 함)                  ├─ POST /api/panes/:id/attention/set
    │                                └─ 직접 attention 상태 변경 → SSE
```

### 6.6 PaneHub 인터페이스 변경

```go
// internal/server/deps.go
type PaneHub interface {
    // 기존
    List() []map[string]interface{}
    Create(cwd string, cols, rows uint16) (*Pane, error)
    Get(id string) *Pane
    Delete(id string)

    // 신규 (dongminald RPC로 구현)
    Restore(id, name, cwd string, cols, rows uint16) error
    IsLive(id string) bool
    Snapshot(id string) (*PaneSnapshot, error)
    Busy(id string) bool
    Cwd(id string) string
    Kill(id string)
    Write(id string, data []byte) error
    Resize(id string, cols, rows uint16) error
    SaveAll()
    LoadAll()
}
```

`PaneManager`(dongminald)와 `PaneClient`(dongminal) 양쪽이 이 인터페이스를 구현한다.

## 7. 실패 모드 및 복구 (Failure Modes)

| 모드 | 검출 | 복구 |
|-----|-----|------|
| dongminald 소켓 없음 (콜드 스타트) | dial 실패 | dongminald spawn, panes.json 기반 LoadAll |
| dongminald crash (연결 끊김) | PaneClient readLoop EOF | 지수 백오프 재연결 (1s, 2s, 4s, ... max 30s). 실패 시 dongminald 재시작 + panes.json 복원 |
| dongminald hang (타임아웃) | request 응답 > 5초 | 연결 close → crash 복구 경로 |
| dongminal crash/재시작 | dongminald 연결 close 감지 | dongminald는 셸 유지 + outbuf 계속 축적. 다음 연결 시 snapshot push |
| 중복 dongminal 연결 | dongminald: 신규 accept → 기존 close | 기존 PaneClient readLoop EOF → 재연결 경로 |
| pidfile 누락 / stale | pidfile read 실패 or PID 없음 | `kill -0 <pid>` liveness 확인 |
| Unix socket 권한 문제 | dial Permission denied | 로그 + fatal. `$DONGMINAL_HOME` 권한 확인 안내 |

## 8. 데이터 흐름 다이어그램

```
┌─────────────────────────────────────────────────────────────────────┐
│ dongminald                                                          │
│                                                                     │
│  ┌──────────┐    read()     ┌──────────┐    Feed()    ┌──────────┐  │
│  │  zsh #1  │──────────────▶│ readPTY  │─────────────▶│ outbuf   │  │
│  │  (PTY)   │◀──────────────│ goroutine│              │ Stream   │  │
│  └──────────┘    write()    └────┬─────┘              └────┬─────┘  │
│                                  │ output push              │        │
│                                  │ (base64)                 │ snap-  │
│  ┌───────────────────────────────▼─────────────────────┐    │ shot   │
│  │              paned.sock (Unix)                      │◀───┘       │
│  └───────────────────────────────┬─────────────────────┘            │
└──────────────────────────────────┼──────────────────────────────────┘
                                   │
┌──────────────────────────────────┼──────────────────────────────────┐
│ dongminal                        │                                  │
│                                  ▼                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ PaneClient                                                    │   │
│  │  ├─ OnOutput → bytes                                          │   │
│  │  └─ OnExit   → cleanup                                        │   │
│  └──────────────────────┬───────────────────────────────────────┘   │
│                         │                                           │
│         ┌───────────────┼───────────────┐                           │
│         ▼               ▼               ▼                           │
│  ┌──────────┐   ┌──────────────┐  ┌──────────┐                     │
│  │ WS fan-  │   │ Attention    │  │ Activity │                     │
│  │ out      │   │ 감지 (L1/L2) │  │ 상태     │                     │
│  │ (브라우저)│   │ + idle sweeper│  │ (in-mem) │                     │
│  └──────────┘   └──────┬───────┘  └──────────┘                     │
│                        │                                            │
│                        ▼                                            │
│              ┌─────────────────┐                                    │
│              │  CommandHub     │                                    │
│              │  (SSE broadcast)│                                    │
│              └────────┬────────┘                                    │
│                       ▼                                             │
│              ┌─────────────────┐                                    │
│              │  브라우저 SSE    │                                    │
│              │  (attention     │                                    │
│              │   badge, panel) │                                    │
│              └─────────────────┘                                    │
└─────────────────────────────────────────────────────────────────────┘
```

## 9. 검증 계획 (Validation)

### 9.1 단위 테스트

- `internal/server/pane_client_test.go`: PaneClient request/response matching, push event dispatch, 연결 끊김/재연결.
- `internal/outbuf/` + `internal/server/pane.go`: 기존 테스트 유지 (dongminald에서 사용).
- dongminal 쪽 attention 감지: output push byte를 `observeOutput`에 feeding 하는 테스트.
- `fakePaneHub` 확장: PaneClient 테스트용 mock dongminald (in-process Unix socket).

### 9.2 통합 테스트

| 테스트 | 내용 |
|--------|------|
| TestDaemonColdStart | dongminald spawn → PaneClient 연결 → create → write → output push 수신 |
| TestDaemonReattach | create → dongminal close → dongminald 유지 → 새 연결 → snapshot + output 수신 |
| TestDaemonCrashRecovery | dongminald kill → dongminal 재연결 → spawn → 복구 |
| TestAttentionFromOutput | output push bytes에 OSC 9 포함 → dongminal attention 감지 → SSE payload 검증 |

### 9.3 E2E 테스트 (Playwright)

- split → 명령 실행 → 서버 kill → 재시작 → 3초 내 동일 pane에 출력 이어서 표시
- attention: `echo -e '\e]9;done\a'` → 서버 재시작 → attention badge 유지
- 멀티 클라이언트 회귀: `e2e/sync.spec.ts` 통과

## 10. 점진적 도입 단계 (Phasing)

### Phase 1 — 공통 코드 분리 (1~2일)

- `Pane` struct에서 attention/activity 필드를 분리 가능한 형태로 리팩터링
- `PaneHub` 인터페이스 확장 (`Restore`, `Snapshot`, `Busy`, `Cwd`, `Kill`, `Write`, `Resize`, `IsLive`, `SaveAll`, `LoadAll` 추가)
- `PaneManager`가 확장된 인터페이스를 구현하는지 확인
- `fakePaneHub` 확장

### Phase 2 — dongminald 바이너리 (2~3일)

- `cmd/dongminald/main.go` 신설
- 서브커맨드 디스패치: `os.Args[1] == "d"` → dongminald main
- Unix socket listen + JSON-Lines encode/decode
- Request dispatch: method → PaneManager 메서드
- Push: readPTY → `output` push, pane 종료 → `exit` push
- pidfile 기록

### Phase 3 — PaneClient (2~3일)

- `internal/server/pane_client.go` 신설
- `Dial()` + `ReadLoop()` + request/response matching
- `PaneHub` 인터페이스 구현
- `OnOutput`, `OnExit` handler 주입 포인트

### Phase 4 — 연동 + main.go 변경 (2~3일)

- `main.go`에 `dialOrStartDaemon()` 추가
- `Deps.Panes = paneClient`
- dongminal 쪽 attention/activity 감지 재배치 (output bytes → observeOutput)
- dongminald crash → 재연결 로직

### Phase 5 — 테스트 + 회귀 방지 (2~3일)

- Phase 1~4 테스트 보강
- 기존 e2e 전수 회귀
- 수동: Ctrl+C → `./dongminal` → pane 살아있는지 확인

**총 작업량: 9~15일**

## 11. 비범위 (Non-goals)

- dongminald 독립 배포·별도 빌드 — 항상 `dongminal` 바이너리 안에 포함.
- dongminald 네트워크 노출 — Unix socket only.
- 머신 간 PTY 마이그레이션.
- Windows 지원.
- **attention/activity 상태 영속화** — 해당 상태는 dongminal 메모리(`AttnTracker`)에만 존재한다. `dongminal` 재시작 시 초기화되며(셸·스크롤백은 dongminald가 유지하지만 알림 뱃지는 사라짐), 재연결 시 스냅샷은 attention 감지를 거치지 않으므로 과거 알림이 재발화되지도 않는다. 이는 §3.3(attention은 dongminal에 둔다)에 따른 **의도된 동작**이다. 알림은 새 이벤트(OSC/`dmctl notify`/L2 idle) 발생 시 다시 표시된다.

## 12. 완료 조건 (Definition of Done)

- [x] `dongminald`가 Unix socket으로 raw PTY I/O relay
- [x] `dongminal`이 `dongminald` 소켓에 연결하여 정상 동작
- [x] `dongminal` 재시작 후 기존 셸 세션 유지 + outbuf scrollback 복원
- [x] Attention/activity 감지가 dongminal에서 정상 동작 (dmctl notify, OSC, L2 idle — FR-15)
- [x] `dongminald` crash 시 자동 재시작 및 복구 (FR-13)
- [x] IPC 동시성 안전 (FR-11/FR-12), RPC 타임아웃(FR-14), reattach 무손실(FR-17), 출력 백프레셔(FR-18), whoami 자동해석(FR-16)
- [x] 기존 테스트 전수 통과 (회귀 없음)
- [x] 프로세스 레벨 검증: 콜드스타트 spawn(FR-5), dongminal SIGTERM 후 데몬 생존(FR-6), 재기동 reattach(FR-1), 셸 출력 토큰 스냅샷 복원(FR-2), 데몬 SIGKILL 후 백오프 재연결·respawn(FR-7) 확인
- [x] 본 문서를 IMPLEMENTED 상태로 갱신
