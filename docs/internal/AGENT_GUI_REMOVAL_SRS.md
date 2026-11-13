# 에이전트 GUI 제거 — SRS

> **문서 상태**: 승인·구현완료

IEEE 29148 준수. 작성 2026-09-16.

## 1. 서론

### 1.1 목적

에이전트 GUI(`AgentPane` 탭, `type:'agent'`, `toolhub.KindAgent`, `/api/agent/*`,
`domain/agentsess`)를 코드베이스에서 제거한다. 남는 것은 **어댑터**
(`internal/shared/agentadapter`) 한 벌이다.

### 1.2 범위

제거 대상은 **에이전트를 GUI 대화 뷰로 직접 구동하는 길** 전체다. 제거하지 않는 것은
① 어댑터 패키지, ② 훅 기반 활동 패널·주의 알림, ③ 실행(run) 오케스트레이션이다.

### 1.3 배경 — 왜 지우는가

에이전트 GUI 는 터미널 도구와 나란히 서는 **두 번째 도구 종류**를 만들었다.
그 종류 하나 때문에 toolhub(PTY 없는 파이프 도구), 지속화(되살리지 않는 도구),
주의(L2 idle 제외), 붙여넣기(무동작), 데몬 IPC(큐 분기), 프론트 배치·포커스·슬롯이
전부 분기를 들었다. 얻은 것에 비해 **복잡도 비용이 크다**. 어댑터가 낸 이벤트 추상은
활동 보고·컨텍스트 창·실행 오케스트레이션이 이미 쓰고 있으므로 그것만 남긴다.

### 1.4 용어

| 용어 | 뜻 |
|------|-----|
| 에이전트 GUI | `type:'agent'` 탭과 그 뷰 `AgentPane`. xterm 대신 대화 뷰가 선다 |
| 어댑터 | `agentadapter` — 에이전트별 프로토콜·훅·전사본 해석. **남는다** |
| 해석층 | `domain/agentsess` — 프로토콜 프레임을 화면 이벤트로 옮기는 층. **지운다** |
| 활동 패널 | 툴바 `Agents` 버튼이 여는 `#agents-panel`. 훅이 보고한 활동 카드. **남는다** |
| 올리기(lift) | 셸에서 도는 에이전트 세션을 GUI 탭으로 여는 길. **지운다** |

## 2. 전체 기술

### 2.1 확정된 경계 (사용자 결정 2026-09-16)

| # | 물음 | 결정 |
|---|------|------|
| D-1 | 훅 기반 활동 패널 | **유지** — GUI 탭이 아니라 터미널 에이전트의 활동이다. 배선이 분리돼 있다 |
| D-2 | 올리기 버튼 + 세션 신원 저장소 | **둘 다 제거** — 목적지가 사라지고, 저장소의 유일한 독자가 `handlers_agent.go` 였다 |
| D-3 | `agentApprovalMode` 설정 | **제거** — 유일한 소비자가 GUI 탭 생성이다 |

### 2.2 이전 동작 / 새 동작

| | 이전 | 새 |
|---|------|-----|
| 탭 종류 | `terminal` · `agent` 둘 | `terminal` 하나 |
| 도구 종류 | `KindTerminal` · `KindAgent` 둘 | `KindTerminal` 하나 |
| 에이전트 구동 | GUI 대화 뷰 **또는** 터미널 셸 | 터미널 셸만 |
| 터미널의 올리기 버튼 | 세션이 잡히면 선다 | 서지 않는다 |
| `dmctl new-tab --agent <id>` | 에이전트 GUI 탭을 연다 | **플래그가 없다** |
| 설정 ▸ 에이전트 승인 정책 | 드롭다운이 있다 | 없다 |
| 활동 패널·주의 알림 | 훅으로 온다 | **그대로** |

### 2.3 비목표

