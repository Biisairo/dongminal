# 05 — 테스트 전략 · 커버리지 · 테스트 코드 품질 · CI 신뢰성

대상: `/Users/dykim/personal/dongminal` (HEAD `a312eee`, 작업 트리에 미커밋 변경 16파일)
방식: read-only. 모든 수치는 이 감사에서 직접 실행한 명령의 출력이다.

감사 시점에 **다른 세션의 e2e 전량 실행이 진행 중**이었다 (`pgrep`: pid 28900 `playwright/lib/common/process.js`, 28980 `/tmp/dongminal-e2e-1788952040926-78080/dongminal-e2e start --foreground`, 29003 데몬). 그 실행이 `test-results/` 를 20:07 에 새로 만들었으므로 지시에 언급된 3건의 실패 트레이스(git-stash 19단계 · git-view-refresh · history-branch-button)는 **이미 덮여 남아 있지 않았다.** 대신 14:10 에 저장된 `playwright-report/index.html`(임베디드 report.json)을 파싱해 직전 전량 실행의 결과를 썼다 (§4).

---

## 0. 실측 요약

### 0.1 Go 커버리지 (`go test ./... -cover -count=1`, 41 패키지, 전부 통과, 패키지 시간 합 214 s)

| 구분 | 패키지 | 커버리지 |
|---|---|---|
| 상위 | `internal/helper/toolline` · `internal/shared/outbuf` · `internal/webserver/apierr` · `web` | 100.0% |
| | `internal/shared/uuid` | 92.2% |
| | `internal/shared/workspace` | 89.9% |
| | `internal/webserver/domain/run` | 89.8% |
| | `internal/webserver/domain/git/write` | 89.7% |
| | `internal/ctl/migrate` · `internal/webserver/domain/git/core` | 88.9% |
| | `internal/webserver/domain/sysstat` | 87.3% |
| | `internal/webserver/domain/submodule` | 86.7% |
| | `internal/webserver/domain/git/jobs` | 86.2% |
| | `internal/webserver/domain/git/store` | 85.8% |
| | `internal/shared/agentadapter` | 85.2% |
| | `internal/shared/runtime` | 85.1% |
| | `internal/webserver/gitapi` | 85.0% |
| | `internal/webserver/domain/git/query` | 83.9% |
| | `internal/webserver/domain/wsentry` | 83.3% |
| | `internal/webserver/httpapi` | 81.7% (57 s) |
| | `internal/helper/runtimebin` | 80.0% |
| 중간 | `hub` 77.9 · `platform` 77.0 · `lsp` 77.4 · `toolhub` 75.4 · `worktree` 75.4 · `sandbox` 73.0 · `daemon/ipc` 70.3 | |
| 하위 | `internal/webserver/toolclient` | 66.3% |
| | `internal/webserver/domain/ext` | 66.1% |
| | `internal/shared/sandboxplace` | 61.5% |
| | `internal/webserver/seam/adapters` | 46.2% |
| | `internal/ctl/cli` (소스 2,950 LOC) | **31.5%** |
| | `internal/shared/testpath` | 18.5% (테스트 보조 패키지) |
| 테스트 0 | `cmd/dongminal` (600 LOC) · `internal/daemon/boot` (125) · `internal/webserver/httproute` (100) · `internal/webserver/seam/toolaccess` (92) · `internal/shared/listorder` (67) · `internal/shared/dmenv` (58) · `internal/shared/diagtail` (36) · `internal/shared/toolipc` (28) | 0% / no test files |

측정 주의: 패키지 단위 `-cover` 는 교차 패키지 실행을 세지 않는다. `platform/pty_posix.go` 의 `Start/Read/Write/Kill/Terminate` 가 0% 로 나오지만(`cov-func.txt`) 실제로는 `toolhub` 의 PTY 테스트가 그 코드를 지난다. 진짜 미실행을 가르려면 `-coverpkg=./...` 로 재측정해야 한다.

### 0.2 e2e (`playwright-report/index.html` 14:10 판, macOS, 3 워커)

