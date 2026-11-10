# SRS: 서브에이전트 사용량 — subagentStatusLine 프록시와 Activity 카드 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **확인**: Go·JS 단위 시험과 e2e(TC-SAU-1~9)가 통과했다(2026-11-09). TC-SAU-10(새 빌드에서 실제 세션 확인)은 데몬 재시작 뒤 사용자 확인이 남았다
> **입력**: 2026-11-09 대화. 사용자 결정 둘 — ① 서브에이전트의 모델·effort·맥락 사용량을 statusLine 경로로 가져온다 ② Activity 에이전트 카드 안에 서브에이전트마다 한 줄을 그리고, 끝난 것은 Claude Code 가 지울 때까지 흐리게 보인다 (D-SAU-1)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

Claude Code 의 화면은 main 세션의 모델·effort·맥락만 보인다. 서브에이전트의 값은 보이지 않는다. Claude Code 는 이 값을 `subagentStatusLine` 명령의 입력으로 넘긴다. 이 SRS 는 그 입력을 dongminal 서버에 남기고, Activity 에이전트 카드에 서브에이전트마다 한 줄로 그린다.

### 1.2 범위 (Scope)

- `dmctl subagent-statusline`: `subagentStatusLine` 프록시. 값을 서버에 보고하고, 원래 등록된 명령에 같은 입력을 넘긴다.
- 서버: 도구별 서브에이전트 목록을 메모리에 둔다. `GET /api/tools/activity` 와 `dmctl status --json` 으로 내보낸다.
- 클라이언트: 에이전트 카드에 서브에이전트 줄을 그린다.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **subagentStatusLine** | Claude Code 설정 키. 등록한 명령은 stdin 으로 `tasks` 배열을 받고, stdout 의 JSON 줄로 서브에이전트 행을 바꾼다. 줄을 내지 않은 행은 기본 표시를 유지한다 |
| **틱** | Claude Code 가 `subagentStatusLine` 명령을 한 번 실행하는 일. 실측 주기는 약 5초다 (§2.2) |
| **서브에이전트 항목** | `tasks` 의 원소 하나에서 허용 목록(FR-SAU-2)의 값만 꺼낸 것 |
| **서브에이전트 목록** | 한 도구의 마지막 보고에 담긴 서브에이전트 항목들과 받은 시각 |
| **신선** | 서브에이전트 목록을 받은 지 `subagentStaleMs` 이하인 상태 (FR-SAU-12) |
| **서브에이전트 줄** | 카드에서 서브에이전트 항목 하나를 그리는 줄 (FR-SAU-20) |

### 1.4 참고 (References)

- `ISSUE_AGENT_TREE_SRS.md` FR-SLP-* — statusLine 프록시, 허용 목록, `/api/tools/usage`
- `ACTIVITY_CARD_USAGE_SRS.md` FR-ACU-* — 카드의 사용량 줄, `cardUsage`, 맥락 등급
- Claude Code 문서 "Customize your status line" — `subagentStatusLine` 절

### 1.5 개요 (Overview)

§2 는 지금의 사실과 실측, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험이다.

## 2. 현황 (Identified Issue)

### 2.1 지금 있는 것

- dongminal 은 띄운 claude 세션에 flag 설정으로 `statusLine` 프록시(`dmctl statusline`)를 건다 (`agentadapter/claude_install.go`).
- 프록시는 main 세션 값만 받는다. 서브에이전트 값은 그 입력에 없다.
- 카드의 사용량 줄(FR-ACU-10)은 main 세션 값이다.

### 2.2 실측 (2026-11-09, 이 세션)

사용자 설정에 입력을 기록만 하는 명령을 `subagentStatusLine` 으로 걸고, 백그라운드 서브에이전트(Explore, haiku) 하나를 실행했다.

- 입력의 최상위 키: `session_id`·`transcript_path`·`cwd`·`prompt_id`·`columns`·`tasks`.
- `tasks` 원소: `id`·`type`(`local_agent`)·`agentType`·`status`·`description`·`label`·`startTime`(ms)·`model`(id, 예: `claude-haiku-5-5`)·`contextWindowSize`·`tokenCount`·`tokenSamples`·`cwd`. effort 를 지정하지 않은 서브에이전트는 `effort` 가 없다.
- 틱은 약 5초 주기다. main 세션이 쉬어도 돈다.
- `tokenCount` 의 마지막 값(19,250)은 서브에이전트의 마지막 응답 토큰 합(입력+캐시 생성+캐시 읽기+출력 = 19,139)과 가깝다. 맥락 크기로 쓴다.
- 끝난 서브에이전트는 `status: "completed"` 로 약 25초(5틱) 더 들어온다.
- 보일 행이 없으면 **틱이 멈춘다.** 빈 `tasks` 입력은 오지 않는다.
- 명령이 아무것도 출력하지 않아도 Claude Code 의 기본 행은 그대로 보였다.
- 사용자 설정을 고친 직후 다시 시작하지 않아도 적용됐다.

