# SRS: 에이전트 메시지의 깨움 전달 — otterctl msg 가 입력창에 끼어들지 않게 한다 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **남은 것**: 없음. 검증은 §5.1 에 적었다
> **승인**: 2026-11-26 사용자 승인("구현진행")
> **접수**: 2026-11-26 대화(인터뷰). 사용자 결정은 §4, 사용자가 아직 확인하지 않은 가정은 §10 이다.
> **개정 대상**: `ISSUE_TREE_CHAT_SRS` §3.5 의 `msg` 설명, FR-CAL-8(깨움 훅을 거는 이벤트), FR-CAL-9(깨움 훅이 기다리는 것). 자세한 것은 §8 이다.

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

사용자 요구(2026-11-26)는 다음과 같다.

> otterctl 로 에이전트에 프롬프트를 넣으면 붙여넣기 뒤 엔터를 눌러 버린다. 사용자가 입력하는 중에 이 일이 일어나면, 쓰던 입력이 미완성인 채로 함께 제출된다. 해결법을 연구한다.

메모장 `memo` 64줄도 같은 주제다: "에이전트 입력창에 입력 시 현재 입력된 내용 저장 후 삭제한 뒤 입력하고 저장한 내용 다시 쓰기".

이 SRS 는 claude 에게 가는 에이전트 메시지를 입력창이 아니라 깨움 훅으로 전달하도록 정한다. 깨움 훅은 `Stop` 과 `SessionStart` 에 걸고, 채팅 깨움도 같은 훅을 쓴다.

### 1.2 범위 (Scope)

| 묶음 | 이름 | 접두어 | 산출물 |
|---|---|---|---|
| **Q** | 전달 대기열 | `FR-AMW-` 1~9 | 받을 탭의 판별 · 대기열 · 버림 · 응답 |
| **H** | 깨움 훅 | `FR-AMW-` 10~16, 23~25 | 훅을 거는 이벤트 · 훅이 메시지와 채팅 글을 기다리고 건네는 방식 |
| **S** | 상태 판정 | `FR-AMW-` 17~19 | 대기 메시지가 있을 때의 `done` |
| **D** | 안내문 | `FR-AMW-` 20~22 | 신뢰 채널 안내 · 도움말 · 에이전트 메모리 |
| — | 비기능 | `NFR-AMW-` | 유휴 규칙 · 보안 · 시험 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

`ISSUE_TREE_CHAT_SRS` §1.3 의 **깨움 훅** 을 따른다. 이 SRS 고유 용어만 적는다.

| 용어 | 정의 |
|---|---|
| **에이전트 메시지** | `agent_envelope` 로 감싼 글. `otterctl msg`(`POST /api/tools/message`)와 서버 알림 셋(§2.2)이 만든다 |
| **명령 입력** | 엔벨로프가 아닌 입력. `otterctl send-input`, `--resume` 실행 줄, `/exit` 다 |
| **깨움 대상** | 깨움 훅으로 메시지를 받을 수 있는 탭. 판정은 FR-AMW-1 이다 |
| **전달 대기열** | 깨움 대상 탭마다 서버가 들고 있는, 아직 건네지 않은 에이전트 메시지의 목록 |
| **훅 대기** | 깨움 훅이 그 탭의 대기열을 기다리며 서버에 열어 둔 연결 |
| **비우기** | 서버가 대기열의 메시지를 모두 훅 대기 하나에 넘기고 대기열을 비우는 일 |

### 1.4 참고 (References)

- `ISSUE_TREE_CHAT_SRS.md` §2.2(깨움 훅 실측), FR-CAL-8~13, D-ITH-3, R-1, TC-ITH-7
- `ISSUE_TREE_CHAT_PROGRESS.md` — TC-ITH-7 실측 결과
- `BRACKETED_PASTE_SRS.md` FR-BPW-4·5 — 붙여넣기 감싸기와 120ms 뒤 제출
- `ORCHESTRATION_V2_SRS.md` — 서버 알림 엔벨로프(`from=otterminal-server`)
- `PERF_OPTIMIZATION_SRS.md` NFR-PRF-5, FR-SRV-3 — 유휴 규칙
- Claude Code 설정 스키마의 `hooks[].asyncRewake`

### 1.5 개요 (Overview)

§2 는 지금의 사실, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험, §8 은 다른 SRS 의 개정, §10 은 확인할 가정이다.

## 2. 현황 (Identified Facts)

### 2.1 지금의 전달

