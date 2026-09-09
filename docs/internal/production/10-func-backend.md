# 10 — 백엔드 · CLI · API 기능 완성도 감사 (read-only)

- 대상: `/Users/dykim/personal/dongminal` — `cmd/`, `internal/` (Go 583 파일 중 테스트 316, 111,578 LOC)
- 축: **기능이 반쪽만 되어 있다 / 특정 조건에서 동작하지 않는다 / 있어야 할 동작이 없다**
- 방법: 미완성 신호 grep 전수 → 각 신호를 코드로 판정, dmctl·dongminal CLI 서브커맨드 표와 HTTP 라우트 표 대조,
  direct/daemon/`--isolated` 세 모드의 배선(`cmd/dongminal/main.go` `buildDeps`/`buildDepsWithHub`/`serve`, `internal/daemon/boot`) 정독,
  `internal/webserver/domain/git/{core,query,write,jobs}` 허용 목록·출구 경로 정독, Run 오케스트레이션 전 경로 추적
- 기존 감사(01·04·05·07·12, 총 173건)와 겹치는 것은 ID 참조만 하고 재보고하지 않는다.
- git 폴링·갱신은 전담 에이전트 담당이므로 다루지 않았다.

**심각도**: P1 = 실사용에서 기능이 깨지거나 데이터가 어긋남 · P2 = 완성도 부족·불편

---

## 0. 요약

미완성 신호(TODO/FIXME/HACK/XXX/not implemented/unimplemented/nolint)는 **0건**이다. 이 코드베이스에서
기능 결손은 주석이 아니라 **모드 간 배선 차이**와 **CLI↔서버 계약의 불일치**로 나타난다. 발견 18건
(P1 8 · P2 10), 의도적 설계 6건, 미확인 4건.

가장 무거운 세 가지:

1. `dmctl` 이 서버의 장기 보류(최대 180초)를 10초 고정 타임아웃으로 끊는다 — 서버는 계속 진행하므로
   **실패로 보고된 승계가 실제로는 성공해 있고, 재시도가 멤버·도구를 이중으로 만든다.**
2. `dmctl` 의 레이아웃 명령 전부가 **브라우저가 없어도 exit 0** 이다. 같은 종단을 쓰는 `detach` 는
   `delivered==0` 을 확인해 exit 1 을 내므로, 이것은 설계가 아니라 한쪽만 고쳐진 자리다.
3. 웹서버만 재시작하는 **문서화된 "세션 보존" 경로**가 헤드리스 Run 멤버를 15초 안에 전부 죽인다 —
   FR-HLM-3 이 세운 복원 기계장치(`SetOwnedTools`·boot.go 복원·`restoreHeadlessBackground`)를
   같은 기동의 reaper 가 되돌린다.

---

## 1. 미완성 신호 전수 조사 (조사 항목 1)

`*.go` 전체(583 파일) 실측. 괄호 안은 비테스트 파일 기준.

| 신호 | 전체 | 비테스트 | 기능 결손 판정 |
|---|---|---|---|
| `TODO` | 0 | 0 | — |
| `FIXME` | 0 | 0 | — |
| `HACK` | 0 | 0 | — |
| `XXX` | 0 | 0 | — |
| `not implemented` | 0 | 0 | — |
| `unimplemented` | 0 | 0 | — |
| `nolint` | 0 | 0 | — |
| `추후` / `향후` | 0 | 0 | — |
| `panic(` | 11 | 4 | **0건** — 전부 의도적 방어 |
| `임시` | 46 | 26 | **0건** — 전부 임시 파일·임시 홈 서술 |
| `미지원` | 1 | 1 | **0건** — `handlers_fs.go:434` 는 EXDEV 폴백 주석 |
| `보류` | 5 | 5 | **1건** (아래 §5-A) |
| `미확인` | 2 | 2 | **1건** (아래 P1-6) |
| `no-op` | 9 | 9 | **0건** — 전부 문서화된 계약 |

판정 근거:
- `panic(` 4건 — `testpath/testpath.go:58`(string marshal 불가능), `testpath/toolhome.go:28`(테스트 격리 실패를 조용히 넘기지 않는 의도적 중단), `uuid/uuid.go:155`(엔트로피 고갈), `httpapi/server.go:270`(recover 후 재패닉). 모두 결손 아님.
- 빈 본문 함수는 전체에서 **3개**뿐: `toolclient/client.go:576-577` `SaveAll`/`LoadAll`(데몬 모드에서 영속은 데몬이 하므로 정당한 no-op — `ToolHub` 인터페이스에도 없고 호출부도 `bd.pm != nil` 로 direct 모드에서만 부른다), `workspace/manager.go:460-466` `InvalidateTool`(주석이 "현재 의미상 할 일이 없다"를 명시한 의도적 훅). **셋 다 기능 결손이 아니다.**
- `보류` 5건 중 4건은 cross-platform 비목표·Run 잔여물 로그. 나머지 1건이 §5-A.

**결론: 마커 기반 기능 결손 2건.** 이 코드베이스의 결손은 마커로 표시되지 않는다.

---

## 2. P1

### [P1] FBE-01 `dmctl` 의 10초 고정 타임아웃이 서버의 장기 보류(최대 180초)를 끊는다 — 실패 보고 뒤에 성공이 남는다
- 위치
  - `internal/helper/runtimebin/http.go:39` `var httpClient = &http.Client{Timeout: 10 * time.Second}` (전 서브커맨드 공용)
  - `internal/helper/runtimebin/dmctl_run.go:646-654` `runPost`/`runGet` → 위 클라이언트
  - 서버측 보류 상한: `httpapi/handlers_runs_context.go:39` `handoffWaitDefault = 180 * time.Second`(POST /api/runs/succeed), `:45` `handoffPreambleWait = 90 * time.Second`(GET /api/runs/preamble), `httpapi/handlers_runs_cleanup.go:31` `exitSettleTimeout = 20 * time.Second`(POST /api/runs/close)
  - 서버는 클라이언트 절단을 보지 않는다 — `requestHandoff`(`handlers_runs_context.go:386-399`)·`waitHandoff`(`handlers_runs.go:364-379`)·`waitToolsIdle`(`handlers_runs_cleanup.go:104-123`) 전부 `time.Sleep` 루프이며 `r.Context()` 를 읽지 않는다
