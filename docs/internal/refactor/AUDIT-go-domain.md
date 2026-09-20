# AUDIT — Go 도메인 계층 + 허브

- 대상: `internal/webserver/domain/**`, `internal/webserver/hub/**` (비테스트 Go 파일 전량)
- 브랜치: `refactor` (`ba13ec92`)
- 성격: **읽기 전용 감사**. 소스는 한 줄도 고치지 않았다.
- 규율: 파일에서 실제로 읽은 것만 사실로 적었다. 구체적 대체 형태를 제시할 수 없는 항목은 넣지 않았다.

## 요약

| 우선순위 | 건수 |
|---|---|
| HIGH | 3 |
| MED | 11 |
| LOW | 6 |
| 성능 기회 | 6 |
| 문서-구현 괴리 | 5 |

가장 중요한 5건:

1. **[HIGH] `run.Store` 의 조회가 잠금 밖으로 `Members` 배열과 `*Worktree` 포인터를 그대로 내보낸다** — 같은 위험을 `AppendMessage` 가 `Messages` 에 대해서만 이미 고쳐 두었다. 제자리 수정(`Report`·`Succeed`·`MarkWorktrees`)과 겹치면 데이터 레이스다.
2. **[HIGH] `query.StatusOf` 만 `StdoutTruncated` 를 보지 않는다** — 다른 8개 조회는 전부 본다. `--untracked-files=all` + 1MiB 출력 상한이라, FR-GDT-22 가 겨냥한 바로 그 저장소(수만 파일)에서 status 가 파싱 오류로 죽거나 조용히 짧아진다.
3. **[HIGH] LSP 요청마다 플러그인 칸 전체를 다시 읽는다** — `session()` 이 세션 캐시를 보기 **전에** `ext.Resolve` 를 부르므로, 마우스 호버 한 번이 `ReadDir` + 팩 수만큼의 JSON 파싱 + `LookPath` 를 돌린다.
4. **[MED] `worktree`·`submodule` 의 `Runner` 가 `ctx` 를 받지 않는다** — `Remove(ctx, …)` 의 ctx 가 git 프로세스에 닿지 못하고, FR-GXU-3 의 "더 짧은 ctx 가 이긴다"가 이 두 도메인에서만 성립하지 않는다.
5. **[MED] `store.Store.Status` 의 single-flight 가 첫 호출자의 ctx 를 공유한다** — gitwatch 회차(20초 시한)가 앞섰으면, 그 뒤에 붙은 브라우저 요청이 회차의 취소를 자기 실패로 받는다.

---

## HIGH

### [HIGH] run.Store 의 조회가 잠금 밖으로 내부 배열·포인터를 내보낸다
- 위치:
  - `internal/webserver/domain/run/store_query.go:14` (`Get`), `:24` (`List`), `:34` (`MemberByTool`), `:48` (`FindMember`)
  - `internal/webserver/domain/run/store_write.go:173` (`Report` — `m := &rec.Members[mi]` 제자리 수정), `:224` (`Close`), `:247` (`Sweep`), `:264` (`Delete`), `:320` (`MarkWorktrees` — `w.Removed` 제자리 수정)
  - `internal/webserver/domain/run/store_context.go:175` (`ObserveContext`), `:365` (`Succeed`)
  - 소비자 증거: `internal/webserver/httpapi/handlers_runs_peers.go:84` — `for _, rec := range s.Runs.List() { for _, m := range rec.Members { … } }` 를 잠금 밖에서 읽는다
- 현상: `Record` 는 값 복사지만 `Members []Member` 와 `Worktree *Worktree` 는 저장소 내부를 그대로 가리킨다.
- 비용: `List()` 가 돌려준 목록을 훑는 동안 다른 요청이 `Report` 로 `Members[mi]` 를 제자리 수정하면 `go test -race` 가 잡는 진짜 레이스다. `AddMember`·`Succeed` 의 `append` 가 용량 안에서 일어나면 같은 배열에 쓴다. `MarkWorktrees` 는 호출자가 `Sweep`/`Close` 에서 받아 든 **그 포인터**를 고친다. 이 패키지는 이미 같은 위험을 알고 있다 — `store_messages.go:61-67` 이 `Messages` 에 대해서만 *"Get·List 가 돌려준 Record 는 이 슬라이스의 배열을 공유하므로 … 읽는 쪽이 잠금 밖이라 데이터 레이스다"* 라고 적고 새 배열로 옮긴다. `Members`·`Worktree` 는 그 처방에서 빠져 있다.
- 제안: 이미 있는 `cloneRuns` 의 1건 버전을 만들어 **모든 반환 경로**를 통과시킨다.
  ```go
  // store.go 에 추가 — cloneRuns 가 이미 하는 일의 단건 판이다
  func cloneRun(r Record) Record   // Members 복사 + Worktree 값 복제 + Messages 복사
  ```
  `Get`·`List`·`MemberByTool`·`FindMember`·`Close`·`Sweep`·`Delete`·`Report`·`Succeed`·`ObserveContext`·`mutateMember` 의 반환값을 전부 이것으로 감싼다. `Member` 단건 반환도 `Worktree` 포인터를 들고 나가므로 `cloneMember` 가 함께 필요하다.
- 위험도: LOW (반환값 복사는 호출자 동작을 바꾸지 않는다 — 다만 호출자가 반환된 포인터로 저장소를 고치고 있었다면 그것이 드러난다. 그런 호출자가 있는지 확인이 먼저다)
- 공수: M

### [HIGH] query.StatusOf 만 출력 잘림을 보지 않는다
- 위치: `internal/webserver/domain/git/query/status.go:306-317`
- 대조군 (모두 `StdoutTruncated` 를 검사하고 명시적 오류를 낸다): `query/log.go:120`, `query/refs.go:77`, `query/diff.go:160`·`:401`, `query/diff_image.go:117`, `query/blame.go:88`, `query/commitdetail.go:77`, `write/stash.go:107`·`:318`
- 현상: `StatusOf` 는 `s.Exec(… "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all")` 의 결과를 잘림 여부를 보지 않고 곧장 `ParseStatusV2` 에 넘긴다.
- 비용: 출력 상한은 `core.DefaultMaxOutput` = 1MiB 이고(`core/exec.go:19`), `--untracked-files=all` 은 접힌 디렉터리를 전부 펼친다(FR-GIT-215). 경로 평균 50B 로 잡아도 약 2만 항목에서 상한에 닿는다 — `status.go:57-59` 의 주석이 직접 지목한 *"변경·미추적 파일이 수만 개인 저장소(빌드 산출물, `node_modules` 미무시)"* 가 그 조건이다. 잘림은 NUL 경계를 가리지 않으므로 두 결말 중 하나다:
  - 마지막 레코드가 중간에 끊긴다 → `ParseStatusV2` 가 *"필드가 N개다"* 또는 *"알 수 없는 레코드"* 로 실패 → **status 가 영구히 실패**
  - 우연히 경계에 맞으면 → **조용히 짧은 목록**. `Total` 도 함께 틀린다
  파급 범위가 표시에 그치지 않는다: `store.observe`(→ gitwatch 회차 전체), `write.StashPush`(stash.go:144), `write.CleanUntracked`(uncommitted.go:75), `write.Rebase`(branch.go:466), `write.PushSpec`(remote.go:203) 이 전부 이 함수를 지난다 — 그 저장소에서는 stash·clean·rebase·push 가 함께 막힌다.
