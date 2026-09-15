# M12 — 에이전트의 차이는 어댑터에서 끝난다

> **문서 상태**: 승인·구현중

- 선행: M11 완료 (`edad7ca`). 접수 쉰둘이 닫혔고 전량 e2e 는 `unexpected 0` 이다
- 형식: IEEE 29148 (요구 → 결정 → 검증). 규약은 `M11_SRS` 와 같다 — Spec → Test → Code,
  단계마다 전량 e2e `unexpected 0`, 동작 변경은 이전/새/이유
- 상위 결정: `D-M11-3`(진실은 실제 에이전트의 동작이다) · `D-M11-4`(주지 않는 값은
  옮기지 않는다) · `D-M11-7`(쓰면서 나온 접수가 앞선 결정을 이긴다) 이 그대로 선다

## 1. 목적

넷이다. **둘째가 본체이고 나머지 셋은 그 둘레다.**

1. **`/dongminal:migration` 이 확인되면 묻지 않고 닫는다** — 판정의 근거가 화면이
   아니라 훅 상태이므로, 그 판정이 섰으면 되물을 것이 없다
2. **에이전트 어댑터 강화** — *"agent 별로 다른 동작은 전부 adaptor 에서 끝나야 한다.
   밖에서는 무조건 agent adaptor 를 통해 동작한다"* (사용자 지시, 반복)
3. **컨텍스트 사용량이 100 을 넘는다** — *"지금 300% 넘게 쓰고있으니까 말이야"*
4. **글 쓰던 중간의 `/` 도 명령을 찾는다**

## 2. 현재 상태 (2026-09-16 실측)

측정 환경: `edad7ca` 의 작업 트리 · 실제 `claude` 2.1.273 · 실제 `omp` 17.4.0.
**`codex` 는 이 기계에 설치돼 있지 않다** — codex 에 대한 아래 기술은 어댑터 소스와
그것이 근거로 삼은 `app-server generate-json-schema` 뿐이며, **실측이 아니다**
(그 사실을 §7 에 갭으로 적는다).

### 2.1 어댑터 밖으로 새어 나간 자리 — 열둘

사용자가 여섯을 지목했고, 세어 보니 열둘이다. 그중 **서브에이전트 묶기는 이미
어댑터를 지난다**(사용자의 지목이 맞았다) — 아래 표에서 뺀다.

#### (1) 도구 표면

| # | 자리 | 새어 나간 것 |
|---|---|---|
| L1 | `web/js/ui/agent-pane.js:2054` `agentDetail()` | claude 입력 키 `command`·`file_path`. **어댑터에 같은 함수가 이미 있다** (`claude.go:146` `claudeToolDetail`) — 그쪽은 `Grep`·`Glob` 의 `pattern` 까지 안다. 두 벌이고 화면판이 더 얕다 |
| **L2** | `agent-pane.js:305` | **`tool_start` 의 `ev.detail` 을 화면이 버린다.** codex·omp 어댑터는 `Detail` 을 채워 보내는데(`codex_decode.go:310·318` · `omp_decode.go:87`) `_toolCard(id, tool, **null**)` 이 받지 않는다 → **codex 의 도구 카드에는 인자가 없다** (codex 는 `tool_use` 블록을 내지 않으므로 이 길이 유일하다). omp 는 블록 길이 있어 **우연히** 서 있었다 — §2.1b |
| L3 | `agent-pane.js:1041` `_mkDiff()` | `Edit`·`Write`·`old_string`·`new_string`·`content`·`file_path`. codex 는 편집을 `Changes`(경로 배열), omp 는 `Arguments` 원문으로 준다 → **둘 다 diff 가 서지 않는다** |
| L4 | `agent-pane.js:1021` `_isBackground()` | `run_in_background` 는 claude `Bash` 의 입력 키다 |

#### (1b) L2 의 실제 범위 — **omp 는 우연히 서 있었다** (프로브 실측 2026-09-16)

고침을 무력화하고(`_toolCard(…, null)` TEMP-PROBE) 셋을 다시 재니 **codex 만 떨어졌다.**
omp 는 통과했다. 까닭을 따라가면 우연이다.

```
claude 의 Bash  input = {"command": …}       ← agentDetail 이 찾던 키
omp 의 shell    arguments = {"command": …}   ← 같은 이름이라 맞았다
codex           tool_use 블록을 **아예 내지 않는다** → 어떤 길도 없다
```

화면의 `agentDetail` 은 `command` → `file_path` 순으로 찾았고, omp 의 shell 도구가
마침 `command` 를 쓴다. **맞은 것이지 안 것이 아니다** — `ompArgsDetail` 이 둘째로
보는 키는 `path` 이고 화면은 그것을 `file_path` 로 찾았으므로, **경로를 인자로 받는
omp 도구는 화면에 JSON 원문이 섰다.**

우연한 일치는 계약이 아니다. 이 사실이 D-M12-1 의 근거를 더한다 — **누수는 틀린
답보다 우연히 맞은 답으로 더 오래 산다.**

#### (2) 명령 표면

| # | 자리 | 새어 나간 것 |
|---|---|---|
| L5 | `web/js/core/constants.js:175` `AGENT_PICK_CMD_RE` | `/model`·`/config` 라는 claude 의 명령 **이름**이 상수에 박혔다 |
| L6 | `agent-pane.js:1508` `_openConfigPick()` | `key=a|b|c` 는 claude `/config` 의 **응답 텍스트 형식**. 가로채는 계기(`_awaitConfig`)가 본문 렌더 경로(`_endText`) 한가운데 산다 |
| **L7** | `agent-pane.js:1504` ↔ `:1791` | **같은 일을 하는 손이 둘이다.** 메뉴는 `control('set_model', v)` — 어댑터 경로다. `_openModelPick` 은 `/model <v>` 를 **프롬프트 문자열로** 보낸다. codex 에는 슬래시 명령이 없어 그쪽에선 그냥 프롬프트로 샌다 |
| **L8** | `omp_decode.go:205` `ompCommandsStatus` | **어댑터 안의 결함.** 주석이 *"omp 의 명령 목록은 이름뿐이다 — 실측한 프레임에 설명·인자 문법이 없다"* 라 적혀 있는데 **사실이 아니다** (§2.2) |

#### (3) 사용량

| # | 자리 | 잘못된 것 |
|---|---|---|
| **L9** | `claude_decode.go:292` `claudePickModelUsage` | **300% 의 뿌리** (§2.3) |
| L10 | `agent-pane.js:511` `_setUsage` | `Object.assign` 영구 병합 — `contextWindow` 가 한 번 박히면 모델이 바뀌어도 낡은 채 남는다 |

#### (4) 도구 종류

| # | 자리 | 잘못된 것 |
|---|---|---|
| **L11** | `internal/shared/toolhub/bracketpaste.go:118` | `SendPaste` 가 `p.Kind == KindAgent` 면 **`return nil`** — 성공으로 답하고 버린다 (§2.4) |
| L12 | `agentsess/session.go:273` `Controls` | 선언이 부족하다 — 화면이 *"내가 아는 도구인가"* 를 **스스로** 판정한다 (L1·L3·L4 가 그 결과다) |

### 2.2 실측 — omp 의 명령 목록은 이름뿐이 아니다 (L8)

`omp --mode rpc-ui --approval-mode always-ask` 를 띄우고 기동 직후 밀려오는
`available_commands_update` 를 원문으로 받았다. 명령 **56개**이고 항목의 모양이 이것이다.

```json
{"name":"fast","description":"Toggle fast mode",
 "input":{"hint":"[on|off|status]"},
 "subcommands":[{"name":"on","description":"Enable fast mode"},
                {"name":"off","description":"Disable fast mode"},
                {"name":"status","description":"Show fast mode status"}],
 "source":"builtin"}
```