- 현재 동작: `dmctl run succeed --member X --headless` → 10초 뒤 `dmctl: ... context deadline exceeded`, exit 1. 그동안 서버는 계속 돌아 **헤드리스 도구를 만들고 후임 멤버를 등록하고 전임자를 succeeded 로 확정한다.** 조정자가 재시도하면 같은 일이 한 번 더 일어나 멤버와 도구가 둘씩 생긴다. `dmctl run launch`(승계 직후, 프리앰블이 늦은 요약을 최대 90초 기다림)와 `dmctl run close`(도구 정리에 최대 20초 + worktree 제거)도 같은 형태로 끊긴다.
- 기대 동작과 근거: **같은 파일의 `dmctl wait` 가 이미 옳게 한다** — `dmctl_status.go:305-310` 이 `waitClientDefaultBudgetMS + waitClientSlack` 으로 전용 클라이언트를 만든다. 저자는 이 문제를 알고 `wait` 한 곳만 고쳤다. `handoffWaitDefault` 의 주석은 "30초는 거의 언제나 초과됐다"라고 적는다 — 즉 10초 클라이언트로는 **정상 경로가 늘 실패로 보인다.**
- 재현 조건: 데몬/비데몬 무관. Run 하나에 멤버를 만들고 `dmctl run succeed --member <uuid> --headless` 실행. 전임 에이전트가 10초 안에 `run handoff` 로 답하지 않으면(요약 작성에 통상 수십 초) 재현된다.
- 제안 조치: `runPost`/`runGet` 에 서브커맨드별 예산을 받게 하고(`statusGet` 과 같은 모양), `succeed` 는 `--timeout-ms + slack`, `preamble` 은 `handoffPreambleWait + slack`, `close` 는 넉넉한 고정값. 서버측은 `time.Sleep` 루프를 `select { case <-ctx.Done(): ... }` 로 바꿔(01-Go P1 "time.Sleep 폴링" 과 같은 조치) 끊긴 요청의 부작용을 멈춘다.
- 규모: S (클라이언트) / M (서버 ctx 전파 포함)

### [P1] FBE-02 `dmctl` 레이아웃 명령이 브라우저 미구독을 성공으로 보고한다 (exit 0)
- 위치
  - `internal/helper/runtimebin/dmctl.go:432-437` `dmctlPost` → `dmctlHTTPResult`(`:413-430`) — HTTP status 만 본다
  - 서버는 사실을 준다: `httpapi/commands.go:181,205` 응답에 `"delivered": n`, 생성 명령은 `"timedOut"` 까지
  - **대조군**: `internal/helper/runtimebin/detach.go:157-178` `detachPost` 는 같은 `/api/commands` 종단을 쓰면서 `resp.Delivered == 0` 이면 `"구독 중인 브라우저가 없습니다"` + exit 1
  - 같은 결손이 `runDmctlSplit`(`dmctl.go:187`)·`runDmctlFocus`(`:207`)·`runDmctlRename`·`runDmctlOpenEditor`(`dmctl_toolio.go`)에도 그대로 있다
- 현재 동작: 브라우저 탭이 하나도 열려 있지 않을 때 `dmctl new-window`·`new-tab`·`split-h`·`split-v`·`focus`·`close-tab`·`close-window`·`rename-tab`·`rename-window`·`open-editor`·`tool-*`·`window-*`·`tab-*` 전부 `{"ok":true,...,"delivered":0}` 를 stdout 에 찍고 **exit 0** 을 낸다. 아무것도 만들어지지 않았다. 생성 명령은 `timedOut:true`, `newTabs:[]` 까지 실려 오지만 CLI 는 읽지 않는다(`grep delivered internal/helper/runtimebin/*.go` 실측: `detach.go` 한 곳뿐).
- 기대 동작과 근거: `detach` 와 같은 판정. `dmctl` 헬프의 팀 구성 절차(`dmctl.go:47-57`)가 `new-tab → run member --at <새 탭 uuid>` 를 전제하는데, `new-tab` 이 조용히 실패하면 조정자는 존재하지 않는 uuid 로 다음 단계에 들어간다.
- 재현 조건: 서버만 띄우고 브라우저를 열지 않은 채 도구 셸(또는 `DONGMINAL_PORT` 를 export 한 외부 셸)에서 `dmctl new-tab; echo $?` → `0`.
- 제안 조치: `dmctlHTTPResult` 에 `delivered` 판정을 넣고(생성 명령은 `timedOut`·`newTabs` 도), 0 이면 `detach` 와 같은 문구로 exit 1. `dmctlPost` 를 지나는 모든 서브커맨드가 한 자리에서 덮인다.
- 규모: S

### [P1] FBE-03 웹서버만 재시작해도 헤드리스 Run 멤버가 15초 안에 강제 종료된다 — FR-HLM-3 복원 기계장치가 같은 기동의 reaper 에 지워진다
- 위치
  - 펜싱: `domain/run/store.go:110-132` `Load` → `fenceStale()` 가 `r.Epoch != s.epoch` 인 열린 Run 을 전부 `Aborted`(`AbortDaemonRestart`)로 확정. epoch 는 `main.go:317` `run.NewStore(cfg.DataDir, uuid.NewString())` — **웹서버 기동마다 새 uuid** 라 데몬이 살아 있어도 매번 펜싱된다
  - 복원: `cmd/dongminal/main.go:225,235-244`(direct: `HeadlessToolIDs` → `LoadAll` → `restoreHeadlessBackground`), `daemon/boot/boot.go:69-82`(daemon: `SetOwnedTools` + `LoadAll` + `SetBackground`), `toolhub/persist.go:59-66`(tools.json 의 백그라운드 제외 규칙에 낸 예외)
  - 파괴: `main.go:551` `srv.StartRunReaper(ctx.Done())` → `handlers_runs_delete.go:120` 이 **부팅 직후 한 번 즉시** `reapRuns()` → `domain/run/store.go:421-423` `ReapTargets` 가 `State != Open` 인 Run 을 **전부** 대상으로 → `handlers_runs_delete.go:69` `purgeRun` → `closeHeadlessTools(rec, false)`(`handlers_runs_headless.go:262-273`) → `s.Tools.Delete(m.ToolID)`