- 제안: 다른 조회와 **같은 형태**로 막는다.
  ```go
  if out.StdoutTruncated {
      return Status{}, fmt.Errorf("git status 의 출력이 상한(%dB)에서 잘렸다: …", s.MaxOutput())
  }
  ```
  다만 status 는 실패로 끝낼 수 없는 표면이므로(배지·관측이 여기 딛는다) 한 걸음 더 낫다: `Exec` 대신 상한을 키운 호출을 쓰거나, 잘렸을 때 `Status{Truncated: {"output": -1}}` 로 **잘렸다는 사실 자체를 실어** FR-GDT-23 의 규약을 출력 상한에도 넓힌다.
- 위험도: MED (동작이 바뀐다 — 지금 조용히 짧게 답하던 저장소가 명시적 사실을 답하게 된다)
- 공수: S (검사만) / M (Truncated 확장까지)

### [HIGH] LSP 요청마다 플러그인 선언 전체를 다시 읽는다
- 위치:
  - `internal/webserver/domain/lsp/manager.go:98` — `s.Ext.Resolve(filepath.Ext(path), s.Overrides)`
  - `internal/webserver/domain/lsp/manager.go:111` — 세션 캐시 조회는 **그 뒤**다
  - `internal/webserver/domain/ext/service.go:94` `Resolve` → `:47` `Manifests` → `ext/load.go:19` `Load` (`os.ReadDir` + 팩마다 `os.ReadFile` + `ParseManifest`)
  - `ext/locate.go:237` `Locate` → `exec.LookPath` + `ManagedExeFound` 의 `os.Stat` 들 + `readiness` 의 `LookPath` 한 번 더
- 현상: 이미 살아 있는 세션을 쓰는 요청도 매번 격리 칸을 전량 재파싱하고 PATH 를 훑는다.
- 비용: 이 경로에 서는 것은 `Definition`·`References`·**`Hover`** 다. 호버는 편집기에서 커서를 움직일 때마다 뜬다 — 사용자 조작 한 번이 디렉터리 스캔 1회 + 팩 수만큼의 파일 읽기·JSON 파싱 + `LookPath` 2회(PATH 항목 수 × 2회의 stat)가 된다. `Locate` 는 또 호출마다 `&Missing{Kind: MissingNotFetched}` 를 할당하고 `st.Found` 면 곧바로 버린다(`locate.go:263`).
- 제안: 캐시의 자리를 나눈다. **`FR-EXT-33`("상태는 캐시가 아니라 관측")은 설정 화면의 요구이지 LSP 핫패스의 요구가 아니다.**
  - ① `lsp.Session` 이 이미 (root, descID) 로 키잉되므로, 해소 결과를 세션에 붙이고 `manager.go` 의 순서를 뒤집는다 — 캐시 히트면 `Resolve` 를 아예 부르지 않는다. 확장자→descID 매핑만 가벼운 별도 표로 둔다.
  - ② 또는 `ext.Service` 에 mtime 게이트 캐시를 넣는다: `PluginsDir` 의 `os.Stat` 한 번으로 `Load` 결과 재사용 여부를 정하고, 설정 화면의 `Status()` 는 그 캐시를 강제 무효화(`Service.Invalidate()`)한 뒤 부른다 — 그러면 FR-EXT-9c(고치면 다음 관측이 읽는다)가 그대로 지켜진다.
  ①이 더 작고 LSP 밖을 건드리지 않는다.
- 위험도: LOW (①), MED (② — 관측 규약을 건드린다)
- 공수: M

---

## MED

### [MED] worktree·submodule 의 Runner 가 ctx 를 버린다
- 위치:
  - `internal/webserver/domain/worktree/worktree.go:75` (`type Runner func(dir string, args ...string)`), `:204-207` (`svc.ExecUnguarded(context.Background(), …)`)
  - `internal/webserver/domain/submodule/submodule.go:62`, `runGit` 의 `context.Background()`
  - 그 ctx 를 받아 놓고 못 쓰는 자리: `worktree/remove.go:38` `Remove(ctx, …)`, `:105` `removeWithRetry(ctx, …)`
- 현상: `Remove` 는 ctx 를 받지만 그것이 닿는 곳은 **되풀이 사이의 대기**뿐이다(`remove.go:116-121`). 실제 `git worktree remove` 는 `context.Background()` + 고정 180초로 돈다.
- 비용: 요청이 끊기거나 서버가 종료해도 git 한 번이 최대 180초를 더 돈다 — 그동안 `repoLock(s.Repo)` 를 쥔 채이므로 **같은 저장소의 다른 worktree 조작 전부가 함께 막힌다**. `removeWithRetry` 의 주석은 *"되풀이에는 예산이 있고 ctx 로 끊긴다"* 고 적었는데 절반만 참이다. `submodule update --init` 은 원격을 clone 하므로 같은 구멍이 더 길게 열린다.
- 제안: 서명에 ctx 를 넣는다 — 두 패키지가 같은 모양이므로 함께 바꾼다.
  ```go
  type Runner func(ctx context.Context, dir string, args ...string) (string, error)
  ```
  `Create`·`Rollback`·`BranchExists`·`List`·`isDirty`·`gone`·`deleteBranch` 와 submodule 의 `List`·`Update`·`Sync`·`runPathOp` 에 ctx 를 얹는다. 테스트의 가짜 Runner 도 같은 서명을 따른다.
- 위험도: MED (서명 변경이 두 패키지의 호출처 전부를 건드린다)
- 공수: M

