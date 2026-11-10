# 인계: AGENT_RECORD_DAEMON_SRS 구현 (단계 2부터)

> 2026-11-10. 단계 1을 끝내고 커밋한 뒤, 맥락이 많이 차서 넘긴다. 이 문서의 「착수 블록」이 다음 세션의 지시 전부다.

## 착수 블록

1. `docs/internal/AGENT_RECORD_DAEMON_SRS.md` 를 끝까지 읽는다. 특히 §3.1a(단계 1 설계, 구현됨)와 §3.2(단계 2), §4(결정)를 먼저 본다.
2. **단계 2(묶음 R·C)부터** 구현한다. 순서는 SDD → TDD → 구현이다. 스펙은 이미 승인됐다(`승인·구현중`).
   - 먼저 SRS 에 §3.2a(단계 2 설계)를 적는다. 아래 「단계 2 설계 메모」가 출발점이다.
   - 테스트를 먼저 쓰고 실패(RED)를 확인한 뒤 구현한다(GREEN).
   - 단계가 끝나면 아래 「검사」를 모두 돌린다. 통과하면 **묻지 말고 커밋한다**(사용자 지시, 2026-11-10: "모든 계획이 종료될 때까지 물어보지 말고 커밋하고 구현하여 진행"). 커밋 메시지에 AI 서명을 넣지 않는다.
   - 데몬 코드를 바꾸는 단계(2·3)는 적용하려면 `dongminal start --restart-daemon` 이 필요하다고 커밋 메시지와 보고에 적는다. **재시작은 사용자가 정한다** — 직접 하지 않는다.
3. 단계 2가 끝나면 단계 3 → 4 순으로 간다. 단계마다 따로 커밋한다. 구현상 결정이 꼭 필요할 때만 사용자에게 묻는다.
4. 맥락이 차면 `/dongminal:migration` 으로 다음 세션에 넘긴다. 이 문서를 고쳐 쓴다.

## 지금까지 한 일

| 커밋 | 내용 |
|---|---|
| `8ae13045` | 별개 결함 수정: statusLine 허용 목록이 한도 창 이름을 camelCase 로 바꿔(`five_hour`→`fiveHour`) Usage 바닥이 "FiveHour" 로 보였다. 이제 이름을 입력 그대로 둔다. `dmctl status` 의 `usage.rateLimits` 키가 바뀌었다(CHANGELOG 「바뀜」) |
| `315ddeee` | **ARD 단계 1**: 데몬 기록 저장소, `recordset`·`records`, push `record`, 기능 `records`, 서버의 비동기 쓰기 큐(`internal/webserver/recordsync`), 스냅샷 반영 |

### 단계 1이 남긴 구조 (단계 2가 딛는 것)

- 와이어: `internal/shared/toolipc/protocol.go` 끝 — `Record*` 종류 상수, `RecordIsGlobal`, `RecordSetParams`, `RecordsResult`, `ToolRecords`, `RecordEvent`, `EventRecord`, `FeatureRecords`.
- 데몬:
  - `internal/daemon/ipc/paned_records.go` — `applyRecord`(검증 + 쓰기), `recordSet`·`recordsSnapshot` 처리기
  - `PanedServer.PutRecord(kind, tool, value)` — 데몬 안의 쓰기 + push. **단계 2의 보고가 쓸 자리다.** 아직 부르는 곳이 없다.
  - 전역 기록(`globalRecords`)은 `PanedServer.records`
- 도구별 기록은 `toolhub.Tool` 에 매단다 (`internal/shared/toolhub/tool_records.go`).
  - `AgentState()`·`RestoreAgentState()` — 활동·`agentSeen`·턴·알람·무장·잠금. 마지막 출력 시각은 데몬 Tool 이 스스로 적고 쓰기는 무시한다.
  - `SetRecord`·`Records` — 나머지 종류. 데몬은 해석하지 않는다.
  - `AgentTurn.State()`·`Restore()` (`agentturn.go`)
- 서버:
  - `hub.AttnTracker` 의 `SetOnChange`(판정 뒤 상태 알림), `AgentStateOf`, `Restore`, `RestoreAll` (`internal/webserver/hub/attn_records.go`)
  - httpapi 의 쓰기 자리 `s.putRecord(...)` 는 `handlers_usage.go`·`handlers_subagents.go`·`handlers_subagent_activity.go`·`handlers_attention.go`(ended → subagentActs null)·`handlers_migration_advice.go` 에 있다. 반영은 `ApplyRecords`·`ApplyRecord` 다 (`internal/webserver/httpapi/agent_records.go`).
  - 값의 JSON 모양은 지금 httpapi 의 비공개 타입이 정한다: `toolUsage`, `subagentRecord`, `map[agentId]subagentActivity`, `map[agent]limitRecord`, `true`.
