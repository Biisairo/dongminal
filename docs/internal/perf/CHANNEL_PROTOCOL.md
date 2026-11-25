# 채널 프로토콜 — PERF_OPTIMIZATION_SRS M1 하위 설계

> **문서 상태**: 승인·구현중
> **남은 것**: C1~C6 구현 (2026-11-24 사용자 확인)
> 상위: `docs/internal/PERF_OPTIMIZATION_SRS.md` §3.1 FR-CON-1~10 · 결정 D-5, D-9, D-10
> **개정 2026-11-25 (M2, PERF 2.10)**: 터미널에 화면 상태 스냅숏이 들어왔다 — `term.open` 의 `snap`, `SEQ` 의 `SNAP` 깃발과 꼬리(§4.2), 위로 받기 `term.history`(§4.1, §6), 흐름 제어·틈의 스냅숏 맞춤(§6, TC-CH5-2·7·11), 명령 구독이 넘쳐 닫히면 채널을 닫음(§6, TC-CH2A-14). 설계는 `perf/M2_DESIGN.md`

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
- 압축(FR-CON-9, D-12): 로컬·원격을 가리지 않고 모든 연결에서 `permessage-deflate` 를 협상한다. 서버 WebSocket(채널·편집기 LSP)은 sockudo-ws 하나로 통일했다. 압축을 제안하지 않는 업그레이드는 400 이다 — 그래서 스트림 종류가 하나다. 설정은 context takeover 켬, 단계 6, 최소 크기 임계값 없음, 서버 압축기 창 13비트(`perf/COMPRESSION_2026-11-24.md` §9).
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
| `term.open` | `sid`, `tool`, `cols`, `rows`, `since?`, `snap?` | 터미널 하나를 이 채널에 붙인다. `sid` 는 브라우저가 고르는 32비트 번호다. `tool` 이 비면 새 도구를 만든다(옛 `/ws` 의 `tool=` 없음과 같다). `snap:true`(깨움)면 `since` 를 보지 않고 화면 상태 스냅숏을 보낸다(M2 D-16·D-19) |
| `term.history` | `sid`, `before`, `count` | 위로 받기(FR-TRM-5). 절대 줄 번호 `before` 앞의 `count` 줄을 데몬 줄 저장소에 묻는다. 별도 태스크가 묻고 출력·입력을 막지 않는다 |
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
| `term.history` | `sid`, `from`, `top`, `lines` | 위로 받기의 답. `from` 은 `lines[0]` 의 줄 번호, `top` 은 저장소에 남은 가장 오래된 줄 번호, `lines` 는 ANSI 줄 목록이다. 지워진 옛 번호면 빈 목록이다 |
| `term.lost` | `sid` | 서버 쪽 사정으로 그 터미널의 붙음이 끝났다(§10.6) |
| `error` | `code`, `msg` | 프레임 해석 실패, 모르는 토픽 등 |

### 4.2 바이너리 프레임 (터미널)

```
[op: u8][sid: u32 빅엔디언][payload]
```

- `op` 와 `payload` 는 **지금 `/ws` 의 것을 그대로 쓴다**(`web/js/core/constants.js` 의 `OP`, `toolhub` 의 `OP_*`). 서버→브라우저 `OUTPUT·ERROR·EXIT·TOOLID·SEQ·SIZE·REPLY_SEAT`, 브라우저→서버 `INPUT·RESIZE`.
- 이유: `TerminalTool._onOp` 의 해석과 바이트 오프셋 재동기화(`_seq`, FR-TRS)를 바꾸지 않고, 소켓만 채널의 `sid` 하나로 바꾼다. 앞의 5바이트를 떼면 지금 프레임과 같다.
- 화면 상태 스냅숏(M2, D-19)은 새 op 없이 `OUTPUT` + `SEQ` 로 보낸다. `SEQ` 페이로드는 `오프셋 u64 BE` + `깃발 u8` 이고 깃발은 비트 0 `FULL`(버퍼를 통째로 바꿈)·비트 1 `ALT`(대체 화면 중)·비트 2 `SNAP`(앞의 `OUTPUT` 이 스냅숏)이다. `SNAP` 이면 깃발 뒤에 첫 기록 줄 번호(`u64 BE`)와 cwd(UTF-8)가 붙는다(`httpapi/src/ws.rs` `snap_seq_payload`). 브라우저는 `SNAP` 에 넛지를 걸지 않는다(넛지는 없어졌다).

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
| `stats:<ms>` | full | `/api/stats` 3초 | 서버가 구독자가 있을 때만 잰다. 주기는 토픽 이름의 `<ms>` 중 가장 짧은 것, 하한 1초(§10.4) |
| `git.jobs` | full | `git_jobs_changed` + `/api/stats?jobs=1` | `data` 는 `{jobs:[…]}` (`/api/git/jobs` 와 같은 목록) |
| `git:<repo>` | full | `git_changed` + git status 폴링 | `data` 는 `{repo, mark}` — 서버 gitwatch 관측의 식별자다(관측 실패는 빈 mark). 구독자가 있는 동안 서버가 그 저장소를 감시한다(임대). status 본문은 싣지 않는다 — 본문이 요청 경로(`requested`)와 동작 판정(`actions`)에 매여 구독자마다 다르고, 바뀔 때만 브라우저가 `ifMark` 로 한 번 받는다(주기 없음). Git 패널·저장소 목록·탐색기가 같은 토픽을 구독한다 |
| `gitjob:<id>` | event | git job SSE | `data` 는 `{kind:"line", line}` 들과 마지막 `{kind:"done", job}`. 첫 구독자가 생기면 보존된 줄부터 흘린다(겹침은 브라우저가 `line.seq` 로 거른다). 브라우저는 `done` 을 받으면 해지하고, 마지막 구독자가 떠나면 서버가 토픽을 잊는다. 없는 잡은 `unknown_topic` 이다 |
| `gitconsole:<root>` | full | Console 탭의 `gitConsoleInterval`(2초) 재조회 | `data` 는 `{seq, epoch}` — 그 저장소 기록의 마지막 Seq 와 기록 링의 세대. 구독하는 동안만 기록이 더해질 때 민다(`Recorder::set_on_add`). 브라우저는 Seq 가 커서 뒤이거나 세대가 바뀌면 `/api/git/records?after=` 로 그 뒤만 받는다. 보이는 Console 탭만 구독한다 (C6) |
| `fs` | event | `fs_changed` | |
| `alert` | event | `claude_account_alert` | |