| 항목 | 값 |
|---|---|
| 스펙 파일 / 테스트 | 135 / 1,425 (`test(` 1,436 + skip 변형 13) |
| 결과 | expected 1,418 · **unexpected 0 · flaky 4 · skipped 3** |
| 벽시계 | 801,578 ms ≈ **13.4 분** |
| 테스트 소요 합 | 36.6 분 (÷3 워커 ≈ 12.2 분 — 워커 점유율 ~91%) |
| 30 s 초과 테스트 | 8 (그중 7 이 `git-repo-missing.spec.ts`, 파일 합 249 s) |
| 하드코딩 대기 | `waitForTimeout` **224회 / 40파일**, 값 합산 ≈ 197 s |
| 내부 상태 직접 접근 | `app._xxx` 533회 / **81파일**, `evaluate(` 1,617회 |
| 셀렉터 | CSS 클래스 `locator('.…')` 2,266 · `.first()/.last()` 249 · `.nth()` 79 · 텍스트 85 · `getByRole` 4 · `data-testid` **0** |

---

## 1. P0

### [P0] 편집기 저장 경로 `/api/file/write` 가 단위 테스트 0 · 경로 경계 검사 없음
- 위치: `internal/webserver/httpapi/handlers_files.go:362-388` (`apiFileWrite`), 라우팅 `handlers_api.go:140`
- 현상: 함수 커버리지 0.0% (`cov-func.txt`). `internal/webserver/httpapi/*_test.go` 에서 `/api/file/write` 를 부르는 곳이 **0건**. e2e 는 3파일이 우회 호출(`notes-live-explorer.spec.ts:211,250`, `slot-view-state.spec.ts:1214`, `ux-batch9.spec.ts:144`)하지만 응답 규약을 단정하지 않는다. 본문은 `filepath.IsAbs` 만 보고 `platform.WriteFileAtomic(req.Path, …, 0o644)` 로 **임의 절대경로**에 쓴다 — 워크스페이스 루트·`wsentry` 대조가 없다 (`handlers_fs.go` 의 탐색기 전송은 루트 대조·403 을 한다, `docs/internal/test-checklist.md` A3.11).
- 왜 문제인가: 사용자 파일을 덮어쓰는 유일한 쓰기 경로다. 회귀(빈 본문 저장, 경로 정규화 실패, 원자 쓰기 깨짐)가 CI 에서 걸리지 않는다. `--expose` 뒤에 세운 access allowlist(`d35b916`)를 지난 클라이언트는 이 엔드포인트로 서버 권한의 어느 파일이든 쓸 수 있다.
- 조치: `handlers_files_test.go` 에 (a) 정상 쓰기·ETag/`ok` 응답, (b) 상대경로 400, (c) 빈 path 400, (d) 쓰기 실패 500, (e) **루트 밖 경로 403** 테스트를 먼저 적고(RED) 루트 대조를 넣는다. 규모 **S** (테스트) + **S** (루트 대조).

### [P0] 데몬 재기동 복원 경로(세션 생존)가 어느 층에서도 검증되지 않는다
- 위치: `internal/daemon/boot/boot.go:29-51` (`referencedTools`, `Run`, 테스트 0), `internal/shared/toolhub/persist.go:94` `LoadAll` 0%, `manager.go:436` `Restore` 0%, `daemon/ipc/paned.go:222` (Restore 호출), `httpapi/handlers_ws.go:149` `handleWSDaemon` 0%, `httpapi/server.go:219` `Run` 0%, `server.go:408` `StartGitWatch` 0%, `manager.go:187-202` `sweepIdle`/`StartAttentionSweeper` 0%
- 현상: 데몬이 다시 뜰 때 `panes.json` → `LoadAll` → `Restore` 로 도구를 되살리는 사슬 전체가 단위·통합 테스트에 없다. CI 의 `dongminal verify`(`internal/ctl/cli/verify.go:197-246`, 22항목)는 **새 데몬을 띄워 왕복**만 본다 — 재기동·복원 항목이 없다. `daemon_integration_test.go` 는 `ipc.NewPanedServer` 를 직접 세워 `Create` 경로만 지난다.
- 왜 문제인가: 데몬 분리의 존재 이유가 "서버가 죽어도 셸 세션이 산다" 인데, 그 보장이 회귀해도 초록이다. `CROSS_PLATFORM_SRS §11.6` 이 실제로 데몬 모드에서만 나온 결함을 기록하고 있다.
- 조치: (1) `persist_test.go` — `LoadAll` 이 참조되지 않은 도구를 거르고 `Restore` 를 부르는지(가짜 PTY 로), (2) `verify.go` 에 "서버 재기동 뒤 `/api/state` 에 같은 도구 id 가 남고 입출력이 왕복한다" 항목 추가(CI 3 OS 가 그대로 돈다). 규모 **M**.

