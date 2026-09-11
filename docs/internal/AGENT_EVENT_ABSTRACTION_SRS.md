# SRS: 에이전트 이벤트를 선언으로 추상화하고 알람을 그 위에 세운다 — IEEE 29148

> **문서 상태**: 승인·구현완료

| | |
|---|---|
| 접수 | 사용자 (2026-09-11): *"omp 는 agents 에서 상태 바뀌는건 확인했는데 알람이 연결 안됐어. 해당 agents 상태 부분 추상화해서 어떤 에이전트 붙이든 똑같이 동작하도록 해. agent 자체를 추상화해서해."* |
| 방향 결정 | 사용자 (2026-09-11): *"에이전트 별로 구현부는 다르게 하지만 이벤트들을 agent 인터페이스로 추상화해서 구현하면 되잖아. 없는 이벤트는 미구현하거나 그냥 빈 구현으로 두고"* · *"모든 이벤트를 미리 선언해서 문제없도록 하자."* |
| 성격 | **요구사항 개정을 동반한다.** `ATTENTION_FIRING_SRS` 의 배선 전제를 바꾼다 |

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`omp` 는 활동(상태)을 보고하는데 **알람이 울리지 않는다.** 원인은 omp 의 결함이
아니라 **배선이 에이전트마다 손으로 쓰여 있다는 것**이다 (§2.1).

고칠 것은 omp 한 자리가 아니라 그 구조다. 에이전트가 낼 수 있는 **이벤트를 선언**
으로 만들고, 알람을 그 선언 위에 세운다. 그러면 새 에이전트를 붙일 때 빠진 것이
선언에서 드러나고, 배선을 다시 쓰지 않아도 알람이 같게 동작한다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 이름 |
|---|---|
| **묶음 E** | 이벤트 선언 (Events) — `Adapter.Signals` |
| **묶음 A** | 알람을 활동 이벤트에서 파생 (Alarm) |
| **묶음 W** | 손배선 제거 (Wiring) |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 말 | 뜻 |
|---|---|
| **이벤트** | 에이전트가 자기 훅으로 알려 오는 사건 |
| **공통 어휘** | 이 저장소가 쓰는 활동 상태 — `idle`·`working`·`waiting`·`done`·`ended` 와 곁들이 값(`UserPrompt`·`Compacted`·`Tool`/`Detail`·`SessionID`/`Transcript`) |
| **선언** | `Adapter` 의 값. 그 에이전트가 **실제로 낼 수 있는 것**을 밝힌다 |
| **활동** | 에이전트가 지금 무엇을 하는가. 활동 패널이 그린다 |
| **알람** | 도구가 사용자를 부르는 것. `Tool.attention` / `AttnTracker.attention` |

### 1.4 참조 (References)

- [`./ATTENTION_FIRING_SRS.md`](./ATTENTION_FIRING_SRS.md) — `FR-ATN-1`~`16`.
  알람의 발화 규칙. **판정은 한 글자도 바뀌지 않는다.** `FR-ATN-8`·`12` 의
  **전제**만 개정한다 (§3.4)
- [`./OMP_AGENT_SUPPORT_SRS.md`](./OMP_AGENT_SUPPORT_SRS.md) — `FR-OMP-8`(관측되지
  않는 것을 지어내지 않는다) · §2.4(omp 에 승인 대기 이벤트가 없다는 실측)
- [`./RUN_ORCHESTRATION_SRS.md`](./RUN_ORCHESTRATION_SRS.md) 묶음 A — `FR-ADP-1`~`6`.
  선언 테이블의 계약. 이 문서가 `Adapter` 에 필드를 더한다
- [`./ORCHESTRATION_V2_SRS.md`](./ORCHESTRATION_V2_SRS.md) — `FR-CBG-5`
  **"모른다 ≠ 괜찮다"**. 이 문서의 중심 근거다

---

## 2. 현재 상태 (조사로 확정한 사실, 2026-09-11)

### 2.1 배선이 에이전트마다 다르고, 셋 다 손으로 쓰여 있다

| 에이전트 | 활동(상태) | 알람 |
|---|---|---|
| claude | `hooks.json` 의 9개 훅 → `dmctl activity claude` | **같은 파일**의 `Stop`·`Notification` 에 **따로** `dmctl notify done`/`waiting` (`install.go:435-436`) |
| codex | `dmctl notify codex` **안에서** `reportCodexActivity` 가 역방향으로 파생 (`dmctl_activity.go:221`) | `dmctl notify codex` |
| omp | shim → `dmctl activity omp` (`install_omp.go`) | **없다** |