### [MED] store.Status 의 single-flight 가 첫 호출자의 ctx 를 공유한다
- 위치: `internal/webserver/domain/git/store/store.go:130-163`
- 현상: `s.inflight` 를 세운 첫 호출자의 `ctx` 로 `st.observe(ctx, repo)` 가 돈다. 뒤에 붙은 호출자는 `<-f.done` 으로 그 결과와 그 오류를 **그대로** 받는다.
- 비용: 첫 호출자가 gitwatch 회차일 수 있다 — `hub/gitwatch.go:578` 이 `GitWatchRoundTimeout`(20초) 컨텍스트로 `Tick` 을 돌리고 `observe` 가 `w.git.Status(ctx, repo)` 를 부른다(`gitwatch.go:512`). 회차가 시한을 넘기거나 종료로 취소되면, 그 flight 에 붙어 있던 브라우저 요청이 `ErrCanceled`/`ErrTimeout` 을 받는다 — 자기 요청은 멀쩡한데도. 반대 방향도 같다: 브라우저가 탭을 닫아 요청이 끊기면 그 flight 를 공유하던 감시 회차가 함께 죽는다.
- 제안: flight 의 수명을 호출자에게서 떼어 낸다.
  ```go
  // store.go — flight 를 띄울 때
  fctx, fcancel := context.WithTimeout(context.WithoutCancel(ctx), st.flightTimeout)
  ```
  `flightTimeout` 은 `core.DefaultTimeout`(30초)을 기본으로 새 `StoreOption`(`WithFlightTimeout`)로 둔다. 뒤따르는 호출자는 `select { case <-f.done: …; case <-ctx.Done(): return … }` 으로 **자기 ctx 로 빠져나갈 수** 있게 한다 — 지금은 `<-f.done` 만 기다려 자기 취소를 무시한다(`store.go:140`).
- 위험도: MED (취소 의미론이 바뀐다 — 테스트로 고정해야 한다)
- 공수: M

### [MED] Exec / ExecWrite / ExecUnguarded 의 오류 분류가 세 벌이다
- 위치: `core/exec.go:106-117`, `core/write.go:140-148`, `core/unguarded.go:84-91`
- 현상: 세 진입점이 글자 그대로 같은 `switch` 를 갖는다 — `err == nil && out.ExitCode != 0` → `&ExecError{…, kind: classify(ctx2, out.Stderr)}`, `err != nil && !classified(err)` → `fmt.Errorf("%w: %v", k, err)`.
- 비용: 분류 규칙이 늘거나(새 sentinel) 감싸는 방식이 바뀌면 세 자리를 함께 고쳐야 한다. 이 패키지가 스스로 세운 규칙 — *"판정이 두 벌이면 한쪽만 고쳐진다"* — 이 자기 안에서 깨져 있다. `deny`/`denyWrite`/`denyUnguarded` 도 같은 3중복이다(`Output{ExitCode: -1}` + 기록 + 반환).
- 제안:
  ```go
  // core/exec.go
  func finishExec(ctx context.Context, argv []string, dir string, out Output, err error) error
  ```
  세 진입점이 `err = finishExec(ctx2, argv, dir, out, err)` 한 줄로 부른다. `deny` 는 기록 함수만 인자로 받는 하나로 접는다:
  ```go
  func (s *Service) denyWith(err error, rec func(Output)) (Output, error)
  ```
- 위험도: LOW (순수 추출, 동작 불변)
- 공수: S

### [MED] worktree.runGit 과 submodule.runGit 이 쌍둥이다 (차이는 trim 하나)
- 위치: `worktree/worktree.go:204-224`, `submodule/submodule.go` 의 `runGit`
- 현상: 두 함수가 같은 일을 한다 — `ExecUnguarded` 를 `Timeout: opTimeout`(양쪽 다 180초) + 자기 `Reason` 으로 부르고, `core.ErrGitMissing` 을 자기 sentinel 로 바꿔 들고, stdout+stderr 를 이어 문자열로 낸다. **다른 것은 딱 하나다**: worktree 는 `strings.TrimSpace`, submodule 은 `strings.TrimRight(…, "\r\n")`.
- 비용: 그 한 글자 차이가 실측으로 잡힌 결함이다 — submodule 쪽 주석이 *"`worktree.runGit` 는 `TrimSpace` 하지만 그것을 그대로 베끼면 안 된다 — `submodule status` 는 첫 글자가 상태"* 라고 적어 두었다. 즉 **복제가 이미 한 번 사고를 냈고 그 사실이 주석으로만 남아 있다.** 위 항목의 ctx 배선을 하려면 지금은 두 곳을 똑같이 고쳐야 한다.
- 제안: 차이를 **인자로 드러내** 한 곳으로 모은다.
  ```go
  // core/unguarded.go
  type TrimMode int
  const (TrimBoth TrimMode = iota; TrimTrailingNewline)
  func (s *Service) RunUnguardedText(ctx context.Context, dir string, argv []string,
      timeout time.Duration, reason string, trim TrimMode) (string, error)
  ```
  두 패키지는 각자의 sentinel 매핑만 남긴다. 그러면 "왜 트림이 다른가"가 주석이 아니라 **호출 인자**로 보인다.
- 위험도: LOW
- 공수: S

### [MED] BranchDelete 가 중간 실패에서 거짓 hint 를 남긴다
- 위치: `internal/webserver/domain/git/write/branch.go` — `BranchDelete` 의 루프
  ```go
  for _, n := range o.Names {
      oid, err := query.BranchOid(s, ctx, repo, n)
      if err != nil {
          return denied(), plan, err        // ← 앞선 n 들의 hint 는 이미 기록됐다
      }
      plan.Oids = append(plan.Oids, oid)
      s.AddHint(branchDeleteHint(repo, n, oid))
  }
  ```
- 현상: 두 번째 이름의 `BranchOid` 가 실패하면 첫 번째 이름의 recovery hint 는 이미 HintLog 에 들어갔는데, `ExecWrite` 는 **한 번도 돌지 않는다**.
- 비용: 그 자리의 주석이 *"없는 브랜치의 복구 안내는 거짓이므로 실행도 hint 도 하지 않는다"* 라고 약속하는데, 다중 삭제에서 그 약속이 깨진다. 사용자는 Console 에서 *"지우기 전 feat 는 abc123 를 가리켰다"* 를 읽지만 `feat` 는 그대로 있다 — hint 는 파괴적 동작의 유일한 근거이고(FR-GIT-92), 거짓 hint 는 없는 hint보다 나쁘다.
- 제안: 읽기와 기록을 두 패스로 가른다.
  ```go
  oids := make([]string, 0, len(o.Names))
  for _, n := range o.Names { oid, err := query.BranchOid(…); if err != nil { return denied(), plan, err }; oids = append(oids, oid) }
  plan.Oids = oids
  for i, n := range o.Names { s.AddHint(branchDeleteHint(repo, n, oids[i])) }
  ```