`description` 과 `input.hint` 가 **둘 다 있다.** `aliases`(`model` → `models`)와
`subcommands` 도 온다. 어댑터는 `name` 만 읽고 나머지를 버린다.

  이전 동작: omp 의 슬래시 목록은 이름만 선다 — `M9_SRS FR-M9-45` 가 claude 에서
             푼 문제(*"무엇을 보낼지 알 길이 없다"*)가 omp 에 그대로 남아 있다
  새  동작: `description`·`ArgumentHint` 를 함께 싣는다 — claude 와 같은 자격
  이유:     그 값은 프로토콜이 이미 보내고 있었다. **주석이 틀렸을 뿐이다**

**`subcommands` 는 옮기지 않는다** — `ProtoCommand` 에 그 어휘가 없고, `input.hint` 가
같은 내용을 문법으로 이미 말한다(`[on|off|status]`). 없는 계약을 이 변경에서 만들지
않는다 (FR-APS-4).

### 2.3 실측 — 300% 는 분자가 아니라 **분모**다 (L9)

사용자의 가설은 *"누적과 순간이 섞였다"* 였다. **재어 보니 틀렸다.**

`claude -p --output-format stream-json --input-format stream-json` 에 프롬프트 **둘**을
넣고 사용량을 싣는 프레임을 전수로 셌다.

| 프레임 | `input` | `cache_creation` | `cache_read` | `context()` |
|---|---|---|---|---|
| 턴1 `message_start.usage` | 2 | 25698 | 0 | **25700** |
| 턴1 `result.usage` | 2 | 25698 | 0 | **25700** |
| 턴2 `message_start.usage` | 2 | 34 | 25698 | **25734** |
| 턴2 `result.usage` | 2 | 34 | 25698 | **25734** |

**`result.usage` 는 턴별이다 — 누적이 아니다.** 분자는 옳다.

누적인 것은 `modelUsage` 쪽이다 (턴2 의 `cacheCreationInputTokens` = 25732 = 25698+34).
그리고 **거기에 항목이 둘이다.**

```
modelUsage = {
  "claude-haiku-4-5-20251001": { contextWindow:  200000, ... },
  "claude-opus-5[1m]":         { contextWindow: 1000000, ... }
}
```

`claudePickModelUsage` 는 `sort.Strings(names); return names[0]` 다. 주석은
*"보통 하나다"* 라 적혀 있으나 **둘이고, 사전순 첫 항목이 haiku 다**(`h` < `o`).
claude Code 가 제목 생성 등에 haiku 를 쓰기 때문에 거의 언제나 둘이다.

그래서 화면은 **opus 대화의 토큰을 haiku 의 창으로 나눈다.**

```
tokens 600000 / window 200000 = 300%     ← 접수한 그 수
```

**모델 이름도 함께 틀린다** — 머리에 `claude-haiku-4-5-20251001` 이 선다.

고칠 재료는 이미 있다: `init` 프레임이 말하는 세션 모델이 `claude-opus-5[1m]` 이고
이것이 **`modelUsage` 의 키와 정확히 일치한다.**

**`message_start` 의 이름은 다르다** — 그쪽은 `claude-opus-5`(정본 이름)이며
`modelUsage[...].canonicalModel` 과 같다. 그래서 되짚는 손이 **둘** 필요하다.

**codex·omp 는 이 결함이 없다** — codex 는 `tokenUsage.last.inputTokens` 와
`modelContextWindow` 를 한 프레임에서 받고, omp 는 `contextUsage{tokens,contextWindow,
percent}` 를 한 덩이로 받는다. 고르는 일 자체가 없다.

### 2.3b **§2.3 의 결론을 뒤집는다** — 잰 턴이 너무 단순했다 (2026-09-16)

§2.3 은 *"`result.usage` 는 턴별이다 — 누적이 아니다. 분자는 옳다"* 로 끝맺었다.
**그것이 틀렸다.** 고침을 넣고도 사용자의 화면이 **462%** 였다.

까닭은 **잰 턴이 도구를 쓰지 않아 API 요청이 하나뿐**이었다는 데 있다 — 그때는
합과 순간이 **같은 수**라 갈리지 않는다. 도구를 세 번 쓰는 턴을 재니 갈렸다.

```
usage (최상위)   input 8  cache_creation 26049  cache_read 77517  → 103574   (요청 4번의 합)
usage.iterations[-1]  input 2  cache_creation 105  cache_read 25944  →  26051   (순간)
```

**접수자의 원래 가설이 옳았다** (*"누적과 순간이 섞였는지부터 의심하라"*).

**그러면 §2.3 의 고침(FR-M12-6)은 헛것이었나 — 아니다.** 라이브 상태가 그것을 가른다:

```
usage: {"tokens": 489801, "contextWindow": 1000000, "model": "claude-opus-5"}
```

창은 **고쳐졌다** (200000 → 1000000). 남아 있던 것은 **분자**이며, 둘은 서로 다른
결함이 같은 수(비율)를 망가뜨리고 있었다. 하나를 고치고 수가 줄지 않자 *"고침이
안 들어갔나"* 로 의심이 갔고, 라이브 상태를 읽고서야 갈렸다.

**교훈 둘.**

1. **실측의 표본이 현상을 담는지 물어라.** 나는 *"두 턴을 쟀다"* 를 근거로 들었는데,
   재야 했던 것은 턴의 **수**가 아니라 턴 안의 **요청의 수**였다
2. **한 수치가 둘 이상의 결함을 가질 수 있다.** 첫 고침 뒤에도 증상이 남으면
   *"안 고쳐졌다"* 가 아니라 **"둘이었다"** 를 먼저 의심한다

### 2.4 인계가 드러낸 결함 — `dmctl msg` 가 GUI 에 닿지 않는다 (L11)

이 SRS 를 낳은 인계 자체가 그 증거다: `dmctl msg --to <toolId>` 를 **두 번** 보냈고
둘 다 *"전송 완료"* 를 냈는데 `/api/agent/events` 에는 `session` 하나뿐이었다.

경로를 따라가면 한 줄에서 끝난다.

```
dmctl msg → POST /api/tools/message → apiToolMessage → s.ToolIO.SendPaste(toolID, …)
                                                              │
  toolhub/bracketpaste.go:118 ─────────────────────────────────┘
      if p.Kind == KindAgent { return nil }      ← 성공으로 답하고 버린다
```

그 자리의 주석은 *"오류가 아니라 무동작이다; 입력은 해석층의 프롬프트 경로로 간다"*
라 적혀 있다. **그 경로로 보내는 코드가 없다.** `apiToolMessage` 도 `apiToolInput` 도
`SendPaste` 하나만 부른다.

**받는 쪽은 이미 있다** — `s.agentSessions` 와 `sess.Prompt(text, atts...)` 를
`/api/agent/prompt` 가 쓰고 있다. 잇기만 하면 된다.

**`SendPaste` 의 무동작은 그 자체로는 옳다** (`FR-AGT-2`: 프레임 아닌 바이트는
에이전트를 깨뜨린다). 틀린 것은 **부르는 쪽이 그 사실을 성공으로 읽는 것**이다.

명령서(`migration.md`)가 같은 자리에서 낡았다:

- 3단계는 `--agent` 로 gui 탭을 열라 하고 7단계는 `dmctl msg` 를 쓰라 한다 — **닿지 않는다**
- 8단계의 진단 갈래(*"엔벨로프가 입력줄에 문자열로 남아 있다"*)는 **PTY 를 전제**한다. gui 에는 입력줄이 없다
- 9단계는 `working` 을 본 뒤에도 사용자에게 확인을 구한다 — **과제 1이 이것이다**

### 2.5 사용자 결정 (2026-09-16)

