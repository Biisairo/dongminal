# 인계 — WS-2 헤드리스 멤버 (묶음 H, FR-HLM-*)

> 근거 문서: [`ORCHESTRATION_V2_SRS.md`](./ORCHESTRATION_V2_SRS.md) **§3.2**
> (FR-HLM-1~12, 검증 V-HLM-1~8). 계획: [`PARALLEL_DELIVERY_PLAN.md`](./PARALLEL_DELIVERY_PLAN.md)
>
> **FR-HLM 은 12번까지만 존재한다.** 브리핑에 13~17 이 있었다면 그것은 덮어써진
> 초안의 번호다 (`WAVE1_HANDOFF.md` §5.1 의 사고 3회 중 하나).

---

## 1. 결론

**WS-2 는 완료다. 미완으로 남긴 코드가 없다.** 중간 상태로 둔 파일도 없다.

`go build ./...` · `go vet ./...` · `go test -count=1 ./...` **전량 통과**.

---

## 2. 끝낸 것 — FR 번호와 검증 ID

| FR | 내용 | 어디 |
|---|---|---|
| FR-HLM-1 | `--at` \| `--headless` 배타, 정확히 하나 | `dmctl_run.go:runSubMember` + `handlers_runs.go:apiRunMemberAdd` (양쪽에서 검사) |
| FR-HLM-2 | `POST /api/tools/headless`. TabID 빈 문자열, background 등록, 고정 `120x40`, cwd = 격리면 worktree·아니면 조정자 cwd | `handlers_runs_headless.go:createHeadlessTool` |
| FR-HLM-3 | `tools.json` 기록 → 재시작 생존 | §5 참조 (파일 4개) |
| FR-HLM-4 | `run close` 가 헤드리스 도구 종료, `--keep-tools` 로 보존 | `handlers_runs_headless.go:closeHeadlessTools` |
| FR-HLM-5 | 고아 목록 — close 응답 + `run status` 양쪽 | `orphanHeadless` + `dmctl_run.go:printOrphans` |
| FR-HLM-6 | `run attach --member [--at]` | `apiRunAttach` |
| FR-HLM-7 | `run detach --member` (프로세스 안 죽음) | `apiRunDetach` |
| FR-HLM-8 | 부착·분리가 state·outcome·컨텍스트를 안 바꿈 | `run/store_headless.go:mutateMember` |
| FR-HLM-9 | `⏻` 목록의 Run·역할 구분 — **서버측 데이터** | `handlers_attention.go:backgroundRow` (렌더는 WS-8) |
| FR-HLM-10 | `team` 스킬 배치 결정표 — **문안 작성 완료, 반영은 WS-4** | §6 참조 |
| FR-HLM-11 | `dmctl wait --member <uuid>` | `dmctl_status.go` + `memberToolID` |
| FR-HLM-12 | `read-screen --at <헤드리스 toolId>` 동작 | **코드 변경 불필요** (§7.1) |

### 검증 표

| V-ID | 상태 | 고정한 테스트 |
|---|---|---|
| V-HLM-1 | ✅ | `TestHeadlessMember_CreatesBackgroundToolWithoutTab` (탭 수 불변 + background 등록) |
| V-HLM-2 | ✅ | `TestDmctlWait_MemberResolvesToToolID` |
| V-HLM-3 | ✅ | `TestHeadlessTool_MessageAndStatusWork` |
| V-HLM-4 | ✅ | `TestHeadlessToolIDs_*` 4건 + `TestSaveAll_KeepsOwnedBackgroundTools` |
| V-HLM-5 | ✅ | `TestRunAttachDetach_DoesNotChangeMemberState`, `TestAttachDetach_TouchesOnlyTabBinding` |
| V-HLM-6 | ✅ | `TestRunClose_TerminatesHeadlessToolsOnly` |
| V-HLM-7 | ✅ | `TestRunClose_KeepToolsLeavesOrphansInStatus`, `TestDmctlRun_StatusRendersOrphans` |
| V-HLM-8 | ✅ | `TestHeadlessMember_AtAndHeadlessAreExclusive`, `TestDmctlRun_MemberRequiresExactlyOneTarget` |

