# SRS: 지원 에이전트에 `omp`(oh my pi)를 더한다 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

사용자 요구 `U-21`(2026-09-11): *"지원 에이전트에 omp(oh my pi) 추가."*

dongminal 이 아는 에이전트는 지금 둘이다 — `claude`(검증 대상) · `codex`
(best-effort). `omp` 를 **세 번째 선언**으로 더해, 활동 관측 · Run 멤버 기동 ·
정책 주입 · 정중한 종료가 claude 와 같은 자리에서 돌게 한다.

`agentadapter` 의 머리에 적힌 규약을 지킨다 — **확인하지 못한 값은 추측해 채우지
않고 비운다.** 이 문서의 §2 는 그래서 전부 실측이다.

### 1.2 범위 (Scope)

- `internal/shared/agentadapter/omp.go` (**신규**) + `registry` 한 줄.
- `internal/shared/runtime/install.go` — omp 용 훅 shim 과 설정 오버레이의 설치.
- `internal/shared/runtime/shellhooks/posix/*` · `windows/powershell-hook.ps1` —
  `omp()` 래퍼.
- `internal/shared/agentadapter/adapter.go` — `MemberArgs` 의 **런타임 자리**
  (`FR-ADP-1` 개정, §3.3).
- Go 테스트: 어댑터 선언·훅 파서·래퍼 대조.

비포함:

- 활동 상태 어휘의 변경. `working`/`waiting`/`done`/`idle`/`ended` 그대로다.
- claude·codex 의 동작. 한 줄도 바뀌지 않는다.
- omp 의 `acp`·`collab`·`worktree` 같은 자체 기능과의 통합.
- `dongminal verify` 항목(별개의 미결 판정).

### 1.3 정의 (Definitions)

- **omp**: `@oh-my-pi/pi-coding-agent`. 이 호스트에서 `omp v17.4.0`,
  `~/.bun/bin/omp` → `dist/cli.js`(bun 런타임).
- **훅 shim**: dongminal 이 설치하는 **omp 훅 모듈 파일**. omp 안에서 돌며
  `dmctl activity omp` 를 불러 활동을 보고한다.
- **오버레이**: `omp --config <path>` 로 이 실행에만 얹는 `config.yml` 조각.
  사용자의 영구 설정을 건드리지 않는다 (`FR-ADP-5`).

### 1.4 참조 (References)

- `docs/internal/RUN_ORCHESTRATION_SRS.md` 묶음 A (`FR-ADP-1`~`6`) — 선언 테이블의
  계약. 이 문서가 그 `FR-ADP-1` 을 개정한다.
- `docs/internal/SKILL_INJECTION_SRS.md` (`FR-INJ-1`~`4`) — `agent-plugin` 의
  세션 스코프 주입.
- `docs/internal/archive/PANE_ATTENTION_NOTIFY_SRS.md` (`FR-PAN-19`) — 셸 래퍼가
  훅을 per-invocation 으로 붙이는 자리. **보관된 문서다** — 지금 그 계약을 지키는
  것은 `SKILL_INJECTION_SRS` `FR-INJ-4`·`5` 와 `install_posix_test.go` 의 대조다.
- `docs/internal/ORCHESTRATION_V2_SRS.md` (`FR-CBG-1`·`5`) — 컨텍스트 관측의
  곁들이 값과 "모른다 ≠ 괜찮다".
- `docs/internal/ATTENTION_FIRING_SRS.md` (`FR-ATN-2`·`3`) — `UserPrompt` 의 뜻.

## 2. 현재 상태 (조사로 확정한 사실 — 전부 실측)

### 2.1 기동면은 claude 와 거의 같다

| 항목 | 값 | 근거 |
|---|---|---|
| 실행 파일 | `omp` | `~/.bun/bin/omp` |
| 프롬프트 | **위치 인자** — `omp "List all .ts files in src/"` | `omp --help` EXAMPLES |
| 모델 | `--model` (퍼지 매칭: `opus`·`gpt-5.2`) | `omp --help` FLAGS |
| 플러그인 | `--plugin-dir <path>` (반복 가능) | `omp --help` Plugin Options |
| 훅 | `--hook <file>` (반복 가능) · `-e/--extension` | `omp --help` FLAGS |
| 설정 오버레이 | `--config <path>` (반복 가능) · 환경변수 `PI_CONFIG_FILES`(경로 목록) | `config/settings.ts:402-404` |
| 종료 | **`/exit` 있다** — "Exit the application", `/quit`(별칭 `q`)와 같은 `shutdownHandlerTui` | `slash-commands/builtin-lifecycle.ts:513` · `builtin-control.ts:73` |