## 3. 요구 (Requirements)

### 3.1 허용 목록

- **FR-SAU-1** 서브에이전트 항목의 허용 목록은 `internal/shared/statusline` 의 타입 한 벌이다. 프록시와 서버가 같은 타입을 쓴다 (FR-SLP-2 와 같은 규칙).
- **FR-SAU-2** 허용 목록의 필드는 아래와 같다. 값이 없거나 타입이 다르면 그 필드를 싣지 않는다.

  | 내보내는 이름 | 입력 이름 | 타입 |
  |---|---|---|
  | `id` | `id` | string |
  | `agentType` | `agentType` | string |
  | `status` | `status` | string |
  | `model` | `model` | string |
  | `effort` | `effort` | string (입력이 string 일 때) |
  | `effortBudget` | `effort` | number (입력이 number 일 때) |
  | `windowTokens` | `contextWindowSize` | number |
  | `tokens` | `tokenCount` | number |
  | `startTime` | `startTime` | number |

- **FR-SAU-3** `description`·`label`·`name`·`cwd`·`tokenSamples` 와 최상위의 경로(`transcript_path`·`cwd`)는 싣지 않는다.
- **FR-SAU-4** `id` 가 없는 원소는 버린다. 목록은 앞에서부터 최대 `subagentMaxTasks`(32)개만 싣는다.

### 3.2 프록시 (`dmctl subagent-statusline`)

- **FR-SAU-5** dongminal 이 claude 세션에 넘기는 flag 설정에 `"subagentStatusLine": {"type":"command","command":<dmctl> subagent-statusline}` 을 더한다.
- **FR-SAU-6** 프록시는 stdin 을 읽어 `DONGMINAL_TOOL_ID` 가 있고 입력에 `tasks` 배열이 있으면 `POST /api/tools/subagents` 에 `{toolId, tasks}` 를 보낸다. `tasks` 가 빈 배열이면 빈 목록을 보낸다. 보고 시한은 `slReportBudget`(100ms)이고, 넘기면 버린다.
- **FR-SAU-7** 하위 명령은 `subagentStatusLine` 키로 찾는다. 찾는 순서와 `disableAllHooks` 규칙은 FR-SLP-4 와 같다. 자기 자신(`dmctl subagent-statusline`)은 고르지 않는다.
- **FR-SAU-8** 하위 명령이 있으면 같은 입력을 넘기고, stdout·stderr·종료 코드를 그대로 돌려준다. 없으면 아무것도 출력하지 않고 0 으로 끝난다. 그래서 Claude Code 의 기본 행이 그대로 보인다 (§2.2).

### 3.3 서버

- **FR-SAU-10** `POST /api/tools/subagents` 는 `{toolId, tasks}` 를 받아 그 도구의 서브에이전트 목록을 통째로 바꾸고 받은 시각을 붙인다. 허용 목록 밖의 필드는 디코딩에서 떨어진다. 도구 식별은 `/api/tools/usage` 와 같다(`callerToolID`).
- **FR-SAU-11** 서브에이전트 목록은 메모리에만 둔다. 살아 있지 않은 도구의 목록은 사용량과 같은 수거 주기에 지운다.
- **FR-SAU-12** 서브에이전트 목록은 받은 지 `subagentStaleMs`(15,000ms = 3틱) 이하일 때만 내보낸다. 넘으면 없는 것으로 본다 (§2.2 "틱이 멈춘다").
- **FR-SAU-13** `GET /api/tools/activity` 항목은 신선한 목록이 비어 있지 않으면 `subagents` 필드를 더한다. 원소는 아래와 같고, 값이 없는 필드는 싣지 않는다.

  | 필드 | 출처 |
  |---|---|
  | `id`·`agentType`·`status`·`model`·`effort`·`tokens`·`windowTokens`·`startTime` | 항목 그대로. `tokens`·`windowTokens` 는 툴팁의 정확한 값이다 (FR-SAU-23) |
  | `effort` | 항목에 `effort` 가 없고 `effortBudget` 이 있으면 그 수를 글자로 |
  | `ctxPct` | `tokens / windowTokens × 100`. 둘 다 있고 `windowTokens > 0` 일 때만 |
  | `ctxLevel` | `ctxPct` 가 있을 때 맥락 정책으로 정한 등급 (FR-ACU-3 과 같은 함수) |