- `cmd` 는 토픽이 아니다. 채널이 열려 있으면 늘 받는다. 지명(`exec`) 판정은 지금과 같다.
- 텔레그램 짝맞춤 확인은 별도 `telegram` full 토픽으로 민다(OQ-C1, C2b 에서 정했다). 간선을 맺거나 지운 알림은 `edges.notice` 사건 토픽이다.
- full 토픽의 본문은 그 GET 종단의 본문이다. 200 이 아니면 `{"$http": 상태, "body": 본문}` 이다. 서버는 바뀐 자리마다 본문을 다시 만들어, 지난 발행과 같으면 내지 않는다(C2b).

## 6. 흐름 제어 (FR-CON-6)

- 채널마다 쓰기 담당 태스크 하나가 큐 넷을 우선순위대로 비운다: **제어**(`pong`·`cmd`·`hello`·`error`·터미널 제어 op) > **터미널 출력** > **위로 받기**(`term.history` 답, M2) > **상태 토픽**.
- 상태 토픽: 보내지 못한 것은 토픽마다 하나로 합친다. `full` 은 최신 것만 남기고, `delta` 가 `TOPIC_PENDING_MAX = 64` 개를 넘으면 버리고 `full` 하나로 바꾼다.
- 터미널 출력: `sid` 마다 보내지 못한 바이트가 `TERM_PENDING_MAX = 1 MB`(데몬 링 `BUF_MAX` 와 같다)를 넘으면, 그 sid 의 밀린 출력만 버리고 서버가 데몬에서 화면 상태 스냅숏을 받아 맞춘다(FR-TRM-6, M2 2.6). 브라우저 왕복은 없다.
- 명령 구독(`cmd`)을 허브가 닫으면(큐 넘침) 채널을 닫는다. 브라우저는 다시 연결해 새로 구독한다(PERF 1.17, `channel/cmd.rs` `pump`).
- 채널 전체가 `CHANNEL_PENDING_MAX = 8 MB` 를 넘으면 채널을 닫는다. 브라우저는 다시 연결하고 §5.1 로 맞춘다.
- 위 숫자는 상수로 두고 시험에서 상한을 검사한다.

## 7. 생존 확인과 지연 (FR-CON-7)

- 서버: WebSocket 핑·퐁과 무응답 마감은 sockudo-ws 의 쓰기 구동기가 한다(받은 것이 30초 없으면 핑, 퐁을 10초 기다림, 무엇도 120초 받지 못하면 닫음 — 라이브러리 기본값). 앱의 `ping_loop`·`PONG_WAIT` 는 지웠다(C6).
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

- **A-C1** (해소) tungstenite 0.30 은 `permessage-deflate` 를 지원하지 않았다. D-11·D-12 로 sockudo-ws 로 바꿨다.
- **A-C2** 지금 `/api/state` 본문 크기가 바뀔 때마다 모든 채널에 밀어도 될 만큼 작다. C2 시험에서 창 5 × 탭 3 기준 크기를 잰다.
- ~~**OQ-C1** 텔레그램 페어링 확인을 어느 토픽에 실을지~~ → `telegram` full 토픽(C2b).

## 10. 시험 (단계마다 구현 전에 쓴다)