### 2.2 훅이 claude 와 **근본적으로 다르다** — 프로세스가 아니라 모듈이다

claude 의 훅은 **stdin 으로 JSON 을 받는 외부 명령**이다(`hooks.json` 의
`{"type":"command","command":"… dmctl activity claude"}`). omp 의 훅은
**in-process TS/JS 모듈**이다:

```ts
export default function (pi: HookAPI) {
  pi.on("tool_call", async (event, ctx) => { … });
}
```

그러므로 `Adapter.HookParse([]byte)` 계약에 맞추려면 **우리가 shim 을 배포해야
한다** — shim 이 `dmctl activity omp` 를 띄우고 **우리가 정한 형식**의 JSON 을
stdin 으로 보낸다. 대신 얻는 것이 있다: 형식의 임자가 우리이므로 claude 처럼
남의 스키마 변화에 매이지 않는다.

**shim 이 자식 프로세스를 띄울 수 있다.** 훅 모듈은 `withHostGuard` 를 지나
import 되지만 그 guard 가 감싸는 것은 `process.exit`·`process.stdin` 뿐이다
(`extensibility/utils.ts:117-137`) — `child_process` 는 그대로 쓸 수 있다.

### 2.3 이벤트 해상도는 claude 급이다

`pi.on(...)` 의 선언(`extensibility/hooks/types.ts:483-512`)에 있는 것 중 우리가
쓰는 것:

| omp 이벤트 | 우리 어휘 |
|---|---|
| `session_start` | `idle` |
| `agent_start` | `working` + `UserPrompt=true` (그 턴이 사용자 프롬프트에서 시작한 자리) |
| `turn_start` · `turn_end` | `working` |
| `tool_call` · `tool_result` | `working` + `tool` + `detail` |
| `auto_compaction_start` · `session_compact` | `working` + `Compacted=true` |
| `agent_end` | `done` |
| `session_shutdown` | `ended` |

**세션 신원도 얻을 수 있다** — `ctx.sessionManager.getSessionId()` ·
`getSessionFile()`(`.jsonl`). 그래서 `Report.SessionID`·`Transcript` 를 비우지
않아도 된다 (`FR-CBG-1`).

### 2.4a 알람 배선 (2026-09-11 추가)

접수: *"omp 는 agents 에서 상태 바뀌는건 확인했는데 알람이 연결 안됐어."*

**원인은 omp 가 아니라 배선이었다.** shim 은 `dmctl activity omp` 만 부르고
`dmctl notify` 를 보내지 않았는데, 그때까지 알람은 에이전트마다 손으로 배선된
`dmctl notify` 에서만 나왔다. 구조를 고친 문서가
[`AGENT_EVENT_ABSTRACTION_SRS`](./AGENT_EVENT_ABSTRACTION_SRS.md) 이며, 이제
**알람은 활동 이벤트에서 파생한다** (`FR-AEV-10`). shim 은 한 줄도 바뀌지 않았다.

그 문서의 `Signals` 선언이 아래 §2.4 의 사실을 **값으로** 옮겨 적는다 —
`omp` 의 `Signals.Waiting` 은 거짓이다.

### 2.4 `waiting` 은 반만 얻는다

claude 의 `Notification` 에 대응하는 이벤트가 없다. 승인 게이트는 훅에 통지되지
않는다 — 그래서 "승인 대기" 는 관측되지 않는다. 관측 가능한 대기는 `ask` 툴의
`tool_call` 하나다. **이 사실을 선언 주석과 이 문서에 남긴다** — 비운 것과
없는 것은 다르다 (`FR-CBG-5`).

### 2.5 훅으로는 **승인할 수 없다** — 사전 허용의 수단이 다르다

