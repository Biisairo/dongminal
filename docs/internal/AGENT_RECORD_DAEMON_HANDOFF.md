# 인계: AGENT_RECORD_DAEMON_SRS 구현 (단계 1부터)

> 2026-11-10. 앞 세션의 맥락이 이관 기준(50%)에 닿아 넘긴다. 이 문서의 「착수 블록」이 다음 세션의 지시 전부다.

## 착수 블록

1. `docs/internal/AGENT_RECORD_DAEMON_SRS.md` 를 끝까지 읽는다. 특히 §2(현황)와 §3.1(단계 1), §4(결정)를 먼저 본다.
2. **단계 1(묶음 D·P)부터** 구현한다. 순서는 SDD → TDD → 구현이다. 스펙은 이미 승인됐다(`승인·구현중`).
   - 테스트를 먼저 쓰고 실패(RED)를 확인한 뒤 구현한다(GREEN).
   - 단계가 끝나면 아래 「검사」를 모두 돌리고, 통과하면 **사용자에게 커밋을 확인받고** 커밋한다. 커밋 메시지에 AI 서명을 넣지 않는다.
   - 데몬 코드를 바꾸는 단계(1·2·3)는 적용하려면 `dongminal start --restart-daemon` 이 필요하다고 보고에 적는다. **재시작은 사용자가 정한다** — 직접 하지 않는다.
3. 단계 1이 끝나면 단계 2 → 3 → 4 순으로 간다. 단계마다 따로 커밋한다.

## 사용자 결정 (유효)

- **가장 중요한 것**: "Run 보다 기존 서버 저장이 데몬으로 간 것이 중요하다" (D-ARD-9). 그래서 단계 순서가 데몬 이관(1~3) → 생존 판정(4)이다.
- 에이전트 기록은 **데몬이 먼저 받아 저장하고 서버로 보낸다** (D-ARD-1). 서버는 거울이다.
- 데몬이 드는 기록은 "전부"다 (D-ARD-2, FR-ARD-10 표).
- 알람 판정도 데몬으로 옮긴다 (D-ARD-3). 직접 모드의 `toolhub.Tool` 코드를 그대로 쓴다 (D-ARD-8).
- Run 기록은 `runs.json` 에 두고, 열림은 저장하지 않고 물을 때마다 계산한다 (D-ARD-4). `contextNotices` 는 멤버 기록에 둔다 (D-ARD-5).
- 서버가 꺼져 있던 동안의 알람은 나중에 울리지 않는다. 상태만 맞춘다 (FR-ARD-25).

## 앞 세션이 확인한 사실 (다시 조사하지 않아도 된다)

- **데몬은 연결을 한 번에 하나만 받는다** (`internal/daemon/ipc/paned_server.go` 의 `Accept`, IPC-24). 그 하나는 서버가 쥔다. 그래서 `dmctl` 용 **보고 소켓을 따로** 연다 (D-ARD-6, 단계 2).
- 데몬의 도구 관리자(`pc.pm`)는 직접 모드와 **같은 `toolhub.ToolManager`** 다. 직접 모드 `Tool` 에 활동·턴·알람 판정이 이미 있다(`internal/shared/toolhub/tool_attention.go` 의 `SetActivity`·`SignalAgentEvent`·`observeOutputAt`, `agentturn.go`). 데몬에서는 알림 콜백(`SetAttentionNotifier`·`SetActivityNotifier`, `manager_notify.go`)을 잇지 않아 돌지 않을 뿐이다.
- 서버 쪽 거울의 현재 주인:
  - 활동·알람·턴·`agentSeen`·`lastOutputAt`: `internal/webserver/hub/attn_tracker.go` (`AttnTracker`)
  - statusLine 사용량: `internal/webserver/httpapi/handlers_usage.go` (`usageStore`)
  - 서브에이전트 목록: `handlers_subagents.go` (`subagentStore`, 15초 기한)
  - 서브에이전트 활동: `handlers_subagent_activity.go` (`subagentActivityStore`, 상한 32·done 30초)
  - 계정 한도: `handlers_limits.go` (`rateLimitStore`)
  - migration 안내 표시: `httpapi/server.go:92` (`migrationUnknownTold`), 사용처 `handlers_migration_advice.go:123`