### 10.5 C4 — git 토픽

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH4-1 | 서버(hub) | `git:<repo>` 구독이 쥐는 감시 임대는 TTL 로 걷히지 않고, 구독자 수와 무관하게 임차인은 하나다. 놓으면 그때부터 TTL 이다 |
| TC-CH4-2 | 서버(hub) | 감시가 잡은 관측 변화는 mark 훅(토픽 발행)으로만 나간다 — `git_changed` 방송은 없다 |
| TC-CH4-3 | 서버(gitapi) | 잡의 흐름(`job_feed`)은 보존된 줄 전부와 끝 하나이고, 진행 중인 잡은 나중 줄과 끝을 이어 준다 |
| TC-CH4-4 | 서버(gitapi) | 없는 잡의 흐름은 없다 |
| TC-CH4-5 | 서버(gitapi) | 작업의 시작·끝은 `on_jobs_changed` 로 알린다(`git.jobs` 발행). `git_jobs_changed` 방송은 없다 |
| TC-CH4-6 | 서버 | `/api/stats?jobs=1` 은 작업 목록을 싣지 않는다 |
| TC-CH4-7 | 서버 | `git:<root>` 구독은 `{repo, mark}` full 을 받고, 서버가 그 저장소를 감시하며, 바뀌면 새 mark 의 full 을 민다 |
| TC-CH4-8 | 서버 | `git.jobs` 구독은 `{jobs:[]}` full 을 받는다 |
| TC-CH4-9 | 서버 | 없는 잡의 `gitjob:<id>` 는 `unknown_topic` 이고 연결은 남는다 |
| TC-CH4-10 | 서버 | clientId 를 실은 명령 SSE 는 git 감시 임대를 만들지 않는다 |
| TC-CH4-11 | 프론트 | 같은 루트를 여럿이 봐도 구독은 하나, 마지막이 놓으면 해지한다. 한 쪽이 두 번 놓아도 남의 구독은 남는다 |
| TC-CH4-12 | 프론트 | 채널이 서기 전의 `watch` 는 `bind` 때 구독한다 |
| TC-CH4-13 | 프론트 | `git:<root>` full 은 `{repo, mark}` 변화(`GitSync._onGitChanged`)로 넘어간다 |
| TC-CH4-14 | 프론트 | `git.jobs` 는 `bind` 와 함께 구독하고 목록을 넘긴다 |
| TC-CH4-15 | 프론트 | Git 패널이 토픽을 보고, 원격·서브모듈 탭이 SSE 를 열지 않고, 저장소 목록 폴링·git 감시견 주기·상태바의 작업 목록 조회·등록부의 옛 git 방송이 없다 |
| TC-CH4-16 | 프론트 | Git 패널은 평상시 `git:<root>`(서버가 푼 루트)를 구독하고 주기 타이머를 걸지 않는다. 보는 표면이 없으면 해지한다 |
| TC-CH4-17 | 프론트 | 실패·소실 동안에만 회복용 주기(백오프·고정)를 건다 |
| TC-CH4-18 | 프론트 | `followJob` 은 줄을 넘기고 끝에서 해지하며, 그 토픽의 `unknown_topic` 오류에만 `fail` 이다 |
| TC-CH4-19 | 프론트 | 탐색기는 관측이 없을 때만 매 틱 묻고, 관측한 뒤에는 주기로 묻지 않는다 |

gitwatch (FR-SRV-2·3, PERF 4.9, D-61): 회차 `GIT_WATCH_ROUND_EVERY`(1초)는 감시 대상(임차인이 있거나 TTL 안의 저장소)이 있을 때만 돈다 — 대상이 0 이면 잠들고 첫 관심 표명·토픽 임대가 깨운다. 회차는 git 을 실행하지 않는 signature(파일 stat) 검사만 해 `.git`·common_dir 아래 변화(커밋·체크아웃·스테이지)를 잡는다. 작업 트리는 저장소 루트의 재귀 파일 감시(macOS FSEvents, Linux inotify)가 보고, 사건이 계기 관측(`kick`, debounce 1초·cooldown 5초)으로 `git status` 를 당긴다 — 사건이 없으면 status 는 돌지 않는다. `.git` 아래 사건은 계기가 아니다(status 자신이 `.git/index` 를 고쳐 되먹임이 생긴다). 감시를 세우지 못했거나(Windows, `/Volumes/`, Linux 감시 한도) 사건을 놓치면(넘침) 그 저장소만 `GIT_WATCH_FALLBACK_EVERY`(4초) 간격 워크트리 회차로 물러선다. 설정 `gitWorktreeInterval` 은 지웠다(`RETIRED_KEYS`).

C4 에 남긴 것: Git Console 탭의 기록 주기(`git/console.js`, 탭이 보일 때만)는 그대로다 — 기록은 git 실행 층(`domain/git/core` Service)이 쌓고 변화 훅이 없어 토픽을 세우려면 그 층을 고쳐야 한다. 편집기 틱(`_edTick`)의 `/api/fs/stamps` 주기는 파일 감시(`fs`) 몫이다.

#### 남기는 주기 (PERF M4 설계 §1 Q8, FR-SRV-2)

유휴에도 남기는 서버·데몬·제어 CLI 의 주기다. 값은 등록부 crate `otter-shared-cadence`(`rust/crates/shared/cadence`)의 상수이고, 이 표와 등록부 모듈 문서의 §1 표가 같아야 한다.

| 상수 | 주기 | 쓰는 곳 | 설계 | 남기는 이유 |
|---|---|---|---|---|
| `DIAG_SNAPSHOT_EVERY` | 60초 | `webserver/httpapi` 진단 스냅샷 로그 | S6 | 오래 도는 서버의 메모리·작업 수 추이를 사후에 보려면 사건이 없어도 시간 축 표본이 있어야 한다 |
| `TOOL_HEARTBEAT_EVERY` | 15초 | `webserver/toolclient` 데몬 생존 확인 hello | S10 | 조용한 데몬 연결이 끊긴 것을 알아채려면 무엇이라도 오가야 한다 (FR-OPT-2-1) |
| `ACCESS_REFRESH_EVERY` | 60초 | `webserver/httpapi` 허용 목록 호스트명 재해석 | S8 | DNS 가 바뀐 것을 알려 주는 사건이 없다 (FR-ACL-5) |
| `LOG_CHECK_EVERY` | 60초 | `ctl/cli` 로그 크기 확인 | S11 | 로그를 쓰는 쪽이 여럿이라 쓰기 사건을 한곳에서 받을 수 없다 (FR-LOG-2) |
| `HUMANCMD_HELPER_EVERY` | 30초 | `daemon/boot` 사람 명령 도우미 확인 | D5 | 도우미가 사라진 것을 알려 주는 사건이 없다 |
| `UPDATE_CHECK_EVERY` | 24시간 | `shared/updatecheck` 판 확인 트리거 ③ | S14 | 오래 켜 둔 서버도 새 판을 알게 하는 보조 트리거다 (FR-UPD-2) |
| `MESH_PING_EVERY` | 15초 | `shared/edgemesh` 간선 ping | D4 | 조용한 간선이 끊긴 것을 알아채려면 무엇이라도 오가야 한다. **간선 연결이 하나도 없으면 돌지 않는다** |

