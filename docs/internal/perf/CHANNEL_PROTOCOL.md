# 채널 프로토콜 — PERF_OPTIMIZATION_SRS M1 하위 설계

> **문서 상태**: 승인·구현중
> **남은 것**: C1~C6 구현 (2026-11-24 사용자 확인)
> 상위: `docs/internal/PERF_OPTIMIZATION_SRS.md` §3.1 FR-CON-1~10 · 결정 D-5, D-9, D-10

---

## 1. 지금 구조 (2026-11-24 조사)

| 경로 | 개수 | 하는 일 | 코드 |
|---|---|---|---|
| 터미널 WebSocket `/ws?tool&cols&rows&since` | 터미널 칸마다 1 | 출력·입력·크기·답장 자격·생존 확인. 바이트 오프셋 `since` 로 이어 붙인다. 틈이 생기거나 큐(256)가 넘치면 연결을 닫고 다시 붙는다 | `web/js/ui/term-socket.js`, `term-pane.js` · `httpapi/src/ws.rs` |
| SSE `/api/commands/sse?clientId` | 브라우저 탭마다 1 | 상태 신호(`workspace_changed` 등), 서버→브라우저 명령. 구독이 붙어 있는 동안 포커스·git 감시·파일 감시 임대를 쥔다 | `web/js/core/event-bus.js` · `httpapi/src/commands.rs` |
| SSE `?presence=1` | 칸(slot) i>0 마다 1 | 메시지를 처리하지 않는다. 칸 소유권을 지키려고 연다 | `core/slots-controller.js` |
| SSE git job | 작업마다 1 | 원격 작업 진행 줄 | `git/remote.js`, `git/submodules.js` |
| 주기 GET | — | ping·stats 3초, activity·runs·background·Run 화면 5초(패널이 열렸을 때), Claude 계정 30초, git status·저장소 목록·편집기 git(설정 주기), 텔레그램 페어링 | `statusbar-controller.js`, `state-registry.js`, `git/*` |
| `POST /api/command-result` | 명령마다 | 서버→브라우저 명령의 결과를 돌려준다 | `commands.rs` |

## 2. 사용자 결정 (이 설계에서 더한 것)

| # | 결정 | 날짜 |
|---|---|---|
| D-9 | 브라우저의 상태용 주기 GET 을 **전부** 없앤다(FR-CON-7 의 5개 + Claude 계정 + git 계열 + 텔레그램). 사건 없이 계속 변하는 값(CPU·메모리)은 서버가 구독자가 있을 때만 재서 민다. 남는 서버 내부 주기(stats 측정, gitwatch 회차)는 FR-SRV-2 에 따라 이유와 주기를 적는다 | 2026-11-24 |
| D-10 | 상태 토픽은 토픽별로 싣는 것을 나눈다. 자주 바뀌는 토픽은 id 단위 변화량, 드물게 바뀌는 토픽은 바뀔 때 최신 전체 값을 민다. FR-CON-4 를 "변화량 또는 최신 전체 값"으로 고친다 | 2026-11-24 |

## 3. 연결

- 종단: `GET /channel?v=1` (WebSocket 업그레이드). 출처 판정은 지금 `/ws` 와 같은 출처 게이트를 지난다(`reqgate.rs`).
- 브라우저 탭 하나가 채널 하나를 연다. 칸 소유권용 presence SSE 와 git job SSE 도 이 채널로 합친다.
- 압축(FR-CON-9): 원격 주소(루프백이 아닌 주소)에서만 `permessage-deflate` 를 협상한다. tungstenite 0.30 이 이것을 지원하는지 시험 단계에서 먼저 확인한다(A-C1). 지원하지 않으면 멈추고 알린다.
- 브라우저→서버 메시지 상한은 지금 `/ws` 와 같은 1 MB(`WS_READ_LIMIT`).

## 4. 프레임

### 4.1 텍스트 프레임 (JSON)

모든 텍스트 프레임은 `{"t":"<종류>", ...}` 꼴이다.

**브라우저 → 서버**

