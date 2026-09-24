# 요구조건: Repo 탭 git 백엔드 근본 수정 — IEEE 29148 (StRS)

> 문서 상태: 승인(사용자 인터뷰 2026-09-24) · **단일 판(통합본)** — 11회의 공격 검증 결과를 모두 반영해 최종 결정만 남겼다. 결정의 경위·폐기된 안은 `REQUIREMENTS-HISTORY.md` 에 있으며 **이 문서가 유일한 기준**이다(이력과 다르면 이 문서가 맞다).
> 근거: `tmp/REPO_AUDIT_2026-09-24.md`(감사), `tmp/verify-backend.md`(반증 검증·실측). file:line 은 2026-09-24 작업 트리(`ed2e4e39`) 기준.
> 입력 → sdd-tdd 워크플로우. 각 요구의 **이전 동작 / 새 동작 / 이유**를 스펙에 기록하고, 단위 테스트(정상·엣지·실패)를 먼저 작성한다(TDD). 실측으로 확인된 재현은 테스트로 옮긴다(임시 저장소).

## 1. 목적과 범위

사용자 진술: *"사용하면서 자잘한 버그가 너무 많아 사용성이 안 좋다. 전부 수정. 구조적으로, 근본적으로 수정해서 정상동작하게 해야 한다."*

- **포함**: `internal/webserver/domain/git/**`(core·query·write·jobs·store), `internal/webserver/gitapi/**`, `internal/webserver/domain/worktree`·`domain/submodule`(Manager 실행 경로), `internal/webserver/httpapi/handlers_runs_worktree.go`(Run 격리)·`handlers_fs_ignored.go`(ExecUnguarded 호출처), `internal/shared/platform`(프로세스 기동), `internal/webserver/apierr`, `cmd/dongminal`(루트 ctx·종료 단계).
- **포함(프런트 — 이 문서의 계약 변경을 따라가는 부분)**: 일반화된 잡 표시기(§6), 쓰기 fetch 시한 상수, lock 버튼, stash 선택 모델의 oid 전환·stash/show 409 화면·stash branch 이름 충돌 오류(§5.3).
- **비포함**: gitwatch 감시자(02), LSP(02), 에디터·탐색기(03·04), git 패널·기능 프런트의 나머지 결함(05). 05 는 §6 을 전제로 하고 잡 UI 계약을 다시 정의하지 않는다(문구·배치 등 시각 요소는 05).
- **02 가 의존하는 계약**: §4(single-flight 수명·세대 Invalidate·호출자별 ctx 탈출·오류 분류 헬퍼)를 스펙에 공개 계약으로 명시한다.

## 2. 근본 원인

1. **실행 규약이 두 갈래**: `jobs/exec.go` 는 프로세스 그룹·그룹 SIGTERM·WaitDelay·유예 뒤 그룹 kill 을 쓰는데 `core.execGit`·`ExecUnguarded` 는 `exec.CommandContext` 기본(리더 SIGKILL)만 쓴다 → 훅 고아·Wait 매달림·index.lock 잔존.
2. **수명의 주인이 틀림**: 쓰기가 요청 ctx(`r.Context()`)와 읽기용 30s 시한에 묶여 있다. single-flight 는 첫 호출자 ctx 로 돌아 그 취소가 합류자 전원의 오류가 된다.
3. **무효화에 세대가 없음**: `Invalidate` 는 TTL 시각만 지우고 진행 중 flight 를 두어, 쓰기 직후 조회가 쓰기 전 관측을 받고 그것이 다시 fresh 로 저장된다.
4. **배타가 없음**: 동기 쓰기끼리, 쓰기와 잡 사이, worktree 들이 공유하는 `refs/stash`·`worktrees/` 에 대한 배타가 없다.
5. **git 출력·ref 의 모호성 방치**: 사용자 설정(log.showSignature), 짧은 ref 이름, stash 위치 참조, 심링크·서브모듈 모드, 절단 경계.

## 3. 프로세스 실행 규약 (#12, N4, #26)

- **P-1** 모든 git 실행(core.execGit, ExecUnguarded — worktree·submodule·`handlers_fs_ignored.go` 호출처 포함, jobs)은 core 의 **기동 헬퍼 하나**를 쓴다. jobs 는 그것을 쓴다(의존 방향 core ← jobs).
- **P-2 새 세션**: POSIX 에서 자식은 Setsid(pgid=pid)로 띄운다. Setpgid 와 함께 세우지 않는다(darwin EPERM — 실측). `platform.Process` 에 새 메서드로 추가하고, 두 플래그 동시 설정을 정상으로 보는 기존 테스트(`TestPosixDetachPreservesExistingAttr` 류)를 바로잡는다. **프로세스를 실제로 Start 하는 테스트**를 둔다. Windows 는 기존 Job Object 구현을 쓴다.
  - 동작 변경(포그라운드 모드만 — 데몬 모드는 이미 Setsid, main.go:133·start.go:349): 이전 — git 이 서버 터미널을 물려받아 pinentry-tty·ssh 암호 프롬프트가 뜨거나 SIGTTIN 정지 / 새 — 그 프롬프트는 즉시 실패(GUI pinentry·ssh-agent 필요) / 이유 — 정지·매달림 제거.
- **P-3 신호 시퀀스** (G = grace 3s, 기존 `jobs.JobKillGrace` 를 core `KillGrace` 로 이동; stdout·stderr 는 `os.Pipe`):
  - A. 시한·취소(t0): 그룹 SIGTERM → 리더 종료 대기 ≤G(`WaitDelay`=G) → 리더 종료 즉시 그룹 SIGKILL(ESRCH 무시) → 파이프 EOF 대기 ≤G, 넘으면 읽기단을 닫는다 → 반환 ≤ t0+2G.
  - B. 정상 종료(t1): 파이프 EOF 대기 ≤G → 안 오면 그룹 SIGKILL → ≤G → 읽기단 닫기. 반환 ≤ min(t1+2G, 단계 마감+2G). exit 코드는 리더의 것.
  - 동작 변경: 이전 — 출력을 리다이렉트하지 않은 훅의 백그라운드 자식(예: `ctags … &`)이 파이프를 쥐면 요청이 매달렸다 / 새 — 리더 종료 3s 뒤 그룹 SIGKILL / 이유 — 매달림 제거. 스펙 한계로 명시("오래 도는 훅 작업은 `>/dev/null 2>&1 &` 로 분리").
  - Windows: 그룹 = Job Object, SIGTERM = Ctrl+Break, SIGKILL = `TerminateJobObject`. 읽기 경로는 두 분기를 정의하고 **스펙 단계에서 벤치로 확정**한다 — W1(읽기도 Job Object) / W2(읽기만 비그룹: 리더 `TerminateProcess` → 파이프 EOF ≤G → 읽기단 닫기, 상한 동일). 규칙: Windows CI 에서 `git status` 1회 중앙값 증가 ≤10ms 면 W1.