- 조립: `cmd/dongminal/records.go` — `recordSender`(보낼 때마다 데몬 기능 확인), `syncRecords`(Flush → records → 반영), `newRecordWriter`. `app.go` 의 `wireDaemonRecords` 가 HTTP 를 열기 전에 스냅샷을 반영하고, push 와 재접속 콜백(`SetOnRecord`·`SetOnResync`)을 건다.

## 단계 2 설계 메모 (앞 세션이 조사한 것, 아직 SRS 에 없음)

- **데몬이 보고를 직접 해석해야 한다.** 서버가 꺼져 있어도 기록해야 하기 때문이다 (FR-ARD-25). 그러려면 지금 httpapi 비공개인 아래 것들이 데몬도 볼 수 있는 `internal/shared` 로 내려가야 한다. 데몬은 `webserver` 를 import 할 수 없다(층 게이트 `check-layer.sh`).
  - 값의 모양(위 다섯)
  - 서브에이전트 활동의 상한 32·done 30초 규칙 (`subagentActivityStore.put`·`list`)
  - 한도 병합: 에이전트 하나의 값을 전역 `limits` 에 넣기, `agentadapter.StatusLineReporter()`
  - `hub.SanitizeActivityField`(`internal/webserver/hub/activity.go:23`)와 상한 `ActivityToolMax`·`ActivityDetailMax`
  - 후보 자리는 새 패키지 `internal/shared/agentrec` 다. httpapi 는 그 타입을 쓰도록 바꾼다.
- **권하는 흐름:** 데몬은 받은 보고를 자기 기록에 먼저 반영한다.
  - main 활동은 `Tool.SetActivity`, `userPrompt` 는 `NoteUserPrompt` 로 반영한다.
  - notify 는 `Tool.SignalAttention` 으로 반영한다. 데몬에는 알림 콜백이 없으므로 상태만 바뀐다. 이것이 FR-ARD-25 의 "상태만 맞춘다" 다.
  - 그다음 서버가 붙어 있으면 **보고 자체**를 push 로 넘긴다(새 이벤트, 예: `report {method, body}`).
  - 서버는 그 push 를 HTTP 처리기와 **같은 함수**로 처리한다. `reportActivity`·`apiToolUsage` 의 본체를 떼어 낸다. 그러면 알람 판정(done·waiting 파생)이 한 자리에 남고, 판정 뒤 상태는 단계 1 의 쓰기 큐가 데몬에 되쓴다.
  - 이렇게 하면 데몬과 서버가 같은 보고를 두 번 반영한다. 서버의 되쓰기가 마지막에 덮으므로 결과는 같다. 이 판단을 SRS §3.2a 에 적고, FR-ARD-22 의 "record push" 와 다른 점을 밝힌다.
- **보고 소켓:** `platform.Current().IPC.Endpoint(home)` 옆, 같은 0700 폴더의 `report.sock` 이다 (`internal/shared/platform/ipc.go`). 연결마다 요청 하나를 받고 닫는다. 동시에 받는다. 메서드는 넷뿐이다 (FR-ARD-21). `toolId` 가 살아 있는 도구가 아니면 거절한다.
- **dmctl:** `internal/helper/runtimebin/dmctl_activity.go:73·103`, `dmctl_notify.go:41`, `dmctl_statusline.go`, subagent-statusline 이 `httpPostJSONWithin(…, hookBudget)` 로 보낸다. 보고 소켓을 먼저 시도하고, 실패하면 HTTP 로 보낸다. 두 시도의 합이 시한을 넘지 않게 한다 (FR-ARD-23).
  - 소켓 자리는 `DONGMINAL_HOME`(`dmenv.EnvHome`)으로 찾는다. 샌드박스 창은 그 자리가 없으므로 곧바로 HTTP 로 간다 (D-ARD-7).
  - `toolId` 는 dmctl 이 지금 어떻게 정하는지(`callerToolID`, 환경변수) 확인한다. 데몬은 HTTP 의 PID 역추적을 할 수 없으므로 dmctl 이 id 를 실어야 한다.
- `dmctl activity` 는 `contextObservePath` 로도 보낸다 (`dmctl_activity.go:162`). 이것은 Run 맥락 관측이며 FR-ARD-21 의 넷에 없다. 그대로 HTTP 에 둔다.

## 사용자 결정 (유효)