| 물음 | 답 |
|---|---|
| `/config` 류 "한 에이전트에만 있는 고르는 화면" 을 계약에 어떻게 넣나 | **`ProtoCommand` 에 `Form` 선언을 더한다** — 어댑터가 선언하고, 응답을 폼 명세로 옮기는 일도 어댑터가 한다 |
| L11 을 어디까지 고치나 | **경로를 잇고 명령서도 고친다** — 과제 1과 같은 변경에서 |

## 3. 요구

### FR-M12-1 — 도구가 무엇을 했는지는 **어댑터가 말한다** (L1·L2)

`Event.Detail` 은 **모든** 어댑터가 `tool_start` 에 싣는다. 화면은 그 값을 그린다.

  이전 동작: codex·omp 는 `Detail` 을 실었으나 화면이 버렸고(`_toolCard(…, null)`),
             claude 는 싣지 않았으며 화면이 **입력 JSON 을 스스로 파싱**했다
  새  동작: claude 도 `tool_start` 에 `Detail` 을 싣는다 (`claudeToolDetail` 을 그
             자리에서도 부른다). 화면의 `agentDetail()` 은 **사라진다**
  이유:     `claudeToolDetail` 이 이미 있었고 더 잘 안다. 두 벌 중 **얕은 쪽이
             브라우저에 있었다**

**입력 원문은 계속 간다** (`Event.Message` 의 `tool_use.input`) — 승인 다이얼로그와
도구 카드 본문이 **원문을 그대로 보이는 것**은 종전 계약이며 바뀌지 않는다
(FR-AGT-5). 바뀌는 것은 **뽑아 쓰는 일을 누가 하는가**다.

**모르는 도구의 `Detail` 은 빈 값이다.** 그때 화면은 도구 이름만 적는다 — 종전에
`agentDetail` 이 `JSON.stringify` 로 채우던 자리이고, **그 모양을 잃지 않기 위해**
어댑터가 마지막 갈래로 같은 일을 한다 (`Detail` 이 빌 때만).

### FR-M12-2 — 편집의 diff 는 **공통 어휘로** 온다 (L3)

`Event` 에 `Edit *ToolEdit` 을 더한다. 어댑터가 자기 도구의 입력을 이 어휘로 옮긴다.

```go
type ToolEdit struct {
    File    string   `json:"file"`
    Added   []string `json:"added,omitempty"`
    Removed []string `json:"removed,omitempty"`
}
```

- claude: `Edit`(`old_string`/`new_string`) · `Write`(`content`) 를 옮긴다
- codex: `Changes` 는 **경로만** 준다 → `File` 만 채우고 줄은 비운다
- omp: 재지 않았다 → **옮기지 않는다** (§7 갭)

  이전 동작: `_mkDiff()` 가 브라우저에서 claude 의 입력 키를 파싱했다
  새  동작: 어댑터가 `ToolEdit` 을 싣고 화면은 그것만 그린다
  이유:     `D-M11-4` 그대로 — **주지 않는 값은 옮기지 않는다.** codex 가 줄을 주지
             않는다는 사실은 `Added`·`Removed` 가 **비어 있는 것**으로 말해진다.
             화면이 파싱하면 그 부재가 *"편집이 아니다"* 로 읽힌다

**줄번호는 여전히 달지 않는다** (`M11_SRS` §7 의 갭 그대로).

### FR-M12-3 — 백그라운드 여부는 **어댑터가 말한다** (L4)

`Event.Background bool` 을 더한다. claude 는 `run_in_background:true` 를 보고 세우고,
codex·omp 는 세우지 않는다 — **그 어댑터에 그 개념이 없다** (FR-APS-4).

### FR-M12-4 — 고르는 화면은 **선언으로 선다** (L5·L6·L7 · 사용자 결정)

`ProtoCommand` 에 `Form` 을 더한다.

```go
type ProtoCommand struct {
    Name, Description, ArgumentHint string
    // Form 은 이 명령이 **고르는 화면으로 서는가**다. nil 이면 평범한 명령이다.
    Form *CommandForm `json:"form,omitempty"`
}

type CommandForm struct {
    // Kind 는 폼의 종류다 — `models` · `keyvalue`.
    Kind string `json:"kind"`
    // AwaitResponse 는 **보낸 뒤 답이 와야** 폼을 채울 수 있는가다.
    // 거짓이면 이미 들고 있는 값(예: status.models)으로 곧바로 선다.
    AwaitResponse bool `json:"awaitResponse,omitempty"`
    // Control 은 고른 값을 보낼 **제어의 종류**다 (`set_model`).
    // `models` 에는 반드시 있어야 한다 — 없으면 폼을 열지 않는다 (아래 근거).
    Control string `json:"control,omitempty"`
}
```

그리고 `Proto` 에 폼을 채우는 손 하나:

```go
// CommandFormFill 은 명령의 응답 텍스트를 폼 명세로 옮긴다 (AwaitResponse 인 것만).
// nil 이면 그 에이전트에 그런 명령이 없다.
CommandFormFill func(name, response string) []FormField
```

  이전 동작: `AGENT_PICK_CMD_RE` 가 `/model`·`/config` 라는 **이름을 알았고**,
             `_openConfigPick` 이 `key=a|b|c` 라는 **claude 의 출력 형식을 파싱**했다
  새  동작: 화면은 `cmd.Form` 이 있으면 폼을 연다 — **이름을 모른다.** `keyvalue`
             폼의 내용은 `/api/agent/command-form` 이 어댑터에게 물어 돌려준다
  이유:     사용자 지시 그대로다. 그리고 이 모양은 **claude 가 `/config` 의 출력
             형식을 바꿔도 화면을 고치지 않는다**

`/model` 은 `Form{Kind:"models", Control:"set_model"}` 이다 — **L7 이 여기서 닫힌다.**
고른 값이 `control('set_model')` 로 가므로 메뉴와 **같은 손**이 된다.

**`Control` 없는 `models` 폼은 열지 않는다.** 문자열로 되돌리는 갈래를 남기면 그것이
곧 L7 의 모양이다 — 어느 에이전트에서는 제어로, 어느 에이전트에서는 프롬프트로 나가고
그 차이를 화면이 든다. 열지 않으면 명령이 글자 그대로 나가 **종전 동작**이 되며,
그것이 우리가 아는 갈래다 (FR-CBG-5). codex 에는
`/model` 명령이 없으므로(`Commands` 가 빈 목록) 이 폼도 서지 않고, 메뉴의 모델 고르기는
종전대로 선다.

**claude 어댑터가 두 명령에 `Form` 을 단다** — `initialize` 가 준 68개 중 그 둘이다.
omp 도 `model` 명령을 주지만(§2.2 의 목록) **그 응답 형식을 재지 않았으므로 달지
않는다** (§7 갭).

### FR-M12-5 — 어댑터의 능력은 **선언으로 말한다** (L12)

`Controls` 에 더한다.

```go
type Controls struct {
    Interrupt, Control, TUIResume, Attachments bool
    // Cancel 은 열린 요청을 **답 없이** 닫을 수 있는가다 (omp 만 참).
    Cancel bool `json:"cancel"`
}
```

화면은 종전대로 *거절 → 끊기* 를 보내되, `Cancel` 이 참이면 거절 대신 취소를 보낸다.

  이전 동작: `_abandon()` 이 언제나 `choice:'deny'` 를 보낸다 — 그 근거가 주석에
             *"claude 에는 답 없이 닫는 프레임이 없다"* 로 적혀 있다. **claude 의
             사정이 모든 에이전트의 동작이 됐다**
  새  동작: 능력을 선언에서 읽는다. omp 는 취소가 가고, 나머지는 종전 그대로다
  이유:     `ompProto.Cancel` 이 **있는데 부르는 곳이 없었다**

### FR-M12-6 — 사용량의 창은 **그 세션의 모델의 것**이다 (L9)

`claudePickModelUsage` 는 세션 모델로 고른다. 순서는 셋이다.