- **P-4 설정 중립화**: 기동 헬퍼가 인자 가드를 지난 **뒤** argv 앞에 `-c log.showSignature=false` 를 붙인다(환경변수 `GIT_CONFIG_COUNT` 는 사용자 `GIT_CONFIG_*` 를 덮으므로 쓰지 않는다). 기록에는 원래 argv 를 남긴다. 스펙에 "파싱하는 git 명령 × 출력에 영향을 주는 설정 키" 조사표를 싣고, 파싱 결과를 바꿀 수 있는 키는 이미 방어된 것(명시)을 빼고 같은 방식으로 중립화한다. 새 기능이 요구하는 최소 git 버전을 스펙에 명시한다.
- **P-4 조사표 (구현 중 실측, git 2.54)** — 파싱하는 명령과 출력에 영향을 줄 수 있는 사용자 설정:

| 명령 | 영향 후보 설정 | 결과 |
|------|----------------|------|
| `log -z --format=…` (log·commitdetail·`%P`·`%B`) | `log.showSignature` | **오염 — `-c log.showSignature=false` 로 중립화** |
| 〃 | `color.ui=always`, `log.decorate` | 영향 없음(형식 문자열에 `%C` 없음, 장식은 명시 플래그) |
| `diff` (hunk) | `diff.external`·textconv·색·prefix | 이미 방어(`--no-color --no-ext-diff --no-textconv --src/dst-prefix`, diff.go:456) |
| `diff-tree --name-status -z -M` | `color.diff=always`, `diff.renames` | 영향 없음(실측), rename 은 `-M` 명시 |
| `stash show --name-status -z` | `stash.showPatch`·`showStat`, 색 | 영향 없음(옵션을 주면 설정 무시 — 실측) |
| `show <blob>` / `cat-file` | textconv, 필터 | 영향 없음(blob 은 textconv 없이 원문 — 실측) |
| `status --porcelain=v2 -z` | `status.*`, `core.quotepath` | 영향 없음(porcelain 고정 형식, `-z` 는 인용 없음, `--untracked-files=all` 명시) |
| `for-each-ref`·`stash list` (명시 형식) | — | 영향 없음 |
| `blame --porcelain` | `blame.ignoreRevsFile` | 결과는 바뀌나 사용자 의도(형식은 불변) |

- **P-5 index.lock** 은 자동 삭제하지 않는다(사용자 결정) — §7.2.

## 4. 상태 조회 single-flight·캐시 (#20 전제, #22, N3, N5)

- **S-1** flight 는 서버 루트 ctx 파생 + 자체 시한(core 조회 기본 30s)으로 돈다. 모든 호출자(첫 호출자 포함)는 **자기 ctx 로만** 빠져나간다. 호출자가 모두 떠나도 flight 는 취소하지 않는다(시한이 상한).
- **S-2 세대**: gen 은 Store 전역 단조 증가 uint64 에서 받는다(`Invalidate` 와 repoState 생성 모두 새 값). flight 는 (repoState 포인터, gen)을 기억하고, 완료 시 `states[repo]` 가 같은 포인터이고 gen 이 같을 때만 fresh 로 저장한다(evict 뒤 재생성 ABA 방지). 저장소당 슬롯은 "현재 세대 flight" 하나이고, 옛 flight 결과는 이미 합류한 호출자에게만 돌려준다. `evictLocked` 등 슬롯 의존 코드를 이 모델에 맞춘다.
- **S-3** 쓰기 응답·잡 결과에 실리는 status·oid 는 **쓰기 이후** 관측이다.
- **S-4 오류 분류**: 기존 sentinel 재사용. 결정적 = `ErrNotRepo`, `ErrRepoMissing`, `ErrGitMissing`. 일시적 = `ErrTimeout`, `ErrCanceled`, `ErrIndexLocked`(신규), 그 밖의 exit 오류, 그리고 status 경로에서 나올 수 없는 `ErrUnsafeArgument`·`ErrWriteCommand`(로그). 공개 헬퍼 `core.IsTerminal(err)`.

## 5. 쓰기 분류·배타·시간

### 5.1 용어
- **동기 쓰기**: 요청 안에서 git 쓰기를 실행하고 결과를 응답으로 주는 종단.
- **잡**: `jobs.Jobs` 에 등록돼 비동기로 도는 실행. 응답은 즉시 200 `{requested, repo, job}`(현행 `gitStartJob`, handlers_git_remote.go:161-177).
- **index 잡**: index·작업 트리·HEAD 중 하나라도 바꿀 수 있는 잡 — kind `pull, commit, merge, rebase, cherry-pick, revert, checkout, am, bisect`. 칸 `index`.
- **비-index 잡**: kind `fetch, push, submodule, worktree`. 칸 `common`. **pull 은 두 칸 모두** 차지한다(index 를 바꾸고 원격 ref 도 받으므로 fetch·push 와의 현행 배타 유지).
- **사전 단계**: 쓰기 전 검사·조회(preflight, before 스냅샷, 이름 충돌, 부모 판정, stash oid 위치 확인 등). 부작용을 남기지 않는다(recovery hint 기록은 잡 등록 성공 뒤). 동기 write 함수 **안**의 조회(`Unstage` 의 `HasHead` 등)는 쓰기 단계에 속한다.
- **사후 단계**: 쓰기 뒤 무효화·재조회. 잡에서는 **완료 처리**(Done 공개 전).
- **배타 키 정규화**: 존재하는 가장 가까운 조상까지 `EvalSymlinks` 한 뒤 나머지를 붙이고 `Clean`. 기존 `resolveSymlinksPrefix`(domain/worktree/worktree.go:163)를 core 공개 헬퍼로 옮겨 모두가 쓴다. 밖에서 지운 경로도 키가 나온다. **정규화 값은 배타 키 전용**이다 — `Job.Repo`·store 키·`Invalidate` 인자·API 응답 `repo`·프런트 재부착 비교는 `core.RepoRoot` 출력 그대로(core/repo.go:10-16 계약 유지). `jobs.Start` 는 repo 와 배타 키를 따로 받는다.
- **toplevel 키**: worktree 별 `--show-toplevel`(정규화). **common-dir 키**: `--git-common-dir` 절대화 + 정규화, core 공개 헬퍼(Service nil 에서도 동작 — FR-GXU-4)가 구하고 핸들러가 jobs·배타 상태·worktree Manager(`repoLock`)·Run 격리에 넘긴다(jobs·worktree 는 store 를 모른다).

### 5.2 잡/동기 분류 (사용자 결정: 느린 쓰기는 잡으로 전환)
- **기준**: ① 새 커밋을 만드는 명령 ② 체크아웃으로 HEAD 를 다른 브랜치·커밋으로 옮기는 명령 ③ 둘을 포함하는 pull ④ 그에 준하는 장시간 작업인 worktree add. **예외: stash 동작은 모두 동기**(§5.3 — 위치 확인과 실행이 한 잠금 안에서 원자적이어야 한다). 판정은 종단 단위. 훅 여부는 기준이 아니다 — 동기 쓰기도 훅(post-checkout·post-index-change·reference-transaction)을 돌 수 있고 쓰기 단계 마감으로 끝난다.
- 분류표(`gitapi/routes.go:15-114` POST 전수; GET 은 전부 읽기, 배타 대상 아님):

