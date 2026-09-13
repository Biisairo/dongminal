# SRS: M8 통합 일정 — Go 부채 · 국제화 · 에이전트 프로토콜 표면 (IEEE 29148)

> **문서 상태**: 초안

- 접수: 2026-09-13. 사용자 지시 — *"8, 9, 10 이 한 번에 하나씩 될 수 없다고 했으므로
  하나의 일정으로 잡고 하나의 스펙을 적자. GUI 에이전트는 지금의 TUI 에이전트와 동일한
  인터페이스(= 에이전트 어댑터)를 이용하여 진행할 것."*
- 흡수한 것: 로드맵 §M8(Go 아키텍처 부채·CLI 계약) · §M9(국제화) · §M10(에이전트
  프로토콜 표면) — 세 마일스톤이 **하나의 마일스톤 M8** 이 된다. 그리고
  [`AGENT_PROTOCOL_SURFACE_SRS`](./AGENT_PROTOCOL_SURFACE_SRS.md)(2026-09-12 초안)의
  본문 전부 — 그 문서는 이 문서로 **대체**된다.
- 사용자 결정 둘 (2026-09-13): ① **병행** — 에이전트 도구는 프로토콜, 터미널 도구의
  훅은 그대로. 훅 제거(옛 묶음 H)는 하지 않는다. ② **어댑터가 인터페이스다** —
  같은 어댑터를 쓸 수 있으면 쓰고, 불가능하면 GUI 용 어댑터를 둔다. 에이전트별
  구현은 어댑터 안에서 끝나며, **어댑터를 쓰는 쪽은 어떤 에이전트든 똑같다.**

---

## 1. 개요

### 1.1 목적

셋을 따로 두면 서로를 딛는다는 사실이 순서를 정해 버리고, 그 순서를 지키면 각각이
반쪽으로 끝난다:

- 프로토콜 표면(축 C)은 `ToolHub`·데몬 IPC·요청 컨텍스트 위에 새 도구를 세운다 —
  그 자리가 Go 부채(축 A ①~④: `GO-13`·`GO-46`·`GO-5`·`GO-12`·`TEST-8`·`FBE-05/12`)다.
  부채 위에 세우면 부채를 갚을 때 새 도구까지 두 번 고친다.
- 축 C 는 M7 뒤 첫 대형 UI 다. 카탈로그(축 B) 없이 태어나면 문구 100여 개를
  축 B 가 한 번 더 걷는다.
- 축 A 의 CLI 계약(⑤)은 Run 멤버의 기동 경로를 다루는데, 축 C 가 그 경로를
  둘로 만든다(TUI 멤버·에이전트 도구 멤버). 축 C-a 뒤에 한 번에 보는 것이 싸다.

그래서 **하나의 일정**이다 — 단계가 축을 넘나들며, 각 단계는 앞 단계의 산출물을
전제로 한다 (§4).

### 1.2 범위

| 축 | 이름 | 접두어 | 출처 |
|---|---|---|---|
| **A** | Go 아키텍처 부채 · 백엔드·CLI 계약 | `FR-A` | 로드맵 §M8 (`GO-*`·`TEST-*`·`FBE-*`·`FUI-23`·`09` 잔여) |
| **B** | 국제화(i18n) | `FR-B` | 로드맵 §M9 (`G7-2·3·4`·`UX-9·11·20·21`) |
| **C** | 에이전트 프로토콜 표면 | `FR-APS`·`FR-AGT`·`FR-AAL`·`FR-ABG` (원문 접두어 유지) | `AGENT_PROTOCOL_SURFACE_SRS` 묶음 P·T·B + A 의 남는 조항 |
| **U** | 통합 원칙 (어댑터 계약 · 병행 · 단계) | `FR-U` · `D-U` | 이 문서 |

**미포함**: §7.

### 1.3 정의

| 말 | 뜻 |
|---|---|
| **어댑터** | `internal/shared/agentadapter.Adapter` — 에이전트 하나의 모든 차이가 사는 자리. 기동 방법·프레임 해석·승인 규약·재개 절차 |
| **소비자** | 어댑터를 쓰는 쪽 — `ToolHub`·`AttnTracker`·Run 오케스트레이션·`dmctl`·브라우저. **에이전트 이름을 모른다** (FR-U-1) |
| **표면(surface)** | 에이전트가 자기 상태를 밖에 내보내는 통로. **프로토콜 표면**(claude `stream-json`·codex `app-server`·omp `--mode rpc-ui`)과 **터미널 표면**(PTY + 훅) |
| **에이전트 도구** | PTY 가 없고 프로토콜 프레임만 오가는 도구 (축 C 묶음 T) |
| **터미널 도구** | PTY 도구. 그 셸에서 뜬 에이전트가 **TUI 에이전트**이며 훅으로 관측된다 — **이 문서가 바꾸지 않는다** |
| **TUI 출구** | 에이전트 도구의 세션을 같은 신원으로 터미널 탭에서 여는 길 (FR-AGT-10) |
| **카탈로그** | 로케일별 키→문장 사상. 프론트가 소유한다 (축 B) |
| **프레임 · 이벤트 로그 · 승인 요청 · 휴면** | `AGENT_PROTOCOL_SURFACE_SRS` §1.3 그대로 |

### 1.4 참조

- 로드맵 [`PRODUCTION_ROADMAP`](./production/PRODUCTION_ROADMAP.md) §M8 — 이 문서가
  그 절의 표와 DoD 를 흡수한다 (§2.1·§3.2·§6.1).
- [`AGENT_PROTOCOL_SURFACE_SRS`](./AGENT_PROTOCOL_SURFACE_SRS.md) — **대체됨.** 실측
  (§2.3)·요구(§3.4)·검증(§6.3)·리스크(§8)·미확인(§9)이 이 문서로 왔다.
- 터미널 표면의 계약 — **그대로 산다**: [`AGENT_EVENT_ABSTRACTION_SRS`](./AGENT_EVENT_ABSTRACTION_SRS.md) ·
  [`AGENT_ADAPTER_COMPLETION_SRS`](./AGENT_ADAPTER_COMPLETION_SRS.md) ·
  [`ATTENTION_FIRING_SRS`](./ATTENTION_FIRING_SRS.md) · [`OMP_AGENT_SUPPORT_SRS`](./OMP_AGENT_SUPPORT_SRS.md)
- [`RUN_ORCHESTRATION_SRS`](./RUN_ORCHESTRATION_SRS.md) FR-ADP-1~6 (어댑터 선언 테이블) ·
  [`ORCHESTRATION_V2_SRS`](./ORCHESTRATION_V2_SRS.md) FR-CBG-5 "모른다 ≠ 괜찮다"
- M7 의 계약 — 새 UI 가 딛는 것: [`UI_KIT_SRS`](./UI_KIT_SRS.md) ·
  [`ACCESSIBILITY_BASELINE_SRS`](./ACCESSIBILITY_BASELINE_SRS.md) ·
  [`DESIGN_TOKENS_SRS`](./DESIGN_TOKENS_SRS.md) · [`CONTEXT_MENU_UNIFY_SRS`](./CONTEXT_MENU_UNIFY_SRS.md)
- [`CONFIG_MANAGEMENT_SRS`](./CONFIG_MANAGEMENT_SRS.md) FR-CFG-1·5 (설정 키는 표 둘에) ·
  [`SETTINGS_PORTABILITY_SRS`](./SETTINGS_PORTABILITY_SRS.md)