- **FR-SAU-14** `subagents` 는 `startTime` 오름차순이다. `startTime` 이 없는 원소는 끝에 받은 순서로 둔다.
- **FR-SAU-15** `dmctl status --json` 의 도구 상태는 신선한 목록이 있으면 `subagents` 필드에 허용 목록 항목(FR-SAU-2) 그대로를 싣는다.

### 3.4 클라이언트

- **FR-SAU-20** 카드는 `subagents` 의 원소마다 사용량 줄(FR-ACU-10) 아래에 서브에이전트 줄을 그린다. 줄은 왼쪽부터 `↳` · `agentType` · 모델·effort · 맥락 막대와 `NN%` 이다.
- **FR-SAU-21** 모델은 id 의 앞 `claude-` 를 뗀 글자다. 각 부분은 값이 있을 때만 선다. `agentType` 이 없으면 `agent` 라고 쓴다.
- **FR-SAU-22** `status` 가 `running` 이 아닌 줄은 흐리게 그린다. 막대 색은 `ctxLevel` 을 따른다 (FR-ACU-13 의 클래스·토큰 재사용).
- **FR-SAU-23** 서브에이전트 줄의 툴팁은 영어로 정확한 값을 보인다. 예: `Explore · claude-haiku-5-5 · effort low · 19,250 / 1,000,000 tokens · running`.
- **FR-SAU-24** 카드의 재조정 근거(`sig`)에 서브에이전트 줄마다 그려지는 값(`id`·`agentType`·`status`·모델 글자·effort·반올림한 `ctxPct`·`ctxLevel`)을 넣는다.
- **FR-SAU-25** SSE `tool_activity` 로 항목을 덮어쓸 때 기존 `subagents` 를 지우지 않는다. `_activityRestore` 는 응답의 `subagents` 를 그대로 담고, 없으면 지운다 (FR-ACU-16·17 과 같은 규칙).

### 3.5 비기능

- **NFR-SAU-1** 프록시는 하위 명령이 없을 때 서버 보고 시한(100ms) 안에 끝난다. 틱(5초)을 밀지 않는다.
- **NFR-SAU-2** 서브에이전트 줄은 패널 최소 폭에서 카드 폭을 넘지 않는다. 넘치면 `agentType` 과 모델·effort 가 말줄임으로 줄고, 막대와 백분율은 줄지 않는다.
- **NFR-SAU-3** 새 조회 주기·새 SSE 이벤트를 만들지 않는다. 카드 지연은 `agentsPollMs` 한 주기 + 틱 한 주기 이하다.