| 종단 | 분류 | kind | 잠금 |
|------|------|------|------|
| `/api/git/init` | 동기 | — | 없음(키가 없다) |
| `/api/git/repos/pin`·`unpin`·`reorder` | git 쓰기 아님 | — | 없음 |
| `/api/git/stage`·`unstage`·`discard` | 동기 | — | toplevel |
| `/api/git/resolve` | 동기 | — | toplevel |
| `/api/git/commit` | **잡** | commit | 사전 |
| `/api/git/undo-last` | 동기 | — | toplevel |
| `/api/git/records/replay` (쓰기 기록) | 동기 | — | toplevel (§7.5 거절 규칙) |
| `/api/git/records/replay` (읽기 기록) | 동기 읽기 | — | 없음 |
| `/api/git/fetch` | 잡(현행) | fetch | 없음 |
| `/api/git/pull` | 잡(현행) | pull | 사전 |
| `/api/git/push` | 잡(현행) | push | 없음 |
| `/api/git/job/cancel` | 제어 | — | 없음 |
| `/api/git/remote/add`·`remove` | 동기 | — | toplevel |
| `/api/git/checkout` | **잡** | checkout | 사전 |
| `/api/git/operation` (모든 kind × continue·skip·abort) | **잡** | argv[0] | 사전 |
| `/api/git/branch` (`checkout:false`) | 동기 | — | toplevel |
| `/api/git/branch` (`checkout:true`) | **잡** | checkout | 사전 |
| `/api/git/branch/rename`·`delete`·`upstream` | 동기 | — | toplevel |
| `/api/git/branch/merge` | **잡** | merge | 사전 |
| `/api/git/branch/rebase` | **잡** | rebase | 사전 |
| `/api/git/branch/push`·`delete-remote`·`fetch` | 잡(현행) | push·fetch | 없음 |
| `/api/git/stash/push`·`apply`·`pop`·`drop`·`branch` | 동기 | — | common-dir → toplevel |
| `/api/git/tag`·`tag/delete` | 동기 | — | toplevel |
| `/api/git/tag/push`·`tag/delete-remote` | 잡(현행) | push | 없음 |
| `/api/git/ignore` | 동기 | — | toplevel |
| `/api/git/uncommitted/reset`·`clean` | 동기 | — | toplevel |
| `/api/git/patch` | 동기 | — | toplevel |
| `/api/git/cherry-pick`·`revert` (noCommit 포함) | **잡** | cherry-pick·revert | 사전 |
| `/api/git/reset` (모든 mode) | 동기 | — | toplevel |
| `/api/git/drop` | **잡** | rebase | 사전 |
| `/api/git/submodules/update` | 잡(현행, `StartUnguarded`) | submodule | 없음 |
| `/api/git/submodules/sync` | 동기(Manager) | — | toplevel |
| `/api/git/worktrees/create` | **잡**(`StartUnguarded`) | worktree | `repoLock`(§5.6) |
| `/api/git/worktrees/remove` | 동기(Manager) | — | **대상** toplevel(§5.6) |
| `/api/git/lock/remove` (신규) | 동기 | — | toplevel TryLock(§7.2) |

  "사전" = 사전 단계~잡 등록 동안만 toplevel 뮤텍스를 쥔다. 잡으로 옮긴 종단의 응답 — 이전: 200 `{ok, partial, status, …}` / 새: 200 `{requested, repo, job}` / 이유: 사용자 결정. **실행 전 거부**(confirmation_required, branch_exists, preflight_blocked, nothing_staged, empty_message, operation_mismatch, no_operation, merge_parent_required, stash_moved, 400 인자 오류 등)는 동기로 응답한다.

### 5.3 stash (#14, R-6)
- 요청: `{repo, oid, withIndex?, confirm?, name?}`. **oid 필수**. index 는 받지 않는다 — 구조체 필드를 `Index *int` 로 두고 non-nil 이면 400 `bad_request`. `DisallowUnknownFields` 는 전역 도입하지 않는다.
- 순서(push·apply·pop·drop·branch 공통): common-dir 잠금(≤5s) → toplevel 뮤텍스(≤5s) → (push 외) 목록에서 oid 의 **현재 위치 n** 을 찾음 — 없으면 409 `stash_moved`(본문 `{error, message, requested, repo, stashes, status}`) → 실행 → 사후 단계 → 역순 반납. 위치가 밀렸어도 사용자가 고른 stash 가 실행된다.
- argv: apply `stash apply <oid>`; pop·drop·branch `stash@{n}`(n 은 같은 잠금 안에서 방금 찾은 값 — pop·drop 은 git 이 ref 만 받고, branch 는 ref 로 열어야 git 이 스스로 드롭한다).
- **stash branch**: 사전 단계에서 기존 `gitBranchNameTaken` 으로 이미 있는 이름이면 409 `branch_exists`(**options 없음** — 브랜치 생성용 선택지는 맞지 않는다). 실행 뒤 `StashPopChecked`(write/stash.go:212-236)와 같은 확인 경로로 oid 잔존을 판정해 `stashKept`·`stashKeptOid`·`stashKeptReason` 을 싣는다(목록 재조회 실패 시 "남지 않았다"로 답하지 않고 오류를 합친다). 안내문: 사후 status 의 `Branch` 가 요청 name 과 같으면 "브랜치 `<name>` 은 만들어졌고 충돌이 남았다 — stash 는 보존됐다", 다르면 "stash branch 가 실패했다 — stash 는 보존됐다"+stderr tail, status 재조회 실패면 "stash branch 뒤 상태를 확인하지 못했다 — stash 보존 여부는 위 표시를 따른다".
- **미리보기** `GET /api/git/stash/show?oid=`: `StashPreview(s, ctx, repo, oid)` 가 `stash show <flags> -z <oid>` 로 **위치를 거치지 않고** 연다. 목록은 oid 가 있는지 판정할 때만 쓰고, 없으면 409 `stash_moved`(본문 `{error, message, requested, repo, stashes}`). `index` 쿼리는 400. 응답 `requested` 는 `{repo, oid}`.
- **없음 코드 통일**: 기존 `write.ErrStashNotFound`(404 `not_found`, write/stash.go:63·365)와 그 tables·inventory·apierr_test 항목을 **제거**하고, oid 가 목록에 없는 모든 경로(apply·pop·drop·branch·show)는 409 `stash_moved`. 이전: 위치로 찾다 없으면 404 / 새: oid 가 없으면 409 `stash_moved` / 이유: 같은 상황이 두 코드로 갈리지 않게.
- **한계(스펙 명시)**: 사용자가 `rebase.autoStash`·`merge.autoStash` 를 켠 상태에서 pull·merge·rebase 잡이 도는 동안 다른 worktree 의 stash pop·drop·branch 는 잡의 autostash 가 위치를 밀 수 있다(막으려면 index 잡 내내 stash 를 잠가야 한다). dongminal 밖(터미널)과의 경쟁도 허용한다.
- **프런트(01 범위)**: web/js/git/stash.js 의 선택·미리보기·조작·echo 비교 키를 index 에서 oid 로 바꾼다. 목록 갱신 뒤 선택한 oid 가 있으면 선택 유지, 없으면 해제 + 미리보기 자리에 "선택한 stash 가 사라졌다". 409 `stash_moved` 는 `stashes` 로 목록을 갈아 끼우고 사유 표시. stash branch 다이얼로그는 409 `branch_exists` 를 다이얼로그 안 오류로 보이고 입력을 유지한다.