1. `modelUsage` 의 **키가 세션 모델과 같은 것** (`init` 의 `claude-opus-5[1m]`)
2. 없으면 `canonicalModel` 이 세션 모델과 같은 것 (`message_start` 의 `claude-opus-5`)
3. 없으면 **고르지 않는다** — `Model`·`ContextWindow` 를 싣지 않는다

  이전 동작: 사전순 첫 항목. 실제로는 거의 언제나 haiku 이고, 그 창(200k)으로
             opus 대화(최대 1M)를 나누어 **비율이 100 을 크게 넘었다**
  새  동작: 세션 모델의 것. 못 고르면 **비운다**
  이유:     `FR-CBG-5` — 모르는 것을 0 이나 남의 값으로 말하지 않는다. 3번 갈래에서
             창을 비우면 화면은 `agent.ctx_unknown`(토큰만) 으로 적는다. **그것이
             300% 보다 정확하다**

**세션 모델을 어댑터가 들고 있어야 한다** — `claudeExt` 에 `model` 을 더한다
(`init` 과 `message_start` 가 쓴다).

### FR-M12-7 — 창은 **그 모델의 것**이다 (L10)

`_setUsage` 의 병합이 `contextWindow` 의 **임자**를 함께 기억한다. 모델이 바뀌었는데
새 창이 오지 않으면 옛 창을 버린다.

  이전 동작: `Object.assign(…, filter(v=>v))` 라 `contextWindow` 가 한 번 박히면
             영영 남는다 — 그 뒤로 어느 모델에서 재든 같은 수로 나눈다
  새  동작: 창과 함께 **그때의 모델**을 적어 둔다. 모델이 바뀌고 새 창이 오지
             않으면 창을 버리고, 화면은 토큰만 적는다 (`agent.ctx_unknown`)
  이유:     FR-M12-6 이 **못 고르면 창을 싣지 않는** 갈래를 두므로 그 부재가
             화면까지 닿아야 한다. 창을 버리지 않으면 **남의 모델의 창**으로
             나눈 수가 계속 선다 — 그것이 이 결함의 모양 그대로다

**범위를 좁힌 것이다.** 초안은 *"창과 모델은 한 벌이라 한쪽만 온 이벤트가 앞의
다른 쪽과 짝지어지지 않는다"* 로 적었으나, 그 갈래(`message_start` 의 토큰이 옛
`result` 의 창과 짝지어진다)는 **정상이다** — 한 세션에서 창은 모델이 바뀌지 않는 한
바뀌지 않으므로, 앞 턴의 창으로 이번 턴의 토큰을 나누는 것이 옳다. 재는 값이 없는
방어를 짓지 않는다.

### FR-M12-8 — 에이전트 도구에 보낸 메시지는 **에이전트에게 간다** (L11)

`apiToolMessage`·`apiToolInput` 은 대상이 에이전트 도구면 `sess.Prompt()` 로 보낸다.

  이전 동작: `SendPaste` 하나를 불렀고, 그것이 `KindAgent` 에 **무동작**이라
             *"전송 완료"* 를 내고 메시지가 사라졌다
  새  동작: 도구 종류를 보고 갈라 보낸다. 에이전트 세션이 없으면 **오류다** —
             성공으로 답하지 않는다
  이유:     *"모른다와 괜찮다는 다르다"* (FR-APS-4). 조용한 성공은 인계를 잃는다

**엔벨로프 형식은 그대로다** — 서버가 만드는 바이트가 같아야 받는 에이전트가
같은 것을 믿는다 (D-A-8).

### FR-M12-9 — 인계가 확인되면 묻지 않고 닫는다 (과제 1)

`migration.md` 9단계에서 **사용자 확인을 구하지 않는다.**

  이전 동작: 8단계가 `working` 을 본 뒤에도 마지막에 사용자에게 되묻는다
  새  동작: 8단계가 `working` 을 확인했으면 곧바로 닫는다. **확인하지 못했으면
             종전대로 멈추고 말한다** (절대 원칙 5는 그대로다)
  이유:     판정의 근거가 화면이 아니라 **훅 상태**(`dmctl wait --for ready` ·
             `dmctl status`)다. 그 판정이 섰는데 되묻는 것은 같은 답을 두 번 구하는 것

같은 변경에서 gui 갈래를 고친다:

- 6단계: gui 는 `read-screen` 이 없다 — `dmctl status` 의 `live=true` 가 둘째 관문이다
- 8단계: gui 의 진단 갈래는 **입력줄이 아니라 `/api/agent/events`** 다

### FR-M12-10 — 캐럿 앞의 토큰이 `/` 로 시작하면 찾는다 (과제 4)

`_suggest()` 는 **입력 전체**가 아니라 **캐럿 앞의 토큰**을 본다.

  이전 동작: `v.startsWith('/')` — 문장 중간의 `/` 는 찾지 않는다
  새  동작: 캐럿 앞에서 공백·줄바꿈까지 거슬러 올라간 토큰이 `/` 로 시작하면 찾는다
  이유:     `FR-M11-48` 이 연 드롭다운의 요구가 *"/글자 로 입력하면 검색"* 이고,
             문장 중간도 그 요구 안이다

**넣을 때는 그 토큰만 간다** — `_suggTake` 가 입력창을 통째로 갈지 않는다. 문장을
날리면 접수한 편의의 반대다 (`FR-M11-48` 의 엔터 갈래와 같은 근거).

**경로는 명령이 아니다** — `src/foo` 의 `/` 는 토큰의 **첫 글자가 아니므로** 서지
않는다. 토큰 경계를 공백으로 두는 것이 그 갈래를 공짜로 준다.

### FR-M12-11 — 컨텍스트는 **마지막 요청**의 것이다 (접수 재개 · 2026-09-16)

`result` 의 최상위 `usage` 는 **턴 안의 API 요청들을 합한 값**이다. 컨텍스트로 쓸 수
없다 — `ProtoUsage.Tokens` 의 뜻이 *"마지막 요청의 입력 컨텍스트"* 이기 때문이다.

  이전 동작: 최상위 `usage` 를 합산해 실었다 (input + cache_creation + cache_read)
  새  동작: `usage.iterations` 의 **마지막 항목**을 쓴다. 없으면 최상위 (요청이 하나뿐인 턴)
  이유:     긴 세션에서 그 합이 창을 훌쩍 넘는다 — 접수한 **462%** 가 그 몫이다

**캐시도 같은 요청의 것을 싣는다** — 그래야 `Tokens = Input+CacheWrite+CacheRead` 가
화면에서 성립한다. 한쪽만 옮기면 나란히 적힌 수가 서로를 부정한다.

**출력 토큰과 비용은 턴의 합이 옳다**: 그것은 *이 턴이 얼마를 썼나* 이지 *지금
컨텍스트가 얼마인가* 가 아니다. 둘을 같은 규칙으로 밀지 않는다.

**§2.3 의 결론을 뒤집는다** — 그 절은 *"`result.usage` 는 턴별이라 분자는 옳다"* 로
적었고 **그것이 틀렸다**. 까닭은 §2.3b 에 적는다.

### FR-M12-12 — 끊고 나서 **끝난 것을 보고** 큐를 넣는다 (접수 2026-09-16)

> 사용자 접수: *"큐가 들어갈때 큐가 들어가고 이후 턴 중단이 선언된다. 순서가
> 반대이다. 턴중단 후 큐가 들어가는것이다."*

  이전 동작: `/api/agent/interrupt` 의 **응답이 오면** 곧바로 큐를 보냈다
  새  동작: 턴이 **실제로 끝나기를** 기다린 뒤 보낸다 (시한 안에서)
  이유:     그 응답은 *"끊는 프레임을 썼다"* 이지 *"턴이 끝났다"* 가 아니다.
             `turn_end` 는 에이전트의 `result` 가 와야 나고, 그 사이에 큐가 나가면
             **끊김 표시가 새 프롬프트 뒤에** 선다 — 사용자는 그것을 *방금 보낸
             프롬프트가 0초 만에 중단됐다* 로 읽는다

