# SRS: 어댑터가 에이전트의 전부를 안다 — 이름을 한 자리로 모은다 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

사용자 지시(`U-27`, 2026-09-11)를 이행한다.

> *"기존 claude code 만을 가지고 동작하는 것으로 구현되었던 모든 코드를 확인하여
> agent adaptor 를 사용하도록 변경. 여기에는 orchestration 도 포함. 오늘 이후에는
> agent adaptor 에 등록하는 부분을 제외하고는 특정 에이전트의 이름이 나오면 안된다."*

`AGENT_EVENT_ABSTRACTION_SRS` 가 **이벤트**를 어댑터로 올렸다. 그때 올리지 않은
것이 셋 남았고, 그 셋이 전부 claude 의 구현 세부에 묶여 있다 — 훅 설치, 전사본
해석, 컨텍스트 창.

### 1.2 범위 (Scope)

- `internal/shared/agentadapter/` — `Adapter` 에 세 능력을 더하고 claude·omp·codex 가
  각자 채운다.
- `internal/shared/runtime/install.go`·`install_omp.go` — 설치의 분기를 순회로 바꾼다.
- `internal/helper/runtimebin/dmctl_activity.go` — 전사본 해석을 어댑터에 묻는다.
- `internal/webserver/domain/run/context_window.go`·`store_context.go` — 창 크기를
  어댑터에 묻는다.
- `internal/webserver/httpapi/handlers_runs_context.go` — 관측이 **누가 보고했는지**를
  싣는다.

비포함:

- **CLI 도움말 문자열** (`dmctl activity <agent>: claude | codex …`). 그것은 사용자에게
  **무엇을 칠 수 있는지** 알리는 자리이며, 등록된 이름을 보이는 것이 목적이다.
  다만 손으로 적은 목록은 낡으므로 `IDs()` 에서 파생시킨다 (`FR-AAC-30`).
- **사실을 서술한 주석.** *"이 훅은 Run 과 무관한 claude 전부에서 돌므로"* 같은
  문장은 그 시점의 실측이다. 지우면 근거가 사라진다 (§4 D-5).
- 새 에이전트의 추가. 이 문서는 **자리를 만드는 것**이지 채우는 것이 아니다.
- omp 전사본 형식의 규명 (§2.4).

### 1.3 정의 (Definitions)

- **능력 선언**: 어댑터가 "나는 이것을 할 수 있다/없다" 를 값으로 밝히는 일.
  `Signals` 가 이미 그 규약이며(`FR-AEV-1~3`), 이 문서는 어휘를 늘리지 않고
  같은 규약을 세 자리에 더 적용한다.
- **미지원(`nil`)**: 능력이 없다는 **선언**이다. "아직 안 만들었다" 와 구분되지
  않지만, 소비자에게는 같은 뜻이다 — 묻지 않는다.

### 1.4 참조 (References)

- `docs/internal/AGENT_EVENT_ABSTRACTION_SRS.md` — `FR-AEV-1~3`(이벤트 선언) ·
  `FR-AEV-10·12`(보고자를 밝히면 판정이 옳아진다) · `§2.5` 능력 실측표.
- `docs/internal/UX_BATCH6_SRS.md` — `FR-CTX-1·4·5·6·7`(실측 토큰, 창, 넓히기).
- `docs/internal/OMP_AGENT_SUPPORT_SRS.md` — `FR-OMP-7·12`(shim 형식의 임자는 우리다).
- `docs/internal/HOST_PARITY_SRS.md` — `FR-HPR-4·5`(훅 명령 한 줄의 인용 규약).

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 이름이 실제로 박힌 자리는 좁다

`grep -i claude` 는 57곳이지만 **실행 코드는 둘**이다 (나머지는 등록부·주석·도움말).

```go
// runtime/install.go:419
activityHook := map[string]any{"type":"command","command":hookCommand(dmctl,"activity","claude")}
// runtime/install.go:452
return os.WriteFile(filepath.Join(dir,"claude.json"), blob, 0o644)
```

그러나 **이름이 없어도 claude 전용인 코드**가 더 넓다 (§2.2~2.4). 지시의 표현은
"이름이 나오면 안 된다" 이지만 뜻은 *"claude 만을 가지고 동작하는 것으로 구현된
모든 코드"* 이므로, 이름 없는 가정도 범위다.

### 2.2 설치가 에이전트마다 다른 함수에 있다