| `t` | 필드 | 뜻 |
|---|---|---|
| `hello` | `client?`, `slots:[칸 신원...]` | 첫 프레임. 이 채널이 대표하는 신원이다. 서버는 `client` 에 포커스·git·파일 감시 임대를, `slots` 의 신원마다 포커스·git 임대를 쥔다(지금 `attach_sse_leases` 의 일반 구독과 presence 구독). 칸 수가 바뀌면 `hello` 를 다시 보내고, 서버는 빠진 신원의 임대를 푼다. `client` 는 명령 SSE 를 지우는 C2 부터 싣는다 — 그 전에는 같은 신원의 임대를 SSE 와 채널이 나눠 쥐어 먼저 끊긴 쪽이 소유권을 풀어 버린다 |
| `sub` | `topic`, `seq?`, `epoch?` | 토픽을 구독한다. `seq` 는 브라우저가 가진 마지막 순번이고 `epoch` 는 그 순번을 받은 서버의 `epoch` 다(§5) |
| `unsub` | `topic` | 구독을 해지한다 |
| `ping` | `n` | 생존 확인과 지연 측정(§7) |
| `cmd.result` | `reqId`, 결과 필드 | 서버→브라우저 명령의 결과(지금 `POST /api/command-result` 본문과 같다) |
| `term.open` | `sid`, `tool`, `cols`, `rows`, `since?` | 터미널 하나를 이 채널에 붙인다. `sid` 는 브라우저가 고르는 32비트 번호다. `tool` 이 비면 새 도구를 만든다(지금 `/ws` 의 `tool=` 없음과 같다) |
| `term.close` | `sid` | 터미널을 뗀다 |

**서버 → 브라우저**

| `t` | 필드 | 뜻 |
|---|---|---|
| `hello` | `epoch`, `server` | `epoch` 는 서버 프로세스마다 새로 고르는 값이다. `server` 는 지금 `server_hello` 의 내용(자산 판 등)이다 |
| `full` | `topic`, `seq`, `data` | 토픽의 전체 값 |
| `delta` | `topic`, `seq`, `ops:[{op:"put",id,v} \| {op:"del",id}]` | id 단위 변화량 |
| `event` | `topic`, `seq`, `data` | 상태가 아닌 사건(예: `claude_account_alert`, `fs_changed`) |
| `reset` | `topic` | 사건 토픽의 빈틈을 메울 수 없다. 구독자는 자기 상태를 다시 맞춘다(지금 `sse:open` 의 재검증과 같은 뜻) |
| `cmd` | `reqId?`, `action`, `args`, `exec?` | 서버→브라우저 명령. 지금 SSE 로 오는 명령 봉투 그대로다 |
| `pong` | `n` | `ping` 의 답 |
| `error` | `code`, `msg` | 프레임 해석 실패, 모르는 토픽 등 |

### 4.2 바이너리 프레임 (터미널)

```
[op: u8][sid: u32 빅엔디언][payload]
```

- `op` 와 `payload` 는 **지금 `/ws` 의 것을 그대로 쓴다**(`web/js/core/constants.js` 의 `OP`, `toolhub` 의 `OP_*`). 서버→브라우저 `OUTPUT·ERROR·EXIT·TOOLID·SEQ·SIZE·REPLY_SEAT`, 브라우저→서버 `INPUT·RESIZE`.
- 이유: `TerminalTool._onOp` 의 해석과 바이트 오프셋 재동기화(`_seq`, FR-TRS)를 바꾸지 않고, 소켓만 채널의 `sid` 하나로 바꾼다. 앞의 5바이트를 떼면 지금 프레임과 같다.
- M2 가 화면 상태 스냅숏을 더할 때 op 를 새로 더한다(이 문서 범위 밖).

## 5. 토픽과 순번

### 5.1 순번 규칙

- 서버는 토픽마다 순번을 1부터 올린다. 순번은 `epoch` 안에서만 뜻이 있다.
- 서버는 토픽마다 최근 변화량을 `TOPIC_RING = 64` 개까지 기억한다.
- `sub {topic, seq}` 를 받으면:
  - `seq` 가 없거나, `epoch` 가 다르거나, 링보다 오래됐으면 → `full`(사건 토픽은 `reset`)
  - 링 안이면 → 그 뒤의 `delta`·`event` 를 차례로 보낸다
  - 최신과 같으면 → 아무것도 보내지 않는다