### [P0] `stop`·포트 킬 경로가 테스트 0 — 운영 인스턴스를 죽인 사고의 재발 방지 장치가 없다
- 위치: `internal/ctl/cli/stop.go:9` `RunStop` 0%, `proc.go:42,48,56` `pidsOnPort`/`signalPIDs`/`killPort` 0%, `start.go:30,107,236` `RunStart`/`startDetached`/`waitReady` 0%, `handoff.go:29` `handOffRestart` 0% (`cov-func.txt`; `ctl/cli` 파일별 평균 — `stop.go 0% · doctor.go 10% · verify_run.go 22% · start.go 49% · proc.go 56%`)
- 현상: `scripts/verify-isolated.sh:11-13` 이 "그 가드가 없어서 운영 인스턴스를 SIGTERM → SIGKILL 하고 터미널 세션을 잃은 사고가 실제로 있었다" 고 적고, 가드를 Go 로 옮겼다(FR-E2G-1). 그런데 가드가 사는 `verify_run.go` 의 `cleanupVerify`/`stopVerifyPID` 가 0% 이고 `killPort` 도 0% 다.
- 왜 문제인가: 파괴적 프로세스 종료 로직이 리팩터되면 그 사고가 조용히 되돌아온다.
- 조치: `proc.go` 의 `pidsOnPort`/`signalPIDs` 를 인터페이스로 분리해 표 기반 테스트(포트 매칭·기본 포트 거부·격리 홈 아님 거부·SIGTERM→SIGKILL 승격 순서). 규모 **M**.

---

## 2. P1

### [P1] CI 단위 테스트가 `./web/...` 을 건너뛴다
- 위치: `.github/workflows/verify.yml:53`, `release.yml:51` — `go test -race ./internal/... ./cmd/...`
- 현상: `web/embed_test.go`(아이콘 임베드 누락 검사, FR-ICON-6) · `web/version_test.go` 는 로컬 `./...` 에서만 돈다(이번 측정에서 `dongminal/web 100.0%`).
- 왜 문제인가: `go:embed` 패턴에서 자산이 빠지면 릴리스 바이너리가 아이콘 없이 나간다 — 정확히 그 검사가 CI 에 없다.
- 조치: 두 워크플로우의 경로를 `./...` 로. 규모 **S**.

### [P1] flaky 가 회차마다 자리를 바꾼다 — 개별 결함이 아니라 계통 결함이며 `retries: 1` 이 그것을 초록으로 만든다
- 위치: `playwright.config.ts:52-70` (`retries: 1`), `docs/internal/DRIFT_RECLAIM_SRS.md:393-415` (§7.6 "남은 flaky 다섯 — 부채로 기록한다": BR11 · B6 · H15 · P4 · X4), 14:10 리포트의 flaky 4:
  | 스펙 | 오류(리포트 원문) | 유형 |
  |---|---|---|
  | `git-history.spec.ts:383` H14 | `locator.click … element was detached from the DOM, retrying` (`.git-hist-opts`) | **재렌더 경쟁** — 관측이 닿으면 목록/툴바를 통째로 다시 그린다 |
  | `git-commit-actions.spec.ts:162` D1 | `clickGitView` → `#area .pn-body .git-view.vis` 15 s `element(s) not found` | **뷰 마운트 유실** — `fixtures.ts:139-157` 주석대로 워크스페이스 저장 409 시 서버판 채택으로 뷰가 비워진다(테스트 간 상태 누수) |
  | `git-console.spec.ts:45` K2 | 맨 위 행이 `git stash list …` (기대 `add`) | **백그라운드 폴러와의 순서 경쟁** — "맨 위" 단정이 폴링이 없다는 전제 위에 있다 |
  | `git-head-mobile.spec.ts:212` V10-13 | `Expected: 7 Received: 1` (탭 수) | **고정 대기 부족** — 직전 `waitForTimeout(800)` (`:227,:241`) 이 탭 바 재구성을 못 기다림 |