| 함수 | 무엇을 놓는가 | 누구의 것인가 |
|---|---|---|
| `installAgentHooks` | 훅 9개(`SessionStart`…`Notification`) → `claude.json` | claude |
| `installOmpAssets` | 활동 shim(`.mjs`) + 멤버 오버레이 | omp |
| `installAgentPluginHooks` | 플러그인의 `SessionStart` 훅 | claude |
| — | (없음) | codex — 기동줄(`-c notify=…`)만 쓴다 |

`Install()` 이 이 셋을 **이름으로 차례로 부른다.** 네 번째 에이전트가 오면 그
자리에 줄이 하나 더 는다.

### 2.3 전사본 해석이 claude 의 JSONL 형식이다

`parseUsageLine`(`dmctl_activity.go:171`)이 읽는 것은 이 모양이다.

```json
{"message":{"model":"…","usage":{"input_tokens":N,"cache_creation_input_tokens":N,"cache_read_input_tokens":N}}}
```

`message.usage` 의 세 값을 더해 입력 컨텍스트를 낸다. 이것은 Anthropic API 의
응답 형식이며, 다른 에이전트가 같은 모양을 쓸 이유가 없다.

**지금도 오답을 내지는 않는다** — 형식이 다르면 `"usage"` 문자열이 없거나
unmarshal 이 실패해 "모름" 으로 떨어진다. 그러나 **어느 에이전트의 것을 읽고
있는지 코드가 묻지 않는다.**

### 2.4 창 크기가 claude 의 모델 표기 규칙이다

`WindowForModel`(`context_window.go:34`)은 모델 이름의 `[1m]` 접미어로 1M 을
가르고, 아니면 200k 다. 주석이 그 근거를 적어 두었다 — *"Claude Code 가 긴
컨텍스트 판을 기록할 때 모델 이름에 붙이는 표식"*.

에이전트별 실측은 이렇다.

| | 전사본 경로 | 전사본 줄 형식 | 모델 이름 | 창 크기 |
|---|---|---|---|---|
| claude | ✅ `transcript_path` | ✅ 확인됨 (§2.3) | ✅ | ✅ `[1m]` |
| omp | ✅ shim 의 `transcript`(`.jsonl`) | ❌ **확인된 바 없다** | ❌ | ❌ |
| codex | ❌ 오지 않는다 | — | — | — |

`OMP_AGENT_SUPPORT_SRS §2.3` 은 omp 의 세션 파일이 `.jsonl` 이라고만 적는다.
**줄의 구조가 claude 와 같다는 근거는 어디에도 없다.** 그러므로 이 문서는 omp 에
claude 의 해석을 붙이지 않는다 (D-4).

### 2.5 "모름" 을 다루는 길이 이미 있다

`FR-CTX-5·6·7` 이 순서를 정해 두었다: ① 모델이 말하면 그것이 이긴다 ② 모르면
정책의 값에서 출발한다 ③ 관측이 창을 넘으면 넓힌다.

그래서 창 크기를 **모르는 에이전트가 생겨도 새 동작을 만들 필요가 없다.** ②③이
그대로 받는다. 주석이 그 설계를 이미 적고 있다 — *"모르는 이름을 기본값으로
단정하지 않는다. 단정하면 그 뒤의 넓히기가 '설정이 틀렸다' 와 '표에 없다' 를
구분하지 못한다."*

### 2.6 관측은 누가 보고했는지 말하지 않는다

`POST /api/runs/context` 의 본문에는 `toolId`·`bytes`·`sessionId`·`compacted`·
`tokens`·`model` 만 있다. **`agent` 가 없다.**

멤버의 관측은 `Member.Agent` 로 되짚을 수 있으나, **조정자의 관측은 멤버가 아니라
되짚을 자리가 없다**(`observeCoordinator`). 지금은 창 판정이 전역 함수라 그 구분이
필요 없었지만, 어댑터에 물으려면 보고자를 알아야 한다.

알람 종단은 이미 같은 문제를 같은 방법으로 풀었다 — `FR-AEV-10` 이 `agent` 를
싣고, *"비어 있으면 종전 판정 그대로 간다 — 알 수 없는 보고자에게 알람을 지어내지
않는다"*.

## 3. 요구사항 (Requirements)