- 현재 동작: `dongminal stop`(데몬 유지) → `dongminal start` 는 콘솔에 `dongminald 실행 중 (세션 보존)` 을 찍지만, 새 웹서버가 뜨자마자 ① 열려 있던 Run 을 전부 `aborted`(사유 "daemon restart", 데몬은 재시작하지 않았다) 로 만들고 ② reaper 가 즉시 그 Run 의 헤드리스 도구를 죽인다. worktree 잔여물이 없으면 레코드까지 지워져 **무엇이 죽었는지 남는 기록도 없다**(`purgeRun` 의 `residue > 0 && !force` 만 삭제를 보류한다).
- 기대 동작과 근거: `persist.go:59-66` 의 주석이 명시한다 — *"FR-HLM-3 이 그 규칙에 예외 하나를 낸다 … 헤드리스 멤버의 도구는 Run 이 소유하며, 소유자가 있으면 되살아난 뒤에도 run status 의 고아 목록과 run close 가 그것을 거둘 수 있다."* 그 전제(소유자가 살아남는다)를 펜싱이 깬다. `store.go:280-283` 의 펜싱 근거 주석 *"백그라운드 도구가 재기동을 넘지 못하므로 되살릴 실체가 없다"* 는 헤드리스 예외가 생긴 뒤로 **거짓**이다.
- 재현 조건: `dmctl run start` → `dmctl run member --headless` 로 멤버를 하나 만들고 에이전트를 기동한 뒤, `dongminal stop && dongminal start`(--all 없이, 데몬 보존). 15초 안에 `dmctl run status` 가 그 Run 을 찾지 못하고 `detach --list` 에서도 도구가 사라진다.
- 제안 조치: 펜싱 기준을 "웹서버 기동"이 아니라 **"멤버의 도구가 실제로 살아 있는가"** 로 바꾼다 — `Load` 뒤 `HeadlessToolIDs` 로 살아 있는 도구가 확인된 Run 은 Open 을 유지. 또는 최소한 `ReapTargets` 가 `AbortDaemonRestart` 로 방금 펜싱된 Run 을 **부팅 첫 회차에서 제외**하고, `closeHeadlessTools` 를 부르기 전에 도구 생존을 근거로 사용자에게 보고한다.
- 규모: M

### [P1] FBE-04 `POST /api/runs/close` 가 브라우저 없이도 "탭을 닫았다"고 보고한다
- 위치: `internal/webserver/httpapi/handlers_runs_cleanup.go:88-99` — `s.broadcastLayout("closeTab", …)` 의 반환값(전달된 구독자 수)을 버리고 `out` 에 무조건 `"closed": true` 를 담는다. `:96` 빈 탭 정리도 같다.
- 현재 동작: 구독 중인 브라우저가 0이면 `closeTab` 방송은 아무 데도 가지 않는데 응답의 `closedTabs` 는 전부 `closed:true` 다. 이어서 `handlers_runs.go:487` `markWorkspaceRunExcept(rec, "", "", closedTabIDs(closed))` 가 **"닫혔다고 보고된" 탭을 표식 해제 대상에서 제외**하므로, 실제로는 남아 있는 탭에 삭제된 Run 의 `runId` 표식이 영구히 붙는다. 그리고 `handlers_runs.go:504` 가 레코드를 삭제한다.
- 기대 동작과 근거: **같은 파일 계열의 `apiRunAttach`/`apiRunDetach`(`handlers_runs_headless.go:126-130, 190-194`)는 `if n := s.broadcastLayout(...); n == 0` 을 확인해 503 `"구독 중인 브라우저가 없다 — 부착은 화면이 있어야 한다"` 를 낸다.** 같은 전제(화면이 있어야 한다)를 close 만 검사하지 않는다. FR-RUN-9("무엇을 어떻게 했는가를 돌려준다")도 위반이다.
- 재현 조건: 브라우저 없이(에이전트만) `dmctl run close --run <uuid>` → 응답 `closedTabs[].closed=true`, 실제 workspace.json 에는 탭이 그대로이며 `tab.runId` 가 존재하지 않는 Run 을 가리킨다.
- 제안 조치: `closeRunTabs` 가 방송 결과를 그대로 `closed` 에 싣고, 0이면 `closedTabIDs` 에서 빼 표식 해제가 정상 동작하게 한다. 전체 실패면 attach/detach 와 같이 사유를 응답에 남긴다(정리는 계속하되 거짓 보고를 하지 않는다).
- 규모: S

### [P1] FBE-05 데몬 모드에서 `POST /api/tools/kill` 의 3초 유예가 적용되지 않는다 (실측 50ms) — FR-BGK-7 위반
- 위치
  - `internal/webserver/httpapi/handlers_tools_kill.go:22` `toolKillGrace = 3 * time.Second`, `:53` `terminateWithGrace(tool, toolKillGrace)`
  - `:66-78` `terminateWithGrace` 는 `tool.CmdProcessPID()` 가 0 이면 **즉시 반환**
  - `toolhub/tool.go:684-689` `CmdProcessPID` 는 `p.term == nil` 이면 0. 데몬 모드의 `ToolClient.Get`(`toolclient/client.go:549-559`)은 `&toolhub.Tool{ID, Name}` — `term` 이 없는 합성 Tool 이다
  - 그 뒤 `s.Tools.Delete` → 데몬의 `ToolManager.Delete`(`toolhub/manager.go:495-514`) → `Tool.kill()`(`tool.go:743-748`) — `Terminate` → **`time.Sleep(50ms)`** → `Kill`
- 현재 동작: `terminateWithGrace` 의 주석은 *"데몬 모드에서 … Delete 가 데몬 쪽 ToolManager 로 건너가 같은 순서를 밟는다"* 라고 적지만 순서는 같아도 **유예가 3초가 아니라 50ms** 다. 그리고 그 50ms 는 주석이 스스로 밝히듯 *"'탭을 닫는다' 용도이지 '돌던 작업에 정리할 틈을 준다' 용도가 아니다"*. **데몬 모드가 기본 경로다**(`main.go:461` `dialOrStartDaemon` 이 항상 먼저 시도하고 실패해야만 direct 로 떨어진다) — 즉 이 종단의 유예는 사실상 언제나 없다.
- 기대 동작과 근거: FR-BGK-7 이 SIGTERM → 유예 → SIGKILL 을 요구하고, 그 유예의 목적이 백그라운드 에이전트(claude 세션 등)의 정리다. `agentadapter/claude.go:27` 도 *"SIGKILL 로 끊으면 이력이 남지 않는다"* 를 명시한다.
- 재현 조건: 데몬 모드(기본)에서 `detach` 로 도구를 백그라운드로 보낸 뒤 ⏻ 모달에서 종료(= `POST /api/tools/kill`). 도구는 SIGTERM 후 50ms 만에 SIGKILL 된다.
- 제안 조치: `kill` RPC 에 grace 파라미터를 실어 데몬의 `Delete` 가 그 값을 쓰게 하거나, 데몬에 `terminate {id, graceMs}` RPC 를 하나 더해 종단이 SIGTERM 후 대기까지 원격으로 수행한다.
- 규모: S/M