- 위험도: LOW
- 공수: S

### [MED] "분류되지 않은 ExecError 를 답으로 읽는" 관용구가 다섯 벌이다
- 위치:
  - `query/head.go:16-22` (`HasHead`)
  - `query/branch.go:64-70` (`LocalBranchExists`)
  - `query/branch.go:214-221` (`isAncestor` — exit 코드까지 본다)
  - `query/branch.go:76-84` (`refNameError` — stderr 문구까지 본다)
  - `query/diff.go:280-292` (`diffAbsent` — stderr 문구 목록까지 본다)
- 현상: 다섯 곳이 전부 `var xe *core.ExecError; errors.As(err, &xe) && xe.Unwrap() == nil` 로 시작한다. 그 뒤의 조건만 각자 다르다(없음 / exit 코드 / stderr 문구).
- 비용: `ExecError` 의 분류 규약이 바뀌면 다섯 곳을 찾아야 한다. 더 중요한 것은 읽기다 — 이 관용구가 뜻하는 것("git 이 분류 불가한 실패를 냈다 = 우리가 문구로 판정해도 되는 자리")이 이름을 갖지 못해서, 읽는 사람이 매번 `Unwrap() == nil` 의 의미를 되짚어야 한다.
- 제안: `core` 에 이름을 준다.
  ```go
  // core/errors.go — "분류되지 않은 실패"는 문구·exit 코드로 판정해도 되는 자리다
  func PlainExit(err error) (*ExecError, bool)
  ```
  다섯 곳이 `if xe, ok := core.PlainExit(err); ok { … }` 로 바뀐다.
- 위험도: LOW
- 공수: S

### [MED] indexOfMember 의 주석과 구현이 다르다 — 닫힌 Run 의 멤버를 집는다
- 위치: `internal/webserver/domain/run/store_context.go:452-462`
  ```go
  // indexOfMember 는 열린 Run 에서 멤버 하나를 찾는다. 호출자가 s.mu 를 쥔다.
  func (s *Store) indexOfMember(memberID string) (runIdx, memberIdx int) {
      for ri := range s.runs {          // ← State 를 보지 않는다
  ```
- 현상: 주석은 "열린 Run 에서"라고 하지만 상태를 거르지 않는다.
- 비용: `Succeed`(`:359`)는 그 뒤에 `State != Open` 을 따로 확인하므로 무사하지만, `HandoffWaiting`(`:469`)과 `GiveUpHandoff`(`:491`)는 확인하지 않는다 — 닫힌 Run 의 멤버 id 로 두 함수가 답하고 `GiveUpHandoff` 는 닫힌 Run 을 **저장까지** 한다(`_ = s.save()`). `findByTool` 이 세운 규약 *"닫힌 Run 의 멤버 행은 기록으로 남지만 그 도구는 더 이상 청구되지 않는다"*(`store_query.go:64-66`)와 어긋난다.
- 제안: 주석을 구현에 맞추거나(`FindMember` 와 같은 "상태 무관" 규약으로) 구현을 주석에 맞춘다. 후자를 권한다 — 두 호출자가 실제로 원하는 것이 그쪽이다.
  ```go
  func (s *Store) indexOfOpenMember(memberID string) (runIdx, memberIdx int)  // State == Open 만
  ```
  `Succeed` 의 중복 `State != Open` 검사는 그대로 둔다(거부 사유가 `ErrRunClosed` 로 구체적이어야 한다).
- 위험도: LOW
- 공수: S

### [MED] lsp.Service.session 이 같은 키에 프로세스를 두 번 띄울 수 있다
- 위치: `internal/webserver/domain/lsp/manager.go:107-153`
- 현상: 캐시 미스 뒤 `s.mu` 를 **놓고** `newSession(...)` 이 프로세스를 띄운다(`:138`). 그 사이에 들어온 두 번째 요청도 미스를 보고 또 띄운다. 나중에 도착한 쪽이 `sess.Close()` 로 자기 것을 죽인다(`:149`).
- 비용: `gopls` 기동은 큰 저장소에서 모듈 그래프를 읽고 수백 MB 를 쓴다(`manager.go:14-16` 의 주석이 그 사실을 근거로 IdleAfter 를 정했다). 편집기에서 파일 두 개를 동시에 열면 그 비용을 두 번 내고 한쪽을 버린다. 주석은 *"둘을 살려 두면 프로세스가 샌다"* 만 말하고 **띄우는 비용**은 다루지 않는다.
- 제안: 키별 in-flight 표로 두 번째를 기다리게 한다.
  ```go
  // Service 에 추가
  starting map[string]chan struct{}   // key → 기동이 끝나면 닫힌다
  ```
  미스 → `starting[key]` 가 있으면 잠금을 놓고 `<-ch` 뒤 재시도, 없으면 자기가 채널을 세우고 띄운 뒤 `close(ch)`. `golang.org/x/sync/singleflight` 가 이미 의존에 있으면 그것을 써도 같다.
- 위험도: LOW
- 공수: M

### [MED] AttnTracker 의 nil 콜백 가드가 경로마다 다르다
- 위치: `internal/webserver/hub/attn_tracker.go`
  - 검사하는 곳: `:125` (`Forget` — `onClear != nil`), `:455` (`SweepIdleAt` — `onAttn != nil`)
  - 검사하지 않는 곳: `:184` (`FeedOutput` → `t.onAttention`), `:206` (`SignalAttention`), `:218` (`SignalAgentEvent`), `:241` (`attend` → `t.onAttentionClear`), `:327` (`ClearAllAttention` → `onClear`), `:352` (`SetActivity` → `t.onActivity`)
- 현상: 같은 세 콜백을 두 경로는 nil 검사하고 여섯 경로는 하지 않는다.
- 비용: `NewAttnTracker` 가 셋을 모두 채우므로 지금은 터지지 않는다 — 그러나 그 사실이 코드에 없고, 검사하는 두 곳이 "nil 일 수 있다"고 말하고 있다. 읽는 사람은 어느 쪽이 참인지 알 수 없고, 필드가 setter 없이 구조체 리터럴로 만들어지는 테스트가 하나만 생기면 패닉이다.
- 제안: 불변을 한쪽으로 못박는다. **채워져 있다**가 맞으므로 `Forget`·`SweepIdleAt` 의 nil 검사를 걷고, 구조체 주석에 *"세 콜백은 `NewAttnTracker` 가 반드시 채운다 — nil 인 트래커는 없다"* 를 적는다. 반대로 nil 을 허용하려면 세 개의 얇은 메서드(`t.fireAttention(id, reason)` 등)를 두고 여섯 경로를 전부 그리로 보낸다.
- 위험도: LOW
- 공수: S