- 현상: §7.6 의 다섯과 이번 넷이 **하나도 겹치지 않는다.** 아홉 모두 "뷰/행이 서지 않았다·떨어졌다" 로 같은 기전(관측 → 전체 재렌더 → DOM 교체)을 가리킨다. `fixtures.ts` 는 이것을 `clickGitView`·`clickRow`·`clickRowAct`·`openRowMenu`·`waitRows` 의 `toPass` 재시도로 **테스트 쪽에서 견디게** 했고("재렌더는 앱의 정상 동작이므로 견디는 쪽은 테스트다" `fixtures.ts:224-233`), 재시도 밖에 있는 클릭·카운트 단정이 회차마다 걸린다.
- 왜 문제인가: 사용자는 같은 기전을 "가끔 안 눌린다" 로 만난다(`playwright.config.ts:62-66` 이 이미 제품 결함 셋이 이 뒤에 숨었다고 적음). `retries: 1` 은 그 신호를 리포트의 `flaky` 칸에만 남기고 job 은 초록이다.
- 조치: (1) CI 에서 `flaky > 0` 을 실패로 승격(`parity-reporter.ts` 가 이미 결과를 세니 한 줄 추가), (2) 제품 쪽 — `reconcileList`/탭 바가 노드를 교체하지 않고 갱신하도록(`pane-dom-reconcile.spec.ts` 가 그 규약을 이미 칸에 대해 검증한다; git 뷰로 확장), (3) 그 전까지 `expect(count)` 류를 `expect.poll` 로. 규모 **M**.

### [P1] e2e 가 프론트 내부(private) 상태에 결합돼 있다 — 리팩터 비용이 테스트로 전가된다
- 위치: 81/135 스펙, `app.focusedTerminal` 38 · `app.edOpenFile` 32 · `app.edWindows` 31 · `app._execRemote` 21 · `app.sbTab` 14 · `app._edActiveEditor` 14 · `app.gitPin` 12 · `app._fgMap` 10 …; `git-head-mobile.spec.ts:172-183` 는 `r._busy = true; r._paint()` 로 내부 플래그를 직접 켠다
- 현상: 밑줄 필드 533회. `fixtures.ts:266-281` 의 `openGitTab` 조차 `app._sbSetTab('repo')` 를 부른다.
- 왜 문제인가: 프론트 리팩터(다른 축 감사 대상 `app-editor.js` 1,155 · `history.js` 1,274 · `branches.js` 990) 때 테스트가 결함이 아니라 이름 변경으로 깨진다. `DRIFT_RECLAIM_SRS §7.6` 이 그 세 파일을 "손대지 않았다" 고 적은 이유의 일부다.
- 조치: 테스트가 쓰는 진입점을 `window.app.testing = { openFile, focusedTerminal, … }` 같은 **공개 계약 한 벌**로 모으고 스펙은 그것만 부른다. 이관은 기계적. 규모 **M**.

### [P1] 스펙이 기능이 아니라 **납품 묶음** 단위로 갈라져 있다
- 위치: `ux-batch6/8/9.spec.ts`, `ux-revision.spec.ts`, `git-ui-revision.spec.ts`(1,246줄), `git-improve.spec.ts`, `regression-focus/pane-scroll.spec.ts` — 8파일
- 현상: 파일명↔SRS 문서명 정확 일치는 **0/135** 다(`ACCESS_ALLOWLIST_SRS` ↔ `access-allowlist` 처럼 관례는 같지만 대소문자·구분자 변환으로도 0). 헤더 주석 기준으로 90 스펙이 SRS 1개, 22 스펙이 2개, 4 스펙이 3~4개를 참조하고 19 스펙은 참조가 없다. 113 SRS 중 82 가 참조된다. 브랜치 화면 하나를 검증하는 파일이 **10개**(`git-branches` 15 · `git-branch-actions` 15 · `branch-menu-unify` 8 · `history-branch-button` 4 · `git-ui-revision` 33 · `git-improve` 11 · `ux-revision` 17 · `ux-batch6/8/9`)다. `ux-batch9.spec.ts:1-6` 은 "묶음 A 편집기 Cmd+S · 묶음 C IME 수식키 · 묶음 B git 자동 갱신" 세 무관 기능을 한 파일에 담는다.
- 왜 문제인가: 기능 하나를 바꾸면 어느 파일이 그 기능을 재는지 grep 으로 찾아야 하고, 같은 표면의 단정이 여러 파일에 흩어져 서로 다른 헬퍼로 같은 것을 누른다(§3 헬퍼 중복). 파일이 병렬 단위(`fullyParallel:false`)이므로 파편화는 부하 분배에도 나쁘다 — `git-ui-revision.spec.ts` 1,246줄이 한 워커에 붙는다.
- 판단: fixtures 층(`fixtures.ts`, `osenv.ts`, `git_fixture.sh`)은 잘 응집돼 있다. 문제는 스펙 층의 **조직 기준**이다. 유지보수 부채 맞다.
- 조치: 배치/리비전 파일 8개를 기능 파일로 흡수(테스트 본문 이동만, 단정 유지). `git-ui-revision` 은 branches/history/diff 로 3분할. 규모 **M**.