### [P1] FBE-06 codex 멤버는 `dmctl run launch` 경로에서 프리앰블을 통째로 잃는다
- 위치
  - `internal/shared/agentadapter/codex.go:25` `PromptInjection: PromptStdinAfterStart`
  - `internal/shared/agentadapter/adapter.go:195-202` `launchLine` — `PromptInjection != PromptArgv` 면 프롬프트를 **싣지 않는다**
  - `internal/helper/runtimebin/dmctl_run.go:417-435` `runSubLaunch` — `--text`/`--json` 이 아니면 `line` 만 찍고 exit 0. 프리앰블이 빠졌다는 어떤 신호도 stderr 로 내지 않는다
  - dmctl 헬프가 지시하는 3단계 절차(`dmctl_run.go:66-73`)는 `launch | send-input --execute` → `wait --for ready` → `msg`(Kickoff) 이며 **프리앰블을 따로 붙여넣는 단계가 없다**
- 현재 동작: `dmctl run member --agent codex …` 로 만든 멤버에 `dmctl run launch --member <uuid>` 를 하면 출력이 `codex` 한 줄이다. 그것을 `send-input --execute` 로 흘리면 codex 는 **자기가 어느 Run 의 어떤 역할이고 brief 가 무엇이며 memberId 가 무엇인지 전혀 모른 채** 뜬다. 결과적으로 `dmctl run report` 도 할 수 없다(보고 권한은 발신 도구 정체 기반이라 동작은 하지만, 무엇을 보고할지 모른다).
- 기대 동작과 근거: `adapter.go:190-194` 의 주석이 *"그 경우 호출자가 준비완료를 기다렸다가 별도로 붙여넣어야 한다 (FR-PRE-8)"* 라고 적지만, **그 "호출자"에게 알리는 코드도 문서도 없다.** claude 는 `PromptArgv` 라 이 경로가 성립하므로 결손이 드러나지 않는다.
- 재현 조건: `dmctl run member --run R --role x --agent codex --at <탭> --brief "..."` → `dmctl run launch --member <uuid>` → 출력이 `codex`.
- 제안 조치: `runSubLaunch` 가 `adapter.PromptInjection != PromptArgv` 일 때 (a) stderr 에 "이 에이전트는 기동줄에 프리앰블을 싣지 못한다 — `wait --for ready` 뒤 `dmctl run launch --member X --text | dmctl send-input --at T --execute -` 를 실행하라" 를 찍고, (b) 종료 코드를 0 으로 두되 헬프의 3단계 절차에 그 분기를 명시한다. 또는 `run launch` 가 아예 2행 스크립트를 내도록 한다.
- 규모: S

### [P1] FBE-07 `paned.pid` 를 PID 재사용 검증 없이 신뢰한다 — 무관한 프로세스를 종료할 수 있다
- 위치
  - `internal/ctl/cli/proc.go:83-96` `daemonPID` — 파일의 정수를 읽어 `procCtl().Alive(pid)` 만 확인
  - `internal/shared/platform/process_posix.go:24-30` `Alive` = `syscall.Kill(pid, 0)` — **프로세스 신원을 보지 않는다**
  - `proc.go:106-131` `stopDaemon` — 그 pid 에 SIGTERM → 1초 → SIGKILL
  - 파일은 재부팅을 넘긴다: `daemon/ipc/paned.go:445-447` 이 `$DONGMINAL_HOME/paned.pid` 에 쓰고, 지우는 곳은 정상 종료 경로(`paned.go:511-513` `Close`)와 `stopDaemon` 뿐이다. SIGKILL·크래시·정전·재부팅에서는 남는다
- 현재 동작: 데몬이 비정상 종료(또는 호스트 재부팅)한 뒤 그 PID 가 재사용되면, `dongminal stop --all` 과 `dongminal start --restart-daemon`(`start.go:66-68`)이 **그 무관한 프로세스에 SIGTERM 을 보내고 1초 뒤 SIGKILL 한다.** `~/.dongminal` 은 재부팅을 넘으므로 "재부팅 직후 첫 `dongminal start --restart-daemon`" 이 가장 현실적인 재현 경로다(부팅 직후 PID 공간이 낮아 재사용 확률이 높다).
- 기대 동작과 근거: 같은 파일의 `PanedServer.Listen`(`paned.go:431-436`)은 **소켓에 대해서는 정확히 이 문제를 방어한다** — dial 로 살아 있는지 확인하고 응답하면 중단한다. pidfile 에는 그 대조가 없다.
- 재현 조건: `kill -9 $(cat ~/.dongminal/paned.pid)` 후 그 PID 를 다른 프로세스가 잡을 때까지 기다리거나(`for i in $(seq 1 40000); do :; done` 식으로 PID 공간을 소진), 재부팅 후 `dongminal stop --all`.
- 제안 조치: pidfile 에 pid 와 함께 기동 시각·소켓 경로를 적고 `daemonPID` 가 대조하거나(POSIX: `/proc/<pid>/comm` · macOS: `platform.Info` 의 프로세스 이름 조회), 더 단순하게 **소켓 dial 이 성공할 때만 pid 를 신뢰한다** — `Listen` 이 이미 쓰는 판정이다.
- 규모: S

### [P1] FBE-08 `git submodule update` 가 네트워크 작업인데 취소·진행·자격증명 가드가 하나도 없다
- 위치
  - `internal/webserver/domain/submodule/submodule.go:268-288` `ExecGit` — `context.WithTimeout(context.Background(), 180s)`, **`cmd.Env` 를 설정하지 않는다**
  - 대조: `domain/git/core/exec.go:200-225` `Env()` 가 `GIT_TERMINAL_PROMPT=0` 등을 세운다. 서브모듈 경로는 그것을 쓰지 않는다
  - `gitapi/handlers_git_submodule.go:107-120` `apiGitSubmoduleUpdate` — 요청 고루틴에서 동기 실행. `r.Context()` 를 넘기지 않는다
  - 대조: fetch/pull/push 는 `domain/git/jobs/job.go` 의 작업 경로(취소 `POST /api/git/job/cancel`, 진행 SSE `GET /api/git/job/events`, 프로세스 그룹 단위 SIGTERM)를 탄다