### [MED] Rebase 가 HEAD oid 하나 때문에 전체 status 를 돌린다
- 위치: `internal/webserver/domain/git/write/branch.go:466`
  ```go
  st, err := query.StatusOf(s, ctx, repo)   // 쓰는 것은 st.Oid 하나뿐
  s.AddHint(rebaseHint(repo, o, st.Oid))
  ```
- 현상: hint 에 실을 HEAD 커밋 하나를 얻으려고 `git status --porcelain=v2 -z --branch --untracked-files=all` 을 돌린다.
- 비용: 큰 저장소에서 가장 비싼 읽기 하나를 값 하나 때문에 부른다. 더 나쁜 것은 결합이다 — 위 [HIGH] status 잘림 결함이 있는 저장소에서는 **rebase 자체가 막힌다**. `rev-parse` 는 이미 읽기 허용 목록에 있다(`core/guard.go:20`).
- 제안: `query/head.go` 에 한 줄짜리 조회를 더한다 — 그 파일에는 이미 `HasHead` 가 같은 명령을 쓴다.
  ```go
  // HeadOid 는 HEAD 가 가리키는 커밋이다. 커밋이 없으면 빈 문자열이며 오류가 아니다.
  func HeadOid(s *core.Service, ctx context.Context, repo string) (string, error)
  // refOid 와 같은 몸통: s.Exec(ctx, repo, "rev-parse", "--verify", "HEAD")
  ```
  `write.Rebase` 를 이것으로 바꾼다. `write/remote.go:203` 은 `HasUpstream`·`Detached`·`Branch` 셋을 쓰므로 그대로 두고, `write/stash.go:144`·`uncommitted.go:75` 는 파일 목록이 필요하므로 그대로 둔다.
- 위험도: LOW
- 공수: S

### [MED] "SucceededFrom 멤버 찾기"가 세 벌이다
- 위치: `run/store_context.go:480-486` (`HandoffWaiting`), `:502-512` (`GiveUpHandoff`), `:527-532` (`HandoffClause`)
- 현상: 셋 다 "이 Run 의 멤버 중 `ID == m.SucceededFrom` 인 것"을 각자 선형 탐색한다. 셋이 보는 필드만 다르다(`HandoffPending`+`HandoffSummary` / `HandoffPending` / `HandoffSummary`).
- 비용: 승계 사슬의 규약(누가 전임자인가, 무엇이 "아직 쓰고 있다"인가)이 세 곳에 흩어져 있다. `HandoffPending` 의 의미가 바뀌면 세 곳을 함께 고쳐야 하며, 두 곳은 Store 메서드이고 한 곳은 순수 함수라 함께 눈에 들어오지 않는다.
- 제안: 레코드 위의 순수 조회 하나로 모은다.
  ```go
  // Record 에 — 이 멤버의 전임자 행. 승계가 아니면 (Member{}, false).
  func (r Record) predecessorOf(m Member) (Member, bool)
  ```
  세 함수가 이것을 딛고 각자 필요한 필드만 읽는다. `HandoffClause` 는 이미 `Record` 를 받으므로 그대로 쓰고, 두 Store 메서드는 `s.runs[ri]` 를 넘긴다.
- 위험도: LOW
- 공수: S

### [MED] ext.Locate 가 찾은 뒤에도 readiness 를 계산한다
- 위치: `internal/webserver/domain/ext/locate.go:260-265`
  ```go
  st.CanInstall, st.Missing = l.readiness(m)
  if st.Found { st.Missing = nil }
  ```
- 현상: 실행 파일을 이미 찾았어도 `readiness` 가 전부 돈다 — 런타임마다 `LookPath`, toolchain 이면 `LookPath` 한 번 더, archive 면 타깃 표 조회. 그리고 `Missing` 은 버려진다.
- 비용: `readiness` 는 `runtimeReadyIn` 을 통해 `LookPath` + `RuntimeExe`(`os.Stat`)를 돌린다. 위 [HIGH] 의 LSP 핫패스에 이것이 통째로 실려 있다. `CanInstall` 은 찾은 뒤에도 뜻이 있으므로(재설치 버튼) 계산 자체를 없앨 수는 없지만, **찾았으면 `Missing` 계산은 필요 없다**.
- 제안: `readiness` 를 두 갈래로 나눈다 — `canInstall(m) bool` 과 `missingOf(m) *Missing`. `Locate` 는 `st.Found` 면 앞의 것만 부른다. 둘이 같은 판정을 딛으므로 공통 몸통(`l.blockers(m)`)을 두고 그 결과를 각자 해석한다.
- 위험도: LOW
- 공수: S

---

## LOW

### [LOW] ReadSignature 의 문서와 실제 비용이 다르다
- 위치: `query/signature.go:78` (*"read 1회 + stat 2회다"*), `:14` (*"0.02ms"*), `hub/gitwatch.go:88` (*"read 1회 + stat 몇 번이다"*)
- 현상: 실제로는 `os.ReadFile(HEAD)` + `stat(index)` + (`stat(ref)` 또는 `stat(packed-refs)`) + `refsTree`(최대 256 디렉터리의 `ReadDir`+`Stat`, 항목마다 이름 해싱) + `extrasOf`(stat 3회 + `dirShape` 의 `Stat`+`ReadDir`) 다.
- 비용: 숫자 자체가 틀린 것보다, 그 숫자가 **설계 근거로 쓰이고 있다**는 것이 문제다 — `gitwatch.go:38-41` 이 fsnotify 를 기각하며 든 근거가 "1차 게이트가 싸다"이고, FR-GDT-1 의 2단 구조 전체가 그 위에 선다. 브랜치가 수백 개인 저장소의 `refs/heads` ReadDir 이 1초마다 × 감시 저장소 수만큼 돈다.
- 제안: 주석을 실제에 맞추고(`"read 1회 + stat 5~8회 + refs 트리 ReadDir"`), FR-GDT 의 예산(NFR-GDT-2·3)이 여전히 지켜지는지 벤치마크 하나로 못박는다 — 아래 성능 절의 측정 항목과 같다.
- 위험도: LOW (주석만)
- 공수: S