### 5.4 잡 슬롯·배타 행렬
- 잡 슬롯: 저장소당 **index 칸(toplevel 키) 1 + common 칸(common-dir 키) 1**. 같은 칸끼리는 409 `job_busy`. push·fetch 중에도 commit·checkout 등을 시작할 수 있다.

| 진행 중 ↓ \ 새 요청 → | 동기 쓰기 | index 잡 시작 | 비-index 잡 시작 |
|------|------|------|------|
| 없음 | 실행 | 실행 | 실행 |
| 동기 쓰기(같은 toplevel) | 뮤텍스 대기 ≤5s → 409 `repo_busy` | 대기 ≤5s → 409 `repo_busy` | 실행 |
| index 잡(같은 toplevel) | 409 `job_busy`(즉시) | 409 `job_busy` | 실행 — pull 은 예외(두 칸) |
| 비-index 잡(같은 common dir) | 실행 | 실행 — pull 은 예외 | 409 `job_busy` |

- **판정 순서 — 동기 쓰기**: ① 같은 toplevel 의 index 칸 확인(있으면 409 `job_busy`) → ② (stash 는 common-dir 잠금 먼저) 뮤텍스 획득(≤5s; 요청 ctx 취소 시 미실행) → ③ index 칸 재확인 → 사전 단계(요청 ctx) → ④ 쓰기 단계 직전 요청 ctx 확인(떠났으면 반납·미실행) → 쓰기 단계(루트 ctx) → 사후 단계 → 반납 → 응답. worktree remove 는 §5.6 순서.
- **판정 순서 — index 잡**: ① 칸 확인(pull 은 두 칸) → ② 뮤텍스(≤5s) → ③ 재확인 → 사전 단계 → ④ 요청 ctx 확인 → 등록 → 반납 → 부작용(hint) → 200 `{job}`. 실행·완료 처리 동안은 뮤텍스를 쥐지 않는다(칸 등록이 동기 쓰기를 막는다).
- **판정 순서 — 비-index 잡**: 같은 common dir 의 common 칸만 확인(뮤텍스 없음).
- **잠금 순서(전역)**: common-dir 잠금(stash 만) → toplevel 뮤텍스(언제나 하나) → `repoLock`. 모든 경로가 이 순서의 부분열이므로 교착이 없다. 잠금 획득은 모두 ctx·시한을 존중한다(채널 세마포어 등).
- **배타 상태 단일 인스턴스**: 뮤텍스·칸·common-dir 잠금은 `buildDeps` 에서 한 인스턴스로 만들어 GitServer(→ jobs, 지연 생성 `gitJobHolder` 포함)와 httpapi(Run 격리)에 같은 것을 주입한다.
- **적용 범위**: 위 분류표의 잠금 열. 미적용: GET, init, 핀, job/cancel, 비-index 잡 시작, gitwatch·status 폴링, check-ignore(읽기).
- 이전/새/이유: 이전 — 동기 쓰기는 잡을 보지 않았고(pull 중 stage 가능), 동기 쓰기끼리 배타가 없어 index.lock 경합 / 새 — 위 표. fetch·push·submodule update·worktree add 중 동기 쓰기·index 잡은 계속 허용, pull 중 동기 쓰기는 409 `job_busy` / 이유 — index 공유 실행의 경합 제거, index 무관 원격 잡까지 막는 사용성 퇴행 방지.
- worktree add 는 common 칸이므로 같은 common dir 의 push·fetch·submodule update 중 409 `job_busy`(이전: 동기라 가능 / 새: 거부, 시작 자리에 "원격 작업이 끝난 뒤 다시 시도" / 이유: 보통 짧고 칸을 더 나누면 모델이 복잡해진다).

### 5.5 시간 예산
| 단계 | 마감(단계 전체에 하나) | ctx 부모 | 초과·이탈 |
|------|------|------|------|
| 잠금 대기(각) | 5s | 요청 ctx | 409 `repo_busy`; 요청 취소면 미실행 |
| 사전 단계 | 10s | 요청 ctx | 504 `git_timeout`, 미실행 |
| 쓰기 단계(write 함수 전체 — 청크·다단계·함수 안 조회 포함) | 30s (`core.DefaultTimeout`) | 서버 루트 ctx | 504 `git_timeout` + 부분 적용 판정(FR-GIT-73) |
| 사후 단계 | 15s | 서버 루트 ctx | 현행(쓰기 성공+재조회 실패 = 실패 응답) |

- 각 단계는 마감 ctx 하나를 만들고 그 안의 모든 git 이 그것을 쓴다(`withTimeout` 의 "호출자 마감이 짧으면 그것", exec.go:127-132). 마감 뒤 새 git 을 시작하지 않는다. 정리 대기는 단계 마감+2G 를 넘지 않는다 → 단계 절대 상한 = 마감+6s(호출 수 무관).
- 최악 응답: 일반 동기 쓰기 5+16+36+21 = **78s**, stash 5종(잠금 둘) **83s**. 프런트 `GIT_WRITE_FETCH_TIMEOUT_MS`(constants-git-detect.js:55) **35000 → 100000**(최소 여유 17s).
- 잡을 여는 종단: 잠금 대기+사전 단계만 동기(최악 21s). 프런트는 현행 `timeout:0`(web/js/git/api.js 잡 규약).
- **Manager 경유**(worktree remove, submodule sync): 쓰기 단계 마감 **180s**(현행 `opTimeout` 을 단계 마감으로 재해석), 루트 ctx 파생. 최악: remove **207s**(§5.6), submodule sync 5+186 = **191s**. 프런트 `timeout:0`. 이전: 35s 에 끊겨 서버는 계속 실행하는데 화면은 실패 / 새: 서버 응답까지 기다림.
- 요청 이탈: 잠금 대기·사전 단계 중(쓰기 직전 확인 포함) 요청 ctx 가 취소되면 실행하지 않는다. 쓰기 단계가 시작된 뒤 이탈은 무시하고 사후 단계까지 끝낸다.
- 상수(5s·10s·15s·180s)는 한 곳에 이름 붙여 둔다.