등록부 밖에 남는 주기:

- WS ping 30초(S15): 화면 쪽 값 `CHAN_PING_HIDDEN_MS`(`web/js/core/constants.js`)다. 숨은 탭의 채널 생존 확인이다(TC-CH1-10).
- Claude 계정 엔진(S12): 간격이 설정과 응답(재설정 시각)에서 정해진다. 바닥·유휴 값은 `webserver/domain/claudeacct` 엔진 안에만 있다.
- 텔레그램 long-poll(S13): 대기는 Bot API 서버가 붙잡는 시간이다. 꺼져 있으면 요청이 없다.
- `stats:` 발행(S3): 간격은 구독 토픽 이름(`stats:<ms>`)이 정하고, 구독 중에만 돈다.

사건 기반으로 바꾼 것 (4.9·4.11):

- gitwatch 회차(S1, 옛 1초 상시·4초마다 `git status`): 대상이 0 이면 잠들고, 작업 트리 `git status` 는 파일 감시 사건으로만 돈다(위 gitwatch 문단).

- Run 수거(S7, 옛 15초): 기동 때 한 번, 그 뒤 도구 종료 push(재접속 뒤 메운 종료 포함)·Run 닫기·데몬 재접속(resync) 때만 돈다. 끊긴 사이 놓친 종료는 재접속 resync 가 메운다(Q7).
- LSP 유휴 정리(S9, 옛 2분): 세션이 없으면 잠든다. 세션이 있으면 가장 이른 `last_use + IDLE_AFTER`(20분) 마감에 한 번 깨고, 새 세션이 열리면 마감을 다시 잡는다.
- 간선 연결 유지(D4, 옛 1초 틱): 간선도 연결도 없으면 잠든다. 다음 ping(연결이 있을 때만)과 다음 다시 걸기(`MESH_REDIAL_MIN`~`MESH_REDIAL_MAX`) 중 가장 이른 마감까지 자고, 간선 목록 저장·연결 붙음/끊김·걸기 끝남에 깬다.

### 10.1 C1 — 채널 뼈대

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH1-1 | 서버 | 업그레이드가 아닌 `GET /channel` 은 400 이다. 도구 허브가 없어도 채널은 열린다 |
| TC-CH1-2 | 서버 | 첫 프레임이 `hello` 가 아니면 `error{code:"hello_required"}` 를 보내고 닫는다. `HELLO_WAIT`(10초) 안에 `hello` 가 없어도 닫는다 |
| TC-CH1-3 | 서버 | `hello` 에 `hello{epoch, server}` 로 답한다. `epoch` 는 비어 있지 않고 같은 프로세스의 채널끼리 같다. `server.assetVersion` 은 지금 `server_hello` 와 같다 |
| TC-CH1-4 | 서버 | `slots` 의 신원은 채널이 열린 동안 포커스 구독으로 산다(`focus.live_count`). 채널이 닫히면 곧바로 풀린다. `hello` 를 다시 보내 빠진 신원은 풀리고 새 신원은 붙는다 |
| TC-CH1-5 | 서버 | `ping{n}` 에 `pong{n}` 으로 답한다 |
| TC-CH1-6 | 서버 | 깨진 JSON·모르는 `t`·머리(5바이트)보다 짧은 바이너리 프레임에는 `error` 를 보내고 연결은 유지한다 (C5 부터 바이너리 프레임은 터미널 입력이다) |
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
| TC-CH2A-14 | 서버 | 허브가 명령 구독을 닫으면(큐 넘침) 채널이 닫힌다 (PERF 1.17) |

### 10.3 C2b — full·사건 토픽

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH2B-1 | 서버 | `workspace`·`settings`·`edges`·`chat`·`update`·`claude.accounts`·`focus`·`telegram` 을 구독하면 `full.data` 는 그 GET 종단(`/api/state`·`/api/settings`·`/api/edges`·`/api/chat`·`/api/update`·`/api/claude-accounts`·`/api/focus`·`/api/telegram`)의 본문이다. GET 에 ETag 가 있으면 `$etag` 로 더한다(브라우저는 그것을 응답 머리로 되돌린다 — 워크스페이스 rev·설정 패널의 지문) |
| TC-CH2B-2 | 서버 | 상태가 바뀌는 자리(설정 PUT, 워크스페이스 저장, 포커스 주장, 간선·채팅 변화, 판 확인, 계정 변화, 텔레그램 짝맞춤·저장)에서 그 토픽의 `full` 이 나간다. 본문이 지난 발행과 같으면 나가지 않는다 |
| TC-CH2B-3 | 서버 | 사건 토픽: `alert`(계정 알림 본문), `fs`(파일 변화 본문), `edges.notice`(간선 변화의 `paired`·`removed`·`byPeer`·`invited`) |
| TC-CH2B-4 | 서버 | 옮긴 방송(`workspace_changed`·`settings_changed`·`update_changed`·`window_focus`·`edges_changed`·`chat_changed`·`claude_accounts_changed`·`claude_account_alert`·`fs_changed`)은 명령 SSE 로 가지 않는다 |
| TC-CH2B-5 | 프론트 | 등록부의 `topic` 항목은 채널에 구독한다. 연결(`chan:open`)마다 첫 `full` 은 `restore` 에, 그 뒤 `full` 은 `change`(없으면 `restore`)에 봉투(`{ok, status:200, data, text, headers}`)로 넘긴다. 사건은 `event` 처리기에 본문을 넘긴다 |
| TC-CH2B-6 | 프론트 | `workspace` full 은 GET 없이 적용한다. `$etag`(rev)가 `wsETag` 이하이면 버리고, 저장 비행 중이면 유예했다가 받은 본문으로 적용한다 |
| TC-CH2B-7 | 프론트 | 이 상태들의 `sse:open` GET 재검증, Claude 계정 30초 폴링, 텔레그램 짝맞춤 읽기 폴링이 없다(짝맞춤 남은 시간 그리기는 남는다) |