- 브라우저가 `seq` 의 빈틈(받은 순번 ≠ 마지막 + 1)을 보면 그 토픽에 `sub {topic, seq: 마지막}` 을 다시 보낸다(FR-CON-5).
- 다시 연결하면 `hello` 뒤에 구독하던 토픽을 마지막 순번과 함께 다시 `sub` 한다.

### 5.2 토픽 목록

| 토픽 | 종류 | 지금 무엇을 대신하나 | 비고 |
|---|---|---|---|
| `workspace` | full | `workspace_changed` + `GET /api/state` | `data` 는 지금 `/api/state` 본문. 자기 PUT 의 메아리는 지금처럼 rev·ETag 로 거른다 |
| `settings` | full | `settings_changed` + 설정 GET | |
| `edges` · `chat` · `update` · `claude.accounts` | full | 각 `*_changed` + GET, 계정 30초 폴링 | 계정은 서버의 조회 결과가 바뀔 때 민다 |
| `attention` | delta | `tool_attention`·`tool_attention_clear` + `/api/snapshot?parts=attention` | id = toolId |
| `activity` | delta | `tool_activity`·`tool_subagent_activity` + `/api/tools/activity` 5초 | usage·subagents 를 statusLine 보고가 올 때 다시 계산해 민다. 리밋은 `full` 하위 키로 함께 싣고, 리셋까지 남은 시간은 브라우저가 시각으로 계산한다 |
| `foreground` | delta | `tool_foreground` | |
| `background` | delta | `tools_background_changed` + `/api/tools/background` 5초 | Run 표지·cwd 를 바뀔 때 다시 계산한다 |
| `runs` | delta | `run_changed` + `/api/runs` 5초 | 멤버 생존은 도구 종료 사건에서 다시 계산한다 |
| `run:<id>` | full | 열린 Run 화면의 `/graph` 5초 | Run 탭이 열린 동안만 구독한다 |
| `focus` | full | `window_focus` | |
| `stats` | full | `/api/stats` 3초 | 서버가 구독자가 있을 때만 `stats` 주기로 잰다. 주기는 구독자의 요청 중 가장 짧은 것, 하한 1초 |
| `git.jobs` | full | `git_jobs_changed` + `/api/stats?jobs=1` | |
| `git:<repo>` | full | `git_changed` + git status 폴링 | 서버 gitwatch 의 관측을 그대로 민다. 저장소 목록·편집기 git 도 같은 토픽을 구독한다 |
| `gitjob:<id>` | event | git job SSE | 작업이 끝나면 서버가 마지막 `event` 뒤에 구독을 닫는다 |
| `fs` | event | `fs_changed` | |
| `alert` | event | `claude_account_alert` | |

- `cmd` 는 토픽이 아니다. 채널이 열려 있으면 늘 받는다. 지명(`exec`) 판정은 지금과 같다.
- 텔레그램 짝맞춤 확인은 별도 `telegram` full 토픽으로 민다(OQ-C1, C2b 에서 정했다). 간선을 맺거나 지운 알림은 `edges.notice` 사건 토픽이다.
- full 토픽의 본문은 그 GET 종단의 본문이다. 200 이 아니면 `{"$http": 상태, "body": 본문}` 이다. 서버는 바뀐 자리마다 본문을 다시 만들어, 지난 발행과 같으면 내지 않는다(C2b).

## 6. 흐름 제어 (FR-CON-6)