| 단계 | 동작 | 근거 |
|---|---|---|
| 받기 | `POST /api/tools/message {to, from, message}` 가 본문을 엔벨로프로 감싼다 | `webserver/httpapi/src/toolio.rs` `api_tool_message`, `agent_envelope` |
| 넣기 | `deliver_to_tool(.., submit=true)` → 데몬 `send_paste` 가 글을 넣고, 셸이 bracketed paste 를 켰으면 감싼다 | `shared/toolhub/src/manager.rs` `send_paste` |
| 제출 | 120ms(`PASTE_SUBMIT_DELAY`) 뒤 CR 을 쓴다 | 같은 곳 |

받는 쪽의 상태(쉬는 중 · 일하는 중)와 입력창의 내용을 보지 않는다. 사용자가 입력창에 쓰던 글이 있으면 그 뒤에 메시지가 붙어 함께 제출된다.

### 2.2 입력창에 넣고 제출하는 다른 곳

| 위치 | 보내는 것 | 종류 |
|---|---|---|
| `runs_context.rs` (context-alert) | `[CONTEXT-ALERT …]` → 조정자 | 에이전트 메시지 |
| `runs_context.rs` (handoff 요청) | `[HANDOFF-REQUEST …]` → 승계될 멤버 | 에이전트 메시지 |
| `runs_tree.rs` (트리 승계 알림 두 곳) | `[ISSUE-TREE 승계] …` | 에이전트 메시지 |
| `runs_recover.rs` | `claude --resume …` 실행 줄(셸에 넣는다) | 명령 입력 |
| `runs_close.rs` | `/exit` | 명령 입력 |
| `toolio.rs` `api_tool_input` | `otterctl send-input` | 명령 입력 |

### 2.3 깨움 훅 (지금)

- otterminal 이 띄운 claude 에는 `Stop` 훅 `otterctl chat-wait`(`asyncRewake: true`, 시한 7일)이 걸린다(`agentadapter/src/claude.rs` `write_activity_hooks`).
- 훅은 턴이 끝날 때 떠서 데몬 채팅 소켓에 `wait` 를 보내고, 답이 올 때까지 막혀 기다린다. 깨울 글이 있으면 개수를 stderr 에 쓰고 종료 코드 2 로 끝나 세션을 깨운다(`runtimebin/src/otterctl/hooks.rs` `run_otterctl_chat_wait`).
- 그 세션의 채팅 MCP 연결이 없으면 곧바로 0 으로 끝난다(FR-CAL-9).
- 실측(TC-ITH-7): 깨움은 입력창을 건드리지 않았다. 입력창에 쓰던 글은 남았고, 엔터로 따로 제출됐다.
- 다른 에이전트: codex 는 훅이 없다(`codex.rs` `hooks: false`). omp 는 자체 훅 모듈이 있으나 깨움 기능은 확인하지 않았다.
- `Stop` 훅은 턴을 한 번 마쳐야 처음 뜬다. 그래서 막 띄운 claude 에는 지금 깨움 훅이 없다.

### 2.3a `SessionStart` 깨움 — 실측 (2026-11-26, Claude Code 2.1.332, shim 을 거치지 않은 진짜 claude)

`--settings` 로 `SessionStart` 에만 `{type:"command", asyncRewake:true}` 훅을 걸었다. 훅은 신호 파일이 바뀌면 메시지 파일의 내용을 stderr 에 쓰고 종료 코드 2 로 끝난다. 재료는 `/private/tmp/` 의 `*-sstest/` 다(`ls -d /private/tmp/*-sstest` 로 찾는다. 폴더 이름의 앞머리가 옛 약칭이라 문서에 그대로 적지 않는다).

| 시험 | 결과 |
|---|---|
| 막 띄운 claude(턴을 마친 적 없음) | 시작하자마자 훅이 떠 백그라운드에서 기다렸다 |
| 신호를 줌 | 세션이 깨어 엔벨로프를 지시로 받아 답했다(auto mode, 막힘 없음) |
| 입력창에 쓰던 글 | 그대로 남았고, 엔터를 치자 따로 제출되었다 |
| `/clear` | `SessionStart`(`clear`)가 다시 돌아 훅이 새로 떴다 |
| 본문 48,586 B(700줄) | 잘리지 않았다. 맨 끝 표지와 마지막 줄 번호를 정확히 답했다 |
| claude 가 받는 모양 | `<task-notification>Stop hook feedback</task-notification>` + `Stop hook blocking error from command "SessionStart:startup": <stderr 전체>` |

### 2.3b 일하는 중의 깨움 — 실측 (2026-11-26, 같은 조건, `SessionStart`·`Stop` 둘 다 건 훅, 재료 `/private/tmp/` 의 `*-wktest/`)