### [P1] Go 프로세스·PTY 테스트가 고정 `time.Sleep` 위에 있다
- 위치: `time.Sleep` 94회/25파일. 1초 이상 — `httpapi/daemon_integration_test.go:371` (1,500 ms) · `:615,:655,:671` (1,300 ms), `toolhub/history_shell_test.go:60,98,102,104` (500 ms×4), `sandboxplace/e2e_test.go:61,107,155,215` (700–900 ms)
- 현상: `daemon_integration_test.go:370-371` "Wait for idle threshold to trigger (ticker fires every 1s)" — 스위퍼의 1 s 틱을 `sleep(1.5s)` 로 기다린다. `attnNow` 는 이미 주입 가능한 변수인데(`attention_tool_test.go:37`, `attention_novel_test.go:119,141,162` 에서 교체) 스위퍼 틱 자체는 주입되지 않는다.
- 왜 문제인가: `-race` 를 켠 CI(Windows 러너는 몇 배 느리다, `playwright.config.ts:120` 실측)에서 부하에 따라 걸린다. 그리고 실제로 `verify.yml:49-53` 주석이 "diag 스냅샷 테스트의 경쟁이 CI 를 통과했다" 고 기록한다.
- 조치: `StartAttentionSweeper(stop, tick <-chan time.Time)` 로 틱 주입 → 테스트가 채널에 한 번 보낸다. `history_shell_test` 의 `sleep(500)` 은 이미 있는 `waitFor` 폴링 헬퍼(`toolhub/*_test.go` 에 `waitUntil` 2 · `waitFor` 2 정의)로 대체. 규모 **M**.

---

## 3. P2 (카테고리별)

### 3.1 CI 게이트 누락 (7건)
1. **린터 없음** — `golangci-lint`/`staticcheck` 어느 것도 `verify.yml` 에 없다. `go vet` 만 있다 (`verify.yml:46`). 규모 S.
2. **gofmt 게이트 없음** — 현재 `gofmt -l` 이 `internal/webserver/domain/lsp/session.go` 1건을 보고한다. 규모 S.
3. **e2e TypeScript 타입 검사·린트 없음** — `tsconfig.json`·eslint 설정 부재, `e2e/*.ts` 의 `: any` **595회**. Playwright 는 트랜스파일만 하므로 타입 오류는 런타임에 나온다. 규모 S (`tsc --noEmit -p e2e`).
4. **커버리지 측정·문턱 없음** — 어느 워크플로우도 `-cover` 를 쓰지 않는다. 최소한 `-coverprofile` 아티팩트라도. 규모 S.
5. **darwin 단위 테스트는 릴리스 때만** — `release.yml:31` 매트릭스에만 macOS. `verify.yml` 은 Windows·Linux. 개발 호스트가 darwin 이라 "손으로 본다" 는 판단(`e2e.yml:14-17` D-7)이지만 단위 테스트는 사람이 매 푸시 돌리지 않는다. 규모 S.
6. **`-shuffle` 없음** — `t.Parallel()` 0건(314 테스트 파일)이라 순서 의존이 숨을 수 있다. 규모 S.
7. **`e2e.yml` 주석이 설정과 어긋난다** — `:37` "`workers: 1` · `fullyParallel: false` … 바꿀 수 없다" 와 `:57` "`retries: 2`" 는 각각 현재 `workerCount()` (2~4, `playwright.config.ts:41-46`) 와 `retries: 1` 과 다르다. 샤드 8 의 근거가 "워커 1" 이었다면 샤드 수 재검토 대상. 규모 S.