### 3.1 묶음 I — 설치

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-AAC-1 | `Adapter.InstallAssets func(InstallSpec) error` 를 둔다. 이 에이전트가 붙기 위해 디스크에 놓아야 할 것을 그 함수가 쓴다. `nil` 은 "놓을 것이 없다" 는 선언이다 (codex) | 필수 |
| FR-AAC-2 | `InstallSpec` 은 **자리**만 담는다 — `Dir`(자산 디렉터리) · `Dmctl`(절대경로). 경로 규칙은 `runtime` 이 알고 어댑터는 "무엇을 놓을지" 만 안다. 그래야 의존이 `runtime → agentadapter` 한 방향으로 남는다 | 필수 |
| FR-AAC-3 | 훅 명령 한 줄을 만드는 규약(`HOST_PARITY_SRS FR-HPR-4·5`)은 `InstallSpec.HookCommand` 하나가 갖는다. 어댑터가 `dmctl` 경로를 직접 이어 붙이지 않는다 — 인용 규칙이 여러 벌이 되면 한쪽만 고쳐진다 | 필수 |
| FR-AAC-4 | `runtime` 은 **등록된 어댑터를 순회**한다. 이름으로 함수를 부르는 자리가 남지 않는다 | 필수 |
| FR-AAC-5 | 실패는 **어느 에이전트인지 밝힌다** (`install <id> assets: …`). 순회가 되면서 실패의 출처가 흐려지면 안 된다 | 필수 |
| FR-AAC-6 | 플러그인(`AgentPluginDir`)의 `SessionStart` 훅도 같은 자리를 지난다. 그것은 claude 의 플러그인 규약이므로 claude 어댑터의 것이다 | 필수 |

### 3.2 묶음 T — 전사본

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-AAC-10 | `Adapter.ParseUsage func(line string) (Usage, bool)` 를 둔다. 전사본 **한 줄**에서 사용량을 뽑는다. `nil` 은 "전사본을 읽지 않는다" 는 선언이다 | 필수 |
| FR-AAC-11 | 줄을 고르고·자르고·뒤에서부터 훑는 **읽기 전략은 어댑터 밖에 남는다.** 그것은 파일 다루기이지 형식이 아니다 (`usageTailMax`·꼬리 읽기·잘린 첫 줄 버리기) | 필수 |
| FR-AAC-12 | `Usage` 는 **숫자와 모델 이름뿐**이다. 내용을 실어 나를 통로를 만들지 않는다 — `NFR-4` 의 첫 방벽이 반환 타입이라는 기존 규약을 그대로 잇는다 | 필수 |
| FR-AAC-13 | `ParseUsage` 가 `nil` 인 에이전트의 전사본은 **열지 않는다.** 지금은 열어서 읽고 실패했다 — 읽지 않는 것이 더 싸고, 더 정직하다 | 필수 |
| FR-AAC-14 | omp 에 claude 의 해석을 붙이지 않는다. 세션 파일이 `.jsonl` 이라는 것만으로는 줄의 구조를 알 수 없다 (§2.4, D-4) | 필수 |

### 3.3 묶음 W — 컨텍스트 창

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-AAC-20 | `Adapter.ContextWindow func(model string) (float64, bool)` 를 둔다. `nil` 은 "창 크기를 말하지 않는다" 는 선언이다 | 필수 |
| FR-AAC-21 | 모델 이름의 해석은 **claude 어댑터로 옮긴다.** `domain/run` 은 그 규칙을 모른다. 옮기는 김에 규칙 자체가 바뀌었다 — `[1m]` 접미어는 폐기되고 **기본이 1M** 이며 다른 크기인 판만 표에 적는다 (`FR-CTX-5b`, 사용자 결정) | 필수 |
| FR-AAC-22 | 아는 창 크기의 **목록**(넓히기가 딛는 오름차순)은 `domain/run` 에 남는다. 그것은 어느 에이전트의 것도 아니라 이 제품이 아는 단계이며, `WidenWindow` 가 그 위에 선다 | 필수 |
| FR-AAC-23 | `POST /api/runs/context` 가 `agent` 를 받는다. 빈 값이면 **창을 모르는 것으로 둔다** — 등록되지 않은 에이전트, `ContextWindow` 가 `nil` 인 어댑터와 **같은 답**이며, 그때는 정책 기본값과 넓히기가 받는다 (`FR-CTX-6·7`). `dmctl` 이 언제나 `agent` 를 싣고 그 dmctl 은 이 저장소가 설치하므로, 빈 값은 실무상 옛 클라이언트뿐이다 | 필수 |
| FR-AAC-24 | 창을 모르는 에이전트에서 **동작이 바뀌지 않는다.** `FR-CTX-5·6·7` 의 ②③ 이 그대로 받는다 (§2.5) | 필수 |