### 5.6 worktree
- `repoLock`(worktree.go:118-127)을 ctx 존중 획득으로 바꾸고 키를 common-dir 로 바꾼다(현행 toplevel). Manager 의 `Runner`(worktree.go:75)·submodule `Runner`(submodule.go:61)에 ctx 첫 인자를 더하고, git 을 부르는 Manager 메서드 전부가 ctx 를 받는다(영향: gitapi/handlers_git_worktree.go·handlers_git_submodule.go, httpapi/handlers_runs_worktree.go 7곳, 도메인 테스트 대역). Manager 오류 래핑(`runGit` 의 `%v`)은 `%w` 로 바꿔 sentinel 을 보존한다.
- ctx 출처: gitapi 읽기(List·BranchExists·Resolve) = 요청 ctx + 사전 단계 마감 10s; gitapi 쓰기(Remove·Sync) = 루트 파생 + 180s; Run 격리 = 자기 요청 ctx(git 1회 180s·`repoLock` 대기 180s).
- **worktree add 잡**: 도메인이 `submodule.UpdateSpec` 과 같은 모양의 순수 함수(검증·argv·사유)를 내고 핸들러가 `StartUnguarded(kind "worktree")` 로 띄운다. 사전 단계: common 칸 확인 → `repoLock`(≤5s, 실패 409 `repo_busy`) → 이름·경로·브랜치 충돌 → 부모 디렉터리 생성(만들었는지 기억) → 요청 ctx 확인 → 등록. 등록 전 실패: `repoLock` 반납, 이번에 만든 빈 부모 디렉터리 삭제. 완료 처리: 성공이고 루트가 살아 있으면 best-effort config 2건(worktree.go:353·357) → `repoLock` 반납(모든 결말). 상한 — 이전: git 1회 180s·취소 불가 / 새: 잡 10분·취소 가능.
- **worktree remove(동기)**: `git worktree remove` 는 요청 worktree 의 index·HEAD·작업 트리를 바꾸지 않는다(대상 작업 트리와 `$GIT_COMMON_DIR/worktrees/<n>` 만). 주 worktree 는 git 이 거부하고, 요청 저장소 자신은 `Manager.Remove` 가 거부한다(remove.go:44, `ResidueUnsafePath` — git 자체는 링크드 worktree 안의 자기 제거를 허용한다, 실측). 따라서 요청 worktree 의 칸·뮤텍스는 보지 않는다.
  - 순서: ① 사전 단계: 같은 common dir 의 worktree 잡 확인(있으면 409 `job_busy`) → `List` 로 대상 확정 → 대상 index 칸 확인(진행 중 409 `job_busy`) → ② 대상 toplevel 뮤텍스(≤5s, 실패 409 `repo_busy`) → ③ 대상 index 칸 재확인 → ④ 요청 ctx 확인(떠났으면 반납·미실행) → ⑤ 쓰기 단계(180s): `repoLock` 대기(**쓰기 단계 마감 안에서** 기다린다) + `Remove` → 반납. common-dir 잠금은 쓰지 않는다.
  - 요청 = 대상이면 ⑤ 의 `Manager.Remove` 가 `ResidueUnsafePath` 로 끝난다(현행).
  - 밖에서 지운 worktree: 정규화 키가 나오므로(§5.1) 순서가 그대로 돌고, 제거는 현행대로 prune 후 성공.
  - ①과 ⑤ 사이에 worktree add 잡이 끼면 ⑤ 의 `repoLock` 대기가 그 잡(≤10분)을 기다리다 쓰기 단계 마감(180s)에 걸리면 504 `git_timeout` — 삭제는 일어나지 않는다.
  - 결과: remove 는 어느 worktree 의 stash 도 막지 않는다. 대상 worktree 의 동기 쓰기만 remove 동안 5s 뒤 409 `repo_busy`(삭제 중인 worktree 이므로 의도 — 이전: 배타 없음).
  - 연속 remove: `repoLock` 을 쓰기 단계 마감 안에서 기다리므로 서로 다른 worktree 를 연달아 지워도 차례로 성공한다(현행 무기한 대기와 같은 결과, 상한만 생김).
  - 최악: (10+6) + 5 + (180+6) = **207s**.
- **Run 격리**(handlers_runs_worktree.go): Create·Remove 는 `repoLock` 을 자기 요청 ctx + 180s 로 기다린다(이전: 무기한 / 새: 사용자 worktree add 잡과 겹치면 최대 180s 뒤 실패 보고 / 이유: 10분 매달림 방지). Remove 는 대상 index 칸을 확인하고 대상 toplevel 뮤텍스를 **TryLock** 한다 — 칸 진행 중이거나 TryLock 실패면 제거하지 않고 기존 잔여물 경로로 `Residue: ResidueRemoveFailed`, `Detail: "사용 중인 worktree — 작업이 끝난 뒤 정리"`(:166-184 와 같은 모양). TryLock 성공 시 `repoLock` 대기·`Remove` 동안 쥔다. 이전: 사용자 커밋 중에도 작업 트리를 지울 수 있었다 / 새: 사용 중이면 잔여물 / 이유: 진행 중 쓰기의 작업 트리 삭제 방지.

## 6. 잡 계약·프런트 (사용자 결정: 잡으로 전환 + 진행·취소 UI)

### 6.1 허용 kind 와 모양
`jobKinds`(job.go:68)를 아래로 바꾼다. `Start` 는 kind 가 표에 있고 `argv[0]==kind` 이며 모양 제약을 만족할 때만 받는다(위반 `ErrJobKind`). argv 는 기존 `*Args`/`*Spec` 순수 함수로 만든다(판정 두 벌 금지).

| kind | 진입 | 모양 제약 | 칸 |
|------|------|-----------|----|
| fetch, push | Start | 현행 | common |
| pull | Start | 현행 | index + common |
| commit | Start | commit.go:43-58 형태, 메시지는 stdin | index |
| merge | Start | `MergeArgs` 또는 `merge --continue\|--abort` | index |
| rebase | Start | `RebaseArgs`·`DropArgs` 또는 `rebase --continue\|--skip\|--abort` | index |
| cherry-pick, revert | Start | `PickArgs` 또는 `--continue\|--skip\|--abort` | index |
| checkout | Start | `CheckoutArgs` 또는 `BranchCreateArgs(Checkout:true)` | index |
| am | Start | `am --continue\|--skip\|--abort` | index |
| bisect | Start | `bisect reset` | index |
| submodule | StartUnguarded | 현행 | common |
| worktree | StartUnguarded | `worktree add …` 만 | common |

`StartUnguarded` 는 kind ∈ {submodule, worktree} 만 받는다(현행 무제한 — job.go:248-262).

### 6.2 stdin·사전 단계
- `JobRunner`(job.go:123)가 stdin 을 받는다(`WriteSpec.Stdin` 비어 있으면 파이프 없음). 내용은 Job JSON·줄 스트림·기록에 싣지 않는다(기록은 바이트 수만).
- 사전 단계는 잡 등록 전·뮤텍스 안: commit 의 메시지 검사·preflight 재검사(handlers_git_write.go:144-167)·before 스냅샷·nothing-staged 및 amend 판정(§7.7), checkout·branch 이름 충돌, pick 부모 판정, drop 부모 수·headOid, operation 종류 일치(handlers_git_operation.go:55-66). rebase·drop 의 recovery hint 는 값만 사전 단계에서 구하고 기록은 등록 성공 뒤. write 함수가 사전 조회와 실행을 한 몸으로 가진 경우(`write.Pick`·`Checkout`·`BranchCreate`·`Rebase`·`Drop`)는 사전 부분·argv 생성을 분리한다. Destructive 선언은 기존 그대로 옮긴다.

### 6.3 완료 처리·결과
- 완료 처리 ctx = 루트 파생 + 15s(잡 ctx 와 별개). 루트가 취소되면 함께 취소 → 종료 7s 상한이 우선.
- 순서: ① 기록 → ② lock 판정(`rev-parse --git-path`) → ③ status 캐시 무효화 → ④ 사후 재조회(status 등) → ⑤ worktree config(worktree 잡 성공 시) → ⑥ `repoLock` 반납(worktree 잡, 항상) → ⑦ undo 토큰 발급(commit 성공 시 — 창 `write.UndoTTL` 5s 의 기점) → ⑧ Done 공개·칸 비움(pull 은 두 칸)·구독자 닫기. 루트가 이미 취소됐으면 ②④⑤⑦ 을 건너뛴다.
- 완료 처리 실패는 잡 성패를 바꾸지 않고 `result.statusError` 로만 싣는다. 잡은 완료 처리가 끝날 때까지 칸에 남는다.
- Job JSON 추가 필드(모두 `omitempty`, `Kind` 주석 job.go:95 갱신):