**omp 의 알람이 울리지 않는 이유가 이것이다.** shim 은 `dmctl activity omp` 만
부르고 `dmctl notify` 를 한 번도 보내지 않는다.

### 2.2 판정부는 이미 에이전트 중립이다

`AgentTurn`(`toolhub/agentturn.go`)은 에이전트를 모른다. `userTurn`·`inProgress`·
`waitingSignaled` 세 표시와 `AllowSignal` 하나가 전부이며, 직접 모드와 데몬 모드가
그 한 벌을 공유한다 (`FR-ATN-14`).

**즉 추상화가 없는 자리는 판정부가 아니라 "누가 알람을 부르는가" 하나뿐이다.**

### 2.3 claude 의 `notify` 배선은 **순수 중복**이다

claude 의 `HookParse` 는 이미 알람에 필요한 것을 전부 낸다 (`claude.go:70-84`):

- `UserPromptSubmit` → `working` + `UserPrompt=true`
- `Notification` → `waiting`
- `Stop` → `done`

그러므로 `Stop`·`Notification` 에 걸린 `dmctl notify` 는 활동 보고가 이미 말한
것을 **한 번 더** 말한다.

### 2.4 알람 규칙은 **턴 출처 이벤트가 없는 에이전트를 침묵시킨다**

`FR-ATN-4`: `done` 은 사용자 턴 표시가 서 있을 때만 알람이다. 그 표시를 세우는
것은 `UserPrompt` 곁들이 값뿐이다 (`FR-ATN-3`).

codex 에는 그 이벤트가 **없다** — codex 의 표준 notify 는 `agent-turn-complete`
하나뿐이다 (`codex.go`). 그래서 codex 가 `done` 을 활동으로 보고하면 **영원히
울리지 않는다.** 지금 codex 가 울리는 것은 규칙을 **우회**하기 때문이다:
라벨이 `done` 이 아니라 `codex` 라서 `FR-ATN-12`(그 밖의 라벨은 무조건 알람)에
걸린다.

> **이것이 이 문서가 "모든 이벤트를 미리 선언" 해야 하는 이유다.** "턴 출처를
> 모른다" 와 "사용자 턴이 아니었다" 는 다르다 (`FR-CBG-5`). 선언이 없으면 둘이
> 구별되지 않고, 규칙은 **모르는 것을 아니라고 읽는다.**

### 2.5 이벤트 능력의 실측

| 신호 | claude | omp | codex |
|---|---|---|---|
| `idle` (세션 시작) | ✅ `SessionStart` | ✅ `session_start` | ❌ |
| `working` | ✅ 다섯 훅 | ✅ `turn_*`·`tool_*` | ❌ |
| `waiting` | ✅ `Notification` | ❌ **승인 게이트가 훅에 통지되지 않는다** (OMP SRS §2.4) | ❌ |
| `done` | ✅ `Stop` | ✅ `agent_end` | ✅ `agent-turn-complete` |
| `ended` | ✅ `SessionEnd` | ✅ `session_shutdown` | ❌ |
| 사용자 턴 | ✅ `UserPromptSubmit` | ✅ `agent_start` | ❌ |
| 압축 | ✅ `PreCompact` | ✅ `auto_compaction_start`·`session_compact` | ❌ |
| tool/detail | ✅ | ✅ | ❌ |
| **알람의 내용** (`done`·`waiting` 의 `Detail`) | ❌ → ✅ `Notification.message` | ❌ → ✅ shim 의 `detail` | ❌ → ✅ `last-assistant-message` |
| 세션 신원 | ✅ | ✅ `sessionManager` | ❌ |

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 E — 이벤트 선언

**FR-AEV-1** 에이전트의 이벤트는 `Adapter.HookParse` 가 **공통 어휘**(`Report`)로
옮긴다. 구현부는 에이전트마다 다르고, 소비자는 그 어휘만 본다. 이것은 이미
성립하는 사실이며 이 문서가 **계약으로 확정**한다.

**FR-AEV-2** `Adapter` 에 `Signals` 를 더한다. 그 에이전트가 **실제로 낼 수 있는
신호 전부**를 선언한다. 낼 수 없는 것은 `false` 이며, 그것이 곧 "빈 구현" 이다.

**FR-AEV-3** 선언 항목은 §2.5 의 아홉이다: `Idle`·`Working`·`Waiting`·`Done`·
`Ended`·`UserTurn`·`Compaction`·`ToolDetail`·`Session`.

> **모든 이벤트를 미리 선언하는 이유** (사용자 결정): 알람에 쓰이는 셋만 적으면
> 다음에 다른 층이 이벤트를 소비할 때 같은 일을 또 겪는다. 선언은 **그 에이전트가
> 무엇을 말할 수 있는가**의 전부여야 한다.