### 3.4 묶음 N — 이름

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-AAC-30 | CLI 도움말의 에이전트 목록은 `IDs()` 에서 **파생**한다. 손으로 적은 목록은 등록이 늘 때 낡는다 | 필수 |
| FR-AAC-31 | 이 변경 뒤 `agentadapter/` 밖의 **실행 코드**에 에이전트 이름 리터럴이 없다. 주석과 `IDs()` 파생 문자열은 예외다 (§1.2) | 필수 |
| FR-AAC-32 | 그 사실을 **게이트가 지킨다.** 사람이 기억하는 규약은 반드시 낡는다 — 이 저장소의 이음매 검사들과 같은 근거다 | 필수 |

### 3.5 비기능 (Non-functional)

| ID | 요구사항 |
|----|---------|
| NFR-AAC-1 | 의존은 한 방향이다: `runtime`·`runtimebin`·`domain/run` → `agentadapter`. 어댑터는 그 셋을 모른다 |
| NFR-AAC-2 | 훅은 에이전트의 핫패스다. 전사본 읽기의 비용이 늘지 않는다 — `ParseUsage` 가 `nil` 이면 **파일을 열지도 않는다** (FR-AAC-13) |
| NFR-AAC-3 | 기존 동작은 claude 에서 **한 톨도 바뀌지 않는다.** 이 작업은 자리를 옮기는 것이지 규칙을 고치는 것이 아니다.<br><br>**예외 하나** — 컨텍스트 창의 판정 규칙은 옮기는 도중 사용자 결정으로 바뀌었다 (`FR-CTX-5b`: 접미어 폐기·기본 1M). 그것은 이 문서의 목적이 아니라 **그 자리를 열어 보니 드러난 결함**이며, 기존 검증을 개정해 그 변화를 명시적으로 고정했다 |

## 4. 설계 결정 (Design Decisions)

- **D-1. 인터페이스가 아니라 함수 필드다.** `Adapter` 는 이미 값의 집합이고
  `HookParse`·`Signals` 가 그 규약이다. Go 에 상속이 없으므로 "상속받아 구현하듯" 은
  **각 어댑터 파일이 자기 함수를 채우는 것**으로 성립한다. 인터페이스를 새로 세우면
  등록부가 두 벌(값 + 타입)이 된다.
- **D-2. `nil` 이 곧 선언이다.** `Signals{Done:true}` 가 "codex 는 done 만 낸다" 를
  말하듯, `ParseUsage:nil` 은 "전사본을 읽지 않는다" 를 말한다. 빈 함수를 채워 넣는
  것보다 `nil` 이 정직하다 — 빈 함수는 "했는데 결과가 없다" 로 읽힌다.
- **D-3. 읽기 전략과 형식을 가른다.** 꼬리 `usageTailMax` 만 읽기·잘린 첫 줄
  버리기·뒤에서부터 훑기는 **파일을 다루는 법**이고 어느 에이전트에게나 같다.
  어댑터가 아는 것은 **한 줄의 뜻**뿐이다 (FR-AAC-11).
- **D-4. 모르는 것을 아는 척하지 않는다.** omp 의 세션 파일이 `.jsonl` 이라는 사실만
  가지고 claude 의 파서를 붙이면, 그것이 우연히 동작하는 날과 조용히 오답을 내는
  날을 우리가 구분할 수 없다. `nil` 로 두고 §2.5 의 폴백에 맡긴다. 형식이 확인되면
  **그 어댑터 파일에 함수 하나가 는다** — 그것이 이 추상화의 이득이다.
- **D-5. 주석의 이름은 지우지 않는다.** *"이 훅은 Run 과 무관한 claude 전부에서
  돈다"* 는 그 시점의 실측이고 판정의 근거다. 이름을 지우면 문장이 거짓이 되거나
  뜻을 잃는다. 지시의 대상은 **동작하는 코드**다.
- **D-6. 게이트로 못 박는다.** `FR-AAC-31` 은 사람이 지킬 수 없다 — 새 코드를 쓰는
  사람이 이 문서를 읽었는지에 기대게 된다. `scripts/check-*.sh` 의 선례대로 검사를
  둔다 (FR-AAC-32).

## 5. 검증 (Verification)

