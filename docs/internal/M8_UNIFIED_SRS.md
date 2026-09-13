# SRS: M8 통합 일정 — Go 부채 · 국제화 · 에이전트 프로토콜 표면 (IEEE 29148)

> **문서 상태**: 승인·구현중

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

**실측 정정 (2026-09-13, P2 착수 — 위 수치는 2026-09-09 감사다):**

| 항목 | 감사(09-09) | 실측(09-13) | 비고 |
|---|---|---|---|
| `constants*.js` | 5파일 2,737줄 | **12파일 3,020줄** — 한국어 문자열 리터럴 **630줄** | M6 묶음 D 가 git 버킷을 8파일로 갈랐다 |
| JS 한국어 리터럴(constants 밖) | 77파일 241줄 | **31파일 254줄** (주석 제외, 문자열·템플릿 리터럴만) | `runs-panel.js` 47 · `helpers.js` 34 · `app-backup.js` 23 … |
| JS 합 | — | **43파일 884줄** | 이것이 FR-B-3 의 분모다 |
| `index.html` 정적 문구 | 178줄 | **주석 밖 72줄** (주석 포함 273) | 감사는 주석을 함께 셌다 |
| CSS `content` 문구 | 3곳 (`style.css:376,772,818`) | **3곳 — `style.css:508`(ko)·`:900`(en `Drop files here`)·`:964`(ko)** | 줄 번호만 낡았다 |
| 서버 `http.Error` 한국어 | 6곳 | **0곳** — M5 `G6-1` 이 전부 `httpErr` 로 옮겼다. `httpErr` 의 한국어 본문은 **9곳 5문장** (`handlers_tools_kill.go`×3 · `handlers_attention.go`×2 · `focus.go`×2 · `handlers_api.go`×2) | fs·git 방언의 JSON 본문 한국어 100+ 는 **코드가 이미 있고** 프론트가 코드로 문장을 고른다 (`ED_FS_ERR`·`GIT_WRITE_ERR`) — FR-B-8 의 범위 밖 |
| `Intl`·`navigator.language` | 0 | 0 | |
| e2e 의 한국어 텍스트 단정 | — | **151곳 / 155스펙** | 기본 로케일이 ko 여야 하는 실무적 근거 (FR-B-1) |

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

**P4 재실측 (2026-09-13, codex 0.154.0 · omp 17.4.0 — 자격증명 없음, 무모델 프레임).** 드라이버는
P0 의 것(`/tmp/m8-spike/drive.py`), 원본은 `/tmp/m8-spike/p4/*.jsonl`. 턴 의존 칸은 P0 과
같이 **미확인 — 자격증명 없음** 이며 그 칸은 스키마(codex `generate-json-schema`)·소스(omp
`rpc-types.ts`·`wrapper.ts`·`pi-ai/types.ts`)로 채웠다. `drift_test.go`(`-tags agentdrift`)가
아래 "실측" 칸을 실제 바이너리로 다시 잰다.

