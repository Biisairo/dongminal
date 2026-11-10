# 인계: AGENT_RECORD_DAEMON_SRS 구현 (단계 4)

> 2026-11-10. 단계 1~3 을 끝내고 커밋했다. 단계마다 새 세션에서 진행하므로 넘긴다. 이 문서의 「착수 블록」이 다음 세션의 지시 전부다.

## 착수 블록

1. `docs/internal/AGENT_RECORD_DAEMON_SRS.md` 를 끝까지 읽는다. 특히 §3.4(단계 4), §4(결정), §5 의 TC-ARD-1~5 를 먼저 본다. §3.1a~§3.3a 는 구현된 설계다.
2. **단계 4(묶음 L)** 를 구현한다. 순서는 SDD → TDD → 구현이다. 스펙은 이미 승인됐다(`승인·구현중`).
   - 먼저 SRS 에 §3.4a(단계 4 설계)를 적는다. 아래 「단계 4 설계 메모」가 출발점이다.
   - 테스트를 먼저 쓰고 실패(RED)를 확인한 뒤 구현한다(GREEN).
   - 끝나면 아래 「검사」를 모두 돌린다. 통과하면 **묻지 말고 커밋한다**(사용자 지시, 2026-11-10). 커밋 메시지에 AI 서명을 넣지 않는다.
   - 단계 4 는 서버 코드만 바꿀 가능성이 높다. 데몬 코드를 바꾸면 `dongminal start --restart-daemon` 이 필요하다고 커밋 메시지와 보고에 적는다. **재시작은 사용자가 정한다.**
3. 단계 4 가 끝나면 SRS 머리의 `> **문서 상태**` 를 `구현됨` 으로, `> **남은 것**:` 줄을 지운다(게이트가 enum 을 본다 — 허용 값을 먼저 확인한다). 이 인계 문서는 끝났다고 적는다.
4. 사용자에게 최종 보고: 단계 1~4 커밋 목록, 데몬 재시작이 필요하다는 것, 문서와 구현이 어긋난 곳.
5. 맥락이 차면 `/dongminal:migration` 으로 다음 세션에 넘긴다. 이 문서를 고쳐 쓴다.

## 지금까지 한 일

| 커밋 | 내용 |
|---|---|
| `8ae13045` | 별개 결함 수정: statusLine 한도 창 이름을 입력 그대로 둔다 |
| `315ddeee` | **ARD 단계 1**: 데몬 기록 저장소, `recordset`·`records`, push `record`, 서버의 비동기 쓰기 큐(`recordsync`), 스냅샷 반영 |
| `c6229742` | **ARD 단계 2**: 데몬 보고 소켓 `report.sock`, push `report`, dmctl 의 소켓 우선 전송, `internal/shared/agentrec` |
| `712379c7` | **ARD 단계 3**: 알람 판정을 데몬이 한다. push `attn`, 메서드 `attnconfig`·`attend`·`attendall`·`report`, 기능 `attention`(데몬·서버 함께), 서버 `AttnTracker` 거울 모드 |

### 단계 3 이 남긴 구조

- 데몬: `internal/daemon/ipc/paned_attention.go` — `wireAttention`(도구 알림 → push `attn`), 메서드 처리기. `boot.Run` 은 `PanedServer` 를 `LoadAll` 앞에서 만들고 `pm.RunAttentionSweeper` 를 돌린다.
- toolhub: `SetAttentionConfig`·`RunAttentionSweeper`, 시험용 `AdoptDetached`·`ObserveOutput`. `Tool.allowBell` 은 원자값이다.
- 서버: `hub.AttnTracker.SetMirror`·`ApplyAttn`(`attn_mirror.go`). httpapi `AttentionDaemon`(`attention_daemon.go`, `Deps.AttnDaemon`), `forwardReport`. 조립 `cmd/dongminal/attention.go` 의 `wireDaemonAttention`·`syncAttnConfig`.
- 종단 시험: `cmd/dongminal/attention_wire_test.go` (실제 데몬·클라이언트·거울).