**FR-AEV-4** **선언과 구현이 어긋나지 않는다.** 대조 테스트가 그 에이전트의 알려진
네이티브 이벤트를 전부 `HookParse` 에 넣고, 나온 것과 선언을 견준다. 선언했는데
나오지 않거나, 나왔는데 선언되지 않았으면 **실패**다 (`FR-OMP-16` 과 같은 규약).

**FR-AEV-5** `Readiness.Hooks` 와 `Signals.Idle` 은 **같은 사실**이다 — 세션 시작
이벤트가 있으면 준비완료를 훅으로 안다. 둘이 어긋나면 대조 테스트가 실패한다.
한 사실을 두 이름으로 두면 한쪽만 고쳐지는 날이 온다.

### 3.2 묶음 A — 알람을 활동 이벤트에서 파생한다

**FR-AEV-10** 활동 보고가 `done` 또는 `waiting` 이면 **그 자리에서** 알람 판정을
지난다. 별도의 `dmctl notify` 배선을 요구하지 않는다. 활동을 보고할 수 있는
에이전트는 **누구나** 알람을 얻는다.

**FR-AEV-11** 판정은 `AgentTurn.AllowSignal` 그대로다. `FR-ATN-4`·`6`·`15` 의
규칙과 소비 의미론(`CompareAndSwap`)은 **한 글자도 바뀌지 않는다.** 이 문서가
바꾸는 것은 그 판정을 **부르는 자리**뿐이다.

**FR-AEV-12** `Signals.UserTurn` 이 **거짓**인 에이전트의 `done` 은 **무조건**
알람이다. 턴 출처를 **모르는 것**과 "사용자 턴이 아니었다" 는 다르다
(`FR-CBG-5`) — 모르는 것을 아니라고 읽으면 그 에이전트는 영원히 침묵한다(§2.4).

**FR-AEV-13** 같은 사건이 두 경로로 와도 **알람은 한 번**이다. claude 가
`notify` 와 `activity` 를 모두 보내는 동안에도 그렇다 — `AllowSignal` 의 표시는
**소비되므로**(`FR-ATN-1`·`15`) 뒤에 온 쪽은 조용하다. 순서는 상관없다.

**FR-AEV-14** 직접 모드(`toolhub.Tool`)와 데몬 모드(`hub.AttnTracker`)에서 **같게**
동작한다 (`FR-ATN-14`·`NFR-4`).

**FR-AEV-15** **알람에도 내용이 실린다** (사용자 보고 `U-25`, 2026-09-11).

접수한 말은 *"codex, omp 에서도 알람 내용을 전달해야 한다. 그게 인터페이스의
기본이다"* 이고, 조사해 보니 **세 어댑터 전부가 비어 있었다** — claude 도 마찬가지다.
`Report.Detail` 은 `working` 에서만 채워졌고, **알람이 되는 두 상태**(`done`·
`waiting`)에서는 셋 다 빈 값을 보냈다. 그래서 데스크톱 알림의 본문에는 자리(창 ·
탭)만 실렸다 — 어느 도구인지는 알려 주고 **무슨 일인지는 말하지 않았다.**

인터페이스가 자리를 안 준 것이 아니라 **모든 구현이 그 자리를 안 채운 것**이므로,
고치는 자리는 어댑터 셋이다.

| 어댑터 | 싣는 값 |
|---|---|
| claude | `Notification` 의 `message` — 권한 요청이면 무엇을 요청하는지가 여기 있다. `Stop` 은 페이로드에 내용이 없다(전사본을 읽는 것은 비목표) |
| codex | `agent-turn-complete` 의 `last-assistant-message` — codex 가 내는 유일한 이벤트이자 그 페이로드의 유일한 내용이다 |
| omp | shim 의 `detail` — **이미 파싱해 두고 버리던 값**이다 |

없는 필드는 빈 값이 되므로 이 변경은 종전 동작을 깨지 않는다 — 싣는 에이전트는
싣고, 없는 에이전트는 지금과 같다.

**FR-AEV-15a** 값은 **알람 페이로드에 다시 싣지 않는다.** 화면은 활동 상태에서
읽는다 — 서버가 한 요청 안에서 `SetActivity` 를 먼저 부르고 `SignalAgentEvent` 를
나중에 부르므로(`handlers_attention.go`), 알람이 닿는 시점의 활동은 **그 알람을 낳은
바로 그 보고**다. 전송 표면을 늘리지 않는 쪽을 고른다 (D-1 과 같은 근거).

### 3.3 묶음 W — 손배선 제거