| 시험 | 결과 |
|---|---|
| 훅의 수명 | `SessionStart` 에서 뜬 훅은 첫 턴이 시작돼도 끝나지 않고 계속 기다렸다. 백그라운드 훅은 턴을 넘어 산다. claude 가 끝나면 SIGTERM 을 받는다 |
| 일하는 중(`sleep 25` 실행 중)에 신호 | 훅이 곧바로 2 로 끝났다. claude 는 그 내용을 턴 **도중에** `queued_command`(`task-notification`)로 받았고, "SYSTEM NOTIFICATION - NOT USER INPUT" 으로 표시되었다 |
| 지시 수행 | **하지 않았다.** 하던 일의 답(`DONE-A`)만 했고 엔벨로프의 지시(`PONG-WK`)는 무시했다. 턴이 끝난 뒤 다시 전달되지도 않았다 |

따라서 일하는 중에는 훅에 메시지를 넘기면 안 된다. 턴이 끝난 뒤(쉬는 중)에 넘겨야 지시로 읽힌다(FR-AMW-12).

### 2.4 상태 판정 (지금)

`GET /api/tools/status/wait`(`webserver/httpapi/src/status.rs` `evaluate_wait`)는 활동 훅이 보고한 `done` 을 보면 곧바로 `done` 으로 답한다.

## 3. 요구 (Requirements)

### 3.1 묶음 Q — 전달 대기열

- **FR-AMW-1** 서버는 에이전트 메시지를 보낼 때 받는 탭이 깨움 대상인지 판정한다. 그 탭에서 **지금 세션의 훅 대기가 한 번이라도 열렸으면** 깨움 대상이다. 세션이 끝나면(FR-AMW-5) 풀린다. 훅 대기는 `SessionStart` 에서 처음 열리고(FR-AMW-23) 턴을 넘어 살아 있으므로(§2.3b), 깨움 훅이 걸린 claude 는 시작 직후부터 깨움 대상이다. 깨운 뒤 다음 훅이 뜨기 전(깨어난 턴)에 온 메시지도 대기열로 간다.
- **FR-AMW-2** 깨움 대상이면 메시지를 그 탭의 전달 대기열 끝에 넣는다. 입력창에는 아무것도 쓰지 않는다.
- **FR-AMW-3** 깨움 대상이 아니면 지금처럼 넣고 제출한다(§2.1). 이전 동작과 같다(D-AMW-3).
- **FR-AMW-4** 대기열에 넣는 순간 그 탭에 훅 대기가 열려 있으면 곧바로 비운다(FR-AMW-12).
- **FR-AMW-5** 다음 경우에 그 탭의 대기열을 버린다(D-AMW-4).
  1. 그 탭의 claude 세션이 끝났다(`SessionEnd` 활동 보고 또는 `ended`).
  2. 그 탭에 다른 세션이 등록됐다.
  3. (탭이 닫히면 claude 가 끝나며 1 이 된다. 보고 없이 사라진 탭의 대기열은 서버가 다시 뜰 때 사라진다 — 구현 결정 I-4.)
- **FR-AMW-6** 버릴 때 서버 기록에 탭 id 와 버린 수를 남긴다(`infof`). 본문은 남기지 않는다.
- **FR-AMW-7** `POST /api/tools/message` 응답에 `delivery` 를 더한다. 값은 `queued`(대기열에 넣음) 또는 `pasted`(넣고 제출함)다. 다른 필드는 그대로다.
- **FR-AMW-8** `otterctl msg` 는 `delivery` 가 `queued` 이면 기존 완료 줄 다음에 한 줄을 더 쓴다: `전달 대기: 받는 claude 가 쉬고 있으면 곧바로, 일하는 중이면 그 턴이 끝난 뒤 깨움 훅이 건넨다`. `pasted` 이면 출력은 이전과 같다.
- **FR-AMW-9** 서버 알림 셋(§2.2 의 에이전트 메시지)도 FR-AMW-1~5 를 따른다. 명령 입력(`--resume` 실행 줄, `/exit`, `send-input`)은 지금처럼 넣고 제출한다(D-AMW-6).

### 3.2 묶음 H — 깨움 훅