- 현재 동작: `submodule update --init` 은 서브모듈을 원격에서 **clone** 하므로 fetch 와 같은 성질(분 단위·진행 출력·취소 필요)인데, ① 진행 상황이 보이지 않고 ② 취소할 수단이 없으며 ③ `GIT_TERMINAL_PROMPT=0` 이 없어 인증이 필요한 서브모듈에서는 180초를 다 채운 뒤 timeout 으로 죽는다(서버 환경에 `GIT_ASKPASS`/`SSH_ASKPASS` 가 있으면 그쪽으로 새기까지 한다). 요청 고루틴이 그동안 붙잡힌다.
- 기대 동작과 근거: `job.go:22-24` 의 규정 — *"원격 작업은 다른 git 실행과 성질이 다르다: 초 단위가 아니라 분 단위이고, 출력이 진행 상황이며, 취소할 수 있어야 한다."* 서브모듈이 그 정의에 정확히 해당한다. `handlers_git_submodule.go:11-19` 는 서브모듈을 `domain/git` 밖으로 뺀 이유를 허용 목록 교집합 금지로 설명하지만, 그것은 **실행 환경과 취소 계약까지 버릴 이유가 아니다.**
- 재현 조건: 인증이 필요한(비공개 SSH/HTTPS) 서브모듈이 있는 저장소에서 Git 창 → Submodules → update. 180초 동안 응답이 없고 취소 버튼이 없다.
- 제안 조치: 최소 조치로 `ExecGit` 에 `cmd.Env = append(os.Environ(), core.Env()...)` 를 넣고 `ctx` 를 `r.Context()` 에서 받는다. 완전한 조치는 `update` 를 `jobs.Jobs` 경로에 태우는 것(`jobKinds` 에 등록 + SSE). 환경 미설정 자체는 01-Go P2("외부 명령 실행")가 이미 지적했으나 여기서는 그 **기능적 귀결**(취소·진행·매달림)을 다룬다.
- 규모: S(환경·ctx) / M(작업 경로 편입)

---

## 3. P2 (카테고리별 10건)

### A. 모드 간 비대칭 (4)

**[P2] FBE-09 `--isolated` 인스턴스의 도구 셸이 사용자 홈을 잃는데 그 사실을 알리지 않는다**
`ctl/cli/start.go:158-168` `isolatedToolHome` 이 격리 홈 아래 `tool-home` 을 만들어 `dmenv.EnvToolHome` 으로 심는다. 그 결과 `--isolated` 로 뜬 인스턴스의 모든 터미널은 rc·git config·ssh 키·에이전트 자격증명이 없는 빈 홈에서 돈다. 근거 주석은 "verify 가 사용자 히스토리를 오염시키지 않게"이고 정당하지만, `dongminal start --isolated` 는 **사용자 노출 플래그**이며 헬프(`help.go:55`)는 "임시 홈 + 비어 있는 포트로 띄운다. 운영 인스턴스를 건드리지 않는다"까지만 말한다. 재현: `dongminal start --isolated` 후 터미널에서 `echo $HOME`·`git config user.name`. 조치: 헬프 한 줄 추가 또는 기동 로그에 명시. (S)

**[P2] FBE-10 `--isolated --foreground` 은 격리 홈 경로를 끝내 알리지 않는다**
`ctl/cli/start.go:73-75` — `o.Foreground` 면 `serve()` 로 바로 들어가고, 격리 홈과 정지 명령을 안내하는 `:140-143` 은 `startDetached` 안에만 있다. `serve`(`cmd/dongminal/main.go:442-`)도 홈을 찍지 않는다. 임시 디렉터리는 "자동으로 지우지 않습니다"(의도)인데 경로를 모르면 지울 수도 없다. 재현: `dongminal start --isolated --foreground` → 출력 어디에도 `/var/folders/.../dongminal-iso-*` 가 없다. 조치: 안내를 `RunStart` 로 올린다. (S)

**[P2] FBE-11 터미널 리셋이 데몬 모드에서만 매 접속마다 나간다**
direct: `httpapi/handlers_ws.go:125-135` — `tool.Restored` 일 때만, 그리고 **스냅샷 뒤에** `termReset` 을 보낸다. daemon: `:152-155` — **모든 WS 접속마다**, 그리고 **스냅샷 앞에** 보낸다. `termReset`(`:21`)은 마우스 보고(`?1000~?1006`)·bracketed paste(`?2004`)·대체 화면(`?1049`)을 끈다. 결과: 데몬 모드(기본)에서는 vim/TUI 가 도는 탭을 브라우저에서 새로고침할 때마다 그 앱 아래에서 마우스와 붙여넣기 모드가 꺼지고 대체 화면이 내려간다 — direct 모드에서는 일어나지 않는다. 순서 차이 때문에 두 모드의 화면 복원 결과도 다르다. 재현: 데몬 모드에서 탭에 `vim` 을 띄우고 브라우저 새로고침 → 마우스 선택이 동작하지 않는다. 조치: 두 모드가 같은 조건(첫 복원 시)과 같은 순서를 쓰게 통일. (S)

**[P2] FBE-12 `POST /api/tools/kill` 의 SIGTERM 이 데몬 모드에서 아예 발송되지 않는다 (FBE-05 의 나머지 절반)**
`handlers_tools_kill.go:67-70` 이 pid 0 에서 즉시 반환하므로 **웹서버는 SIGTERM 을 보내지 않는다.** 데몬의 `kill()` 이 `Terminate`→50ms→`Kill` 을 하므로 신호 자체는 가지만, 종단이 의도한 "정중한 종료 요청 후 3초" 는 어느 프로세스도 수행하지 않는다. FBE-05 와 한 조치로 덮인다. (S)

### B. 에이전트 오케스트레이션 (3)