- **가장 중요한 것**: "Run 보다 기존 서버 저장이 데몬으로 간 것이 중요하다" (D-ARD-9). 그래서 단계 순서가 데몬 이관(1~3) → 생존 판정(4)이다.
- 에이전트 기록은 **데몬이 먼저 받아 저장하고 서버로 보낸다** (D-ARD-1). 서버는 거울이다.
- 데몬이 드는 기록은 "전부"다 (D-ARD-2, FR-ARD-10 표).
- 알람 판정도 데몬으로 옮긴다 (D-ARD-3). 직접 모드의 `toolhub.Tool` 코드를 그대로 쓴다 (D-ARD-8).
- Run 기록은 `runs.json` 에 두고, 열림은 저장하지 않고 물을 때마다 계산한다 (D-ARD-4). `contextNotices` 는 멤버 기록에 둔다 (D-ARD-5).
- 서버가 꺼져 있던 동안의 알람은 나중에 울리지 않는다. 상태만 맞춘다 (FR-ARD-25).
- 단계마다 묻지 않고 커밋하며 끝까지 진행한다 (2026-11-10).

## 앞 세션들이 확인한 사실 (다시 조사하지 않아도 된다)

- **데몬은 연결을 한 번에 하나만 받는다** (`internal/daemon/ipc/paned_server.go` 의 `Accept`, IPC-24). 그 하나는 서버가 쥔다. 그래서 `dmctl` 용 **보고 소켓을 따로** 연다 (D-ARD-6). `Accept` 는 연결이 끝나면 그 오류(EOF)를 돌려준다. 시험에서 여러 연결을 받으려면 정한 횟수만큼 부른다.
- 데몬의 도구 관리자(`pc.pm`)는 직접 모드와 **같은 `toolhub.ToolManager`** 다. 직접 모드 `Tool` 에 활동·턴·알람 판정이 이미 있다(`tool_attention.go`). 데몬에서는 알림 콜백을 잇지 않아 판정 결과가 방송되지 않는다. 다만 데몬 Tool 의 `observeOutput` 은 돌아서, 마지막 출력 시각과 무장을 스스로 적는다.
- 서버의 `AttnTracker.FeedOutput` 은 toolclient 읽기 루프 안에서 돈다. 그 자리에서 데몬 RPC 를 기다리면 교착이다. 그래서 단계 1의 쓰기는 비동기 큐다.
- 생존 질의의 결함(단계 4의 근거): `ToolClient.IsLive`·`seam/adapters.Tool.Has` → `Get` → `List()` 가 `ListOK` 의 ok 를 버린다(`internal/webserver/toolclient/client_toolhub.go`). 그래서 데몬이 답하지 못하면 "죽었다"가 된다. 그 결과 `ReapTargets`(`domain/run/store_write.go:379`)가 Run 을 제거하고, `fenceStale`(`domain/run/store.go:264`)이 `aborted` 로 저장한다.
- 유닉스 소켓 경로는 104 바이트까지다. 시험 이름이 길면 `t.TempDir()` 안의 소켓이 `bind: invalid argument` 로 실패한다. 그때는 `os.MkdirTemp("", "짧은이름")` 을 쓴다.
- e2e 는 직접 모드로 돈다. 데몬 모드는 Go 시험(`cmd/dongminal/records_test.go` 의 실제 데몬·클라이언트 종단 시험 같은 것)으로 잰다.

## 검사 (단계마다 전부)

- `go vet ./...` · `go test ./...` · 바꾼 패키지는 `go test -race`
- `npm run unit` · `npm run typecheck`
- `make gates` · `make lint`
- 관련 e2e: `npx playwright test e2e/activity.spec.ts e2e/attention.spec.ts e2e/attention-pulse.spec.ts e2e/tooltips.spec.ts`
- SRS 를 고치면 `go run ./scripts/gen-decisions` 로 `decisions.md` 를 다시 만든다.
- 새 Go 패키지는 `docs/internal/architecture.md` 의 패키지 트리에 한 줄 더한다(게이트가 잡는다).

## 규약 (변하지 않는 것)

- 사용자 전역 지침: `~/.claude/CLAUDE.md` — 심볼 탐색은 LSP → Serena → grep 순, AI 서명 금지, 한국어 응답, 동작이 바뀌면 이전·새·이유를 기록한다(CHANGELOG).
- 게이트가 잡는 것(이 저장소에서 실제로 걸린 것): 에이전트 이름 리터럴(`"claude"`)을 등록부 밖에 쓰면 안 된다(어댑터 선언으로 가린다) · web/js 파일 500줄 상한 · i18n 키 미사용(조립 키는 `scripts/check-i18n.mjs` 의 `DYNAMIC_PREFIXES` 에 사유와 함께 등록) · z-index 는 토큰(`var(--z-*)`) · SRS 상태 enum 과 `승인·구현중` 이면 `> **남은 것**:` 줄 · 패키지 트리.
- 직접 모드(데몬 없음)는 바꾸지 않는다.
- 옛 데몬·옛 서버와 섞여도 지금보다 나빠지지 않아야 한다(기능 협상, NFR-ARD-3).