- **FR-AMW-10** 깨움 훅(`otterctl chat-wait`)은 채팅 글과 함께 자기 탭의 전달 대기열도 기다린다. 탭은 훅 환경의 도구 id 로 안다.
- **FR-AMW-23** shim 이 주입하는 훅 설정(`<home>/bin/agent-hooks/claude.json`)의 `SessionStart` 에도 깨움 훅을 건다. 모양은 `Stop` 의 것(FR-CAL-8)과 같다(`asyncRewake: true`, 시한 `CHAT_WAIT_TIMEOUT_SECS`). 이전: `Stop` 에만 / 새: `SessionStart` 와 `Stop` / 이유: 막 띄운 claude 도 입력창 없이 깨운다(D-AMW-7).
- **FR-AMW-24** `SessionStart` 에서 뜬 깨움 훅도 채팅 깨움(FR-CAL-9~11)과 메시지 깨움(FR-AMW-10~16)을 모두 한다(D-AMW-8). 그 시점에 그 세션의 채팅 MCP 연결이 아직 없으면 곧바로 끝내지 않고 연결이 생길 때까지 기다린다. 이전: 채팅 연결이 없으면 곧바로 0 / 새: 생길 때까지 기다림 / 이유: 시작 직후에는 MCP 연결이 훅보다 늦게 생길 수 있다.
- **FR-AMW-25** 한 세션의 깨움 훅 대기는 채팅 쪽(데몬)과 메시지 쪽(서버) 모두 세션·탭마다 하나만 남는다. `SessionStart` 의 훅이 기다리는 중에 턴이 끝나 `Stop` 의 훅이 뜨면, 앞의 것은 빈 답을 받고 0 으로 끝난다. 이미 데몬의 채팅 대기가 이 규칙이다(`chatsock` `wait_wake`). 메시지 쪽은 FR-AMW-12 다.
- **FR-AMW-11** 채팅 MCP 연결이 없어도 대기열은 기다린다. 이전: 채팅 연결이 없으면 곧바로 0 으로 끝남 / 새: 대기열을 기다림 / 이유: 메시지는 채팅 연결과 무관하다.
- **FR-AMW-12** 훅 대기는 서버에 하나 열어 둔다. 서버는 그 탭이 **일하는 중이 아닐 때만** 비운다. 일하는 중(`working`·`waiting`)이면 대기열과 훅 대기를 그대로 두고, 턴이 끝나 활동 훅이 `done`·`idle` 을 보고하는 순간 비운다(§2.3b). 일하는 중이 아니면 대기열이 비어 있지 않을 때 곧바로, 비어 있으면 메시지가 들어올 때 비운다. 한 탭에 훅 대기가 둘 열리면 나중 것만 남기고 앞의 것은 빈 답으로 닫는다.
- **FR-AMW-13** 같은 메시지는 한 번만 건넨다. 비우기는 원자적이다.
- **FR-AMW-14** 훅은 받은 메시지를 온 순서대로, 엔벨로프째 통째로 stderr 에 쓰고 종료 코드 2 로 끝난다(D-AMW-2). 메시지 사이는 빈 줄 하나다.
- **FR-AMW-15** 채팅 깨움과 메시지가 함께 있으면 둘 다 쓴다. 채팅 줄(FR-CAL-10)을 먼저, 메시지를 뒤에 쓴다. 한쪽이 먼저 깨우면 다른 쪽은 기다리지 않고 그 순간 있는 것만 싣는다.
- **FR-AMW-16** 훅 대기 연결이 끊기거나 빈 답으로 끝나면(서버 종료, 새 훅에 밀림) 메시지 쪽은 끝나고 채팅 쪽만 계속 기다린다. 두 쪽 모두 건넬 것 없이 끝나면 종료 코드 0 이다. 서버가 건넨 메시지를 받는 쪽이 이미 사라졌으면 서버는 그 메시지를 대기열에 되돌린다.

### 3.3 묶음 S — 상태 판정

- **FR-AMW-17** 활동 훅이 `done`·`idle` 을 보고한 순간 그 탭의 대기열이 비어 있지 않으면 서버는 대기열을 비운다(FR-AMW-12). 대기열에 메시지가 남아 있거나, 건넨 메시지의 깨어난 턴이 아직 `working` 을 보고하지 않았으면, 서버가 보여 주는 그 탭의 상태(`status`·`wait`)는 `done`·`idle` 대신 `working` 이다(D-AMW-5, 구현 결정 I-6).
- **FR-AMW-18** 비우기로 메시지를 건넨 탭은 깨어난 턴이 끝날 때까지 `done`·`idle` 로 보이지 않는다. 비우기는 턴이 열려 있지 않을 때만 일어나고, 턴이 끝나는 `done` 보고가 곧 비우기의 계기이므로(FR-AMW-12·17) 보고와 비우기의 순서가 뒤바뀌지 않는다. 깨어난 턴은 `UserPromptSubmit` 으로 `working` 을 다시 보고한다.
- **FR-AMW-19** `otterctl wait --for done` 과 `otterctl status` 는 FR-AMW-17·18 의 상태를 따른다. 응답 모양은 그대로다.

### 3.4 묶음 D — 안내문