## 단계 4 설계 메모 (앞 세션이 조사한 것, 아직 SRS 에 없음)

**생존 질의의 자리**

- `ToolClient.ListOK()` (`internal/webserver/toolclient/client_toolhub.go`) 가 "모른다"를 이미 안다. `List`·`Get`·`IsLive` 가 ok 를 버린다. 세 값 질의(예: `Liveness(id)`)를 여기에 더하는 것이 출발점이다. 직접 모드 `ToolManager` 는 언제나 안다(alive/dead).
- 서버의 생존 질의는 `Server.toolLive` (`httpapi/handlers_status.go:100`) → `ToolIO.Has` → `seam/adapters/tool.go:60 Tool.Has` → `Hub.Get`.
- `toolLive` 를 부르는 곳은 많다(runs cleanup·assign·headless·close·tree·status·peer). FR-ARD-2 표가 바꾸라는 곳은 넷뿐이다:
  1. Run 수거: `reapRuns` (`httpapi/handlers_runs_delete.go:97`) → `Store.ReapTargets(alive)` (`domain/run/store_write.go:366`). 지금은 `!alive(coord)` 면 대상이다. FR-ARD-5: **확인된 죽음**일 때만.
  2. prune: 같은 파일 :136~138 `s.usage.prune`·`s.subagents.prune`·`s.subActs.prune(s.toolLive)`. `unknown` 이면 지우지 않는다.
  3. 알람 생존 검사: `cmd/dongminal/main.go:274 attnTracker.SetLiveProbe(toolHub.IsLive)`. `unknown` 이면 알람을 막지 않는다.
  4. `dmctl status` 의 `live`: `handlers_status.go` 의 `toolStatusOf(toolID, live)`·:196·:262. `unknown` 이면 `live:false` + `liveUnknown:true`.
- 나머지 `toolLive` 자리는 표에 없으므로 그대로 둔다(종전 동작). SRS §3.4a 에 그렇게 적는다.

**펜싱 제거 (FR-ARD-3·7)**

- `domain/run/store.go` 의 `Load` → `fenceStale`(:264) 이 지난 epoch 의 열린 Run 을 `aborted`(`AbortDaemonRestart`)로 저장한다. FR-ARD-3 은 이것을 없앤다.
- `newRunStore`(`cmd/dongminal/main.go:340`)의 `run.WithLiveness` 는 펜싱만 쓴다 — 펜싱을 없애면 쓰이지 않게 된다. 시험이 쓰는지 확인하고 지운다.
- FR-ARD-7: 옛 `epoch`·`aborted` 는 읽되 새로 쓰지 않는다. `Record.Epoch` 를 어디서 채우는지 찾는다.

**Run 의 liveness (FR-ARD-4)**: `/api/runs`·`run status` 응답 조립을 찾아 Run 마다 `liveness` 를 싣는다. 목록은 `ListOK` 의 짧은 TTL 캐시를 딛는다(R-5).

**contextNotices (FR-ARD-6)**: `httpapi/handlers_runs_context.go:53 contextNoticeLog`(메모리 맵, `claim(memberID, level)` :225). 주석의 "영속하지 않는 이유"가 펜싱을 근거로 든다 — 펜싱이 없어지면 틀린 말이 된다. `domain/run/store_context.go:261` 주석도 이것을 가리킨다. 멤버 기록에 `contextNotified []string`, 조정자 몫은 Run 의 조정자 맥락 상태에 같은 필드로 둔다.

## 사용자 결정 (유효)

- **가장 중요한 것**: "Run 보다 기존 서버 저장이 데몬으로 간 것이 중요하다" (D-ARD-9). 그래서 단계 순서가 데몬 이관(1~3) → 생존 판정(4)이다.
- 에이전트 기록은 **데몬이 먼저 받아 저장하고 서버로 보낸다** (D-ARD-1). 서버는 거울이다.
- 데몬이 드는 기록은 "전부"다 (D-ARD-2, FR-ARD-10 표).
- 알람 판정도 데몬으로 옮긴다 (D-ARD-3). 직접 모드의 `toolhub.Tool` 코드를 그대로 쓴다 (D-ARD-8).
- Run 기록은 `runs.json` 에 두고, 열림은 저장하지 않고 물을 때마다 계산한다 (D-ARD-4). `contextNotices` 는 멤버 기록에 둔다 (D-ARD-5).
- 서버가 꺼져 있던 동안의 알람은 나중에 울리지 않는다. 상태만 맞춘다 (FR-ARD-25).
- 단계마다 묻지 않고 커밋하며 끝까지 진행한다 (2026-11-10).
- 데몬 재시작은 하지 않는다. 사용자가 정한다.