**[P2] FBE-13 `dmctl status` 에는 `--member` 가 없다 — 헤드리스 멤버의 상태를 조회할 수단이 없다**
`runtimebin/dmctl_status.go:117-121` — `--member` 는 `wantCond`(=wait) 일 때만 파싱된다. `dmctl status --member <uuid>` 는 `status: unknown argument: --member` (exit 2). 헬프(`:28`)는 `--at <uuid>` 만 안내한다. 그런데 같은 파일의 `wait` 헬프(`:44-47`)는 *"헤드리스 멤버는 탭 uuid 가 없으므로 이것이 유일한 지목 수단이다"* 라고 적는다 — 즉 헤드리스 멤버는 `wait` 은 되고 `status` 는 안 된다. `memberToolID` 헬퍼가 이미 있으므로 조치는 파싱 게이트를 여는 것뿐이다. (S)

**[P2] FBE-14 `dmctl run launch --model` 이 codex 에서 조용히 무시된다**
`agentadapter/adapter.go:189-191` — `ModelFlag == ""` 면 생략. `codex.go:22` 가 그 경우다. `runSubLaunch`(`dmctl_run.go:417`)는 아무 경고도 내지 않는다. 헬프(`dmctl_run.go:52`)에 "그 에이전트의 모델 플래그가 확인된 경우에만 붙는다"가 있어 **문서 근거는 있으나** 실행 시점 신호가 없다. 조치: 생략 시 stderr 한 줄. (S)

**[P2] FBE-15 CLI 에 `run delete` / `run graph` 가 없다 — 웹 UI 와의 격차**
API: `DELETE /api/runs/{id}`(`handlers_api.go:117`), `GET /api/runs/{id}/graph`(`:116`). CLI 디스패치(`dmctl_run.go:143-168`)에는 `start·member·launch·report·status·list·close·attach·detach·succeed·handoff·peers` 만 있다. 반대 방향으로는 12-func-ui FUI-04 가 "UI 에는 close(정리)가 없고 삭제만 있다"를 지적했다 — 두 표면이 **서로 없는 것을 하나씩** 갖고 있다. 조치: `dmctl run delete --run <uuid>` 와 `dmctl run graph --run <uuid>` 추가(각각 API 한 번 호출). (S)

### C. 엣지 케이스 미처리 (3)

**[P2] FBE-16 존재하지 않는 `--cwd` 가 조용히 홈으로 폴백된다**
`toolhub/tool.go:284-289` — `os.Stat(cwd)` 가 실패하거나 디렉터리가 아니면 `startDir = userHome()`. 오류도 로그도 없다. `toolhub/manager.go:365-367` 의 주석은 정반대를 선언한다: *"작업 디렉터리는 그대로 넘긴다. 실재 여부의 판정과 사유 보고는 배치기가 한다 (FR-SBX-41) — 여기서 조용히 걸러 내면 사용자가 고른 폴더가 왜 안 붙었는지 알 수 없다."* 그러나 **배치기는 샌드박스 창에만 있고**(`manager.go:412-417` `place.Profile == ""` 이면 결정자를 묻지도 않는다), 일반 창은 위 폴백으로 떨어진다. `apiToolsCreate`(`handlers_api.go:261-274`)도 검증하지 않는다. 재현: `dmctl new-window --cwd /does/not/exist` → 새 창이 `$HOME` 에서 뜨고 exit 0. 조치: 비샌드박스 경로에서도 `cwd != "" && !isDir` 이면 `Create` 가 오류를 반환하고 `/api/tools` 가 400 을 낸다. (S)

**[P2] FBE-17 `run.Store` 의 모든 변경이 메모리 선반영 후 저장하며, 저장 실패 시 롤백하지 않는다**
`domain/run/store.go:203,271,328,361,402` · `store_context.go:172,283,402,438` · `store_headless.go:80` — 10곳 전부 `s.runs` 를 먼저 고치고 `if err := s.save(); err != nil { return ..., err }`. 디스크 가득·권한 오류에서 **메모리와 `runs.json` 이 갈라진다.** 특히 `AddMember`(`:270-273`)는 멤버를 슬라이스에 넣은 뒤 저장에 실패하면 오류를 내는데, 호출자(`handlers_runs.go:295-300`)는 그 오류를 보고 도구를 지우고 worktree 를 되돌린다 — 결과적으로 메모리에는 **죽은 도구를 가리키는 멤버**가 남고, 다음 재기동에 조용히 사라진다. 재현: `runs.json` 이 있는 디렉터리를 읽기 전용으로 만들고 `dmctl run member --headless`. 조치: 저장 실패 시 스냅샷 복원(변경 전 `s.runs` 사본을 되돌린다) 또는 `platform.WriteFileAtomic` 성공 후에만 커밋. (S/M)

**[P2] FBE-18 붙여넣기 본문의 종료 마커·엔벨로프 구분자를 이스케이프하지 않는다**
`toolhub/bracketpaste.go:132-141` `wrapPaste` 는 텍스트를 `ESC[200~ … ESC[201~` 로 감쌀 뿐, 본문 안의 `ESC[201~` 을 제거·치환하지 않는다. 본문에 그 바이트열이 있으면 수신 셸이 붙여넣기 구간을 조기 종료하고 나머지를 **타이핑된 입력**으로 해석한다. `dmctl read-output` 은 ANSI 를 그대로 내도록 설계된 명령이므로(`dmctl_toolio.go:31`) `read-output | dmctl msg --to X -` 라는 문서화된 조합이 이 경로를 만든다. 같은 자리에 두 번째 결손이 있다: `httpapi/handlers_toolio.go:139-142` 의 엔벨로프는 본문의 `[/DONGMINAL-AGENT-MSG]`·`[DONGMINAL-AGENT-MSG from=…]` 를 이스케이프하지 않아 발신 에이전트가 **다른 멤버를 사칭하는 헤더**를 본문에 심을 수 있다(`from` 은 서버가 정하지만 본문 안의 가짜 헤더는 수신 에이전트가 구분할 수 없다). 조치: `SendPaste` 진입점에서 `ESC[201~` 를 제거, `apiToolMessage` 에서 본문의 엔벨로프 구분자를 치환. 후자는 04-Sec 축과 겹치므로 그쪽과 조율. (S)

---

## 4. git 기능 완성도 (조사 항목 6 · 폴링 제외)

### 4.1 지원되는 동작 (라우트 `gitapi/routes.go` 실측 — 종단 71개)

