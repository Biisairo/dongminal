# SRS: 활동 상태 정확도 · 서브에이전트 활동 · 계정 한도 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **확인**: Go·JS 단위 시험, e2e(TC-ASV-1~15), gates·lint 가 통과했다(2026-11-10). Usage 바닥 개정(D-ASV-11)도 같은 날 같은 검사를 통과했다. TC-ASV-16(새 빌드에서 실제 세션 확인)은 하지 않은 채로 사용자가 완료를 정했다
> **개정 2026-11-11**: Usage 바닥을 스크롤 영역 밖으로 옮겼다(FR-ASV-40 · D-ASV-12 · TC-ASV-15). 이전 동작: 스크롤되는 패널 안의 sticky 바닥이 목록을 덮었다. 새 동작: 몸통만 스크롤되고 바닥은 그 아래에 고정된다
> **개정 2026-11-11 (2)**: 끝난 서브에이전트가 `working` 으로 남는 결함(C-10)을 고친다. 실측 2(§2.4)·FR-ASV-5·12·D-ASV-13·14·TC-ASV-17~19 를 더했다. 이전 동작: 서브에이전트가 끝나도 하위 카드가 `working` · `SubagentHandback` 으로 남아 main 이 끝날 때까지 지워지지 않았다. 새 동작: `SubagentHandback` 이 보이면 done 이 되고, 신호를 놓친 `working` 도 안전망이 지운다
> **입력**: 2026-11-10 대화. 사용자 요청 넷과 결정 셋이다.
> - 요청: ① 훅으로 만드는 상태가 자주 틀린다. 원인을 분석하고 고친다 ② Activity 아래에 사용량(usage)을 둔다. 지금은 Claude 만 ③ 서브에이전트도 main 카드처럼 상태·프롬프트·도구를 보인다 ④ 카드의 사용량 줄은 왼쪽에 모델·effort, 오른쪽에 사용량을 둔다
> - 결정: Esc 중단은 보완하지 않는다(D-ASV-1). usage 는 Claude 계정 한도(5시간·7일)다(D-ASV-2). 서브에이전트는 폴더형과 카드 안 목록을 둘 다 만들고 고르게 한다(D-ASV-3)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

Activity 패널의 에이전트 카드가 실제 Claude Code 세션과 다른 상태를 보이는 일이 잦다. 이 SRS 는 그 원인을 실측으로 밝히고 훅 해석을 고친다. 아울러 서브에이전트의 활동을 main 카드와 같은 수준으로 보이고, 패널 아래에 계정 한도를 보인다.

### 1.2 범위 (Scope)

- 묶음 H: claude 훅 해석과 배선 (`agentadapter`)
- 묶음 S: 서브에이전트 활동의 수신·저장·방송 (서버)
- 묶음 L: 계정 한도의 보관·응답 (서버)
- 묶음 V: Activity 패널 화면 — 서브에이전트 두 보기, 사용량 줄 배치, Usage 바닥 (클라이언트)

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **main 훅** | `agent_id` 가 없는 훅 입력. main 세션이 낸다 |
| **서브에이전트 훅** | `agent_id` 와 비어 있지 않은 `agent_type` 이 있는 훅 입력 |
| **내부 에이전트 훅** | `agent_id` 는 있고 `agent_type` 이 빈 훅 입력. 프롬프트 제안·`/btw` 같은 Claude Code 내부 에이전트가 낸다 (§2.2 ③) |
| **서브에이전트 활동** | 서브에이전트 훅에서 꺼낸 `{state, tool, detail, updatedAt}`. 도구와 `agentId` 로 찾는다 |
| **서브에이전트 항목** | 카드가 그리는 서브에이전트 하나. statusLine 값(SUBAGENT_USAGE_SRS)과 서브에이전트 활동을 `id = agentId` 로 합친 것 |
| **계정 한도** | statusLine 입력의 `rate_limits` 창들(`five_hour`·`seven_day` …). 창마다 `used_percentage` 와 `resets_at` 이 있다 |
| **폴더형 보기** | main 카드 아래에 서브에이전트마다 한 단계 들여 쓴 하위 카드를 두는 보기 |
| **목록형 보기** | main 카드 안에 서브에이전트마다 두 줄을 두는 보기 |

### 1.4 참고 (References)