**신규 테스트 함수 46개** (`store_headless_test.go` + `handlers_runs_headless_test.go`
+ `dmctl_run_headless_test.go`) + `background_test.go` 에 2개.

### 조정자 판정으로 추가한 것 (SRS 밖)

- **보상 삭제** — 도구 생성과 멤버 등록 사이에서 실패하면 도구를 되돌린다.
  FR-HLM-5 의 고아(Run 이 끝난 뒤 남은 도구)와 **다른 것**이며, 이쪽은 애초에
  만들지 않은 것과 같게 되돌린다. `TestHeadlessMember_RollsBackToolWhenRegistrationFails`
- **`Member.TabID` 화해** — §7.3

### 폐기된 브리핑 지시 (조정자 판정)

- `ResolveStrict` 에 멤버 uuid 추가 — **폐기.** §7.1 참조
- "재시작 후 도구 없으면 `lost`" — **폐기.** V-HLM-4 의 기대값이 정반대다
- 종료 전 정상 종료 유예 — **보류.** SRS 근거 없음 (§7.4)

---

## 3. 빌드·테스트 상태

| 게이트 | 결과 |
|---|---|
| `go build ./...` | ✅ rc=0 |
| `go vet ./...` | ✅ rc=0 |
| `go test -count=1 ./...` | ✅ **전량 통과** |
| `go test -race ./...` | ⚠️ **2패키지 실패 — 둘 다 WS-2 밖** (아래) |

### `-race` 실패 2건 — 내 코드가 아니다. 고치지 않았다

**내 경로의 레이스는 0건이다.** 조정자가 지적했던 `fakeWorkIndex` 레이스 4건은
지적 시점에 이미 해소돼 있었다 — 공유 fake 를 고치는 대신 잠금을 가진
`syncWorkIndex` 를 내 테스트 파일에 세웠다(실물 `workspace.Manager.Entries()` 의
atomic 로드 + 복사 규약을 흉내 낸 것). `fakeWorkIndex` 자체는 손대지 않았다.

| 패키지 | 테스트 | 진단 |
|---|---|---|
| `internal/webserver/toolclient` | `TestToolClientForegroundPushDispatch` | **테스트 결함.** 프로덕션(`client.go:282`)은 `pc.mu` 로 올바르게 잠그는데 테스트가 `client_test.go:491` 에서 `pc.OnForeground` 를 **잠금 없이 대입**한다. `DialToolClient` 가 이미 readLoop 를 띄운 뒤다. 고칠 곳은 테스트, 또는 exported setter 추가 |
| `internal/webserver/gitapi` | `TestGitSync_RunsPullThenPush`, `TestGitRemote_InvalidatesStatusCacheOnDone` | **프로덕션 코드 레이스.** `handlers_git_remote.go` 의 `gitSyncHolder.advance()`(백그라운드 goroutine, :751) vs `gitSyncRun.snapshot()`(요청 핸들러, :713). git 트랙 소관이며 묶음 H 와 무관 |

둘 다 간헐이다. 각 패키지 단독 실행에서 통과하는 회차가 있다.

### 알려진 플레이크 (내 변경 이전부터)

`TestSetBackground_MarksAndLists` 등이 **전량 병렬 실행에서만** 간헐 실패한다
(`TempDir RemoveAll cleanup: directory not empty`). 원인은 `ToolManager.Create`/
`Delete` 의 `go m.SaveAll()` 비동기 쓰기가 `t.TempDir()` 정리와 경합하는 것이며,
**내가 `toolhub` 를 건드리기 전 첫 전량 실행에서 이미 관측했다.** `httpapi` 단독
`-race` 3회 연속 통과를 확인했다. `WAVE1_HANDOFF.md` §5.4 가 같은 계열을 기록한다.

---

## 4. 안 끝낸 것

**WS-2 범위 안에는 없다.** 다만 **내 종단을 기다리며 501 로 막혀 있던 남의 분기가
하나 남아 있다.**

> 인계 요청서가 미완 후보로 꼽은 셋 중 **둘은 끝났다.** 혼동을 막기 위해 명시한다:
>
> | 항목 | 상태 | 어디 |
> |---|---|---|
> | FR-HLM-3 (`tools.json` 기록) | ✅ **완료** | §5 전체 |
> | `Member.TabID` 채우기 | ✅ **완료** | §7.3 — 복귀의 단일 관문에서 **비동기**로 채운다 |
> | `run succeed --headless` | 🔴 **미해결** | 아래. 내 것이 아니라 묶음 C 소관이다 |