### 10.4 C3 — delta 토픽과 stats

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH3-1 | 서버 | `activity` 를 구독하면 `full` 의 `data` 가 `{toolId: 활동 항목, "_limits": 리밋 목록}` 이다. 항목은 `GET /api/tools/activity` 의 것과 같다 |
| TC-CH3-2 | 서버 | 활동 보고 하나는 `activity` 에 그 도구 하나만 `put` 하는 `delta` 를 낸다. 바뀐 것이 없으면 내지 않는다 |
| TC-CH3-3 | 서버 | 사용률(statusLine) 보고는 방송이 없어도 `activity` 의 그 도구를 다시 계산해 `put` 한다 |
| TC-CH3-4 | 서버 | 알람 보고·해제는 `attention` 에 `put`·`del` 을 낸다(`id` = toolId, 값 `true`) |
| TC-CH3-5 | 서버 | `tools_background_changed` 방송 뒤 `background` 는 바뀐 행만 `put`·`del` 한다(행은 `GET /api/tools/background` 의 것) |
| TC-CH3-6 | 서버 | `run_changed` 방송 뒤 `runs` 는 그 Run 의 보기를 `put` 하고, 구독 중인 `run:<id>` 는 새 그래프를 `full` 로 받는다. 없는 Run 의 `run:<id>` 는 `unknown_topic` 이다 |
| TC-CH3-7 | 서버 | `stats:<ms>` 를 구독하면 곧바로 `full` 을 받고, 구독하는 동안 그 주기로 `full` 이 온다. 1000 보다 작은 주기는 1000 으로 읽는다. 구독자가 없으면 측정이 멈춘다(순번이 오르지 않는다) |
| TC-CH3-8 | 프론트 | 등록부의 토픽 항목(`tool.attention`·`tool.activity`·`tool.background`·`run.list`)은 첫 `chan:open` 에 채널을 구독한다. `full`·`delta` 를 받으면 토픽 맵에서 GET 과 같은 본문을 만들어 그 상태의 복원(또는 적용)에 넘긴다. 한 틱 안의 변화는 한 번으로 합친다 |
| TC-CH3-9 | 프론트 | `tool.activity`·`run.list`·`run.views`·`tool.background` 에 주기(`every`)가 없고, 이 넷과 `tool.attention` 의 `revalidateOn` 에 `chan:open` 이 없다(재연결은 토픽 재구독이 맞춘다) |
| TC-CH3-10 | 프론트 | 상태바는 `/api/ping`·`/api/stats` 를 부르지 않는다. `stats:<statsInterval>` 을 구독하고, `full` 마다 지표를 얹고 지연은 `app.channel.latency()` 로 그린다. 주기가 바뀌면 옛 토픽을 해지하고 새 토픽을 구독한다 |
| TC-CH3-11 | 프론트 | 열린 Run 화면은 `run:<id>` 를 구독해 그래프를 GET 없이 얹고, 화면이 사라지면 해지한다 |

토픽별 결정:
- `activity` 의 리밋은 상태 맵의 예약 id `"_limits"` 에 목록으로 둔다. 리셋까지 남은 시간은 브라우저가 시각으로 계산한다(지금과 같다).
- 서버는 "바뀌었을 수 있다"는 계기(관련 방송 — `tool_attention`·`tool_attention_clear`·`tool_activity`·`tool_subagent_activity`·`tools_background_changed`·`run_changed`·`workspace_changed`·`tool_foreground`, 사용률·서브에이전트 보고)마다 해당 토픽의 맵을 다시 계산해 지난번과 비교하고 다른 id 만 낸다. 계기는 `STATE_TOPIC_DEBOUNCE`(100 ms) 로 합친다. 방송은 명령 허브의 `set_broadcast_tap` 으로 엿본다.
- `activity` 의 `working` 항목은 PTY 가 바쁠 때만 든다(`activity_snapshot` 의 busy 판정, GET 과 같다). 바쁨의 변화는 `tool_foreground` 방송으로 드러나므로 그 방송도 `activity`·`runs` 를 다시 계산한다. 이전 동작: 놀고 있는 PTY 의 `working` 카드가 다음 활동 주기(5초)까지 남았다 / 새 동작: 다음 계기(100 ms)에 거둔다 / 이유: 폴링 없이 서버 판정을 그대로 따른다.
- `foreground` 는 이 단계에서 토픽으로 옮기지 않는다. 주기 폴링이 없고 재조회는 워크스페이스 적용 경로(`/api/state`)에 있다 — C2b 의 `workspace` 토픽이 함께 가져간다.
- `stats` 의 주기는 토픽 이름에 싣는다(`stats:<ms>`). 서버는 구독 중인 주기 가운데 가장 짧은 것(하한 1초)으로 한 번 재서, 구독 중인 `stats:*` 모두에 같은 값을 낸다. **남는 서버 내부 주기 (FR-SRV-2)**: `stats` 측정 — 이유: CPU·메모리·가동 시간은 사건 없이 바뀐다. 주기: 구독자의 `statsInterval`(기본 3초, 하한 1초). 커널을 읽는 sysstat 샘플러(`cadence::SYSSTAT_SAMPLE_EVERY`, 2초)도 `stats:*` 구독이 있는 동안만 돈다 — 첫 구독에 띄우고 마지막 해지에 멈춘다. 첫 구독의 seed 는 예열 표본 둘(`SYSSTAT_WARMUP_GAP`, 250 ms 간격)을 기다려 CPU 를 싣고, 마지막 해지는 토픽 상태를 비워 다음 구독이 새로 잰 seed 를 받게 한다. 구독자가 없으면 둘 다 돌지 않는다 (PERF D-61, 4.10. 이전: 샘플러는 서버 수명 동안 2초마다 돌았다). `GET /api/stats` 는 메모리·디스크·부팅 시각을 그 자리에서 재고 CPU 는 구독 중 값이 있을 때만 싣는다.
- git 작업 목록의 안전망(`/api/stats?jobs=1`)은 상태바 폴링과 함께 없어진다. `git.jobs` 토픽(C4)이 대신한다.