사용자 판정은 *"permission-gate 훅으로 dmctl 만 사전 허용"* 이었다. 실측 결과
**그 수단은 omp 에 없다** — `ToolCallEventResult` 의 필드는
`block`·`reason`·`input` 셋뿐이고(`extensibility/shared-events.ts`) 훅은 **막을
수만 있다.** `examples/hooks/permission-gate.ts` 도 확인을 **더하는** 예다.

같은 뜻(`dmctl` 만 사전 허용)을 이루는 수단은 **설정**이다:

| 키 | 뜻 | 근거 |
|---|---|---|
| `bash.patterns` | 순서 있는 bash 승인 규칙. 항목마다 `match`·`approval`, 와일드카드는 `*` 만 | `config/settings-schema.ts:3578` |
| `tools.approval` | 툴별 정책 — `allow`/`prompt`/`deny`. **어느 승인 모드에서도 존중된다** | `:3775` |
| `tools.approvalMode` | 기본 승인 모드 — `always-ask`/`write`/`yolo` | `:3791` |

그러므로 사전 허용은 **`bash.patterns` 오버레이 한 줄**이며, 그것을 `--config`
로 **멤버 기동에만** 싣는다. `tools.approvalMode` 를 낮추는 길(=전면 우회)은
선택지가 아니다 — `FR-ADP-1` 의 주석이 이미 기각한 그 결정이다.

### 2.6 스킬 주입은 **지금 자산 그대로** 될 가능성이 크다

우리 플러그인의 레이아웃은 `.claude-plugin/plugin.json` + `skills/`
(`internal/shared/runtime/agentplugin/`)이고, omp 의 플러그인 매니페스트 탐색
경로에 **`.claude-plugin/plugin.json` 이 들어 있다**
(`extensibility/plugins/marketplace/manager.ts:423`). 그래서 `omp --plugin-dir
<agent-plugin>` 이 claude 와 같은 스킬을 얹을 수 있다.

**다만 이것은 코드 독해이고 실행 확인이 아니다.** 묶음 D 가 그것을 확인하며,
확인되지 않으면 그 묶음만 빠진다 — 나머지가 그것에 매이지 않게 조항을 가른다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 선언

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-OMP-1 | `agentadapter` 에 `omp` 선언을 더한다. 추가는 `registry` 한 줄 + 선언 파일이며 다른 파일의 분기를 늘리지 않는다 (`FR-ADP-1`·`2`) | 필수 |
| FR-OMP-2 | 확정 값: `ID`/`DetectCmd`/`Launch` = `omp` · `ModelFlag` = `--model` · `PromptInjection` = `argv` · `ExitCommand` = `/exit` | 필수 |
| FR-OMP-3 | `ArgvSeparator` 는 **비운다.** claude 가 `--` 를 쓰는 이유는 가변 인자 플래그(`--allowedTools`)가 프롬프트를 삼켰기 때문이다. omp 의 멤버 인자는 `--config <path>` 로 값이 하나이므로 그 함정이 없다. 없는 함정에 구분자를 두면 그 구분자가 새 함정이 된다 | 필수 |
| FR-OMP-4 | `Readiness.Hooks` = **true**. `session_start` → `idle` 이 `FR-STA-4` 1단계를 그 자리에서 성립시킨다. `ScreenPatterns` 는 비운다 (claude 와 같은 이유) | 필수 |
| FR-OMP-5 | `PolicyInjection.Flags` = `["--hook", "--plugin-dir"]`, `SessionScoped` = true. 값(경로)은 런타임이 정하므로 선언에는 **플래그 이름만** 둔다 | 필수 |
| FR-OMP-6 | `HookParse` 는 **우리 shim 의 형식**을 파싱한다 (§3.2 의 형식). 알 수 없는 `event` 는 무시하고 `(Report{}, false)` 를 낸다 — claude·codex 파서와 같은 규약 | 필수 |
| FR-OMP-7 | 매핑은 §2.3 의 표 그대로다. `Report.SessionID`·`Transcript` 는 shim 이 실어 오면 채우고, 없으면 **비운다** | 필수 |
| FR-OMP-8 | 관측되지 않는 것을 지어내지 않는다 — 승인 대기는 `waiting` 으로 오지 않는다(§2.4). 그 사실을 선언 주석에 적는다 (`FR-ADP-4` 와 같은 규약) | 필수 |