**FR-AEV-20** claude 의 `hooks.json` 에서 `notify` 배선을 **뺀다.** `Stop`·
`Notification` 은 활동 훅만 남는다 (§2.3 — 중복이었다).

  - 이전 동작: `Stop` → `dmctl notify done` + `dmctl activity claude`
  - 새  동작: `Stop` → `dmctl activity claude`
  - 이유: 같은 사실을 두 번 말한다. 두 명령의 도착 순서가 보장되지 않는 것이
    `FR-ATN-8` 이 경합을 피해 규칙을 비튼 이유였는데, 명령이 하나가 되면 그
    경합 자체가 사라진다

**FR-AEV-21** codex 의 기동줄(`-c notify=[...]`)은 **이번에 바꾸지 않는다**
(§6 비목표 2). codex 의 알람은 종전대로 `dmctl notify codex` 가 낸다.

**그리고 `reportCodexActivity` 의 활동 보고는 `agent` id 를 싣지 않는다.**

> 초안은 여기서 틀렸다 — *"`FR-AEV-12` 로 알람이 되지만 `FR-AEV-13` 이 흡수하므로
> 두 번 울지 않는다"* 고 적었는데, **소비 의미론은 `FR-AEV-12` 의 갈래에 적용되지
> 않는다.** `UserTurn=false` 의 `done` 은 판정 없이 무조건 울리므로 소비할 표시가
> 없고, `notify codex` 의 알람과 겹쳐 **같은 턴이 두 번 운다.**
>
> 그래서 id 를 싣지 않는다. 빈 `agent` 는 종전 판정으로 가고(`FR-AEV-12` 의
> 보수적 기본), 알람은 `notify` 한 경로에서만 나온다. codex 가 이 문서의 통합
> 경로로 옮겨 오는 날 그 한 줄을 더한다.

이 오류가 남긴 교훈을 적어 둔다: **예외 갈래를 더하면 그 갈래에는 본 규칙의
보호가 걸리지 않는다.** 중복 제거를 소비 의미론에 기대고 있었는데, 예외가 바로
그 의미론을 건너뛴다.

### 3.4 함께 개정하는 요구사항

**FR-AEV-30** `ATTENTION_FIRING_SRS` `FR-ATN-8` 의 **근거를 개정한다.**

  - 이전: *"한 훅에 걸린 여러 명령은 순서가 보장되지 않으므로(`Notification` 에는
    `notify` 와 `activity` 가 함께 걸려 있다), 판정의 재료가 판정 대상과 같은
    훅에서 오면 경합이 판정을 뒤집는다"*
  - 새: 그 경합은 `FR-AEV-20` 으로 **사라졌다**. `waiting`·`idle` 이 진행 표시를
    건드리지 않는 **규칙 자체는 그대로 남는다** — `waiting` 이 `inProgress` 를
    세우면 "턴이 진행 중일 때만" 이라는 `FR-ATN-6` 의 판정이 자기 자신을
    참으로 만든다. 근거가 경합에서 **순환 방지**로 바뀐다

**FR-AEV-31** `FR-ATN-12`("`done`·`waiting` 이 **아닌** 라벨은 무조건 알람")는
**그대로다.** 사람이 직접 부르는 `dmctl notify`·OSC 감지의 규약이며 이 문서가
건드리지 않는다.

### 3.5 비기능

| ID | 요구사항 |
|---|---|
| NFR-AEV-1 | 활동 보고 하나가 알람 판정을 함께 지나므로 **왕복이 늘지 않는다.** 오히려 claude 는 훅마다 프로세스 하나가 줄어든다 |
| NFR-AEV-2 | 활동 상태 어휘는 한 글자도 바뀌지 않는다. 활동 패널의 동작이 이 변경으로 달라지면 안 된다 (`FR-ATN-2` 의 선례) |
| NFR-AEV-3 | 알람 판정이 실패해도 **활동 보고는 그대로 간다.** 사람이 보는 패널이 먼저 죽으면 안 된다 (`NFR-CBG-2` 의 정신) |

---

## 4. 설계 결정 (Design Decisions)

- **D-1. 파생의 자리는 서버다.** `dmctl` 이 알람을 한 번 더 POST 하게 하면 왕복이
  늘고, 두 요청의 순서가 다시 문제가 된다. 서버의 활동 수신부에서 파생하면 한
  요청 안에서 순서가 확정되고, 직접·데몬 두 모드가 같은 자리를 지난다
  (`FR-AEV-14`).