| 필드 | 채우는 때 |
|------|-----------|
| `slots` []string | 항상 — `"index"`·`"common"`(pull 은 둘). kind 에서 서버가 파생. 프런트 잠금의 유일한 출처 |
| `errorCode` | 분류된 실패: `server_shutdown`(최우선), `index_locked`, `git_timeout` |
| `lock` `{path, mtimeUnixMs}` | `errorCode=index_locked` |
| `result.status` | index 잡 전부(쓰기 이후 관측) |
| `result.statusError` | 사후 재조회 실패 |
| `result.partial`·`result.changed` | 실패 시 before 대비 변화(FR-GIT-73) |
| `result.oid`·`result.undoToken` | commit 성공 |
| `result.path`·`result.branch` | worktree 잡 성공 |

- 원격 전용 판정(`authPatterns`·`rejectPatterns`·`Options`, job_run.go:99-105)은 kind ∈ {fetch, pull, push} 에서만. 취소 문구는 원격 kind 는 현행, 그 밖은 "취소했다. 일부가 적용됐을 수 있다 — 상태를 확인하라".
- 충돌로 멈춘 잡(merge·rebase·cherry-pick·revert·operation continue): 실패로 끝나되 `result.status.operation.kind` 가 채워지고, 프런트는 "진행 중(충돌)"으로 표시(FR-GIT-251 규약).
- 결과 조회: 현행 `/api/git/job/events` 의 `done`(보존 5분). `/api/git/jobs` 는 진행 중 잡 전부를 **id 로 중복 제거**해(pull 은 한 번) 현행 정렬로 준다(저장소당 최대 2). `job/cancel` 은 id 지정. `Get` 은 `byID`(변화 없음).

### 6.4 프런트 — 일반화된 잡 표시기
현 원격 전용 상태 기계(web/js/git/remote.js — `run`·`_attach`·`_openStream`·`_finish`·`waitJob`·`adoptJobs`, `.git-job` 박스)를 kind 무관 "잡 표시기"로 떼어 모든 시작 자리가 재사용한다. 공용 잡 박스 하나에 그 저장소의 진행 중 잡을 칸별 최대 두 줄(kind·상태·취소)로 보인다. kind 라벨 `GIT_REMOTE_LABEL`(web/js/core/constants-git-remote.js:15)에 새 kind 를 더한다.

| 상황 | 화면 동작 |
|------|-----------|
| 시작 | `gitPost(…, {timeout:0})`. 실행 전 거부(4xx)는 시작 자리(다이얼로그 등)에 표시. 200 `{job}` 이면 표시기에 붙고 다이얼로그는 닫는다 |
| 진행 중 잠금 | Job 의 `slots` 기준 — 그 칸을 쓰는 컨트롤을 잠근다. `index`: 그 저장소의 동기 쓰기·index 잡 시작 컨트롤(**worktree remove 제외**). `common`: 비-index 잡 시작 컨트롤(worktree 잡이면 worktree remove 도). 시작 자리 컨트롤은 busy (구현 중 정정: 잠금은 한 자리에서 한다 — `panel.post` 가 index 칸이 돌면 동기 쓰기·index 잡 시작을 보내지 않고 `job_busy` 안내를 세우고, 커밋 버튼·원격 버튼은 칸 기준으로 꺼진다. 메뉴 항목마다의 비활성 표시는 05(시각 요소)) |
| 성공 | `adopt(result.status)` + 동작별 후처리 |
| 실패 | 박스에 `err`·`stderrTail`, `result.status` 가 있으면 adopt, 입력 보존 |
| 충돌 | "충돌 — 해결 후 계속" 안내, adopt → Changes 의 진행 중 노트가 출구 버튼을 준다 |
| 취소 | 박스 취소 → 확인 → done 후 adopt |
| `index_locked` | 박스에 "남은 lock 지우기"(§7.2) |
| 재부착 | 새로고침·다른 탭: `/api/git/jobs` → 현재 저장소의 잡 전부(최대 2) 부착 → done 에서 위 규칙(undo 토큰이 있으면 토스트, 창은 서버가 강제) |

| 동작 | 시작 자리 | 추가 잠금 | 성공 후처리 |
|------|-----------|-----------|-------------|
| 커밋 | 커밋 패널 버튼 | 메시지 입력·옵션·버튼 | done(exit 0) 확정 시 입력·draft 비움, amend·옵션 초기화, undo 토스트. 실패·취소·충돌은 메시지 보존. 재부착 탭이 성공을 받으면 그 저장소 draft 비움 |
| checkout·브랜치 생성+checkout | 브랜치 목록·메뉴·생성 다이얼로그 | — | adopt |
| merge·rebase·cherry-pick·revert·drop | 브랜치·History 메뉴 | — | adopt(충돌 규칙) |
| 진행 중 작업 continue·skip·abort | Changes 진행 중 노트 | 노트 버튼 | adopt |
| worktree add | Worktrees 다이얼로그 | — | 목록 재조회, `result.path` 표시 |
| pull·fetch·push 류 | 현행 | 현행 | 현행 |

## 7. 개별 결함 수정

### 7.1 쓰기 실패 코드 (apierr)
| 코드 | HTTP | sentinel | 뜻 |
|------|------|----------|----|
| `repo_busy` | 409 | `jobs.ErrRepoBusy`(신규) | dongminal 동기 쓰기가 진행 중이라 잠금 대기 상한 초과·TryLock 실패 |
| `index_locked` | 409 | `core.ErrIndexLocked`(신규) | git 이 index.lock 을 만들지 못함 |
| `stash_moved` | 409 | `write.ErrStashMoved`(신규) | stash oid 가 목록에 없음 |
| `resolve_partial` | 409 | 없음(핸들러가 직접) | 충돌 해결 일부 실패 |
| `server_shutdown` | 503 | 없음(루트 ctx 취소로 판정) | 종료로 끊김 |
| `job_busy` | 409 | 현행 | 같은 칸의 잡 진행 중 |

모두 codes.go 상수, codes_core.go `gitCodes`(81-94 — `AllCodes()`·`TestAllCodesDeclared` 의 단일 목록), codes_doc.go 문구·조치, tables.go(sentinel 있는 것 — `index_locked` 는 core 일반 규칙보다 앞), inventory.go, apierr_test.go 에 등록한다. `not_found` 의 stash 용 항목은 제거(§5.3).