### 3.2 묶음 B — 활동 shim 과 셸 래퍼

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-OMP-10 | 설치가 훅 shim 을 `<binDir>/agent-hooks/omp-activity.mjs` 로 쓴다. claude 의 `claude.json` 과 **같은 자리·같은 수명**이다 | 필수 |
| FR-OMP-11 | shim 은 `dmctl` 을 **절대 경로**로 부른다. PATH 앞의 낡은 `dmctl` 은 `activity` 를 모른다 (claude 훅이 같은 이유로 절대 경로를 쓴다) | 필수 |
| FR-OMP-12 | shim 이 보내는 JSON 은 한 줄이며 필드는 이렇다: `event`(필수) · `tool` · `detail` · `sessionId` · `transcript` · `userPrompt`. **이 형식의 임자는 우리이고, `parseOmpHook` 과 같은 문서(이 절)를 근거로 한다** | 필수 |
| FR-OMP-13 | shim 은 **에이전트를 막지 않는다.** `dmctl` 호출은 실패해도 조용히 지나가고(비0 종료·부재 포함) 예외를 훅 바깥으로 던지지 않는다. 관측이 도구 사용을 막으면 그것은 관측이 아니다 (`NFR-AAP-5` 의 정신) | 필수 |
| FR-OMP-14 | `omp()` 셸 래퍼가 `--hook <shim>` 과 `--plugin-dir <agent-plugin>` 을 **파일·디렉터리가 있을 때만** 붙인다. 두 셸(POSIX·PowerShell) 모두에 둔다 — claude 래퍼와 같은 형태다 | 필수 |
| FR-OMP-15 | 래퍼는 사용자의 인자를 **그대로 뒤에 붙인다.** `command omp` (POSIX) · `__dongminalApp 'omp'` (PowerShell)로 자기 자신을 다시 부르지 않는다 | 필수 |
| FR-OMP-16 | 선언의 `PolicyInjection.Flags` 와 **실제 래퍼가 붙이는 플래그**가 어긋나지 않는다. 그것을 재는 대조 테스트를 둔다 (`TC-ADP-4` 와 같은 자리) | 필수 |

### 3.3 묶음 C — Run 멤버의 `dmctl` 사전 허용

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-OMP-20 | 설치가 오버레이를 `<binDir>/agent-hooks/omp-member.yml` 로 쓴다. 내용은 **`dmctl` 만** 허용하는 `bash.patterns` 한 항목이다 | 필수 |
| FR-OMP-21 | `MemberArgs` = `["--config", "<오버레이 절대경로>"]`. 경로는 런타임이 아는 값이므로 선언은 **자리(토큰)** 로 두고 기동줄을 만드는 쪽이 채운다 | 필수 |
| FR-OMP-22 | **`FR-ADP-1` 개정**: `memberArgs` 항목은 토큰 `{{dmHooks}}` 를 포함할 수 있고, 그 자리는 `agent-hooks` 디렉터리의 절대 경로로 치환된다. 치환은 기동줄을 만드는 **한 자리**에서만 한다. 치환하지 않은 토큰이 기동줄에 남으면 **오류**다 — 조용히 그대로 타이핑되면 omp 가 없는 파일을 읽고 기동이 깨진다 | 필수 |
| FR-OMP-22a | **치환 뒤 경로 표기를 OS 의 것으로 맞춘다.** `memberArgs` 는 플랫폼을 모르는 선언이라 `{{dmHooks}}/omp-member.yml` 처럼 슬래시로 적히는데 `hooksDir` 은 OS 네이티브다 — 그대로 이으면 Windows 에서 `C:\…\agent-hooks/omp-member.yml` 이라는 **혼합 구분자**가 나간다. 그것을 에이전트가 열 수 있는지는 그 구현에 달린 일이고 우리가 기댈 사실이 아니다 (2026-09-11, Windows CI 가 잡았다) | 필수 |
| FR-OMP-23 | 사전 허용은 **`dmctl` 로만 한정**한다. `tools.approvalMode` 를 낮추거나 `--auto-approve`·`--approval-mode yolo` 를 쓰지 않는다 — 멤버에게 사용자가 주지 않은 권한을 주지 않는다 (`FR-ADP-1` 주석의 기존 결정) | 필수 |