- `SUBAGENT_USAGE_SRS.md` FR-SAU-* — subagentStatusLine 프록시와 서브에이전트 줄
- `ACTIVITY_CARD_USAGE_SRS.md` FR-ACU-* — 카드의 사용량 줄, `cardUsage`
- `ISSUE_AGENT_TREE_SRS.md` FR-SLP-* — statusLine 프록시와 허용 목록
- `ATTENTION_FIRING_SRS.md` FR-ATN-* — 활동에서 파생하는 알람
- Claude Code 문서 "Hooks reference" (https://code.claude.com/docs/en/hooks)

### 1.5 개요 (Overview)

§2 는 현황과 실측, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험이다.

## 2. 현황 (Identified Issue)

### 2.1 지금의 해석

`parseClaudeHook`(`agentadapter/claude.go`)은 훅 이름 하나로 상태를 정한다.

| 훅 | 지금 상태 |
|---|---|
| `PreToolUse`·`PostToolUse` | working (+도구) |
| `UserPromptSubmit` | working (+프롬프트) |
| `SubagentStop`·`PreCompact` | working |
| `Notification` | waiting (+메시지) |
| `Stop` | done |
| `SessionStart` | idle |
| `SessionEnd` | ended |

### 2.2 실측 (2026-11-10, Claude Code 2.1.322)

임시 `--settings` 파일로 훅 15종과 `subagentStatusLine` 의 입력을 기록만 하는 명령을 걸었다. 이 상태로 대화형 claude(haiku)를 띄우고 Explore 서브에이전트를 하나 부르게 했다. 사용자 설정은 건드리지 않았다.

| 시각(s) | 훅 | `agent_id` / `agent_type` | 비고 |
|---|---|---|---|
| 0.0 | UserPromptSubmit | - | |
| 3.8 | PreToolUse(Agent) | - | |
| 5.6 | SubagentStart | a922… / Explore | `description` 없음 |
| 5.6 | PostToolUse(Agent) | - | Agent 도구는 백그라운드로 곧 돌아왔다 |
| 6.8 | **Stop** | - | `background_tasks` 에 Explore 가 `running` |
| 8.3 | **SubagentStop** | a5b4… / **""** | 내부 에이전트 |
| 8.7~15.4 | PreToolUse·PostToolUse·PostToolBatch | a922… / Explore | **main 이 끝난 뒤** 서브에이전트의 도구 |
| 15.4 | UserPromptSubmit | - | `prompt` 가 `<agent-message from="a922…">` 로 시작한다 |
| 15.5 | SubagentStop | a922… / Explore | |
| 18.1 | Stop | - | `background_tasks` 빔 |
| 19.8 | **SubagentStop** | aa98… / **""** | 내부 에이전트 |
| 78.1 | **Notification** | - | `notification_type: idle_prompt`, "Claude is waiting for your input" |

그리고 다음을 확인했다.

- ① subagentStatusLine 의 `tasks[].id` 는 훅의 `agent_id` 와 **같다** (a92250a6023d34136).
- ② subagentStatusLine 의 `description` 은 SubagentStart 에 없는 작업 설명이다. 예: "Find parseClaudeHook definition file".
- ③ `agent_type` 이 빈 `SubagentStop` 이 **Stop 뒤 1.5초 안에** 온다. 매 턴 끝마다 왔다.
- ④ `idle_prompt` 알림은 Stop 뒤 약 60초에 온다.

### 2.3 원인

| # | 증상 | 원인 | 근거 |
|---|---|---|---|
| C-1 | 턴이 끝나도 카드가 `working` 에 멈춘다 | 내부 에이전트의 `SubagentStop` 을 working 으로 읽는다. 이 훅이 Stop 뒤에 와서 done 을 덮는다 | §2.2 ③ |
| C-2 | done 이 약 1분 뒤 `waiting` 으로 바뀐다 | `idle_prompt` 알림을 waiting 으로 읽는다 | §2.2 ④ |
| C-3 | main 이 쉬는데 `working` 이고, 내용에 서브에이전트의 도구가 보인다 | 서브에이전트 훅을 main 훅과 가르지 않는다 | §2.2 표 8.7~15.4 |
| C-4 | API 오류로 끝난 턴이 `working` 에 멈춘다 | 이 경우 Stop 대신 `StopFailure` 가 온다. 걸지 않았다 | 문서 |
| C-5 | 권한 요청이 약 6초 늦게 `waiting` 이 된다 | `waiting` 이 6초 뒤에 오는 `Notification(permission_prompt)` 에만 걸렸다. 바로 오는 `PermissionRequest` 를 걸지 않았다 | 문서 |
| C-6 | 실패한 도구 뒤에도 내용이 앞 도구로 남는다 | `PostToolUseFailure` 를 걸지 않았다 | 문서 |
| C-7 | 압축 중이나 압축 뒤에 상태가 틀린다 | `SessionStart(source=compact)` 를 idle 로 읽는다. 수동 `/compact` 는 PreCompact 로 working 이 된 뒤 끝을 알리는 훅이 없다 | 문서. 실측하지 않았다 (R-2) |
| C-8 | 백그라운드 서브에이전트의 보고가 사용자 턴으로 읽혀 done 알람이 한 번 더 운다 | 보고 프롬프트가 `<agent-message` 로 시작하는데, 배경 표식 목록에 없다 | §2.2 15.4s |
| C-9 | Esc 로 중단하면 `working` 에 멈춘다 | 사용자 중단에는 어떤 훅도 오지 않는다 | 문서. 보완하지 않는다 (D-ASV-1) |
| C-10 | 끝난 서브에이전트가 하위 카드에 `working` · `SubagentHandback` 으로 남고 지워지지 않는다 | 끝의 `PostToolUse(SubagentHandback)`(working)와 두 번째 `SubagentStop`(done)이 약 30ms 차이로 온다. 둘은 서로 다른 `dmctl activity` 프로세스가 보내므로 서버에 닿는 순서가 바뀔 수 있고, 바뀌면 done 이 working 으로 덮인다. `working` 에는 지우는 기한이 없다 | §2.4 |

### 2.4 실측 2 (2026-11-11, Claude Code 2.1.322)

사용자 보고: 일을 마친 서브에이전트가 Activity 에서 사라지지 않는다. 그 순간 서버에는 끝난 web-fetch 6개가 30분 넘게 `working` · `SubagentHandback` 으로 남아 있었다. 같은 세션에서 다시 돌리자 백그라운드 Explore 는 done 이 되고 포그라운드 web-fetch 는 `working` 에 남았다.

임시 `--settings` 파일로 훅 9종의 이름·`agent_id`·`agent_type`·도구 이름만 기록하게 하고, `claude -p`(haiku)로 포그라운드 Explore 하나와 백그라운드 Explore 하나를 부르게 했다. 공용 훅 설정은 건드리지 않았다. 두 서브에이전트 모두 끝이 아래 순서였다.

| 시각(s) | 훅 | 서브에이전트 상태 (종전 해석) |
|---|---|---|
| 0.00 | `SubagentStop` | done |
| 1.41 | `PreToolUse(SubagentHandback)` | working |
| 2.02 | `PostToolUse(SubagentHandback)` | working |
| 2.05 | `SubagentStop` (두 번째) | done |

그리고 다음을 확인했다.

- ⑤ 서브에이전트는 `SubagentHandback` 으로 보고를 넘기고 끝난다. `SubagentStop` 은 그 앞뒤로 두 번 온다.
- ⑥ 끝의 두 훅은 약 30ms 차이다. 포그라운드와 백그라운드가 같다. 그래서 C-10 은 실행 방식이 아니라 도착 순서의 문제다.
- ⑦ main 의 `PostToolUse(Agent)` 응답(`tool_response`)에 `agentId` 가 실린다. 이 SRS 는 쓰지 않는다.

서버에 닿은 순서는 재지 않았다. 남은 항목의 마지막 도구가 모두 `SubagentHandback` 인 것이 순서 역전의 근거다.

## 3. 요구 (Requirements)

### 3.1 묶음 H — 훅 해석과 배선

- **FR-ASV-1** claude 활동 훅 배선(`claudeHookEvents`)에 `PermissionRequest`·`PostToolUseFailure`·`SubagentStart`·`StopFailure`·`PostCompact` 를 더한다. 맥락 훅(`ctx-hook`)의 배선은 바꾸지 않는다.
- **FR-ASV-2** 훅 보고(`Report`)는 `AgentID`·`AgentType` 을 싣는다. `dmctl activity` 는 `AgentID` 가 있으면 `agentId`·`agentType` 을 활동 보고 본문에 더한다.
- **FR-ASV-3** 내부 에이전트 훅(`agent_id` 있음, `agent_type` 빔)은 **어느 상태도 바꾸지 않는다**. `dmctl activity` 는 이 훅을 보고하지 않는다. (C-1)
- **FR-ASV-4** main 훅의 해석은 아래 표를 따른다. 표에 없는 훅과 표에서 "무시" 인 경우는 보고하지 않는다.

  | 훅 | 조건 | 상태 | tool | detail |
  |---|---|---|---|---|
  | `UserPromptSubmit` | | working | | 프롬프트 |
  | `PreToolUse`·`PostToolUse` | | working | 도구 이름 | 도구 인자 (종전 규칙) |
  | `PostToolUseFailure` | | working | 도구 이름 | 도구 인자 |
  | `PermissionRequest` | | waiting | 도구 이름 | 도구 인자 |
  | `Notification` | `notification_type` 이 `permission_prompt`·`elicitation_dialog`·`elicitation_url_dialog`·`agent_needs_input` | waiting | | 메시지 |
  | `Notification` | 그 밖(`idle_prompt` 포함)과 `notification_type` 없음 | 무시 | | |
  | `SubagentStart`·`SubagentStop` | | 무시 (서브에이전트 활동으로만 간다) | | |
  | `PreCompact` | | working | | |
  | `PostCompact` | `trigger` 가 `manual` | idle | | |
  | `PostCompact` | 그 밖 | 무시 | | |
  | `Stop` | | done | | |
  | `StopFailure` | | done | | `error` 값 (예: `rate_limit`) |
  | `SessionStart` | `source` 가 `compact` | 무시 | | |
  | `SessionStart` | 그 밖 | idle | | `source` |
  | `SessionEnd` | | ended | | |

- **FR-ASV-5** 서브에이전트 훅의 해석은 아래 표를 따른다. 결과는 **서브에이전트 활동**이며 main 의 상태·알람·턴 표시를 건드리지 않는다. 단 `PermissionRequest`·`Notification` 은 main 해석(FR-ASV-4)도 함께 한다 — 사람을 기다리게 하는 것은 세션 전체의 일이다. 그래서 `dmctl activity` 는 이 두 훅을 main 보고와 서브에이전트 보고로 두 번 보낸다.

  | 훅 | 서브에이전트 상태 | tool | detail |
  |---|---|---|---|
  | `SubagentStart` | working | | |
  | `PreToolUse`·`PostToolUse`·`PostToolUseFailure` | working | 도구 이름 | 도구 인자 |
  | `PermissionRequest` · `Notification`(FR-ASV-4 의 waiting 조건) | waiting | 도구 이름 / 없음 | 도구 인자 / 메시지 |
  | `PreToolUse`·`PostToolUse`·`PostToolUseFailure` 중 도구가 `SubagentHandback` | done | 도구 이름 | |
  | `SubagentStop` | done | | |
  | 그 밖 | 무시 | | |

  `SubagentHandback` 행은 일반 도구 행보다 앞선다 (C-10, D-ASV-13).

- **FR-ASV-6** 배경 프롬프트 표식(`backgroundPromptMarks`)에 `<agent-message` 를 더한다. (C-8)
- **FR-ASV-7** `dmctl activity` 는 무엇을 하든 0 으로 끝나고 stdout 에 아무것도 쓰지 않는다 (종전 NFR-AAP-5). `PermissionRequest` 훅이 출력하지 않으면 권한 흐름은 바뀌지 않는다 (Claude Code 문서).

### 3.2 묶음 S — 서브에이전트 활동 (서버)

- **FR-ASV-10** `POST /api/tools/activity/set` 은 `agentId` 가 있으면 그 본문을 서브에이전트 활동으로 저장한다. 이때 main 활동·알람·턴 표시는 바꾸지 않는다. `agentType` 은 문자열 그대로 저장하고, `tool`·`detail` 은 main 과 같은 규칙으로 다듬는다(`SanitizeActivityField`). 상태가 `working`·`waiting`·`done` 이 아니면 400 이다.
- **FR-ASV-11** 서브에이전트 활동은 메모리에만 두고, 도구마다 최대 `subagentMaxTasks`(32)개다. 넘으면 `updatedAt` 이 가장 오래된 것을 버린다.
- **FR-ASV-12** 서브에이전트 활동은 아래에서 지운다.
  - 상태가 `done` 이 된 지 `subagentDoneKeepMs`(30,000ms)가 지났을 때
  - 그 도구의 main 활동이 `ended` 가 됐을 때
  - 도구가 살아 있지 않아 사용량과 같은 수거 주기가 돌 때
  - 아래가 모두 참일 때 (안전망, C-10, D-ASV-14)
    - 상태가 `done` 이 아니다
    - 마지막 갱신에서 `subagentStaleKeepMs`(120,000ms)가 지났다
    - 그 도구의 main 활동이 `working`·`waiting` 이 아니다
    - 신선한 statusLine 목록(FR-SAU-13)에 그 서브에이전트가 `running` 으로 없다
- **FR-ASV-13** 서브에이전트 활동이 바뀌면 SSE `tool_subagent_activity` 를 방송한다. 본문은 `{toolId, agentId, agentType, state, tool, detail}` 이다. 지울 때는 방송하지 않는다 (다음 조회가 반영한다).
- **FR-ASV-14** `GET /api/tools/activity` 항목의 `subagents`(FR-SAU-13)는 아래 합집합이다. 순서는 FR-SAU-14 를 따르고, statusLine 값이 없는 원소는 끝에 `updatedAt` 순으로 둔다.
  - 신선한 statusLine 목록의 원소
  - 지워지지 않은 서브에이전트 활동 중 그 목록에 `id` 가 없는 것
- **FR-ASV-15** `subagents` 원소에 아래 필드를 더한다. 값이 없으면 싣지 않는다.

  | 필드 | 출처 |
  |---|---|
  | `state` | 서브에이전트 활동이 있으면 그 상태. 없으면 statusLine `status` 가 `running` 이면 `working`, 그 밖이면 `done` |
  | `tool`·`detail` | 서브에이전트 활동 |
  | `description` | statusLine `tasks[].description`. `SanitizeActivityField` 로 다듬고 `ActivityDetailMax` 로 자른다 |
  | `agentType` | statusLine 값이 없으면 서브에이전트 활동의 값 |

- **FR-ASV-16** statusLine 허용 목록(FR-SAU-2)에 `description` 을 더한다. `label`·`name`·`cwd`·`tokenSamples` 는 여전히 싣지 않는다. (D-SAU-3 을 바꾼다 — D-ASV-4)

### 3.3 묶음 L — 계정 한도 (서버)

- **FR-ASV-20** 서버는 statusLine 보고(`POST /api/tools/usage`)에 `rateLimits` 가 비어 있지 않으면, 그 값과 받은 시각을 **에이전트별 마지막 한도**로 덮어쓴다. 지금 에이전트는 `claude` 하나다. 이 값은 도구가 죽어도 지우지 않는다. 메모리에만 두며 서버를 다시 띄우면 비어 있다.
- **FR-ASV-21** `GET /api/tools/activity` 응답에 최상위 `limits` 배열을 더한다. 마지막 한도가 없으면 빈 배열이다. 원소는 아래와 같다.

  ```json
  {"agent":"claude","observedAt":1794291091000,
   "windows":[{"name":"five_hour","usedPct":34,"resetsAt":1794298291,"resetsInSec":7200,"level":""},
              {"name":"seven_day","usedPct":21,"resetsAt":1794659091,"resetsInSec":368000,"level":""}]}
  ```

  - `windows` 는 `five_hour`·`seven_day` 를 이 순서로 앞에 두고, 나머지 이름은 사전 순으로 뒤에 둔다.
  - `usedPct`·`resetsAt` 은 입력 그대로다. 없으면 싣지 않는다. `resetsAt` 은 유닉스 초다. 값이 `1e12` 를 넘으면 밀리초로 보고 1,000 으로 나눈다 (R-4).
  - `resetsInSec` 는 초기화까지 남은 시간(초)이다. **응답을 만드는 시각에 서버가 셈한다**: `max(0, resetsAt - 서버 지금)`. `resetsAt` 이 없으면 싣지 않는다. 브라우저 시계는 서버와 다를 수 있으므로(원격 접속) 남은 시간은 서버의 셈만 쓴다 (D-ASV-10).
  - `dmctl status --json` 도 같은 `limits` 를 최상위에 싣는다. 사람용 출력은 창마다 `5h 34% (resets in 2h 0m)` 꼴의 한 줄이다.
  - `level` 은 `usedPct` 가 `limitWarnPct`(70) 이상이면 `warn`, `limitCriticalPct`(90) 이상이면 `critical`, 그 밖이면 빈 글자다. 두 상수는 서버 한 곳에 둔다.

### 3.4 묶음 V — 화면 (클라이언트)

**사용량 줄 배치 (요청 ④)**

- **FR-ASV-30** main 카드의 사용량 줄(FR-ACU-10)은 왼쪽에 모델·effort, 오른쪽 끝에 막대와 `NN%` 를 둔다. 폭이 모자라면 모델·effort 만 말줄임으로 준다. 서브에이전트의 사용량 줄도 같다.

**서브에이전트 보기 (요청 ③)**

- **FR-ASV-31** 서브에이전트 하나가 보이는 값은 아래다. 값이 없는 부분은 원소도 없다.
  - 머리: `agentType`(없으면 `agent`), 상태 표시(main 카드와 같은 아이콘·색), `· 도구`
  - 내용: `detail` 이 있으면 그것, 없으면 `description`
  - 사용량 줄(FR-ASV-30): 모델(앞의 `claude-` 를 뗀다)·effort, 막대와 `NN%`
  - 툴팁(영어): FR-SAU-23 의 값에 `description` 을 더한다
- **FR-ASV-32** 보기는 두 가지다. Activity 패널 머리의 전환 버튼으로 바꾼다. 고른 값은 브라우저 저장소(`PrefStore.local`)에 남고 기본은 폴더형이다.
- **FR-ASV-33** **폴더형 보기**: main 카드 바로 아래에 서브에이전트마다 하위 카드를 둔다. 하위 카드는 한 단계 들여 쓰고 FR-ASV-31 의 세 부분을 모두 보인다. 서브에이전트가 있는 main 카드에는 접기 버튼과 서브에이전트 수가 선다. 접으면 하위 카드가 숨는다. 접힘은 도구 id 별로 브라우저 저장소에 남는다. 하위 카드를 누르면 main 카드를 누른 것과 같다(`jumpToTool`). 하위 카드는 끌어 옮기지 않는다.
- **FR-ASV-34** **목록형 보기**: main 카드 안의 사용량 줄 아래에 서브에이전트마다 두 줄을 둔다. 첫 줄은 `↳`·머리, 둘째 줄은 사용량 줄이다. 내용(`detail`/`description`)은 툴팁으로만 보인다.
- **FR-ASV-35** 두 보기 모두 상태가 `done` 인 서브에이전트를 흐리게 그린다.
- **FR-ASV-36** SSE `tool_subagent_activity` 를 받으면 그 도구 항목의 `subagents` 에서 `id = agentId` 인 원소의 `state`·`tool`·`detail` 을 바꾸고 다시 그린다. 원소가 없으면 `{id, agentType, state, tool, detail}` 로 끝에 더한다. main 항목이 없으면 버린다.
- **FR-ASV-37** 재조정 근거(`sig`)에 서브에이전트마다 그려지는 값 전부를 넣는다. FR-SAU-24 의 값에 `state`·`tool`·내용 글자·보기 종류·접힘을 더한다.

**Usage 바닥 (요청 ②, 2026-11-10 개정)**

> 개정 이유: 초판은 Usage 를 네 번째 접는 구역으로 두고 창 이름을 `5h`·`7d` 로 줄였다. 사용자가 두 가지를 바꾸라고 했다 — ① 구역이 아니라 **패널 맨 아래에 붙은 바닥**으로 둔다 ② 이름과 막대를 다른 사용량 도구처럼 보인다. 참고한 것은 Claude Code `/usage`(창마다 "Current session"·"Current week (all models)", 막대, "% used", 초기화 시각)와 CodexBar(세션·주간 막대와 초기화까지 남은 시간)다.

- **FR-ASV-40** (개정 2026-11-11, D-ASV-12) Usage 는 구역 목록(`ACTIVITY_SECTIONS`)에 넣지 않는다. 패널은 **스크롤 몸통(`#agents-body`)과 고정 바닥(`#agents-foot`)** 두 칸이다. 머리와 구역 목록은 몸통에 그리고, Usage 바닥(`.act-usage-foot`) 하나는 고정 바닥에 그린다. 바닥은 스크롤 영역 밖이다 — 몸통이 남은 높이 안에서만 스크롤되고, 바닥은 목록을 덮지 않는다. 접지 않는다.
- **FR-ASV-41** 바닥은 `limits` 원소마다 머리 한 줄(에이전트 이름)과, 창마다 블록 하나를 둔다. 창 블록은 두 줄이다.
  - 첫 줄: 왼쪽에 창 이름, 오른쪽에 `NN% used`
  - 둘째 줄: 패널 폭을 채우는 둥근 막대(트랙과 채움). 그 아래에 `Resets in 2h 10m`
  - 창 이름(i18n): `five_hour` → "Current session"/"현재 세션", `seven_day` → "Current week"/"이번 주", `seven_day_opus` → "Current week (Opus)"/"이번 주 (Opus)", `seven_day_sonnet` → "Current week (Sonnet)"/"이번 주 (Sonnet)". 그 밖의 이름은 `_` 를 빈칸으로 바꾸고 첫 글자를 대문자로 쓴다.
  - 남은 시간은 서버가 준 `resetsInSec` 다 (FR-ASV-21). 일·시간·분 중 큰 단위 둘만 쓴다 — en `4d 6h`·`2h 10m`·`35m`, ko `4일 6시간`·`2시간 10분`·`35분`. 0 이면 "Resets soon"/"곧 초기화" 이고, 필드가 없으면 그 줄을 그리지 않는다.
  - 막대 색은 `level` 을 따른다(FR-ACU-13 의 토큰 재사용). 등급이 없으면 강조색이다.
  - 창 블록의 툴팁(영어)은 초기화 시각을 브라우저 지역 시간으로 보인다. 예: `Current session · 34% used · resets at 16:40`.
- **FR-ASV-42** 머리 줄의 오른쪽에 `observedAt` 이 `limitStaleMs`(600,000ms)보다 오래되면 "as of HH:MM"/"HH:MM 기준" 을 보인다.
- **FR-ASV-43** `limits` 가 비었으면 바닥을 그리지 않는다.
- **FR-ASV-44** 남은 시간 글자는 활동 조회 주기(`agentsPollMs`)마다 받은 응답으로 바뀐다. 새 타이머를 만들지 않는다.

### 3.5 비기능

- **NFR-ASV-1** 훅 하나에 대한 `dmctl activity` 의 HTTP 요청은 종전처럼 최대 한 번이다. 예외는 서브에이전트의 `PermissionRequest`·`Notification`(FR-ASV-5)이며 최대 두 번이다. 각 요청은 종전 시한(`hookBudget`)을 지킨다.
- **NFR-ASV-2** 새 조회 주기를 만들지 않는다. 새 SSE 이벤트는 `tool_subagent_activity` 하나다.
- **NFR-ASV-3** 하위 카드와 Usage 바닥은 패널 최소 폭에서 패널 폭을 넘지 않는다. 넘치면 글자 부분만 말줄임으로 준다.
- **NFR-ASV-4** 툴팁은 영어, 화면 문구는 i18n 키로 둔다(기존 규약).
- **NFR-ASV-5** 서브에이전트의 `detail`·`description` 은 main 의 `detail` 과 같은 상한과 제어 문자 제거를 거친다.

## 4. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-ASV-1 | Esc 중단(C-9)은 보완하지 않는다. 다음 프롬프트가 상태를 바로잡는다 | 사용자가 골랐다. 알려 주는 훅이 없어서 어떤 보완도 추정이 된다 |
| D-ASV-2 | Usage 는 statusLine 의 `rate_limits` 로 Claude 계정 한도(5시간·7일)를 보인다 | 사용자가 골랐다. 구독 OAuth 토큰으로 사용량 API 를 직접 부르는 길은 사내 규정(구독 계정을 자동화에 연결 금지)에 걸려 쓰지 않는다 |
| D-ASV-3 | 서브에이전트는 폴더형과 목록형을 둘 다 만들고, 패널 머리의 버튼으로 고른다. 기본은 폴더형이다 | 사용자가 둘 다 원했다. 보는 방식은 워크스페이스가 아니라 브라우저의 것이다 (FR-AGG-10 과 같은 근거) |
| D-ASV-4 | statusLine 의 `description` 을 싣는다 (D-SAU-3 을 바꾼다) | 사용자가 서브에이전트의 프롬프트를 보기를 원했다. main 카드는 이미 사용자 프롬프트(자유 글)를 `detail` 로 싣는다. 같은 상한·다듬기를 거친다 |
| D-ASV-5 | 서브에이전트 활동은 기존 `/api/tools/activity/set` 에 `agentId` 를 실어 보낸다. 새 종단을 만들지 않는다 | 훅 하나가 요청 하나다. 도구 식별·다듬기·시한을 그대로 쓴다 |
| D-ASV-6 | 서브에이전트 활동의 갱신은 새 SSE 이벤트로 보낸다. `tool_activity` 에 섞지 않는다 | `tool_activity` 의 수신 쪽은 main 상태를 덮어쓴다. 섞으면 C-3 이 화면에서 되살아난다 |
| D-ASV-7 | `idle_prompt` 와 그 밖의 알림은 상태를 바꾸지 않는다 | `idle_prompt` 는 "응답이 끝난 지 60초" 다. 카드는 이미 done 이다 (§2.2 ④). 나머지(`auth_success` 등)는 기다림이 아니다 |
| D-ASV-8 | `Stop` 은 `background_tasks` 가 있어도 done 이다 | main 턴은 끝났고 사람이 입력할 수 있다. 돌고 있는 서브에이전트는 하위 카드가 보인다 |
| D-ASV-9 | 계정 한도의 경고 경계는 70%·90% 이고 서버가 등급을 정한다 | 맥락 등급(FR-ACU-3)과 같은 방식으로, 화면에 경계값을 두지 않는다 |
| D-ASV-11 | Usage 는 접는 구역이 아니라 패널 맨 아래에 붙은 바닥이다. 창 이름은 Claude Code `/usage` 의 이름을 따른다 | 사용자가 요청했다(2026-11-10). 한도는 늘 보이는 값이라 접을 까닭이 없고, `5h`·`7d` 같은 축약은 읽기 나쁘다 |
| D-ASV-12 | Usage 바닥은 스크롤 영역 밖에 둔다 | 사용자가 요청했다(2026-11-11): "사용률 창은 스크롤 밖이고 남은 공간에서 스크롤이 되어야지". 종전(D-ASV-11)의 `position:sticky` 바닥은 스크롤 영역 안에 겹쳐 목록을 덮었고, 스크롤바도 바닥 뒤까지 내려갔다 |
| D-ASV-13 | `SubagentHandback` 도구 훅은 done 이다 | 이 도구는 서브에이전트의 마지막 일이다(§2.4 ⑤). 끝에 오는 훅이 모두 done 이 되므로 도착 순서가 바뀌어도 결과가 같다. 보고 시각으로 순서를 바로잡는 길은 보고 형식과 데몬까지 바꾸고, 프로세스 시작 시각도 30ms 안에서 뒤집힐 수 있어 고르지 않았다 |
| D-ASV-14 | 놓친 신호는 안전망이 지운다. 조건은 main 이 쉬고, statusLine 이 돌고 있다고 하지 않고, 2분간 갱신이 없는 것이다 | 하네스가 끝내는 방식을 또 바꾸면 D-ASV-13 만으로는 다시 남는다. 포그라운드 서브에이전트가 도는 동안 main 은 `working` 이고, 백그라운드 서브에이전트는 statusLine 이 `running` 으로 알린다. 그래서 도는 서브에이전트는 지우지 않는다 |
| D-ASV-10 | 초기화까지 남은 시간은 서버가 셈해 `resetsInSec` 로 내려 준다 | 사용자가 요청했다. 원격 브라우저의 시계가 서버와 다르면 브라우저의 셈은 틀린다. `dmctl status` 도 같은 값을 보인다 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-ASV-1 | FR-ASV-1 | Go: claude 설치 설정 | 다섯 훅이 활동 훅으로 걸리고, 맥락 훅 배선은 그대로다 |
| TC-ASV-2 | FR-ASV-2·3·4 | Go: §2.2 실측 입력을 본뜬 main 훅 표 전부 | 표대로 상태·tool·detail 이 나온다. "무시" 는 보고가 없다. 내부 에이전트 `SubagentStop` 은 보고가 없다 |
| TC-ASV-3 | FR-ASV-5 | Go: 서브에이전트 훅 표 전부 | 서브에이전트 보고가 `AgentID`·`AgentType` 과 함께 나온다. `PermissionRequest`·waiting 알림은 main 보고도 나온다 |
| TC-ASV-4 | FR-ASV-6 | Go: `<agent-message from=…>` 프롬프트 | `UserPrompt` 가 거짓이다 |
| TC-ASV-5 | FR-ASV-2·7, NFR-ASV-1 | Go: 시험 서버로 `dmctl activity` 실행 | 본문에 `agentId`·`agentType` 이 실린다. 두 번 보내는 경우만 요청이 둘이다. stdout 이 비고 종료 코드가 0 이다 |
| TC-ASV-6 | §2.2 순서 재연 | Go: §2.2 표의 훅 순서를 서버에 차례로 보고 | main 상태의 마지막 값이 done 이다(C-1·C-2·C-3 재발 없음). 서브에이전트 활동이 working→done 이 된다 |
| TC-ASV-7 | FR-ASV-10·11·12 | Go: 서브에이전트 보고 / 33개 / done 후 시각 경과 / main ended / 수거 | main 활동이 그대로다 / 32개다 / 지워진다 / 지워진다 / 지워진다 |
| TC-ASV-8 | FR-ASV-13 | Go: 서브에이전트 보고 | `tool_subagent_activity` 가 정해진 본문으로 방송된다. `tool_activity` 는 방송되지 않는다 |
| TC-ASV-9 | FR-ASV-14·15·16 | Go: statusLine 목록과 활동을 겹치게·따로 보고 | 합집합이 정해진 순서로 나오고, `state` 우선순위와 `description` 이 맞다 |
| TC-ASV-10 | FR-ASV-20·21 | Go: 한도 보고 → 도구 수거 → 조회 / 이름 순서 / 경계값 69·70·89·90 / 서버 시각을 고정하고 `resetsAt` 을 초·밀리초·지난 시각으로 / `dmctl status` | 값이 남는다 / `five_hour`·`seven_day` 가 앞이다 / 등급이 맞다 / `resetsInSec` 가 맞고 지난 시각은 0 이다 / `limits` 와 사람용 한 줄이 나온다. 보고가 없으면 `limits` 가 빈 배열이다 |
| TC-ASV-11 | FR-ASV-30·31·34·35 | JS 단위: 카드·목록형 줄 조합 | 모델·effort 가 막대보다 앞이다. 값 없는 부분은 원소가 없다. done 흐림이 붙는다 |
| TC-ASV-12 | FR-ASV-32·33 | JS 단위: 보기 전환·접기 | 폴더형은 하위 카드 항목이 main 카드 뒤에 서고, 접으면 없다. 목록형은 카드 안에 선다. 설정이 저장소에 남는다 |
| TC-ASV-13 | FR-ASV-36·37 | JS 단위: SSE 로 기존·새 서브에이전트 갱신, main 없음 | 바뀐다 / 더해진다 / 버린다. `sig` 가 그려지는 값의 변화에만 바뀐다 |
| TC-ASV-14 | FR-ASV-41·42·43 | JS 단위: `resetsInSec` 368000·7800·2100·0·없음, 창 이름 넷과 모르는 이름, 오래된 관측, 빈 목록 | `4d 6h`·`2h 10m`·`35m`·soon·남은 시간 줄 없음 / 정해진 이름 / `as of` 가 선다 / 바닥이 없다 |
| TC-ASV-15 | FR-ASV-33·40, NFR-ASV-3 | e2e: 서브에이전트와 한도를 보고한 뒤 패널을 최소 폭으로 | 하위 카드가 보이고 보기 전환이 동작한다. Usage 바닥이 패널 아랫변에 붙는다. (개정 2026-11-11) 바닥은 스크롤 몸통 밖이고, 몸통의 아랫변이 바닥의 윗변과 같다 — 목록이 길어 스크롤해도 바닥과 겹치지 않는다. 패널 폭을 넘지 않는다 |
| TC-ASV-16 | 전체 | 수동: 새로 빌드하고 데몬을 다시 띄운 뒤, dongminal 의 claude 세션에서 서브에이전트를 부름 | 턴이 끝나면 카드가 done 으로 남고 1분 뒤에도 waiting 이 되지 않는다. 하위 카드가 working→done 으로 바뀐다. Usage 바닥에 현재 세션·이번 주가 보인다 |

| TC-ASV-17 | FR-ASV-5 | Go: `SubagentHandback` 의 `PreToolUse`·`PostToolUse`·`PostToolUseFailure` 서브에이전트 훅 | 서브에이전트 보고가 done 이고 tool 이 `SubagentHandback` 이다. main 보고는 없다 |
| TC-ASV-18 | §2.4 순서 재연, C-10 | Go: §2.4 의 끝 순서를 그대로, 그리고 마지막 두 훅을 뒤바꿔 서버에 보고 | 두 경우 모두 서브에이전트 활동이 done 이다 |
| TC-ASV-19 | FR-ASV-12 안전망 | Go: working 활동을 두고 시각·main 상태·statusLine 을 바꿔 조회 | 120초가 지나고 main 이 done 이며 statusLine 에 `running` 이 없을 때만 지워진다. 120초 전 / main working·waiting / statusLine `running` 중 하나라도 맞으면 남는다. done 활동은 이 규칙과 무관하다 |

## 6. 비목표 (Non-goals)

- Esc 중단의 감지 (D-ASV-1). 중단한 뒤 다음 프롬프트까지 카드는 `working` 이다
- 권한을 승인한 뒤 도구가 끝날 때까지의 상태. `PostToolUse` 가 올 때까지 `waiting` 으로 남는다 — 승인을 알리는 훅이 없다
- Claude 외 에이전트(codex 등)의 계정 한도와 서브에이전트
- 구독 OAuth 토큰으로 사용량 API 를 부르는 일 (D-ASV-2)
- 계정 한도의 영속 저장. 서버를 다시 띄우면 다음 statusLine 보고까지 비어 있다
- 하위 카드의 끌어 옮기기와 서브에이전트별 점프
- `PostToolBatch`·`TaskCreated`·`TaskCompleted` 등 상태에 쓰지 않는 훅의 배선

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 훅 배선이 데몬 지문에 들어가 데몬을 다시 띄워야 적용된다. 재시작하면 터미널 세션이 끊긴다 | MEDIUM | 구현 뒤 사용자에게 알리고 재시작은 사용자가 정한다. 이미 떠 있는 claude 세션은 다시 띄워야 새 훅을 받는다 |
| R-2 | `PostCompact.trigger`·`SessionStart(compact)` 의 동작을 실측하지 않았다 | LOW | 문서대로 구현하고 TC-ASV-16 에서 `/compact` 로 확인한다. 틀려도 다음 훅이 바로잡는다 |
| R-3 | 서브에이전트의 `Notification` 에 `agent_id` 가 실리는지 실측하지 않았다 | LOW | 실리지 않으면 main 해석만 일어난다. 종전과 같다 |
| R-4 | `resets_at` 의 단위(초)를 실측 입력으로 확인하지 않았다 | LOW | 값이 `1e12` 를 넘으면 밀리초로 보고 나눈다. TC-ASV-16 에서 확인한다 |
| R-5 | 내부 에이전트를 "`agent_type` 이 빈 것" 으로 가르는 것은 문서와 실측에 기댄 판정이다 | MEDIUM | 판마다 바뀌면 C-1 이 되살아난다. 판정을 함수 하나에 두고 시험(TC-ASV-2)으로 고정한다 |
| R-6 | `PermissionRequest` 로 waiting 알람이 종전보다 약 6초 빨리 운다 | LOW | 동작 변경으로 기록한다. 같은 대기의 되풀이는 FR-ATN-15 가 막는다 |
| R-7 | 안전망이 도는 백그라운드 서브에이전트를 지울 수 있다. statusLine 보고가 끊기고(15초 넘게) 한 도구가 2분 넘게 돌 때다 | LOW | 지워도 그 서브에이전트의 다음 훅이 활동을 다시 만든다. 화면에서 잠깐 사라질 뿐이다 |
| R-8 | 고친 해석은 `dmctl` 에 있다. 새 빌드의 `dmctl` 이 깔려야 적용된다 | LOW | 구현 뒤 적용 절차를 사용자에게 알린다. 안전망은 서버에 있어 서버만 새로 띄워도 동작한다 |