- 채널마다 쓰기 담당 태스크 하나가 큐 셋을 우선순위대로 비운다: **제어**(`pong`·`cmd`·`hello`·`error`·터미널 제어 op) > **터미널 출력** > **상태 토픽**.
- 상태 토픽: 보내지 못한 것은 토픽마다 하나로 합친다. `full` 은 최신 것만 남기고, `delta` 가 `TOPIC_PENDING_MAX = 64` 개를 넘으면 버리고 `full` 하나로 바꾼다.
- 터미널 출력: `sid` 마다 보내지 못한 바이트가 `TERM_PENDING_MAX = 1 MB`(데몬 링 `BUF_MAX` 와 같다)를 넘으면, 밀린 것을 버리고 서버가 데몬에서 `snapshot_tool_since(보낸 끝)` 으로 다시 받아 보낸다. 브라우저 왕복은 없다. M2 가 이 자리를 화면 상태 스냅숏으로 바꾼다(FR-TRM-6).
- 채널 전체가 `CHANNEL_PENDING_MAX = 8 MB` 를 넘으면 채널을 닫는다. 브라우저는 다시 연결하고 §5.1 로 맞춘다.
- 위 숫자는 상수로 두고 시험에서 상한을 검사한다.

## 7. 생존 확인과 지연 (FR-CON-7)

- 서버: WebSocket ping 을 지금 `/ws` 와 같은 주기로 보내고, 퐁이 `PONG_WAIT` 안에 없으면 닫는다(`toolhub` 상수 그대로).
- 브라우저: 앱 수준 `ping` 을 보낸다. 브라우저 JS 는 WebSocket ping 을 볼 수 없기 때문이다. 주기는 **탭이 보일 때 `statsInterval`(기본 3초), 숨었을 때 30초**다. `pong` 왕복이 상태바의 지연 값이 된다.
- 브라우저는 `pong` 을 포함한 아무 프레임도 `주기 × 2 + 5초` 동안 받지 못하면 다시 연결한다(지금 SSE 침묵 감시의 자리).

## 8. 옮기는 순서 (FR-CON-10)

옛 경로와 채널이 함께 돈다. 단계마다 시험을 통과하면 그 기능의 옛 경로를 지운다.

| 단계 | 내용 | 지우는 옛 경로 |
|---|---|---|
| C1 | 채널 뼈대: 종단, `hello`·`ping`·`pong`, 재연결, 신원 임대 | presence SSE |
| C2 | `cmd`·`cmd.result`, 사건 토픽(`fs`·`alert`), `workspace`·`settings` 등 full 토픽 | 명령 SSE, `POST /api/command-result`, 해당 GET 재조회 |
| C3 | delta 토픽(`attention`·`activity`·`foreground`·`background`·`runs`·`run:<id>`), `stats` | 5초·30초·3초 폴링, `/api/snapshot` 재검증 |
| C4 | git 토픽(`git:<repo>`·`git.jobs`·`gitjob:<id>`) | git 폴링, git job SSE |
| C5 | 터미널(`term.open`·바이너리 프레임·흐름 제어) | `/ws`, `term-socket.js` |
| C6 | 정리: 옛 종단·코드·시험 제거, 압축, `scenario.mjs` 재측정 | SSE 종단 |

`otterctl` 이 쓰는 REST·SSE(예: `activity/wait`)는 브라우저 경로가 아니므로 이 순서와 무관하게 남는다.

## 9. 가정과 미결

- **A-C1** tungstenite 0.30 이 `permessage-deflate` 를 지원한다. C6 전에 확인한다.
- **A-C2** 지금 `/api/state` 본문 크기가 바뀔 때마다 모든 채널에 밀어도 될 만큼 작다. C2 시험에서 창 5 × 탭 3 기준 크기를 잰다.
- ~~**OQ-C1** 텔레그램 페어링 확인을 어느 토픽에 실을지~~ → `telegram` full 토픽(C2b).

## 10. 시험 (단계마다 구현 전에 쓴다)