### 3.2 e2e 테스트 코드 품질 (6건)
1. **하드코딩 대기 224회** — 값 분포 300 ms 39 · 500 ms 37 · 200 ms 17 · 400 ms 16 · 800 ms 12 · … · 8 s 2 · 10 s 1. 합 ≈ 197 s. 두 부류다: (a) "폴링 주기의 여러 배" 부정 단정(`git-view-refresh.spec.ts:382,453`, `git-polling.spec.ts:130,165,216`) — TimerHub 가 유일한 타이머 소유자이므로(`scripts/check-timers.sh`) 가짜 시계 주입으로 결정적으로 바꿀 수 있다; (b) 300–800 ms "안정화" 대기(`git-head-mobile.spec.ts:227,241`) — `expect.poll` 로. 최다 파일 `pane-dom-reconcile` 12 · `git-ui-revision` 10 · `git-polling` 10. 규모 M.
2. **헬퍼 중복** — 스펙 지역 함수 `enter` ×15, `goto` ×11, `gotoMobile` ×8, `addEditor` ×8, `counter` ×8, `makeRepo` ×7, **`waitForInit` ×6 (fixtures 의 것을 가리는 재정의)**, `openGit` ×6, `pin` ×6, `openBranches` ×5. 규모 S–M.
3. **셀렉터 전략** — `data-testid` 0, `getByRole` 4, CSS 클래스 2,266. 스타일 클래스가 곧 테스트 계약이라 CSS 리팩터가 테스트를 깬다. `.first()/.last()` 249회는 모호한 로케이터의 신호. 규모 L (점진).
4. **`git-repo-missing.spec.ts` 가 전량의 1/3 시간을 먹는다** — 파일 합 249 s, M4 61.8 s·M7 35.7 s (30 s 백오프를 실시간으로 기다림). 폴링 주기 설정(`gitStatusInterval`)을 낮춰 주입하면 10 s 안. 규모 S.
5. **파일 내 순서 의존이 병렬화를 막는다** — `fullyParallel:false` (`playwright.config.ts:83-93`, "git 스펙의 여러 묶음"), `beforeAll` 65파일, 모듈 수준 `let` 19파일. 그런데 `git-stash.spec.ts:64-266` 처럼 테스트마다 `copyFx()` 로 자기 저장소를 받는 파일은 이미 독립이다 — 그런 파일부터 `test.describe.configure({mode:'parallel'})`. 규모 M.
6. **git 픽스처가 호스트 gitconfig 를 그대로 본다** — Go 테스트는 `GIT_CONFIG_GLOBAL=/dev/null` 을 20곳에서 세우지만(`git/write/fixture_test.go:39`), e2e 는 `explorer-transfer-ignore.spec.ts:30` 한 곳뿐이다. `git_fixture.sh:47-52` 는 저장소별 `user.*`·`gpgsign` 만 덮는다 — 호스트의 `core.autocrlf`·`init.templateDir`·훅은 새어 들어온다(CI 는 `e2e.yml:79-85` 에서 전역을 손으로 맞춘다). 규모 S.

### 3.3 Go 테스트 품질 (5건)
1. **표 기반 테스트 비율 낮음** — `[]struct{` 24/314 파일, `t.Run` 161회. 대부분이 시나리오 하나짜리 함수. 규모 정보성.
2. **저장소 픽스처 7벌** — `init -b main` + `config user.*` + 첫 커밋 블록이 `httpapi/handlers_fs_ignored_test.go:50`, `httpapi/handlers_runs_worktree_test.go:48`, `gitapi/handlers_git_worktree_test.go:53`, `domain/worktree/worktree_test.go:50`, `git/query/fixture_test.go:41`, `git/core/exec_test.go:46`, `git/write/fixture_test.go:44` 에 복제. 격리 자체는 좋다(`t.TempDir` 529회 vs `os.MkdirTemp` 1회 — `runtime/install_ephemeral_test.go:38` 은 `go-build*` 흉내라 의도적). `internal/shared/testpath` 가 이미 있으니 `gittest` 헬퍼 패키지로. 규모 S.
3. **git 쓰기 도메인의 0% 함수** — `git/write/branch.go:444` `Merge`, `replay.go:27` `Replay`, `operation.go:64` `OperationActions`, `stage.go:42` `Unwrap`. `Merge` 는 `gitapi/handlers_git_branch_test.go:616` 이 가짜 실행기로 핸들러만 덮는다 — 실제 `git merge` 인자·충돌 종료 코드 분기는 미실행. `Replay` 는 기록 재실행(쓰기 재실행 포함) 인데 `rec.Cwd != repo` 거부 조건이 테스트에 없다. 규모 S.
4. **호스트 셸 의존** — `toolhub` 의 셸 테스트가 `$SHELL` 을 그대로 쓴다(`platform/shell.go:142-145`), 조건부 `t.Skip` 110곳. zsh 호스트와 bash 러너가 다른 코드 경로를 지나고 결과가 "돈 항목 수" 로만 보인다(e2e 의 `parity-reporter` 같은 집계가 Go 쪽엔 없다). `DONGMINAL_SHELL` 이 이미 있으니(`shell.go:237`) 테스트에서 `t.Setenv` 로 고정. 규모 S.
5. **전역 훅 교체** — `attnNow = func()…` 를 6곳에서 교체·복원(`attention_*_test.go`). `t.Parallel()` 이 0이라 지금은 안전하지만 `-shuffle`/병렬 도입 시 첫 번째로 깨질 자리. `SetAttnBusyProbe` 처럼 restore 반환형으로 통일. 규모 S.

