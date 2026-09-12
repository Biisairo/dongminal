# SRS: 에이전트를 프로토콜로 붙이고 훅을 걷는다 — IEEE 29148

> **문서 상태**: 초안 — 구현 미착수. 착수 순서상 다른 작업이 앞선다 (사용자 지시 2026-09-12).

| | |
|---|---|
| 접수 | 사용자 (2026-09-12): *"claudecode, codex, omp 등의 에이전트 모든 입출력을 인터셉트해서 다른 ui 로 만드는게 가능할까?"* → *"그걸 이용해서 tui 를 gui 로 승격시키는게 목적"* → *"전면 gui 화 및 훅 및 알람 또한 해당 방법으로 전면 제거"* |
| 방향 결정 | 사용자 (2026-09-12): *"알람을 이용하는방향으로 통일"* · *"타임아웃은 따로 걱정할건없을꺼같고 사용자 책임"* · *"백그라운드에서 부르면 다시 지금까지의 대화내용대로 알아서 ui 를 살려주는 방향"* |
| 성격 | **요구사항 개정을 동반한다.** `AGENT_EVENT_ABSTRACTION_SRS` 의 `Signals`·`HookParse` 계약을 폐기하고, `ATTENTION_FIRING_SRS` 의 발화 조건 중 훅에 의존하는 절반을 교체한다 |

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

에이전트를 **터미널 화면이 아니라 프로토콜로** 붙인다. 그 결과로 두 가지를
얻는다 — 에이전트를 GUI 로 그릴 수 있게 되고, 알람이 추정에서 사실로 바뀐다.

지금 dongminal 은 에이전트를 PTY 바이트스트림으로만 안다. 그래서 "지금 무엇을
하는가" 를 알려면 에이전트가 **자기 훅으로 밖에 알려 주기로 한 것**에 의존해야
했고, 그 표면이 좁아서 구멍이 났다 (§2.2). 구멍을 메우려고 쌓은 것이 추정
장치들이다 — L2 idle 무장·재무장, `waiting` 판정, 사용자 턴 휴리스틱.

세 에이전트 모두 **다른 UI 를 붙이라고 만든 전용 인터페이스**를 이미 갖고 있다
(§2.3). 그쪽으로 옮기면 추정 장치가 통째로 필요 없어진다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 이름 | 접두어 |
|---|---|---|
| **묶음 P** | 프로토콜 표면 (Protocol) | `FR-APS` |
| **묶음 T** | 에이전트 도구 (Tool) | `FR-AGT` |
| **묶음 A** | 알람 통일 (Alarm) | `FR-AAL` |
| **묶음 H** | 훅 제거 (Hook removal) | `FR-AHR` |
| **묶음 B** | 백그라운드·휴면·복원 (Background) | `FR-ABG` |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 말 | 뜻 |
|---|---|
| **표면(surface)** | 에이전트가 자기 상태를 밖에 내보내는 통로. **프로토콜 표면**과 **터미널 표면** 둘뿐이다 |
| **프로토콜 표면** | 에이전트의 구조화 인터페이스. claude `stream-json`, codex `app-server`, omp `--mode rpc-ui` |
| **터미널 표면** | 사용자가 도구의 셸에 직접 친 에이전트. PTY 바이트스트림 말고는 아무것도 없다 |
| **에이전트 도구** | PTY 가 없고 프로토콜 프레임만 오가는 새 도구 종류 (묶음 T) |
| **프레임** | 프로토콜이 한 번에 주고받는 한 덩어리. JSONL 한 줄 또는 JSON-RPC 메시지 하나 |
| **이벤트 로그** | 한 에이전트 세션이 낸 프레임을 시각 순으로 쌓은 append-only 기록 (묶음 B) |
| **승인 요청** | 에이전트가 사용자의 결정을 **기다리며 멈추는** 역방향 요청. 통지가 아니라 요청이다 |
| **알람(attention)** | 도구가 사용자를 부르는 상태. `Tool.attention` / `AttnTracker.attention` — **이 문서가 이 정의를 바꾸지 않는다** |
| **휴면(dormant)** | 프로세스는 없고 세션 신원만 남은 상태. 열면 재개된다 (`FR-ABG-10`) |

### 1.4 참조 (References)

- `docs/internal/AGENT_EVENT_ABSTRACTION_SRS.md` — `FR-AEV-1~5`(이벤트 선언),
  `FR-AEV-10~12`(알람을 활동에서 파생), §2.5 능력 실측표. **이 문서가 폐기한다**
- `docs/internal/AGENT_ADAPTER_COMPLETION_SRS.md` — `FR-AAC-1`(InstallAssets) ·
  `FR-AAC-10~14`(ParseUsage) · `FR-AAC-20`(ContextWindow) · `FR-AAC-31`(ActivityFromNotify)
- `docs/internal/ATTENTION_FIRING_SRS.md` — `FR-ATN-1~16`·`FR-ATF-1~13`.
  **발화 판정의 골격은 남고 신호원이 바뀐다** (§3.3)