- 외부: [Codex App Server](https://learn.chatgpt.com/docs/app-server) ·
  [Agent Client Protocol](https://agentclientprotocol.com) ·
  [oh-my-pi](https://github.com/can1357/oh-my-pi) README §"Four entry points"

---

## 2. 현재 상태

### 2.1 축 A — Go 부채·CLI 계약 (로드맵 §M8 의 표, 2026-09-09 감사)

| 구분 | ID | 내용 | 규모 |
|---|---|---|---|
| P1 | GO-4 | 프로세스 축 의존 규칙 위반 — 문서와 import 그래프 불일치(4곳) | M |
| P1 | GO-5 | `ToolClient.OnOutput/OnExit` 데이터 레이스(문서화된 채 방치) | S |
| P1 | GO-7 | `readPTY` 패닉 시 도구가 반죽음 상태로 남음 | S |
| P1 | GO-9 | 패키지 전역 가변상태 + 전역뮤텍스가 네트워크 I/O 를 감쌈 | M |
| P1 | GO-6 | 데몬모드 `Get/IsLive/Has` 가 매번 전체 `list` RPC | M |
| P1 | GO-12 | 요청 고루틴 안의 `time.Sleep` 폴링 — 컨텍스트 취소 미전파 | M |
| P1 | GO-13 | `ToolHub.List()` 가 `[]map[string]interface{}` | M |
| P1 | TEST-8 | Go 프로세스·PTY 테스트가 고정 `time.Sleep` 위(94회/25파일) | M |
| P2 | GO-14~21 | 거대 파일·거대 함수 8건 | S×6+M×2 |
| P2 | GO-22,24~28 | 중복 로직 6건 | S×6 |
| P2 | GO-29~35,37,42 | 동시성·리소스 9건 | S×8+M×1 |
| P2 | GO-40,41 | 매직 리터럴 · 환경변수 파싱 분산 | S×2 |
| P2 | GO-44~47 | 인터페이스 설계·테스트가능성 4건 | S×1+M×3 |
| P2 | GO-48 | `architecture.md` 패키지 표에 11개 패키지 누락 | S |
| P2 | TEST-23·25·26 | 픽스처 7벌 · 호스트 셸 의존 · 전역 훅 교체 | S×3 |
| P2 | TEST-24 | ~~git 쓰기 0% 함수~~ → **기능 결손 아님으로 정정**(§1.6). 조치는 "커버리지 해석 주의 기록" 으로 축소 | S |
| P1 | **FBE-01** | `dmctl` 의 10초 고정 타임아웃이 서버의 장기 보류(최대 180초)를 끊는다 — **실패로 보고된 승계가 실제로는 성공해 있고 재시도가 멤버·도구를 이중으로 만든다** | S(클라)+M(서버 ctx = `GO-12`) |
| P1 | **FBE-02** | `dmctl` 레이아웃 명령 전부가 브라우저 미구독을 성공으로 보고(exit 0) — 같은 종단을 쓰는 `detach` 는 `delivered==0` 을 확인해 exit 1 을 낸다 | S |
| P1 | **FBE-04** | `POST /api/runs/close` 가 브라우저 없이도 "탭을 닫았다" 고 보고 → 존재하지 않는 Run 의 `runId` 표식이 탭에 영구히 남는다 | S |
| P1 | **FBE-05·FBE-12** | 데몬 모드에서 `POST /api/tools/kill` 의 3초 유예가 적용되지 않는다(실측 50ms) — FR-BGK-7 위반이고 **데몬 모드가 기본 경로**다 | S/M |
| P1 | **FBE-06** | codex 멤버는 `dmctl run launch` 경로에서 프리앰블을 통째로 잃는다 — 알리는 코드도 문서도 없다 | S |
| P2 | **FBE-09~11·13~16·18** | `--isolated` 홈 상실 미고지 · 격리 홈 경로 미출력 · 터미널 리셋이 데몬 모드에서만 매 접속 · `dmctl status --member` 없음 · `--model` 무시 무경고 · CLI 에 `run delete`/`graph` 없음 · 없는 `--cwd` 가 조용히 홈으로 폴백 · 붙여넣기 종료 마커 미이스케이프 | S×8 |
| P2 | **FUI-23** | Run 시작이 UI 에 없다(CLI 전용) — `FBE-15` 와 **반대 방향의 같은 격차**(UI 에는 close 가 없고 CLI 에는 delete 가 없다). 기록만 | S |
| P2 | **`09` FR-GCC-3·4** | `write.SyncNext`·`StepOutcome` 죽은 코드가 도메인 계층에 남았다 — exported 라 자기 테스트로 초록을 유지해 커버리지·정적분석 어느 쪽도 잡지 못한다 | S |
| P2 | **`09` D-WBR-8** | "다음 판에서 확인하고 지운다" 한 죽은 분기가 그대로 (`app-layout.js:732-736`) | S |
| P1(부분) | **FBE-08**(작업 경로분) | `submodule update` 를 `jobs.Jobs` 경로에 태워 취소·진행 SSE 를 준다. 환경·ctx 최소분은 M2 | M |

**선행**: M1 · M3 (`GO-8`·`GO-10`·`GO-36`·`FBE-03`·`FBE-07`·`FBE-17` 은 M3 에서 이미
끝났다). `GP-8` 은 M6 이 처리했으므로 `GO-33` 은 확인만 한다.

### 2.2 축 B — 문자열의 현재 (로드맵 §M9)

| 구분 | ID | 내용 | 근거 | 규모 |
|---|---|---|---|---|
| 갭 | G7-3 | **선택→포함(결정 3)** 문자열 외부화·i18n 체계 — JS 241줄/77파일 + `index.html` 178줄 + Go | 카탈로그 모듈, `constants*.js` 키화, `index.html` 정적 문구 렌더 이관 | L |
| 갭 | G7-2 | 권장 제품 언어 정책 미선언 | README·`docs/internal/README.md` 결정 기록 | S |
| 갭 | G7-4 | 선택→포함 서버 한국어 문구 6곳 → 코드화 | `http.Error` 호출부 | S |
| P2 | UX-20 | 한국어·영어 혼용이 규칙 없이 섞임 | `index.html:166-184,268,274,286,294`; `constants-git.js:187,464` | M |
| P2 | UX-9 | `<html lang="en">` 인데 UI 대부분 한국어 | `index.html:2` | S |
| P2 | UX-11 | 시각전용정보 — CSS `content` 문구(**i18n 불가**) | `style.css:376,772,818` | S |
| P2 | UX-21 | 툴팁의 단축키 표기가 정적 — 재바인딩하면 거짓 | `index.html:166-167,179,181` | S |

`Intl`·`navigator.language` 사용 0건 · `<html lang="en">` 고정 · CSS `content` 문구 3곳 ·
`constants*.js` 5파일 2,737줄이 문구를 든다 · `index.html` 정적 문구 178줄 · JS 77파일
241줄의 한국어 리터럴 · 서버 `http.Error` 한국어 6곳 · CLI 출력은 전부 한국어 자유 문장.

### 2.3 축 C — 에이전트 표면 (조사로 확정한 사실, 2026-09-12)

#### 2.3.1 알람의 생산이 네 갈래다

| 층 | 신호원 | 코드 |
|---|---|---|
| L1 | OSC 알림 시퀀스 | `toolhub/attention.go` |
| L1 | `dmctl notify <reason>` | `helper/runtimebin/dmctl_notify.go` |
| L2 | 에이전트 훅의 활동 보고 → `done`·`waiting` 에서 파생 | `agentadapter.HookParse` → `dmctl activity` → `AttnTracker.SignalAgentEvent` |
| L2 | idle 추정 (무장·재무장·stale) | `toolhub/tool.go:maybeIdle`, `hub/attn_tracker.go:sweepIdle` |

넷 중 셋이 에이전트를 위한 것이고, 그 셋이 서로를 전제한다. `FR-ATN-6` 의
`waiting` 판정이 `FR-ATN-7` 의 진행 표시에 기대고, 그 표시는 훅의 `working`
보고가 세운다. 한 갈래를 걷어내면 나머지 둘의 전제가 무너진다.

#### 2.3.2 훅 표면의 해상도는 에이전트마다 다르고, 구멍이 실재한다

`AGENT_EVENT_ABSTRACTION_SRS` §2.5 의 실측표 그대로다 — **이 표는 터미널 표면의 것이고 병행에서 그대로 산다.**

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

#### 2.3.3 세 에이전트 모두 프로토콜 표면을 갖고 있다

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

#### 2.3.4 claude stream-json 실측 (claude 2.1.269, 2026-09-12)

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

#### 2.3.5 전경 프로세스 이름은 이미 있다

`hub/foreground.go` 가 2 초 주기(`ForegroundInterval`)로 전경 프로그램 이름을
조회해 SSE `tool_foreground` 로 뿌린다. 어댑터에는 `DetectCmd`(`claude`·`omp`·
`codex`)가 이미 있다.

그러므로 **훅 없이도 "이 도구에서 에이전트가 돌고 있다" 를 판정할 수 있다.**
이것은 `Readiness.ScreenPatterns` 가 피한 화면 패턴 휴리스틱이 아니다 —
프로세스 이름은 스테이터스라인을 붙여도 바뀌지 않는다.

#### 2.3.6 백그라운드는 이미 1급 개념이다

- `toolhub.ToolHub.SetBackground(id, bg)` — *"detaches tool id from its tab"*
- `POST /api/runs/detach` — *"탭은 닫히고 도구는 산다"*
- `GET /api/tools/background` · SSE `tools_background_changed` (`FR-BGP-2`)
- `NewDetachedTool` — PTY 없는 합성 `Tool` 이 이미 존재한다 (`term` 이 nil)

**PTY 없는 도구를 다루는 자리가 이미 코드에 있다.** 묶음 T 는 그것을 테스트
헬퍼에서 실제 종류로 올리는 일이다.

#### 2.3.7 훅에 묶인 자리의 목록

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

### 2.4 M7 이 남긴 계약 (새 UI 가 딛는 자리)

버튼·탭·상자·메뉴는 `UIKit` 한 벌(옛 클래스 서른아홉이 선언 0). 모달 골격은
`.ui-modal`/`.ui-modal-box`. 메뉴는 `UIKit.menu`(키 이동·비활성 사유·`role=menu`).
색·글자·z-index 는 토큰이고 게이트 30종이 지킨다. axe 표면은 등록부에서 파생하고
(`FR-A11Y-13`), 키보드 계약은 `UIKit.roving`·`dialogOpen`, 알림은 라이브 리전. 설정
키는 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다(TC-CFG-4 의 개수).

---

## 3. 요구사항

### 3.1 축 U — 통합 원칙

| ID | 요구 | 등급 |
|---|---|---|
| FR-U-1 | **어댑터가 인터페이스다.** 에이전트 하나의 모든 차이(기동 인자·프레임 스키마·승인 규약·재개·종료·사용량 위치)는 `Adapter` 안에서 끝난다. 소비자(`ToolHub`·`AttnTracker`·Run·`dmctl`·브라우저)는 **어댑터 ID 만 알고 에이전트를 모른다** — 에이전트 이름이 등록부 밖에 나오면 안 된다는 규약(`check-agent-names`)이 그것을 지킨다. | 필수 |
| FR-U-2 | **같은 어댑터를 우선한다.** 한 `Adapter` 가 터미널 표면(`Launch`·`HookParse`·…)과 프로토콜 표면(`LaunchProto`·`Decode`·`Approve`·…)을 **함께** 든다. 프로토콜 쪽 필드가 비어 있으면 그 에이전트는 에이전트 도구로 뜰 수 없고, 소비자는 그 사실을 부재로 받는다(FR-APS-4). 한 구조체에 담을 수 없는 에이전트가 나오면 **GUI 용 어댑터를 같은 등록부에 따로** 둔다 — 소비자 쪽은 달라지지 않는다 (사용자 결정). | 필수 |
| FR-U-3 | **병행.** 터미널 도구의 훅·활동 보고·idle 추정·전사본 추정은 **한 줄도 바뀌지 않는다.** 에이전트 도구는 프로토콜만 쓴다. 한 도구는 한 표면만 가지므로(에이전트 도구에는 PTY 가 없어 훅이 돌 자리가 없다) 두 신호 체계는 겹치지 않는다. 옛 묶음 H(`FR-AHR-1~5`)와 묶음 A 의 삭제 조항(`FR-AAL-10·11·12·20·21·22·30`)은 **폐기**. | 필수 |
| FR-U-4 | **에이전트 도구는 TUI 의 어떤 기능도 막지 않는다.** 프로토콜이 주지 않는 것(로그인·설정 파일·TUI 전용 명령·세션 중 모델 전환이 안 되는 에이전트)은 **TUI 출구**(FR-AGT-10)로 간다. P0 스파이크의 기능 대조표가 무엇이 어느 길인지 확정한다 (§9.1 U-9). | 필수 |
| FR-U-5 | **새 UI 는 M7·축 B 위에 선다.** `UIKit` 로 그리고, axe 표면 등록부에 들고, 키보드 계약·라이브 리전을 지키고, 토큰만 쓰고, **카탈로그 키로 태어난다** (축 B 의 게이트가 지킨다). 예외는 등록부에만. | 필수 |
| FR-U-6 | **단계는 §4 의 순서를 지킨다.** 단계마다 진입 조건이 있고, 앞 단계의 DoD 가 그것이다. 단계 안에서는 표적 스펙으로 확인하고 **전량 e2e 는 단계마다 1회** — 항목마다 돌리지 않는다. | 필수 |
| FR-U-7 | 축 C 가 요구하는 축 A 항목(`GO-13`·`GO-46`·`GO-5`·`GO-12`·`TEST-8`·`FBE-05/12`)은 **축 C 착수 전에** 끝나 있어야 한다. 축 C 가 그 자리를 다시 고치지 않는다. | 필수 |

### 3.2 축 A — Go 부채·CLI 계약

로드맵 §M8 의 DoD 를 그대로 요구로 든다. 번호는 로드맵의 내부 순서 ①~⑦ 이고,
**①~④ 가 축 C 의 선행**이다 (FR-U-7).

| 단계 | 항목 |
|---|---|
| ① 경계·문서 | `GO-4` · `GO-48` |
| ② 레이스·리소스 | `GO-5` · `GO-7` · `GO-29~35·37·42` |
| ③ 컨텍스트·전역상태 | `GO-9` · `GO-12` · `FBE-01`(서버측) · `GO-40·41` |
| ④ 타입·인터페이스 | `GO-13` · `GO-6` · `GO-44~47` · `FBE-05/12` |
| ⑤ CLI 계약 | `FBE-02`·`04`·`06`·`13~16`·`18` · `FUI-23`(기록) — **C-a 뒤** (§4) |
| ⑥ 분리·중복·죽은 코드 | `GO-14~21` · `GO-22·24~28` · `09 FR-GCC-3·4` · `09 D-WBR-8` · `FBE-08`(작업 경로분) · `FBE-09~11` |
| ⑦ 테스트 결정성 | `TEST-8` (**④ 와 함께 앞당긴다** — 축 C 의 V-1 이 그 위에 선다) · `TEST-23·25·26` · `TEST-24`(기록) |

**DoD (로드맵 §M8 원문)**

- `go list -deps` 를 읽는 경계 테스트가 `internal/{ctl,daemon,helper}` → `internal/webserver` import 를 실패시킨다. 현재 위반 4곳(`shared/runtime→helper/runtimebin`, `daemon/boot→webserver/domain/run`, `ctl/cli→webserver/domain/git/core`, `shared/sandboxplace→shared/toolhub`)이 해소되거나 명시적 예외 목록으로 등록되고 `architecture.md:113` "프로세스 축에 예외는 없다" 가 사실과 맞게 개정된다.
- `architecture.md:49-116` 패키지 표가 `go list ./...` 과 일치(생성 또는 대조 스크립트, CI 0 불일치). `:959-962` 동시성 절에 `toolclient`·`AttnTracker`·`Jobs` 기재.
- `go test -race -shuffle=on -count=1 ./...` 통과. `t.Parallel()` 도입 패키지에서 전역 테스트 훅(`toolBusyProbe`·`attnBusyProbe`·`fgProbe`·`attnNow`·`procCtl`)이 구조체 필드 주입 또는 restore 반환형으로 교체.
- `SetOnOutput/SetOnExit`(mu 또는 `atomic.Pointer`) 도입 + 필드 비공개화. `main.go:468,472` 맨 대입 소멸. 배선 포함 레이스 테스트 존재(현재 패키지 테스트가 닿지 않는 자리).
- `readPTY` 의 `recover` 뒤에 `p.kill()` + `relay.onExit` 이 EOF 경로와 같은 순서로 호출되고, 패닉 주입 테스트가 도구 정리와 `OpExit` 전달을 확인.
- `time.Sleep` 이 요청 경로에서 0곳 — `handlers_runs.go:364-379`·`handlers_runs_headless.go:232-244`·`handlers_runs_cleanup.go:104-123`·`bracketpaste.go:123`·`tool.go:746`·`worktree.go:424-436` 이 `select { case <-ctx.Done(): … }` 로(`handlers_status.go:247-252` 모범). 연결을 끊으면 대기가 즉시 종료됨을 테스트로 확인. `repoLock` 을 쥔 채 최대 18분 대기하는 경로 소멸.
- 테스트의 1초 이상 `time.Sleep` 0(`daemon_integration_test.go:371,615,655,671`). `StartAttentionSweeper(stop, tick <-chan time.Time)` 로 틱 주입, `history_shell_test` 의 500ms×4 가 `waitFor` 폴링으로.
- `ToolHub.List()` 가 `[]ToolInfo` 를 반환하고 `m["id"].(string)` 형 단언 0. `map[string]interface{}` 79곳 감소, 필드 추가가 컴파일 오류로 잡힘 1회 확인.
- 데몬 모드 `Get/IsLive/Has` 가 전체 `list` RPC 를 매번 부르지 않는다(`has {id}` RPC 또는 TTL 캐시 + `exit` push 무효화). `GET /api/runs` 한 번의 RPC 왕복 수 감소 계측.
- `httpapi` 전역 가변상태(`fsOpMu`·`contextNotices`·`toolKillGrace`·`uploadMaxBytes`·`fsListMax/DeleteMax/CopyMax`)가 `Server` 필드로 이동 → `server.go:1-4` 의 "두 서버 공존" 계약이 성립함을 두 서버 동시 기동 테스트로 확인. `fsOpMu` 가 실제 파일 조작 구간만 감싼다.
- 동시성 9건 해소: `Create` 가 락 밖에서 `StartTool`, onExit 클로저가 `invalidator` 를 락으로 읽음, `tool.Restored` 가 `atomic.Bool`, `ClearAllAttention` 이 락을 놓고 `Broadcast`, `StartGitWatch` 가 `ctx` 를 받음, `OnIndexUpdate` 가 락 밖 호출 + rev 순서 보장, `time.After` → `NewTimer`+`Stop`, PTY 청크 복사 1회.
- `deps.go` 구체 포인터 5개 → 좁은 인터페이스(`RunStore`·`WorktreeManager`·`GitQuery`)로 `/api/runs*`·`/api/git/*` 핸들러 테스트가 파일시스템·git 없이 돈다. `SettingsStore` 가 패키지 밖에서 구현 가능. 데몬 모드 판별 타입 단언 4곳이 `ToolHub` 인터페이스 메서드로.
- 500줄 초과 Go 파일 목록 축소(현재 `handlers_fs.go` 775 · `tool.go` 774 · `handlers_runs.go` 710 · `worktree.go` 701 · `doctor.go` 685). `main.go serve` 158줄 + `buildDeps` 3벌 → `Build(cfg)`/`App.Run(ctx)`/`App.Shutdown()`, 종료 순서 주석(`main.go:571-593`)이 코드가 된다. `doctor.go` 진단 11개가 `[]check{name, fn}` 표.
- 중복 6건 해소: `decodeParams[T]` 제네릭 + JSON-RPC 코드 상수, `dataPath` 1벌, `HeadlessToolIDs` 부팅 중 1회 읽기, 스냅샷 프레이밍 1벌, `pollUntil(ctx, every, fn)` 1벌, 기본 터미널 크기 상수 1곳.
- `worktree.go:600` 의 `strings.Contains(p, "..")` 오탐(`a..b` 정상 이름 거부) 해소 + 테스트.
- Go 테스트: `gittest` 헬퍼로 픽스처 7벌 → 1벌, `DONGMINAL_SHELL` 을 `t.Setenv` 로 고정(조건부 `t.Skip` 110곳 감소).
- **`TEST-24` 정정 반영**: `Merge`·`Replay` 에 함수 단위 테스트를 새로 쓰지 않는다. `10 §4.4` 가 둘 다 기능 완성이고 계약이 `MergeArgs`(`write/branch_test.go:352-375`)와 HTTP 종단(`TestAPIGitBranchMerge`·`handlers_git_replay_test.go` 5건)에서 시험됨을 확인했다. 대신 **커버리지 리포트에 "래퍼 함수의 0% 는 결손이 아니다" 를 주석으로 남기고**, `OperationActions`·`Unwrap` 만 필요 여부를 개별 판단한다.
- **`dmctl` 계약**: `runPost`/`runGet` 이 서브커맨드별 예산을 받는다(`dmctl_status.go:305-310` `wait` 가 이미 옳게 하는 형태). `run succeed` 가 `--timeout-ms + slack`, `preamble` 이 `handoffPreambleWait + slack`. 서버측 `time.Sleep` 루프가 `select { case <-ctx.Done() }` 로 바뀌어(=`GO-12`) 끊긴 요청의 부작용이 멈춘다. 전임자가 60초 뒤 답해도 `succeed` 가 성공으로 끝남을 통합 테스트로 확인.
- `dmctlHTTPResult` 가 `delivered`(생성 명령은 `timedOut`·`newTabs` 도)를 판정한다 — 브라우저 없이 `dmctl new-tab` 을 실행하면 **exit 1** 과 `detach` 와 같은 문구가 나온다.
- `POST /api/runs/close` 가 방송 결과를 그대로 `closed` 에 싣는다 — 브라우저 0 이면 `closedTabIDs` 에서 빠져 표식 해제가 정상 동작한다.
- 데몬 모드에서 `POST /api/tools/kill` 의 유예가 **3초**다(현재 50ms) — `kill` RPC 에 grace 를 싣거나 데몬에 `terminate {id, graceMs}` 를 더한다. 백그라운드 claude 세션이 SIGTERM 후 이력을 남기고 종료함을 확인.
- `dmctl run launch` 가 `PromptInjection != PromptArgv` 인 에이전트(codex)에서 stderr 로 안내를 낸다 — 프리앰블이 기동줄에 실리지 않으니 `wait --for ready` 뒤 별도로 붙여넣으라는 지시. 헬프의 3단계 절차에 그 분기가 명시된다.
- `--isolated` 가 도구 홈 상실을 헬프 또는 기동 로그에 알리고, `--foreground` 에서도 격리 홈 경로가 출력된다.
- `termReset` 이 두 모드에서 같은 조건(첫 복원 시)·같은 순서로 나간다 — 데몬 모드에서 vim 이 도는 탭을 새로고침해도 마우스·bracketed paste 가 꺼지지 않는다.
- `dmctl status --member <uuid>` 가 동작한다(현재 `wait` 만 `--member` 를 받는다). `dmctl run delete`·`run graph` 가 추가된다.
- 없는 `--cwd` 가 조용히 홈으로 폴백하지 않고 400 을 낸다.
- `wrapPaste` 가 본문의 `ESC[201~` 를 제거하고, `apiToolMessage` 가 본문의 엔벨로프 구분자를 치환한다(후자는 보안 축과 조율 — M2 에서 처리했으면 확인만).
- `write.SyncNext`·`StepOutcome` 과 그 자기 테스트가 제거되고 `app-layout.js:732-736` 의 죽은 editor 분기가 제거된다. **제거할 수 없는 보류가 있으면 M5 의 모범 사례대로 가드 테스트로 봉인**한다.
- **양호 판정 유지 확인**: `go vet ./...` 무경고, `go build ./...` 성공, git 실행 초크포인트 동작 불변, `check-gitwrite.sh` 통과, 고득점 패키지 커버리지 하락 0.

### 3.3 축 B — 국제화

| ID | 요구 | 등급 |
|---|---|---|
| FR-B-1 | **언어 정책이 결정으로 기록된다** (`README.md`·`docs/internal/README.md`): 지원 로케일 목록 · 기본 로케일 · 감지 규칙(`navigator.language` 를 쓰는가, 설정이 이기는가) · 미번역 키의 폴백 로케일 · **범위 경계** — UI 는 포함, 서버 오류 문구는 코드로(문장은 프론트), CLI 출력은 범위 밖으로 명시하거나 포함 정책을 적는다 (`G7-2`). | 필수 |
| FR-B-2 | **카탈로그 모듈**이 있다. 키→문장 사상이 로케일별 파일로 갈리고, 읽는 함수는 하나다 (`t(key, params)`). 키 규약(네임스페이스 · 소문자 점 표기 · 자리표시자 `{name}` · 복수형 규칙)이 이 문서에 적힌다. `constants*.js` 5파일의 문구가 키로 바뀌고 `index.html` 정적 문구 178줄이 렌더 경로로 간다 (`G7-3`). | 필수 |
| FR-B-3 | **하드코딩 문자열 게이트**가 CI 에 있고 위반 0 — JS·HTML 의 한국어 리터럴(문구)이 카탈로그 밖에 남지 않는다. 검출 규칙(한글 유니코드 범위 + 예외 등록부: 로그·테스트·주석)이 이 문서에 적히고, 탐침으로 검출을 확인한다 (M7 규약). **이 게이트가 없으면 외부화는 즉시 역행한다.** | 필수 |
| FR-B-4 | 로케일을 전환하면 UI 문자열 전부가 바뀌고, 미번역 키는 폴백으로 표시되며 콘솔에 경고가 남는다 (e2e 1스펙). 전환은 설정 키(`locale`, `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다)다. | 필수 |
| FR-B-5 | `<html lang>` 이 활성 로케일이다. 다른 언어가 섞인 요소에는 그 `lang` 이 붙는다 (`UX-9`). | 필수 |
| FR-B-6 | CSS `content` 로만 전달되던 문구 3곳(`style.css:376,772,818`)이 DOM 텍스트로 간다 — 접근성 트리의 이름 또는 텍스트 노드로 잡히는지 e2e 가 단정한다 (`UX-11`, `FR-A11Y-21`). | 필수 |
| FR-B-7 | 툴팁의 단축키 표기가 `displayKey(shortcuts.*)` 보간으로 생성되고, 재바인딩 뒤 툴팁이 갱신됨을 e2e 가 단정한다 (`UX-21`). 보간 파라미터는 카탈로그의 자리표시자 규약을 지난다. | 필수 |
| FR-B-8 | 서버의 한국어 `http.Error` 6곳이 오류 코드로 바뀌고 문장은 카탈로그가 든다 (`G7-4`, `ERROR_CONTRACT_SRS` 의 규약). | 필수 |
| FR-B-9 | 혼용(`index.html:268,274` 한국어 vs `:286,294` 영어)이 **카탈로그 데이터 교정만으로** 해소된다 — 코드 변경 0 이 외부화의 증거다 (`UX-20`). | 필수 |
| FR-B-10 | 축 C 의 새 UI(대화·도구 호출·승인·사용량·TUI 출구)는 **처음부터 키**다. 게이트가 그것을 잡는다. | 필수 |

**DoD (로드맵 §M9 원문)**

> **[결정 2 확정 — 2026-09-12]** `UX-11`(CSS `content` → DOM 텍스트)의 검증 방법이 정해졌다: 기준은 WCAG 2.1 AA 이고, "읽힌다" 는 **해당 문구가 접근성 트리의 이름 또는 텍스트 노드로 잡히는지**를 e2e 가 단정하는 것으로 확인한다 (`ACCESSIBILITY_BASELINE_SRS` FR-A11Y-21).

- 언어 정책이 `README.md` 와 `docs/internal/README.md` 에 결정으로 기록된다 — 지원 로케일 목록, 기본 로케일, 로케일 감지 규칙(`navigator.language` 사용 여부), 미번역 항목의 폴백. **현재 `Intl`·`navigator.language` 사용 0건**이므로 이 선언이 곧 신규 계약이다.
- 카탈로그 모듈이 존재하고 키→문장 사상이 로케일별 파일로 갈린다. `constants*.js` 5파일 2,737줄의 문구가 키로 바뀌고, `index.html` 정적 문구 178줄이 렌더 경로로 이관된다.
- **하드코딩 문자열 검출 grep 게이트**가 CI 에 존재하고 위반 0 — JS 77파일 241줄의 한국어 리터럴과 `index.html` 정적 문구가 카탈로그 밖에 남지 않음을 기계적으로 보장. 이 게이트가 없으면 외부화는 즉시 역행한다.
- 로케일을 전환하면 UI 문자열 전부가 바뀌고, 미번역 키가 폴백 로케일로 표시되며 콘솔에 경고가 남는다(전량 e2e 1스펙).
- `<html lang>` 이 정적 `"en"` 이 아니라 활성 로케일로 세팅된다. 다른 언어가 섞인 요소에는 해당 `lang` 속성이 붙는다(`03 UX-9` 조치대로).
- CSS `content` 로만 전달되던 문구 3곳(`style.css:376,772,818`)이 DOM 텍스트로 이관 — `::after` 텍스트는 "대부분의 스크린리더에서 읽히지 않거나 불안정하고 **i18n 불가**"(`03 UX-11`)이므로 이것이 외부화의 전제다.
- 툴팁 단축키 표기가 `displayKey(shortcuts.*)` 보간으로 생성되고 재바인딩 후 툴팁이 갱신됨을 e2e 가 단정. 보간 파라미터가 카탈로그 규약(치환 자리표시자)을 지난다.
- 서버의 한국어 `http.Error` 문구 6곳이 코드로 바뀌고 문장은 프론트 카탈로그가 소유한다(`07 §7` 기준선: "서버 오류 문구는 코드로, 문장은 프론트가"). M5 의 `G6-1`(63곳 코드화)이 이미 끝났으므로 여기서는 잔여 한국어 제거만.
- CLI 출력은 **범위 밖으로 명시**하거나 포함 범위를 정책에 적는다 — 현재 `migrate.go` 등 CLI 출력 전부가 한국어 자유 문장이다(`07 §6`). 어느 쪽이든 정책 문서에 근거와 함께 기록.
- 혼용 해소 확인: 한 패널 안에서 언어가 갈리는 자리(`index.html:268,274` 한국어 vs `:286,294` 영어)가 카탈로그 데이터 교정으로 해소되고, **코드 변경 없이** 되는지 확인(외부화가 제대로 됐다는 증거).

### 3.4 축 C — 에이전트 프로토콜 표면

> 원문 `AGENT_PROTOCOL_SURFACE_SRS` §3 에서 왔다. 병행(FR-U-3)으로 묶음 H 와 묶음 A 의
> 삭제 조항은 빠졌고, 어댑터 계약(FR-U-1·2)과 TUI 출구(FR-U-4)가 더해졌다.

#### 3.4.1 묶음 P — 프로토콜 표면

**FR-APS-1** `Adapter` 는 **프로토콜 기동**을 선언한다. 기존 `Launch`(TUI 기동)
와 나란한 자리이며, 서로를 대체하지 않는다 — 터미널 표면은 여전히 존재한다
(FR-U-3 — 터미널 표면은 그대로다).

**FR-APS-2** 어댑터는 프레임을 **공통 이벤트**로 옮긴다. 공통 이벤트의 어휘는
`Report` 의 후신이며, 활동 상태(`idle`·`working`·`waiting`·`done`·`ended`)를
**한 글자도 바꾸지 않는다.** 활동 패널의 동작이 이 변경으로 달라지면 안 된다
(`FR-CBG-1`·`FR-AEV-2` 의 선례를 따른다).

**FR-APS-3** 공통 이벤트는 §2.3.4 에서 실측한 것을 담을 수 있어야 한다. 최소로:
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

**FR-APS-9** (추가) 프로토콜 표면의 어댑터 필드는 **같은 `Adapter` 구조체**에 든다 —
`LaunchProto`(기동 인자) · `Decode`(프레임 → 공통 이벤트) · `Approve`(승인 응답 →
프레임) · `Resume`(세션 재개 인자) · `Exit`(정중한 종료). 터미널 표면의 필드
(`Launch`·`HookParse`·`InstallAssets`·`ParseUsage`·`ContextWindow`·`Readiness`)는
**그대로**다 (FR-U-2·3). 소비자는 `Adapter.Proto()` 가 참일 때만 에이전트 도구를
띄운다.

**FR-APS-10** (추가, §9.2 R-c) claude 의 승인 요청은 `--permission-prompt-tool` 이
요구하는 **MCP 도구**로 온다. dongminal 이 그 도구를 노출하는 MCP 서버를 하나 든다
— 어댑터의 `LaunchProto` 가 그 주소를 인자로 싣고, 서버는 그 호출을 FR-APS-5 의
승인 요청으로 올린다. 이것은 실측 항목이 아니라 **범위 항목**이다.

#### 3.4.2 묶음 T — 에이전트 도구

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

**FR-AGT-8** (추가) 에이전트 도구는 **터미널 도구와 같은 소비자 길**을 지난다 —
`ToolHub` 의 생성·조회·종료·백그라운드, `AttnTracker` 의 알람, Run 오케스트레이션의
멤버, `dmctl` 의 조회·대기(`wait --for ready` 는 프로토콜의 `system:init` 이 답한다),
프리셋. 소비자 코드가 도구 종류를 묻는 자리는 **전송이 필요한 곳**(PTY 입출력·
리사이즈·붙여넣기)뿐이어야 한다 (FR-U-1).

**FR-AGT-9** (추가) UI 는 M7 의 계약 위에 선다 (FR-U-5): `UIKit` 로 그리고, 에이전트
도구의 뷰가 axe 표면 등록부에 들며(`FR-A11Y-13`), 승인 다이얼로그는 `UIKit.dialogOpen`
의 트랩·복귀를 지나고, 승인 요청의 도착은 라이브 리전으로 읽히며(`FR-A11Y-19`),
문구는 카탈로그 키다.

**FR-AGT-10** (추가, FR-U-4) **TUI 출구.** 에이전트 도구의 탭 메뉴에 "터미널로
열기" 가 있다 — 같은 세션 신원으로 터미널 탭을 열고(`claude --resume <id>` 류, 어댑터의
`Resume` 이 인자를 준다) 거기서 TUI 의 모든 기능이 된다. 그 터미널 탭의 에이전트는
**훅으로 관측된다** (병행). 반대 방향(터미널 세션을 에이전트 도구로 들어올리기)도
같은 `Resume` 으로 가능해야 한다 — P0 스파이크가 세 에이전트에서 확인한다.

#### 3.4.3 묶음 A — 알람 (병행에서 남는 것)

> 판정 이후는 한 줄도 바뀌지 않는다. `Tool.attention` 은 "부른다" 는 비트 하나이며
> 누가 세웠는지 모른다. 표시·펄스·해제·모바일 푸시는 그대로다.

**FR-AAL-1** 알람의 생산은 **세 갈래**다 — 원문의 "두 갈래" 를 병행에 맞게 고쳤다.

| 층 | 신호원 | 대상 |
|---|---|---|
| **L1 명시 신호** | 프로토콜의 `done`·**열린 승인 요청**, OSC 시퀀스, `dmctl notify` | 에이전트 도구 · 모두 |
| **L2 훅** | 활동 보고(`done`·`waiting`·`working`) — **지금 그대로** | 터미널 도구 |
| **L2 idle 추정** | 무장·재무장·stale — **지금 그대로** | 터미널 도구 |

**FR-AAL-2** 프로토콜 표면의 `done` 은 추정을 거치지 않고 알람 판정에 들어간다.
`FR-ATN-4`(표시가 서 있을 때만)의 판정은 남되, 그 표시를 세우는 것은 훅의
`UserPromptSubmit` 이 아니라 **우리가 보낸 입력**이다 — 에이전트 도구에서는 입력을
넣은 주체가 우리이므로 사람 턴과 배경 턴을 판정할 필요가 없다.

**FR-AAL-3** **승인 요청이 열리면 알람이 선다.** 에이전트 도구에서 `waiting` 은
추론이 아니라 열린 요청이다.

**FR-AAL-4** 알람의 내용(`Detail`)은 승인 요청의 payload 에서 온다 — 어떤 명령을
실행하려 하는가, 어떤 파일을 어떻게 바꾸려 하는가 (`FR-AEV-15` 의 뜻이 여기서
온전해진다).

**FR-AAL-5** (원문 FR-AAL-30) 에이전트 도구는 **L2 idle 의 대상이 아니다.** 프로토콜이
턴의 시작과 끝을 명시한다. 프로토콜이 끊기면 idle 이 아니라 **오류**다 (FR-ABG-20).

**FR-AAL-6** (원문 FR-AAL-23·24) `FR-ATF-5~13` 은 그대로다 — 터미널 도구의 것이며 이
문서가 손대지 않는다. 프로토콜 표면도 직접 모드와 데몬 모드에서 같아야 한다.

~~FR-AAL-10·11·12·20·21·22·30~~ — 병행으로 폐기 (FR-U-3). `AgentTurn`·`waiting`
추론·사용자 턴 판정·전경 프로세스 판정 교체는 **하지 않는다**.

#### 3.4.4 묶음 B — 백그라운드·휴면·복원

**FR-ABG-1** 에이전트 도구의 백그라운드는 **기존 경로를 쓴다** — `SetBackground`,
`/api/runs/detach`, `/api/tools/background`, SSE `tools_background_changed`.
새 기계를 만들지 않는다 (§2.3.6).

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

**FR-ABG-21** (추가, §9.2 R-b) 이벤트 로그의 상한(NFR-C-2)과 재생(FR-ABG-4)은 이렇게
맞는다: 잘린 앞부분은 **요약 스냅샷 하나**(마지막 `assistant` 누적 메시지 + 열린
요청 + 사용량)로 대체되고, UI 가 "이전 기록은 잘렸다" 를 표시한다. V-3 의
"빠짐없이" 는 **상한 안에서** 빠짐없이다.

#### 3.4.5 비기능 (NFR)

**NFR-C-1** 프레임의 **내용을 서버 밖으로 내보내지 않는다.** `AGENT_ADAPTER_COMPLETION_SRS` NFR-4 의 규약을
잇는다. 이벤트 로그는 이 인스턴스의 디스크에만 있다.

**NFR-C-2** 이벤트 로그는 **무한히 자라지 않는다.** 상한과 잘라내기 규칙을 둔다.
값은 구현 시 정한다.

**NFR-C-3** 프레임 처리는 **에이전트를 막지 않는다.** 우리 쪽 처리 지연이 에이전트의
진행을 늦추면 안 된다.

**NFR-C-4** 승인 응답의 왕복은 사용자가 답한 순간부터 **한 번의 프레임**이다.
중간 계층이 재확인을 끼워 넣지 않는다.

---

---

## 4. 통합 일정 (단계)

| 단계 | 축 | 내용 | 진입 조건 | 규모 |
|---|---|---|---|---|
| **P0** | C(스파이크) | §9.1 의 U-1~U-9 를 한 세션에 실측한다. 산출물: ① 기능 대조표(에이전트 셋 × TUI 기능 × 프로토콜/파일/TUI 출구) ② 가짜 에이전트 픽스처의 가능성 판정 ③ `Adapter` 의 프로토콜 필드 시안(FR-APS-9) ④ 데몬 파이프 중계의 설계 선택(§9.2 R-g) — 결과가 P1 ④의 `GO-46` 설계에 들어간다 | 이 문서 승인 | S |
| **P1** | A ①~④ + ⑦의 `TEST-8` | 경계 테스트·문서 일치 → 레이스·리소스 → 컨텍스트·전역상태 → 타입·인터페이스. `TEST-8` 을 여기 붙인다 | P0 (P0 가 `ToolHub` 인터페이스에 요구하는 것을 안다) | L |
| **P2** | B | 언어 정책 결정 → 카탈로그 모듈 → 게이트(탐침) → 외부화(constants → index.html → 혼용) → `lang`·CSS content·툴팁 보간 → 서버 6곳 | P1 (Go 쪽 오류 코드화가 `ERROR_CONTRACT` 위에서) | L |
| **P3** | C-a | 묶음 P + T, **claude 한정**: 어댑터 프로토콜 필드 · 공통 이벤트 · 승인 요청-응답 + MCP 도구(FR-APS-10) · 에이전트 도구 종류 · GUI · TUI 출구 · L1 알람(FR-AAL-1~4). 터미널 표면은 손대지 않는다 | P1 · P2 | L |
| **P4** | C-b | codex · omp 어댑터 (FR-U-2 — 같은 구조체에 들어가는지가 첫 판정). codex 대조 잡의 주기 결정 | P3 | M |
| **P5** | C-c(B) | 이벤트 로그 · 재생 복원(+요약 스냅샷) · 휴면·재개 · 연결 끊김의 오류 상태 | P3 | M |
| **P6** | A ⑤ | CLI 계약 — Run 멤버 기동 경로가 둘(TUI·에이전트 도구)이 된 뒤 한 번에 본다. `FBE-06` 은 TUI 멤버에 남는다 | P3 | M |
| **P7** | A ⑥·⑦ | 분리·중복·죽은 코드 · 테스트 결정성 나머지 | 언제든 (P1 뒤) | M |

**단계의 규약** (FR-U-6): 단계마다 진입 시 이 문서의 해당 절을 **다시 읽고 실측으로
정정**한다(M7 이 SRS 를 세 번 정정한 선례). 전량 e2e 는 단계 끝에 1회, 판정은
unexpected 0. 단계 하나가 세션 여럿이면 `M8_PROGRESS.md`·`M8_NEXT_SESSION.md` 가
M7 의 형식으로 인계한다.

**규모 합**: S + L + L + L + M + M + M + M → **XL** (두세 세션이 아니라 여러 주). 그래서
단계마다 출하 가능해야 한다 — P1·P2·P3 각각이 minor 릴리스 하나다 (로드맵 §6-2).

---

## 5. 설계 결정

**D-U-1 — 하나의 일정.** (사용자 지시 2026-09-13) §1.1 의 세 의존이 근거다. 셋을 따로
두면 순서가 강제되고 각각이 반쪽으로 끝난다. 대가는 마일스톤이 XL 이 되는 것이며,
§4 의 단계별 출하가 그 대가를 갚는다.

**D-U-2 — 어댑터가 인터페이스다.** (사용자 결정 2026-09-13: *"같은 어댑터를 사용하면
좋고 불가능하다면 GUI 용 어댑터를 만들어서 사용한다. 각 에이전트별 구현은 어댑터
내에서 끝나며 어댑터를 사용하는 쪽에서는 어떤 에이전트를 사용하든 똑같아야 한다."*)
원문의 FR-APS-1·2·7 이 이미 이 방향이었고, 이 결정이 그것을 **소비자 쪽의
불변식**(FR-U-1·2, FR-AGT-8)으로 올린다. 같은 구조체를 우선하는 이유: 등록부가
하나이고 `check-agent-names` 가 하나의 목록을 지킨다. 갈라야 하는 에이전트가 나오면
등록부에 **같은 ID 의 두 항목**이 아니라 **표면을 표시한 별도 항목**으로 둔다 —
소비자는 여전히 ID 로만 안다.

**D-U-3 — 병행 · 훅 유지.** (사용자 결정 2026-09-13) 원문 D-1(터미널 표면 강등)을
뒤집는다. 세 선택지 — (A) 병행 · (B) 훅 제거 + idle 추정만 · (C) 훅 제거 + 도구
자체의 알림 채널(BEL·OSC 9)을 L1 로 — 중 **A**. 근거: TUI 는 상시 경로(FR-U-4)이므로
그쪽 알람을 약하게 할 수 없고, 훅 체계는 이미 있어 "유지" 는 "신설" 보다 싸며, 한
도구가 한 표면만 갖는 한 두 신호가 겹치지 않는다. C 는 훅을 깔 수 없는 환경
(원격 `ssh`·`tmux`)의 보조 채널 후보로 남긴다 (§9.1 U-10). 폐기되는 원문 조항: D-1 ·
FR-AAL-10·11·12·20·21·22·30 · FR-AHR-1~5 · R-3 의 "훅 제거를 마지막에" · R-6 · V-4 ·
V-7 · AS-3.

**D-U-4 — 에이전트 도구는 새 도구 종류다.** (원문 D-4, 사용자 선택 2026-09-12 유지)
기존 터미널 도구에 뷰를 토글하는 안은 PTY 없는 세션에 PTY 도구의 껍데기를 씌운다.
다만 D-U-2 가 그 위에 선다 — 종류가 달라도 **소비자 길은 같다**(FR-AGT-8).
P0 가 "종류" 와 "전송만 다른 변형" 중 어느 쪽이 `ToolHub` 인터페이스(`GO-46`)에
싼지 판정한다 — 이 결정은 그 판정으로 **정정될 수 있다**.

**D-U-5 — codex app-server 를 채택한다.** (원문 D-2, 근거 정정) 원문은 "훅을 지우면
codex 가 침묵하므로 강제" 였다. 병행에서는 그 근거가 사라지지만 결론은 같다 —
codex 의 프로토콜 표면은 app-server 뿐이다. experimental 딱지는 R-1 로 관리하고
대조 잡의 주기는 P4 에서 정한다.

**D-U-6 — `Signals` 같은 선언 테이블을 다시 만들지 않는다.** (원문 D-3 그대로) 없는
이벤트는 부재로 (FR-APS-4).

**D-U-7 — 승인 요청의 타임아웃을 다루지 않는다.** (원문 D-5, 사용자 결정 2026-09-12)
열린 요청이 에이전트 쪽에서 만료되면 그 턴은 거부/실패로 끝난다. 알람을 세워 알릴
뿐이며 대신 답하지 않는다 (FR-APS-6).

**D-U-8 — L1(OSC·`dmctl notify`)은 남긴다.** (원문 D-6 그대로)

**D-U-9 — 축 B 가 축 C 앞이다.** 새 UI 의 문구 100여 개가 키로 태어나야 축 B 가
그것을 한 번 더 걷지 않는다 (§1.1). 축 C 가 지우는 UI 문구는 없다 (병행).

**D-U-10 — 축 A ⑤(CLI 계약)는 C-a 뒤다.** Run 멤버의 기동 경로가 둘이 된 뒤 한 번에
본다 — 먼저 고치면 C-a 가 다시 고친다.

---

## 6. 검증

### 6.1 축 A

로드맵 §M8 DoD(§3.2)의 항목마다 그 문장이 곧 검증이다 — 경계 테스트(`go list -deps`),
`-race -shuffle` 전량, 패닉 주입 테스트, `time.Sleep` 0 의 grep, `[]ToolInfo` 의 형
단언 0, 두 서버 동시 기동 테스트, `dmctl` 의 exit 1 …

### 6.2 축 B

| ID | 무엇 |
|---|---|
| TC-B-1 | 하드코딩 문자열 게이트 0 · **탐침**: 한국어 리터럴을 JS 와 HTML 에 하나씩 넣으면 빨개지고, 예외 등록부(로그·테스트)의 것은 잡지 않는다 |
| TC-B-2 (e2e) | 로케일 전환 — 표본 문구 열 곳이 전부 바뀌고, 미번역 키 하나를 심으면 폴백 문장과 콘솔 경고가 난다 |
| TC-B-3 (e2e) | `<html lang>` 이 활성 로케일이고, 혼용 요소의 `lang` 이 붙는다 |
| TC-B-4 (e2e) | CSS `content` 문구 3곳이 접근성 트리의 이름/텍스트 노드로 잡힌다 (`FR-A11Y-21`) |
| TC-B-5 (e2e) | 단축키를 재바인딩하면 툴팁이 갱신된다 |
| TC-B-6 (Go) | `http.Error` 한국어 0 (grep 게이트, `ERROR_CONTRACT` 의 카탈로그 게이트에 편입) |
| TC-B-7 | 혼용 해소가 카탈로그 파일 diff 만으로 이뤄졌음을 커밋이 보인다 |

### 6.3 축 C 의 검증 (V-1~V-9)

**V-1** 세 어댑터 각각에 대해, 실제 프로세스를 프로토콜 모드로 띄우고 한 턴을
돌려 §3.4.1 의 공통 이벤트가 나오는지 본다. 녹화된 프레임 픽스처가 아니라 **실행**
이다 — 스키마 드리프트를 잡는 것이 목적이므로.

**V-2** 승인 요청이 열린 채 브라우저를 끊고, 알람이 서고, 다시 붙었을 때 그
요청이 UI 에 있고, 답이 에이전트에 도달하는지 본다 (`FR-APS-5·6`, `FR-AAL-3`,
`FR-ABG-5`).

**V-3** 백그라운드에서 진행된 턴이 탭을 다시 열었을 때 **빠짐없이** 재생되는지
본다 (`FR-ABG-4`).

**~~V-4~~ (폐기 — 병행)** 터미널 도구의 셸에서 `claude` 를 직접 띄우고, 훅이 없는 상태에서 L2 idle
알람이 서는지 본다 (`FR-AAL-21`). 그리고 활동 패널이 **비어 있음을 확인한다** —
D-1 이 포기한 것이 실제로 포기되었는지가 검증 대상이다.

**V-5** 에이전트 도구에 대해 리사이즈·bracketed paste·스크롤백 경로를 호출해
**오류가 아니라 무동작**임을 본다 (`FR-AGT-2`).

**V-6** 터미널 도구와 에이전트 도구를 한 창에 섞어 두고 배치·영속·복원·포커스·
이름·닫기가 동작하는지 본다 (`FR-AGT-7`).

**~~V-7~~ (폐기 — 병행)** §2.3.7 의 목록이 저장소에서 사라졌는지 `grep` 으로 대조한다. 폐기 표시가
참조 문서에 적혔는지 함께 본다 (`FR-AHR-2`).

**V-8** 프로토콜 연결을 강제로 끊고 오류 상태가 되는지, idle 로 읽히지 않는지
본다 (`FR-ABG-20`).

**V-9** 직접 모드와 데몬 모드에서 V-1~V-3 이 같게 동작하는지 본다
(`FR-AAL-24`).

---

**V-10** (추가) **TUI 출구** — 에이전트 도구의 세션을 "터미널로 열기" 로 열면 같은
세션이 이어지고(직전 대화가 보인다), 그 터미널 탭의 에이전트가 **훅으로** 알람을
낸다 (병행의 증거).

**V-11** (추가) **훅 표면 불변** — 기존 `attention*`·`activity*`·`agent*`·`run*` e2e 전부가
그대로 통과한다. 한 줄도 고치지 않았어야 한다 (FR-U-3).

**V-12** (추가) **가짜 에이전트 e2e** — 세 프로토콜을 말하는 픽스처 프로그램으로
V-1~V-3·V-5·V-6 을 CI 에서 돈다. 실제 바이너리의 V-1 은 로컬·야간 잡이다 (§9.2 R-a).

**V-13** (추가) **소비자는 에이전트를 모른다** — `check-agent-names` 가 프로토콜
어댑터 코드까지 덮고, 에이전트 도구를 다루는 소비자 코드에 에이전트 ID 분기가
없음을 grep 으로 대조한다 (FR-U-1).

---

## 7. 비목표

- **TUI 의 재구현.** 에이전트가 그리던 터미널 화면을 우리가 다시 그리지 않는다.
- **훅 제거·터미널 표면 강등.** D-U-3.
- **ACP 채택.** 세 에이전트 모두 네이티브 표면이 더 풍부하다. 네 번째 에이전트의
  폴백 후보로만 둔다.
- **자동 휴면.** (`FR-ABG-11`)
- **`dmctl notify`·OSC 감지의 개정.** D-U-8.
- **승인 타임아웃 처리.** D-U-7.
- **모바일 길게 누르기 메뉴** — 축 C 의 UI 에도 `CONTEXT_MENU_UNIFY` §6 이 그대로다.
- **CLI 출력의 번역** — 축 B 의 정책이 "범위 밖" 으로 적을 가능성이 크다 (FR-B-1 이
  결정한다).
- **Run 오케스트레이션의 에이전트 도구 전환** — 축 C 는 에이전트 도구가 Run 멤버로
  **설 수 있게** 하지만(FR-AGT-8), Run 의 기본 멤버를 바꾸거나 `LaunchLine` 계열을
  걷어내지 않는다. 그 전환은 후속 문서다.

---

## 8. 리스크

### 8.1 축 C 의 리스크

**R-1 — codex app-server 는 공식 문서가 experimental·프로덕션 미지원이라고
명시한다.** 스키마가 예고 없이 움직일 수 있다. 완화: `FR-APS-7`(어댑터 한 자리
흡수) + 대조 테스트. 잔여 위험은 받아들인다 (D-2).

**R-2 — claude stream-json 의 프레임 스키마는 공개 계약이 아니다.** §2.4 는
2.1.269 의 실측이다. 완화: R-1 과 같다.

**R-3 — ~~삭제 범위가 넓다~~ (병행으로 폐기, D-U-3). 남는 위험은 "두 표면의 공존" 이다 — 한 도구는 한 표면만 가지므로 겹치지 않으나, 어댑터가 둘(TUI·프로토콜)일 때 한쪽만 고쳐지는 것.** §2.3.7 의 목록이 13 자리이고 테스트가 그에 딸린다.
한 번에 걷으면 회귀를 어디서 잡았는지 말할 수 없다. 완화: 묶음 순서를
P → T → A → B → H 로 둔다. **훅 제거를 마지막에 한다** — 그전까지는 두 표면이
공존하며, 그동안의 중복 발화는 `FR-AAL-1` 의 L1 우선으로 막는다.

**R-4 — 에이전트 도구가 도구 모델의 첫 비-PTY 종류다.** 도구를 다루는 코드가
PTY 를 전제하는 자리가 남아 있으면 거기서 깨진다. 완화: `NewDetachedTool` 이
이미 그 경로를 지나고 있으므로(§2.3.6) 기존 테스트가 일부를 덮는다.

**R-5 — omp `--mode rpc-ui` 의 프레임 형식을 실측하지 않았다.** README 의 서술만
근거다. omp 는 릴리스가 잦다. 완화: 착수 시 실측이 선행 조건이다 (§9.1).

**R-6 — ~~터미널 표면 강등~~ (병행으로 폐기, D-U-3).** dongminal 을 쓰는
이유 중 하나가 여러 탭의 에이전트 감시다. 완화: 강등되어도 **알람은 울린다**
(`FR-AAL-20`·`21`). 잃는 것은 활동 패널과 컨텍스트 관측이다.

---

**R-7** (추가) **XL 이 길어져 중간에 멎는다.** 완화: 단계마다 출하 가능(§4) —
P1 만 끝나도 Go 부채가, P2 만 끝나도 i18n 이 가치다. 인계는 M7 의 형식.

**R-8** (추가) **두 표면의 어댑터가 한쪽만 고쳐진다.** 같은 구조체에 두면(FR-U-2)
한 파일이지만 필드가 둘이라 잊을 수 있다. 완화: 어댑터 단위 테스트가 두 표면을
같은 표에서 돈다 (`signals_test.go` 의 선례).

**R-9** (추가) **축 B 의 게이트가 축 C 의 개발을 느리게 한다.** 새 문구마다 키를
더해야 한다. 완화: 그것이 게이트의 목적이다 — 다만 `t('…')` 에 기본 문장을 함께
적는 관용(키 + 기본값)을 카탈로그 규약이 허용하면 개발 중 마찰이 준다.

### 8.2 축 C 의 가정

**AS-1** 세 프로토콜 모두 **한 프로세스가 한 세션**을 든다. 한 프로세스에 여러
세션을 다중화하는 모델은 가정하지 않는다. (codex 의 thread 모델은 여러 thread 를
허용하는 것으로 보이나, 확인하지 않았다 — §9.1)

**AS-2** 프로토콜 표면에서도 세션 신원이 디스크에 남아 **재개가 가능하다.**
claude `--resume`, codex `thread/resume` 는 문서·플래그로 확인했고, omp 는
세션 개념이 있다는 것까지만 확인했다.

**~~AS-3~~** (폐기) 사용자는 GUI 와 TUI 를 **둘 다** 쓴다 — 로그인·설정·TUI 전용 명령은 TUI 로만 된다 (R-j). 병행(D-U-3)이 이 사실 위에 선다.

**AS-4** 프레임의 양은 이벤트 로그로 감당 가능하다. §2.4 의 실측에서 1+1 질문
한 번에 약 20 프레임이 나왔다.

---

---

## 9. 미확인 · 검토 기록

### 9.1 축 C — 미확인 사실 (P0 스파이크의 대상)

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

---
| U-9 | **기능 대조표** — 세 에이전트 × TUI 기능(로그인·설정·모델 선택[기동/세션 중]·권한/plan 모드 전환·슬래시 명령·스킬/플러그인·`/compact`·`/clear`) × (프로토콜 / 파일 / TUI 출구). FR-U-4 의 근거 |
| U-10 | 세 TUI 가 내는 알림 시퀀스(claude `preferredNotifChannel=terminal_bell`, codex `tui.notifications`, omp) — D-U-3 의 선택지 C 를 보조 채널로 둘 수 있는가 |

### 9.2 초안 검토에서 나온 정정 (R-a~R-k) — 이 문서에 반영된 상태

원문 `AGENT_PROTOCOL_SURFACE_SRS` §10.1 의 표를 기록으로 남긴다. 반영 상태:
R-a → V-12 · R-b → FR-ABG-21 · R-c → FR-APS-10 · **R-d → 해당 없음**(FR-AAL-21 폐기;
`ssh`·`tmux` 안에서 훅도 못 까는 경우는 U-10) · **R-e → 해당 없음**(FR-AHR-4 폐기) ·
R-f → FR-U-5·FR-AGT-9 · R-g → P0 산출물 ④ · R-h → §4 의 P3~P5 · R-i → P0 ·
R-j → FR-U-4·FR-AGT-10 · R-k → D-U-3.


| # | 자리 | 무엇 | 왜 |
|---|---|---|---|
| R-a | V-1 · R-1·R-2·R-5 | "녹화된 픽스처가 아니라 실행" 은 **CI 에서 돌 수 없다** — 바이너리도 자격증명도 없다. 계약 드리프트 검사는 로컬·야간 잡으로 두고, CI·e2e 는 **가짜 에이전트**(세 프로토콜을 말하는 작은 Go 프로그램, `gittest` 픽스처와 같은 지위)로 돈다는 검증 전략을 §8 에 적어야 한다 | 세 표면 셋 다 불안정(experimental·비공개 계약·미실측)인데 검증이 실행 하나에 걸려 있다 |
| R-b | NFR-2 ↔ FR-ABG-4·V-3 | "무한히 자라지 않는다(잘라낸다)" 와 "빠짐없이 재생한다" 가 충돌한다. 잘린 앞부분은 **요약 스냅샷 + 이후 증분**이거나, 잘렸음을 UI 가 표시한다 — 어느 쪽인지 정한다 | 두 요구가 같은 로그를 가리키며 반대 방향이다 |
| R-c | U-3 · FR-APS-5 | claude 의 `--permission-prompt-tool` 은 **MCP 도구 서버**를 요구한다 — dongminal 이 MCP 서버를 하나 노출해야 한다. 그것은 실측 항목이 아니라 **범위 항목**이다(묶음 P 에 FR 로). 없으면 claude 의 승인 요청이 서버에 오지 않는다 | 승인 요청-응답(FR-APS-5·6, FR-AAL-3)이 이 문서의 핵심인데 claude 쪽 통로가 범위 밖에 있다 |
| R-d | FR-AAL-21 · D-1 | 전경 프로세스 판정은 `tmux`·`ssh` 안의 에이전트를 못 본다(전경이 `tmux`/`ssh`). 훅은 원격 안에서도 돌았으므로 이것은 D-1 이 잃는 것에 **더해지는** 손실이다 — D-1 의 대가 목록에 적고 받아들이거나, 등록부에 `tmux`·`ssh` 를 투명 셸로 둔다 | 터미널 표면의 알람이 "idle 하나" 에서 "idle 도 없음" 이 되는 경로가 있다 |
| R-e | FR-AHR-4 | 사용자 홈의 훅 자산을 걷어내는 것은 **사용자 설정 파일(`~/.claude/settings.json` 등)을 고치는 파괴적 조작**이다. 우리가 심은 것만(표식으로 식별) · 백업 뒤 · 보고와 함께 — M3 의 백업 규약(FR-BAK)을 지나야 한다 | 조용한 실패를 없애려다 조용한 파괴가 되지 않게 |
| R-f | FR-AGT-4 · 묶음 T | 새 UI 표면에 M7 이 세운 계약이 빠져 있다: `UIKit` 로 그린다(버튼·메뉴·모달), axe 표면에 든다(`ACCESSIBILITY_BASELINE_SRS` FR-A11Y-13 의 표면 목록), 키보드 계약(`UIKit.roving`·`dialogOpen`), 라이브 리전(승인 요청 도착), 토큰만 쓴다(게이트가 지킨다). 그리고 M9 뒤라면 **카탈로그 키로 태어난다** | M7·M9 뒤에 오는 첫 대형 UI 이므로 그 계약의 첫 적용 사례가 된다 |
| R-g | FR-AGT-3 · U-8 | 데몬 모드의 파이프 중계는 새 IPC 가 아니라 **PTY 바이트 중계와 같은 길**일 수 있다 — stdout 은 바이트열이고 해석은 서버가 한다. 실측 전에 설계 선택지로 적어 둔다 | 새 기계를 만들지 않는다는 FR-ABG-1 의 규약과 같은 방향 |
| R-h | 전체 | **규모와 조각이 없다.** XL 이며 세 조각으로 내야 한다: **M10-a** 묶음 P+T 를 **claude 하나로**(훅·터미널 표면은 손대지 않음, 두 표면 공존) → **M10-b** codex·omp 어댑터 → **M10-c** 묶음 A+B+H(훅 제거는 마지막, R-3). 조각마다 출하 가능해야 한다 | 13 자리 삭제와 새 도구 종류를 한 번에 하면 회귀를 어디서 잡았는지 말할 수 없다 (R-3 가 이미 그렇게 적었다) |
| R-i | §9 | U-1~U-8 은 **착수 전 스파이크 한 세션**으로 한꺼번에 메운다 — 그 결과가 M10 의 규모와 M8 의 설계(GO-46 `ToolHub` 인터페이스, 데몬 IPC)에 들어간다 | 실측 없이 규모를 말할 수 없다 |

| R-j | 신규 FR (묶음 T) | **에이전트 도구는 TUI 의 어떤 기능도 막지 않는다.** 프로토콜 표면은 에이전트 루프(대화·도구 호출·승인·사용량)를 주지만 로그인·설정 파일·TUI 전용 명령은 주지 않는다 — 그것들은 **같은 세션을 터미널 탭으로 여는 출구**(`claude --resume <id>` 등)로 간다. M10-0 스파이크가 **기능 대조표**(에이전트 셋 × TUI 기능 × 프로토콜/파일/TUI 출구)를 실측으로 채운다 | 사용자 요구(2026-09-13): *"설정·로그인·모델 선택 등 TUI 의 모든 기능을 그대로 쓸 수 있어야 한다"* — 프로토콜만으로는 성립하지 않고 하이브리드로만 성립한다 |
| R-k | D-1 · 묶음 A·H | **병행으로 간다 — 훅을 지우지 않는다** (사용자 결정 2026-09-13, 아래 §10.2). 에이전트 도구는 프로토콜, 터미널 도구는 지금의 훅 그대로. TUI 가 상시 경로(R-j)이므로 그쪽 알람을 강등할 수 없다. 묶음 H(FR-AHR-1~5)와 묶음 A 의 삭제 조항(FR-AAL-10·11·12·20·21·22·30)은 **폐기**. 한 도구는 한 표면만 가지므로 두 신호 체계가 겹치지 않는다(에이전트 도구에는 PTY 가 없어 훅이 돌 자리가 없다) | D-1 의 전제 AS-3 가 R-j 로 무너졌다 |

---

## 10. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-13 | 초안. 로드맵 §M8·§M9·§M10 과 `AGENT_PROTOCOL_SURFACE_SRS` 를 흡수해 **하나의 일정** 으로 (D-U-1). 사용자 결정 둘 — 어댑터가 인터페이스(D-U-2) · 병행(D-U-3). 원문의 묶음 H 와 묶음 A 삭제 조항 폐기. 추가 요구: FR-U-1~7 · FR-APS-9·10 · FR-AGT-8·9·10 · FR-ABG-21 · FR-B-1~10 · V-10~13 |