### 3.4 프론트엔드 단위 테스트 부재 (1건, 우선순위 포함)
- 현상: `web/js` 35,120 LOC(벤더 제외), 단위 테스트 **0**, 테스트 러너·린터 설정 **없음**(`package.json` 은 `@playwright/test` 만). `web/index.html:470-` 에 클래식 `<script>` 85개, `type="module"` 0 — 모듈이 전역 `class`/`function` 으로 노출된다(`hunk-coords.js`, `lanes.js`, `helpers.js:17-143`). 그래서 지금은 **단위 테스트를 e2e 로 돌린다**: `git-hunk.spec.ts:407-448` "묶음 S — 좌표 사상 (단위)" 5건이 브라우저를 띄워 순수 함수를 검사한다.
- 순수 로직 모듈(DOM/window 참조 0~6회, 실측):
  | 우선 | 모듈 | LOC | DOM 참조 | 이유 |
  |---|---|---|---|---|
  | 1 | `web/js/core/hunk-coords.js` | 140 | 0 | 서버 패치 좌표 사상 — 틀리면 **다른 줄이 스테이지/되돌려진다**. 이미 e2e 로 단위 검사 중 |
  | 2 | `web/js/core/timer-hub.js` · `core/event-bus.js` | 385 · 319 | 3 · 4 | `check-timers.sh` 가 앱의 모든 타이머·채널을 이 둘에 강제한다. visibility·single-flight·백오프 규약이 전부 여기 — `event-timer-hub-contract.spec.ts`(633줄) · `timer-hub-bus.spec.ts`(503줄) 가 브라우저로 재는 것의 대부분이 순수 로직 |
  | 3 | `web/js/git/lanes.js` | 274 | 0 | 히스토리 그래프 레인 배치 알고리즘(R1~R4). 입력 DAG → 출력 열 번호, 표 기반에 최적 |
  | 4 | `web/js/core/helpers.js` 경로 함수 (`pathJoin/pathSep/isAbsPath/pathUnder/pathBase/pathRel` `:53-124`) | ~100 | 0 | Windows 구분자 결함이 러너에서만 드러났다(`e2e/osenv.ts:97-113`). `appJoin` 이 그 규약을 **복제**해 들고 있다 |
  | 5 | `web/js/ui/file-tree-store.js` · `git/observer.js` · `git/api.js` · `core/state-registry.js` | 72 · 123 · 121 · 164 | 0 · 0 · 0 · 1 | 캐시·관측·요청 dedupe 규약 |
  | 6 | `web/js/core/constants-git*.js` · `constants-editor.js` | 1,282 · 447 · 500 | 0 | 표 무결성(액션 표의 키 중복·필수 필드) 스냅숏 |
- 조치: 빌드 단계 없이 가려면 `node:test` + `vm.createContext` 로 클래식 스크립트를 순서대로 로드하는 30줄 하네스(ESM 전환은 85개 `<script>` 순서와 `__ASSETV__` 캐시 버스팅에 얽혀 별도 결정). 1~3 부터. 규모 **S** (하네스) + **M** (모듈 6종).

### 3.5 실행 시간·구성 (2건)
1. **Go 테스트 직렬 214 s** — `t.Parallel()` 0. `httpapi` 57 s 가 지배. 패키지 간은 이미 병렬이므로 체감은 ~60 s. 규모 정보성.
2. **e2e CI 매트릭스 16 job × 최대 60 분** (`e2e.yml:66-77`, `CI_E2E_MATRIX_SRS R-3` 이 "받아들인다"). 로컬 13.4 분(3워커) 대비 샤드 8 은 워커가 1 이던 시절 값(§3.1-7). 워커 병렬이 들어온 지금 샤드 4 로 러너 셋업(npm ci·브라우저·go build)을 절반으로 줄일 수 있는지 실측 필요. 규모 S (실험).