**`FR-M11-5` 와 같은 부류다** (*"전환은 끝난 것을 보고 연다"*): 명령을 보냈다는 것과
그것이 먹혔다는 것은 다르다. 그 조항이 셸 쪽에서 세운 규약을 GUI 의 큐가 지키지
않고 있었다.

**시한을 넘기면 그래도 보낸다.** 사용자가 쓴 글을 잃는 것이 순서가 뒤집히는 것보다
나쁘다 — 그 갈래를 §7 에 갭으로 적는다.

### FR-M12-13 — 모르는 프레임 다섯은 **백그라운드 작업**이다 (접수 2026-09-16)

> 사용자 접수: *"여전히 '알 수 없는 프레임'이 나온다."*

사용자의 실제 세션 로그에서 **다섯 종 124건**을 셌다 (이벤트 4096 중 `raw` 124).

| 프레임 | 실린 것 | 건수 |
|---|---|---|
| `system:task_started` | `task_id`·`tool_use_id`·`description`·`is_backgrounded`·`task_type` | 38 |
| `system:task_notification` | `task_id`·`tool_use_id`·**`status`·`output_file`·`summary`** | 38 |
| `system:background_tasks_changed` | `tasks[{task_id, task_type, description}]` | 20 |
| `tool_progress` | `tool_use_id`·`tool_name`·`parent_tool_use_id`·`elapsed_time_seconds`·`heartbeat` | 17 |
| `system:task_updated` | `task_id`·`patch{is_backgrounded}` | 11 |

**`M11_SRS` §7 의 갭 기술이 틀렸다.** 거기엔 *"백그라운드의 내용은 보이지 않는다 —
프로토콜이 진행을 **구조로 주지 않는다** … ID·출력 경로가 결과 **문장 안**에 있다"*
라 적혀 있는데, **구조로 준다**: `task_notification` 이 완료 `status`·`output_file`·
`summary` 를 필드로 싣는다.

**L8 과 같은 부류의 잘못된 단정이다** (D-M12-2) — 그때는 omp 의 명령 설명이었고
이번은 claude 의 백그라운드 진행이다. 둘 다 *"프로토콜이 주지 않는다"* 로 적혀 있었고
둘 다 주고 있었다.

  이전 동작: 다섯 모두 `raw` 로 서서 대화에 **'알 수 없는 프레임'** 이 섞인다
  새  동작: 어댑터가 해석한다 — 도구 카드가 **경과 시간**과 **완료 상태·요약**을 말한다
  이유:     사용자 결정 (2026-09-16) · `FR-CBG-5` 는 **오는 값을 버리라는 조항이
             아니다**

### FR-M12-14 — 고르는 화면은 읽히고, 엔터로 끝난다 (접수 2026-09-16)

> 사용자 접수: *"선택 모달 좀 가시성이 안좋은거같아. 가독성 높게 디자인하고
> 줄바꿈도 하고 엔터도 치고 해줘."*

  이전 동작: 선택지가 한 줄로 흐르고(`align-items:baseline`, 줄바꿈 규칙 없음) 긴
             이름·설명이 잘리거나 창을 밀었다. 설명은 `title` 에만 있어 **가리켜야**
             보였다. 엔터로 확정할 수 없었다
  새  동작: 항목마다 **이름과 설명이 두 줄로** 서고 긴 글은 줄바꿈한다. 고른 항목이
             **테두리로** 갈린다. `Enter` 가 확정, `Esc` 는 종전대로 닫힘
  이유:     고르는 일은 **읽고 나서** 하는 일이다. `title` 은 읽는 길이 아니다
             (`FR-M9-45` 가 슬래시 목록에서 이미 세운 규약 — 같은 근거를 여기에 잇는다)

### FR-M12-15 — 도는 중 표시는 **손이 있는 자리**에 선다 (접수 2026-09-16)

> 사용자 접수: *"작업 중 표시 채팅과 text area 사이로 옮겨줘 중앙쪽으로. 잘 안보이네"*

  이전 동작: `agp-head` 의 왼쪽 끝에 섰다 — 사용자의 눈은 대화의 바닥과 입력창에
             있는데 표시는 화면 맨 위 구석에 있었다
  새  동작: **대화와 입력창 사이**에 가운데로 선다
  이유:     `FR-M11-51` 이 *"도는 중이면 화면이 움직인다"* 를 세웠으나 **어디서**
             움직이는지는 정하지 않았다. 움직여도 보지 않는 자리면 그 요구가 절반만
             선 것이다

**머리의 자리는 비운다** — 같은 값이 두 자리에 서지 않는다 (`FR-M11-15` 의 규약
*"상단엣것을 없애고 전부 하단으로 내린다"* 와 같은 근거).

### FR-M12-16 — 서브에이전트가 **무엇을 했는지** 보인다 (실측 2026-09-16)

실제 `Agent` 호출을 돌려 재니 서브 안의 도구가 **한 줄도 서지 않는다.**

```
tool_start  parent=-              tool=Agent                              ← 부모 카드는 선다
user        parent=toolu_018i…                                           ← 서브가 받은 프롬프트
message     parent=toolu_018i…    BLOCK name=Bash detail="echo HELLO…"    ← 도구가 여기 있다
tool_end    parent=toolu_018i…                                           ← 결과
```

**서브에이전트에는 `tool_start` 가 오지 않는다** — 도구 시작은 부모 스트림의
`content_block_start` 로만 오고, 서브의 도구는 **`assistant` 스냅샷에만** 실린다.
그런데 `_applySub` 는 `message` 를 받으면 `sub.live=null` 만 하고 **블록을 버린다.**

  이전 동작: 서브 카드에 도구가 서지 않고 머리의 개수도 0 이다
  새  동작: `message` 의 `tool_use` 블록으로 도구 줄을 세운다 (이름·인자)
  이유:     **어댑터는 이미 싣고 있다** — 누수 L2 와 같은 부류이며, 그때 고친 것이
             본 대화의 경로뿐이었다

### FR-M12-17 — `Agent` 의 인자는 **무엇을 시켰나**다 (실측 2026-09-16)

`claudeToolDetail` 이 `Agent` 를 몰라 폴백이 입력 JSON 을 통째로 낸다.

```
BLOCK name=Agent detail="{\n  \"description\": \"Echo HELLO test\", …"
```

그 입력의 `description` 이 **이 서브에이전트가 무엇을 하는지** 말하는 자리다.

### FR-M12-18 — `Ctrl+B` 로 도는 작업을 백그라운드로 (접수 2026-09-16)

> 사용자 접수: *"원래 tui 에는 긴작업을 ctrl + b 로 bg 로 보낼 수 있는 기능이 있어."*

**프로토콜에 대응 제어가 있다** (실측: CLI 2.1.273 의 SDK 클라이언트):

```js
async backgroundTasks(e){ return (await this.request({
    subtype:"background_tasks", tool_use_id:e })).response.backgrounded ?? true }
async stopTask(e){ await this.request({subtype:"stop_task", task_id:e}) }
```

  새 동작: `Ctrl+B` → `Control{Kind:"background_task", Value:<도는 도구의 toolUseId>}`
           → 어댑터가 `control_request{subtype:"background_tasks", tool_use_id}` 를 보낸다

**힌트는 도는 도구에만 보인다** — 원본도 이미 백그라운드인 작업에는 그 힌트를 숨긴다
(`xc()` 가 `backgroundTask` 를 보는 그 자리).

**`stop_task` 는 이번에 쓰지 않는다** — 개별 작업을 멈추는 손은 접수에 없다. §7 에 적는다.