- 어댑터(`agentadapter`)의 축소·정리. 쓰이지 않게 되는 심볼도 **그대로 둔다** (사용자 지시). **개정(D-4, §6)**: 2차 개정에서 프로토콜 표면을 지운다.
- 실행(run) 오케스트레이션, 헤드리스 실행, 컨텍스트 창 관측의 변경.
- 기존 SRS 문서(M8~M12)의 수정. 그것은 **기록**이며 이 문서가 그 위에 선다. **개정(D-5, §6)**: GUI 가 주제인 문서는 `archive/` 로 옮긴다.

## 3. 요구사항

### FR-AGR-1 — 프론트엔드 에이전트 뷰가 없다

`web/js/ui/agent-pane.js` · `web/js/core/app-agent-tool.js` 를 지우고
`web/index.html` 의 두 `<script>` 를 뺀다. `app.agentPanes` · `mkAgent` ·
`agentMenuItems` · `agentOpenTerminal` · `agentLiftFromTerminal` · `_agentList` ·
`_newAgentTool` · `_agentResyncAll` · `_onAgentEvent` 을 참조하는 모든 자리를 제거한다.

### FR-AGR-2 — 탭 종류 `agent` 가 없다

`renderer.js`(배치·복원·메뉴), `app-tool.js`(생성·정리), `app-slots.js`(슬롯 정리),
`app-layout.js`(`addTab`), `app-cmd.js`(SSE 구독·WS 제외·`--agent` 인자)에서
`type==='agent'` · `kind==='agent'` 분기를 제거한다. 모르는 `--agent` 플래그는
`dmctl new-tab` 에서 사라진다.

### FR-AGR-3 — 올리기 경로가 없다

`term-pane.js` 의 `liftBtn` · `refreshLift` · `GET /api/agent/session` 호출,
`app-agents.js` 의 `_noteLiftable`, `.tp-lift` 규칙을 제거한다.
`term.lift_to_agent*` 카탈로그 키를 지운다.

### FR-AGR-4 — 승인 정책 설정이 없다

`helpers.js` 의 `agentApprovalMode`, `app-settings.js` 의 접근자와
`_initAgentApproval` 호출, `app-settings-init.js` 의 `_initAgentApproval`,
`settings-schema.js` · `internal/shared/settingsschema` 의 키,
`index.html` 의 `ds-agent-approval` 블록, `html.agent_approval*` 키를 제거한다.

**보존 설정**: `agentsPollInterval`(활동 패널 폴링)은 **남는다** — 이름이 비슷할 뿐
다른 것이다.

### FR-AGR-5 — 문구 카탈로그에서 `agent.*` 가 빠진다

`web/js/i18n/ko.js` · `en.js` 의 `agent.*` 키 109개와 `term.lift_to_agent*` ·
`html.agent_approval*` 를 지운다. `agent.open_terminal` 을 읽던
`constants.js` 의 `AGENT_OPEN_TERMINAL` 도 함께 사라진다.

**보존 키**: `poll.agents.*` · `shortcut.agents_toggle` · `runs.*` 는 활동 패널과
실행의 것이다.

### FR-AGR-6 — 스타일시트에서 `agp-*` 가 빠진다

`web/style.css` 의 `.agent-pane` · `.agp-*` · `.tp-lift` 규칙을 지운다.

### FR-AGR-7 — HTTP 표면 `/api/agent/*` 가 없다

`handlers_api.go` 에서 라우트 11개(`/api/agents` 포함)를 빼고
`internal/webserver/httpapi/handlers_agent.go` · `server_agentsess.go` 를 지운다.
`POST /api/tools?kind=agent` 분기도 사라진다 — 그 질의는 알 수 없는 kind 로 떨어진다.

### FR-AGR-8 — 해석층이 없다

`internal/webserver/domain/agentsess/` 전체를 지운다. 소비자는
`handlers_agent.go` 하나였다.

### FR-AGR-9 — 세션 신원 저장소가 없다 (D-2)