## 앞 세션들이 확인한 사실 (다시 조사하지 않아도 된다)

- **데몬은 연결을 한 번에 하나만 받는다** (`internal/daemon/ipc/paned_server.go` 의 `Accept`, IPC-24). 그 하나는 서버가 쥔다. 그래서 `dmctl` 용 **보고 소켓을 따로** 연다 (D-ARD-6). `Accept` 는 연결이 끝나면 그 오류(EOF)를 돌려준다. 시험에서 여러 연결을 받으려면 정한 횟수만큼 부른다.
- 데몬의 도구 관리자(`pc.pm`)는 직접 모드와 **같은 `toolhub.ToolManager`** 다. 직접 모드 `Tool` 에 활동·턴·알람 판정이 이미 있다(`tool_attention.go`). 데몬에서는 알림 콜백을 잇지 않아 판정 결과가 방송되지 않는다. 다만 데몬 Tool 의 `observeOutput` 은 돌아서, 마지막 출력 시각과 무장을 스스로 적는다.
- 서버의 `AttnTracker.FeedOutput` 은 toolclient 읽기 루프 안에서 돈다. 그 자리에서 데몬 RPC 를 기다리면 교착이다. 그래서 단계 1의 쓰기는 비동기 큐다.
- 생존 질의의 결함(단계 4의 근거): `ToolClient.IsLive`·`seam/adapters.Tool.Has` → `Get` → `List()` 가 `ListOK` 의 ok 를 버린다(`internal/webserver/toolclient/client_toolhub.go`). 그래서 데몬이 답하지 못하면 "죽었다"가 된다. 그 결과 `ReapTargets`(`domain/run/store_write.go:379`)가 Run 을 제거하고, `fenceStale`(`domain/run/store.go:264`)이 `aborted` 로 저장한다.
- 이음매 게이트(`scripts/check-seams.sh`)는 시험 안에서도 `net.Dial("unix", …)`·`net.Listen("unix", …)` 를 막는다. `platform.Current().IPC.Dial`·`Listen` 을 쓴다. 요청 본문 게이트(`check-body-limit.sh`)는 변수 이름 `r.Body`·`req.Body` 를 글자로 잡는다 — HTTP 가 아닌 곳에서는 다른 이름을 쓴다.
- `dmctl` 시험은 `internal/helper/runtimebin/main_test.go` 의 `TestMain` 이 `DONGMINAL_HOME` 을 지운다. dongminal 안에서 시험을 돌리면 그 변수가 실제 홈이어서, 지우지 않으면 시험 보고가 실제 데몬의 보고 소켓으로 간다.
- 유닉스 소켓 경로는 104 바이트까지다. 시험 이름이 길면 `t.TempDir()` 안의 소켓이 `bind: invalid argument` 로 실패한다. 그때는 `os.MkdirTemp("", "짧은이름")` 을 쓴다.
- e2e 는 직접 모드로 돈다. 데몬 모드는 Go 시험(`cmd/dongminal/records_test.go` 의 실제 데몬·클라이언트 종단 시험 같은 것)으로 잰다.

- 기능 이름을 더하면 hello 바이트 골든 둘이 바뀐다: `internal/daemon/ipc/wire_typed_test.go`(데몬)·`internal/webserver/toolclient/wire_typed_test.go`(서버).
- e2e 의 기본 리포터는 통과 수를 끝에 찍지 않는다. `--reporter=line` 으로 돌리면 `47 passed` 가 보인다.

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