### [LOW] wsentry.Roots 가 호출마다 MkdirAll 을 두 번 한다
- 위치: `wsentry/wsentry.go:146-161` → `:93` (`Notes`), `:107` (`Plugins`)
- 현상: 읽기처럼 생긴 `Roots()` 가 `os.MkdirAll` 을 두 번 부른다.
- 비용: `Roots()` 는 파일 API 의 루트 가드(FR-EDT-113)이므로 파일 조작마다 돈다 — 요청당 syscall 2회. 부작용이 이름에 없어서, 이 함수를 "목록만 읽는다"로 읽는 호출자가 생기기 쉽다.
- 제안: 보장은 기동에서 한 번 한다(`Store.EnsureDirs()` 를 배선이 부른다). `Notes`/`Plugins` 는 `os.Stat` 만 하고, 없으면 `ErrUnavailable` 로 그 행만 빠진다 — 지금의 실패 규약(FR-NOT-11)과 같다.
- 위험도: LOW
- 공수: S

### [LOW] BroadcastAndAwait 의 타이머가 정리되지 않는다
- 위치: `hub/commands.go:149-155` — `case <-time.After(timeout):`
- 현상: 응답이 먼저 오면 타이머는 만료까지 런타임 힙에 남는다.
- 비용: 기본 3초라 작지만, 이 경로는 생성 명령마다 돈다. `time.NewTimer` + `defer t.Stop()` 이 같은 줄 수다.
- 제안: `jobs/exec.go:121` 의 `waitFor` 가 이미 그 형태다 — 같은 모양으로 맞춘다.
- 위험도: LOW
- 공수: S

### [LOW] attnPaneState.attnCarry 의 단일 작성자 불변식이 적혀 있지 않다
- 위치: `hub/attn_tracker.go:61` (필드), `:174-188` (`FeedOutput` 에서 잠금 없이 읽고 쓴다)
- 현상: `attnCarry` 는 `sync/atomic` 이 아닌 평범한 `[]byte` 인데 `t.mu` 밖에서 수정된다. 안전한 이유는 `FeedOutput` 의 호출자가 하나(`cmd/dongminal/app.go:123`, toolclient 의 `readLoop` 고루틴)이기 때문이다.
- 비용: 직접 모드의 대응물에는 이 불변식이 적혀 있다 — `toolhub/tool_attention.go:12` (*"Called from the readPTY goroutine only; attnCarry needs no lock"*), `toolhub/tool.go:71`. 데몬 모드 쪽만 빠져 있어서, 이 파일만 읽는 사람은 잠금 누락으로 읽는다. 이 구조체의 다른 필드는 전부 `atomic.*` 이라 대비가 더 두드러진다.
- 제안: 같은 문장을 필드 옆에 적는다 — *"`attnCarry` 는 `FeedOutput` 만 만지고 그 호출자는 toolclient readLoop 하나다 (toolhub.Tool.attnCarry 와 같은 규약)."*
- 위험도: LOW (주석만)
- 공수: S

### [LOW] submodule.Manager.run 은 의미 없는 위임이다
- 위치: `submodule/submodule.go` — `func (m *Manager) run(dir string, args ...string) (string, error) { return m.git(dir, args...) }`
- 현상: 인자를 그대로 넘기기만 한다. 호출처는 `List` 와 `runPathOp` 둘뿐이다.
- 비용: 읽는 사람이 `run` 에 가드나 변환이 있는지 확인하러 가야 한다 — 없다.
- 제안: 지우고 `m.git(...)` 을 직접 부른다. (위 ctx 배선 항목을 할 때 함께 정리하면 비용이 0 이다.)
- 위험도: LOW
- 공수: S

### [LOW] 구독 채널 버퍼가 보존 상한과 같다
- 위치: `jobs/job.go:359` — `sub := &jobSub{ch: make(chan Line, j.lineCap)}` (`JobLineCap` = 2000)
- 현상: 구독 하나가 `Line` 2000개 분량의 채널을 든다. `Subscribe` 가 보존분 재생에 그 버퍼를 쓰므로 크기 자체에는 근거가 있다.
- 비용: `Line` 은 `{uint64, string, string}` 이고 텍스트는 최대 `JobLineMax`(4096B)다. 한 작업에 브라우저 4개가 붙으면 최악 32MB 가 채널에 잡힌다. `hub` 쪽은 같은 문제를 `cmdSubQueue = 16` + 드롭으로 풀었다(`commands.go:186`).
- 제안: 재생과 실시간을 나눈다 — 재생은 `Subscribe` 가 슬라이스로 돌려주고(`([]Line, <-chan Line, func(), bool)`), 채널 버퍼는 `hub` 와 같은 작은 값(16~64)으로 줄인다. 드롭 규약은 이미 있다(`job_run.go:63-70`, "놓친 줄은 `after=<seq>` 재연결이 되찾는다").
- 위험도: MED (구독 API 가 바뀐다 — httpapi 의 SSE 핸들러를 함께 고쳐야 한다)
- 공수: M

---

## 성능 개선 기회

### P1. LSP 핫패스의 플러그인 재파싱 (위 [HIGH] 3 과 같은 항목)
- 예상 효과: 호버·정의 이동 한 번당 `ReadDir` 1 + `ReadFile`·JSON 파싱 N(팩 수) + `LookPath` 2 제거. 팩 3개 기준 syscall 10여 회가 0 이 된다.
- 측정: `go test -bench` 로 `ext.Service.Resolve` 를 팩 3개짜리 임시 디렉터리에 대고 잰다. 또는 `lsp.Service.Hover` 를 가짜 Starter 로 10회 반복하고 `strace`/`dtruss` 로 syscall 수를 센다 — 캐시 전후의 차이가 곧 효과다.

### P2. obsMark 의 fmt 기반 해싱
- 위치: `hub/gitwatch.go:100-125`
- 현상: 회차마다 파일 목록 전체를 `fmt.Fprintf(h, "%s:%s:%s;", …)` 로 접는다. 항목당 포맷 호출 1회 + 인터페이스 박싱 3회다.
- 비용: 네 그룹 각 최대 `StatusGroupCap`(2000) → 최악 8000 항목 × (포맷 파싱 + 3회 박싱). 워크트리 회차는 저장소마다 4초에 한 번이고 감시 상한은 16개다. `fmt` 는 리플렉션 경로라 직접 쓰기보다 한 자릿수 느리다.
- 제안: `h.Write` 로 직접 쓴다 — 해시 입력의 모양은 그대로 유지한다.
  ```go
  for _, f := range g { h.Write([]byte(f.Path)); h.Write(colon); h.Write([]byte(f.XY)); … }
  ```
  앞의 헤더 부분(`%s|%s|…|%t|%d|%d|`)은 항목 수와 무관하므로 `fmt` 로 두어도 된다.