### 10.1 C1 — 채널 뼈대

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH1-1 | 서버 | 업그레이드가 아닌 `GET /channel` 은 400 이다. 도구 허브가 없어도 채널은 열린다 |
| TC-CH1-2 | 서버 | 첫 프레임이 `hello` 가 아니면 `error{code:"hello_required"}` 를 보내고 닫는다. `HELLO_WAIT`(10초) 안에 `hello` 가 없어도 닫는다 |
| TC-CH1-3 | 서버 | `hello` 에 `hello{epoch, server}` 로 답한다. `epoch` 는 비어 있지 않고 같은 프로세스의 채널끼리 같다. `server.assetVersion` 은 지금 `server_hello` 와 같다 |
| TC-CH1-4 | 서버 | `slots` 의 신원은 채널이 열린 동안 포커스 구독으로 산다(`focus.live_count`). 채널이 닫히면 곧바로 풀린다. `hello` 를 다시 보내 빠진 신원은 풀리고 새 신원은 붙는다 |
| TC-CH1-5 | 서버 | `ping{n}` 에 `pong{n}` 으로 답한다 |
| TC-CH1-6 | 서버 | 깨진 JSON·모르는 `t`·바이너리 프레임에는 `error` 를 보내고 연결은 유지한다 |
| TC-CH1-7 | 서버 | `presence=1` 명령 SSE 가 없어졌다 — 그 파라미터는 일반 구독으로 읽힌다 |
| TC-CH1-8 | 프론트 | 연결은 `ws(s)://<host>/channel?v=1` 이고, 열리면 `hello{slots}` 를 보낸다 |
| TC-CH1-9 | 프론트 | `setSlots` 는 열려 있으면 `hello` 를 다시 보내고, 닫혀 있으면 다음 연결에 싣는다 |
| TC-CH1-10 | 프론트 | `ping` 주기는 보일 때 `statsInterval`, 숨었을 때 `CHAN_PING_HIDDEN_MS`(30초)다. `pong` 의 왕복을 `latency()` 가 돌려준다 |
| TC-CH1-11 | 프론트 | 아무 프레임도 `주기 × 2 + CHAN_SILENCE_GRACE_MS`(5초) 동안 오지 않으면 닫고 다시 연결한다 |
| TC-CH1-12 | 프론트 | 끊기면 백오프(`CHAN_RETRY_MIN_MS` 500 → ×2 → `CHAN_RETRY_MAX_MS` 10초)로 다시 연결하고, 서버 `hello` 를 받으면 백오프를 되돌린다. 서버 `hello` 마다 버스에 `chan:open{gen, epoch}` 를 발행한다 |
| TC-CH1-13 | 프론트 | 칸 i>0 의 소유권은 presence SSE 를 열지 않고 채널의 `slots` 로 쥔다 |


| 대상 | 시험 |
|---|---|
| 서버 채널 | 구독·해지, 구독하지 않은 토픽은 오지 않는다, 순번 단조 증가, 링 안 재구독은 변화량만, 링 밖·epoch 다름은 full, 우선순위 큐, 상한(토픽 합치기·터미널 재스냅숏·채널 닫기), 신원 임대가 채널 수명과 같다 |
| 프론트 채널 | 재연결 시 마지막 순번으로 재구독, 빈틈 발견 시 재구독, 침묵 판정, `ping` 주기(보일 때·숨었을 때), `sid` 로 터미널 프레임 나누기 |
| e2e | 브라우저 탭 하나에 WebSocket 하나, 유휴 1분 동안 상태용 GET 0, 채널을 끊었다 이었을 때 모든 토픽이 서버와 같다(NFR-PRF-15) |