`Server.agentSessions` · `AgentSessionInfo` · `noteAgentSession` ·
`endAgentSession` · `transcriptFor` · `AgentSession` 을 지우고,
`handlers_attention.go` · `handlers_runs_context.go` 의 호출 지점을 제거한다.

**주의**: 두 핸들러가 받는 요청 본문의 `sessionId` · `agent` · `transcriptPath`
필드는 **와이어 호환을 위해 남긴다** — 훅이 이미 실어 보내며, 필드를 빼면 훅과
서버가 어긋난다. 서버가 그것을 **저장하지 않을 뿐**이다.

### FR-AGR-10 — `toolhub.KindAgent` 가 없다

`hub.go` 의 `KindAgent` 상수와 `manager_create.go` · `tool.go` · `persist.go` ·
`bracketpaste.go` · `tool_attention.go` · `daemon/ipc/paned_handlers.go` 의
분기를 제거한다. `Placement.Pipe` 와 `platform.StartPipe` 경로도 유일한 호출자가
사라지므로 함께 제거한다.

`Tool.Kind` 필드 자체는 **남긴다** — 와이어(`kind`)에 실려 나가고 있고, 단일 값이
되어도 그 표면을 깨지 않는다.

### FR-AGR-11 — 오류 코드에서 에이전트 계열이 빠진다

`apierr` 의 `CodeAgentUnknown` · `CodeAgentNoProto` · `CodeAgentBinMissing` ·
`CodeAgentNoSession` · `CodeApprovalNotOpen` · `CodeAgentUnsupported` ·
`CodeAgentNoIdentity` · `CodeAgentDormant` · `CodeAgentNotDormant` 와 그 설명을
지운다.

### FR-AGR-12 — 어댑터는 그대로다

> **개정(2026-11-13, D-4)**: FR-AGR-17~20 이 이 요구를 대체한다. 아래 본문은 1차 제거 때의 기록이다.

`internal/shared/agentadapter/` 는 **한 줄도 고치지 않는다** — 하위
`fakeagent` 포함. 이미 `dmctl_activity` · `dmctl_run_subs` ·
`runtime/install` · `run/context_window` · `run/store_write` ·
`handlers_attention` · `handlers_status` 가 쓰고 있고, 쓰이지 않게 되는 심볼도
남긴다(사용자 지시 — 이벤트를 나중에 쓸 수 있다).

### FR-AGR-13 — `dmctl new-tab --agent` 가 없다

플래그와 그 해석(`dmctlParsed.agent`·`buildArgs`), `docs/external/commands.md` 의
줄과 예시를 제거한다. `dmctl run member --agent` 는 **남는다** — 그것은 실행
오케스트레이션의 역할 표시이며 GUI 와 무관하다.

### FR-AGR-14 — 인계 명령서의 `gui` 갈래가 없다

`internal/shared/runtime/agentplugin/commands/migration.md` 는 표면을 둘로 갈라
`gui` 쪽에서 `--agent` 탭을 열고 `/api/agent/events` 로 배달을 진단했다. 그 갈래를
지우고 `cli` 하나로 편다 — 없는 종단을 안내하는 명령서는 읽는 에이전트를 404 로
보낸다. `skills_contract_test.go` 의 두 계약도 함께 좁힌다.

### FR-AGR-15 — e2e 의 가짜 에이전트 배선이 없다

`global-setup.ts` 가 매 실행 `fakeagent` 를 빌드해 `E2E_AGENT_BIN_DIR` 에 세 이름으로
놓고 `fixtures.ts` 가 그 경로를 서버에 줬다. 소비자가 사라졌으므로 배선을 걷는다 —
`fakeagent` **패키지 자체는 남는다** (FR-AGR-12, `drift_test.go` 가 쓴다).

### FR-AGR-16 — 테스트가 따라 빠진다