### 10.6 C5 — 터미널

서버→브라우저 텍스트 프레임에 `term.lost{sid}` 를 더한다: 그 터미널의 붙음이 서버 쪽 사정(도구 구독이 끊김, 데몬 재연결 중 조회)으로 끝났다. 브라우저는 옛 `/ws` 가 닫혔을 때와 같이 백오프 뒤 `term.open{since}` 로 다시 붙는다. 옛 `/ws` 의 "없는 도구를 거듭 묻는 연결 붙잡기"(hold)는 두지 않는다 — 채널은 다시 연결하지 않고 `EXIT` 를 받은 칸은 다시 열지 않는다. 반복 조회의 지연(`MISS_DELAY`)은 남긴다.

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH5-1 | 서버 | `term.open` 에 `tool` 이 없으면 `cols`·`rows` 로 도구를 만들고 `[TOOLID][sid]` 로 id 를 알린다 |
| TC-CH5-2 | 서버 | 있는 도구: `TOOLID` → `SIZE` → `REPLY_SEAT(1)` → 맞춤 `OUTPUT` → `SEQ` 순서다. `since` 가 없거나 보유 창 밖이거나 `snap` 이면 맞춤은 화면 상태 스냅숏이고 `SEQ` 에 `FULL`·`SNAP` 이 선다(M2 개정, 이전: 전량 재생 — 초기화·클리어·첫 줄까지 버림). 모든 프레임 앞에 그 `sid` 가 붙는다 |
| TC-CH5-3 | 서버 | `since` 가 보유 창 안이면 그 뒤만 보내고 `SEQ` 의 full 비트가 0 이다. 크기를 모르면 `SIZE` 를 보내지 않는다 |
| TC-CH5-4 | 서버 | `[INPUT][sid]`·`[RESIZE][sid]` 는 그 sid 의 도구로 간다(브라우저 입력 시각도 남는다). 모르는 sid 는 버린다 |
| TC-CH5-5 | 서버 | 없는 도구는 그 sid 에 `EXIT` 이고 채널은 남는다 |
| TC-CH5-6 | 서버 | 출력은 보낸 끝을 따라 겹침을 잘라 이어 보내고, 크기 통보 앞의 출력을 먼저 보낸다 |
| TC-CH5-7 | 서버 | 출력에 틈이 생기면 채널을 닫지 않고 그 sid 만 화면 상태 스냅숏 + `SEQ` 로 다시 맞춘다(M2 2.6 개정, 이전: `since=보낸 끝` 재생) |
| TC-CH5-8 | 서버 | 도구가 끝나면 그 sid 에 `EXIT` 이고 같은 채널의 다른 sid 는 계속 받는다 |
| TC-CH5-9 | 서버 | 같은 도구에 두 채널이 붙으면 먼저 붙은 쪽이 좌석 주인이고, 그쪽이 `term.close` 하면 남은 쪽이 `REPLY_SEAT(1)` 을 받는다 |
| TC-CH5-10 | 서버 | `term.close` 뒤에는 그 sid 로 아무것도 오지 않는다 |
| TC-CH5-11 | 서버 | Outbox 는 sid 마다 밀린 바이트만 센다. sid 의 밀린 양이 `TERM_PENDING_MAX`(1 MB)를 넘으면 그 sid 의 밀린 출력만 버리고 화면 상태 스냅숏으로 다시 맞춘다(M2 2.6 개정, 이전: 브라우저 좌표를 따라가 그 좌표부터 재생) |
| TC-CH5-12 | 서버 | 도구 구독이 끊기면 `term.lost{sid}` 를 보낸다 |
| TC-CH5-13 | 서버 | 옛 `/ws` 종단이 없다 |
| TC-CH5-14 | 프론트 | `open` 은 채널이 준비됐을 때 `term.open{sid,tool,cols,rows,since?}` 를 보내고, 아니면 다음 서버 `hello` 때 보낸다. 자기 sid 의 바이너리 프레임만 앞 5바이트를 뗀 꼴로 `_onOp` 에 넘긴다 |
| TC-CH5-15 | 프론트 | `send` 는 `[op][sid]` 머리를 붙인다. 붙는 중이면 큐(`TERM_SEND_QUEUE_MAX`)에 담고, 끊겼으면 버리며 센다. 열리면 큐를 비운다 |
| TC-CH5-16 | 프론트 | 채널이 끊기면 열린 터미널 모두가 `_wsLost('close')` 를 받고, 다시 붙으면 백오프 뒤 `term.open{since}` 로 다시 연다 |
| TC-CH5-17 | 프론트 | `ws.close()`(손잡이)와 서버 `term.lost` 는 그 터미널만 끊긴 것으로 다룬다: `term.close` → `_wsLost` → 백오프(종전 수열) → 다시 연다 |
| TC-CH5-18 | 프론트 | 한 번 열린 뒤 끊긴 동안의 사용자 입력은 보류함에 담긴다(FR-HIN) |