- 예상 효과: 큰 저장소의 회차 CPU 가 수 ms → 수백 µs 수준으로. 할당은 `[]byte(string)` 변환만 남는다.
- 측정: `BenchmarkObsMark` 를 `Status` 에 항목 2000개씩 채워 돌린다. `-benchmem` 으로 할당 수를 함께 본다.

### P3. run.Store 의 저장 비용 — 변경마다 전량 재직렬화 + 두 번의 깊은 복사
- 위치: `run/store.go:214-231` (`save` — `json.MarshalIndent` 전량 + 성공 시 `cloneRuns` 1회, 실패 시 1회 더), `run/store_messages.go:42-70` (`AppendMessage` 가 메시지 **하나마다** `save`)
- 현상: 팀 통신 한 줄이 `runs.json` 전체를 들여쓰기 JSON 으로 다시 쓰고, 그 뒤에 모든 Record·Member 를 다시 복사한다.
- 비용: 이 패키지가 이미 인지하고 있다 — `store_messages.go:12-14` 가 *"저장소는 매 변경마다 전체를 다시 쓰므로 그 비용이 팀 통신 속도에 그대로 실린다"* 고 적고 `MaxMessages = 500` 을 그 근거로 둔다. Run 여럿 × 멤버 여럿 × 메시지 500 이면 한 줄의 통신이 수백 KB 의 JSON 직렬화 + 디스크 원자 쓰기 + O(전체) 복사를 부른다.
- 제안 (작은 것부터):
  - `MarshalIndent` → `Marshal`. 사람이 읽을 일이 있으면 별도 덤프 명령을 둔다. 직렬화 시간과 파일 크기가 함께 준다.
  - `cloneRuns` 는 **실패 경로에만** 필요하다. 성공 시의 `s.persisted = cloneRuns(s.runs)` 를 없애려면 되돌림 스냅샷을 `save` **진입 시점**에 한 번만 뜨면 된다 — 지금은 성공/실패 양쪽에서 복사한다.
- 예상 효과: 메시지 한 건의 저장 지연이 절반 이하로.
- 측정: `BenchmarkAppendMessage` 를 Run 10 × 멤버 5 × 메시지 500 상태에서 돌리고 `-benchmem` 으로 본다.

### P4. refsTree 의 1Hz ReadDir 워크
- 위치: `query/signature.go:185-218`, 호출 주기 `hub/gitwatch.go:46` (`GitWatchInterval` = 1s), 상한 `:76` (`GitWatchCap` = 16)
- 현상: 1차 게이트가 매 초, 감시 저장소마다 `refs` 아래를 걷는다. `refs/heads` 에 브랜치 1000개면 매 초 1000개 이름을 해싱한다.
- 비용: 2단 게이트(FR-GDT-1)의 존재 이유가 "1차는 싸다"인데, ref 가 많은 저장소에서 그 전제가 약해진다. `packed-refs` 를 쓰는 저장소는 개별 파일이 없어 싸고, 원격 추적 ref 가 개별 파일로 풀려 있는 저장소는 비싸다 — 즉 비용이 저장소 모양에 따라 크게 갈린다.
- 제안: 측정이 먼저다. 실제로 비싸다면 `refs` 디렉터리 자신의 mtime 이 그대로일 때 직전 `shape` 를 재사용하는 한 겹 캐시를 둔다 — 다만 `refsTree` 의 주석이 지적한 Windows 의 mtime 지연(FR-CEM-32) 때문에 그 캐시는 **N 회차마다 강제 재계산**이 필요하다. `GitWatchWorktreeEvery` 와 같은 위상 기법을 쓰면 된다.
- 측정: `BenchmarkReadSignature` 를 ref 10 / 1000 / 5000 인 임시 저장소 셋에 대고 돌린다. NFR-GDT-2·3 의 예산과 견준다.

### P5. Store 캐시의 전량 폐기 (`pruneCache`)
- 위치: `store/store.go:318-322`
  ```go
  func pruneCache[V any](m map[string]V, cap int) { if len(m) >= cap { clear(m) } }
  ```
- 현상: `roots`(TTL 2초)·`dirs`(TTL 30초) 가 상한 64 에 닿으면 **통째로 비운다**.
- 비용: 핀·에디터 행이 64개를 넘는 사용자에게는 `gitDirs` 캐시가 사실상 꺼진 것과 같다 — 30초 TTL 이 무의미해지고 감시 회차마다 `rev-parse` 가 돈다(`store.go:256`). 주석은 *"항목이 싸고 TTL 이 짧으므로 개별 LRU 를 둘 값이 없다"* 고 하는데, `gitDirsTTL` 은 30초라 "짧다"에 해당하지 않는다.
- 제안: 버리기 전에 **만료된 것만** 먼저 거둔다 — 그래도 상한을 넘으면 그때 비운다.
  ```go
  func pruneCache[V any](m map[string]V, cap int, expired func(V) bool)
  ```
  `rootEntry`·`dirsEntry` 가 둘 다 `at` 을 들고 있으므로 판정이 바로 된다.
- 예상 효과: 핀이 많은 워크스페이스에서 `rev-parse` 호출이 회차당 N회 → 30초당 N회.
- 측정: 핀 80개짜리 워크스페이스에서 `Service.Records(0)` 의 `rev-parse` 건수를 1분간 센다.

### P6. Rebase 의 불필요한 status (위 [MED] 와 같은 항목)
- 예상 효과: rebase 한 번에서 가장 비싼 git 호출 하나 제거. 큰 저장소에서 수백 ms.
- 측정: `WithRunner` 로 argv 를 수집하는 가짜 실행기를 붙이고 `write.Rebase` 가 내는 argv 목록을 본다 — `status` 가 빠지고 `rev-parse` 가 들어오면 된다.

---

## 문서-구현 괴리