삭제: `e2e/agent-tool.spec.ts` · `e2e/agent-input-keys.spec.ts` ·
`e2e/lift-button-reload.spec.ts` · `web/js/test/agent-{lift,slash,usage}.test.mjs` ·
`httpapi/agent_api_test.go` · `agent_dormant_test.go` · `agent_history_test.go` ·
`agent_message_test.go` · `agent_prompt_limit_test.go` ·
`httpapi/activity_identity_test.go` · `toolhub/agentkind_test.go` ·
`platform/pipe_test.go`.

수정: 남는 테스트에서 GUI 를 전제한 단언만 덜어낸다. 활동·주의·폴링·테마·실행의
단언은 손대지 않는다.

## 4. 검증

| ID | 층 | 내용 |
|----|-----|------|
| V-AGR-1 | build | `go build ./...` · `go vet ./...` 통과 |
| V-AGR-2 | unit | `go test ./...` 통과 |
| V-AGR-3 | lint | `npx eslint` 통과 — 정의되지 않은 전역(`AgentPane` 등) 참조가 없다 |
| V-AGR-4 | grep | 소스에 `AgentPane` · `agentPanes` · `/api/agent/` · `KindAgent` · `agentsess` · `agentApprovalMode` 가 남지 않는다 (docs 제외) |
| V-AGR-5 | make gates | 생성물(`docs/external/errors.md`·`decisions.md`)과 문서 검사(api-docs·commands-docs·srs-status·i18n·css-vars) 전부 통과 |
| V-AGR-6 | e2e | 전량 통과. 특히 `activity` · `attention*` · `poll-interval` · `runs` · `terminal` 이 이전과 같이 돈다 |

## 5. 리스크

| 리스크 | 등급 | 완화 |
|--------|------|------|
| 지속화된 `tools.json` 에 남은 에이전트 도구 | LOW | 애초에 기재하지 않았다 (`persist.go` 가 걸렀다) — 되살릴 레코드가 없다 |
| 저장된 설정의 `agentApprovalMode` 잔여 키 | LOW | 스키마에서 빠진 키는 무시된다 (기존 규약) |
| 훅이 계속 보내는 `sessionId`·`transcriptPath` | LOW | FR-AGR-9 — 필드를 남기고 저장만 하지 않는다 |
| 활동 패널 회귀 | MEDIUM | V-AGR-5 의 `activity`·`attention*` e2e 가 문지기다 |

## 6. 2차 개정 — 프로토콜 표면 제거 (2026-11-13)

### 6.1 배경

1차 제거는 어댑터의 프로토콜 표면(`Adapter.Proto`)을 남겼다(FR-AGR-12). 그 뒤 운영 코드에서
그 표면을 부르는 곳이 하나도 없다. 시험과 `fakeagent` 만 부른다. `CLAUDE_ACCOUNTS_SRS`
FR-CAC-84 가 이 표면(`claudeProtoLaunch`)에 기능을 더하라고 요구해서, 남은 표면이 새 작업을
잘못 이끌었다.

### 6.2 결정

| # | 물음 | 결정 |
|---|------|------|
| D-4 | 어댑터의 프로토콜 표면 | **제거** — 사용자 결정(2026-11-13): "GUI 는 완전 폐기다. 코드나 문서에 남아 있으면 함께 지운다". FR-AGR-12 와 §2.3 의 첫 비목표를 대체한다 |
| D-5 | GUI 를 설명하는 문서 | GUI 가 주제인 문서는 `docs/internal/archive/` 로 옮긴다. 현행 문서(구조 설명·색인)는 GUI 설명을 지운다. 지나가며 언급하는 지난 문서는 기록으로 둔다 — 사용자 결정(2026-11-13) |

### 6.3 이전 동작 / 새 동작