### 10.2 C2a — 명령·사건 스트림을 채널로

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH2A-1 | 서버 | `hello.client` 의 신원은 채널이 열린 동안 포커스 구독·git 감시·파일 감시 임대를 쥔다(`/api/fs/watch` 가 그 `clientId` 를 받는다). 채널이 닫히면 곧바로 풀린다 |
| TC-CH2A-2 | 서버 | `hello.client` 가 처음 붙을 때 판 확인(`updates.trigger`)을 한 번 건다. `client` 없는 인사는 걸지 않는다 |
| TC-CH2A-3 | 서버 | 명령 허브의 방송 봉투는 `client` 를 밝힌 채널에 `{"t":"cmd", ...봉투}` 로 온다. `client` 가 없는 채널에는 오지 않는다 |
| TC-CH2A-4 | 서버 | `client` 가 붙으면 서버 `hello` 뒤에 도구 전경 스냅숏(`tool_foreground`)이 `cmd` 로 온다 |
| TC-CH2A-5 | 서버 | `cmd.result{reqId, ...}` 는 그 `reqId` 를 기다리던 생성 명령(`POST /api/commands`)의 응답에 실린다 |
| TC-CH2A-6 | 서버 | 명령 구독 상한(`SUB_CAP`)을 넘으면 `error{code:"subscribe_rejected"}` 를 보낸다. 채널은 유지한다 |
| TC-CH2A-7 | 서버 | `GET /api/commands/sse` 와 `POST /api/command-result` 는 없다(404) |
| TC-CH2A-8 | 프론트 | `hello` 에 `client`(앱의 clientId)를 싣는다 |
| TC-CH2A-9 | 프론트 | 서버 `hello` 는 연결마다 처음 한 번만 재구독과 `chan:open{gen, epoch, server}` 를 낸다. 칸 수가 바뀌어 다시 받은 인사는 아무것도 다시 내지 않는다 |
| TC-CH2A-10 | 프론트 | `cmd` 프레임은 옛 SSE 수신과 같은 길로 간다: 구독자가 있는 action 은 발행, 없으면 지명(`execClientId`) 검사 뒤 대체 처리기, `reqId` 를 인자에 싣는다 |
| TC-CH2A-11 | 프론트 | 생성 명령의 결과는 채널 `cmd.result` 로 보낸다 |
| TC-CH2A-12 | 프론트 | 깨어남(`online`·`focus`·`visible`)은 `channel.kick()` 이다: 닫혀 있으면 백오프를 무시하고 곧바로 연결, 열려 있으면 침묵일 때만 다시 연결 |
| TC-CH2A-13 | 프론트 | 자산 판 확인은 `chan:open` 의 `server.assetVersion` 으로 한다 |

### 10.3 C2b — full·사건 토픽

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH2B-1 | 서버 | `workspace`·`settings`·`edges`·`chat`·`update`·`claude.accounts`·`focus`·`telegram` 을 구독하면 `full.data` 는 그 GET 종단(`/api/state`·`/api/settings`·`/api/edges`·`/api/chat`·`/api/update`·`/api/claude-accounts`·`/api/focus`·`/api/telegram`)의 본문이다. `workspace` 는 여기에 `rev`(그 GET 의 ETag 값)를 더한다 |
| TC-CH2B-2 | 서버 | 상태가 바뀌는 자리(설정 PUT, 워크스페이스 저장, 포커스 주장, 간선·채팅 변화, 판 확인, 계정 변화, 텔레그램 짝맞춤·저장)에서 그 토픽의 `full` 이 나간다. 본문이 지난 발행과 같으면 나가지 않는다 |
| TC-CH2B-3 | 서버 | 사건 토픽: `alert`(계정 알림 본문), `fs`(파일 변화 본문), `edges.notice`(간선 변화의 `paired`·`removed`·`byPeer`·`invited`) |
| TC-CH2B-4 | 서버 | 옮긴 방송(`workspace_changed`·`settings_changed`·`update_changed`·`window_focus`·`edges_changed`·`chat_changed`·`claude_accounts_changed`·`claude_account_alert`·`fs_changed`)은 명령 SSE 로 가지 않는다 |
| TC-CH2B-5 | 프론트 | 등록부의 `topic` 항목은 채널에 구독한다. 연결(`chan:open`)마다 첫 `full` 은 `restore` 에, 그 뒤 `full` 은 `change`(없으면 `restore`)에 봉투(`{ok, status:200, data, text, headers}`)로 넘긴다. 사건은 `event` 처리기에 본문을 넘긴다 |
| TC-CH2B-6 | 프론트 | `workspace` full 은 GET 없이 적용한다. `rev` 가 `wsETag` 이하이면 버리고, 저장 비행 중이면 유예했다가 받은 본문으로 적용한다 |
| TC-CH2B-7 | 프론트 | 이 상태들의 `sse:open` GET 재검증, Claude 계정 30초 폴링, 텔레그램 짝맞춤 읽기 폴링이 없다(짝맞춤 남은 시간 그리기는 남는다) |