- 서버가 데몬 push 를 받는 곳: `cmd/dongminal/app.go` 의 `wireDaemonPushes` (`SetOnOutput` → `attnTracker.FeedOutput`, `SetOnExit`, 전경). push 종류와 기능 협상: `internal/shared/toolipc/protocol.go` (`Event*`, `Feature*`, `DaemonFeatures`, `HasFeature`). 데몬의 push 보내기: `internal/daemon/ipc/paned_handlers.go` 끝(`pushExit`·`pushForeground`·`pushOutputData`, `enqueue(…, droppable)`). 클라이언트의 push 받기: `internal/webserver/toolclient/client_push.go`.
- 데몬 소켓 자리: `platform.Current().IPC.Endpoint(home)`, 파일명 `paned.sock`(`internal/shared/platform/ipc.go`), 홈은 `DONGMINAL_HOME`(`dmenv.EnvHome`). 폴더는 0700.
- 샌드박스 창의 `dmctl` 은 `host.docker.internal` 로 서버에 HTTP 로만 붙는다(`internal/shared/sandbox/sandbox.go` `HostGateway`). 데몬 소켓에는 닿지 못한다 (D-ARD-7).
- 생존 질의의 결함(단계 4의 근거): `ToolClient.IsLive`·`seam/adapters.Tool.Has` → `Get` → `List()` 가 `ListOK` 의 ok 를 버린다(`internal/webserver/toolclient/client_toolhub.go:67·191·230`). 그래서 데몬이 답하지 못하면 "죽었다"가 되어 `ReapTargets`(`domain/run/store_write.go:379`)가 Run 을 제거하고, `fenceStale`(`domain/run/store.go:264`)이 `aborted` 로 저장한다.
- 직전 작업(이번 SRS 와 별개, 이미 커밋·푸시됨): `ACTIVITY_STATE_SUBAGENT_SRS` — 훅 해석 수정, 서브에이전트 활동(`/api/tools/activity/set` 의 `agentId`, SSE `tool_subagent_activity`), 계정 한도(`limits`, `resetsInSec`), Usage 바닥. 단계 1의 데몬 기록은 이 값들을 포함한다.

## 검사 (단계마다 전부)

- `go vet ./...` · `go test ./...`
- `npm run unit` · `npm run typecheck`
- `make gates` · `make lint`
- 관련 e2e: `npx playwright test e2e/activity.spec.ts e2e/attention.spec.ts e2e/attention-pulse.spec.ts e2e/tooltips.spec.ts`
- SRS 를 고치면 `go run ./scripts/gen-decisions` 로 `decisions.md` 를 다시 만든다.

## 규약 (변하지 않는 것)

- 사용자 전역 지침: `~/.claude/CLAUDE.md` — 심볼 탐색은 LSP → Serena → grep 순, 커밋은 사용자 확인 뒤, AI 서명 금지, 한국어 응답, 동작이 바뀌면 이전·새·이유를 기록한다.
- 게이트가 잡는 것(이 저장소에서 실제로 걸린 것): 에이전트 이름 리터럴(`"claude"`)을 등록부 밖에 쓰면 안 된다(어댑터 선언으로 가린다) · 파일 500줄 상한 · i18n 키 미사용(조립 키는 `scripts/check-i18n.mjs` 의 `DYNAMIC_PREFIXES` 에 사유와 함께 등록) · z-index 는 토큰(`var(--z-*)`) · SRS 상태 enum 과 `승인·구현중` 이면 `> **남은 것**:` 줄.
- 직접 모드(데몬 없음)는 바꾸지 않는다.
- 옛 데몬·옛 서버와 섞여도 지금보다 나빠지지 않아야 한다(기능 협상, NFR-ARD-3).