| 영역 | 지원 |
|---|---|
| 저장소 | 해석(`repo-at`)·목록·핀/언핀/재배치·**init**(인자 없는 형태로 한정, `core/write.go:129` `guardInitArgs`) |
| 관측 | status·signature·preflight·policy·recovery(hint)·records(실행 기록)·file-head·hunks |
| 스테이징 | stage·unstage·discard·resolve·**부분 스테이징**(hunks→patch, 패치는 서버가 만든다) |
| 커밋 | commit(`--amend`·`--signoff`·`--no-verify`·`-a`)·undo-last·cherry-pick·revert·reset·drop·commit-range |
| 브랜치 | create·validate·checkout·rename·delete·merge·rebase·upstream·merge-preview·push·fetch-into·delete-remote |
| 태그 | create·validate·delete·push·delete-remote |
| stash | list·show·push·apply·pop·drop·branch |
| 원격 | remotes(목록)·add·remove·fetch·pull·push(job) |
| 진행 중 작업 | **detect + continue/skip/abort**(`query/operation.go` + `write/operation.go`) |
| 기타 | ignore 추가·uncommitted reset/clean·blame·log·diff·submodules(list/update/sync)·worktrees(list/create/remove)·replay |

### 4.2 지원되지 않는 것 — 전부 **문서 근거가 있는 의도적 비목표**

| 미지원 | 근거 |
|---|---|
| `clone` | `GIT_ACTIONS_SRS.md:380-381,496,511` FR-GIT-285 — "P2, 터미널로 충분", 인증 문제 미해결. `init` 절반만 구현됨을 명시 |
| 인터랙티브 rebase | `GIT_ACTIONS_SRS.md:43` FR-GIT-284 — 다음 판 |
| merge editor | 같은 곳 FR-GIT-283 |
| `remote set-url`/`prune`/`update` | `core/write.go:47-49` — *"이 표면이 제공하지 않는 동작이고, 열어 두면 화면에 없는 변경이 API 직접 호출로 들어온다"* |
| `git init --bare/--template/--separate-git-dir` | `core/write.go:35-40` 동일 근거 |
| `merge --skip` | `write/operation.go:38-41` — *"없는 것을 목록에 넣으면 화면이 누를 수 있는 것처럼 보인다"* (git 에 실제로 없음) |
| bisect·notes·reflog UI·worktree prune/lock/move | 어느 SRS 에도 없음 — 범위 밖 |

### 4.3 부분 지원 — 흐름의 출구 점검

**출구는 완비되어 있다.** merge·rebase·cherry-pick·revert 넷 모두 `query.DetectOperation`(gitdir 표식 파일만 읽고 git 을 실행하지 않는다)으로 진행 상태를 판정하고, `write.OperationActions(kind)` 가 그 종류에 실제로 있는 출구만 API 로 노출한다(`GET`/`POST /api/git/operation`). rebase 는 진행 위치(`at/total`)까지 두 백엔드(`rebase-merge`/`rebase-apply`) 모두에서 읽는다. **"시작만 되고 중단·재개가 없는 흐름"은 발견되지 않았다.**

충돌 상태에서 할 수 없는 것은 preflight(`query/preflight.go`)가 명시적으로 차단하며(`inProgressChecks` 가 `markersOf` 로 같은 표를 공유한다), 그 표가 한 벌인 것이 설계상 보장이다.

### 4.4 `branch.go:444 Merge` · `replay.go:27 Replay` 의 구현 완성도 (직접 확인)

- **`Merge`(`write/branch.go:444-450`)**: 3줄 래퍼다 — `MergeArgs(o)` 로 argv 를 만들고 `ExecWrite` 에 넘긴다. 인자 조립·검증은 `MergeArgs` 에 있고 그것은 `write/branch_test.go:352-375` 가 모드 4종·잘못된 모드·빈 ref 까지 시험한다. HTTP 종단은 `gitapi/handlers_git_branch_test.go:616` `TestAPIGitBranchMerge` 가 덮는다. **함수 자체에 직접 단위 테스트가 없을 뿐 기능은 완성이다.** 파괴적 선언을 하지 않는 것(`Destructive` 미설정)도 주석이 근거를 댄다 — 충돌은 되돌릴 수 있는 중간 상태이고 그 출구가 §4.3 이다.
- **`Replay`(`write/replay.go:27-38`)**: 완성이다. argv 를 클라이언트에서 받지 않고 서버 기록(`core.Recorder`)에서 꺼내며(임의 명령 표면 차단), 빈 argv·다른 저장소의 기록을 `ErrReplayTarget` 으로 거부하고, 쓰기였으면 `ExecWrite`·읽기였으면 `Exec` 로 **원래와 같은 문**을 지난다. 테스트는 `gitapi/handlers_git_replay_test.go` 에 5건 있다(없는 기록·쓰기 confirm 요구·기록된 argv 실행·라우트 등록·command 필드 부재).
- **결론: 두 함수 모두 기능 결손 없음.** "테스트 0%" 는 함수 단위 커버리지 지표의 산물이며, 실제 계약은 인자 조립기와 HTTP 종단 양쪽에서 시험된다.

### 4.5 취소·중단 (조사 항목 9)

| 장시간 동작 | 취소 | 진행 표시 | 판정 |
|---|---|---|---|
| fetch / pull / push | ✅ `POST /api/git/job/cancel` (프로세스 **그룹** SIGTERM → 유예 → SIGKILL, `jobs/job.go:492-`) | ✅ SSE `job/events` | 완성 |
| `/api/fs/find`·`/api/fs/grep` | ✅ `r.Context()` 전파(`handlers_fs_search.go:91,201,207`), ripgrep 은 `exec.CommandContext` | — | 완성 |
| git 읽기 조회 전반 | ✅ `r.Context()` 를 `core.Service.Exec` 까지 전파 | — | 완성 |
| LSP definition/references/hover/install | ✅ `r.Context()`(`handlers_lsp.go:92,151,161,175`) | — | 완성 |
| **submodule update** | ❌ `context.Background()` + 180초 | ❌ | **FBE-08** |
| **worktree create/remove** | ❌ `r.Context()` 미전파 | ❌ | 01-Go P1(`removeWithRetry` 최악 18분 락 점유)에 포함 — 재보고하지 않음 |
| `/api/file/read` 대용량 | ❌ 상한 없음 | — | 01-Go P2 에 포함 |
| headless 실행(`detach --run`) | 부분 — `POST /api/tools/kill` 로 종료 가능하나 유예가 FBE-05 | — | FBE-05 |

---

## 5. 의도적 설계 결정 (결함 아님 — 문서·주석 근거 있음)