### D1. FR-GDT-22·23 의 상한이 출력 상한보다 뒤에 선다
- 근거 문서: `docs/internal/GIT_DETECT_TIER_SRS.md:207` (FR-GDT-22), `:210` (FR-GDT-23)
- 구현: `query/status.go:275-296` (`finalizeStatus` — 파싱 **후** 그룹당 2000 으로 자른다), `:306` (`StatusOf` — 잘림 미검사)
- 괴리: **미흡**. FR-GDT-22 가 겨냥한 저장소(수만 파일)에서는 1MiB 출력 상한이 먼저 걸려 `ParseStatusV2` 가 실패하거나 조용히 짧아진다 — 그룹 상한에 도달하지도 못한다. FR-GDT-23 이 요구한 *"잘렸다는 사실을 싣는다"* 도 이 경로에서는 실리지 않는다.
- 해소: 위 [HIGH] 2 의 제안. `Truncated` 에 출력 상한 잘림을 실으면 FR-GDT-23 의 규약을 한 겹 더 지킨다.

### D2. FR-GXU-3 의 "더 짧은 ctx 가 이긴다"가 두 도메인에서 성립하지 않는다
- 근거 문서: `docs/internal/GIT_EXEC_UNIFY_SRS.md:172` (FR-GXU-3), `:285` (V4 — *"더 짧은 `ctx` 는 여전히 이긴다"*)
- 구현: `core/unguarded.go` 의 `unguardedDeadline` 은 규칙대로 구현돼 있다. 그런데 `worktree/worktree.go:204` 와 `submodule/submodule.go` 의 `runGit` 이 `context.Background()` 를 넘기므로, **이 두 호출자에게는 더 짧은 ctx 가 존재할 수 없다.**
- 괴리: **구현 미흡**. V4 는 `core` 단위 시험으로 통과하지만, 실제 두 소비자에서는 그 성질이 도달하지 않는다.
- 해소: 위 [MED] 의 Runner 서명 변경.

### D3. FR-WKT-18 의 "ctx 로 끊긴다"가 절반만 참이다
- 근거: `worktree/remove.go:99-104` 의 주석 (*"되풀이에는 예산이 있고 ctx 로 끊긴다 (M8 `GO-12`)"*)
- 구현: ctx 는 `remove.go:116-121` 의 되풀이 **대기**만 끊는다. 진행 중인 `git worktree remove` 는 끊기지 않는다.
- 괴리: **구현 미흡**. 주석이 근거로 든 문제("최악 18분을 잠근 채였다")의 절반이 남아 있다 — 되풀이 6회는 막았지만 git 한 번의 180초는 그대로다.
- 해소: D2 와 같은 변경.

### D4. FR-EXT-33 의 "캐시가 아니라 관측"이 FR-LSP-13 의 핫패스와 충돌한다
- 근거 문서: `docs/internal/LSP_PLUGIN_SRS.md:328` (FR-EXT-33), `:263` (FR-EXT-9c), `:370` (V-EXT-11)
- 구현: `ext/service.go:12-14` 가 그 요구를 `Service` 전체에 적용했고, `lsp/manager.go:98` 이 그것을 요청마다 부른다.
- 괴리: **설계 범위 초과**. FR-EXT-33 과 V-EXT-11 이 말하는 것은 **설정 화면의 상태 조회**다 (*"조달 후 파일을 지우면 다음 조회가 없음"*). 그 규약을 LSP 의 세션 해소 경로에까지 적용할 근거가 문서에 없다 — 세션은 이미 살아 있고, 그 세션의 해소는 이미 끝난 일이다.
- 해소: 위 [HIGH] 3 의 ① (세션이 해소 결과를 들고, `Status()` 만 매번 새로 관측한다). SRS 에 *"FR-EXT-33 은 `Status()` 의 규약이다. 세션 해소는 세션 수명 동안 고정이며, 설치가 그 기억을 지운다(FR-LSP-16 의 `forget` 과 같은 자리)"* 한 줄을 더하면 규약이 명시된다.

### D5. GIT_PUSH_OBSERVE_SRS 의 "0.02ms" 근거가 재측정되지 않았다
- 근거: `hub/gitwatch.go:38-41` (fsnotify 기각 근거), `query/signature.go:14` (*"FR-GIT-19, §2.6: 0.02ms"*), `gitwatch.go:479-481` (*"`GIT_PUSH_OBSERVE_SRS §1.2` 가 fsnotify 를 기각하며 든 근거가 **"ReadSignature = 0.02ms 이므로 싸다"** 였는데"*)
- 구현: 그 측정 이후 `refsTree`(FR-GVR-21·21a)와 `extrasOf`(FR-GDT-12~16)가 signature 에 추가됐다. 지금의 `ReadSignature` 는 ReadDir 워크를 포함한다.
- 괴리: **근거 노후**. 숫자가 틀렸다는 증거는 없지만, 그 숫자를 딛는 결정(fsnotify 기각, 2단 게이트, 1초 주기)이 세 번 확장된 함수 위에 그대로 서 있다.
- 해소: P4 의 벤치마크로 재측정하고, 결과를 `signature.go` 머리말과 SRS 의 NFR-GDT-2·3 에 적는다. 측정이 예산 안이면 그 사실이 근거를 되살리고, 밖이면 P4 의 캐시가 필요하다는 뜻이다.

---

## 흠잡지 않은 것 (판단 근거 기록)

감사 범위에서 아래는 **비용이 있는 문제를 찾지 못했다**. 근거를 남겨 다음 감사가 같은 곳을 다시 파지 않게 한다.

- `core/guard.go`·`core/write.go` 의 인가 층 — 허용 목록 두 벌의 교집합-금지(FR-GIT-95)가 구현과 주석 양쪽에서 일관되고, `RelPath`·`CheckRefArg` 의 Windows 경로 처리가 실측 근거를 달고 있다.
- `hub/focus.go`·`hub/replyseat.go` — 락 범위가 좁고 통보가 락 밖에서 돈다. epoch 규약이 두 곳에서 같다.
- `lsp/conn.go` — `fail` 의 "처음인가" 판정과 `close(done)` 이 같은 잠금 아래 있고, 그 이유(`close of closed channel`)가 주석에 있다. `Call` 의 ctx 이탈과 pending 정리도 맞다.
- `sysstat` 전체 — 샘플러가 커널 호출을 잠금 밖에서 하고, 지표별 독립 실패가 일관되게 구현돼 있다.
- `query/status.go` 의 porcelain v2 파서 — 필드 수 부족을 오류로 올리는 규약이 모든 레코드 종류에서 같다. (위 [HIGH] 2 는 파서가 아니라 그 입력을 검사하지 않는 `StatusOf` 의 문제다.)
- `worktree/naming.go` 의 `PathSlug` — uuid v7 의 앞 8자가 49일 주기라는 실측이 근거로 남아 있고 구현이 그것에 대응한다.