### FR-M12-19 — 백그라운드와 서브에이전트를 **모아 보인다** (접수 2026-09-16)

> 사용자 접수: *"bg 랑 서브에이전트는 모아서 보고싶다고 했잖아 tui 처럼."*

**프로토콜이 둘을 한 개념으로 준다.** `is_backgrounded` 필드의 문서열이 그것을 말한다:

> *"…A resumed subagent is always registered in the background. A later move to the
> background arrives as `task_updated patch.is_backgrounded`. Set for **`local_agent`**
> and **`local_bash`** tasks."*

그리고 원본이 **모아 적는 함수**가 그대로 있다 (D-M11-3 의 명세다):

```
local_bash          → "1 shell" / "N shells"   (kind==="monitor" 이면 "N monitors")
local_agent         → "1 local agent" / "N local agents"
in_process_teammate → "N teams"
```

살아 있는 목록은 `system:background_tasks_changed{tasks:[{task_id, task_type,
description}]}` 가 **매번 통째로** 준다 — 우리가 세지 않는다.

### FR-M12-20 — 할 일 목록이 보인다 (접수 2026-09-16)

> 사용자 접수: *"todo도 보이게 하자."*

원본 TUI 는 `TodoWrite` 의 목록을 그 자리에 세운다. **재료는 도구 입력**이고
(`todos:[{content,status,activeForm}]`) 지금은 그 JSON 이 도구 카드 안에 글로 선다.

### FR-M12-21 — GUI 에이전트도 **플러그인을 들고 뜬다** (접수 2026-09-16)

> 사용자 접수: *"dongminal:migration 이 커맨드는 검색이 안되는데 왜그런지 확인"*

**검색의 문제가 아니다.** 라이브 상태를 읽으니 그 세션의 명령 68개에
`dongminal:migration` 이 **아예 없다.**

까닭은 `claudeProtoLaunch` 의 argv 에 `--plugin-dir`·`--settings` 가 **없다**는 것이다.
그 둘은 **셸 래퍼**(`shellhooks/posix/zdotdir/.zshrc` 의 `claude()` 함수)가 붙이므로,
터미널에서 친 `claude` 만 받는다.

```
터미널:  claude --settings …/agent-hooks/claude.json --plugin-dir …/agent-plugin   ← 붙는다
GUI:     claude -p --output-format stream-json …                                    ← 안 붙는다
```

그래서 **GUI 에이전트는 `/dongminal:migration`·`/dongminal:team`·`/dongminal:workflow`
를 쓸 수 없다.** 인계를 GUI 로 넘기면 그 세션은 다음 인계를 스스로 하지 못한다.

  새 동작: 프로토콜 기동도 `PolicyInjection.Flags` 를 싣는다 — 선언은 이미 어댑터에
           있고(`claude.go` 의 `Flags:[]string{"--settings","--plugin-dir"}`) 그것을
           **읽는 쪽이 터미널 표면뿐**이었다
  이유:    같은 에이전트가 표면에 따라 다른 능력을 갖는 것은 `FR-U-3` 의 *"서로를
           대체하지 않는다"* 와 다르다 — 그 조항은 **표면이 나란하다**는 뜻이지
           한쪽이 모자라도 된다는 뜻이 아니다

### FR-M12-22 — `Shift` 를 쥐면 **고른다** (접수 2026-09-16)

> 사용자 접수: *"cmd + 좌우 + shift 도 text area 에서 동작을 안하는데"*

`FR-M11-22` 는 **캐럿 이동**만 세웠다. 코드가 그것을 그대로 말한다:

```js
if((e.key==='ArrowLeft'||e.key==='ArrowRight') && !e.shiftKey){ … }  ← shift 면 우리 손이 안 돈다
this.ta.setSelectionRange(i,i);                                       ← 언제나 선택을 접는다
```

  새 동작: `Cmd+Shift+좌우` 는 줄 끝까지, `Alt+Shift+좌우` 는 단어 단위로 **고른다**.
           고정점(anchor)은 움직이지 않는 쪽 끝이다
  이유:    이동과 선택은 같은 규약의 두 짝이고, 한쪽만 있으면 나머지를 브라우저가
           할 것이라 **가정**한 것이다. 접수가 그 가정을 반증했다

**전역 단축키 충돌은 아니다** — 창 이동은 `Ctrl+Shift+화살표`이고 `Cmd+Shift+화살표`를
잡는 자리는 없다 (확인함).

### FR-M12-23 — **멈춘 것은 오류가 아니다** (접수 2026-09-16)

> 사용자 접수: *"0.1초 걸렸습니다 / 턴이 오류로 끝났습니다: aborted_tools — 이런경우도
> 잦네."*

**라이브 로그가 그 잦음을 센다** — 턴 12개 중 **7개가 "오류"로 적혔고 하나도 오류가
아니다**:

| 사유 | 횟수 | 실제 |
|---|---|---|
| `aborted_streaming` | 6 | 사용자가 끊었다 (`Esc`) |
| `aborted_tools` | 1 | **사용자가 도구를 거절했다** |
| `completed` | 5 | 정상 |

**claude 의 어휘가 이미 갈라 준다** (CLI 2.1.273 전수):

    aborted_streaming · aborted_tools · aborted_by_mock          ← 멈춘 것
    error_during_execution · error_max_turns · error_max_budget_usd
      · error_max_structured_output_retries                      ← 오류

**누수가 함께 있다.** 화면이 이렇게 가른다:

```js
ev.text==='aborted_streaming' ? t('agent.turn_aborted') : t('agent.turn_error',{reason:ev.text})
```

`aborted_streaming` 은 **claude 의 사유 문자열**이다 (누수 L1·L5 와 같은 부류) — 그래서
`aborted_tools` 가 그 갈래에 걸리지 않고 *오류*로 떨어졌다. 어휘가 하나 늘 때마다
브라우저를 고쳐야 한다.

  이전 동작: `IsError` 하나로 갈라 **중단과 오류가 같은 빨강**이고, 사유 문자열을
             화면이 직접 비교한다
  새  동작: 어댑터가 **끝난 종류**를 공통 어휘로 말한다 — `completed` · `stopped` ·
             `error`. 화면은 그 셋만 안다
  이유:     사용자가 스스로 멈춘 것을 **오류라고 적으면** 그 화면은 거짓말을 한다.
             12번 중 7번이면 사용자는 오류 표시를 아예 안 읽게 된다

**`0.1초 걸렸습니다` 도 함께 본다** — `agent.turn_took` 가 중단된 턴에도 선다. 멈춘
턴의 경과는 *한 일*을 말하지 않으므로 `stopped` 에는 적지 않는다.

**codex·omp 도 같은 자리를 지난다**: codex 는 `turn/completed` 의 `status`
(`completed`·`interrupted`·`failed`), omp 는 `agent_end` 다 — 셋의 어휘를 그 셋으로
옮기는 것이 어댑터의 일이다.

## 4. 비목표

- **codex 를 실측하지 않는다** — 설치돼 있지 않다. 어댑터 소스와 스키마가 근거이며,
  `fakeagent` 의 codex 판으로 재는 것까지다
- **`subcommands` 를 계약에 넣지 않는다** (§2.2)
- **diff 에 줄번호를 달지 않는다** (`M11_SRS` §7 그대로)
- **M11-B1 본체** — 여전히 열려 있다

## 5. 설계 결정

**D-M12-1 — 어댑터가 옮기는 것은 *값*이고, 선언하는 것은 *능력*이다.**

누수 열둘이 두 종류였다.

| 종류 | 예 | 고치는 법 |
|---|---|---|
| 값이 계약에 없어 화면이 원문을 파싱했다 | L1·L3·L4 | **어휘를 계약에 더한다** — `Detail`·`ToolEdit`·`Background` |
| 능력이 선언되지 않아 화면이 추측했다 | L5·L6·L7·L12 | **선언을 더한다** — `Form`·`Cancel` |