**A. `evaluateWait` 사다리 2단계 미구현** — `httpapi/handlers_status.go:148-153`: *"스펙에는 남아 있으나 구현을 보류했다. 화면 패턴은 사용자가 하단 스테이터스라인 하나만 붙여도 깨지며, FR-SKL-2 가 스킬에서 삭제하려는 fingerprint 와 같은 취약성이기 때문이다."* 1단계(훅)와 3단계(정적 폴백)가 실제로 동작하고, 3단계를 훅 지원 에이전트에 적용하지 않는 이유까지 실측 근거로 적혀 있다. **스펙 미충족이지만 근거 있는 유보.**

**B. codex 어댑터의 `ExitCommand`/`ModelFlag` 공란** — `agentadapter/codex.go:14-18`: *"추측한 플래그는 없는 것보다 나쁘다 — 기동 자체를 깨뜨린다."* 귀결로 codex 멤버는 `run close` 시 정중한 종료 없이 탭이 강제로 닫히지만(`handlers_runs_cleanup.go:155-162` 가 빈 명령이면 청하지 않는다), 이는 확인되지 않은 명령을 셸에 치는 것보다 낫다는 명시적 판단이다.

**C. 격리 홈을 자동으로 지우지 않음** — `ctl/cli/start.go:140` 이 그 사실을 출력한다(단 `--foreground` 에서는 출력되지 않음 → FBE-10).

**D. `apiRunAttach`/`apiRunDetach` 가 브라우저를 요구** — 503 과 사유를 명시적으로 낸다. 부착은 화면이 있어야 한다는 정의상의 제약.

**E. `ToolManager.Write` 가 없는 도구에 조용히 nil 반환** — `manager_hub.go:16-18`. 01-Go P1("IPC 경계에서 실패를 성공으로 응답")이 이미 결함으로 지적했으므로 재보고하지 않는다.

**F. `PanedServer.Accept` 의 직렬 처리(dongminal 한 번에 하나)** — `boot.go:105-108` 주석이 명시. 데몬은 한 웹서버만 섬긴다는 계약.

---

## 6. 양호 판정 (범위에서 제외할 근거를 남긴다)

- **식별자 해석**: `workspace.ResolveStrict`(`manager.go:275-291`)가 빈 id·좌표 라벨·미지의 id·죽은 도구를 각각 다른 오류로 가르고, HTTP 층(`handlers_toolio.go:194-208`)이 400/404 로 옮긴다. 문안이 한 자리(`manager.go:296-304`)에 모여 두 해석기가 갈라지지 않는다.
- **`GET /api/tools/activity/wait`**: `handlers_status.go:222-260` — timeoutMs 클램프를 응답에 실어 조용하지 않게 하고, `r.Context().Done()` 을 존중하며, 데몬 RPC 인 liveness 만 1초 주기로 낮춘다. dmctl 쪽도 종료 코드 0/1/2/4/5 를 의미별로 가른다(`dmctl_status.go:78-86`). **이 표면 하나만 클라이언트 타임아웃까지 옳게 잡혀 있다** — FBE-01 의 대조군.
- **git 쓰기 초크포인트**: `core.ExecWrite` 가 유일 경로이고 거부도 기록에 남으며, 읽기·쓰기 허용 목록의 교집합이 비어 있음을 `core/static_test.go` 가 지킨다.
- **파일 조작 경합**: `fsRenameNoReplace`(`handlers_fs.go:415-450`)가 종류별로 다른 수단(`os.Link` / `os.Rename` 의 EEXIST / Lstat+락)을 쓰고 각각의 한계를 주석에 남겼다.
- **삭제 상한**: `apiFSDelete` 가 "먼저 세고 나서 지운다"(`handlers_fs.go:462-472`)로 절반만 지워진 트리를 원리적으로 막는다.
- **부팅 시 고아 회수**: 샌드박스 컨테이너(`sandboxplace.Reap`)와 Run worktree(`StartRunReaper`) 양쪽에 회수 루프가 있다.

---

## 7. 미확인 (코드로 확정하지 못한 것)

1. **Windows 경로에서의 FBE-07** — `process_windows.go:34-49` `Alive` 는 `OpenProcess` 로 존재만 본다. PID 재사용 특성이 POSIX 와 다르나 실기 검증을 하지 못했다.
2. **FBE-11 의 실제 화면 영향** — `termReset` 이 데몬 모드에서 매 접속 나가는 것은 코드로 확정했으나, xterm.js 가 스냅샷 재생으로 그것을 얼마나 되돌리는지는 브라우저 실행 없이 판정할 수 없다.
3. **FBE-18 의 `ESC[201~` 유입 빈도** — 경로 자체는 확정했으나, 실사용 출력에 그 바이트열이 얼마나 나타나는지는 측정하지 못했다.
4. **`--isolated` 모드의 기능 비대칭 전수** — 홈·포트·도구 홈 셋은 확인했다. 그 밖에 `verify` 전용 분기가 서버 기능을 바꾸는지는 `verify.go` 의 가드(`:74`)까지만 보았고 전수 대조하지 않았다.

---

## 8. 기존 발견과의 겹침 (재보고하지 않음)

| 이 리포트 | 겹치는 기존 ID | 관계 |
|---|---|---|
| FBE-01 | 01-Go P1 "요청 고루틴 안의 `time.Sleep` 폴링 — 컨텍스트 취소 미전파" | 같은 코드, 다른 귀결(저쪽은 자원 점유, 이쪽은 CLI 오보고). 조치가 겹친다 |
| FBE-05/12 | 01-Go P1 "IPC 경계에서 실패를 성공으로 응답" | `ToolHub.Delete` 가 오류를 못 내는 것은 저쪽. 유예 상실은 별개 |
| FBE-08 | 01-Go P2 "git 실행기가 4벌 — `core.Env()` 미사용" | 저쪽은 중복, 이쪽은 취소·진행·매달림이라는 기능 결손 |
| FBE-15 | 12-UI FUI-04 "Run 을 UI 에서 중단·정리할 길이 없다" | 반대 방향의 같은 격차 |
| FBE-17 | 01-Go P1 "영속 실패가 사용자에게 성공으로 보인다" | 저쪽은 workspace/settings, 이쪽은 runs.json 의 메모리/디스크 분기 |
| FBE-18 후반 | 04-Sec P0-1/P0-2 | 엔벨로프 사칭은 보안 축과 조율 필요 |