### 10.7 C6 — 압축과 WebSocket 구현 통일 (D-12)

| ID | 쪽 | 동작 |
|---|---|---|
| TC-CH6-1 | 서버 | 채널 업그레이드 응답에 `Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=13` 이 붙는다. context takeover 를 끄지 않는다 |
| TC-CH6-2 | 서버 | 압축을 제안하지 않는 채널 업그레이드는 400 이다 |
| TC-CH6-3 | 서버 | 큰 텍스트 프레임(200 KB)이 압축된 채로 오가고 내용이 같다. 나머지 채널 시험도 모두 압축된 클라이언트로 돈다 |
| TC-CH6-4 | 서버 | 편집기 LSP WebSocket 도 같은 구현으로 압축을 협상하고, 제안이 없으면 400 이다. 메시지 상한을 넘으면 연결이 끝나고 통로도 닫힌다(1009 는 싣지 못한다 — 아래 동작 변경) |
| TC-CH6-5 | e2e | 실제 Chromium 의 채널 핸드셰이크 응답에 `permessage-deflate` 가 있고, 그 위로 `ping`·`pong` 이 오간다 |
| TC-CH6-6 | 서버 | `gitconsole:<root>` 의 full 은 `{seq, epoch}` 이고, 그 저장소에 기록이 더해지면 새 Seq 의 full 을 민다. 다른 저장소의 기록은 오지 않는다 |
| TC-CH6-7 | 프론트 | Console 은 주기 재조회를 걸지 않는다. 보이는 동안 받은 루트의 토픽 하나를 구독하고, Seq 가 커서 뒤이거나 세대가 바뀔 때만 `after` 로 다시 받는다. 숨으면·저장소가 바뀌면·내려가면 구독을 놓는다 |
| TC-CH6-8 | 프론트·서버 | 설정 `agentsPollInterval` 이 표·화면·기본값에 없다. 저장된 옛 값은 화면이 무시하고 `otterctl config` 도 경고하지 않는다(`RETIRED_KEYS`) |

동작 변경:
- 이전: LSP WebSocket 에 상한을 넘는 메시지가 오면 서버가 닫힘 코드 1009 를 보냈다.
- 새 동작: 연결이 닫힘 코드 없이 끝난다(브라우저에는 1006). 통로는 전과 같이 닫힌다.
- 이유: sockudo-ws 는 읽기 오류 뒤 쓰기를 막아 닫힘 프레임을 보낼 수 없다. 브라우저(`cm-lsp.js`)는 1009 를 따로 다루지 않는다.
- 이전: 진단 한 줄(`diag …`)에 `hold=` 와 그 경고가 있었다.
- 새 동작: 없다.
- 이유: 그 값을 올리던 옛 `/ws` 의 연결 붙잡기가 C5 에서 사라져 늘 0 이었다.

## 11. 구현 계약 (토픽 기반 — C2~C5 가 딛는다)

### 11.1 서버 (`rust/crates/webserver/httpapi/src/channel/`)