| ID | 시나리오 | 기대 |
|----|---------|------|
| V-AAC-1 | `Install()` 을 돌린다 | claude 의 훅 파일과 omp 의 shim·오버레이가 **종전과 같은 자리에 같은 내용**으로 놓인다 (NFR-AAC-3) |
| V-AAC-2 | `InstallAssets` 가 `nil` 인 어댑터(codex) | 건너뛴다. 오류가 아니다 |
| V-AAC-3 | 한 어댑터의 설치가 실패한다 | 오류 메시지가 **그 에이전트의 id** 를 담는다 (FR-AAC-5) |
| V-AAC-4 | 어댑터를 하나 더 등록하고 `Install()` | `runtime` 을 고치지 않고 그 자산이 놓인다 — 순회임을 잰다 (FR-AAC-4) |
| V-AAC-10 | claude 전사본 줄로 `ParseUsage` | 세 값의 합과 모델 이름. 종전 `parseUsageLine` 과 **같은 답** |
| V-AAC-11 | `usage` 가 없는 줄 · 깨진 JSON · 합이 0 | 거짓. 종전과 같다 |
| V-AAC-12 | `ParseUsage` 가 `nil` 인 에이전트로 활동 보고 | 전사본을 **열지 않는다** (FR-AAC-13). 파일 접근을 스파이로 센다 |
| V-AAC-13 | 꼬리 자르기·잘린 첫 줄 버리기 | 어댑터를 바꿔도 그대로 — 전략이 밖에 있음을 잰다 (FR-AAC-11) |
| V-AAC-20 | `agent=claude`, 예외 표에 오른 판 | 그 값이 기본을 이긴다 (`claude_window_test.go`) |
| V-AAC-21 | `agent=claude`, 모델을 모르거나 표에 없음 | **1M**(기본). 접미어는 근거가 아니다 (`FR-CTX-5b`) |
| V-AAC-22 | `agent` 가 빈 값 | **종전 판정 그대로** (FR-AAC-23) — 옛 클라이언트가 조용히 망가지지 않는다 |
| V-AAC-23 | `ContextWindow` 가 `nil` 인 에이전트 | 창을 말하지 않는다. 정책 기본값에서 출발해 관측으로 넓혀진다 (FR-AAC-24) |
| V-AAC-24 | 조정자(멤버 아님)의 관측 | 멤버와 **같은 판정**을 받는다 (§2.6) |
| V-AAC-30 | `dmctl activity` 도움말 | 등록된 id 전부가 나온다. 어댑터를 더하면 도움말도 따라 는다 (FR-AAC-30) |
| V-AAC-31 | `agentadapter/` 밖의 실행 코드 | 에이전트 이름 리터럴이 없다 — 게이트가 잰다 (FR-AAC-31·32) |

## 6. 비목표 (Non-goals)

- omp 전사본 형식의 규명. 근거가 생기면 그 어댑터에 함수 하나를 더한다.
- 새 에이전트 추가.
- `Adapter` 의 기존 필드 재배치.
- CLI 도움말의 문안 개선 (파생으로 바꾸는 것만 한다).
- 컨텍스트 창 목록(200k·1M)의 값 변경.

## 7. 리스크 (Risks)

| ID | 리스크 | 등급 | 완화 |
|----|--------|------|------|
| R-AAC-1 | 설치를 순회로 바꾸다 **놓이던 것이 안 놓인다** — 조용히 훅이 죽고, 그러면 알람과 활동이 통째로 멎는다 | **HIGH** | `V-AAC-1` 이 파일의 자리와 내용을 종전과 대조한다. 기존 설치 테스트를 그대로 통과시킨다 |
| R-AAC-2 | 조정자 경로가 `agent` 를 싣지 못해 창 판정이 바뀐다 | **HIGH** | `V-AAC-22`(빈 값 = 종전) · `V-AAC-24`(조정자 = 멤버와 같음). 빈 값의 폴백을 먼저 세운다 |
| R-AAC-3 | 전사본 읽기를 옮기다 꼬리 자르기가 어긋나 **오답**을 낸다 | MEDIUM | 전략을 옮기지 않는다 (FR-AAC-11). `V-AAC-13` 이 그 경계를 잰다 |
| R-AAC-4 | 게이트가 오탐을 내 정당한 주석·도움말을 막는다 | MEDIUM | 검사 대상을 **실행 코드의 문자열 리터럴**로 좁히고, 주석과 `IDs()` 파생은 지나게 한다 (FR-AAC-31) |
| R-AAC-5 | `agentadapter` 가 `runtime` 을 필요로 해 순환이 생긴다 | MEDIUM | `InstallSpec` 이 값만 담는다 (FR-AAC-2). 지금 `agentadapter` 는 `platform` 만 import 하며 그것을 유지한다 (NFR-AAC-1) |