| 프레임 | codex `app-server` (JSON-RPC 2.0) | omp `--mode rpc-ui` (NDJSON) | 근거 |
|---|---|---|---|
| 기동·핸드셰이크 | `initialize`→`initialized`→`thread/start{cwd,model?,approvalPolicy?}` 를 **응답을 기다리지 않고 한 번에** 보내도 순서대로 처리된다. 요청 id 는 문자열이어도 된다 (`"dm-1"`). 빈 줄은 무시된다 | 기동 즉시 `ready{protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576}` → `extension_ui_request{setWidget}` → `available_commands_update{commands[]}`. `negotiate_protocol 2` 는 선택 — 안 하면 큰 프레임을 omp 가 줄여서(compact·shrink·overflow) 보낸다 | 실측 |
| 세션 신원·모델 | `thread/start` 응답 `{thread{id,model,status,path},model,approvalPolicy,sandbox{type}}` — `cwd` 를 안 실으면 프로세스 cwd, `approvalPolicy` 를 안 실으면 설정 기본(`on-request`, sandbox `readOnly`). **부작용 없음** — `approvalPolicy`·`sandbox` 를 싣지 않으면 `~/.codex/config.toml` 에 신뢰 항목이 쓰이지 않는다 (P0 의 §9.3 ⑦ 부작용은 그 인자를 실었을 때였다) | `get_state` 응답 `data{sessionId,model{id,provider,name,contextWindow},contextUsage{tokens,contextWindow,percent},thinkingLevel,isStreaming}` | 실측 |
| 모델 목록 | `model/list` 응답 `data[{id,model,displayName,description,hidden,supportedReasoningEfforts[]}]` — **자격증명 없이도 온다** (원격 갱신 실패는 stderr 401 로만) | `get_available_models` 응답 `data.models[{id,name,provider,contextWindow,…}]` (11개). `set_model{provider,modelId}` 응답이 모델 객체, 없는 모델은 `success:false,error:"Model not found: p/m"` | 실측 |
| 턴 | `turn/start{threadId,input[{type:text,text}],model?,approvalPolicy?}` → 응답 `{turn{id,status:inProgress}}` → `thread/status/changed{active}` → `turn/started` → `item/started·completed{userMessage}` → (모델 없음: `thread/status/changed{systemError}` · `error{error{message,codexErrorInfo:unauthorized},willRetry:false}` · `turn/completed{turn{status:failed,error{message}}}`). `turn/start` 의 `model` 은 세션 파일에 남아 재개 때 `warning` 알림으로 되읽힌다 | `prompt{message}` → 즉시 `response{success}` → `agent_start` → `turn_start` → `message_start/end{role:user}` → `message_start{role:assistant}` → (모델 없음: `message_end{stopReason:"error",errorStatus:401,errorMessage}` · `turn_end` · `agent_end{messages[]}`). 스트리밍 중의 `prompt` 는 `streamingBehavior` 가 있어야 받는다 | 실측 (오류 턴) |
| 텍스트·추론 델타 | `item/agentMessage/delta{delta,itemId}` · `item/reasoning/summaryTextDelta{delta,summaryIndex}` · `item/reasoning/textDelta` · 완료 `item/completed{item{type:agentMessage,text}}` | `message_update{assistantMessageEvent{type:text_delta\|thinking_delta\|toolcall_end{toolCall{id,name,arguments}},delta}}` · `message_end{message{role:assistant,content[{text}\|{thinking}\|{toolCall}],usage{input,output,cacheRead,cacheWrite,cost{total}},stopReason,model,provider}}` | 미확인 — 자격증명 없음 (스키마·소스) |
| 도구 호출·결과 | `item/started·completed{item{type:commandExecution,id,command,cwd,status,exitCode,aggregatedOutput}}` · `fileChange{changes[{path,kind,diff}],status}` · `mcpToolCall{server,tool,status,error}` · `contextCompaction` | `tool_execution_start{toolCallId,toolName,args}` · `tool_execution_end{toolCallId,toolName,result,isError}` · `message_end{message{role:toolResult,toolCallId,toolName,content[],isError}}` | 미확인 (스키마·소스) |
| **승인 요청** | 서버→클라 요청 `{id,method:"item/commandExecution/requestApproval",params{itemId,command,cwd,reason,proposedExecpolicyAmendment[],threadId,turnId}}` — 답 `{id,result{decision:"accept"\|"acceptForSession"\|{acceptWithExecpolicyAmendment{execpolicy_amendment[]}}\|"decline"\|"cancel"}}` · `item/fileChange/requestApproval{itemId,reason,grantRoot}` (같은 decision) · `item/permissions/requestApproval{permissions,reason}` — 답 `{permissions,scope:turn\|session}` · `item/tool/requestUserInput{questions[{id,header,question,options[{label,description}]?}]}` — 답 `{answers{<id>{answers[]}}}`. 우리가 답하지 않고 닫히면 `serverRequest/resolved{requestId}`. `id` 는 숫자일 수 있다 — 그대로 되돌린다 | `extension_ui_request{id,method:"select",title:"Allow tool: <name>\n<details>",options:["Approve","Deny"]}` — 답 `extension_ui_response{id,value:"Approve"\|"Deny"}`. 승인 아닌 위젯도 같은 프레임: `select`(일반 선택 — `ask` 도구가 이것) · `confirm{title,message}`→`{confirmed}` · `input{title,placeholder?}`·`editor{title,prefill?}`→`{value}` · `notify{message,notifyType}`·`open_url{url}`·`setWidget`·`setStatus`·`setTitle`·`set_editor_text`(답 없음). 취소는 `{cancelled:true}` | 미확인 — 자격증명 없음 (스키마 · `wrapper.ts:332`·`rpc-types.ts:373`·`ask.ts:521`) |
| 사용량 | `thread/tokenUsage/updated{tokenUsage{last{inputTokens,cachedInputTokens,outputTokens,…},total{…},modelContextWindow}}`. 비용은 없다 | `message_end.message.usage{input,output,cacheRead,cacheWrite,totalTokens,cost{total}}` · `get_state.contextUsage` (라이브: 15,685/1,048,576) · `get_session_stats` | 실측(omp) · 스키마(codex) |
| 세션 중 제어 | **없다** — 모델·정책은 다음 `turn/start{model,approvalPolicy}` 의 것 ("이후 턴에도 적용"). 반영은 `thread/settings/updated{threadSettings{model,approvalPolicy,…}}` | `set_model{provider,modelId}` · `set_thinking_level{level}` (`high` 성공) · `/model` 프롬프트 → `command_output{text:"Current model: p/m"}` + `response{data.agentInvoked:false}`; 슬래시 명령이 설정을 바꾸면 `config_update{model,thinkingLevel}`. 승인 정책의 세션 중 전환은 **없다** | 실측 |
| 인터럽트 | `turn/interrupt{threadId,turnId}` — 진행 중 턴이 없으면 `error{code:-32600,message:"no active turn to interrupt"}` | `abort` → `response{success}` (진행 중이 아니어도 성공) | 실측 |
| 재개 | `thread/resume{threadId}` → `thread/status/changed{idle}` + 응답의 `thread` 메타 + `deprecationNotice`(전량 하이드레이션) + 모델이 다르면 `warning`. 잘못된 id 는 `error{"invalid session id…"}`. **주의**: 이미 살아 있는 프로세스에 `thread/start` 를 다시 보내면 새 thread 가 선다 — 서버 재시동의 되살림(AgentAdoptExisting)은 그 프로세스의 thread 를 잃는다 (P5 의 휴면·재개에서 신원을 디스크에 남겨야 한다) | `--resume <id 접두>` → `ready` 부터 같은 `sessionId`(`get_state`). 없는 id 는 **exit 1** + stderr `Session "…" not found.` | 실측 |
| 종료 | stdin EOF → exit 0, **0.04~0.07s** | stdin EOF → exit 0, **0.01~0.06s** | 실측 (드라이버·drift_test) |
| 알려진 알림(무시) | `remoteControl/status/changed` · `mcpServer/startupStatus/updated` · `thread/goal/cleared` · `deprecationNotice` · `warning` · `account/*` — 90여 종이 스키마에 있다 | `notice{level,message}`(xd:// 마운트) · `model_changed`(본문 없음) · `thinking_level_changed` · `setWidget{autoresearch}` | 실측 |

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

**2.1.270 재실측 (2026-09-13, P0)** — 위 표에 더해: `system:status`(`requesting` ·
`permissionMode` · `compact_result`) · `system:permission_denied` · `system:compact_boundary`
(`compact_metadata{pre_tokens,post_tokens,…}`) · `conversation_reset{new_conversation_id}`
(`/clear` — **세션 id 가 바뀐다**) · `control_request`/`control_response`(승인 `can_use_tool`
과 호스트→CLI 제어 `initialize·set_model·set_permission_mode·set_max_thinking_tokens·
mcp_status·interrupt`) · `user`(도구 결과·`<local-command-stdout>`) · `init.capabilities/
terminal_slash_commands/messaging_socket_path` · `result.terminal_reason/stop_reason`.
전부 §9.3 ⑥ F-2.

**2.1.270 P3 재실측 (2026-09-13, P3 착수)** — 같은 판이고 위 표와 어긋나는 프레임은 없다. 더 확정한
것 둘: ① `AskUserQuestion` 은 `can_use_tool` + `requires_user_interaction:true` 로 오고 payload 는
`input.questions[{question,header,options[{label,description}],multiSelect}]` 다. 답은 `behavior:"allow"` +
`updatedInput.answers{<question>:<label>}` **한 프레임**이며 `user` 의 `tool_result` 가 그 답을 되읊는다
(FR-AGT-4 의 "질문 답변"). ② `control_response.response.updatedPermissions:[<permission_suggestions 의 항목
그대로>]` 를 실으면 CLI 가 그것을 적용한다 — `setMode` 를 실었을 때 `system:status{permissionMode:"acceptEdits"}`
가 뒤따르고 같은 세션의 다음 `Bash` 는 요청 없이 돌았다. 그러므로 승인 다이얼로그의 선택지는
`allow` · `deny` · **`permission_suggestions` 각 항목**이며 우리가 접거나 늘리지 않는다 (FR-AGT-5).

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
| FR-B-8 | ~~서버의 한국어 `http.Error` 6곳이 오류 코드로 바뀌고~~ **(정정 2026-09-13: `http.Error` 한국어는 M5 가 0 으로 만들었다)** 핵심 표면의 오류 응답은 `X-Error-Code` 가 문장의 열쇠다 — 프론트가 `r.text` 대신 `err.<code>` 카탈로그 문장을 보이고(`apiErrText`), 서버 본문은 D-ERR-2 로 동결되며 새 한국어 본문은 게이트가 막는다 (`G7-4`, `ERROR_CONTRACT_SRS` 의 규약). | 필수 |
| FR-B-9 | 혼용(`index.html:268,274` 한국어 vs `:286,294` 영어)이 **카탈로그 데이터 교정만으로** 해소된다 — 코드 변경 0 이 외부화의 증거다 (`UX-20`). | 필수 |
| FR-B-10 | 축 C 의 새 UI(대화·도구 호출·승인·사용량·TUI 출구)는 **처음부터 키**다. 게이트가 그것을 잡는다. | 필수 |

**FR-B-1 의 결정 (사용자 결정 2026-09-13 — 안 A)**

| 항목 | 결정 |
|---|---|
| 지원 로케일 | `ko` · `en` |
| 기본 로케일 | `ko` |
| 감지 규칙 | **`navigator.language` 를 쓰지 않는다.** 설정 키 `locale`(`ko`\|`en`)이 유일한 원천이다 — 단일 사용자 제품(결정 7)이고, 감지를 넣으면 e2e 155스펙이 브라우저 로케일에 의존한다 |
| 폴백 | 활성 로케일에 없는 키는 `ko` 문장으로 표시하고 `console.warn` 한 번(키마다). `ko` 에도 없으면 **키 자체**를 표시하고 경고한다 |
| `en` 카탈로그 | **전수 번역** — 폴백은 기계적 안전망이지 설계가 아니다 (`scripts/check-i18n.mjs` 가 ko·en 키 집합의 일치를 잡는다) |
| 전환 | 설정을 저장하면 `localStorage['dm.locale']` 에 비추고 **페이지를 다시 연다** (D-B-1) |
| 범위 밖 | CLI 출력(`dmctl`·`dongminal`) · 서버 로그 · `SETTINGS_SCHEMA` 의 `where`(문서 필드, Go 가 같은 바이트를 읽는다) · e2e·단위 테스트의 문자열 |
| 서버 오류 | 본문은 **바뀌지 않는다**(D-ERR-2). `X-Error-Code` 가 문장의 열쇠이고 문장은 프론트 카탈로그(`err.<code>`)가 든다 (FR-B-8 정정) |
| 툴팁 | FR-TIP-2(`title` 은 영어)는 **ko 카탈로그의 데이터**로 유지된다 — 규약을 바꾸는 것은 카탈로그 diff 한 번이다 |

**키 규약 (FR-B-2)**

- 키는 `seg(.seg)+` 이고 `seg` 는 `[a-z0-9_]+` 다. 첫 세그먼트가 **네임스페이스**다.
- 네임스페이스: `core`(`constants.js`) · `git`(`constants-git*.js`) · `editor`(`constants-editor.js`) ·
  `docrender` · `html`(`index.html` 정적 문구 — `html.<영역>.<이름>`) · `err`(서버 오류 코드 →
  문장, 키의 둘째 세그먼트가 곧 `X-Error-Code`) · 그 밖은 화면 단위(`runs`·`bg`·`attn`·`backup`·
  `acl`·`sbx`·`presets`·`keys`·`diag`·`term`·`shortcut`·`statusbar`·`poll`·`boot`).
- 상수 하나가 키 하나다: `const GIT_ACT_TITLE=t('git.act_title')` — 이름을 소문자로 내리고 네임스페이스
  접두(`GIT_`·`ED_`·`DOC_RENDER_`)를 뗀다. 객체·배열 값은 `ns.name.prop` 으로 펼친다.
- 자리표시자는 `{name}` 이다. `t(key, params)` 가 `params[name]` 을 문자열로 치환한다. 치환되지
  않은 자리표시자는 그대로 남는다(결함이 보인다).
- 복수형: `tn(key, n, params)` 가 `Intl.PluralRules(locale).select(n)` 으로 `key.one`/`key.other`
  를 고른다(없으면 `key.other`). `{n}` 은 자동으로 들어간다. `ko` 는 `.other` 만 둔다.
- 카탈로그 파일은 `web/js/i18n/<locale>.js` 하나씩이고 `I18N.register('<locale>', {…})` 한 호출이다.
  읽는 함수는 `t`·`tn` 둘(`web/js/core/i18n.js`)이며 `constants.js` **앞**에 선다.
- `index.html` 의 정적 문구는 `data-i18n`(텍스트) · `data-i18n-title` · `data-i18n-placeholder` ·
  `data-i18n-aria-label` 속성에 키를 적고 `I18N.apply(root)` 가 채운다. 단축키를 품는 툴팁은
  `data-i18n-shortcut="<action>"` 을 더해 `{key}` 에 `displayKey(shortcuts[action])` 이 들어간다 (FR-B-7).

**게이트 규칙 (FR-B-3 — `scripts/check-i18n.mjs`)**

- 대상: `web/js/**/*.js` · `web/index.html` · `web/*.css`.
- JS: espree AST 의 `Literal`(문자열)·`TemplateLiteral` 의 원문에 한글(`[가-힣ㄱ-ㆎ]`)이 있으면 위반.
  주석은 AST 에 없으므로 자연히 지난다.
- HTML: 주석 밖의 텍스트 노드와 `title`·`placeholder`·`aria-label`·`alt`·`value` 속성값의 한글.
- CSS: 주석 밖 `content:` 값에 한글 또는 **2자 이상의 라틴 단어** (FR-B-6 — `content` 문구는
  언어와 무관하게 DOM 으로 간다).
- 예외 등록부(스크립트 상단의 표 — 줄마다 사유):
  ① `web/js/i18n/` 카탈로그 자신 ② `web/js/test/` ③ `console.<x>(…)` 의 인자(로그) ④ `throw new
  Error(…)` 의 인자(개발자 오류) ⑤ `settings-schema.js` 의 `where` 값(문서 필드).
- 카탈로그 검사: `ko`·`en` 의 키 집합이 같다 · 키 형식이 규약이다 · `t('…')` 리터럴 호출의 키가
  카탈로그에 있다.
- Go: `check-http-error.sh` 가 `http.Error` 한국어 0 과 **`httpErr` 한국어 본문이 동결 목록(9곳)을
  넘지 않음**을 함께 잡는다 (TC-B-6). 동결 목록은 D-ERR-2 의 공개 계약이다 — 줄어들 수는 있다.

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

**FR-APS-10** (추가, §9.2 R-c · **P0 실측으로 정정 2026-09-13, §9.3 ⑥ F-1 — 사용자 승인**)
claude 의 승인 요청은 **stdio 제어 프레임**(`control_request{subtype:"can_use_tool"}`)으로
온다. 어댑터의 `LaunchProto` 가 `--permission-prompt-tool stdio` 를 싣고, 서버는 그
프레임을 FR-APS-5 의 승인 요청으로 올리며 `control_response{behavior:"allow"|"deny"}` 로
답한다. **MCP 서버는 두지 않는다** — R-c 의 "범위 항목" 은 해소됐다. 단, 이 값은 헬프에
없는 **숨은 플래그**다 (2.1.270 실측, 비공개 계약 — R-2).

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
도구 호출과 결과 · 진행 중 델타 · 승인 다이얼로그 · **질문 답변**(에이전트가 사용자에게
묻는 선택형 질문 — claude `AskUserQuestion`, 같은 `can_use_tool` 통로. 사용자 지시 2026-09-13,
P3) · 활동 상태 · 사용량/컨텍스트 창 · 비용.

**FR-AGT-4a** (추가, 사용자 지시 2026-09-13 P3 — *"esc 를 통한 인터셉트, 히스토리같은 기능들도
동작해야해. 최대한 tui agent 의 모든 공통 기능을 이용하게 할 수 있으면 좋겠어."*) **TUI 에이전트의
공통 조작이 에이전트 도구에서도 된다** — 프로토콜이 그 길을 주는 한. P3(claude)에서 확정하는 것:
`Esc` → 진행 중 턴 인터럽트(`Proto.Interrupt`) · 입력 상자의 `↑`/`↓` → 이 도구에서 보낸 프롬프트
히스토리(이벤트 로그의 `user` 에서 되살린다 — 재접속 뒤에도 남는다) · `/` 로 시작하면 슬래시 명령
자동완성(목록은 `initialize` 의 `commands`, 없는 것은 그대로 보낸다 — 명령의 해석은 에이전트의 것) ·
`Shift+Tab` → 권한 모드 순환(`set_permission_mode`, 순서는 `initialize` 가 준 것이 없으므로 P3 는
claude 의 TUI 순서 `default → acceptEdits → plan → default` 를 어댑터가 `Proto.PermissionModes` 로
선언한다 — 비어 있으면 그 에이전트에 순환이 없다) · `Ctrl+C` 두 번 같은 종료 관용은 두지 않는다(탭 닫기가 그 자리). 어댑터가
주지 않는 조작은 부재다 (FR-APS-4) — 메뉴에 나타나지 않는다.

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

**FR-AGT-11** (추가, P0 사용자 요구 2026-09-13 · **확정 2026-09-13** — *"omp 는 여러 방식으로 로그인이 가능한데
이걸 다 사용할 수 있어야 해, 모델 변경이라거나"*) **프로토콜이 주는 로그인·모델 전환은
UI 로 노출한다.** 어댑터의 `Proto.Control`(§9.3 ③) 이 지원하는 것 — 로그인 공급자 목록과
로그인 흐름(omp `get_login_providers`·`login` → `open_url`·`input`; codex `account/login/*`),
모델 목록과 전환(omp `get_available_models`·`set_model`·`cycle_model`; claude `initialize.models`·
`set_model`; codex `model/list`·`turn/start.model`), 권한 모드·사고 예산 — 을 에이전트 도구의
메뉴에 낸다. 어댑터가 주지 않는 것(claude 로그인)은 FR-AGT-10 의 TUI 출구다. 선택지는
프로토콜이 준 것 그대로다 (FR-AGT-5 와 같은 규약).

**FR-AGT-12** (추가, P0 사용자 요구 2026-09-13 · **확정 2026-09-13** — *"에이전트 화면 동시 접근에 대해서는
터미널과 같은 동작으로 한쪽만 컨트롤하도록 블로킹하기"*) **동시 접근은 창 포커스 소유를
그대로 지난다.** 에이전트 도구의 뷰는 터미널 도구와 같은 규약 — 창마다 소유자 하나
(last-focus-wins, `FR-XDF-2/3`, `POST /api/focus/claim` → SSE `window_focus`, `FR-XDF-5/6`) —
아래 선다. 소유자가 아닌 브라우저는 `.pn-dimmed`("클릭하여 포커스") 로 **보기만** 하며
프롬프트·승인 응답·제어(FR-AGT-11)를 보내지 못한다; 클릭하면 소유권을 가져온다.
새 기계를 만들지 않는다 — `app-focus.js` 의 `_windowFocusOwner`·`applyFocusOverlay` 가
에이전트 도구의 pane 에도 그대로 적용된다 (FR-AGT-7 의 "종류를 묻지 않는 코드" 에 든다).
서버가 소유자 아닌 클라이언트의 승인 응답을 거절할지는 P3 에서 정한다 — 터미널은
지금 클라이언트만 막는다. **P3 결정(D-C-4): 거절하지 않는다** — 터미널과 같은 동작이 요구였고,
`clientId` 는 자기 신고 값이라 서버측 거절이 보안이 아니며, 서버는 도구가 어느 창에 있는지 모른다.

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

**P5 착수 실측 (2026-09-14, codex 0.154.0 · omp 17.4.0 — 자격증명 없음, 무모델 프레임. 드라이버
P0 의 것, 원본 `/tmp/m8-spike/p5/*.jsonl`).** 드리프트 잡(`-tags agentdrift`) 셋 초록이 먼저였다.

| 물음 | 결과 | 뜻 |
|---|---|---|
| omp `--resume` 의 접두 길이 | **길이 제한이 없다** — `0`·`01`·`01a0`·8·13·36자 전부 같은 세션에 닿았다. 접두가 여러 세션에 맞으면 **조용히 하나를 고른다**(세션 둘인 cwd 에서 `0` → 최근 것). 다른 cwd 의 세션에도 닿는다(전역 탐색). 없는 id 는 exit 1 + stderr `Session "…" not found.` | 우리는 `get_state` 가 준 **전체 id** 만 싣는다 — 접두 규칙은 쓰지 않는다 |
| codex `thread/resume` 이 **살아 있는(loaded) thread** 를 rejoin 하는가 | **한다.** 같은 프로세스에서 `thread/resume{T}` 를 두 번 보내면 둘 다 같은 `thread.id` 로 답하고 새 thread 가 서지 않는다(`thread/list` 개수 불변). **턴이 `inProgress` 인 동안**에도 같은 id 로 답한다(status `active`). 단 **아직 rollout 파일이 없는 thread**(`thread/start` 직후, 첫 턴 전)는 `error{"no rollout found for thread id …"}` | P4 발견("되살림이 thread 를 잃는다")의 해법: 신원을 레코드에 남기고 되살릴 때 `Resume=threadId` 로 핸드셰이크한다 (D-C-14). 첫 턴 전의 thread 는 잃어도 잃는 것이 없다 |
| 살아 있는 codex 프로세스에 `initialize` 를 다시 보내면 | `error{-32600,"Already initialized"}` — 그 뒤의 `thread/resume`·`model/list` 는 정상 | 어댑터가 그 한 오류를 부재(`nil,true`)로 읽는다 — 되살림 핸드셰이크의 잡음이다 (D-C-14) |
| codex `config.toml` 부작용 | 없음 (`approvalPolicy`·`sandbox` 를 싣지 않았다) | R-e 규약 유지 |

#### 3.4.5 비기능 (NFR)

**NFR-C-1** 프레임의 **내용을 서버 밖으로 내보내지 않는다.** `AGENT_ADAPTER_COMPLETION_SRS` NFR-4 의 규약을
잇는다. 이벤트 로그는 이 인스턴스의 디스크에만 있다.

**NFR-C-2** 이벤트 로그는 **무한히 자라지 않는다.** 상한과 잘라내기 규칙을 둔다.
**P3 값**: 도구마다 메모리 링 **4,096 이벤트**. 넘치면 가장 오래된 것부터 버리고 `seq` 는
계속 는다 — 재생 요청의 `since` 가 잘린 앞을 가리키면 응답이 `truncated:true` 를 싣는다
(FR-ABG-21 의 요약 스냅샷·디스크 영속은 P5).

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
| **P3** | C-a | 묶음 P + T, **claude 한정**: 어댑터 프로토콜 필드 · 공통 이벤트 · 승인 요청-응답(stdio 제어 프레임, FR-APS-10) · 에이전트 도구 종류 · GUI · TUI 출구 · L1 알람(FR-AAL-1~4). 터미널 표면은 손대지 않는다 | P1 · P2 | L |
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

**D-U-4 — 에이전트 도구는 `Tool.Kind = agent` 인 변형이다.** (원문 D-4 "새 도구 종류",
사용자 선택 2026-09-12 → **P0 판정으로 정정 2026-09-13, §9.3 ⑤ — 사용자 승인**)
배치·영속·복원·포커스·백그라운드·데몬 중계는 터미널 도구와 **바이트 길을 공유**하고,
종류를 묻는 코드는 셋에 한정된다 — (a) 서버의 해석층(`Proto.Decode` → 이벤트 로그 →
열린 요청 큐 → L1 알람) (b) 브라우저의 뷰(xterm 대신 대화 뷰) (c) 전송이 필요한
호출(리사이즈·붙여넣기·전경 프로세스 폴링)의 무동작. 새 종류로 두면 `ToolHub`
인터페이스(`GO-46`)가 종류별 메서드를 갖게 되고 소비자가 종류를 묻는 자리가 셋 밖으로
샌다(FR-AGT-8 위반). D-U-2 가 그 위에 선다 — **소비자 길은 같다**.

**D-U-5 — codex app-server 를 채택한다.** (원문 D-2, 근거 정정) 원문은 "훅을 지우면
codex 가 침묵하므로 강제" 였다. 병행에서는 그 근거가 사라지지만 결론은 같다 —
codex 의 프로토콜 표면은 app-server 뿐이다. experimental 딱지는 R-1 로 관리한다.

**대조 잡 (P4 결정, 2026-09-13)**: `internal/shared/agentadapter/drift_test.go` — 빌드 태그
`agentdrift` 로 CI 밖에 있다. 어댑터의 `Launch`·`Handshake` 로 **실제 바이너리**(PATH 또는
`DONGMINAL_AGENT_BIN_DIR`)를 띄워 세션 신원·모델 목록이 어댑터의 `Decode` 로 읽히는지,
핸드셰이크 동안 모르는 프레임이 없는지, stdin EOF 로 끝나는지를 잰다 — 무모델 프레임뿐이다
(자격증명을 묻지 않는다). **주기는 야간이 아니라 사건이다**: M8 의 단계 착수마다 1회 ·
에이전트 바이너리의 판이 오를 때 · 어댑터 파일을 고칠 때. 로컬에 스케줄러가 없고 자격증명이
없어 야간에 돌려도 얻는 것이 같다. 실행: `go test -tags agentdrift -run TestDrift -v
./internal/shared/agentadapter/`. P4 결과: 셋 다 초록 (claude 는 `system:init` 이 첫 프롬프트
뒤에 오므로 핸드셰이크 판정에서 세션 신원을 요구하지 않는다 — `driftSessionAtHandshake`).

**D-U-6 — `Signals` 같은 선언 테이블을 다시 만들지 않는다.** (원문 D-3 그대로) 없는
이벤트는 부재로 (FR-APS-4).

**D-U-7 — 승인 요청의 타임아웃을 다루지 않는다.** (원문 D-5, 사용자 결정 2026-09-12)
열린 요청이 에이전트 쪽에서 만료되면 그 턴은 거부/실패로 끝난다. 알람을 세워 알릴
뿐이며 대신 답하지 않는다 (FR-APS-6).

**D-U-8 — L1(OSC·`dmctl notify`)은 남긴다.** (원문 D-6 그대로)

**D-U-9 — 축 B 가 축 C 앞이다.** 새 UI 의 문구 100여 개가 키로 태어나야 축 B 가
그것을 한 번 더 걷지 않는다 (§1.1). 축 C 가 지우는 UI 문구는 없다 (병행).

**D-B-1 — 로케일 전환은 페이지를 다시 연다.** 문구 상수 1,100여 개가 `const X=t('…')` 로
로드 시점에 한 번 평가되고 77파일이 그 이름을 읽는다 — 살아 있는 재렌더는 모든 소비처를
고치는 일이고 그 값은 이 제품(단일 사용자, 전환은 드물다)에 없다. 설정 저장 → `localStorage`
비추기 → `location.reload()`. 첫 페인트 전의 `<html lang>` 과 로케일 결정은 head 인라인
스크립트가 같은 키(`dm.locale`)를 읽는다 (BOOT_SCREEN 의 `dm.themeVars` 와 같은 모양).

**D-B-2 — 게이트가 한글만 본다.** 영어 리터럴을 잡을 기계적 기준이 없다(식별자·CSS 클래스·
프로토콜 문자열과 구분 불가). 한글 0 이면 "ko 문장이 카탈로그 밖에 없다" 가 보장되고, en 은
ko 와 **키 집합이 같다**는 검사가 덮는다. CSS `content` 만 라틴 단어도 잡는다 — 거기서는
글자가 곧 문구다.

**D-B-3 — 서버 본문은 동결, 문장의 소유는 프론트.** D-ERR-2 를 지킨다. 동결 목록이 게이트에
있으므로 "한국어 제거" 는 본문을 고치는 일이 아니라 **프론트가 본문을 읽지 않게** 하는 일이다.
비브라우저 클라이언트(`curl`)는 종전 본문을 그대로 받는다 — CLI 는 FR-B-1 의 범위 밖이다.

**D-B-3a — 코드가 구체적이면 카탈로그가, 상태에서 파생됐으면 본문이 사유다.** (전량 e2e 가
잡았다, 2026-09-13) 첫 구현은 "코드가 카탈로그에 있으면 카탈로그" 였고, 접속 허용 목록의 저장
거부(`fail(w, 400, err.Error())` — 본문이 **사용자가 보낸 값과 그 설명**)가 `err.bad_request` 의
일반 문장으로 덮였다. `fail()` 은 코드를 상태에서 파생하므로(`bad_request`·`not_found`·`forbidden`·
`internal_error`·`conflict`·`method_not_allowed`) 그 여섯에서는 **본문이 사유**이고, `httpErr` 이
구체 코드(`missing_argument`·`tool_not_found`·`sandbox_unavailable`…)를 붙인 자리는 **코드가
사유**다 — 동결된 한국어 본문 9곳 중 여덟이 이쪽이다. `apiErrText` 의 순서: 닿지 못함 →
구체 코드의 카탈로그 → 본문 → 파생 코드의 카탈로그 → `{what} ({status})`.

**D-B-4 — ko 카탈로그의 값은 종전 문자열과 바이트 단위로 같다.** 외부화 패스에서 문구를 고치지
않는다(e2e 151 단정이 그 위에 선다). 문구 교정은 별도 diff(FR-B-9 의 UX-20 넷이 그 첫 예) —
외부화와 교정이 한 커밋에 섞이면 어느 쪽이 깨뜨렸는지 알 수 없다.

**D-U-10 — 축 A ⑤(CLI 계약)는 C-a 뒤다.** Run 멤버의 기동 경로가 둘이 된 뒤 한 번에
본다 — 먼저 고치면 C-a 가 다시 고친다.

**D-A-1 — `dmctl` 의 대기 예산은 서버 상한의 사본이 아니라 같은 상수다.** (P6, FBE-01 클라이언트
절반) `runPost`/`runGet` 이 예산을 받고, `succeed` 는 `--timeout-ms`(없으면 서버 기본 180초) + 여유,
`preamble`(`run launch`·`wait --member`·`status --member` 의 멤버 해석)은 90초 + 여유, `close` 는
20초 + 40초 여유다. 상한 셋은 `shared/runwait` 한 곳에 있고 서버(`httpapi`)와 CLI(`runtimebin`)가
그것을 함께 읽는다 — `wait` 가 `waitClientDefaultBudgetMS` 로 서버 기본을 **베껴** 둔 형태는 답습하지
않는다(두 벌은 한쪽만 바뀐다). "전임자가 60초 뒤 답해도 성공" 은 60초 자는 테스트가 아니라 두 단정으로
잰다: 예산 계산이 순수 함수(`--timeout-ms 60000` → 70초)이고, 전송이 그 예산을 실제로 쓴다(짧은
예산은 끊기고 긴 예산은 잇는다).

**D-A-2 — `/api/commands` 를 지나는 `dmctl` 명령은 전부 `delivered` 를 판정한다.** (P6, FBE-02)
`dmctlPost`·`dmctlSend` 가 응답의 `delivered`·`timedOut` 을 읽는다.
  이전 동작: 브라우저가 없어도 `{"ok":true,"delivered":0}` 를 찍고 exit 0
  새  동작: `delivered==0` 이면 `detach` 와 같은 문구("구독 중인 브라우저가 없습니다 — 페이지를
            새로고침하세요")로 **exit 1**. 생성 명령이 `timedOut` 이면 "브라우저가 결과를 답하지
            않았다 — 만들어지지 않았을 수 있다. list-workspace 로 확인하라" 로 **exit 1**. 본문은
            둘 다 stdout 에 그대로 남는다(스크립트가 읽던 것을 빼앗지 않는다)
  이유:     헬프의 팀 구성 절차(`new-tab` → `run member --at <새 uuid>`)가 exit 0 을 "만들어졌다"
            로 읽는다. 같은 종단의 `detach` 는 이미 이렇게 판정한다
`open-url` 은 자기 경로(`where=local` 이면 부른 셸이 연다)라 대상이 아니다.

**D-A-3 — `closedTabs[].closed` 는 방송 결과다.** (P6, FBE-04) `closeRunTabs` 가 `broadcastLayout`
의 반환(구독자 수)을 `closed` 에 싣고 `delivered` 도 함께 낸다. `closedTabIDs` 는 `closed==true`
만 모으므로 브라우저가 없으면 표식 해제(`markWorkspaceRunExcept`)가 그 탭을 건너뛰지 않는다 —
남은 탭에 죽은 Run 의 `runId` 가 붙지 않는다. 정리는 계속한다(attach/detach 처럼 503 으로 멈추지
않는다) — 정리는 조건이 아니고, 거짓 보고만 없앤다.

**D-A-4 — codex 의 터미널 표면은 실측대로 `argv` · `--model` 이다.** (P6, FBE-06·14 — 사용자 결정
2026-09-14 "선언 정정 + 안내 코드") codex 0.154.0 `--help`: `codex [OPTIONS] [PROMPT]` ·
`-m, --model <MODEL>`. P0 의 "미확인 — 보수적으로 `stdin-after-start`" 는 실측으로 소멸한다.
  이전 동작: `dmctl run launch --member <codex>` 가 `codex` 한 줄 — 프리앰블·모델 없음
  새  동작: `codex --model <m> '<프리앰블>'` — claude·omp 와 같은 한 줄
  이유:     실측. 헬프의 3단계 절차가 이 전제 위에 있었고 codex 만 조용히 어긋났다
어댑터 계약의 다른 값(`PromptStdinAfterStart` · 빈 `ModelFlag`)은 남으므로 `runSubLaunch` 가 그것을
호출자에게 **말한다**: 주입이 argv 가 아니면 stderr 로 "기동줄에 프리앰블이 실리지 않는다 — `wait
--for ready` 뒤 `run launch --text | send-input --execute -`" 를, `--model` 을 줬는데 플래그가 없으면
"이 에이전트의 모델 플래그를 모른다 — 생략했다" 를 낸다. 종료 코드는 0 이다(기동줄은 유효하다).
헬프의 3단계 절차에 그 분기를 적는다. 프로토콜 표면(`codex_proto.go`)은 건드리지 않는다.

**D-A-5 — `status --member` 는 `wait --member` 와 같은 해석이다.** (P6, FBE-13) `parseStatusFlags` 의
`--member` 게이트를 푼다. 해석(`memberToolID`)은 둘이 같은 함수이며 예산은 D-A-1 의 preamble 것이다.

**D-A-6 — `run delete` · `run graph` 는 API 한 번이다.** (P6, FBE-15) `DELETE /api/runs/{id}` ·
`GET /api/runs/{id}/graph`. `delete` 는 close 와 달리 미보고 검사 없이 **레코드를 지운다**(UI 의
삭제와 같은 뜻, FR-DEL-8~11) — 헬프가 그 차이를 적는다. `graph` 는 `--json` 이 아니면 멤버·간선·
타임라인을 줄로 낸다. FUI-23(Run 시작이 UI 에 없다)은 기록만 — 팀 구성은 스킬의 것이다.

**D-A-7 — 없는 `--cwd` 는 400 이다.** (P6, FBE-16) 검사 자리는 `apiToolsCreate`(HTTP 종단) —
샌드박스가 아닌 창(`sandbox` 없음)에서 `cwd` 가 주어졌는데 디렉터리가 아니면 `tool_cwd_missing`
400. 샌드박스는 종전대로 배치기가 판정한다(FR-SBX-41). `toolhub` 의 홈 폴백(`tool.go`)은 **남긴다**
— 그것은 되살림(`Restore`)의 길이며, tools.json 에 적힌 cwd 가 사라진 도구를 되살릴 때 홈으로
떨어지는 것이 맞다. `cwdTool` 로 물려받은 cwd 도 같은 검사를 지난다.
  이전 동작: `dmctl new-window --cwd /없는/경로` → 새 창이 홈에서 뜨고 exit 0
  새  동작: 도구 생성이 400, 브라우저가 echo 하지 않아 `timedOut` → D-A-2 로 exit 1
  이유:     `manager.go` 의 주석("조용히 걸러 내면 왜 안 붙었는지 알 수 없다")이 이미 이 뜻이다

**D-A-8 — 붙여넣기 본문의 종료 마커와 엔벨로프 구분자는 서버가 치환한다.** (P6, FBE-18)
`wrapPaste` 는 본문의 `ESC[201~` 를 제거한다(모드가 켜져 있을 때만 — 꺼져 있으면 마커가 뜻이
없다). `apiToolMessage` 는 본문의 `[DONGMINAL-AGENT-MSG` → `[\DONGMINAL-AGENT-MSG`,
`[/DONGMINAL-AGENT-MSG` → `[\/DONGMINAL-AGENT-MSG` 로 바꾼다 — 역슬래시 하나가 "인용" 의 표식이고,
헤더의 정확한 바이트열은 서버가 만든 것 하나뿐이 된다. 04-Sec P0-1/2 는 Origin/CSRF 라 M2 가 이것을
다루지 않았다 — 여기서 닫는다. `agent-context` 본문은 바꾸지 않는다(FR-CTX-3 최소, 훅 표면 불변 V-11).

**D-A-9 — 격리 기동은 두 경로가 같은 안내를 내고 같은 도구 홈을 심는다.** (P6, FBE-09·10)
`announceIsolated`(격리 홈 · 도구 셸의 홈 · 내리는 법) 하나를 `startDetached` 와 `--foreground` 가
함께 부르고, `ensureIsolatedToolHome` 하나가 두 경로의 도구 홈을 만든다. 헬프의 `--isolated` 가 도구
홈 상실을 적는다.
  이전 동작: `--isolated --foreground` 는 임시 홈 경로를 끝내 알리지 않았고(안내가 `startDetached`
            안에만), 도구 셸은 **사용자 홈**에서 떴다(`prepareServerCmd` 만 도구 홈을 심었다)
  새  동작: 전경에서도 같은 안내와 같은 격리
  이유:     "자동으로 지우지 않습니다" 인데 경로를 모르면 지울 수 없다. 격리의 뜻이 모드에 따라
            달라선 안 된다
FBE-11(`termReset`)은 TERMINAL_RESUME FR-TRS-12 가 이미 닫았다 — `buildReplay` 하나를 두 모드가 쓰고
`termReset` 은 전량 재생 때만 나간다. 판정표에 "이미 해소" 로 적는다.

**D-A-10 — 분리는 이동이다.** (P7, GO-14·15·18·20·21) 500줄 초과 파일의 축소는 **심볼을 옮기기만**
한다 — 같은 패키지의 새 파일로, 시그니처·동작·주석은 그대로. `handlers_fs.go` 의 `/api/editors/*` →
`handlers_editors.go` · `tool.go` 의 주의·활동 상태기 → `tool_attention.go` · `worktree.go` 의
porcelain 파서·slug·ref 검사 → `parse.go`·`naming.go` · `doctor.go` 의 프로브(PTY 왕복·콘솔 없는
자식) → `doctor_probe.go` · `client.go` 의 `handlePush` → 이벤트별 메서드. 판정은 "같은 테스트가
그대로 초록" 이다 — 이동에 테스트를 새로 쓰지 않는다.

**D-A-11 — `doctor` 는 표다.** (P7, GO-20) 진단 항목은 `[]doctorCheck{name, run}` 으로 `RunDoctor` 가
순서대로 돈다. 항목의 함수 시그니처는 그대로이고 표는 그것을 닫아 넣는 클로저다. 실패 수 집계·
로그 포획·임시 bin 은 표 밖(전후)이다.

**D-A-12 — `serve` 는 `Build → Run → Shutdown` 이다.** (P7, GO-16) `cmd/dongminal/app.go` 의
`buildApp(cfg, home, host, port) (*app, error)` 가 조립(데몬 연결·`buildDeps` 3벌·서버·해석층 배선)을,
`app.run(ctx)` 이 기동(스위퍼·폴·감시·리퍼·HTTP)을, `app.shutdown()` 이 종료를 맡는다. 종료 순서는
**슬라이스**다 — `shutdownSteps() []shutdownStep{name, fn}` 이 `[마커, 데몬 연결, 도구 저장, 샌드박스,
LSP, 워크스페이스]` 를 그 순서로 들고 `shutdown` 은 그것을 돈다. 테스트가 이름 순서를 잰다 — 주석이
코드가 된 자리다. 패키지는 `cmd/dongminal` 그대로다(`internal/webserver/app` 을 만들면 ①·②·④ 의
패키지를 ③ 아래에서 import 하게 되어 축 규칙에 걸린다).

**D-A-13 — Run 표식의 트리 조작은 `shared/workspace` 의 것이다.** (P7, GO-17) `applyRunMarks`·
`markTabsIn`·`setOrClear` 는 `workspace.ApplyRunMarks(tree, tabs, windowID, markWindow, runID) bool`
로 옮긴다 — workspace.json 의 모양을 아는 자리는 그 패키지다. `markWorkspaceRun*`(Save 재시도·방송)은
httpapi 에 남는다(HTTP 의 관심사). `apiRunClose`·`apiRunMemberAdd` 는 응답 조립을 함수로 뗀다.

**D-A-14 — `..` 는 조각으로 판정한다.** (P7, GO-18) `worktree.checkPath` 의 `strings.Contains(p, "..")`
는 `a..b` 같은 정상 이름을 거부했다. 경로 **조각**이 `..` 인 경우만 이탈이다 — `handlers_fs.go`
`fsUnderRoot` 와 같은 규칙. `validRef` 의 `..` 는 그대로다(git ref 문법이 `..` 를 금한다).
  이전 동작: `<root>/run/a..b` 제거 거부(ErrUnsafePath)
  새  동작: 허용. `<root>/../x` 는 여전히 거부
  이유:     오탐. Clean 뒤 root 접두 검사가 이탈을 이미 막는다

**D-A-15 — 대기 폴링은 `shared/pollwait` 한 벌이다.** (P7, GO-27) `httpapi.pollUntil` 을
`pollwait.Until(ctx, max, every, cond) error`(`pollwait.ErrTimeout`)로 올리고 요청 경로 넷·데몬 소켓
대기(`dialOrStartDaemon`)·`waitReady`·`killPort`/`stopDaemon` 이 그것을 쓴다.
  이전 동작: `killPort`·`stopDaemon` 이 TERM 뒤 **고정 1초** 를 잤다
  새  동작: 같은 1초를 상한으로 프로세스가 사라지면 곧 KILL 판정으로 간다(상한은 같다)
  이유:     정지가 빨라지고 대기의 형태가 한 벌이 된다. 기다리는 것은 시간이 아니라 사라짐이다

**D-A-16 — JSON-RPC 코드와 파라미터 해석은 한 벌이다.** (P7, GO-22 · P6 발견) `toolipc` 에
`CodeMethodNotFound(-32601)`·`CodeInvalidParams(-32602)`·`CodeInternal(-32603)`·`CodeServer(-32000)` 와
**`CodeToolCap(-32010)`** 을 둔다. 데몬 핸들러는 `decodeParams[T](req) (T, *PanedError)` 로 파라미터를
읽는다. `create` 가 `toolhub.ErrToolCap` 을 `CodeToolCap` 으로 싣고, `toolclient.call` 은 오류 응답을
`*toolipc.RPCError{Code, Message}` 로 돌려주며 `Create` 는 `CodeToolCap` 을 `toolhub.ErrToolCap` 으로
되돌린다 — 데몬 모드에서도 `errors.Is(err, toolhub.ErrToolCap)` 이 참이고 HTTP 가 429 를 낸다.
  이전 동작: 데몬 모드에서 상한 초과가 500 (`paned error: 도구 수가 상한에 이르렀다`)
  새  동작: 두 모드가 같은 429 `tool_cap`
  이유:     상한 판정이 프로세스 경계에서 문자열로 뭉개졌다
구현 중 발견: `toolclient.call` 은 오류 응답을 **한 번도 오류로 읽지 않았다** — `PanedResponse` 로
먼저 해석했고 오류 응답도 `id` 를 가져 그 해석이 성공했다(`Result` 없음 → 빈 맵, err nil). M3 의
`GO-8`(데몬이 write/kill 실패를 답한다)은 그래서 데몬 모드에서 반쪽이었다.
  이전 동작: 데몬의 오류 응답(없는 도구에 write·kill·paste 등)이 클라이언트에서 nil 로 돌아왔다
  새  동작: `*toolipc.RPCError` 로 돌아온다 — 핸들러가 이미 하던 오류 처리가 데몬 모드에서도 선다
  이유:     오류를 성공으로 답하는 경계는 `GO-8` 이 지우려 한 바로 그것이다

**D-A-17 — 기본 터미널 크기는 `toolhub.DefaultCols/DefaultRows` 다.** (P7, GO-28) `ParseSize`·
`LoadAllWith`·헤드리스 멤버가 같은 상수를 읽는다. 브라우저의 `cols=120&rows=40` 은 그대로다(그쪽은
자기 값을 보낸다).

**D-A-18 — `dataPath` 는 지운다.** (P7, GO-24) `main.go` 의 사본은 `filepath.Join(home, …)` 로 —
`serve` 의 홈은 비지 않는다. `toolhub` 의 것은 `dataDir==""` 폴백이 있는 자기 메서드로 남는다.
GO-25(`HeadlessToolIDs` 두 번)는 이미 해소다 — 부팅 읽기는 한 번이고 `SetOwnedTools` 의 술어는 저장
시점에 신선해야 하므로 읽기가 맞다. GO-26(스냅샷 프레이밍)은 FR-TRS-12 의 `buildReplay` 가 닫았다.

**D-A-19 — 죽은 Sync 상태기계는 지운다.** (P7, `09` FR-GCC-3·4) `write.SyncStep*`·`SyncSteps`·
`StepOutcome`·`SyncNext`·`syncStopReason` 과 자기 테스트 둘. FR-GIT-270 은 GIT_ACTIONS_SRS 에서 이미
⊘ 철회다. D-WBR-8(`app-layout.js` editor 분기)은 **지우지 않는다** — WORKBENCH_REVIEW_SRS D-WBR-19 가
닿는 길(FR-EDT-120 환경)을 확인하고 D-WBR-8 을 종결했다. `09` 의 그 항목은 낡은 지도였다.

**D-A-20 — Go 테스트의 저장소 픽스처는 `shared/gittest` 한 벌이다.** (P7, TEST-23) `gittest.Path(t)`
(없으면 Skip) · `gittest.Run(t, dir, args…)`(전역·시스템 gitconfig 차단) · `gittest.Init(t)`(`init -b
main` + `user.*`) · `gittest.Repo(t)`(첫 커밋까지). 일곱 벌이 이것을 부른다. `testpath` 와 같은
"테스트 전용 shared" 다.

**D-A-21 — 테스트가 띄우는 셸은 고정한다.** (P7, TEST-25) 셸을 띄우는 패키지의 `TestMain` 이
`testpath.PinShell()` 로 `SHELL` 을 `/bin/bash`(없으면 `/bin/sh`)로 고정한다 — 호스트의 `$SHELL` 이
검사 경로를 고르지 않는다. zsh 의 rc 사슬을 재는 검사(`history_shell_test`)는 셸 목록(`bash`·`zsh`)을
서브테스트로 돌고, 없는 셸은 **이름을 남기고** Skip 한다 — "돈 항목 수" 가 아니라 어느 셸이 빠졌는지가
보인다. Windows 는 무동작(`DONGMINAL_SHELL` 은 그쪽의 값이다).

**D-A-22 — 테스트 훅의 교체는 restore 를 돌려주는 헬퍼 한 형식이다.** (P7, TEST-26 · GO-42 결정)
`attnNow` 는 `stubAttnNow(t, f)` 하나로(`t.Cleanup` 복원). GO-42 의 구조체 필드 주입은 **하지 않는다** —
DoD 의 조건("`t.Parallel()` 도입 패키지")이 성립하지 않고(도입 0), 전역 훅 다섯은 이미 전부
`t.Cleanup` 복원 형식이다. `runtimebin.clientWithin` 도 같은 결이다. 어느 패키지가 `t.Parallel()` 을
들이면 그 패키지의 훅부터 필드로 옮긴다(`ToolManager.startTool` 이 본).

**D-A-23 — 오류 세션의 런타임 회수는 부팅 규칙의 반복이다.** (P7, P5 유산) `agentsess.Manager.Reap
(referenced, olderThan)` 이 **어느 탭도 참조하지 않는** 휴면·오류 세션 중 그 상태로 `olderThan` 을 넘긴
것을 `Forget` 한다 — D-C-14 의 부팅 판정(`workspace.ReferencedToolIDs`)을 리퍼 틱마다 적용하는 것이다.
유예(30초)는 생성 직후의 창(도구가 먼저 서고 탭이 뒤에 저장된다)을 지나기 위해서다. 활성 세션은 대상이
아니다. `Server.StartAgentReaper` 가 Run 리퍼와 같은 주기로 돈다.
  이전 동작: 탭 없는 에이전트 도구가 죽으면 오류 세션·로그가 다음 부팅까지 남았다(보이는 자리 없음)
  새  동작: 유예 뒤 회수
  이유:     닿을 수 없는 세션은 되살릴 길도 보일 자리도 없다 — 부팅이 버리는 것과 같은 것

**D-A-24 — `wait` 의 기본 상한도 `runwait` 다.** (P7, P6 유산 — D-A-1 의 연장) `runwait.ActivityWait
Default`(5분)·`ActivityWaitMax`(30분)을 서버(`/api/tools/activity/wait`)와 `dmctl wait` 가 함께 읽는다.
`waitClientDefaultBudgetMS` 사본은 지운다.

**D-A-25 — 창·탭 생성 실패는 화면에 말한다.** (P7, P6 유산) 원격 명령 `newWindow`·`newTab` 과
사이드바의 창 추가가 `_newTool` 의 거부(400 `tool_cwd_missing`·샌드박스 실패)를 `_notify` 로 보인다
(`t('window.create_fail')`·`t('tab.create_fail')`). echo 는 내지 않는다 — `dmctl` 은 D-A-2 의 `timedOut`
으로 exit 1 을 이미 받고, 빈 echo 는 "만들어졌다" 로 읽힌다. `_newAgentTool` 의 `opts.resume` 은
지운다(재개는 `/api/agent/resume`, D-C-11).

**D-A-26 — 남기는 것과 그 사유.** (P7) ① GO-44 `Git *store.Store`: gitapi 가 `Service()` 를 72곳에서
쓴다 — 인터페이스로 좁혀도 git 없이 돌지 못하므로 좁히지 않는다. 좁힘은 GO-39(git 실행기 통합)의
후속이며 로드맵에 남긴다. ② `fail()`/`httpErr` 한국어 본문 9곳: D-ERR-2(본문은 공개 계약)가 동결했고
문장의 주인은 이미 카탈로그(`err.<code>`)다 — 옮기지 않는다. ③ §5-5 flaky 군집: M7 §5-5 가 "두 헬퍼
(git 관측 주기 대기·칸 그리기 대기)를 보는 별도의 일" 로 좁혔고 그 일은 이 단계의 것이 아니다 —
로드맵에 항목으로 남긴다. ④ 데몬 모드의 레코드 없는 에이전트 도구(P5 이전 판)는 빈 옵션 채택
그대로 — 한 번뿐인 이행 경로다. ⑤ `agents.json` 과 `migrate`: 그 파일은 uuid 시대에 태어나 구 형식
식별자가 없다 — `migrate` 가 알 것이 없다. ⑥ `sandboxplace/e2e_test.go` 의 700~900ms 고정 대기:
컨테이너 런타임이 있어야 도는 검사라 이 호스트에서 검증할 수 없어 손대지 않는다. ⑦ FBE-08 작업
경로분은 D-A-27.

**D-A-27 — `submodule update` 는 작업이다.** (P7, FBE-08 작업 경로분) `jobs.Jobs.StartUnguarded(repo,
kind, argv, reason)` 이 허용 목록 대신 **호출자의 인가**(submodule 의 `checkRepo`·`checkPath`·`--`
규약)를 전제로 작업을 띄운다 — `Kind="submodule"`, 취소·SSE·상한·자격증명 지움은 fetch/pull/push 와
같은 기계장치다. `POST /api/git/submodules/update` 는 `{job}` 을 즉시 돌려주고(fetch 와 같은 모양)
완료 훅이 관측 캐시를 버린다. 브라우저의 Submodules 탭은 작업을 구독해 진행 줄과 **취소** 를 보이고
끝나면 목록을 다시 받는다. `sync` 는 그대로 동기다(원격에 닿지 않는다).
  이전 동작: 요청 고루틴에서 동기 실행 — 진행 없음·취소 없음·180초 매달림
  새  동작: 작업 경로 — 진행 SSE·취소·상한은 원격 작업과 같다
  이유:     `job.go` 의 규정("원격 작업은 분 단위이고 취소할 수 있어야 한다")에 서브모듈 clone 이 든다

**D-C-1 — 에이전트 탭은 `type:"agent"` + `toolId` 다.** (P3) 탭 레코드가 종류를 들어야 브라우저가
목록을 받기 전에도 어느 뷰를 그릴지 안다. `toolId` 를 보는 코드(닫기·복원·백그라운드·`dmctl
list-workspace`)는 그대로 닿고, `type==='terminal'` 을 묻던 자리 중 뜻이 "도구가 있는 탭" 이던
곳(`allPids`)은 `toolId` 유무로 고친다. 종류를 묻는 자리는 D-U-4 의 셋 — 서버 해석층·뷰·전송 호출.

**D-C-2 — 해석층은 서버(③)에 있고 두 모드가 같은 바이트를 받는다.** (P3) 직접 모드는
`ToolHooks.OnOutput`(기동 전에 배선, readPTY 고루틴이 부른다), 데몬 모드는 `ToolClient.SetOnOutput`
의 사슬. 에이전트 도구의 바이트는 `AttnTracker.FeedOutput`(L1 OSC·L2 무장)을 **지나지 않는다**
(FR-AAL-5) — 그 도구의 알람은 공통 이벤트에서 파생한 활동 보고(`idle`·`working`·`waiting`·`done`·
`ended`)가 `activity/set` 과 **같은 함수**를 지나 세운다 (FR-APS-2·FR-AGT-8: `dmctl wait --for ready`
가 `system:init` 에 답하는 길이 이것이다). 세션은 도구 하나에 하나, 해석은 절대 오프셋 위에서
한다 — 생성 직후·재접속 뒤·틈이 보이면 `SnapshotTool(Since)` 로 되메운다 (§9.3 ④의 "틈").

**D-C-10 — 종류는 청크에 실려 온다.** (P3, 둘째 세션) 해석층 입구(`Server.AgentOutput`)는 도구의
종류를 **되묻지 않는다** — `ToolHooks.OnOutput`·`ToolClient.SetOnOutput` 이 `kind` 를 청크와 함께
준다(데몬의 `output` push 에 `kind` 필드, 터미널 도구는 생략). 이유: 데몬 모드에서 그 입구는
ToolClient 의 readLoop 안이고, `Tools.Get` 은 그 readLoop 이 응답을 읽어야 끝나는 RPC 다 —
되물으면 시한(5초)까지 막혔다가 연결을 떨어뜨리고, 그 사이의 `IsLive`·`Cwd`·WS attach 가 전부
실패한다 (실측: e2e TC-AGT-6 의 `── exited ──`, `M8_PROGRESS` §2-25). 청크의 출처(readPTY·데몬의
relay)는 `Tool.Kind` 를 이미 알고 있으므로 싣는 데 비용이 없다.

**D-C-3 — 이벤트 로그는 P3 에서 메모리다.** (NFR-C-2) 재생은 `GET /api/agent/events?tool&since` 가
하고 라이브는 SSE `agent_event{tool,seq,ev}` 다. 브라우저는 열 때 재생 → `seq` 로 이어 붙인다.
디스크·요약 스냅샷·휴면은 P5 (FR-ABG-2·4·10·21).

**D-C-4 — 비소유자의 승인 응답을 서버가 거절하지 않는다.** (FR-AGT-12) 근거는 그 조항에.

**D-C-5 — 에이전트 도구는 `tools.json` 에 기재하지 않는다.** (P3) `Restore` 가 셸을 띄우는 길이라
재개 인자(`--resume <id>`)와 argv 없이 되살릴 수 없다 — 그 되살림은 P5 의 휴면·재개다. 샌드박스
도구의 제외(FR-SBX-33)와 같은 자리. 데몬이 살아 있으면 서버 재시동은 넘긴다(도구는 데몬의 것).

**D-C-6 — stderr 는 로그로 간다.** (P3) 에이전트 프로세스의 stderr 는 줄 단위로 `dmlog` 에 남긴다.
`output` 스트림에 섞지 않는다 — 청크가 줄과 무관해 JSON 한 줄이 갈린다. 연결 끊김의 사유를 UI 에
싣는 것(§9.3 ④의 `stream:"stderr"`)은 FR-ABG-20 과 함께 P5.

**D-C-7 — 실행 파일은 `DONGMINAL_AGENT_BIN_DIR` 이 먼저다.** (§9.3 ②의 전제) 그 디렉터리에
`DetectCmd` 이름의 파일이 있으면 그것, 없으면 `PATH`. e2e 는 그 디렉터리에 가짜 에이전트를
`DetectCmd` 이름으로 놓는다 — 서버·픽스처 어느 쪽에도 에이전트 이름 리터럴이 늘지 않는다.

**D-C-8 — 데몬 모드에서 에이전트 도구의 `output` 푸시는 떨어지지 않는다.** (§9.3 ④ 조건 1)
`enqueue(…, droppable=false)` — `exit` 와 같은 등급. 데몬의 배선 클로저가 `Tool.Kind` 를 본다;
이것은 D-U-4 (c) 전송 호출에 든다.

**D-C-9 — 가짜 에이전트는 프롬프트 본문으로 시나리오를 고른다.** (V-12) `APPROVE` 가 들어 있으면
`can_use_tool Bash` 를 열고 답을 기다린 뒤 도구 결과와 본문을 낸다 · `QUESTION` 이면 `AskUserQuestion` ·
`DIE` 면 `result` 없이 `exit 1` · 그 밖은 `PONG`. `--resume <id>` 는 그 id 로 `system:init`. 설정
파일도 환경변수도 없다 — 서버는 그것을 어떤 에이전트와도 같게 다룬다.


**D-C-11 — 세션은 프로세스보다 오래 산다: 휴면·오류는 세션의 상태이고, 도구 신원은 재개를 넘어
같다.** (P5) `agentsess.Session` 에 `Dormant`(`""` 활성 · `hibernated` 휴면 · `error` 오류)가 생긴다.
프로세스의 끝은 세션을 지우지 않는다 — 지우는 것은 **사용자의 닫기**(`DELETE /api/tools/<id>` →
`Forget`) 하나다. 재개는 **같은 `toolId`** 로 새 프로세스를 세운다(`Placement.ReuseID` — toolhub 가
그 id 로 등록한다, `Restore(id, …)` 와 같은 길; 데몬 `create` RPC 에 `reuseId`). 이유: 탭의 신원이
`toolId` 다 (D-C-1). id 를 바꾸면 그 교체가 워크스페이스를 타고 모든 브라우저에 가야 하고, FR-ABG-4 가
피한 "재접속" 류의 문제가 되돌아온다. 대신 세션은 절대 오프셋(`seen`)을 재개마다 0 으로 되돌린다 —
새 프로세스의 스트림은 새 좌표계다.

**D-C-12 — 디스크 형식은 SSE 와 같은 줄이다.** (FR-ABG-2 · NFR-C-2) `<DataDir>/agents/<toolId>.jsonl`
— 한 줄이 `Logged{seq,at,ev}` 그대로(와이어의 `agent_event.args` 와 같은 모양) 또는 `{"snap":Snapshot}`.
이벤트마다 append. **압축**은 링에서 버려진 수가 `LogCap` 에 이르거나 파일이 8 MiB 를 넘을 때 —
`{snap}` 한 줄 + 링의 내용으로 다시 쓴다(원자적, `WriteStateFile`). 그래서 파일은 `2×LogCap` 이벤트
+ 스냅샷 하나를 넘지 않는다. 읽을 때(재시동 뒤) 마지막 `snap` 뒤의 이벤트가 링이 되고, 파싱되지 않는
꼬리 줄(쓰다 끊긴 것)은 버린다. `DataDir` 이 비면 디스크가 없고 P3 의 메모리 링만 있다(테스트).
휴면 레코드는 `<DataDir>/agents.json` (D-C-14). `tools.json` 은 그대로 셸의 것이다 — D-C-5 는 유지된다.

**D-C-13 — 요약 스냅샷은 잘린 이벤트의 접힘이다.** (FR-ABG-21) `Snapshot{seq, sessionId, status, usage,
open[], lastMessage}` 는 링에서 **버려진 이벤트를 차례로 접은 것**이다 — 지금 상태의 복사가 아니다.
그래야 스냅샷 + 남은 이벤트 = 전량과 같은 뜻이 되고, 마지막 assistant 메시지가 두 번 그려지지 않는다.
재생 응답은 `{state, events, truncated, snapshot?}` 이고 `snapshot` 은 `truncated` 일 때만 있다. 뷰는
"이전 기록은 잘렸다" 아래에 `lastMessage` 를 assistant 메시지로 한 번 그린 뒤 이벤트를 이어 붙인다.
`since>0` 인 이어 붙이기 요청이 잘린 자리를 가리켜도 같은 모양이다.

**D-C-14 — 휴면 레코드와 되살림.** (FR-ABG-10 · P4 발견) `agents.json` 의 레코드 = `{toolId, agent,
name, sessionId, cwd, approval, permissionMode, model, dormant, reason, at, lastSeq}`. 세션이 열릴 때
쓰고, 신원(`session`·`reset`)·권한 모드·모델·`dormant` 가 바뀔 때마다 다시 쓴다 — 활성 세션도 레코드가
있다. 그래서 서버가 죽어도 되살릴 근거가 남는다. **부팅**(`AgentRestore`): 레코드마다 — 도구가 목록에
살아 있으면(데몬 모드) `Resume=sessionId` 로 `Open` 한다 → codex 는 살아 있는 thread 를 **rejoin**
하고(P5 실측) 새 thread 를 세우지 않는다, claude·omp 의 핸드셰이크는 무해하다 · 도구가 없으면
`dormant=error, reason=server_restart` 로 세션을 디스크 로그에서 되살린다 · **신원이 없거나 어느 탭도
참조하지 않는 레코드는 버린다**(되살릴 것도 보일 자리도 없다 — `workspace.ReferencedToolIDs` 가 그
판정, `LoadAll` 과 같은 근거). 재개의 `LaunchOpts` = `{Cwd, Resume: sessionId, Approval, PermissionMode:
마지막 status 의 것}` — `Model` 은 싣지 않는다(셋 다 세션이 기억한다, U-4). codex 어댑터는 살아 있는
프로세스가 `initialize` 에 내는 `Already initialized` 오류를 부재로 읽는다.

**D-C-15 — 오류 상태는 `EvExit` 가 말한다 — 새 이벤트 종류가 아니다.** (FR-ABG-20 · D-C-6) `EvExit{Text:
"hibernated"|"closed"|"died", Detail: "exit <code>: <stderr 마지막 줄들>", IsError: died}`. 사유는
서버가 안다: 휴면 절차 중이면 `hibernated`, 사용자가 닫는 중이면 `closed`, 그 밖은 `died`(오류 상태 —
`idle` 로 읽지 않는다, 활동은 `ended`). stderr 꼬리(마지막 8줄, 2 KiB)는 파이프를 든 toolhub 의 `Tool` 이
모으고 종료와 함께 나온다 — 직접 모드 `ExitObserver(id, ExitInfo)`, 데몬 모드 `exit` push 의
`code`·`stderr[]`(옛 데몬은 비어 온다 — 사유 없는 오류 상태). dmlog 에 남기는 것(D-C-6)은 그대로다.
공통 어휘가 바뀌지 않으므로 소비자가 바뀌는 자리는 뷰의 `exit` 분기 하나다.

**D-C-16 — 신원 없는 도구는 휴면하지 않는다.** (P4 발견 §2-28) 실제 claude 의 `system:init` 은 첫
프롬프트 뒤에 온다 — 첫 턴 전에는 되살릴 id 가 없다. `POST /api/agent/hibernate` 는 그때 409
`agent_no_identity` 다. 활동 `idle` 은 신원이 아니라 **핸드셰이크 응답**에서 파생한다: claude 어댑터는
`initialize` 응답을 `EvSession{SessionID:""}` 로 낸다("떴다, 신원은 아직 모른다" — FR-APS-4 의 부재) —
`dmctl wait --for ready` 가 첫 턴 전에도 답을 얻는다. 가짜 claude 도 실제에 맞춘다: `system:init` 은 첫
`user` 프레임 뒤. `--resume` 은 세 판 다 이력 없이 신원만 되돌린다 (U-4).

**D-C-17 — 휴면·오류 도구는 목록에 있다.** (FR-ABG-4 의 전제) `/api/state.tools` 는 toolhub 의 목록에
휴면·오류 세션을 `ToolInfo{id, name, kind:"agent", agent, dormant}` 로 **합친다** — 그래야 브라우저의
`clean()` 이 탭을 살려 두고 재개 버튼이 놓일 자리가 있다. 해석층 밖의 목록 소비자(whoami·diag·경계)는
toolhub 목록을 그대로 본다. 브라우저의 `_applyRemoteWorkspace` 는 `kind:"agent"` 에 `mkTool` 을 부르지
않는다(P3 의 잠복 결함 — 살아 있는 에이전트 도구에 숨은 xterm 이 붙어 있었다). HTTP: `POST
/api/agent/hibernate{toolId}` · `POST /api/agent/resume{toolId}` → `{id,name}`. 휴면은 뷰의 메뉴에서만
(FR-ABG-11 명시적) — 탭 메뉴(FR-CMU-8)는 그대로다.
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
| TC-B-6 (Go) | `http.Error` 한국어 0 · `httpErr` 한국어 본문이 동결 목록을 넘지 않는다 (`check-http-error.sh`, 탐침: 한국어 `httpErr` 하나를 더하면 빨개진다) |
| TC-B-7 | 혼용 해소가 카탈로그 파일 diff 만으로 이뤄졌음을 커밋이 보인다 (외부화 커밋과 **별도 커밋**, D-B-4) |
| TC-B-8 (unit) | `t`·`tn`·`I18N.apply` 의 계약 — 치환·폴백·경고 1회·복수형·속성 채움·`lang` (`web/js/test/i18n.test.mjs`) |

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
2.1.269 의 실측이다. `--permission-prompt-tool stdio`(FR-APS-10) 는 헬프에 없는 값이다 —
2.1.270 실측, 비공개. 완화: R-1 과 같다.

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

**AS-1** (P4 정정, §9.3 ⑥ F-3) **한 프로세스를 한 도구로 쓴다 — 다중화는 쓰지 않는다.**
codex 는 한 프로세스가 여러 thread 를 들 수 있으나(§9.1 U-2 실측) 어댑터는 thread 하나만
쓴다. claude·omp 는 한 프로세스가 한 세션이다.

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

**P0 스파이크 실측 (2026-09-13).** 바이너리: claude **2.1.270** · codex **0.154.0**
(bunx 캐시, 전역 설치 없음) · omp **17.4.0**. 프레임 원본은 `/tmp/m8-spike/*.jsonl`
(저장소 밖, NFR-C-1). 라이브 모델 턴은 **claude 만** 돌았다 — codex 는 저장된
ChatGPT 토큰이 만료(`2026-04-03`)·refresh 거부, omp 는 등록된 키 둘(xiaomi·deepseek)이
401. 사용자 결정: *"코덱스는 지금 사용 안 하고 있다. 다 그냥 진행"* — 그 둘의
턴 의존 칸은 **미확인 — 자격증명 없음** 으로 남기고 스키마·소스·무모델 실측으로
채웠다. 세 에이전트 모두 TUI 와 프로토콜 모드가 **같은 자격증명 저장소**를 쓴다
(claude `~/.claude`+키체인 · codex `~/.codex/auth.json` · omp `~/.omp/agent/agent.db`)
— 그러므로 위 401 은 TUI 로 띄워도 같다.

| # | 확인할 것 | 결과 |
|---|---|---|
| U-1 | omp `--mode rpc-ui` 의 실제 프레임 형식과 `extension_ui_request` 의 payload (R-5) | **확인.** stdio NDJSON. 기동 즉시 `{type:"ready",protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,…}` → `available_commands_update{commands[]}`. 명령은 `{id?,type,…}`, 응답 `{id,type:"response",command,success,data\|error}`. 세션 이벤트 `agent_start/turn_start/message_start/message_update/message_end/turn_end/agent_end{isTerminal}/tool_execution_*`. **승인**은 `tools/approval.ts`→`extensibility/extensions/wrapper.ts:332` `uiContext.select(prompt, ["Approve","Deny"])` 가 rpc-ui 에서 `{type:"extension_ui_request",id,method:"select",title:"Allow tool: bash\n…",options:["Approve","Deny"]}` 로 나가고 호스트가 `{type:"extension_ui_response",id,value:"Approve"}` 로 답한다 (소스 확인, 라이브 왕복은 미확인 — 자격증명 없음). `--mode rpc`(hasUI=false)에서는 승인이 **오류로 실패**한다(`wrapper.ts:307`) — rpc-ui 가 필수. 기본 `tools.approvalMode` 는 **yolo** — 에이전트 도구는 `--approval-mode always-ask\|write` 를 실어야 승인 요청이 생긴다. 라이브로 본 UI 요청: `setWidget`(autoresearch, 무시 가능) · `open_url`·`notify`·`input`(로그인 흐름). 슬래시 명령은 `prompt{message:"/model"}` 로 보내면 `command_output{text}` + `response{data.agentInvoked:false}` (라이브). |
| U-2 | codex app-server 의 한 프로세스가 여러 thread 를 드는가 (AS-1) | **확인 — 든다.** 한 stdio 프로세스에서 `thread/start` 둘 → 서로 다른 `thread.id`, 둘 다 `turn/start` 가 `inProgress` 로 받아들여지고 `thread/status/changed`·`turn/started`·`item/*`·`turn/completed` 가 **`threadId` 를 실어** 병렬로 왔다. `thread/list` 가 둘을 낸다. AS-1 은 codex 에서 거짓이지만 **한 프로세스 = 한 도구** 로 쓰는 것을 막지 않는다 (어댑터가 thread 하나만 쓰면 된다). |
| U-3 | claude `--permission-prompt-tool` 이 MCP 툴을 요구하는가, 그 호출 규약은 무엇인가 | **확인 — MCP 서버가 필요 없다.** `--permission-prompt-tool stdio`(헬프에 없는 숨은 값, 2.1.270 동작) 를 주면 승인이 stdout 의 `{type:"control_request",request_id,request:{subtype:"can_use_tool",tool_name,input,description,permission_suggestions[],blocked_path?,tool_use_id,requires_user_interaction?}}` 로 오고, stdin 으로 `{type:"control_response",response:{subtype:"success",request_id,response:{behavior:"allow",updatedInput}}}`(거부는 `behavior:"deny",message`) 를 보내면 그 한 프레임으로 도구가 실행됐다(파일 생성 확인). `permission_suggestions` 가 TUI 의 "항상 허용/디렉터리 추가/모드 전환" 선택지를 그대로 싣는다(FR-AGT-5 의 근거). `--permission-prompts host` 만 주고 이 플래그가 없으면 요청 없이 **자동 거부** — `system:permission_denied` 프레임과 `result.permission_denials[]`. `ExitPlanMode`·`AskUserQuestion` 도 같은 `can_use_tool` 로 온다(후자는 이 플래그가 있어야 `tools` 목록에 나타난다). **FR-APS-10 과 충돌 — §9.3 ⑥.** |
| U-4 | 세 프로토콜 각각의 세션 재개 절차와 재개 시 이벤트 로그가 어디부터 오는가 (`FR-ABG-10`) | **확인 (셋 다 이력을 재생하지 않는다 — 새 이벤트만 온다).** claude: `-p --resume <session_id>` → 같은 `session_id` 로 `system:init` 부터, 이전 대화는 프레임으로 오지 않으나 모델은 기억한다(첫 메시지를 인용). 이력은 `~/.claude/projects/<cwd>/<id>.jsonl`(FR-AGT-6 이 읽지 않는 파일). `--fork-session` 으로 새 id 분기 가능. codex: `thread/resume{threadId}` → `thread/status/changed{idle}` + 응답의 `thread` 메타, 이력은 `thread/turns/list`·`thread/items/list` 로 **페이지 조회**(`includeTurns` 전량 하이드레이션은 deprecationNotice). omp: `--mode rpc-ui --resume <id prefix>` → `ready` 부터 같은 `sessionId`, 이력은 `get_messages`/`get_messages_page` 로 조회. **결론**: FR-ABG-4 의 재생 원천은 **우리 이벤트 로그**뿐이며, 재개는 세 어댑터 모두 "인자 하나(id)" 로 성립한다. |
| U-5 | omp 의 사용량·컨텍스트 창이 프레임에 실리는가 (`FR-AGT-6`) | **확인 — 실린다.** `get_state.contextUsage{tokens,contextWindow,percent}`(라이브: 15,685/1,048,576) · `get_session_stats{tokens{input,output,reasoning,cacheRead,cacheWrite,total},cost,contextUsage}` · `message_end.message.usage{input,output,cacheRead,cacheWrite,totalTokens,cost{…}}`(라이브, 오류 턴이라 0). `model_changed` 이벤트가 모델의 `contextWindow` 를 든다. |
| U-6 | claude `--bg`/`claude attach` 가 `FR-ABG-10` 의 휴면에 쓸 수 있는가 | **확인 — 쓸 수 없다(반대 방향).** `--bg` 는 `claude daemon run` + `bg-pty-host`(200×50 PTY) 를 띄워 **TUI 를 숨은 PTY 에 살려 두는** 기계다 — 프로세스가 사라지는 휴면이 아니라 dongminal 의 백그라운드 터미널 도구와 같은 자리. `claude stop <id>` 뒤 `--resume` 이 되므로 휴면의 실체는 **`--resume` 하나**다. 부수 발견: `claude agents --json` 이 **대화형 세션까지** `status: busy\|idle` 로 낸다 — 훅 없는 터미널 도구의 보조 신호 후보 (U-10 에 적음). |
| U-7 | 세 프로토콜의 종료 절차 — `ExitCommand` 를 대신할 것이 무엇인가 | **확인 — 셋 다 stdin EOF.** claude: `control_request{subtype:"interrupt"}` → `control_response{still_queued:[]}` + `result{subtype:"error_during_execution",terminal_reason:"aborted_streaming"}` 가 **0.01s**, 그 뒤 stdin 닫으면 **0.84s** 에 종료. codex: `turn/interrupt{threadId,turnId}` 가 있고 stdin 닫으면 **0.06s** 에 exit 0. omp: `abort` 명령이 있고 stdin 닫으면 열린 UI 요청을 거절·세션 dispose 후 exit 0 (**0.05s**, 문서 그대로). **주의**: omp 가 로그인 `input` 대기 중에 stdin 을 닫으면 `input` 재요청이 폭주했다(1,162회, 종료 5s 초과) — 호스트는 열린 요청에 `{cancelled:true}` 로 답한 뒤 닫아야 한다. |
| U-8 | 데몬 모드에서 파이프 3개를 IPC 로 중계하는 비용 (`FR-AGT-3`, `NFR-3`) | **확인 — 같은 길로 간다. §9.3 ④.** |
| U-9 | **기능 대조표** | **§9.3 ①.** |
| U-10 | 세 TUI 가 내는 알림 시퀀스 | **확인.** claude: `preferredNotifChannel` ∈ `auto·iterm2(OSC 9)·iterm2_with_bell·kitty(OSC 99)·ghostty(OSC 777)·terminal_bell(BEL)·notifications_disabled`; 발화는 `idle_prompt`("Claude is waiting for your input") — 턴 완료 후 `messageIdleNotifThresholdMs`(기본 60,000) 경과·그 사이 키 입력 없음·다이얼로그 없음, 그리고 승인 프롬프트. PTY 실측: `iterm2_with_bell` + 승인 프롬프트에서 `OSC 9;Claude is waiting for your input` 포착(2초 임계값). `terminal_bell` 두 회차는 BEL 미포착(포커스 이탈 키가 "상호작용" 으로 읽혀 억제된 것으로 보임 — 조건은 바이너리에서 읽었고 발화는 미재현). 제목 OSC 0 에 상태 글리프(✳·◐·◑)가 실려 "working" 을 말한다. codex: `tui.notification_method` ∈ `osc9·bel`(`codex_tui::notifications::osc9`), 조건 `tui.notifications`/`notification_condition`. omp: `completion.notify`(기본 on)·`ask.notify`(on)·`error.notify`(off) → `TERMINAL.sendNotification` → 터미널 감지에 따라 OSC 9(iterm2·wezterm·ghostty·warp)·OSC 99(kitty)·**BEL(그 외 — dongminal 은 `TERM=xterm-256color` 만 주므로 여기)**; tmux 안에서는 DCS 패스스루 + BEL. dongminal 의 L1 은 OSC 9(9;4 제외)·99·777;notify 를 이미 잡고 BEL 은 `DONGMINAL_ATTENTION_BELL=1` 옵트인이다 — **선택지 C 는 세 TUI 모두에서 보조 채널로 성립**하되 omp 는 BEL 옵트인 또는 `TERM_PROGRAM` 힌트가 필요하다. |

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

### 9.3 P0 스파이크 산출물 (2026-09-13)

> §4 P0 행의 ①~⑤. 실측 근거는 §9.1. 코드는 한 줄도 고치지 않았다.

#### ① 기능 대조표 (U-9) — FR-U-4 의 근거

**길**: **P** = 프로토콜 프레임/명령으로 된다 · **F** = 파일(설정·자산)로 기동 전에 정한다 ·
**T** = TUI 출구(같은 세션을 터미널 탭으로)로만 된다 · **—** = 그 에이전트에 그 기능이 없다.
괄호 안은 근거. "미확인" 은 자격증명이 없어 라이브로 못 본 것.

| 기능 | claude 2.1.270 | codex 0.154.0 | omp 17.4.0 |
|---|---|---|---|
| 로그인 (인증 자체) | **T** — `/login` 은 TUI 전용. `claude setup-token` 으로 장기 토큰은 CLI. 프로토콜 모드는 TUI 와 같은 저장소를 읽는다(라이브) | **P** — `account/login/start`(ChatGPT 브라우저·API 키)·`account/login/cancel`·`account/logout`·`account/read`; 완료는 `account/login/completed` 알림 | **P** — `get_login_providers`(63 공급자, `authenticated` 플래그) · `login{providerId}` → `open_url`·`notify`·`input`(인증 코드) UI 요청 (라이브, anthropic 흐름 관찰) |
| 설정 파일·설정 값 | **F** `~/.claude/settings.json` + `--settings <json>`(기동 인자, 세션 스코프). 세션 중 `/config key=value` 가 **P** 로 된다(라이브: 사용법 응답) | **F** `~/.codex/config.toml` + `-c key=value`. **P** `config/read`·`config/value/write`·`config/batchWrite`(라이브 read) | **F** `~/.omp/agent/config.yml` + `--config <overlay>`. **P** `config_update` 프레임·`/settings` 류 builtin 명령(미확인 라이브) |
| 모델 선택 — 기동 시 | **P** `--model` (라이브) | **P** `thread/start.model`·`turn/start.model` | **P** `--model`(퍼지) (라이브) |
| 모델 선택 — 세션 중 | **P** `control_request{set_model}` → `success`(라이브, `/model` 이 "Sonnet 5 (this session only)" 확인). 목록은 `initialize` 응답 `models[]` | **P** `model/list`(라이브, `gpt-6-astra` 등) + 다음 `turn/start.model`. 턴 중 전환 미확인 | **P** `set_model{provider,modelId}`·`cycle_model`·`get_available_models` → `model_changed` 이벤트 (라이브) |
| 권한/plan 모드 전환 | **P** `--permission-mode` 기동 · `control_request{set_permission_mode}` 세션 중 → `system:status{permissionMode}` (라이브, plan 전환 뒤 ExitPlanMode 가 `can_use_tool` 로 옴) | **P** `thread/start.approvalPolicy`(`untrusted·on-request·never·granular`)·`sandbox` · `turn/start.approvalPolicy`(이후 턴에도 적용) | **P** `--approval-mode always-ask\|write\|yolo` 기동. 세션 중 전환은 `/settings` builtin 경유 — 미확인 |
| 슬래시 명령 | **P 일부** — `prompt` 로 `/model`·`/compact`·`/clear`·`/context`·`/cost`·`/config` 가 `assistant{model:"<synthetic>"}` + `result` 로 답한다(라이브). `/status` 는 "isn't available in this environment"; `init.terminal_slash_commands`(`doctor·color·reload-plugins`) 는 **T** | **P** `turn/start` 입력 `/status` 가 userMessage 로 실렸다(미확인 — 모델 앞에서 실패). TUI 전용 명령 목록은 미확인 → **T** 로 둔다 | **P** `prompt{message:"/…"}` → `command_output` (라이브: `/model`·`/context`·`/usage`·`/compact`). `available_commands_update` 가 55개 명령(builtin·skill·extension·custom·file)을 든다 |
| 스킬·플러그인 | **F** `--plugin-dir`·`--settings`(지금 `PolicyInjection` 그대로). **P** `init.skills·plugins·agents·slash_commands` 목록, `Skill` 도구 호출은 프레임으로 관찰 가능 | **P** `skills/list`·`plugin/list`·`plugin/install`·`hooks/list`·`marketplace/*` | **F** `--hook`·`--plugin-dir`·`-e`. **P** `available_commands_update` 에 `skill:*` 가 실린다(라이브) |
| `/compact` | **P** `prompt "/compact"` → `system:status{compact_result}`·`system:compact_boundary{compact_metadata{pre_tokens,post_tokens,…}}`·새 `system:init`·요약 `user` 메시지 (라이브) | **P** `thread/compact/start` → `thread/compacted` 알림 | **P** `compact{customInstructions?}` 명령 또는 `prompt "/compact"` → `command_output` (라이브: "Nothing to compact") |
| `/clear` (새 대화) | **P** `prompt "/clear"` → `conversation_reset{new_conversation_id}` + 새 `system:init` — **세션 id 가 바뀐다**(라이브: `09142f1e…`→`d222a4ac…`). 어댑터가 이 프레임에서 신원을 갱신해야 한다 | **P** `thread/start` 를 새로 (한 프로세스가 여러 thread) | **P** `new_session{parentSession?}` |
| MCP 서버 | **P** `init.mcp_servers[{name,status}]`·`control_request{mcp_status}`(config 포함, 라이브)·`mcp_set_servers`. 추가 자체는 **F**(`--mcp-config`) | **P** `mcpServerStatus/list`·`config/mcpServer/reload`·`mcpServer/oauth/login`·`mcpServer/tool/call` | **F** `mcp-config.md`. **P** `notice`(xd:// 마운트 목록, 라이브) |
| 승인 응답 | **P** `can_use_tool` ↔ `control_response`(라이브 왕복) | **P** `item/commandExecution/requestApproval`·`item/fileChange/requestApproval`·`item/permissions/requestApproval`·`item/tool/requestUserInput` ↔ `{decision: accept\|acceptForSession\|acceptWithExecpolicyAmendment\|decline\|cancel}`(스키마) | **P** `extension_ui_request{select,["Approve","Deny"]}` ↔ `extension_ui_response{value}`(소스) |
| 사용량·컨텍스트 창 | **P** `result.modelUsage[m].contextWindow`·`usage`·`rate_limit_event`(라이브) | **P** `thread/tokenUsage/updated`·`account/rateLimits/read`(라이브: 401)·`account/usage/read` | **P** `get_state.contextUsage`·`get_session_stats`·`message_end.usage`(라이브) |
| 진행 중 개입 | **P** `interrupt`(라이브) · 큐잉된 사용자 메시지 | **P** `turn/interrupt`·`turn/steer` | **P** `steer`·`follow_up`·`abort`·`abort_and_prompt` |

**FR-U-4 의 결론**: TUI 출구가 **필수인** 칸은 claude 의 로그인·터미널 전용 명령 셋뿐이다.
나머지는 프로토콜이 주거나 파일로 기동 전에 정한다. 그래도 TUI 출구는 남긴다 —
"프로토콜이 없는 것" 이 아니라 **"사용자가 TUI 로 하고 싶은 것"** 을 위해서다 (사용자
요구 2026-09-13).

**사용자 요구 (2026-09-13, P0 중)**: *"omp 는 여러 방식으로 로그인이 가능한데 이걸 다
사용할 수 있어야 해 — 모델 변경이라거나 그런 거."* → 에이전트 도구는 프로토콜이 주는
로그인 공급자 목록·로그인 흐름(`open_url`·`input`)·모델 목록·모델 전환을 **UI 로 노출**한다.
**FR-AGT-11** 로 §3.4.2 에 더했다.

**사용자 요구 (2026-09-13, P0 중, 둘째)**: *"에이전트 화면 동시 접근에 대해서는 터미널과
같은 동작으로 한쪽만 컨트롤하도록 블로킹하기."* → 창 포커스 소유(`FR-XDF-*`, `.pn-dimmed`)를
에이전트 도구 뷰가 그대로 지난다. **FR-AGT-12** 로 §3.4.2 에 더했다.

#### ② 가짜 에이전트 픽스처 판정 (V-12)

**가능하다.** 세 표면이 전부 "stdin 한 줄 → stdout 여러 줄" 의 JSONL 이고 상태가
작다(codex 는 `threadId`·`turnId`, omp 는 요청 `id`, claude 는 `request_id`). 픽스처는
**Go 테스트 바이너리의 서브커맨드 하나**(`fakeagent claude|codex|omp <시나리오>`)로,
`gittest` 픽스처와 같은 지위로 `internal/shared/agentadapter/fakeagent` 에 둔다.
시나리오는 실측 파일(`/tmp/m8-spike/*.jsonl`)에서 **형태만** 옮긴 것(내용은 `PONG`
류로 치환, NFR-C-1): 한 턴 · 승인 열림 · 승인 뒤 도구 결과 · 재개(`--resume`/
`thread/resume`/`--resume`) · 프로세스 즉사(V-8) · 큰 프레임(omp `rpc_chunk`).

| 검증 | 픽스처로 | 실제 바이너리로 |
|---|---|---|
| V-1 공통 이벤트 | 형태 (CI) | 드리프트 (야간 잡 — claude 만 자격증명이 있다) |
| V-2 승인 왕복 | ✅ | — |
| V-3 재생 | ✅ | — |
| V-5 무동작 | ✅ (PTY 없음이 곧 픽스처) | — |
| V-6 혼합 배치 | ✅ | — |
| V-8 끊김 | ✅ (시나리오가 자기를 죽인다) | — |

전제: 어댑터의 `Proto.Launch` 가 **실행 파일 경로를 주입받는다**(등록부의 `DetectCmd`
가 아니라 옵션으로) — 그래야 e2e 가 `PATH` 를 건드리지 않고 픽스처를 꽂는다.
`check-agent-names` 는 픽스처 코드까지 덮는다(에이전트 이름은 서브커맨드 인자로만).

#### ③ `Adapter` 프로토콜 필드 시안 (FR-APS-9 · FR-U-2)

**셋이 한 구조체에 든다.** 차이는 전부 함수 안에서 끝난다 — 갈라야 할 에이전트는
없다. 판정 근거: 세 표면의 차이는 (a) 핸드셰이크 유무(codex `initialize`/`initialized`,
omp `negotiate_protocol` 선택) (b) 서버→클라 **요청**의 id 자리(claude `request_id`,
codex JSON-RPC `id`, omp `extension_ui_request.id`) (c) 도구 상태(codex `threadId`)
뿐이고 셋 다 `ProtoState` 하나로 닫힌다.

```go
// Proto 는 프로토콜 표면의 선언이다 (FR-APS-9). Adapter.Proto 가 nil 이면 이
// 에이전트는 에이전트 도구로 뜰 수 없다 — 소비자는 그것을 부재로 받는다 (FR-APS-4).
type Proto struct {
	// Launch 는 프로토콜 모드 기동 argv 다. 프롬프트는 싣지 않는다 — 입력은
	// Prompt 가 프레임으로 만든다. opts.Bin 이 실행 파일이다 (② 의 전제).
	Launch func(opts LaunchOpts) []string
	// Handshake 는 기동 직후 호스트가 먼저 보내는 프레임들이다. nil 이면 없다.
	Handshake func(st *ProtoState) [][]byte
	// Decode 는 stdout 한 줄을 공통 이벤트로 옮긴다. ok=false 는 "모르는 프레임" —
	// 호출자가 원문을 이벤트 로그에 남기고 부재로 올린다 (FR-APS-8). st 는 갱신된다
	// (세션 신원 · codex threadId/turnId · 열린 요청).
	Decode func(line []byte, st *ProtoState) (evs []Event, ok bool)
	// Prompt 는 사용자 입력을 프레임으로 만든다. 슬래시 명령도 여기로 간다.
	Prompt func(text string, st *ProtoState) [][]byte
	// Approve 는 열린 승인 요청에 대한 답이다. choice 는 요청이 준 선택지 중
	// 하나 그대로다 (FR-AGT-5) — 어댑터가 그것을 프레임으로 옮긴다.
	Approve func(req ApprovalRequest, choice string, st *ProtoState) ([]byte, error)
	// Cancel 은 열린 요청을 답 없이 닫는 프레임이다. 종료 직전에 보낸다 (U-7 omp).
	Cancel func(req ApprovalRequest, st *ProtoState) []byte
	// Interrupt 는 진행 중 턴을 멈춘다. nil 이면 그 에이전트에 없다.
	Interrupt func(st *ProtoState) []byte
	// Control 은 세션 중 설정 변경(모델·권한 모드·사고 예산)이다 (FR-AGT-11).
	// 어댑터가 지원하는 키만 받고 나머지는 ErrUnsupported 다.
	Control func(op ControlOp, st *ProtoState) ([]byte, error)
	// TUIResume 은 TUI 출구의 기동 argv 다 (FR-AGT-10) — 같은 세션을 터미널 탭에서.
	TUIResume func(sessionID string) []string
}

// 종료(U-7)는 필드가 아니라 규약이다: 열린 요청을 Cancel 로 닫고 stdin 을 닫는다.
// 셋 다 그것으로 정중히 끝난다. Exit 필드를 두지 않는 이유는 "없는 것을 선언
// 테이블로 두지 않는다" (D-U-6) 와 같다.

type LaunchOpts struct {
	Bin, Cwd, Model string
	Resume          string // 세션 신원. 비어 있으면 새 세션
	Approval        string // 승인 정책 — omp 는 기본이 yolo 라 반드시 싣는다 (§9.1 U-1)
}

// ProtoState 는 도구 하나의 프로토콜 상태다. 어댑터만 읽고 쓴다.
type ProtoState struct {
	SessionID string
	Open      map[string]ApprovalRequest // 열린 요청 (FR-APS-5)
	Ext       any                        // 어댑터 사적 상태 (codex: threadId·turnId·JSON-RPC id 카운터)
}

type ApprovalRequest struct {
	ID      string   // 프로토콜의 id 그대로 (답에 되돌린다)
	Tool    string
	Detail  string   // 명령·경로 (FR-AAL-4)
	Options []string // 프로토콜이 준 선택지 그대로 (FR-AGT-5)
	Raw     json.RawMessage
}

// Event 는 공통 이벤트다 (FR-APS-2·3). Kind 만 열거하고 활동 어휘는 여기서 파생한다:
// session→idle · turn_start→working · approval_open→waiting · turn_end→done · exit→ended.
type Event struct {
	Kind EventKind // session · turn_start · turn_end · text_delta · thinking_delta ·
	               // tool_start · tool_end · approval_open · approval_closed · usage ·
	               // status(모델·권한모드) · reset(신원 교체, claude /clear) · error · raw
	// 이하 Kind 별 값 — 없는 것은 영값이 아니라 부재다 (FR-APS-4)
	SessionID string
	Text      string
	Tool      string
	Detail    string
	Approval  *ApprovalRequest
	Usage     *ProtoUsage // Tokens·ContextWindow·CostUSD·Model — 전사본을 읽지 않는다 (FR-AGT-6)
	Raw       json.RawMessage
}
```

세 에이전트의 필드별 매핑(요약): `Launch` — claude `-p --output-format stream-json
--input-format stream-json --include-partial-messages --verbose --permission-prompt-tool
stdio [--resume id]` · codex `app-server` · omp `--mode rpc-ui --approval-mode <a>
[--resume id]`. `Handshake` — codex `initialize`+`initialized`+`thread/start|resume` · omp
`negotiate_protocol 2`(선택) · claude 없음(`initialize` 는 선택이며 `models`·`commands` 를
준다). `Approve` — claude `control_response` · codex JSON-RPC result `{decision}` · omp
`extension_ui_response{value}`. `Interrupt` — claude `interrupt` · codex `turn/interrupt` ·
omp `abort`. `Control` — claude `set_model`·`set_permission_mode`·`set_max_thinking_tokens` ·
codex 다음 `turn/start` 의 `model`·`approvalPolicy` · omp `set_model`·`set_thinking_level`.
`TUIResume` — `claude --resume <id>` · `codex resume <id>` · `omp --resume <id>`.

터미널 표면의 필드(`Launch`·`HookParse`·`InstallAssets`·`ParseUsage`·`ContextWindow`·
`Readiness`·`Signals`)는 **그대로**다 (FR-U-3). `Adapter` 에 `Proto *Proto` 하나가 는다.

**P3 가 구현한 모양과 시안의 차이** (2026-09-13): `Approve(req, Decision, st)` — `Decision{Choice,
Answers}` 로 승인(`allow`·`deny`·`suggestion:<i>`)과 질문 답변(`answers`)을 한 시그니처가 받는다 ·
`ApprovalRequest` 에 `Kind`(`permission`·`question`)·`Questions` 가 는다 · `Event.Status *ProtoStatus`
(모델·권한 모드·모델 목록·명령 목록·계정) 가 `initialize` 응답과 `system:status` 를 나른다 ·
`LaunchOpts.PermissionMode` 추가 · `Cancel` 은 claude 에 없어 nil (D-U-6). 나머지는 시안 그대로.
두 표면이 한 파일(`claude.go` 등)에 나란히 놓이므로 R-8 의 완화(같은 표에서 도는
단위 테스트)가 성립한다.

**P4 판정 (2026-09-13) — FR-U-2 첫 판정: 셋이 한 구조체에 든다.** GUI 용 어댑터를 따로 두지
않았다. 시안에서 더 움직인 것 셋: ① `Handshake(opts LaunchOpts, st)` — codex 의 cwd·모델·재개는
기동 인자가 아니라 `thread/start|resume` 요청의 것이라 핸드셰이크가 LaunchOpts 를 받는다
(소비자 `agentsess.Open` 이 기동에 쓴 opts 를 그대로 넘긴다 — 한 인자). ② `LaunchOpts.Approval` —
승인 정책(F-4), 어댑터 어휘 그대로; omp 만 싣고(`--approval-mode`, 비면 `always-ask`) 나머지는
무시한다. 값은 브라우저 설정 `agentApprovalMode`(`SETTINGS_SCHEMA`·`SETTINGS_ACCESS`) 가 생성
쿼리 `approval` 로 싣는다. ③ `Question.FreeText` — 선택지 없는 질문(omp `input`·`editor`, codex 의
선택지 없는 `requestUserInput`). `ApprovalRequest.Kind` 두 값으로 omp 의 위젯이 전부 들어갔다:
`select["Approve","Deny"]`+`Allow tool:` 제목 → permission · 그 밖의 `select`·`input`·`editor` →
question · `confirm` → permission(Yes/No) · `notify`·`open_url` → 본문(`user`) · 나머지 위젯은
무시. codex 의 서버 요청 넷(`commandExecution`·`fileChange`·`permissions`·`requestUserInput`)이
승인·질문으로 들어가고, 선택지는 codex 의 decision 그대로(`accept`·`decline`·`acceptForSession`·
`acceptWithExecpolicyAmendment`·`cancel`)다. codex 의 `Control` 은 보낼 프레임이 없어 빈
프레임(빈 줄, codex 가 무시)을 돌려주고 다음 `turn/start` 에 싣는다 — `PermissionModes` 는
`untrusted·on-request·never`. omp 는 `PermissionModes` 가 비어 있다(세션 중 전환 없음).

#### ④ 데몬 파이프 중계의 설계 선택 (U-8 · §9.2 R-g)

**같은 길로 간다 — 조건 둘.** 지금의 길: 데몬 `readPTY` → `outbuf.Stream.Feed`(절대
오프셋 `end`) → `panedConn.pushOutputData{event:"output",tool,data(base64),end}`
(**droppable**) → 서버 `toolclient.handlePush` → `OnOutput` 한 번 + WS 구독자 fan-out.
쓰기는 `write{id,data(base64)}` RPC. 재접속은 `snapshot{id,since}` 가 링에서 `since`
이후를 준다.

에이전트 프로세스의 stdout 도 바이트열이고 해석(`Proto.Decode`)은 서버가 하므로 이
길이 그대로 맞는다. 비용은 PTY 와 같다(base64 4/3 + JSON 봉투; AS-4 의 20 프레임/턴은
PTY 화면 갱신보다 작다). **다른 것 둘**:

1. **드롭 정책.** PTY 청크는 떨어져도 화면이 자기치유하지만(다음 `snapshot`), 프로토콜
   프레임 하나가 떨어지면 승인 요청이 사라진다. 그래서 에이전트 도구의 `output` 은
   `enqueue(…, droppable=false)` — `exit` 이벤트와 같은 등급. 막히는 것은 그 도구의
   read 고루틴 하나이고, 그것은 파이프를 통해 에이전트에 역압을 준다. NFR-C-3 와의
   충돌은 "죽은 dongminal" 에서만 생기며 그때는 도구가 멈추는 것이 맞다(오류 상태,
   FR-ABG-20). 보조로 서버가 `end` 의 틈을 보면(`prev.end+len(data) != end`)
   `snapshot{since}` 로 메운다 — 링(`outbuf` max)이 그 틈보다 크면 회복된다.
2. **줄 경계와 stderr.** 청크는 줄과 무관하므로 서버가 도구마다 줄 버퍼를 든다
   (omp 는 1 MiB 프레임 상한, `rpc_chunk` 재조립도 서버). stderr 는 PTY 에 없던
   스트림이다 — 데몬이 작은 링에 모아 `snapshot` 으로 주거나 `output` 에
   `stream:"stderr"` 를 붙여 민다. **후자**를 권한다 — 연결 끊김(FR-ABG-20)의 이유가
   stderr 에 있다(codex 의 401 이 그랬다).

`create` RPC 에 `kind`·`argv` 가 더해지고(⑤), `resize`·`paste` 는 그 종류에서 무동작을
답한다(FR-AGT-2). 이것이 P1 ④ `GO-46`(`ToolHub` 인터페이스) 설계에 들어간다:
**인터페이스는 바이트 지향으로 유지**하고, 종류가 갈리는 메서드는 없다.

#### ⑤ D-U-4 판정 — 새 종류 vs 전송만 다른 변형

**판정: 전송만 다른 변형 + `Kind` 표식.** `ToolHub`·데몬·`toolclient` 의 길이 전부
바이트 지향이고(④), `NewDetachedTool` 의 `term == nil` 계약이 이미 "전송이 없는 Tool"
을 지나고 있다. 종류가 실제로 갈리는 자리는 셋뿐이다: (a) 서버의 해석층 —
`Proto.Decode` → 이벤트 로그 → 열린 요청 큐 → L1 알람 (b) 브라우저의 뷰 — xterm 대신
대화 뷰 (c) 전송이 필요한 호출(리사이즈·붙여넣기·전경 프로세스 폴링) 의 무동작.
(c) 는 `platform.Terminal` 자리에 `pipeTransport` 를 두면 인터페이스 안에서 끝난다.

그러므로 `GO-46` 에 싼 쪽은 **변형**이다 — 새 종류로 두면 `ToolHub` 인터페이스가
종류별 메서드를 갖게 되고 소비자가 종류를 묻는 자리가 (a)(b)(c) 밖으로 샌다
(FR-AGT-8 위반). D-U-4 는 이렇게 **정정됐다** (사용자 승인 2026-09-13): *"에이전트
도구는 `Tool.Kind = agent` 인 변형이다. 배치·영속·복원·포커스·백그라운드·데몬 중계는
바이트 길을 공유하고, 종류를 묻는 코드는 해석층·뷰·전송 호출 셋에 한정된다."*

#### ⑥ 스펙과 실측의 충돌 — 플래그 (F-1 은 사용자 판단으로 반영됨, 나머지는 해당 단계에서)

| # | 자리 | 실측 | 제안 |
|---|---|---|---|
| F-1 (**정정 반영 2026-09-13**) | **FR-APS-10** "claude 승인은 MCP 도구로 온다 — MCP 서버를 하나 든다" | **거짓.** `--permission-prompt-tool stdio` 가 승인을 stdio `control_request` 로 보낸다. MCP 서버는 필요 없다 (U-3 라이브 왕복) | FR-APS-10 을 *"claude 의 승인 요청은 stdio 제어 프레임(`can_use_tool`)으로 온다; 어댑터의 `Launch` 가 `--permission-prompt-tool stdio` 를 싣는다. MCP 서버는 두지 않는다"* 로 정정. R-c 의 "범위 항목" 도 해소. **단, 숨은 플래그다**(헬프에 없음) — R-2 에 "2.1.270 실측, 비공개" 를 적는다 |
| F-2 | §2.3.4 표 (2.1.269) | 2.1.270 에 프레임이 늘었다: `system:status{status:"requesting"\|permissionMode\|compact_result}`·`system:permission_denied`·`system:compact_boundary`·`conversation_reset`·`control_request/control_response`·`user`(tool_result·`<local-command-stdout>`)·`init.capabilities/terminal_slash_commands/messaging_socket_path`·`result.terminal_reason/stop_reason/queued_turn_count` | §2.3.4 에 "2.1.270 추가" 행을 더한다. FR-APS-3 의 최소 목록에 **신원 교체(reset)** 를 더한다 (`/clear` 가 세션 id 를 바꾼다) |
| F-3 | AS-1 "한 프로세스가 한 세션" | codex 는 한 프로세스가 여러 thread 를 든다 (U-2) | AS-1 을 *"한 프로세스를 한 도구로 쓴다 — 다중화는 쓰지 않는다"* 로 고쳐 적는다. 설계는 안 바뀐다 |
| F-4 | omp 승인 (§2.3.3 "`extension_ui_request` 프레임을 호스트가 답한다") | 맞다 — 그러나 **기본 `approvalMode` 가 yolo** 라 인자 없이 띄우면 승인 요청이 **한 번도 안 온다**, 그리고 `--mode rpc` 는 승인이 오류다 | `Proto.Launch` 가 `--mode rpc-ui --approval-mode <정책>` 을 **반드시** 싣는다. 정책 값은 설정 키(`SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다) — P3/P4 에서 |
| F-5 | §2.3.2 "codex 는 사실상 침묵한다" (터미널 표면) | codex 0.154.0 은 `hooks` 기능이 **stable** 이고 claude 와 같은 훅 이벤트(`SessionStart·UserPromptSubmit·PreToolUse·PermissionRequest·PostToolUse·PreCompact·Stop·SessionEnd·SubagentStart/Stop·Interrupt`)를 `~/.codex/hooks.json` 으로 받는다(바이너리 문자열 + 사용자 홈의 파일). **터미널 표면의 사실이라 이 문서의 범위 밖**(FR-U-3) | 기록만. `codexAdapter` 의 훅 표면 확장은 별도 문서(후속). §2.3.2 표에 각주 하나 |
| F-6 | U-6 의 전제 "`--bg` 가 휴면 후보" | 반대다 — TUI 를 숨은 PTY 에 살려 두는 기계 | FR-ABG-10 의 재개 열은 `--resume` 하나. `--bg` 는 비목표(§7)에 적는다 |

#### ⑦ 이 세션이 만든 부작용과 남긴 것

- codex app-server 가 `~/.codex/config.toml` 에 `[projects."/private/tmp/m8-spike/cwd"] trust_level="trusted"` 를 **스스로 썼다** — 되돌렸다. P3/P4 의 어댑터는 이 부작용을 안다(cwd 마다 신뢰 항목이 사용자 설정에 남는다; R-e 의 규약).
- claude `--bg` 가 `claude daemon run` 을 남겼다(`/tmp/cc-daemon-501/…`) — `stop`·`rm` 뒤에도 데몬 프로세스는 남는다. 우리가 쓰지 않으므로 무관.
- omp 세션 파일 둘·claude 세션 파일 다섯이 `/private/tmp/m8-spike/cwd` 프로젝트 아래 남았다 (사용자 홈, 내용은 `PONG` 류).
- 실측 드라이버 `/tmp/m8-spike/drive.py`(stdio JSONL)·`ptycap.py`(PTY 캡처) — 픽스처(②)와 야간 잡의 출발점. 저장소에 넣지 않았다.

---

## 10. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-14 | **P7 완료 — M8 완료.** 항목별 판정은 `production/M8_PROGRESS.md` §1-13, 전량 e2e 는 §1-14. 착수 실측(드리프트 셋 초록) 뒤 재감사 — GO-25·26·D-WBR-8 은 이미 해소(각각 술어의 성질·FR-TRS-12·D-WBR-19), 나머지는 열림. D-A-10~27 신설: 분리는 이동(D-A-10, 500줄 초과 26→20 · 지목 다섯 전부 500 아래) · doctor 표(D-A-11) · `serve`→`buildApp/run/shutdown` + 종료 순서 표(D-A-12) · Run 표식 트리 조작 `workspace.ApplyRunMarks`(D-A-13) · `..` 조각 판정(D-A-14, 동작 변경) · `shared/pollwait`(D-A-15, stop 대기 동작 변경) · JSON-RPC 코드·`decodeParams`·`RPCError`·`CodeToolCap`(D-A-16 — 구현 중 발견: 클라이언트가 오류 응답을 한 번도 오류로 읽지 않았다, 동작 변경) · `DefaultCols/Rows`(D-A-17) · `dataPath` 삭제(D-A-18) · Sync 상태기계 삭제(D-A-19) · `shared/gittest`(D-A-20) · 셸 고정 `PinShell`+셸별 서브테스트(D-A-21) · 훅 stub 한 형식·GO-42 는 조건 미충족 그대로(D-A-22) · 오류 세션 런타임 회수 `Reap`(D-A-23, 동작 변경) · `wait` 기본 상한 `runwait`(D-A-24) · 창·탭 생성 실패 `_notify`(D-A-25) · 남기는 것과 사유(D-A-26: GO-44·한국어 본문 9곳·§5-5 군집·이행 경로·`migrate`·docker 검사) · `submodule update` 는 작업(D-A-27, FBE-08, 동작 변경). §3.2 ⑥·⑦ 이 닫혔다 |
| 2026-09-14 | **P6 완료.** 항목별 판정은 `production/M8_PROGRESS.md` §1-11, 전량 e2e 는 §1-12. 착수 실측(드리프트 셋 초록) 뒤 재감사 — FBE-11 은 이미 해소(FR-TRS-12), codex 표면은 실측이 전제를 뒤집음(0.154.0 `[PROMPT]`·`--model`). D-A-1~9 신설: `shared/runwait` 예산(D-A-1) · `dmctlDelivery` exit 1(D-A-2, 동작 변경) · `closedTabs[].closed` 는 방송 결과(D-A-3) · codex 터미널 표면 argv·`--model` + `launchNotes`(D-A-4, 사용자 결정) · `status --member`(D-A-5) · `run delete`·`run graph`(D-A-6) · 없는 `cwd` 400 `tool_cwd_missing`(D-A-7) · `wrapPaste`·`quoteEnvelope`(D-A-8) · 격리 기동 안내·전경 도구 홈(D-A-9, 동작 변경). §3.2 ⑥ 의 `FBE-09~11` 은 P6 가 닫았다(인계서가 그것을 P6 DoD 로 들었다) |
| 2026-09-14 | **P5 완료.** 항목별 판정은 `production/M8_PROGRESS.md` §1-9, 전량 e2e 는 §1-10. 세션이 프로세스보다 오래 산다(D-C-11 — `Dormant` hibernated·error, 같은 `toolId` 로 재개 `ReuseID`) · 디스크 `agents/<toolId>.jsonl`+`agents.json`(D-C-12·14) · 요약 스냅샷은 버려진 이벤트의 접힘(D-C-13) · `EvExit` 사유 + stderr 꼬리 `ExitInfo`(D-C-15, 데몬 `exit` push 가 실제 code·stderr 를 싣는다) · 신원 없는 도구는 휴면 불가, claude `initialize` 응답이 `idle`(D-C-16) · 휴면 세션은 `/api/state.tools` 에 합쳐진다(D-C-17). HTTP `hibernate`·`resume`, 오류 코드 셋. P4 발견 둘 해소(가짜 claude 의 init 시점 · codex rejoin). 발견: 틈 되메움이 readLoop 안의 RPC 였다(§2-30, 비동기로) |
| 2026-09-14 | **P5 착수.** 드리프트 잡 셋 초록. §3.4.4 P5 착수 실측(omp 접두 무제한·모호하면 조용히 고른다 · codex `thread/resume` 이 살아 있는 thread 를 rejoin 한다 · 재 `initialize` 는 `Already initialized`). D-C-11~17 — 휴면·오류는 세션의 상태, 같은 `toolId` 로 재개(`ReuseID`) · 디스크 JSONL(SSE 와 같은 줄)+`agents.json` · 스냅샷은 버려진 이벤트의 접힘 · `EvExit` 가 사유를 든다 · 신원 없는 도구는 휴면 불가(claude 첫 턴 전) · 휴면 도구는 목록에 합쳐진다 |
| 2026-09-13 | **P4 완료.** 항목별 판정은 `production/M8_PROGRESS.md` §1-7, 전량 e2e 는 §1-8. codex·omp 어댑터가 같은 `Proto` 구조체에 들어갔다(FR-U-2 첫 판정 — §9.3 ③ P4 판정). §2.3.3 에 P4 재실측 표. D-U-5 의 대조 잡(`drift_test.go`, 사건 주기). F-4 의 설정 키 `agentApprovalMode`. `Handshake` 가 LaunchOpts 를 받는다 · `LaunchOpts.Approval` · `Question.FreeText`. 가짜 에이전트가 세 프로토콜을 말한다 (argv 모양으로 고른다). P4 발견 둘: claude 의 `system:init` 은 첫 프롬프트 뒤(§2-28) · codex 되살림은 thread 를 잃는다(P5) |
| 2026-09-13 | **P3 완료.** 항목별 판정은 `production/M8_PROGRESS.md` §1-5, 전량 e2e 는 §1-6. 묶음 P(`Adapter.Proto`·claude 구현·가짜 에이전트)·T(`Kind=agent` 변형·파이프 전송·`/api/agent/*`·`AgentPane`·TUI 출구)·A(활동 보고 한 자리·L2 idle 제외). **D-C-10** 신설 — 종류는 청크에 실려 온다(데몬 readLoop 의 자기 RPC, §2-25). 둘째 세션이 잡은 뷰 결함 둘(재생 비행 중 SSE·열린 요청 이중 계수, §2-26). V-11 확인: 훅 표면 diff 0 · `claude.go` 3줄 |
| 2026-09-13 | **P3 중 사용자 지시.** FR-AGT-4a — Esc 인터럽트 · ↑↓ 프롬프트 히스토리 · 슬래시 자동완성 · Shift+Tab 권한 모드 순환 |
| 2026-09-13 | **P3 착수.** §2.3.4 P3 재실측(같은 판 · `AskUserQuestion` payload · `updatedPermissions` 적용 확인). FR-AGT-4 에 **질문 답변** 추가(사용자 지시). FR-AGT-12 의 P3 결정(D-C-4). NFR-C-2 값. D-C-1~9. §9.3 ③ 실제 모양 |
| 2026-09-13 | **P2 완료.** 항목별 판정은 `production/M8_PROGRESS.md` §1-3, 전량 e2e 는 §1-4. 카탈로그 915키(ko·en 전수), JS·HTML 한글 리터럴 0, CSS `content` 문구 0, 게이트 `check-i18n.mjs`(탐침 5종)·`check-http-error.sh` 확장, 설정 키 `locale`(TC-CFG-4 24). 전량이 잡은 셋: 격리 하네스의 전역 · **D-B-3a**(파생 코드의 본문은 사유) · `lang=ko` 의 글리프 메트릭(기준선 값 하나). FR-B-9 는 별도 데이터 커밋(TC-B-7) |
| 2026-09-13 | **P2 착수.** §2.2 실측 정정(constants 12파일·JS 884줄/43파일·HTML 72줄·`http.Error` 한국어 0). FR-B-1 결정(안 A: ko·en · 기본 ko · 감지 없음 · 폴백 ko · CLI 밖 · 서버 본문 동결). §3.3 에 키 규약·게이트 규칙 신설, FR-B-8 정정, D-B-1~4, TC-B-6·7 정정, TC-B-8 추가 |
| 2026-09-13 | **P1 코드 완료** (전량 e2e 대기). ①~④ + TEST-8 의 항목별 판정은 `production/M8_PROGRESS.md` §1-1. DoD 밖으로 남긴 것: GO-44 의 `Git *store.Store`(gitapi 의 `Service()` 83곳 — ⑥ 뒤) · GO-47(DoD 없음, 축 C 의 `Kind` 와 함께) · GO-42(조건 미충족). 전량 `-race -shuffle` 이 FR-GIT-107 의 창을 잡아 `Jobs.finish` 의 순서를 고쳤다 |
| 2026-09-13 | **P1 착수.** 사용자 판단 셋 반영 — FR-APS-10 정정(stdio 제어 프레임, MCP 서버 없음) · D-U-4 정정(변형 + `Kind`) · FR-AGT-11·12 확정. R-2 에 숨은 플래그 기재 |
| 2026-09-13 | **P0 스파이크 완료.** §9.1 표를 실측으로 채우고 §9.3(산출물 ①~⑤·충돌 플래그 ⑥·부작용 ⑦)을 신설. FR-AGT-11·FR-AGT-12 추가(사용자 요구 둘). FR-APS-10·D-U-4 에 충돌 표식 — 사용자 판단 대기. 진행 기록 `production/M8_PROGRESS.md` |
| 2026-09-13 | 사용자 승인 → `승인·구현중`. 첫 단계 P0 스파이크는 `production/M8_NEXT_SESSION.md` 가 안내한다 |
| 2026-09-13 | 초안. 로드맵 §M8·§M9·§M10 과 `AGENT_PROTOCOL_SURFACE_SRS` 를 흡수해 **하나의 일정** 으로 (D-U-1). 사용자 결정 둘 — 어댑터가 인터페이스(D-U-2) · 병행(D-U-3). 원문의 묶음 H 와 묶음 A 삭제 조항 폐기. 추가 요구: FR-U-1~7 · FR-APS-9·10 · FR-AGT-8·9·10 · FR-ABG-21 · FR-B-1~10 · V-10~13 |