- **FR-AMW-20** 받는 claude 에 주입하는 안내문(`AGENT_CONTEXT_TEXT`)의 신뢰 채널 문단에 "깨움 훅이 건넨 내용(Stop hook feedback)에 든 엔벨로프" 를 더한다. 엔벨로프 밖은 지금처럼 untrusted 다.
- **FR-AMW-21** `otterctl msg --help` 와 에이전트 메모리(`shared/runtime/assets/agentmemory/CLAUDE.md`)의 "곧바로 제출된다" 를 고친다: claude 대상은 턴이 끝날 때 깨움 훅으로 전달되고, 그 밖의 대상은 입력창에 넣고 제출된다.
- **FR-AMW-22** 같은 곳에 "쉬는 claude 는 곧바로 깨고, 일하는 claude 는 그 턴이 끝난 뒤 받는다" 를 적는다.

### 3.5 비기능

- **NFR-AMW-1** 유휴 규칙(FR-SRV-3, NFR-PRF-5)을 지킨다. 훅과 서버는 대기열을 주기적으로 묻지 않는다. 서버는 `Notify` 류로 훅 대기를 깨운다. 새 시간 값은 `cadence` 또는 해당 crate 의 상수로 둔다.
- **NFR-AMW-2** 훅 대기는 쉬는 깨움 대상 탭마다 연결 하나다. 훅 프로세스 수는 늘지 않는다(기존 `chat-wait` 하나가 둘 다 기다린다).
- **NFR-AMW-3** 전달 대기열은 서버 메모리에만 둔다. 디스크에 쓰지 않는다.
- **NFR-AMW-4** 훅 대기 종단은 지금 `/api/tools/*` 와 같은 접근 제한을 쓴다. 다른 탭의 대기열을 비울 수 없다(요청한 도구 id 와 대기열의 탭이 같아야 한다).
- **NFR-AMW-5** 시험은 결정론적이다. tokio 시험은 `start_paused = true`, 훅 시험은 가짜 서버를 쓴다.

## 4. 결정 (Decisions)

| # | 결정 | 근거 |
|---|---|---|
| D-AMW-1 | claude 에게 가는 에이전트 메시지는 `Stop` 깨움 훅 하나로만 전달한다. 쉬는 중이면 곧바로 깨우고, 일하는 중이면 턴이 끝날 때 건넨다. 입력창은 건드리지 않는다. 이전: 입력창에 넣고 제출 / 새: 깨움 훅 / 이유: 사용자 입력을 가로챘다 | 사용자 결정. 일하는 중에 `PostToolUse` 로 끼워 넣는 안은 버렸다 — 프롬프트로 넣는 지금 동작과 같게 턴 사이에만 넣는다 |
| D-AMW-2 | 깨울 때 본문을 엔벨로프째 통째로 건넨다. 여러 개면 온 순서대로 함께 건넨다 | 사용자 결정. 지금 받는 쪽 동작과 같고, 읽기 단계를 새로 두지 않는다 |
| D-AMW-3 | 깨움 훅이 없는 대상(codex · omp · 셸 · otterminal 밖에서 띄운 claude)은 지금처럼 넣고 제출한다 | 사용자 결정. 끼어듦을 확률만 줄이는 "입력이 멈출 때까지 미룸" 은 쓰지 않는다 |
| D-AMW-4 | claude 세션이 끝나면 그 탭의 대기열을 버린다 | 사용자 결정. 종료된 claude 의 입력창에 넣은 글이 사라지는 지금 동작과 같다 |
| D-AMW-5 | 대기열에 메시지가 있으면 턴이 끝나도 `done` 으로 치지 않는다 | 사용자 결정. 보낸 쪽의 `wait --for done` 이 메시지를 처리하기 전에 끝나지 않게 한다 |
| D-AMW-6 | 서버 알림 셋(CONTEXT-ALERT · HANDOFF-REQUEST · 트리 승계)도 같은 길로 보낸다. 명령 입력은 그대로 둔다 | 사용자 결정 |
| D-AMW-7 | 깨움 훅을 `SessionStart` 에도 건다. 막 띄운 claude 에도 붙여넣지 않는다 | 사용자 결정. 실측(§2.3a)에서 턴을 마친 적 없는 세션이 깨었고 입력창의 글이 남았다 |
| D-AMW-8 | `SessionStart` 깨움은 채팅 깨움에도 같이 쓴다 | 사용자 결정. 막 띄운 트리 멤버도 첫 턴 전에 채팅 글로 깬다 |

### 4.1 구현 결정 (2026-11-26, 구현 중에 정함)