### 3.4 묶음 D — 스킬 주입 (확인 대상)

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-OMP-30 | `omp --plugin-dir <agent-plugin>` 이 우리 스킬을 얹는지 **실행으로 확인한다**(§2.6 은 코드 독해다). 확인되면 `FR-OMP-14` 의 `--plugin-dir` 이 그 근거를 갖는다 | 필수 |
| FR-OMP-31 | 확인되지 않으면 `--plugin-dir` 을 래퍼에서 **빼고** 그 사실을 선언 주석과 이 문서에 적는다. 나머지 묶음은 이 결과에 매이지 않는다 | 필수 |

### 3.5 비기능 (Non-functional)

| ID | 요구사항 |
|----|---------|
| NFR-OMP-1 | **omp 의 설치나 설정에 파일을 추가·교체하지 않는다** (2026-09-11 사용자 요구: *"omp 역시 클로드처럼 파일을 교체하거나 추가하면 안 된다. 완벽한 런타임 주입이어야 한다"*). 세 가지를 지킨다: ① omp 의 설치 트리(`node_modules/@oh-my-pi/**`)를 건드리지 않는다 ② 사용자의 `~/.omp/**` 에 **한 바이트도** 쓰지 않는다 ③ omp 의 **자동 탐색** 디렉터리(`~/.omp/agent/hooks/`)를 쓰지 않는다 — 그 자리에 두면 우리 파일이 사용자의 **모든** omp 세션에 얹히므로 그것이 곧 "추가" 다. 우리 산출물은 전부 `$DONGMINAL_HOME/bin/agent-hooks/` 아래이고, 주입은 전부 기동줄의 플래그다(`--hook`·`--plugin-dir`·멤버의 `--config`). 검증: `TestOmpInjectionIsRuntimeOnly` · `TestInstallDoesNotTouchOmpHome` · `TestPolicyInjectionNeverTouchesUserPermanentSettings`(금지 문자열에 `~/.omp`·`.omp/agent` 추가) |
| NFR-OMP-2 | claude·codex 의 기동줄·훅 파싱은 **한 글자도 바뀌지 않는다.** 기존 테스트가 그 회귀 검출기다 |
| NFR-OMP-3 | shim 이 세션당 남기는 비용은 프로세스 하나(`dmctl activity omp`)이며 이벤트마다 한 번이다. claude 훅과 같은 자리·같은 크기다 |

## 4. 설계 결정 (Design Decisions)

- **D-1. shim 형식의 임자를 우리로 둔다.** omp 훅이 in-process 모듈이므로 형식을
  고를 수 있다. claude 의 스키마를 흉내내는 대신 §3.2 의 최소 형식을 쓴다 —
  `HookParse` 가 읽는 것과 shim 이 쓰는 것이 **같은 문서 한 절**을 근거로 한다.
- **D-2. 사전 허용은 설정으로 한다.** 사용자 판정의 *수단*(permission-gate 훅)은
  omp 에 없다(§2.5). *뜻*(dmctl 만)은 `bash.patterns` 로 그대로 이룰 수 있으므로
  뜻을 지키고 수단을 바꾼다. 그 사실을 사용자에게 보고한다.
- **D-3. `MemberArgs` 에 런타임 자리를 만든다.** 대안 셋을 봤다.
  (i) 래퍼가 늘 오버레이를 얹기 — **모든** dongminal omp 세션에 사전 허용이
  퍼진다. 멤버 한정이라는 기존 결정을 넓히므로 기각.
  (ii) `PI_CONFIG_FILES` 를 멤버 탭의 환경에 심기 — 탭 환경을 새로 다루어야 하고
  기동줄만 보고는 무엇이 켜졌는지 알 수 없다. 기각.
  (iii) 토큰 치환 — 계약이 한 줄 늘고, 치환 실패가 **오류로 드러난다**. 채택.
- **D-4. `ArgvSeparator` 를 비운다.** 있는 함정에만 장치를 둔다 (`FR-OMP-3`).
- **D-5. `waiting` 을 지어내지 않는다.** 승인 대기를 화면 패턴으로 추정하는 길은
  `Readiness.ScreenPatterns` 를 비워 둔 것과 같은 이유로 기각한다 — 스테이터스
  라인 하나에 깨지는 판정은 없는 것보다 나쁘다.