### 🔴 `run succeed --headless` 가 아직 501 이다 — 다음 사람이 먼저 볼 것

`internal/webserver/httpapi/handlers_runs_context.go:197`

```go
notImplemented(w, "run succeed --headless — 헤드리스 도구 생성이 묶음 H (WS-2) 미구현이다. --at <탭 uuid> 를 써라")
```

**이 안내문은 이제 사실이 아니다.** 헤드리스 도구 생성은 구현됐다.

- 막힌 것: 묶음 **C**(FR-CBG)의 승계 경로이지 묶음 H 가 아니다
- 필요한 것: 같은 패키지의 `s.createHeadlessTool(cwd)` 를 부르고, `toolID` 를
  `run.SucceedSpec` 에 넘기면 된다 (~10줄)
- cwd 는 **승계 대상의 worktree 를 물려받아야** 한다 — 승계는 worktree 를 새로
  만들지 않는다는 것이 FR-CBG 의 규칙이므로, `prev.Worktree` 를 써야지
  `createHeadlessTool("")` 로 두면 안 된다
- **내가 하지 않은 이유**: `handlers_runs_context.go` 는 WS-3 소유이고 FR 도 묶음 C 다.
  조정자에게 판정을 올렸으나 세션이 닫혔다

이대로 두면 `dmctl run succeed --member <uuid> --headless` 가 501 로 출시된다.

---

## 5. FR-HLM-3 — 어떤 형태로 넣었나 (질문 5에 대한 답)

### `TestSaveAll_ExcludesBackgroundTools` 를 살렸는가 — **살렸다. 한 글자도 안 고쳤다.**

그리고 요청대로 **옆에 짝을 세웠다.** `internal/webserver/httpapi/background_test.go`
에 세 개가 나란히 있다:

| 테스트 | 고정하는 것 |
|---|---|
| `TestSaveAll_ExcludesBackgroundTools` (기존, 무수정) | 일반 백그라운드 도구는 **여전히** 기재되지 않는다 (FR-EM-12/FR-BG-9) |
| `TestSaveAll_KeepsOwnedBackgroundTools` (신규) | 소유자가 있는 백그라운드 도구는 기재된다 (FR-HLM-3) |
| `TestSaveAll_NoOwnerProbeKeepsLegacyBehavior` (신규) | 술어를 **주입하지 않으면** 동작이 이 기능 이전과 완전히 동일하다 |

셋이 함께 있어야 경계가 고정된다. 하나만 있으면 다음 사람이 규칙을 통째로
지우거나 예외를 통째로 지워도 테스트가 울지 않는다.

### 술어 주입 — **했다. `toolhub` 는 `run` 을 import 하지 않는다.**

```
toolhub.ToolManager.ownedProvider func() map[string]struct{}   // nil 이 기본
        ↑ SetOwnedTools(...)  — SetInvalidator 와 같은 형태
        │
        ├── cmd/dongminal/main.go   : run.HeadlessToolIDs(cfg.DataDir)
        └── internal/daemon/boot/boot.go : run.HeadlessToolIDs(home)
```

`SaveAll` 의 변경은 제외 규칙을 지우는 것이 아니라 **예외 하나를 내는 것**이다:

```go
if m.IsBackground(p.ID) {
    if _, own := owned[p.ID]; !own {
        continue
    }
}
```

근거는 주석에 남겼다 — FR-EM-12 가 백그라운드 도구를 배제하는 이유는 **소유자가
없어 되살아나도 아무도 거둘 수 없다**는 것이고, 헤드리스 멤버의 도구에는 Run 이라는
소유자가 있다. 그 차이가 예외의 전부다.

집합을 통째로 돌려주는 형태인 이유: 제공자가 파일을 읽으므로 `SaveAll` 이 도구마다
부르면 한 번의 저장이 파일을 n번 읽는다. 루프 밖에서 한 번만 묻는다.

### 데몬 모드 — `dongminald` 에는 Run 저장소가 없다