**둘을 섞지 않는 것이 요점이다.** `Form` 을 함수 하나로 두면(그 대안이 있었다) 화면이
*"물어봐야 아는지"* 를 여전히 명령 이름으로 판단해야 한다 — 선언이 먼저 서야 이름이
사라진다.

**D-M12-4 — `D-M11-4` 는 절반만 인용하면 뒤집힌다.** (2026-09-16)

그 조항은 *"주지 않는 값은 옮기지 않는다"* 다. **이번 단계에서 그 앞 절반이 두 번
잘못 쓰였다** — 둘 다 `FR-CBG-5` 를 근거로 들고 *"프로토콜이 주지 않는다"* 라 단정한
주석이었고, 둘 다 **주고 있었다** (omp 의 명령 설명 L8 · 백그라운드 진행 FR-M12-13).

그러므로 문장을 늘린다.

> **주지 않는 값은 옮기지 않는다 — 다만 주는 값은 버리지 않는다.**

`FR-CBG-5` 는 **지어내기를 막는 손**이다. 재지 않은 단정에 붙으면 **안 읽기를
정당화하는 손**이 된다. 그 조항을 인용하는 주석은 그 *"모른다"* 가 **실측인지**를
함께 적어야 한다.

**D-M12-2 — 값이 있는데 안 읽는 것과, 값이 없는 것은 다르게 고친다.**

L8(omp 의 설명·힌트)과 L9(모델 고르기)는 **어댑터 안**의 결함이고, 둘 다 주석이
*"없다"* 또는 *"보통 하나다"* 라 단정한 자리였다. 그 단정이 **실측이 아니라 추정**
이었다.

그러므로 이 SRS 는 두 주석을 **실측한 문장으로 바꾼다** — 지우지 않는다. 다음 사람이
같은 값을 치르지 않도록, 무엇을 언제 어떻게 쟀는지가 그 자리에 남아야 한다.

**D-M12-3 — 못 고른 것은 비우고, 비운 것은 화면까지 간다.** (FR-M12-6·7)

`ContextWindow` 를 못 고를 때 **haiku 의 창으로라도 그리는 것**이 지금 동작이고
그것이 300% 를 낳았다. 대안 둘을 버렸다.

  고르지 않은 것 ①: 가장 큰 창을 고른다 — 우연히 맞을 뿐이고, 왜 맞는지 말할 수 없다
  고르지 않은 것 ②: 100 에서 자른다 — 거짓을 **보기 좋게** 만드는 일이다
  고른 것: 못 고르면 **창을 싣지 않고**, 화면은 토큰만 적는다 (`agent.ctx_unknown`)

`_setBar` 는 이미 100 에서 자르므로 **바는 종전에도 거짓말을 하지 않았다** — 글자만
넘쳤다. 그 비대칭이 이 결함을 오래 살렸다.

## 6. 검증

| ID | 층 | 무엇을 재는가 |
|---|---|---|
| **V-M12-1** | Go 단위 | claude 의 `tool_start` 가 **`Detail` 을 싣는다** — `Bash`→`command` · `Edit`→`file_path` · `Grep`→`pattern` (FR-M12-1) |
| **V-M12-2** | Go 단위 | 모르는 도구는 `Detail` 이 **입력 JSON** 이다 — 종전에 화면이 하던 마지막 갈래가 어댑터로 옮겨졌다 |
| **V-M12-3** | e2e (3판) | **codex·omp 의 도구 카드 머리에 인자가 선다** — 종전에는 도구 이름뿐이었다 (L2 의 RED) |
| **V-M12-4** | Go 단위 | claude 의 `Edit`·`Write` 가 `ToolEdit{File,Added,Removed}` 를 싣는다 · codex 의 `Changes` 는 **`File` 만** 싣고 줄은 비운다 (FR-M12-2) |
| **V-M12-5** | e2e | diff 가 **어댑터가 준 `edit`** 으로 그려진다 — 화면에 입력 파싱이 없다 |
| **V-M12-6** | Go 단위 | `run_in_background:true` 가 `Event.Background` 를 세운다 · codex·omp 는 **세우지 않는다** (FR-M12-3) |
| **V-M12-7** | Go 단위 | omp 의 명령 목록이 `description`·`ArgumentHint` 를 **싣는다** — §2.2 의 실측 프레임 그대로 (L8) |
| **V-M12-8** | e2e (omp) | omp 의 슬래시 드롭다운에 **설명과 인자 문법이 보인다** — claude 와 같은 모양 |
| **V-M12-9** | Go 단위 | claude 의 `/model`·`/config` 가 `Form` 을 단다 · 나머지 66개는 **달지 않는다** (FR-M12-4) |
| **V-M12-10** | Go 단위 | `CommandFormFill("config", <실측 응답>)` 이 키·선택지를 낸다 · 모양이 아니면 **빈 목록** |
| **V-M12-11** | e2e | 인자 없는 `/model` 이 폼을 열고, 고른 값이 **`/api/agent/control`** 로 나간다 — 프롬프트로 나가지 않는다 (L7 의 RED, **나가는 요청을 잰다**) |
| **V-M12-12** | e2e (codex) | codex 에는 `/model` 폼이 **서지 않는다** — 명령 목록이 비어 있다. 메뉴의 모델 고르기는 종전대로 선다 |
| **V-M12-13** | Go 단위 | `Controls.Cancel` 이 omp 만 참이다 (FR-M12-5) |
| **V-M12-14** | e2e (omp) | 질문 모달을 닫으면 **취소**가 나간다 — 거절이 아니다. claude 는 종전대로 거절이다 |
| **V-M12-15** | Go 단위 | **`modelUsage` 에 항목이 둘일 때 세션 모델의 것을 고른다** — §2.3 의 실측 프레임 그대로 (`window=1000000` · `model="claude-opus-5[1m]"`). **이것이 L9 의 RED 다** (FR-M12-6) |
| **V-M12-16** | Go 단위 | 키가 안 맞으면 `canonicalModel` 로 되짚는다 (`claude-opus-5`) |
| **V-M12-17** | Go 단위 | 둘 다 못 찾으면 `Model`·`ContextWindow` 를 **싣지 않는다** — 남의 창으로 그리지 않는다 |
| **V-M12-18** | web unit | 같은 모델에서는 **앞 턴의 창이 이어진다** (정상) · **모델이 바뀌고 새 창이 안 오면 옛 창을 버린다** · 새 창이 오면 임자가 그것으로 갈린다 (FR-M12-7) |
| **V-M12-19** | Go 단위 | `apiToolMessage` 가 에이전트 도구에 **`sess.Prompt` 로** 보낸다 (FR-M12-8) |
| **V-M12-20** | Go 단위 | 에이전트 도구인데 세션이 없으면 **오류다** — 200 이 아니다 |
| **V-M12-21** | Go 단위 | 엔벨로프 **바이트가 종전과 같다** — 터미널 경로와 에이전트 경로가 같은 것을 만든다 |
| **V-M12-22** | Go 단위 | `/api/tools/input` 도 **같은 문**을 지난다 — 손이 둘이면 한쪽만 고쳐진다 |
| **V-M12-23** | web unit | 캐럿 앞 토큰이 `/` 로 시작하면 목록이 선다 — 문장 중간도 (FR-M12-10) |
| **V-M12-24** | web unit | 고른 것이 **그 토큰만** 갈아 끼운다 — 앞뒤 글이 남는다 |
| **V-M12-25** | web unit | `src/foo` 처럼 **토큰 중간의 `/`** 는 목록을 세우지 않는다 |
| **V-M12-26** | e2e | 문장 중간의 `/` 로 고른 명령이 입력창의 문장을 **날리지 않는다** |

## 7. 갭