| # | 결정 | 근거 |
|---|---|---|
| I-1 | 대기열은 웹 서버(`webserver/httpapi/src/inbox.rs`)의 메모리에 둔다 | `/api/tools/message`·서버 알림·활동 보고가 모두 웹 서버를 지난다(§10 A-1) |
| I-2 | 턴이 열렸는지는 대기열이 활동 보고로 따로 기억한다(`working`·`waiting` → 열림, `done`·`idle` → 닫힘). 훅 대기가 열리기 전의 보고도 기억한다 | 주의 추적기의 상태는 D-AMW-5 로 바꿔 보고하므로 그것을 다시 읽으면 막힌다 |
| I-3 | 훅은 채팅이 먼저 깨우면 `now=1` 요청으로 붙잡힌 메시지 대기를 밀어내고, 그 대기가 받은 것과 `now` 가 받은 것을 모두 싣는다 | 서버가 막 건넨 메시지를 훅이 버리고 끝나는 일을 막는다. 새 종단을 더하지 않는다 |
| I-4 | 활동 보고 없이 사라진 탭의 대기열은 지우지 않는다 | 탭이 닫히면 claude 가 끝나며 `SessionEnd` 가 보고된다. 남는 것은 서버가 다시 뜰 때 사라지는 작은 메모리다 |
| I-5 | `otterctl msg` 의 `pasted` 출력은 이전 그대로 둔다 | 출력을 읽는 기존 절차와 골든을 바꾸지 않는다 |
| I-6 | D-AMW-5 는 활동 보고를 바꿔 넣지 않고, `status`·`wait` 가 상태를 읽는 자리(`tool_status_of`)에서 덧씌운다 | 2026-11-27 격리 실측: 운영 구성에서는 데몬이 상태를 판정하고 서버의 추적기는 그 `done` 을 거울로 받아, 서버가 바꿔 넣은 `working` 이 덮였다. `wait --for done` 이 깨어난 턴 전에 돌아왔다 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 |
|---|---|---|
| TC-AMW-1 | FR-AMW-1~3 | `httpapi` 단위: 훅 대기 있음 → queued, 등록된 claude + working/waiting → queued, 등록된 claude + idle + 훅 대기 없음 → pasted, codex·미등록 → pasted. pasted 는 `send_paste(.., true)` 를 부른다 |
| TC-AMW-2 | FR-AMW-4·12·13 | `httpapi` 단위: 대기열에 둘 넣고 훅 대기 → 둘을 순서대로 한 번에 받음, 다음 훅 대기 → 기다림. 훅 대기 중에 넣음 → 곧바로 받음. 훅 대기 둘 → 앞의 것은 빈 답 |
| TC-AMW-3 | FR-AMW-5·6 | `httpapi` 단위: SessionEnd · 다른 세션 등록 · 탭 닫힘마다 대기열이 비고 기록이 남는다. 기록에 본문이 없다 |
| TC-AMW-4 | FR-AMW-7·8 | `httpapi` 단위 + `runtimebin` 단위: 응답의 `delivery`, `otterctl msg` 출력 |
| TC-AMW-5 | FR-AMW-9 | `httpapi` 단위: 서버 알림 셋은 깨움 대상이면 queued, `/exit`·`--resume`·`send-input` 은 언제나 넣고 제출 |
| TC-AMW-6 | FR-AMW-10·11·14~16 | `runtimebin` `chat-wait` 단위(가짜 서버 + 가짜 데몬 소켓): 채팅 연결 없음 + 메시지 옴 → 2 와 본문, 메시지 둘 → 순서와 빈 줄, 채팅과 메시지 함께 → 채팅 줄 먼저, 서버 연결 끊김 → 0 |
| TC-AMW-13 | FR-AMW-23 | `agentadapter`: 훅 설정의 `SessionStart` 와 `Stop` 에 `asyncRewake` 깨움 훅이 하나씩 있다. 다른 이벤트에는 없다 |
| TC-AMW-14 | FR-AMW-24·25 | `chatsock` 단위: 연결 전에 온 `wait` 는 연결이 생길 때까지 기다리다 깨울 글이 생기면 답한다. 같은 세션의 두 번째 `wait` 가 오면 첫 `wait` 는 빈 답. `httpapi` 단위: 같은 탭의 두 번째 훅 대기에 첫 대기가 빈 답 |
| TC-AMW-15 | 실측 | 진짜 claude 로(shim 경유, 격리 인스턴스): 막 띄운 탭에 ① `otterctl msg` ② 트리 방의 부른 글 → 첫 턴 전에 깬다. 입력창의 글이 남는다 |
| TC-AMW-7 | FR-AMW-17~19 | `httpapi` `status` 단위: 대기열 있음 + done 보고 → working. 비우기 → done 보고 순서와 done 보고 → 비우기 순서 모두 깨어난 턴의 done 전까지 `wait --for done` 이 끝나지 않는다 |
| TC-AMW-8 | FR-AMW-20~22 | 문장 시험: 안내문 · 도움말 · 에이전트 메모리의 새 문장 |
| TC-AMW-9 | NFR-AMW-1·2 | `scripts/perf/scenario.mjs` 유휴 측정: 서버·데몬 깨어남과 외부 프로세스가 M4 기준선과 같다 |
| TC-AMW-10 | 실측 | 진짜 claude 로(격리 인스턴스): ① 쉬는 세션에 msg → 곧바로 깨고 엔벨로프를 지시로 받아 움직인다 ② 일하는 중에 msg → 턴이 끝난 뒤 깨어난다 ③ 두 경우 모두 입력창에 쓰던 글이 남는다 ④ 보낸 쪽 `wait --for done` 이 깨어난 턴이 끝난 뒤 돌아온다 |
| TC-AMW-11 | 실측 | 진짜 claude 로: 훅 출력의 길이 한도. **2026-11-26 통과**(§2.3a, 48,586 B 가 잘리지 않음). Claude Code 를 올릴 때 다시 돈다 |
| TC-AMW-12 | 실측 | 진짜 claude 로: auto mode 에서 깨어난 claude 가 엔벨로프의 지시를 막힘 없이 수행한다 |