### 7.2 index.lock (#12, 사용자 결정: 자동 삭제 없음 + 안내·버튼)
- `core.classify`(errors.go:57)가 소문자 stderr 에 `unable to create '` 와 `index.lock': file exists` 가 **함께** 있으면 `ErrIndexLocked`, `kinds`(errors.go:29)에 추가. 다른 `.lock` 은 범위 밖(현행 `git_failed`).
- lock 정보: 응답 필드 `lock {path, mtimeUnixMs}` — `path` = `git rev-parse --git-path index.lock`(상대면 루트 기준 절대화 — 링크드 worktree 대응), `mtimeUnixMs` = `Lstat` mtime. 파일이 없으면 mtime 을 싣지 않는다(프런트는 "다시 시도" 안내). (구현 중 정정: 동기 응답도 §6.3 잡 결과와 같은 `lock {path, mtimeUnixMs}` 모양 — 한 필드가 두 모양이면 프런트가 둘을 따로 읽는다. 삭제 종단 응답의 `lockPath` 는 그대로)
- **모든 동기 쓰기 실패 응답**(gitApply 경로 전부·replay·undo·stash·Manager 경유·resolve)에 실패 렌더링 공통 지점 하나가 `errors.Is(ErrIndexLocked)` 로 판정해 덧붙인다(판정 git 은 사후 단계 ctx). 잡은 완료 처리에서 같은 판정.
- 삭제 종단 `POST /api/git/lock/remove` 본문 `{repo, confirm, mtimeUnixMs}`(경로 필드 없음): `beginWrite` → `requireConfirm` → resolve → 잡 확인(그 toplevel 의 index 칸 또는 그 common dir 의 common 칸에 잡이 있으면 409 `job_busy`) → toplevel 뮤텍스 TryLock(실패 409 `repo_busy`) → 경로 재계산 → 검사(파일명 정확히 `index.lock`, `Lstat` 일반 파일 — 아니면 400, `--git-dir`/`--git-common-dir` 하위) → 없으면 200 `{ok:true, removed:false, lockPath}` → mtime ≠ 요청이면 409 `stale_observation` → `os.Remove` → 캐시 무효화 → 200 `{ok:true, removed:true, lockPath}`. 파괴적 정책 `core.ActionIndexLockRemove = "index_lock_remove"` 를 `DestructiveActions` 에 추가(`/api/git/policy` 노출). 서버 로그에 경로·mtime.
- 프런트: 버튼은 `index_locked` 응답·잡 결과에서만. 확인 다이얼로그에 lockPath·상대 시각과 확인문("터미널 등 다른 git 이 실행 중이면 지우지 말 것"). 성공 뒤 status 재수집, 원래 동작은 자동 재시도하지 않는다.

### 7.3 ref 모호성 (N1, #11)
- 원격 브랜치·태그 삭제는 완전 이름(`refs/heads/<b>`, `refs/tags/<t>`). 원격에 브랜치만 있을 때 태그 삭제가 브랜치를 지우지 않는다(실측 재현을 테스트로). 태그 원격 삭제 시 로컬 `TagOid` 조회 실패는 **현행대로 값 없는 hint 로 진행한다**(구현 중 정정: 로컬에 없는 원격 전용 태그를 지울 수 있어야 하고, 위험이던 브랜치 삭제는 완전 이름으로 해소된다).
- 브랜치 메뉴 Push(`BranchPushSpec`): upstream 이 원격 R 의 브랜치 B → `push R <local>:refs/heads/B`(R 이 기본 원격이 아니어도). upstream 원격이 `.` → 거절+사유. upstream gone → 같은 refspec 으로 다시 만든다. upstream 이 있으면 `-u` 재설정 안 함. upstream 없으면 현행. 현재 브랜치 Push(`PushSpec`, 인자 없는 `git push`)는 사용자의 `push.default`·`pushRemote` 설정을 존중하므로 바꾸지 않는다. upstream 은 `%(upstream:remotename)`·`%(upstream:remoteref)` 로 원격과 ref 를 나눠 읽는다(`/` 가 든 원격 이름 대응).

### 7.4 충돌 해결 (#24, N8)
- 선택한 쪽 S(ours|theirs, git 정의 그대로 — rebase 중 반전 안내는 기존 프런트 문구)의 stage 가 없으면 `git rm`, 양쪽 삭제(DD)는 `git rm`, 그 밖(AA 포함)은 `checkout --S` + `add`. 경로별로 실행해 한 경로의 실패가 다른 경로를 막지 않는다.
- 응답: 전부 성공 200 `{ok:true, results, status}`. 쓰기 단계 마감 뒤 남은 경로는 `{path, ok:false, skipped:true, error:"시간 초과로 실행하지 않음"}`, 마감 순간 실행 중이던 경로는 `{ok:false, error}`. 코드 우선순위: 경로 오류에 `index_locked` 가 있으면 409 `index_locked`(results·status·lock) → 그 밖 실패·skipped 가 있으면 409 `resolve_partial`(`{error, message, requested, repo, results, status, partial}`) → 전부 성공 200. 504 는 쓰지 않는다. 실행 전 거부는 현행 400. 프런트는 실패 경로와 사유를 노트로.

### 7.5 replay 거절 (Console 재실행)
- 쓰기 기록의 replay 는 동기(현행), 쓰기 단계 마감 초과 504. 다음은 실행 전 400 `bad_request`: `rec.StdinBytes > 0`(커밋·패치 — 내용이 기록되지 않아 재실행은 다른 결과), `argv[0]=="stash"` 인 쓰기 기록(위치로 기록돼 다른 stash 를 건드릴 수 있다). Console 버튼 비활성은 05.

### 7.6 diff (#13, #25, P2 서브모듈 500)
- 작업 트리 쪽 심링크(`Lstat`)는 링크 문자열을 본문으로(git 과 같은 표현). 저장소 밖 검사는 링크 자신의 위치에만.
- gitlink: `diffBlobSide`(diff.go:139)에서 `cat-file -s` 가 실패하고 그것이 `diffAbsent` 가 아닐 때만 모드를 확인한다(hot path 에 호출 추가 없음). rev 를 `:<p>`(index — `ls-files -s -- <p>`) 또는 `<treeish>:<p>`(첫 `:` 분리 — `ls-tree <treeish> -- <p>`)로 나눠 모드 160000 이면 `Kind:"submodule"`, `Oid` = 항목 oid. 모든 축에 적용. `ls-tree` 를 읽기 허용 목록(guard.go:19)에 추가. 작업 트리 쪽이 디렉터리이고 반대쪽이 submodule 이면 작업 트리 쪽도 `Kind:"submodule"`. `DiffSide.Kind` 주석 갱신. 한계: 상위 객체 저장소에 같은 커밋이 있어 `cat-file` 이 성공하는 드문 경우는 현행 경로.
- 크기: 작업 트리 본문 읽기는 `query.DiffMaxBytes`(1MiB, diff.go:37). 이미지 판별(`ImageMimeOf`)은 앞 512바이트만. 이미지 본문(`SideBytes`, diff_image.go:103)은 그림 전용 Service 의 `img.MaxOutput()`(배선 10MiB, file_boundary.go:30)을 상한으로 `Stat` 후 넘으면 `ErrDiffTooLarge`(413).