| 갭 | 왜 열어 두는가 |
|---|---|
| **`dmctl msg` 의 CLI 홉을 합쳐서 재지 않는다** | 두 반쪽을 따로 잰다 — `TestDmctlMsg_SendsToAndFrom`(dmctl → `/api/tools/message`)과 `V-M12-19~21`(그 종단 → `sess.Prompt`). 합친 경로를 e2e 로 재려면 셸이 붙은 터미널 탭에서 실제 바이너리를 돌려야 하고, 그것은 느리고 흔들리며 **두 반쪽이 이미 결정적으로 재어진 자리**에 덧붙는 것이 없다 |
| **codex 를 실측하지 않았다** | 이 기계에 설치돼 있지 않다. codex 에 대한 기술은 어댑터 소스와 그것이 근거로 삼은 JSON 스키마이며 **실측이 아니다**. `fakeagent` 의 codex 판이 재는 것은 *우리가 믿는 codex* 이지 codex 가 아니다 |
| **omp 의 편집 도구를 `ToolEdit` 으로 옮기지 않는다** | omp 의 `Arguments` 는 도구마다 모양이 다르고, 편집 도구가 무엇을 싣는지 재지 못했다(실측한 턴에서 도구 호출이 나오지 않았다). 재지 않은 형식을 파싱하면 **없는 변경을 그린다** (D-M11-4) |
| **omp 의 `model` 명령에 `Form` 을 달지 않는다** | 명령은 목록에 있으나(§2.2) 그 응답 형식을 재지 않았다. `Kind:"models"` 는 `status.models` 를 쓰므로 달 수 있어 보이지만, 고른 값을 **어떤 문자열로** 보내야 하는지가 omp 의 `provider/modelId` 규약과 얽힌다 — `control('set_model')` 이 이미 그 일을 하므로 **메뉴로 충분하다** |
| **`/config` 의 현재값을 여전히 되읽지 않는다** | `M11_SRS` §7 그대로 — 응답이 주는 것은 키와 선택지뿐이다 |
| **M11-B1 본체** | `M11_SRS` §2.4~2.4d — 재현하지 못했다 |
| **FR-STA-4 사다리 2단계 · M4 인증 계열** | 종전대로 의도적 보류·회피 |

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-16 | **접수 일곱 — FR-M12-16~22 (재기만 끝냈다).** 사용자가 GUI 로 쓰며 낸 것이다. **전부 원인을 확정했다**: ① 서브에이전트 카드에 도구가 **한 줄도 안 선다** — 서브에는 `tool_start` 가 오지 않고 도구가 `assistant` 스냅샷에만 실리는데 화면이 그 블록을 버린다(누수 L2 와 같은 부류, 그때 고친 것이 본 대화 경로뿐이었다) ② `Ctrl+B` 는 **대응 제어가 있다** — CLI 바이너리의 SDK 클라이언트에 `control_request{subtype:"background_tasks", tool_use_id}` 와 `stop_task{task_id}` 가 그대로 있다 ③ **bg 와 서브에이전트는 프로토콜이 한 개념으로 준다** (`task_type: local_bash|local_agent`) — 원본이 *"1 shell, 2 local agents"* 로 모아 적는 함수까지 있다 ④ **`/dongminal:migration` 이 검색되지 않는 것은 검색의 문제가 아니다** — 그 세션의 명령 68개에 아예 없고, `claudeProtoLaunch` 가 `--plugin-dir`·`--settings` 를 싣지 않기 때문이다(셸 래퍼만 붙인다) ⑤ `Cmd+Shift+좌우` 는 **애초에 구현되지 않았다** (`!e.shiftKey` 가 우리 손을 막고 `_moveCaret` 은 언제나 선택을 접는다). 덤으로 `get_context_usage{detail}` 제어를 찾았다(§7 갭). D-M12-4 |
| 2026-09-16 | **접수 넷 — FR-M12-11~15.** ① **컨텍스트 462% 는 결함이 둘이었다** — 창은 FR-M12-6 으로 이미 고쳐져 있었고(라이브 확인: 1000000) 분자가 따로 틀렸다. `result.usage` 는 **턴 안의 요청들을 합한 값**이며 §2.3 의 결론이 뒤집혔다(§2.3b — 잰 두 턴이 도구를 안 써 요청이 하나뿐이었다) ② **큐가 끊김보다 먼저 선다** — `interrupt` 의 응답은 *"프레임을 썼다"* 이지 *"턴이 끝났다"* 가 아니다. 사용자는 그것을 *새 프롬프트가 0초 만에 중단됐다* 로 읽었다 ③·④ 고르는 화면의 가독성·엔터와 도는 중 표시의 자리. **RED 를 보려고 흉내를 원본에 맞췄다** — fake 가 끊김의 `result` 를 같은 순간에 내어 검사가 초록이었다(§2-11). 계약이 바뀐 기존 검사 둘(`V-M11-65` 의 선택자 · `V-M9-39/40` 의 머리 계약)을 같은 변경에서 고쳤다 |
| 2026-09-16 | **구현 — FR-M12-1~10.** 어댑터가 `Detail`·`ToolEdit`·`Background` 를 싣고(claude 는 블록에, codex·omp 는 `tool_start` 에 — **입력이 드러나는 시점이 프로토콜마다 다르다**), 화면의 `agentDetail`·`_isBackground` 가 사라지고 `_mkDiff` 가 어댑터가 준 어휘만 그린다. `/model`·`/config` 는 `ProtoCommand.Form` 선언으로 서고, `/model` 은 메뉴와 **같은 손**(`control('set_model')`)으로 합쳐졌다. `dmctl msg`·`send-input` 은 **문 하나**(`deliverToTool`)를 지나 에이전트 세션으로 간다. `claudePickModelUsage` 가 세션 모델로 고른다. **프로브가 목록의 범위를 고쳤다**: L2 를 무력화하니 codex 만 떨어졌고 omp 는 통과했다 — omp 의 shell 이 마침 `command` 를 써서 **우연히 맞고 있었다**(§2.1b). **기존 검사 셋이 계약 변경으로 떨어져 같은 변경에서 고쳤다** (`V-M11-65` 는 화면 대신 나가는 요청을 재게, `V-M11-66` 계열은 흉내에 `config` 를 더해, `TestFake_PongTurn` 은 명령 수 대신 선언의 유무를 재게). **FR-M12-7 은 범위를 좁혔다** — 초안의 방어는 FR-M12-6 이 이미 막는 경우까지 덮었다 |
| 2026-09-16 | **초안.** 사용자가 과제 넷을 지정했고 둘째(어댑터 강화)가 본체다. **고치기 전에 세었다** — 사용자가 여섯을 지목했고 실제로는 **열둘**이었으며, 그중 지목된 하나(서브에이전트 묶기)는 이미 어댑터를 지나고 있었다. **실측이 가설 둘을 뒤집었다**: ① 300% 의 원인은 *"누적과 순간이 섞였다"* 가 아니다 — `result.usage` 는 턴별이고 분자는 옳다. 틀린 것은 **분모**이며, `modelUsage` 에 항목이 **둘**(haiku 200k · opus 1M)이고 사전순 첫 항목을 고르는 코드가 haiku 의 창을 집었다(주석은 *"보통 하나다"*). ② omp 의 명령 목록이 *"이름뿐"* 이라는 어댑터 주석이 **틀렸다** — 실측한 프레임이 `description`·`input.hint`·`subcommands`·`aliases` 를 전부 싣는다. **인계 자체가 결함 하나를 드러냈다**: `SendPaste` 가 `KindAgent` 에 `return nil` 이라 `dmctl msg` 가 *"전송 완료"* 를 내고 버린다 — 받는 쪽(`sess.Prompt`)은 이미 있고 부르는 곳이 없었다. D-M12-1·2·3 · FR-M12-1~10 · V-M12-1~26 |