`runs.json` 의 주인은 웹서버 프로세스인데 `SaveAll` 은 데몬에서 돈다. 그래서
`run.HeadlessToolIDs(dir)` 가 **파일을 직접 읽는 순수 함수**다. `boot.go` 가
배선 지점이며, 그 파일은 이미 `workspace.json` 을 직접 읽고 있어(`referencedTools`)
같은 계층이다.

### ⚠️ 가장 미묘한 것 — **펜싱 전에 읽어야 한다**

`Store.Load` 는 이전 세대가 열어 둔 Run 을 전부 `aborted` 로 확정한다
(FR-RUN-5, `fenceStale`). **그 뒤에 "열린 Run 의 헤드리스 도구" 를 물으면 하나도
없다.** 되살릴지 말지는 **지난 세대가 끝날 때의 사실**로 정해야 한다.

`main.go:buildDeps` 의 호출 순서가 그래서 이렇다:

```go
headless := run.HeadlessToolIDs(cfg.DataDir)   // ← 펜싱 전에 캡처
bd, err := buildCommonDeps(...)                // ← 여기서 runStore.Load 가 펜싱
...
for id := range headless { refs[id] = struct{}{} }
pm.LoadAll(refs)
restoreHeadlessBackground(pm, headless)        // ← background 재등록
```

**이 순서를 바꾸면 조용히 no-op 이 된다.** `TestHeadlessToolIDs_MustBeReadBeforeFencing`
이 그 전제를 고정한다 — 순서가 뒤집히면 그 테스트가 운다.

`LoadAll` 은 도구를 되살리기만 한다. background 등록은 런타임 상태라 `tools.json`
에 없으므로 별도로 되돌려야 한다. 안 하면 탭에도 `⏻` 목록에도 없는, 어디서도
닿을 수 없는 도구가 된다 (FR-BGR-5 와 같은 이유).

### 열린 Run 으로 한정한 이유

끝난 Run 의 헤드리스 도구는 FR-HLM-5 의 **고아**다. 고아를 부팅마다 되살리면
영원히 쌓인다. 정리는 `close` 의 몫이지 부팅의 몫이 아니다.
`TestHeadlessToolIDs_OnlyOpenRuns` 가 고정한다.

### 📌 스펙 관찰 — FR-HLM-3 이 실제로 사는 것

**되살아나는 것은 빈 셸이다. 그 안에서 돌던 에이전트는 돌아오지 않는다.**
그리고 Run 자체도 재시작으로 `aborted` 가 된다(FR-RUN-5).

그러므로 FR-HLM-3 이 사는 것은 **작업의 연속성이 아니라 정리 가능성**이다 —
기록하지 않으면 재시작 후 도구가 사라져 거둘 대상조차 없어진다. 기록하면
`run status` 의 고아 목록에 나타나고 `run close --force` 로 거둬진다.

SRS FR-HLM-3 의 문면은 "정리도 **승계도** 불가능한 상태가 남는다" 인데, 이 구현으로
회복되는 것은 **정리뿐이다.** 빈 셸에서 인수인계를 받을 수는 없다. 문서를 손볼
기회가 있으면 이 한 문장을 정정할 가치가 있다. WS-4 에는 "재시작을 넘겨 계속
일한다" 로 쓰지 말라고 명시해 두었다.

---

## 6. 다른 워크스트림에 넘긴 것

### WS-4 (스킬 문안) — **전달 완료. 반영 대기 중이었고, 차단 사유는 해소됐다**

`ws4-patterns` 에 두 번 보냈다. WS-4 가 **부분 반영을 하지 않고 대기**하기로 했고
(헤드리스 멤버를 만들 수단이 없으면 절 전체가 도달 불가능한 문서가 되므로),
그 차단 사유였던 CLI 4건은 **전부 열렸다.** 두 번째 메시지로 알렸다.

전달한 문안 (FR-HLM-10/11/12):

- **(A) 새 절 §3.2 "화면에 붙일까, 헤드리스로 둘까"** — 배치 결정표 4행(기본은 탭
  부착 / 4명 초과 / 팬아웃 / 승계 전용) + cwd 를 서버가 정한다는 것 + 능력 동등성 표