- `docs/internal/ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS.md` — 알람의 수명
- `docs/internal/OMP_AGENT_SUPPORT_SRS.md` — `FR-OMP-7·8`(관측되지 않는 것을
  지어내지 않는다) · §2.4(omp 승인 게이트가 훅에 통지되지 않는다는 실측)
- `docs/internal/RUN_ORCHESTRATION_SRS.md` — `FR-ADP-1~6`(선언 테이블) ·
  `FR-RUN-11a`(정중한 종료)
- `docs/internal/ORCHESTRATION_V2_SRS.md` — `FR-CBG-1`·`FR-CBG-5`
  **"모른다 ≠ 괜찮다"**
- `docs/internal/UX_BATCH6_SRS.md` — `FR-BGP-2`(백그라운드 SSE) ·
  `FR-CTX-1·4~7`(컨텍스트 창)
- 외부: [Codex App Server](https://learn.chatgpt.com/docs/app-server) ·
  [Agent Client Protocol](https://agentclientprotocol.com) ·
  [oh-my-pi](https://github.com/can1357/oh-my-pi) README §"Four entry points"

---

## 2. 현재 상태 (조사로 확정한 사실, 2026-09-12)

### 2.1 알람의 생산이 네 갈래다

| 층 | 신호원 | 코드 |
|---|---|---|
| L1 | OSC 알림 시퀀스 | `toolhub/attention.go` |
| L1 | `dmctl notify <reason>` | `helper/runtimebin/dmctl_notify.go` |
| L2 | 에이전트 훅의 활동 보고 → `done`·`waiting` 에서 파생 | `agentadapter.HookParse` → `dmctl activity` → `AttnTracker.SignalAgentEvent` |
| L2 | idle 추정 (무장·재무장·stale) | `toolhub/tool.go:maybeIdle`, `hub/attn_tracker.go:sweepIdle` |

넷 중 셋이 에이전트를 위한 것이고, 그 셋이 서로를 전제한다. `FR-ATN-6` 의
`waiting` 판정이 `FR-ATN-7` 의 진행 표시에 기대고, 그 표시는 훅의 `working`
보고가 세운다. 한 갈래를 걷어내면 나머지 둘의 전제가 무너진다.

### 2.2 훅 표면의 해상도는 에이전트마다 다르고, 구멍이 실재한다

`AGENT_EVENT_ABSTRACTION_SRS` §2.5 의 실측표 그대로다.

| 신호 | claude | omp | codex |
|---|---|---|---|
| `idle` | ✅ `SessionStart` | ✅ `session_start` | ❌ |
| `working` | ✅ 다섯 훅 | ✅ `turn_*`·`tool_*` | ❌ |
| **`waiting`** | ✅ `Notification` | **❌ 승인 게이트가 훅에 통지되지 않는다** | ❌ |
| `done` | ✅ `Stop` | ✅ `agent_end` | ✅ `agent-turn-complete` |
| `ended` | ✅ `SessionEnd` | ✅ `session_shutdown` | ❌ |
| 사용자 턴 | ✅ `UserPromptSubmit` | ✅ `agent_start` | ❌ |
| 압축 | ✅ `PreCompact` | ✅ | ❌ |
| tool/detail | ✅ | ✅ | ❌ |
| 세션 신원 | ✅ | ✅ | ❌ |

**codex 는 사실상 침묵한다** — `Signals{Done: true}` 하나다. 그래서
`ActivityFromNotify` 라는 특례가 생겼다 (`FR-AAC-31`).

그리고 훅 표면이 낼 수 없는 것을 메우려고 두 개의 자백이 코드에 적혀 있다:

- `FR-ATN-3a` — *"**휴리스틱임을 인정한다** — 훅 payload 에 출처 필드가 없어
  본문이 유일한 근거다"*. 프롬프트가 `<task-notification>`·`<system-reminder>`
  로 시작하는지로 사람 턴과 배경 턴을 가른다
- `Readiness.ScreenPatterns` — 선언은 있으나 **비워 둔 것이 의도다**.
  *"화면 패턴은 사용자가 하단 스테이터스라인 하나만 붙여도 깨진다"*

### 2.3 세 에이전트 모두 프로토콜 표면을 갖고 있다

| 에이전트 | 진입 | 전송 | 승인 위임 | 확인 방법 |
|---|---|---|---|---|
| claude | `--print --output-format stream-json --input-format stream-json --include-partial-messages` | stdio JSONL, 양방향 | `--permission-prompts host` + `--permission-prompt-tool` | **직접 실행 검증** (§2.4) |
| codex | `codex app-server` | stdio JSONL / ws / unix | 서버→클라 역방향 JSON-RPC request. `accept`·`acceptForSession`·`decline`·`cancel` | 공식 문서 |
| omp | `omp --mode rpc-ui` | stdio NDJSON | `extension_ui_request` 프레임을 호스트가 답한다 | README §"Four entry points" |

**omp 의 `--mode rpc-ui` 가 이 문서의 목적에 가장 정확히 맞는다.** README 가
*"adds tool cards, selectors, and dialogs as `extension_ui_request` frames the
host must answer"* 라고 적는다 — TUI 가 그리던 위젯을 그리지 않고 호스트에
넘기는 것이 프로토콜 차원의 설계다.

**§2.2 의 omp `waiting` ❌ 는 훅 표면 한정의 사실이다.** `--mode rpc-ui` 와
`omp acp`(`session/request_permission`) 에는 그 신호가 있다. `ompAdapter` 의
주석 *"omp 에 그 이벤트가 생기면 이 한 줄이 참이 된다"* 가 가리키던 자리가
이쪽이며, 생긴 것이 아니라 **처음부터 다른 표면에 있었다**.

codex 는 세 에이전트 중 **가장 크게 올라간다** — `thread/started`,
`turn/started`·`turn/completed`·`turn/plan/updated`, `item/started`·
`item/completed` 와 델타, `thread/resume`·`thread/fork`, `turn/steer`(진행 중
개입) 가 전부 들어온다. §2.2 에서 유일하게 ✅ 하나였던 자리다.

### 2.4 claude stream-json 실측 (claude 2.1.269, 2026-09-12)

실제로 실행해 프레임을 받았다. 훅 표면이 내지 못하던 것이 여기 있다:

| 프레임 | 싣는 것 |
|---|---|
| `system:init` | `session_id`, 도구 목록, 슬래시 명령, MCP 서버 상태, 에이전트·스킬·플러그인 목록, `permissionMode`, `cwd`, 모델 |
| `stream_event` | `message_start`·`content_block_delta`(`thinking_delta`/`text_delta`)·`content_block_stop`·`message_delta`·`message_stop` |
| `system:thinking_tokens` | 추론 토큰의 증분 |
| `assistant` | 누적된 메시지 스냅샷 (`thinking` 서명 포함) |
| `system:hook_started`·`hook_progress`·`hook_response` | **훅의 실행 자체가 프레임으로 나온다** |
| `rate_limit_event` | `five_hour`·`seven_day` 소진율과 리셋 시각 |
| `result` | `total_cost_usd`, `modelUsage`(모델별 토큰·비용·`contextWindow`), `permission_denials`, `subagent_stats`, `num_turns`, `duration_ms`, `ttft_ms` |

**컨텍스트 창과 사용량이 프레임에 직접 실린다.** 지금 `ParseUsage` 가 전사본
파일을 뒤에서부터 훑어 얻는 값(`FR-AAC-10~13`)과 `ContextWindow` 가 모델
이름으로 추측하는 값(`FR-AAC-20`)이 `result.modelUsage` 한 자리에 있다.

### 2.5 전경 프로세스 이름은 이미 있다

`hub/foreground.go` 가 2 초 주기(`ForegroundInterval`)로 전경 프로그램 이름을
조회해 SSE `tool_foreground` 로 뿌린다. 어댑터에는 `DetectCmd`(`claude`·`omp`·
`codex`)가 이미 있다.

그러므로 **훅 없이도 "이 도구에서 에이전트가 돌고 있다" 를 판정할 수 있다.**
이것은 `Readiness.ScreenPatterns` 가 피한 화면 패턴 휴리스틱이 아니다 —
프로세스 이름은 스테이터스라인을 붙여도 바뀌지 않는다.

### 2.6 백그라운드는 이미 1급 개념이다

- `toolhub.ToolHub.SetBackground(id, bg)` — *"detaches tool id from its tab"*
- `POST /api/runs/detach` — *"탭은 닫히고 도구는 산다"*
- `GET /api/tools/background` · SSE `tools_background_changed` (`FR-BGP-2`)
- `NewDetachedTool` — PTY 없는 합성 `Tool` 이 이미 존재한다 (`term` 이 nil)

**PTY 없는 도구를 다루는 자리가 이미 코드에 있다.** 묶음 T 는 그것을 테스트
헬퍼에서 실제 종류로 올리는 일이다.

### 2.7 훅에 묶인 자리의 목록

삭제·개정의 대상을 미리 특정한다. 착수 시 이 목록으로 대조한다.

| 자리 | 지금 하는 일 |
|---|---|
| `agentadapter.Adapter.HookParse` | 훅 stdin JSON → `Report` |
| `agentadapter.Signals` (9 필드) | 그 에이전트가 낼 수 있는 신호의 선언 |
| `agentadapter.Readiness.Hooks` · `.ScreenPatterns` | 준비완료 판정 |
| `agentadapter.ActivityFromNotify` | codex 특례 |
| `agentadapter.InstallAssets` · `claude_install.go` · `omp_install.go` · `install.go` | 훅·shim 자산 배포 |
| `agentadapter.ParseUsage` · `ContextWindow` | 전사본·모델명에서 사용량 추정 |
| `parseCodexHook` · `parseOmpHook` · claude 훅 파서 | 위 `HookParse` 의 구현 |
| `helper/runtimebin/dmctl_activity.go` (+5 테스트) | 훅에서 활동 보고 |
| `helper/runtimebin/agenthooks.go` | 훅 자산 디렉터리 |
| `shared/runtime/install.go`·`install_omp.go` | 훅 설치 분기 |
| `toolhub/agentturn.go` · `Tool.turn` | 턴 상태 추적 (`FR-ATN-1·7`) |
| `Tool.agentSeen` | "에이전트가 돌고 있다" — 활동 보고가 세운다 |
| `AttnTracker.SignalAgentEvent` · `NoteUserPrompt` · `SetActivity` | 활동 보고의 수신단 |

**`dmctl notify` 는 이 목록에 없다.** 그것은 에이전트 아닌 것들의 몫이며
`FR-ATF-4`(*"명시적 신호는 누가 보냈든 알람이다"*)가 이미 그렇게 선을 그었다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 P — 프로토콜 표면

**FR-APS-1** `Adapter` 는 **프로토콜 기동**을 선언한다. 기존 `Launch`(TUI 기동)
와 나란한 자리이며, 서로를 대체하지 않는다 — 터미널 표면은 여전히 존재한다
(`FR-AAL-20`).

**FR-APS-2** 어댑터는 프레임을 **공통 이벤트**로 옮긴다. 공통 이벤트의 어휘는
`Report` 의 후신이며, 활동 상태(`idle`·`working`·`waiting`·`done`·`ended`)를
**한 글자도 바꾸지 않는다.** 활동 패널의 동작이 이 변경으로 달라지면 안 된다
(`FR-CBG-1`·`FR-AEV-2` 의 선례를 따른다).

**FR-APS-3** 공통 이벤트는 §2.4 에서 실측한 것을 담을 수 있어야 한다. 최소로:
세션 신원 · 턴 경계 · 도구 호출과 결과 · 텍스트/추론 델타 · 승인 요청 ·
사용량과 컨텍스트 창 · 종료 사유.

**FR-APS-4** **어댑터가 내지 못하는 이벤트는 빈 값이 아니라 부재다.** `FR-CBG-5`
그대로다 — 모른다와 괜찮다는 다르다. 다만 `Signals` 같은 **선언 테이블은 두지
않는다** (D-3).

**FR-APS-5** 승인 요청은 **요청-응답**으로 모델링한다. 통지가 아니다. 응답이
갈 때까지 그 요청은 열려 있고, 서버는 열린 요청의 목록을 도구마다 갖는다.

**FR-APS-6** 열린 승인 요청에 서버가 **대신 답하지 않는다.** 사용자의 결정이기
때문이다. 브라우저가 없으면 요청은 큐에 남고 알람이 선다 (`FR-AAL-3`).

**FR-APS-7** 프로토콜 스키마의 변화는 **어댑터 한 자리에서** 흡수한다. 상위
층은 공통 이벤트만 안다. codex app-server 가 experimental 인 것(R-1)을 감당하는
자리가 여기다.

**FR-APS-8** 프레임 해석 실패는 **조용히 삼키지 않는다.** 알 수 없는 프레임은
이벤트 로그에 원문으로 남기고(`FR-ABG-2`) 상위에 부재로 보고한다. 지금 훅
파서가 `return Report{}, false` 로 버리던 자리와 다르다 — 그때는 버릴 수밖에
없었지만(훅은 비0 로 끝날 수 없다, `NFR-AAP-5`) 프로토콜은 그 제약이 없다.

### 3.2 묶음 T — 에이전트 도구

**FR-AGT-1** **에이전트 도구는 터미널 도구와 나란한 도구 종류다.** 창·분할
칸·탭의 배치, 영속, 복원, 포커스, 백그라운드는 **그대로 재사용한다.** 새 배치
기계를 만들지 않는다.

**FR-AGT-2** 에이전트 도구는 **PTY 가 없다.** 리사이즈·bracketed paste·
스크롤백·OSC 해석이 성립하지 않는다. 그 경로들은 호출되면 **오류가 아니라
무동작**이어야 한다 — `NewDetachedTool` 의 `term == nil` 계약이 이미 그 모양이며
(*"모든 접근이 nil 을 견뎌야 한다"*), 이 문서는 그 계약을 종류로 승격시킨다.

**FR-AGT-3** 에이전트 프로세스의 소유는 **터미널 도구의 셸과 같은 자리**다.
직접 모드는 서버가, 데몬 모드는 `dongminald` 가 든다. 파이프(stdin/stdout/stderr)
가 PTY 를 대신할 뿐 소유 구조는 바뀌지 않는다.

**FR-AGT-4** UI 는 **최소한** 다음을 그린다: 대화(사용자/에이전트 메시지) ·
도구 호출과 결과 · 진행 중 델타 · 승인 다이얼로그 · 활동 상태 · 사용량/컨텍스트
창 · 비용.

**FR-AGT-5** 승인 다이얼로그는 프로토콜이 준 선택지를 **그대로** 낸다. codex 의
`acceptForSession` 처럼 에이전트마다 다른 선택지를 우리가 접거나 늘리지 않는다.

**FR-AGT-6** 에이전트 도구는 **전사본 파일을 읽지 않는다.** 사용량·컨텍스트 창은
프레임에서 온다 (§2.4). `NFR-4`(내용을 서버로 보내지 않는다)는 그대로 지켜지며,
오히려 파일을 열지 않으므로 더 강해진다.

**FR-AGT-7** 터미널 도구와 에이전트 도구가 한 창에 섞여 있을 수 있다. 도구
종류를 묻지 않는 코드(배치·포커스·이름·닫기)는 그대로 동작해야 한다.

### 3.3 묶음 A — 알람 통일

> **판정 이후는 한 줄도 바뀌지 않는다.** `Tool.attention` 은 "부른다" 는 비트
> 하나이며 누가 세웠는지 모른다. 표시·펄스·해제·모바일 푸시는 그대로다.

**FR-AAL-1** 알람의 생산은 **두 갈래**로 준다.

| 층 | 신호원 |
|---|---|
| **L1 명시 신호** | 프로토콜의 `done`·승인 요청, OSC 시퀀스, `dmctl notify` |
| **L2 idle 추정** | 프로토콜이 없는 에이전트 도구 |

**FR-AAL-2** 프로토콜 표면의 `done` 은 **추정을 거치지 않고** 알람 판정에
들어간다. `FR-ATN-4`(표시가 서 있을 때만)의 판정은 남되, 그 표시를 세우는 것이
훅의 `UserPromptSubmit` 이 아니라 **우리가 보낸 입력**이다 (`FR-AAL-10`).

**FR-AAL-3** **승인 요청이 열리면 알람이 선다.** 이것이 `waiting` 의 새 정의이며
추론이 아니다 — 요청이 열려 있다는 것이 곧 에이전트가 멈춰 있다는 뜻이다.

**FR-AAL-4** 알람의 내용(`Detail`)은 승인 요청의 payload 에서 온다 — 어떤 명령을
실행하려 하는가, 어떤 파일을 어떻게 바꾸려 하는가. `FR-AEV-15`(알람에도 내용이
실린다)의 뜻이 여기서 온전해진다. shim 이 내용을 짜낼 필요가 없다.

**FR-AAL-10** **사용자 턴 판정을 삭제한다.** 프로토콜 표면에서는 입력을 넣은
주체가 우리이므로, 사람이 친 것인지 배경이 깨운 것인지 **판정할 필요가 없다.**
`FR-ATN-3a` 의 본문 접두사 휴리스틱과 그 자백이 함께 사라진다.

**FR-AAL-11** **`waiting` 추론을 삭제한다.** `FR-ATN-6`(턴이 진행 중일 때만
`waiting` 이 알람) · `FR-ATN-7`(진행 표시) · `FR-ATN-8`(순환 방지)이 풀려는
문제가 존재하지 않게 된다.

**FR-AAL-12** **`AgentTurn` 을 삭제한다.** 턴의 경계는 프로토콜이 말한다.

**FR-AAL-20** **터미널 표면의 알람은 L2 idle 하나다.** 사용자가 도구의 셸에
직접 친 에이전트는 활동 패널도 컨텍스트 관측도 갖지 않는다 (D-1 의 대가).

**FR-AAL-21** L2 idle 의 대상 판정을 바꾼다. `FR-ATF-1` 의 *"활동을 보고한 적이
있고 아직 `ended` 를 보내지 않은 도구"* 를 **"전경 프로세스가 등록된 에이전트
실행파일인 도구"** 로 대체한다 (§2.5). `Tool.agentSeen` 은 활동 보고가 아니라
전경 이름 갱신이 세운다.

**FR-AAL-22** `FR-ATF-3`(전경 프로세스 검사는 그대로 남는다)은 **흡수된다** —
`FR-AAL-21` 이 그것과 같은 검사이기 때문이다. 두 개의 검사를 겹쳐 두지 않는다.

**FR-AAL-23** `FR-ATF-5~9`(주목이 재무장을 잠근다)와 `FR-ATF-10`(stale `working`
은 억제하지 않는다)은 **남는다.** 그것들은 훅의 성질이 아니라 idle 추정의
성질이고, 터미널 표면에 idle 추정이 남는 한 함께 남는다.

**FR-AAL-24** `FR-ATF-12`(직접 모드와 데몬 모드에서 같게 동작한다)는 그대로
적용된다. 프로토콜 표면도 두 모드에서 같아야 한다.

**FR-AAL-30** **에이전트 도구는 L2 idle 의 대상이 아니다.** 프로토콜이 턴의
시작과 끝을 명시하므로 추정할 것이 없다. 프로토콜이 끊기면 그것은 idle 이
아니라 **오류**다 (`FR-ABG-20`).

### 3.4 묶음 H — 훅 제거

**FR-AHR-1** §2.7 의 목록을 **삭제한다.** 남기는 것은 `dmctl notify` 와
`toolhub/attention.go` 의 OSC 감지뿐이다.

**FR-AHR-2** `AGENT_EVENT_ABSTRACTION_SRS` 의 `FR-AEV-1~5`·`10~12`·`15` 와
`AGENT_ADAPTER_COMPLETION_SRS` 의 `FR-AAC-1`·`10~14`·`20`·`31` 을 **폐기한다.**
폐기는 그 문서에 명시로 적는다 — 지우지 않는다.

**FR-AHR-3** **에이전트 이름이 등록부 밖에 나오면 안 된다**는 지시(`U-27`,
2026-09-11)는 그대로 유효하다. 프로토콜 어댑터도 같은 규약을 진다.

**FR-AHR-4** 훅 자산을 이미 설치한 사용자의 홈에서 그것을 **걷어낸다.** 남은
shim 이 없어진 `dmctl activity` 를 부르면 조용히 실패하지만, 조용한 실패를
남겨 두지 않는다.

**FR-AHR-5** **오케스트레이션의 기동 경로가 함께 바뀐다.** `LaunchLine`·
`MemberArgs`·`PolicyInjection`·`ArgvSeparator`·`PromptInjection`·`ExitCommand`
는 *"도구의 셸에 그대로 타이핑할"* 것을 만드는 자리다. Run 멤버가 에이전트
도구가 되면 타이핑할 셸이 없다. **이 문서는 그 전환의 범위를 정하지 않는다** —
§6 비목표이며 후속 문서의 몫이다. 다만 훅 제거가 그쪽을 건드린다는 사실은
여기 적는다.

### 3.5 묶음 B — 백그라운드·휴면·복원

**FR-ABG-1** 에이전트 도구의 백그라운드는 **기존 경로를 쓴다** — `SetBackground`,
`/api/runs/detach`, `/api/tools/background`, SSE `tools_background_changed`.
새 기계를 만들지 않는다 (§2.6).

**FR-ABG-2** 서버는 세션마다 **이벤트 로그**를 append-only 로 쌓는다. 해석하지
못한 프레임도 원문으로 남긴다 (`FR-APS-8`).

**FR-ABG-3** **브라우저 연결은 순수 뷰다.** 브라우저가 없어도 에이전트는
진행하고 로그는 쌓인다. 백그라운드가 예외 상태가 아니라 기본 상태다.

**FR-ABG-4** 탭을 다시 열면 **이벤트 로그를 재생해 UI 를 복원한다** (사용자
결정 2026-09-12). 재접속이 "이어 붙이기냐 다시 뿌리기냐" 로 갈리던 터미널
도구의 문제(`fix(term)` 커밋 `327e785`)가 여기서는 생기지 않는다 — 화면이
아니라 이벤트이므로 **어디까지 보았는가** 하나만 기억하면 된다.

**FR-ABG-5** 복원된 UI 는 **열린 승인 요청을 그대로 보여준다.** 백그라운드에서
알람이 울린 이유가 그것이면, 열었을 때 답할 것이 그 자리에 있어야 한다.

**FR-ABG-10** **휴면 상태를 둔다.** 프로세스는 없고 세션 신원만 남으며, 열면
재개된다 (claude `--resume`, codex `thread/resume`, omp 세션). 터미널 도구에는
없는 상태다 — 셸을 죽이면 그것으로 끝이기 때문이다.

| 상태 | 프로세스 | 탭 | 재개 |
|---|---|---|---|
| 활성 | ○ | ○ | — |
| 백그라운드 | ○ | ✕ | 탭 복귀 |
| **휴면** | **✕** | ✕ | **세션 재개** |

**FR-ABG-11** 휴면 전환은 **명시적이어야 한다.** 자동 휴면(유휴 시간 경과 등)은
이 문서의 범위가 아니다 (§6).

**FR-ABG-20** 프로토콜 연결이 끊기거나 프로세스가 죽으면 **오류 상태**다. idle
로 읽지 않는다 (`FR-AAL-30`). 사용자에게 보이고, 이벤트 로그에 남고, 재개가
가능하면 그 길을 제시한다.

### 3.6 비기능 (NFR)

**NFR-1** 프레임의 **내용을 서버 밖으로 내보내지 않는다.** `NFR-4` 의 규약을
잇는다. 이벤트 로그는 이 인스턴스의 디스크에만 있다.

**NFR-2** 이벤트 로그는 **무한히 자라지 않는다.** 상한과 잘라내기 규칙을 둔다.
값은 구현 시 정한다.

**NFR-3** 프레임 처리는 **에이전트를 막지 않는다.** 우리 쪽 처리 지연이 에이전트의
진행을 늦추면 안 된다.

**NFR-4** 승인 응답의 왕복은 사용자가 답한 순간부터 **한 번의 프레임**이다.
중간 계층이 재확인을 끼워 넣지 않는다.

---

## 4. 결정 (Decisions)

**D-1 — 터미널 표면의 강등을 받아들인다.** (사용자 결정: *"알람을 이용하는
방향으로 통일"*)

직접 TUI 세션은 활동 패널과 컨텍스트 관측을 잃고 알람 해상도가 idle 하나로
내려간다. 대안은 훅을 축소해 남기는 것이었으나, 예외 경로를 위해 두 벌의 신호
체계와 두 벌의 테스트를 유지하는 비용이 얻는 것보다 크다고 판단했다.

**D-2 — codex app-server 를 채택한다.**

D-1 이 codex 의 `notify` 배선도 지우므로, app-server 를 쓰지 않으면 codex 는
완전히 침묵한다. 채택이 강제된다. experimental 딱지는 R-1 로 관리한다.

**D-3 — `Signals` 같은 선언 테이블을 다시 만들지 않는다.**

`FR-AEV-3` 이 아홉 항목을 미리 선언하게 한 이유는 훅 표면의 능력이 에이전트마다
크게 달랐기 때문이다(§2.2). 프로토콜 표면은 셋 다 같은 급이라 그 문제가 없다.
선언 테이블은 **차이가 클 때만** 값을 한다. 없는 이벤트는 `FR-APS-4` 의 부재로
표현한다.

**D-4 — GUI 는 새 도구 타입이다.** (사용자 선택 2026-09-12)

기존 터미널 도구에 뷰를 토글하는 안은 PTY 없는 세션에 PTY 도구의 껍데기를
씌우게 되어 빈 개념이 남는다. 별도 창 개념은 배치·저장·복원 기계를 한 벌 더
만들게 된다.

**D-5 — 승인 요청의 타임아웃을 다루지 않는다.** (사용자 결정: *"타임아웃은 따로
걱정할건없을꺼같고 사용자 책임"*)

열린 요청이 에이전트 쪽에서 만료되면 그 턴은 거부/실패로 끝난다. 우리는 알람을
세워 알릴 뿐이며 대신 답하지 않는다 (`FR-APS-6`).

**D-6 — L1(OSC·`dmctl notify`)은 남긴다.**

에이전트 아닌 것들(빌드·테스트·사용자 스크립트)의 몫이고 프로토콜과 무관하다.
`FR-ATF-4` 가 이미 *"명시적 신호는 누가 보냈든 알람이다"* 로 선을 그었다.

---

## 5. 가정 (Assumptions)

**AS-1** 세 프로토콜 모두 **한 프로세스가 한 세션**을 든다. 한 프로세스에 여러
세션을 다중화하는 모델은 가정하지 않는다. (codex 의 thread 모델은 여러 thread 를
허용하는 것으로 보이나, 확인하지 않았다 — §9)

**AS-2** 프로토콜 표면에서도 세션 신원이 디스크에 남아 **재개가 가능하다.**
claude `--resume`, codex `thread/resume` 는 문서·플래그로 확인했고, omp 는
세션 개념이 있다는 것까지만 확인했다.

**AS-3** 사용자는 dongminal 안에서 에이전트를 **주로 GUI 로** 쓴다. 터미널
표면은 예외 경로다. D-1 이 이 가정 위에 선다.

**AS-4** 프레임의 양은 이벤트 로그로 감당 가능하다. §2.4 의 실측에서 1+1 질문
한 번에 약 20 프레임이 나왔다.

---

## 6. 비목표 (Non-goals)

- **TUI 의 재구현.** 에이전트가 그리던 터미널 화면을 우리가 다시 그리지 않는다.
- **오케스트레이션(Run)의 전환.** `LaunchLine`·`MemberArgs` 계열이 이 변경에
  영향받는다는 사실만 적는다 (`FR-AHR-5`). 범위는 후속 문서가 정한다.
- **ACP 채택.** 세 에이전트 모두 네이티브 표면이 더 풍부하다. ACP 는 에디터용
  최소공배수라 §2.4 의 rate limit·누적 비용·추론 델타·서브에이전트 통계가
  통과하지 못한다. **네 번째 에이전트를 붙일 때의 폴백 후보로만 둔다.**
- **자동 휴면.** 유휴 시간 경과에 따른 자동 전환은 다루지 않는다 (`FR-ABG-11`).
- **`dmctl notify`·OSC 감지의 개정.** D-6 대로 그대로 둔다.
- **터미널 표면의 해상도 회복.** D-1 이 포기한 것을 다른 수단으로 되찾지 않는다.
- **승인 타임아웃 처리.** D-5.

---

## 7. 리스크 (Risks)

**R-1 — codex app-server 는 공식 문서가 experimental·프로덕션 미지원이라고
명시한다.** 스키마가 예고 없이 움직일 수 있다. 완화: `FR-APS-7`(어댑터 한 자리
흡수) + 대조 테스트. 잔여 위험은 받아들인다 (D-2).

**R-2 — claude stream-json 의 프레임 스키마는 공개 계약이 아니다.** §2.4 는
2.1.269 의 실측이다. 완화: R-1 과 같다.

**R-3 — 삭제 범위가 넓다.** §2.7 의 목록이 13 자리이고 테스트가 그에 딸린다.
한 번에 걷으면 회귀를 어디서 잡았는지 말할 수 없다. 완화: 묶음 순서를
P → T → A → B → H 로 둔다. **훅 제거를 마지막에 한다** — 그전까지는 두 표면이
공존하며, 그동안의 중복 발화는 `FR-AAL-1` 의 L1 우선으로 막는다.

**R-4 — 에이전트 도구가 도구 모델의 첫 비-PTY 종류다.** 도구를 다루는 코드가
PTY 를 전제하는 자리가 남아 있으면 거기서 깨진다. 완화: `NewDetachedTool` 이
이미 그 경로를 지나고 있으므로(§2.6) 기존 테스트가 일부를 덮는다.

**R-5 — omp `--mode rpc-ui` 의 프레임 형식을 실측하지 않았다.** README 의 서술만
근거다. omp 는 릴리스가 잦다. 완화: 착수 시 실측이 선행 조건이다 (§9).

**R-6 — 터미널 표면 강등이 사용자 기대를 어긋날 수 있다.** dongminal 을 쓰는
이유 중 하나가 여러 탭의 에이전트 감시다. 완화: 강등되어도 **알람은 울린다**
(`FR-AAL-20`·`21`). 잃는 것은 활동 패널과 컨텍스트 관측이다.

---

## 8. 검증 (Verification)

**V-1** 세 어댑터 각각에 대해, 실제 프로세스를 프로토콜 모드로 띄우고 한 턴을
돌려 §3.1 의 공통 이벤트가 나오는지 본다. 녹화된 프레임 픽스처가 아니라 **실행**
이다 — 스키마 드리프트를 잡는 것이 목적이므로.

**V-2** 승인 요청이 열린 채 브라우저를 끊고, 알람이 서고, 다시 붙었을 때 그
요청이 UI 에 있고, 답이 에이전트에 도달하는지 본다 (`FR-APS-5·6`, `FR-AAL-3`,
`FR-ABG-5`).

**V-3** 백그라운드에서 진행된 턴이 탭을 다시 열었을 때 **빠짐없이** 재생되는지
본다 (`FR-ABG-4`).

**V-4** 터미널 도구의 셸에서 `claude` 를 직접 띄우고, 훅이 없는 상태에서 L2 idle
알람이 서는지 본다 (`FR-AAL-21`). 그리고 활동 패널이 **비어 있음을 확인한다** —
D-1 이 포기한 것이 실제로 포기되었는지가 검증 대상이다.

**V-5** 에이전트 도구에 대해 리사이즈·bracketed paste·스크롤백 경로를 호출해
**오류가 아니라 무동작**임을 본다 (`FR-AGT-2`).

**V-6** 터미널 도구와 에이전트 도구를 한 창에 섞어 두고 배치·영속·복원·포커스·
이름·닫기가 동작하는지 본다 (`FR-AGT-7`).

**V-7** §2.7 의 목록이 저장소에서 사라졌는지 `grep` 으로 대조한다. 폐기 표시가
참조 문서에 적혔는지 함께 본다 (`FR-AHR-2`).

**V-8** 프로토콜 연결을 강제로 끊고 오류 상태가 되는지, idle 로 읽히지 않는지
본다 (`FR-ABG-20`).

**V-9** 직접 모드와 데몬 모드에서 V-1~V-3 이 같게 동작하는지 본다
(`FR-AAL-24`).

---

## 9. 미확인 사실 (착수 전 실측 대상)

**추측해 채우지 않는다.** 아래는 이 문서를 쓰는 시점에 확인하지 못한 것이며,
구현 착수 전에 실측으로 메운다. `codexAdapter` 가 *"확인하지 못한 값은 추측해
채우지 않고 비워 둔다 — 틀린 플래그는 기동 자체를 깨뜨리므로 없는 것보다
나쁘다"* 고 적은 것과 같은 규약이다.

| # | 확인할 것 |
|---|---|
| U-1 | omp `--mode rpc-ui` 의 실제 프레임 형식과 `extension_ui_request` 의 payload (R-5) |
| U-2 | codex app-server 의 한 프로세스가 여러 thread 를 드는가 (AS-1) |
| U-3 | claude `--permission-prompt-tool` 이 MCP 툴을 요구하는가, 그 호출 규약은 무엇인가 |
| U-4 | 세 프로토콜 각각의 세션 재개 절차와 재개 시 이벤트 로그가 어디부터 오는가 (`FR-ABG-10`) |
| U-5 | omp 의 사용량·컨텍스트 창이 프레임에 실리는가 (`FR-AGT-6`) |
| U-6 | claude `--bg`/`claude attach` 가 `FR-ABG-10` 의 휴면에 쓸 수 있는가 |
| U-7 | 세 프로토콜의 종료 절차 — `ExitCommand` 를 대신할 것이 무엇인가 |
| U-8 | 데몬 모드에서 파이프 3개를 IPC 로 중계하는 비용 (`FR-AGT-3`, `NFR-3`) |