| | 이전 | 새 |
|---|------|-----|
| `Adapter.Proto` | claude·codex·omp 가 프로토콜 표면을 선언한다 | 필드가 없다 |
| `Adapter.ParseHistory` | claude 가 전사본 한 줄을 화면 이벤트로 옮긴다 | 필드가 없다 |
| `fakeagent` | 프로토콜 표면을 흉내 내는 가짜 에이전트 | 없다 |
| 훅·활동 보고, 전사본 사용량, 컨텍스트 창, 정책 주입 선언 | 있다 | **그대로** |

사용자가 보는 동작은 바뀌지 않는다. 지우는 것은 아무도 부르지 않는 코드다.

### FR-AGR-17 — 어댑터에 프로토콜 표면이 없다

`internal/shared/agentadapter/` 에서 다음을 지운다.

- `Adapter.Proto`·`Adapter.ParseHistory` 필드와 claude·codex·omp 의 그 값.
- `proto.go`(`Proto`·`LaunchOpts`·`ProtoState`·`Event`·`EventKind`·`ApprovalRequest`·`Decision`·
  `ToolEdit` 등 프로토콜 어휘 전부와 `HasProto`).
- `claude_proto.go`·`codex_proto.go`·`omp_proto.go`·`claude_decode.go`·`codex_decode.go`·
  `omp_decode.go`.
- `claude.go` 의 대화 뷰용 주석 함수 `claudeAnnotateBlocks`·`claudeToolView`·`claudeToolEdit`.
  훅이 쓰는 `claudeToolDetail` 은 **남는다**.

### FR-AGR-18 — `fakeagent` 가 없다

`internal/shared/agentadapter/fakeagent/` 전체(실행 파일 `cmd` 포함)와 그것을 쓰는
`drift_test.go` 를 지운다.

### FR-AGR-19 — 남는 것

훅 해석(`HookParse`)·활동 신호(`Signals`)·준비 판정(`Readiness`)·기동줄(`LaunchLine`·
`BareLaunchLine`)·정책 주입 선언(`PolicyInjection`)·설치 자산·전사본 사용량(`ParseUsage`)·
컨텍스트 창(`ContextWindow`)은 바꾸지 않는다.

### FR-AGR-20 — 시험이 따라 빠진다

삭제: `claude_proto_test.go`·`codex_proto_test.go`·`omp_proto_test.go`·`proto_common_test.go`·
`proto_test.go`·`drift_test.go`·`tool_view_test.go`·`claude_commands_test.go`·
`claude_attach_test.go`·`claude_history_test.go`·`claude_hygiene_test.go`, 그리고
`omp_test.go` 의 `TestOmpProto_*` 두 건.

### FR-AGR-21 — 문서 (D-5)

- `archive/` 로 옮긴다: `AGENT_PROTOCOL_SURFACE_SRS.md`·`production/M9_P7_GUI_SURVEY.md`.
  옮긴 문서를 가리키는 링크는 새 자리로 고치고 `decisions.md` 를 다시 만든다.
- `M8_UNIFIED_SRS.md`·`production/M8_PROGRESS.md` 는 Go 부채·국제화(언어 정책 원문 §3.3)를
  함께 다루므로 옮기지 않는다. 프로토콜 표면 절에 이 개정을 가리키는 표시만 단다.
- `architecture.md`·`docs/internal/README.md` 에서 프로토콜 표면·`fakeagent` 설명을 지운다.
- `CLAUDE_ACCOUNTS_SRS` FR-CAC-84 를 "해당 없음"으로 고친다.

### 6.4 검증

| ID | 층 | 내용 |
|----|-----|------|
| V-AGR-7 | unit | `adapter_test.go` `TestNoProtocolSurface` — `Adapter` 에 `Proto`·`ParseHistory` 필드가 없고, 패키지 폴더에 `*_proto.go`·`*_decode.go`·`proto.go`·`fakeagent/` 가 없다 |
| V-AGR-8 | build·unit·lint | `go build ./...`·`go vet ./...`·`go test ./...`·`golangci-lint` 통과 |
| V-AGR-9 | make gates | 문서 검사(링크·srs-status) 포함 전부 통과 |