- **(A') §3.3 "잠깐 들여다보기 — attach / detach"** — 상태를 바꾸지 않는다는 것,
  **구독 중인 브라우저가 없으면 거부된다**는 비대칭
- **(B)** 도구 요약 표 3행 (`run attach`·`run detach`·`wait --member`)
- **(C)** 패턴 표 아래 한 줄 — "헤드리스는 패턴이 아니라 배치다"
- **(D)** Barrier 절에 `wait --member` 예시
- **(E)** 해체 절 — `run close` 가 헤드리스 도구를 닫는다, `--keep-tools`, 고아 목록

WS-4 가 역제안한 것도 전부 동의했다: `run peers` 행 추가(`to=` 가 toolId 이므로
헤드리스도 P2P 대상), "부착·분리는 `run peers` 의 `state` 도 바꾸지 않는다".

스니펫은 전부 ```` ```bash ````, 좌표 라벨 0건, `--at`/`--to` 는 전부 uuid 변수다.

### WS-8 (background 형식) — **전달 완료, WS-8 이 실데이터에 연결까지 마쳤다**

`GET /api/tools/background` 의 각 행에 **필드 3개를 더했다** (기존 소비자
`detach --list`·`_bgRefresh` 는 무영향):

```json
{ "toolId":"…", "name":"…", "cwd":"…", "since":…,
  "runId":"…", "memberId":"…", "role":"비평가" }
```

- 셋 다 `omitempty` — **값이 없으면 키 자체가 없다.** `if (b.runId)` 로 가른다
- **열린 Run 의 멤버에만** 붙는다 (`run.Store.MemberByTool` 이 의도적으로 열린 Run 만
  본다). 끝난 Run 의 도구는 `run status` 의 `orphans` 가 맡는다
- 고정 테스트: `TestApiToolsBackground_AnnotatesRunMembers` — Run 과 무관한 도구에
  세 필드가 **붙지 않는** 것까지 검사한다

WS-8 이 `app-statusbar.js:_bgRun()` 을 이 형식에 맞췄고 `e2e/bg-kill.spec.ts` 의
TC-BGK-13 을 내 종단을 타는 실경로로 다시 썼다고 회신했다.

### WS-3 (`run succeed --headless`) — **§4 참조. 유일한 미해결 항목이다**

---

## 7. 설계 판정 기록 — 다음 사람이 되짚을 것

### 7.1 멤버 uuid 해석을 `ResolveStrict` 에 넣지 않았다

브리핑은 "`ResolveStrict` 의 해석 순서에 멤버 uuid 를 더하라" 였으나 **폐기됐다.**

- `ResolveStrict` 1단계가 `m.live.IsLive(id)` 다 (`workspace/manager.go:288`).
  탭 없는 헤드리스 도구의 toolId 가 **이미 그대로 해석된다.** → FR-HLM-12 는 코드
  변경 없이 성립하고, 테스트로 고정만 했다
- 멤버 uuid 로 부르는 것은 `--member` **전용 플래그**의 몫이며 `--at` 에 섞지 않는다.
  섞으면 `workspace` 가 Run 도메인을 알아야 하고 **의존 방향이 뒤집힌다**
- `wait --member` 는 **클라이언트에서 2단 해석**한다: `GET /api/runs/preamble?member=`
  로 toolId 를 얻어 평소의 `id=<toolId>` 로 대기를 건다. 서버는 한 줄도 안 고쳤고,
  접합면은 끝까지 toolId 만 본다. `TestDmctlWait_MemberResolvesToToolID` 가 멤버
  uuid 가 접합면에 새지 않는 것을 검사한다

### 7.2 attach/detach 는 폴링으로 탭을 관측한다 — 후속에서 정리할 자리

`restoreTool`·`detachTab` 은 `hub/commands.go` 의 `creatingActions` 에 **없어서**
reqId echo 규약에 참여하지 않는다. 새 탭의 uuid 를 동기적으로 받을 길이 없다.

그래서 브로드캐스트 후 워크스페이스 색인을 **최대 3초 폴링**해 탭 uuid 를 관측하고,
관측되면 그때 기록을 고친다. **관측 실패 시 기록을 건드리지 않고 504** 를 낸다 —
재시도하면 그 탭을 관측해 성공하므로 스스로 낫는다.

`restoreTool` 을 `creatingActions` 로 승격하는 편이 깨끗하지만 `hub/commands.go`
+ `web/js` 양쪽이라 WS-2 범위 밖이었다. **조정자가 "지금 방식으로 두되 후속에서
정리할 자리로 보고하라" 고 판정했다.**

### 7.3 `Member.TabID` 는 복귀의 **단일 관문**에서 채운다

`⏻` 모달 클릭은 dmctl 을 지나지 않는다. 그래서 `POST /api/tools/background/set
{background:false}` 에서 `reconcileMemberTab` 을 부른다 — 두 경로가 그리로 모이므로
**경로가 둘이어도 기록은 하나**가 된다 (WS-8 이 제안하고 조정자가 채택).

**비동기여야 한다.** 브라우저의 `_restoreTool` 은 백그라운드 해제를 `await` 한
**뒤에** 탭을 만든다 (`web/js/core/app-tool.js`). 여기서 동기로 탭을 기다리면
서로가 서로를 기다린다 — 교착이다.

`run attach` 와 경합하면 **같은 탭일 때 양쪽 성공으로 수렴**한다
(`apiRunAttach` 가 `ErrMemberAttached` 를 받으면 결과 탭이 같은지 확인하고 성공 처리).

### 7.4 `terminateWithGrace` 를 쓰지 않았다

WS-8 의 `handlers_tools_kill.go` 에 SIGTERM 유예가 있지만 내 `run close` 경로는
`Tools.Delete` 를 직접 부른다. **조정자가 "종료 유예" 를 SRS 근거 없음으로 보류
판정했기 때문**이다. WS-8 도 "뒷단은 결국 같은 `Tools.Delete` 이므로 문제없다" 고
회신했다. 통합에서 둘을 합칠 가치는 있다고 본다.

---

## 8. 건드린 파일 전부

### 신설

```
internal/webserver/domain/run/store_headless.go
internal/webserver/domain/run/store_headless_test.go
internal/webserver/httpapi/handlers_runs_headless_test.go
internal/helper/runtimebin/dmctl_run_headless_test.go
docs/internal/HANDOFF_WS2.md   (이 파일)
```

`handlers_runs_headless.go`·`dmctl_run_headless.go` 는 Step 0 스텁이 있던 자리를
채운 것이다(둘 다 워킹트리 신규 파일).

### 수정

```
internal/webserver/httpapi/handlers_runs.go        헤드리스 분기·보상 삭제·keepTools·orphans·오류 매핑 2개
internal/webserver/httpapi/handlers_attention.go   backgroundRow(FR-HLM-9), 복귀 시 TabID 화해
internal/webserver/httpapi/background_test.go      예외 경계 짝 테스트 2개 추가 (기존 테스트 무수정)
internal/shared/toolhub/tool.go                    SaveAll 예외 + SetOwnedTools/ownedTools
cmd/dongminal/main.go                              펜싱 전 캡처·refs 병합·background 재등록·술어 주입
internal/daemon/boot/boot.go                       같은 배선의 데몬판
internal/helper/runtimebin/dmctl_run.go            runSubMember --headless, --keep-tools, printOrphans, help
internal/helper/runtimebin/dmctl_status.go         wait --member
```

### 건드리지 않은 것 (명시)

`run/store.go` 본문 · `workspace/manager.go` · `web/**` · `handlers_status.go` ·
`handlers_toolio.go` · `fakeWorkIndex`(`handlers_toolio_test.go`) ·
`hub/commands.go` · `handlers_runs_context.go`(WS-3)

### 제거한 것

`dmctl_run_headless.go` 의 Step 0 공용 헬퍼 `runSubNotImplemented` — attach/detach
구현으로 대체되며 전 저장소 참조 0건이 됐다. **조정자가 승인했다** ("스텁을 지우지
않는다" 규칙의 목적은 다른 WS 가 딛고 있는 것을 뽑지 않는 것이고, 지금은 아무도
딛지 않는다).

---

## 9. 커밋

**하지 않았다.** 사용자 확인 후 한 번에 한다. 커밋 메시지에는 SRS 번호를 쓴다
(`PARALLEL_DELIVERY_PLAN` §6.2) — 예:

```
feat(run): 헤드리스 멤버 — 탭 없는 팀원의 생성·부착·수명 (FR-HLM-1~12)
```