TC-AMW-10·12 는 구현 전에 먼저 돈다(쉬는 경우의 깨움과 분류기는 §2.3a 에서 확인했다. 남은 것은 일하는 중의 깨움과 상태 판정이다). 결정을 뒤집을 결과(길이 한도로 본문이 잘림, 분류기가 막음)가 나오면 멈추고 사용자에게 묻는다.

### 5.1 검증 결과 (2026-11-27)

| TC | 결과 |
|---|---|
| TC-AMW-1~8·13·14 | 단위 시험 통과(`httpapi` 13건, `runtimebin` chat-wait 5건·msg 출력, `chatsock` 2건, `agentadapter`). Rust 전체 실패 0, clippy·fmt 깨끗, 게이트 68개 통과, `check-cross.sh` 5대상 통과 |
| TC-AMW-9 | 유휴 측정(`scenario.mjs --only idle,idle-closed`, 1회): 외부 프로세스 0. 서버 CPU 0.1%(페이지 열림)·0%(닫힘). CSW 서버 11.6/1.8 초당, 데몬 7.4/0.6 초당 — M4 기준선과 같은 범위 |
| TC-AMW-10 | 격리 인스턴스(`otterminal-amw`, shim 경유 진짜 claude 2.1.332): `sleep 25` 중에 보낸 메시지가 `queued` 로 들어가 그 턴이 끝난 뒤 깨어 지시대로 답했다. 첫 실측에서 `wait --for done` 이 깨어난 턴 전에 돌아와 I-6 으로 고쳤고, 다시 잰 결과 깨어난 턴의 Stop(…31.029) 뒤(…31.053)에 돌아왔다 |
| TC-AMW-11 | 통과(§2.3a) |
| TC-AMW-12 | auto mode 에서 두 번 모두 엔벨로프의 지시를 수행했다 |
| TC-AMW-15 ① | 막 띄운 claude(턴을 마친 적 없음)에 보낸 메시지가 `queued` 로 들어가 곧바로 깨었다. 입력창의 "사용자가 쓰던 미완성 입력" 이 그대로 남았다 |
| TC-AMW-15 ② | 트리 방 대신 개인채팅으로 했다(개인채팅 글은 언제나 부른 글이다, FR-CAL-3). 막 띄운 claude 가 가짜 에이전트의 글로 첫 턴 전에 깨어 `chat_read` 로 읽었다. 입력창의 글은 남았다. `chatsock` 단위 시험(연결 전 대기)도 통과 |
| e2e | 전량 8샤드: 2,334 통과, 실패 1(`regression-pane-scroll` V-VSR-12), flaky 1. 변경 전 바이너리(`735ca658`)도 같은 파일에서 3건 실패해 이번 변경과 무관하다. I-6 뒤 상태·메시지 관련 e2e(`skill-contract`) 23건 통과 |

## 6. 비목표 (Non-goals)

- 일하는 중에 도구 훅(`PostToolUse`)으로 메시지를 끼워 넣는 일(D-AMW-1)
- 입력창 내용을 읽어 저장하고 되살리는 일
- 사용자의 입력이 멈출 때까지 붙여넣기를 미루는 일(D-AMW-3)
- codex · omp 의 깨움 — 후속 후보(§9)
- 대기열의 디스크 보관과 서버 재시작 뒤 복원
- 명령 입력(`send-input`, `--resume`, `/exit`)의 전달 방식

## 7. 위험 (Risks)

| # | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | `asyncRewake` 가 바뀌거나 없어지면 claude 대상 메시지가 턴이 끝나도 전달되지 않는다 | MEDIUM | TC-AMW-10·11·15 를 Claude Code 를 올릴 때 다시 돈다(TC-ITH-7 과 함께). 쉬는 중이고 훅 대기가 없으면 FR-AMW-1 에 따라 넣고 제출로 돌아가므로 쉬는 탭은 받는다 |
| R-7 | claude 는 깨움 내용을 "Stop hook blocking error" 라는 머리로 받는다. 판이 바뀌면 이 표현이 지시로 읽히지 않을 수 있다 | LOW | 안내문(FR-AMW-20)에 이 모양을 적는다. TC-AMW-10 에서 지시 수행을 본다 |
| R-2 | 훅 출력에 길이 한도가 있으면 긴 인계문이 잘린다 | MEDIUM | TC-AMW-11 을 구현 전에 돈다. 잘리면 멈추고 묻는다 |
| R-3 | 깨어난 claude 가 훅 출력을 사용자 지시보다 약하게 다루거나 auto mode 분류기가 막는다 | MEDIUM | 안내문(FR-AMW-20)과 TC-AMW-12 |
| R-4 | 일하는 중에 보낸 메시지가 긴 턴만큼 늦어진다 | LOW | 사용자가 받아들였다(D-AMW-1). `otterctl msg` 가 `queued` 로 알린다 |
| R-5 | 서버가 다시 뜨면 대기열과 훅 대기가 사라진다 | LOW | §10 A-3·A-4. 지금도 서버가 없으면 msg 는 실패한다 |
| R-6 | 서버의 HTTP 연결 시한이 훅 대기를 끊는다 | MEDIUM | 훅 대기 종단은 시한을 두지 않는다. 구현 때 서버의 유휴 연결 시한을 확인한다(§10 A-5) |

## 8. 다른 SRS 의 개정

| 대상 | 이전 | 새 | 이유 |
|---|---|---|---|
| `ISSUE_TREE_CHAT_SRS` §3.5 첫 문단 | "`msg` 는 받는 탭의 입력에 넣고 곧바로 제출한다" | claude 대상은 깨움 훅으로 전달한다(FR-AMW-1·2) | D-AMW-1 |
| `ISSUE_TREE_CHAT_SRS` FR-CAL-8 | 깨움 훅은 `Stop` 에만 | `SessionStart` 와 `Stop`(FR-AMW-23) | D-AMW-7·8 |
| `ISSUE_TREE_CHAT_SRS` FR-CAL-9 | 채팅 MCP 연결이 없으면 곧바로 0 | 대기열도 기다리고, 연결이 아직 없으면 생길 때까지 기다린다(FR-AMW-10·11·24) | 같은 훅이 둘을 기다린다. 시작 직후에는 연결이 늦다 |
| `BRACKETED_PASTE_SRS` FR-BPW-4·5 | 모든 msg 에 적용 | 깨움 대상이 아닌 msg 와 명령 입력에만 적용 | FR-AMW-3 |

## 9. 후속 후보

- omp 의 훅 모듈로 같은 깨움을 할 수 있는지 실측한다.
- 채팅 깨움(데몬)은 탭의 활동 상태를 모른다. 그래서 일하는 중에 깨울 글이 오면 훅이 턴 도중에 끝나고, §2.3b 처럼 그 알림이 무시된 채 알림 표식만 남을 수 있다. 일하는 중에는 `ctx-hook` 의 개수 알림(FR-PCH-60)이 있어 글을 아주 잃지는 않는다. 이번 범위 밖이다.

## 10. 확인할 가정 (Assumptions)

| # | 가정 | 중요 |
|---|---|---|
| A-1 | 대기열은 웹 서버에 둔다. `/api/tools/message`, 서버 알림, 활동 상태, 세션 등록이 모두 웹 서버에 있어 한곳에서 판정한다 | |
| A-2 | (해소) 새로 띄운 claude 도 `SessionStart` 깨움 훅(FR-AMW-23)으로 훅 대기가 있다. 실측 §2.3a, D-AMW-7 | |
| A-3 | 서버가 다시 뜨면 대기열은 사라진다(NFR-AMW-3) | |
| A-4 | 서버가 다시 뜨면 쉬는 탭의 훅 대기도 끊겨 훅이 0 으로 끝난다. 그 탭은 훅 대기가 없는 쉬는 탭이 되어, 다음 메시지는 넣고 제출로 간다(FR-AMW-1). 그 탭이 턴을 한 번 마치면 다시 깨움으로 돌아간다. 붙여넣기로 돌아가는 경우는 이것 하나다 | **중요** |
| A-5 | 웹 서버는 훅 대기처럼 몇 시간~며칠 열린 HTTP 요청을 끊지 않거나, 이 종단만 시한 없이 둘 수 있다 | |