### 7.7 기타
- **status 절단**(FR-SAF-19): 출력 상한 절단 시 마지막 불완전 레코드는 종류(1/2/u/?/!)와 무관하게 버린다.
- **인자 가드**: 위험 접두(`-o`, `--output` 등) 검사는 `--` 앞 옵션 위치에만. 값 플래그 제외는 하위 명령별 — commit·tag 의 `-m`/`--message`/`-F`/`--file` 분리형(다음 인자 제외)과 붙은 형태(`--message=…`, `--file=…`, `-m…`, `-F…`). 그 밖의 명령은 제외 없음(`branch -m`·`checkout -m` 은 불리언, `cherry-pick -m` 은 숫자). 결합 짧은 옵션(`-am`)은 제외하지 않는다. 태그 메시지는 `-m <msg>` 를 유지한다(구현 중 정정: 가드가 값 플래그 뒤 인자를 검사하지 않게 되어 stdin 으로 옮길 이유가 사라졌고, 옮기면 Console 재실행이 거절되고 기록에서 메시지가 사라진다).
- **amend 메시지 전용**(사용자 결정, FR-GIT-84 개정 — GIT_SRS 에 기록): amend 가 켜져 있으면 staged 없이도 커밋 허용(서버·프런트 판정). 요청 메시지(트레일러 추가 전)와 직전 메시지를 Go 로 구현한 cleanup=strip 정규화로 비교해 같고 staged 도 없으면 "바뀔 것이 없음". 정규화: 주석 접두 = `core.commentString`(git ≥ 2.45) → `core.commentChar` → `#`, 값이 `auto` 면 주석 줄 제거 안 함 → 줄 끝 공백 제거 → 연속 빈 줄 하나로 → 앞뒤 빈 줄 제거. signoff 가 켜져 있고 직전 메시지에 `Signed-off-by:` 줄이 없으면 "바뀔 것이 있음"(서명자 일치는 보지 않음 — 한계). amend + `-a` 로 추적 변경이 있으면 허용. HEAD 없으면 amend 불가(현행).

## 8. 서버 수명·종료
- `serve`(cmd/dongminal/app.go)가 `buildApp` 앞에서 `gitRoot, cancelGit := context.WithCancel(context.Background())` 를 만들어 `buildDeps`/`buildDepsWithHub`(main.go:216·268)로 GitServer 에 넘긴다(Store flight·지연 생성 Jobs·동기 쓰기·사후 단계·잡 상한 ctx(현행 `context.Background()` — job.go:272)·완료 처리 ctx 가 모두 그 파생). `signal.NotifyContext` ctx(app.go:320)가 생기면 `context.AfterFunc(sigCtx, cancelGit)`.
- 종료 단계 "git 잡·쓰기 대기": 먼저 `cancelGit()`, 최대 **7s**(2G+1s) 기다리고 초과 시 로그만. 위치는 `shutdownSteps` **인덱스 0 — "마커" 앞**(마커는 "정상 종료" 뜻, FR-OBS-15). `a.shutdown()` 은 HTTP 수신 중단 뒤. 순서 테스트(app_test.go)·주석(app.go:241-251) 갱신.
- 종료로 끊긴 잡: `errorCode:"server_shutdown"`, `err:"서버 종료로 중단했다 — 일부가 적용됐을 수 있다"`, `canceled:false`. 동기 쓰기: 503 `server_shutdown`(재조회 안 함, partial 없음).
- 상수 이동: `jobs.RemoteOpCeiling` → core `JobCeiling`(10분), `jobs.JobKillGrace` → core `KillGrace`(3s). jobs 참조 전부 교체(별칭 없음). `WriteSpec` 에 시한 필드를 두지 않는다(잡은 `withTimeout` 을 거치지 않는다).

## 9. 제약
- Go 1.25, 새 외부 의존성 금지. 기존 플랫폼 추상을 확장한다.
- 레포 관례: 주석·문서 한국어, FR ID 체계, `make gates`/`make test`(-race -shuffle=on) 통과, 관련 e2e(`e2e/git-*.spec.ts`) 회귀 없음. 시간 의존 테스트는 짧은 시한과 가짜 훅 스크립트로 결정적으로, POSIX 신호 의존 테스트는 build tag 분리(Windows CI 샤드 `go test` 통과).
- 커밋 메시지·문서에 AI 서명 금지.

## 10. 인수 기준
- 각 절의 요구마다 실패하던 테스트가 구현 후 통과(결정적).
- 필수 인수 목록:
  - §3: 실제 Start 하는 Setsid 테스트, 신호 시퀀스 A·B 반환 상한(+2G), 훅 자식이 파이프를 쥔 경우, 서명 커밋 저장소에서 log·부모 판정·amend 메시지 무오염.
  - §4: 호출자 취소가 합류자에게 전파되지 않음, 쓰기 뒤 조회가 쓰기 이후 관측, gen ABA 재현.
  - §5: 배타 행렬 12칸의 응답 코드, 잠금 대기 5s 경계·대기 중 취소 시 미실행, 분류표의 잡 종단이 200 `{job}`·실행 전 거부는 동기, 다회 git 쓰기 단계의 절대 상한(마감+6s), push 중 commit 동시 실행, pull 의 두 칸 점유·`/api/git/jobs` 한 번·종료 시 두 칸 비움, common-dir 키 배타(링크드 worktree add ↔ 주 저장소 remove), `/var`↔`/private/var` 존재·부재 경로의 키 동일성, 심링크 경로 저장소의 잡 완료 후 캐시 무효화.
  - §5.3: 두 worktree 탭의 stash push 와 pop 이 겹쳐도 고른 oid 가 pop, 위치가 밀린 oid 성공·사라진 oid 409 `stash_moved`(모든 경로·show 포함), `index` 필드·쿼리 400, stash branch 기존 이름 409(options 없음), 충돌 시 세 필드·안내문 분기, show 가 oid 로 직접 조회, 프런트 목록 갱신 뒤 oid 선택 유지·사라짐 표시, `ErrStashNotFound` 제거.
  - §5.6: worktree 잡 중 remove 409, 대상 index 잡 중 remove 409·요청 worktree index 잡 중 remove 허용, remove 가 stash 를 막지 않음, 요청=대상 unsafe_path, 밖에서 지운 worktree remove 성공(사용자·Run 격리), 연속 remove 성공, `repoLock` 대기 상한·등록 실패 시 반납·디렉터리 정리, Run 격리 Remove 사용 중 잔여물 보고.
  - §6: Job `slots`, 잡 결과 페이로드·undo 창 기점(완료 처리 마지막), stdin 비기록, 충돌 잡 표시, §6.4 표의 성공·실패·충돌·취소·`index_locked`·재부착 e2e.
  - §7: `index_locked` 판정·lock 정보(동기·잡), 삭제 종단 거절 코드 5종, 원격 태그 삭제가 브랜치를 지우지 않음, upstream push 경우별, 충돌 해결 분기·skipped·코드 우선순위, replay 의 stdin·stash 기록 거절, 심링크·gitlink·대용량 diff, status 절단, 값 플래그 하위 명령별 제외(붙은 형태, `branch -m` 뒤 인자 검사), amend 메시지 전용·commentChar/commentString·signoff.
  - §8: 종료 대기 7s, `server_shutdown`(잡·동기), 종료 단계 인덱스 0·cancel 선호출(신호 없는 오류 종료 포함), apierr `gitCodes` 등록.
- `go test -race ./internal/...` 전체 통과, `make gates lint typecheck unit` 통과, 영향 e2e(git-commit, git-branch-actions, git-hunk, git-diff, git-stash 등) 통과.