- **D-2. `Signals` 는 `bool` 아홉이다.** 이벤트 **이름**을 선언에 담지 않는다 —
  이름은 에이전트마다 다르고 그것을 아는 것은 `HookParse` 의 일이다. 선언이
  말하는 것은 **"이 에이전트가 그 신호를 낼 수 있는가"** 하나다.
- **D-3. codex 를 이번에 옮기지 않는다.** codex 의 훅은 페이로드를 **argv** 로
  준다 — `dmctl activity` 는 stdin 을 읽는다. 옮기려면 `dmctl activity` 의 입력
  계약을 넓혀야 하고, 그것은 이 문서가 고치려는 문제와 다른 일이다. `FR-AEV-12`
  가 codex 를 **규칙 안으로** 들이는 것으로 충분하다.
- **D-4. `waiting` 이 없는 에이전트를 위해 무엇도 지어내지 않는다.** omp 의 승인
  대기는 관측되지 않는다(§2.5). `Signals.Waiting=false` 가 그 사실이며, 화면에
  가짜 대기를 그리지 않는다 (`FR-OMP-8`).

---

## 5. 검증 (Verification)

### 5.1 RED 를 먼저 본다

`V-AEV-1` 은 지금 코드에서 **반드시 실패한다** — omp 의 활동 보고 `done` 은
알람을 세우지 않는다. 실패를 확인한 뒤 구현한다.

### 5.2 검증표

| ID | 확인 | 층 |
|---|---|---|
| V-AEV-1 | omp 가 `agent_start`→`agent_end` 를 보고하면 **알람이 선다** | Go |
| V-AEV-2 | claude 가 `UserPromptSubmit`→`Stop` 을 보고하면 알람이 선다 (`notify` 없이) | Go |
| V-AEV-3 | 사용자 턴 없이 온 `done`(배경 턴)은 알람이 **아니다** — `FR-ATN-4` 무변경 | Go |
| V-AEV-4 | `Signals.UserTurn=false` 인 에이전트의 `done` 은 **무조건** 알람이다 (`FR-AEV-12`) | Go |
| V-AEV-4a | codex 의 활동 보고에는 `agent` 가 실리지 않는다 — 실으면 `notify` 와 겹쳐 두 번 운다 (`FR-AEV-21`) | Go |
| V-AEV-5 | `waiting` 은 턴이 진행 중일 때만 알람이고, 되풀이는 한 번만 운다 (`FR-ATN-6`·`15` 무변경) | Go |
| V-AEV-6 | 같은 사건이 `notify` 와 `activity` 로 둘 다 와도 알람은 **한 번**이다 (`FR-AEV-13`) | Go |
| V-AEV-7 | 선언(`Signals`)과 `HookParse` 의 실제 산출이 일치한다 — 세 에이전트 전부 (`FR-AEV-4`) | Go |
| V-AEV-8 | `Readiness.Hooks == Signals.Idle` (`FR-AEV-5`) | Go |
| V-AEV-9 | claude 의 `hooks.json` 에 `notify` 가 **없다** (`FR-AEV-20`) | Go |
| V-AEV-10 | 데몬 모드(`AttnTracker`)에서 V-AEV-1·3·5 가 같게 성립한다 (`FR-AEV-14`) | Go |

---

## 6. 비목표 (Non-goals)

1. **활동 상태 어휘의 변경.** `working`/`waiting`/`done`/`idle`/`ended` 그대로다.
2. **codex 기동줄의 이관** (D-3). `-c notify=[...]` 는 그대로 둔다.
3. **omp 의 승인 대기 관측.** omp 의 훅 표면에 그 이벤트가 없다 (D-4). omp 에
   승인 게이트 이벤트가 생기면 `Signals.Waiting` 을 참으로 바꾸는 한 줄이다.
4. **L2 idle 알람·OSC 감지·`dmctl notify` 의 사람용 규약** (`FR-AEV-31`).
5. **`Adapter` 를 Go `interface` 로 바꾸는 것.** `Adapter` 는 이미 에이전트별
   구현을 한 타입 뒤에 두는 추상화이고, `HookParse` 가 그 구현부다. 타입 종류를
   바꾸는 것은 동작을 하나도 바꾸지 않으면서 호출부 전부를 건드린다.

---

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-11 | 초안. omp 알람 미배선의 원인을 구조에서 확정하고(§2.1), 이벤트 선언(`Signals`)과 알람 파생을 세웠다. |
| 2026-09-11 | 구현 중 `FR-AEV-21` 을 바로잡았다 — 초안은 codex 의 중복 발화를 소비 의미론이 막는다고 적었으나, `FR-AEV-12` 의 무조건 갈래에는 그 의미론이 걸리지 않는다. codex 의 활동 보고에서 `agent` 를 빼는 것으로 닫았다. |