---

## 4. 플레이키 흔적 조사 결과

- `test-results/` (20:07~20:12, 진행 중 실행): `.playwright-artifacts-{0,1,2,3}/traces/` 에 `.trace/.network` 1,900여 개. 트레이스 제목에서 `focus-owner` · `git-observe-revive` · `git-live-triggers`(미커밋 신규 스펙) · `git-hunk` 등이 보이며 이는 **현재 돌고 있는** 회차의 것이다. 지시의 3건(git-stash 19단계 · git-view-refresh · history-branch-button)은 이 회차가 디렉터리를 새로 만들며 **소실**됐다.
- `playwright-report/` (14:10 판): `data/*.md` 4건 = 위 P1 표의 flaky 4건 error-context. `data/*.zip` 4건이 그 트레이스. `npx playwright show-trace playwright-report/data/<id>.zip` 으로 열 수 있다.
- 분류 요약: 재렌더 경쟁(DOM 교체) 1 · 테스트 간 상태 누수(워크스페이스 409 → 뷰 소실) 1 · 백그라운드 폴러와 순서 경쟁 1 · 고정 대기 부족 1. `DRIFT_RECLAIM_SRS §7.6` 의 다섯도 같은 두 기전(뷰가 안 섬 · 목록이 안 참)이다.
- 지시가 언급한 `git-stash 19단계` 는 `git-stash.spec.ts:62` describe 이름이고 S1~S10 전부 `copyFx` 로 독립 저장소를 쓴다(`:64-266`) — 순서 의존은 아니며 위 기전의 후보다.

---

## 5. 테스트 없이 배포되면 위험한 경로 — 현재 덮개

| 경로 | 단위 | 통합/verify | e2e | 판정 |
|---|---|---|---|---|
| 도구 생성·입출력·종료 (`toolhub.StartTool`/`kill`) | ○ (`toolhub` 75%, `foreground_test` 등) | ○ `verify` 도구 4항목 | ○ `terminal.spec` 등 | 양호 |
| **데몬 재기동 복원** (`boot.Run`→`LoadAll`→`Restore`) | **×** | **×** | × | **P0** |
| `stop`/포트 킬 (`killPort`, `stopVerifyPID`) | **×** | 간접(`verify` 정리) | — | **P0** |
| git 파괴 쓰기 — reset/branch delete/force/stash drop | ○ `git/write` 89.7%, `TestBranchDelete_DestructiveInRecord`, `TestStashDrop_HintBeforeExecuting`, `TestCheckout_ForceDeclaredDestructive`; `check-gitwrite.sh` 게이트 | — | ○ `git-confirm`·`git-branch-actions`·`git-stash` | 양호 (단 `Merge`·`Replay` 0%) |
| **파일 쓰기** `/api/file/write` | **×** | × | 우회 3건 | **P0** |
| 데몬 IPC (`paned.go`) | △ 70.3% — `paste`·`setBackground`·`backgroundList` 0% | ○ `verify` "데몬 종단 생성"·왕복 | ○ `bg-kill`·`background-ui` | 보통 |
| 접근 허용 목록 (`access.go`) | ○ `access_test.go` 352줄, 단 `startRefresh`/`StartAccessRefresh` 0% | — | ○ `access-allowlist.spec` | 양호 |

---

## 6. 조치 우선순위 (제안)

1. `/api/file/write` 루트 대조 + 테스트 (S)
2. `verify.yml`/`release.yml` `./...` (S) · gofmt 게이트 (S) · `tsc --noEmit` (S)
3. flaky > 0 을 CI 실패로 (S) → 재렌더 경쟁을 제품에서 해소 (M)
4. `persist/Restore` 테스트 + `verify` 에 재기동 항목 (M)
5. `proc.go`/`stop` 테이블 테스트 (M)
6. 프론트 단위 하네스 + `hunk-coords`·`timer-hub`·`lanes` (S+M)
7. 스펙 재조직(배치 8파일 흡수) · 테스트용 공개 계약(`app.testing`) (M+M)