- **D-6. 묶음 D 를 분리한다.** 스킬 주입은 코드 독해로만 확인됐다. 그것이 아니어도
  활동 관측과 멤버 기동은 성립해야 하므로 조항을 가른다.

## 5. 검증 (Verification)

### 5.1 Go 단위 — 선언과 파서

| ID | 재는 것 | 기대 |
|----|--------|------|
| V-OMP-1 | `IDs()` | `claude`·`codex`·`omp` 셋 |
| V-OMP-2 | `Get("omp")` 의 확정 값 (`FR-OMP-2`) | 표 그대로. `ExitCommand`=`/exit` |
| V-OMP-3 | `parseOmpHook` 전 이벤트 (`FR-OMP-7`) | §2.3 매핑 그대로 |
| V-OMP-4 | `parseOmpHook` 의 알 수 없는 `event`·깨진 JSON | `ok=false`, 상태를 지어내지 않는다 |
| V-OMP-5 | `parseOmpHook` 이 `sessionId`·`transcript` 를 실어 오지 않은 페이로드 | 두 값이 **빈 문자열**이다 (`FR-CBG-5`) |
| V-OMP-6 | `parseOmpHook` 이 claude 페이로드(`{"hook_event_name":"Stop"}`)를 받는다 | 거절한다 — 남의 형식을 받아들이면 두 형식이 섞인다 |
| V-OMP-7 | `LaunchLine` (멤버) | `--config` 뒤에 **치환된 절대 경로**가 온다. `{{dmHooks}}` 가 남아 있지 않다 |
| V-OMP-8 | 치환 자리가 없는 호출 | 토큰이 남으면 오류다 (`FR-OMP-22`) |
| V-OMP-9 | `claude`·`codex` 의 기동줄·파서 (`NFR-OMP-2`) | 기존 값과 동일 (기존 테스트 보존) |

### 5.2 Go 단위 — 설치와 래퍼

| ID | 재는 것 | 기대 |
|----|--------|------|
| V-OMP-10 | 설치 뒤 `agent-hooks/omp-activity.mjs` · `omp-member.yml` | 둘 다 있고, shim 이 `dmctl` **절대 경로**를 담는다 |
| V-OMP-11 | 두 셸의 `omp` 래퍼 (`FR-OMP-14`·`15`) | `--hook`·`--plugin-dir` 을 조건부로 붙이고 자기 자신을 다시 부르지 않는다 |
| V-OMP-12 | 선언 ↔ 래퍼 대조 (`FR-OMP-16`) | `PolicyInjection.Flags` 의 모든 플래그가 래퍼에 있다 |
| V-OMP-13 | 오버레이 내용 (`FR-OMP-20`·`23`) | `dmctl` 만 `allow`. `approvalMode` 를 만지지 않는다 |
| V-OMP-14 | 사용자 홈 (`NFR-OMP-1`) | `~/.omp` 아래에 아무것도 생기지 않는다 |

### 5.3 실행 확인 (수동 · 사용자 환경)

| ID | 재는 것 | 기대 |
|----|--------|------|
| V-OMP-20 | 도구 탭에서 `omp` 를 띄운다 | 활동 패널이 `idle` → `working` → `done` 을 따라간다 |
| V-OMP-21 | 그 세션에서 `/skills` 또는 스킬 목록 (`FR-OMP-30`) | dongminal 스킬(`team`·`workflow`)이 보인다. 아니면 `FR-OMP-31` 을 적용한다 |
| V-OMP-21a | 그 세션을 닫은 뒤 `~/.omp` 를 본다 (`NFR-OMP-1`) | **새 파일이 없다.** 우리가 얹은 것은 플래그뿐이므로, 무언가 생겼다면 그것은 omp 자신의 캐시이며 그 사실을 이 문서에 적는다 |
| V-OMP-22 | `dmctl run` 으로 omp 멤버를 띄운다 | 첫 `dmctl` 호출이 **승인 프롬프트 없이** 지나고 `run report` 가 서버에 닿는다 |

`e2e`(Playwright)는 이 작업의 자리가 아니다 — 브라우저 화면이 아니라 헬퍼·설치·
선언의 계약이다. 활동 패널의 표시는 이미 서 있는 e2e 가 덮는다.