- `TopicHub` 하나를 `Server` 가 갖는다(`self.topics`). 토픽마다 **지금 상태**를 든다: full 토픽은 마지막 값, delta 토픽은 `id → 값` 맵, event 토픽은 상태가 없다. 그래서 `full` 은 언제나 허브가 가진 상태에서 만든다.
- 발행: `publish_full(topic, Value)`, `publish_delta(topic, Vec<DeltaOp>)`(`DeltaOp::Put{id,v}` · `DeltaOp::Del{id}`, 상태 맵에 적용한다), `publish_event(topic, Value)`. 발행마다 순번이 1 오르고 링(`TOPIC_RING`=64)에 들어간다. 구독자가 없어도 상태와 순번은 갱신한다.
- 처음 상태: `register_seed(prefix, f)` — 상태가 아직 없는 토픽을 처음 구독할 때 `f(topic: String) -> BoxFuture<'static, Option<Seed>>` 를 불러 채운다(`Seed::Full(Value)` · `Seed::Map(BTreeMap<String,Value>)` · `Seed::Event` — 사건 토픽을 이름으로 등록한다). 서버가 필요하면 등록하는 쪽이 `Weak<Server>` 를 잡는다. seed 전에 들어온 delta 는 상태에 적용하지 않고(순번·링은 오른다), seed 하는 사이에 발행이 끼면 seed 를 다시 부른다(최대 3회). full 을 보낼 때 그 full 에 이미 든 밀린 변화는 버린다. `prefix` 는 `"workspace"` 처럼 정확한 이름이거나 `"git:"` 처럼 `:` 로 끝난다. seed 가 없는 토픽을 구독하면 `error{code:"unknown_topic"}` 다.
- 채널 쪽: 채널마다 `Outbox` 하나. 차선 넷 — 제어 > 터미널 > 위로 받기 > 상태(§6). 상태 차선은 토픽마다 합친다(full 은 최신만, delta 가 `TOPIC_PENDING_MAX`=64 를 넘으면 full 로 바꾼다). 채널 전체 `CHANNEL_PENDING_MAX`=8 MB 를 넘으면 닫는다. 쓰기 태스크 하나가 Outbox 를 비운다.
- 메시지 처리: `sub`·`unsub` 을 C1 의 읽기 루프에 더한다. 재구독 판정은 §5.1(epoch 다름·링 밖 → full/reset, 링 안 → 이어지는 것, 같으면 없음).
- 터미널 차선(C5): `term_begin(sid) -> 세션 번호`(밀린 프레임을 잊고 번호를 올린다), `push_term_as(번호, op, sid, payload)`(지금 세션이 아니면 버린다 — 바뀐 세션의 늦은 프레임이 새 재생 사이에 끼지 않는다), `term_current(sid, 번호)`(지금 세션인가), `term_pending(sid) -> 밀린 바이트`, `drop_term_output(sid)`(밀린 출력만 버림), `forget_term(sid)`, `push_history(프레임)`(위로 받기 차선, M2). 도구 출력은 `push_shared_as(번호, op, sid, Bytes)` 로 넣어 본문을 복사하지 않는다(아래 "한 번 인코딩"). 세션 코드는 `channel/term.rs` 다.
- 구독자가 생기고 없어지는 순간을 알 수 있게 `on_demand(prefix, f(topic, active: bool))` 를 둔다(`stats` 측정·git 감시 임대가 쓴다).
- **한 번 인코딩(FR-SRV-1, M4 설계 §4·Q9).** 출력 하나·발행 하나의 직렬화와 프레임 본문 조립은 서버에서 한 번만 한다. 연결마다 하는 일은 셋뿐이다: 5바이트 머리(`op`·`sid`) 붙이기, permessage-deflate(연결마다 문맥이 다르다, D-12), 참조 계수 나누기.
  - 상태 토픽: 발행한 프레임(`Item.frame: Arc<str>`)을 모든 구독 채널이 나눈다. full 은 `(토픽, 순번)` 마다 `Arc<Item>` 하나를 캐시한다 — 발행한 full, 새 구독의 full, 밀려서 바꾼 `NeedFull` 이 같은 순번이면 같은 `Arc` 다(사건 토픽의 reset 도 같다). 순번이 오르면 다음에 필요할 때 새로 만들고, 구독자가 없어 상태를 비우면(`stale_if_idle`) 캐시도 놓는다. 쓰기 태스크는 `Bytes::from_owner` 로 `Arc<str>` 를 복사 없이 `Message::Text` 에 넘긴다.
  - 터미널 출력: 데몬 push 하나의 바이트는 toolclient 가 한 번 `bytes::Bytes` 로 만들고(`OutChunk.data`), 구독자마다 참조 계수만 나눈다. 중계(`channel/term.rs` `relay`)는 겹침을 잘라도 같은 버퍼의 조각(`slice_ref`)을 쓰고, 조각 하나면 그대로 Outbox 에 넣는다. 조각 여럿을 합칠 때(`RELAY_COALESCE_MAX` 안)만 채널마다 새 버퍼를 만든다. Outbox 는 `TermFrame{op, sid, payload}` 를 들고, 쓰기 태스크가 보낼 때 머리를 붙인다(`TermFrame::wire`).
  - 남는 연결마다의 복사: WebSocket 구현(`sockudo-ws`)이 메시지 하나를 연속 바이트로 받으므로 머리와 본문을 잇는 복사 한 번과, 압축·프레이밍이 쓰기 버퍼에 쓰는 것은 연결마다 남는다. 시험: `topic_full_same_seq_serialized_once`(`Arc::ptr_eq`), `term_output_shared_across_subscribers`(본문 포인터가 데몬 버퍼와 같다), toolclient `output_shared_across_subscribers`.

### 11.2 프론트 (`web/js/core/channel.js`)

- `sub(topic, fn, {owner})` → `{stop()}`. 같은 토픽에 구독자가 여럿일 수 있고, 첫 구독자가 서버 `sub` 를, 마지막 해지가 서버 `unsub` 를 보낸다.
- `fn(msg)` 의 `msg`: `{kind:'full', data, seq}` · `{kind:'delta', ops, seq}` · `{kind:'event', data, seq}` · `{kind:'reset'}`.
- 토픽마다 마지막 `seq` 와 그것을 받은 `epoch` 를 든다. 빈틈이면 `sub{topic, seq, epoch}` 를 다시 보내고 그 사이의 프레임은 버린다. 다시 연결하면 서버 `hello` 뒤에 구독 중인 토픽 전부를 `sub{topic, seq, epoch}` 로 다시 보낸다.
- 도우미 `chanApply(map, ops)` — delta 를 `Map` 에 적용한다. `full` 이 delta 토픽에 오면 `data` 는 `{id: 값}` 객체다.
- 원시 수신: `on(t, fn)` — `cmd` 처럼 토픽이 아닌 종류(C2), `onBinary(fn)` — 터미널 프레임(C5).
- 보내기: `send(v)`(열려 있을 때만, 아니면 false), `sendBinary(u8)`.