## 11. 구현 계약 (토픽 기반 — C2~C5 가 딛는다)

### 11.1 서버 (`rust/crates/webserver/httpapi/src/channel/`)

- `TopicHub` 하나를 `Server` 가 갖는다(`self.topics`). 토픽마다 **지금 상태**를 든다: full 토픽은 마지막 값, delta 토픽은 `id → 값` 맵, event 토픽은 상태가 없다. 그래서 `full` 은 언제나 허브가 가진 상태에서 만든다.
- 발행: `publish_full(topic, Value)`, `publish_delta(topic, Vec<DeltaOp>)`(`DeltaOp::Put{id,v}` · `DeltaOp::Del{id}`, 상태 맵에 적용한다), `publish_event(topic, Value)`. 발행마다 순번이 1 오르고 링(`TOPIC_RING`=64)에 들어간다. 구독자가 없어도 상태와 순번은 갱신한다.
- 처음 상태: `register_seed(prefix, f)` — 상태가 아직 없는 토픽을 처음 구독할 때 `f(topic: String) -> BoxFuture<'static, Option<Seed>>` 를 불러 채운다(`Seed::Full(Value)` · `Seed::Map(BTreeMap<String,Value>)` · `Seed::Event` — 사건 토픽을 이름으로 등록한다). 서버가 필요하면 등록하는 쪽이 `Weak<Server>` 를 잡는다. seed 전에 들어온 delta 는 상태에 적용하지 않고(순번·링은 오른다), seed 하는 사이에 발행이 끼면 seed 를 다시 부른다(최대 3회). full 을 보낼 때 그 full 에 이미 든 밀린 변화는 버린다. `prefix` 는 `"workspace"` 처럼 정확한 이름이거나 `"git:"` 처럼 `:` 로 끝난다. seed 가 없는 토픽을 구독하면 `error{code:"unknown_topic"}` 다.
- 채널 쪽: 채널마다 `Outbox` 하나. 차선 셋 — 제어 > 터미널 > 상태(§6). 상태 차선은 토픽마다 합친다(full 은 최신만, delta 가 `TOPIC_PENDING_MAX`=64 를 넘으면 full 로 바꾼다). 채널 전체 `CHANNEL_PENDING_MAX`=8 MB 를 넘으면 닫는다. 쓰기 태스크 하나가 Outbox 를 비운다.
- 메시지 처리: `sub`·`unsub` 을 C1 의 읽기 루프에 더한다. 재구독 판정은 §5.1(epoch 다름·링 밖 → full/reset, 링 안 → 이어지는 것, 같으면 없음).
- 구독자가 생기고 없어지는 순간을 알 수 있게 `on_demand(prefix, f(topic, active: bool))` 를 둔다(`stats` 측정·git 감시 임대가 쓴다).

### 11.2 프론트 (`web/js/core/channel.js`)

- `sub(topic, fn, {owner})` → `{stop()}`. 같은 토픽에 구독자가 여럿일 수 있고, 첫 구독자가 서버 `sub` 를, 마지막 해지가 서버 `unsub` 를 보낸다.
- `fn(msg)` 의 `msg`: `{kind:'full', data, seq}` · `{kind:'delta', ops, seq}` · `{kind:'event', data, seq}` · `{kind:'reset'}`.
- 토픽마다 마지막 `seq` 와 그것을 받은 `epoch` 를 든다. 빈틈이면 `sub{topic, seq, epoch}` 를 다시 보내고 그 사이의 프레임은 버린다. 다시 연결하면 서버 `hello` 뒤에 구독 중인 토픽 전부를 `sub{topic, seq, epoch}` 로 다시 보낸다.
- 도우미 `chanApply(map, ops)` — delta 를 `Map` 에 적용한다. `full` 이 delta 토픽에 오면 `data` 는 `{id: 값}` 객체다.
- 원시 수신: `on(t, fn)` — `cmd` 처럼 토픽이 아닌 종류(C2), `onBinary(fn)` — 터미널 프레임(C5).
- 보내기: `send(v)`(열려 있을 때만, 아니면 false), `sendBinary(u8)`.