## 4. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-SAU-1 | 카드 안에 서브에이전트마다 한 줄을 두고, 끝난 것은 흐리게 보인다 | 사용자가 골랐다. Claude Code 화면과 같은 목록을 보인다 |
| D-SAU-2 | 끝난 줄을 지우는 시점은 Claude Code 가 정한다 | Claude Code 가 끝난 행을 빼면 다음 틱 입력에 없다. 마지막 행이 빠지면 틱이 멈추므로 FR-SAU-12 의 기한이 지운다 |
| D-SAU-3 | `description`·`label` 은 싣지 않는다 (2026-11-10 `ACTIVITY_STATE_SUBAGENT_SRS` D-ASV-4 가 `description` 을 싣도록 바꿨다) | 모델이 쓴 자유 글이다. FR-SLP-2a 의 "본문은 싣지 않는다" 를 따른다. 종류(`agentType`)로 구별한다 |
| D-SAU-4 | 맥락 사용률은 `tokenCount / contextWindowSize` 로 셈한다 | Claude Code 문서가 이 셈을 말하고, 실측도 마지막 요청 토큰과 맞는다 (§2.2) |
| D-SAU-5 | 프록시는 `statusLine` 프록시와 같은 하위 명령 찾기를 쓴다 | 두 키의 우선순위·`disableAllHooks` 규칙이 같다 (Claude Code 문서). 함수 하나가 키를 받는다 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-SAU-1 | FR-SAU-1~4 | Go: §2.2 실측 입력에 모르는 필드·경로·`description` 을 더해 꺼냄 | 허용 필드만 남는다. `effort` 가 string/number 일 때 각각 `effort`/`effortBudget` 이다. `id` 없는 원소는 없다. 33개 입력은 32개다 |
| TC-SAU-2 | FR-SAU-5 | Go: claude 설치 설정 | `subagentStatusLine.command` 가 `"<dmctl>" subagent-statusline` 이다 |
| TC-SAU-3 | FR-SAU-6 | Go: 시험 서버로 프록시 실행 | `/api/tools/subagents` 에 `{toolId, tasks}` 가 온다. `DONGMINAL_TOOL_ID` 가 없으면 보내지 않는다 |
| TC-SAU-4 | FR-SAU-7·8 | Go: 사용자 설정에 `subagentStatusLine` 하위 명령 / 자기 자신 / 없음 / `disableAllHooks` | 하위 명령의 stdout 이 그대로 나온다 / 자기는 고르지 않는다 / 출력 없이 0 이다 / 실행하지 않는다 |
| TC-SAU-5 | FR-SAU-10·12·13·14 | Go: 보고 후 `/api/tools/activity` 를 시각을 바꿔 호출 | 신선하면 `subagents` 가 `startTime` 순으로 있고 `ctxPct`·`ctxLevel` 이 맞다. 기한이 지나면 필드가 없다. 빈 목록 보고 뒤에도 없다 |
| TC-SAU-6 | FR-SAU-11·15 | Go: 도구가 죽은 뒤 수거 / `dmctl status --json` 응답 | 목록이 지워진다 / `subagents` 가 허용 목록 항목이다 |
| TC-SAU-7 | FR-SAU-20~23 | JS 단위: 서브에이전트 조합별 카드 | 원소마다 줄이 서고, 모델 글자에 `claude-` 가 없고, `running` 이 아닌 줄에 흐림 클래스가 붙고, 툴팁이 영어다 |
| TC-SAU-8 | FR-SAU-24·25 | JS 단위: `ctxPct` 2.1→2.3 / status 변경 / SSE 덮어쓰기 / `subagents` 없는 복원 | `sig` 같음 / 다름 / 남음 / 지워짐 |
| TC-SAU-9 | FR-SAU-20·NFR-SAU-2 | e2e: 서브에이전트를 보고한 도구로 패널을 열고 최소 폭으로 줄임 | 줄이 보이고 카드 폭을 넘지 않는다 |
| TC-SAU-10 | FR-SAU-5·8, §2.2 | 수동: 새로 빌드한 dongminal 에서 띄운 claude 세션이 서브에이전트를 실행 | Activity 카드에 줄이 서고, Claude Code 화면의 기본 행이 그대로다 |

## 6. 비목표 (Non-goals)

- 서브에이전트의 비용·`tokenSamples` 추이·설명 글 표시 (D-SAU-3)
- Claude Code 화면의 서브에이전트 행 모양 바꾸기 (프록시는 행을 출력하지 않는다)
- dongminal 이 띄우지 않은 claude 세션의 서브에이전트
- Claude 외 에이전트(codex 등)의 서브에이전트
- 서브에이전트 줄 클릭 동작 (카드 클릭과 같다)

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | flag 설정의 `subagentStatusLine` 이 사용자 설정을 덮는지 실측하지 않았다 | MEDIUM | `statusLine` 은 flag 가 이긴다(TC-SLP-5). 같은 규칙으로 보고, TC-SAU-10 에서 확인한다. 덮지 못하면 사용자 설정의 명령이 그대로 돌고 dongminal 은 값을 받지 못한다 — 동작이 망가지지는 않는다 |
| R-2 | 틱 주기나 끝난 행의 유지 시간이 Claude Code 판마다 바뀐다 | LOW | 기한(`subagentStaleMs`)만 기대고, 상수 하나로 둔다 |
| R-3 | `tokenCount` 의 뜻이 문서에 정확히 없다 | LOW | 실측으로 맥락 크기와 가깝다(§2.2). 툴팁에 원래 수를 함께 보인다 |
| R-4 | 서브에이전트가 많으면 카드가 길어진다 | LOW | Claude Code 가 보이는 행만 온다. 32개로 자른다 (FR-SAU-4) |