## 6. 비목표 (Non-goals)

- omp 의 승인 게이트를 관측하는 일(§2.4). 이벤트가 없다.
- 화면 패턴으로 준비완료·대기를 추정하는 일.
- codex 를 같은 수준으로 끌어올리는 일 (`FR-ADP-4` 가 best-effort 로 둔 결정).
- omp 의 `--profile`·`--session-dir` 격리를 dongminal 이 관리하는 일.
- 모델 이름의 정규화. `--model` 은 퍼지 매칭이며 그 해석은 omp 의 것이다.

## 7. 리스크 (Risks)

| ID | 리스크 | 등급 | 완화 |
|----|--------|------|------|
| R-OMP-1 | shim 이 예외를 던져 omp 의 도구 호출을 막는다 | HIGH | `FR-OMP-13` 을 조항으로 두고, shim 의 모든 경로를 `try`/무시로 닫는다. `dmctl` 부재를 포함한 실패를 단위로 잰다 |
| R-OMP-2 | 토큰 치환이 빠진 자리가 남아 기동줄에 `{{dmHooks}}` 가 그대로 타이핑된다 | HIGH | `FR-OMP-22` 가 오류로 규정하고 `V-OMP-8` 이 잰다. 치환은 한 자리에서만 한다 |
| R-OMP-3 | omp 의 이벤트 이름·페이로드가 판 올림에서 바뀐다 | MEDIUM | shim 이 **우리 형식으로 번역**하므로 깨지는 자리가 shim 하나로 좁다. `v17.4.0` 기준임을 선언 주석에 적는다 |
| R-OMP-4 | `bash.patterns` 의 매칭 문법(`*` 만)이 `dmctl` 호출 형태를 놓친다 | MEDIUM | `V-OMP-13` 이 내용을 재고, `V-OMP-22` 가 실제 멤버로 확인한다. 놓치면 승인 프롬프트가 뜨므로 **조용히 실패하지 않는다** |
| R-OMP-5 | `--plugin-dir` 이 우리 레이아웃을 받지 않아 멤버가 스킬 없이 뜬다 | MEDIUM | 묶음 D 로 분리하고 `V-OMP-21` 로 확인한다. 실패하면 래퍼에서 빼되 나머지는 그대로 선다 |
| R-OMP-6 | 사전 허용이 멤버 밖으로 새어 모든 omp 세션에 적용된다 | MEDIUM | `MemberArgs` 경로만 오버레이를 싣는다(D-3). 래퍼는 오버레이를 **모른다** — `V-OMP-11`·`12` 가 래퍼의 플래그 목록을 고정한다 |

## 8. 기존 문서의 개정 (Traceability)

| 문서 | 개정 |
|---|---|
| `RUN_ORCHESTRATION_SRS.md` | ✅ `FR-ADP-1` — 선언 표에 `omp`, `memberArgs` 의 **런타임 자리(`{{dmHooks}}`)** 와 `LaunchLine` 시그니처 변경 |
| `RUN_ORCHESTRATION_SRS.md` | ✅ `FR-ADP-4a` 신설 — omp 의 해상도와 그 한 가지 빠짐(§2.4) |
| `SKILL_INJECTION_SRS.md` | ✅ `FR-INJ-4a` 신설 — `--plugin-dir` 을 쓰는 에이전트가 둘이다 |
| `agentplugin/skills/team/references/models.md` | ✅ `omp` 행 추가(`--model` 있음)와 **`waiting` 이 반만 온다**는 주의 (`FR-ADP-4` 의 "스킬 문서에 명시" 요구) |
| `production/M2_PROGRESS.md` | `§3.4` `U-21` 열을 이 문서로 잇는다 |

**현재 상태 (2026-09-11)**: 묶음 A·B·C 구현 완료. Go 전량 `-race -shuffle=on` 초록
(34 패키지) · `make gates` 초록. **묶음 D 와 §5.3 의 실행 확인
(`V-OMP-20`·`21`·`22`)은 사용자 환경에서만 할 수 있다** — 실제 omp 세션과 Run
멤버가 필요하다. `V-OMP-21` 이 실패하면 `FR-OMP-31` 을 적용한다.
