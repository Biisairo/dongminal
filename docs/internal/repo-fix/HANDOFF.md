# REPO_FIX 인계 — 다음 세션 착수 문서

> 작성 2026-09-24. 01~05 끝났다. 다음은 **마무리**(`make e2e` 전량 8샤드 + 재감사).
> **사용자 지시: "새 세션에서 순서대로 진행"** — 아래 §3 순서대로 한다.

## 1. 무엇을 하는 일인가

사용자 진술: *"에디터·git 등 repo 쪽에 자잘한 버그가 너무 많아 사용성이 안 좋다. 전부 수정. 구조적으로, 근본적으로 수정해서 정상 동작하게 해야 한다."*

- 감사 원본: `tmp/REPO_AUDIT_2026-09-24.md`(82건+), 반증 검증: `tmp/verify-frontend.md`, `tmp/verify-backend.md`, 02~05 사전 공격: `tmp/preattack-02-05.md` (tmp/ 는 git 밖 — 로컬에만 있다)
- 요구조건(= 이 작업의 SRS, 단일 진실): `docs/internal/repo-fix/0N-*/REQUIREMENTS.md`
  - 01 은 **통합본**이다(`01-git-backend/REQUIREMENTS.md`). 경위는 `REQUIREMENTS-HISTORY.md`(참고만, 기준 아님)
  - 02~05 는 머리말에 "§3A > 본문" 우선순위 — §3A 확정 사항을 먼저 읽어라

## 2. 어디까지 왔나 (커밋 근거)

| 단계 | 내용 | 커밋 |
|---|---|---|
| 01-A P-1~4 | 기동 헬퍼 `core.Spawn`(새 세션 Setsid·그룹 SIGTERM→grace→KILL·파이프 쥔 자식 정리), `-c log.showSignature=false`, 상수 `core.KillGrace`·`core.JobCeiling` | `536a9fcf` |
| 01-B S-1~4 | store single-flight: 호출자 ctx 로만 탈출, 전역 단조 세대(Invalidate), ABA 방지, `core.IsTerminal` | `fe171cb6` |
| 01-C §7.3 | 원격 ref 완전 이름 삭제, 브랜치 메뉴 push 는 `<local>:<upstream ref>`, `upstream_local` | `ba5f910a` `e1585179` `86234563` |
| 01-C §7.4 | resolve 경로별 실행·지운 쪽은 `git rm`·409 `resolve_partial`, apierr 새 코드 5개 등록(repo_busy·index_locked·stash_moved·resolve_partial·server_shutdown) | `0312b148` |
| 01-C §7.5 | stdin·stash 기록 replay 거절 | `8ed905de` |
| 01-C §7.6 | diff 심링크=링크 문자열, gitlink=kind submodule+oid(`ls-tree` 읽기 허용), 그림 크기 상한·512B 판별 | `637e71f8` |
| 01-C §7.7 | status 절단 rename 경계, 가드는 옵션 자리에만(commit·tag 값 플래그 제외), amend 메시지 전용(FR-GIT-84 개정) | 그 뒤 커밋들 ~`d0ef2a55` |
| 01 P-4 조사표 | 설정 영향 실측 — log.showSignature 외 불변 | `5def3a87` |
| 01-D §5.3 | stash oid 지목(apply·show 는 oid, pop·drop·branch 는 찾은 stash@{n}), 409 stash_moved, index 필드 400, stash branch 이름 사전검사, 프런트 oid 선택 모델, Diff 머리 `revLabel` | `d1d6fbcf` `a74ee758` |
| 01-E §5.1·5.4·5.5·7.1·7.2 | `jobs.Exclusion`(뮤텍스·common-dir 잠금·두 칸) buildDeps 주입, `writeLocks` 분류표 + Handle lease, 판정 순서, 단계 ctx(사전 요청+10s·쓰기 루트+30s·사후 루트+15s), `ErrIndexLocked`·lock 필드·resolve 우선, `POST /api/git/lock/remove`, 프런트 100s·lock 버튼 | `202dc805` `55886b21` |
| 01-G §8 | 서버 루트 ctx(`serve` → buildDeps → `Store.WithRoot`), AfterFunc, 종료 표 인덱스 0 "git 잡·쓰기 대기"(cancel → `core.Drain` 7s), `core.ErrServerShutdown` → 503(동기 쓰기 재조회 없음) | `10a2e911` |
| 01-G §5.6 | worktree·submodule `Runner` ctx·`%w`, `worktree.LockRepo`(ctx·시한, common-dir 키 `Spec.LockKey`), `core.CommonDirKey`(nil 수신자), worktree add 잡(common 칸→repoLock→충돌→부모 디렉터리→등록, 완료 처리 config·반납), remove 순서(대상 칸·뮤텍스, 180s 단계 안 repoLock), sync 180s·lock 필드, Run 격리 ctx·TryLock 잔여물, 프런트 index 칸 예외·`timeout:0` | 인계 문서와 같은 커밋 |
| 01-F §5.2·6 | 느린 쓰기 8종 잡 전환, kind 표·모양 제약, stdin, Job JSON `slots`·`errorCode`·`lock`·`result`, 완료 처리 순서, undo 토큰 기점, 프런트 칸별 잡 표시기(`GitJobs`)·`panel.post` 잡 인식·e2e `git-job-indicator.spec.ts` | `6862f2ca` `02b8a777` |

**05 도 끝났다** — F-1 `50de3c10`, F-2 `afe856ee`(+회귀 수정 `a719bc25`), F-3 `37a2ce04`, F-4 `9e33a09f`, F-5 `7cb95605`, F-6 `200ff7e2`, F-7 `501af931`, F-8 `af3157b1`, F-9 `b5a7f7ef`. 정정·추적표는 `05-git-frontend/REQUIREMENTS.md` §3A-8. **남은 플래그**: Clean 은 서버가 목록을 받지 않아 확인 뒤~실행 사이 서버 쪽에 생긴 untracked 까지 지울 수 있다(서버 `paths` 필드가 필요 — 사용자 결정 대상). 옛 Git 창의 저장소 전환은 Diff 만 연 dirty 문서를 확인 없이 버린다(이전과 같음, 비범위).

**04 도 끝났다** — 서버(mark·대소문자) `4e1eacea`, 프런트는 인계 갱신과 같은 커밋. 정정·추적표는 `04-explorer/REQUIREMENTS.md` §3A-8.

**03 도 끝났다** — 서버 `2bc4e059`, 조회·dirty 파생 `4768034a`, 문서 레지스트리 `053e283f`, 인코딩 UI 는 인계 갱신과 같은 커밋. 정정·추적표는 `03-editor/REQUIREMENTS.md` §3A-9.

**02 도 끝났다** — G-1 `0cee908c`, G-2 `24174030`, L-4 `a9a75741`, L-1~3 `eb96878e`, L-5 `84671484`. 추적표·구현 중 정정은 `02-lsp-gitwatch/REQUIREMENTS.md` §3A-8·각 절.

**01 은 전부 끝났다.** (G 에서 정정한 요구조건은 `01-git-backend/REQUIREMENTS.md` §5.6 "구현 중 정정 (01-G)")

**01-F 에서 한 것** (커밋은 이 문서 아래 표): jobs 의 kind 표·모양 제약(`jobs/kinds.go`), `JobRunner` stdin, Job JSON `slots`·`errorCode`·`lock`·`result`, 완료 처리 순서(기록→lock→무효화 훅→`OnFinish`→공개), `WithRoot`(server_shutdown 판정 — 배선은 G), 원격 전용 판정·취소 문구 kind 한정. write 의 실행 함수를 `*Spec`(CommitSpec·CheckoutSpec·RebaseSpec·DropSpec·OperationSpec)으로 바꿨다. gitapi `startWriteJob`·`indexFinisher`(gitjob.go). 프런트: `GitRemote` = 칸 하나의 표시기, `GitJobs`(jobs.js) = 두 칸 묶음, `panel.post` 가 `{job}` 을 받으면 붙이고 기다려 동기 모양으로 편다(`postJob` 은 다이얼로그용 detach).

**01-F 에서 G 로 넘긴 것**: worktree add 잡(`StartUnguarded("worktree")` 는 받게 해 뒀다 — 핸들러·repoLock·config 완료 처리는 §5.6 과 함께), Manager 경유 쓰기의 lock 필드.

**01-E 에서 F·G 로 넘긴 것**:
- ~~(F) 잡 완료 처리의 lock 판정·잡 결과의 lock 버튼~~ 01-F 에서 함
- (G) Manager 경유 쓰기(submodule sync·worktree remove)의 lock 필드 — Manager 가 `%v` 로 감싸 sentinel 이 사라진다(§5.6 `%w` 전환과 함께), 180s 단계 마감·루트 ctx
- (G) `writeLocks` 의 worktrees/create·remove·submodules/update 는 현행(잠금 없음) — §5.6 순서로 바꾼다. Run 격리에 `Deps.GitExclusion` 주입(지금은 GitServer 만 받는다)
- (G) common-dir 키 헬퍼의 Service nil 동작(FR-GXU-4) — 지금은 `store.CommonDir` 경유(Git 이 있어야 한다). Git 없는 배선의 잡 키는 `jobKeys` 가 루트로 대신한다

## 3. 남은 일 — 순서

1. ~~**01-E**~~ 완료 (§5.1·5.4·5.5·7.1·7.2): 배타 상태 단일 인스턴스(`buildDeps` 에서 생성·주입), 저장소 뮤텍스(ctx 존중·5s)·common-dir 잠금(stash 5종)·index/common 두 칸 잡 슬롯, 판정 순서, 단계별 마감(대기 5·사전 10·쓰기 30·사후 15, 쓰기는 루트 ctx 파생), `ErrIndexLocked` 분류 + 모든 동기 쓰기 실패에 lock 필드, `POST /api/git/lock/remove`, 프런트 `GIT_WRITE_FETCH_TIMEOUT_MS` 35000→100000, resolve 의 index_locked 우선
2. ~~**01-F**~~ 완료 (§6 — worktree add 잡은 G 로 넘김): 잡 전환(commit·checkout·operation·branch merge/rebase·checkout:true·cherry-pick/revert·drop·worktree add), `jobKinds`·모양 제약, stdin, 사전 단계 위치, 완료 처리 순서(①~⑧), Job JSON `slots`·`result.*`, undo 토큰 기점, 원격 전용 판정 한정, 프런트 **일반화 잡 표시기**(remote.js 상태기계 → kind 무관, §6.4 표 두 개)
3. ~~**01-G**~~ 완료 (§5.6·8, E·F 에서 넘긴 것 포함)
4. ~~**02 gitwatch·LSP**~~ 완료 — `02-lsp-gitwatch/REQUIREMENTS.md` (§3A 필독: LSP 경로는 **서버 설정 `<dataDir>/lsp-paths.json` + GET/PUT `/api/lsp/paths` + 설정 ▸ Code UI**, 사용자 결정)
5. ~~**03 에디터**~~ 완료 — 인코딩 왕복(x/text 의존성 추가 승인됨, 자동판별 BOM→UTF-8→CP949 + 다시 열기 4종 + "UTF-8 로 변환해 저장" 확인창), 권한·심링크 보존, 응답 후 재확인 장치, slot 인식 조회, 문서 이동 API(undo 소실 허용), tab.dirty 비영속
6. ~~**04 탐색기**~~ 완료 — 로드 세대·coalesce, 폴더 관측 상태 4종, 대소문자 이름변경(같은 부모+대소문자만 다름+SameFile), status 응답 `mark` 는 04 가 추가
7. ~~**05 git 프런트**~~ 완료 — Delete both 한 쌍, Diff = 편집기 문서 모델 공유(문서 단위 저장 `edDocSave`), 어휘적 저장소 최상위 경로, 쓰기 세대·stage 큐, 커밋 draft/amend 슬롯 분리, 결과 미상 잡 판정(`gitJobOutcome`)
8. **마무리** ← **여기서 시작**: `make e2e`(전량 8샤드) + 재감사

직전 세션 말미에 사용자에게 "데이터 손실 5건(Delete both·Diff hunk 오적용·입력 유실·칸1 닫기 확인 누락·저장 권한)을 먼저 하자"고 제안했으나 **사용자는 "순서대로"를 택했다.** 제안을 다시 꺼내지 말고 위 순서대로 간다.

## 4. 진행 방식 규약 (사용자 지시 — 어기지 마라)

- **워크플로우(sdd-tdd 등)를 쓰지 않는다. 직접 한다.** ("워크플로우 사용하지 말고 직접 해줘") 서브에이전트에 판단을 맡기지 말고, 공격·검증 지적은 **직접 코드와 대조해 판정**한다("진동하는 건 직접 보고 진짜 오류인지 아닌지 제대로 잡아. 맡기지만 말고")
- TDD: 테스트를 먼저 쓰고 실패를 본 뒤 구현한다. 각 변경에 이전/새/이유를 코드 주석이나 커밋에 남긴다(레포 관례: `//\t이전 동작: … / 새 동작: … / 이유: …`)
- **커밋**: 게이트 통과 시 자동 커밋(사용자 승인). 메시지 관례 `fix(git): … (REPO_FIX 01 §x.y)`, 한국어, **AI 서명 금지**
- 요구조건과 코드가 충돌하면 코드를 보고 판정하고, 요구조건 문서를 **제자리에서 정정**하며 "(구현 중 정정: 사유)"를 남긴다(예: §7.3 TagOid, §7.7 태그 stdin 은 정정됨)

## 5. 게이트·검사 (값을 치르고 배운 것)

- **게이트 종료 코드를 파이프로 가리지 마라.** `make gates 2>&1 | tail -1 && git commit` 은 실패해도 커밋된다 — 실제로 한 번 기준선 위반 커밋이 들어갔다. `make gates >/tmp/g.log 2>&1; echo $?` 로 본다
- 커밋 전: `make gates`(gofmt·vet·이음매·오류 카탈로그·모듈 크기 기준선 등), `make typecheck`, `make unit`, `go test -race ./internal/... ./cmd/...`, 관련 e2e(`npx playwright test e2e/<spec> --reporter=line`)
- apierr 코드를 바꾸면 `go run ./scripts/gen-errors` 로 `docs/external/errors.md` 재생성. 새 sentinel 은 tables.go·inventory.go·**git_table_test.go**(gitTableCases) 모두에
- **모듈 크기 기준선**: web/js 파일이 500줄을 넘으면 게이트 실패(23개 동결). 넘으면 파일을 나누고 `web/index.html` 에 script 태그 추가
- **이음매 게이트**: `syscall.Kill` 등 OS 호출은 `internal/shared/platform` 밖(테스트 포함)에 두지 못한다 → `platform.Current().Process.Alive`
- Linux 에는 `syscall.Getsid` 가 없다 → `golang.org/x/sys/unix`
- 읽기 허용 목록 개수 고정 테스트(`core/exec_gate_test.go` wantRead=16)
- Setsid 로 띄우면 Go 가 fork 경로를 타 chdir 실패가 `fork/exec` 오류로 온다 → `ErrRepoMissing` 은 `os.Stat(dir)` 로 판정(이미 반영)
- `exec.Command` 로 만든 cmd 는 `Cancel`·`WaitDelay` 가 무시된다 → `core.Spawn` 은 `exec.CommandContext` 로 만든 cmd 만 받는다
- 완전 이름(`refs/heads/x`) 원격 삭제는 이미 없는 ref 도 경고와 함께 **성공(exit 0)** 한다(실측)
- 픽스처 `gittest.Repo` 두 개의 첫 커밋 oid 가 같다 — 서브모듈 테스트는 서브 쪽을 한 번 더 커밋해야 한다
- e2e 는 `npx playwright test` 가 바이너리를 스스로 빌드한다. `timeout` 명령이 없다(macOS)
- `e2e/branch-menu-unify.spec.ts` "원격이 실제로 지워지면 조용하다" 가 부하 중 flaky(E·F 전량에서 각 1회 실패, 단독 3/3 통과). `git-dialog` D6·`git-menu` N3(Esc 계열)도 전량 부하에서 1회씩 떨어졌고 단독은 통과 — 가짜 항목만 재는 테스트라 변경과 무관으로 판정했다
- **(01-E·F 에서 배운 것)**
  - 쓰기 잠금 분류는 `gitapi/gitlock.go` 의 `writeLocks` 표 하나다(POST 종단 전부가 있어야 한다 — `TestWriteLocks_CoverAllPostRoutes`). 잠금은 `gitWrite.resolve` 가 쥐고 `Handle` 의 lease 가 핸들러 뒤 반납한다. 사전 단계 조회는 `t.ctx()`, 쓰기는 `t.write`, 사후는 `t.post()` 를 쓴다(`r.Context()` 를 새로 쓰지 마라)
  - `jobs/job.go` 는 **원격 표면 파일**이라 `token`·`secret` 이 든 이름·주석을 두면 `core/credentials_static_test` 가 실패한다(그래서 `Result` 는 `jobs/result.go`). `creden…` 은 저장소 전체 금지 — 주석에도 쓰지 마라
  - gitapi 테스트 서버(`gitWriteServer`·`gitM5Server`·`gitCoServer`)는 `s.gitJobs.run = fakeJobRunner(f.write)` 로 잡도 fake 에 태운다 — 빼면 **실제 git 이 돈다**. 잡 종단 테스트는 `gitReqAwait`(잡 완료 대기 + 동기 모양) 로 쓴다
  - 잡 쓰기의 쓰기 가드가 모양 제약보다 먼저 거절하는 경우가 있다(`submodule`·`worktree` 는 쓰기 허용 목록 밖, `am --quit`·`bisect good` 은 금지 하위 명령)
  - 프런트: 잡 박스가 칸마다 둘(`.git-job[data-slot=index|common]`) — e2e 는 `.git-job.vis` 로 짚는다. 새 잡이 시작되면 다른 칸의 **끝난** 결과는 걷힌다(`GitJobs._dismissOthers`)
  - `constants-git-commit.js` 는 `constants-git-remote.js` 보다 **먼저** 로드된다 — 앞 파일에서 뒤 파일 상수를 쓰면 TDZ 로 전체가 죽는다(`GIT_JOB_BUSY_NOTE` 를 앞 파일에 둔 이유)
  - web/js 500줄 기준선: `commit.js` 496·`remote.js` 949(최대 959 는 panel-diff) — 더 늘리면 파일을 나눠라
- **(01-G 에서 배운 것)**
  - 잡 허브(`gitJobHolder.get`)는 **처음 쓸 때 실행기를 고정한다** — 테스트가 잡을 한 번 띄운 뒤 `s.gitJobs.run` 을 바꾸면 적용되지 않는다(단독 실행은 타이밍으로 통과하고 `-race -shuffle` 전량에서만 떨어졌다). 서버를 만들 때 넣어라(`wtExclServer` 참고)
  - worktree 생성은 이제 잡이다 — e2e·Go 테스트에서 경로가 필요하면 잡 완료를 기다린다(`wtCreateAwait`, e2e `createUserWorktree`)
  - `worktree.LockRepo` 는 패키지 전역 잠금이다 — 테스트 간 키가 겹치지 않게 임시 경로를 키로 써라
- **(02 에서 배운 것)**
  - 게이트를 `;` 로 잇고 커밋하면 실패해도 커밋된다 — 한 번 또 당했다. `make gates …; rc=$?; if [ $rc -eq 0 ]; then git commit …; fi` 로만 커밋한다
  - SSE 쓰기 시한은 미들웨어 `responseWriter.Unwrap()` 이 있어야 닿는다(`http.ResponseController`)
  - 새 홈 파일은 `internal/ctl/cli/homelayout.go`·`docs/external/getting-started.md` 표에, 새 종단은 `docs/external/api.md` 에 등록해야 게이트가 통과한다. PUT 요청은 Content-Type 이 없으면 415
  - LSP 가짜 서버(`fakeStarter`·`killableStarter`)는 읽기 고루틴 하나다 — 처리기 안에서 막으면 뒤 메시지가 전부 멈춘다. `go test` 는 `-timeout` 을 줘서 돌려라(행이 나면 스택이 나온다)
  - 서버 경로 표는 `팩/서버` 키, `ext.Locator` override 는 서버 id 키 — `lsp.Service.locatorOverrides` 가 옮긴다
- **(03 에서 배운 것)**
  - 문서 API: `edDoc`(자리)·`edDocAt`(조회만)·`edDocLoad`·`edDocRefresh`·`edDocMove`·`edDocDirtySync`·`edDocReopen`·`edDocConvertUtf8` (`app-editor-doc.js`), 토큰 `docTokenOf/docTokenValid` (`doc-token.js`). 04 의 이름변경은 `edRetargetTabs`→`edDocMove` 를 탄다. 05 의 Diff 뷰는 이 문서·토큰·저장 대기(`savePromise`)를 재사용한다
  - 편집기 조회는 `editorsOf`·`editorAny`·`editorsDrop` 뿐(게이트). ui/ 는 App 의 `_이름` 에 닿지 못한다(게이트 FR-FMB-40) — 필요하면 공개 이름을 만든다
  - e2e 는 `app.testing.<이름>` 만 쓴다 — 새 내부 이름은 `app-testing.js` 에 먼저 등록
  - 한국어 조사는 `{으로로}` 같은 마커(게이트 FR-WRD-65), OS 분기 테스트는 build tag 파일(이음매 게이트), 새 Go 패키지는 `docs/internal/architecture.md` 표에
  - 문서 로드가 끝나면 dirty 가 초기화된다 — e2e 에서 `_dirty=true` 를 세우려면 `_editor` 가 선 뒤에
- **(04 에서 배운 것)**
  - 탐색기 관측: store 가 `obs`(unseen·ok·failed·gone, `file-tree-obs.js`)·`gen`(낙관 반영이 올린다)·`loadQ`(대기 1건)·`gitKey`(mark 비교)를 든다. 스탬프 폴링은 `store.pollStamp()` 하나(모든 뷰의 펼침 합집합)
  - 낙관 반영과 진행 중 로드의 경합이 실제로 있다 — 테스트는 로드 완료를 기다리지 않는 순서로도 돌려라(`--repeat-each`)
  - status 응답의 `mark`(=`store.Mark`)가 "관측이 같은가" 의 유일한 기준이다 — 05 도 이것을 쓴다

- **(05 에서 배운 것)**
  - 회귀 범위를 좁게 잡지 마라 — F-2 때 `git-view-refresh` 를 빼고 돌려 회귀(바깥 변경이 Diff 에 안 옴)가 다음 단계에서야 드러났다. git 프런트를 건드리면 `e2e/git-*.spec.ts` 전부를 돌린다(약 8분)
  - 문서 저장은 `app.edDocSave(path, ui)` 하나다(`ui` = `_confirmConflict`·`_noteUnmappable`·`_noteSaveFailed`). Diff 뷰는 레지스트리에 `_docViewOf` 객체로 든다(`_editor` 를 주지 않는다 — 레지스트리가 `setModel(model)` 을 부른다)
  - 잡 결과 판정은 `gitJobOutcome(jb)`(jobs.js) 하나 — `!exitCode` 로 읽지 마라(결과 미상이 성공이 된다)
  - 메뉴 항목은 `busy`(잡 키 | 'write')를 선언해야 한다 — `git-feedback.test.mjs` 가 누락을 잡는다. 비활성 사유는 `GitMenu._why`
  - status 는 탐색기도 폴링한다(`clientId` 없음) — 패널의 관측만 재려면 `clientId=` 로 가르거나 그 패널의 `apiGet` 한 번을 가로챈다
  - e2e 의 고정 대기는 "일어나지 않음" 을 잴 때만, `**예외 (\`TEST-16\`)**` 표식과 사유를 붙인다(게이트). testing 계약 이름은 `_` 를 뗀 것이다(`app.testing.edDocs`)
  - helpers.js 는 최대 파일(기준선)이다 — 새 전역 헬퍼는 새 파일로(`core/git-path.js`)

## 6. 유효한 사용자 결정 (요약 — 상세는 각 REQUIREMENTS)

- 느린 쓰기 → **기존 원격 잡 경로로 전환**, 상한 10분, 진행·취소 UI
- index.lock → **자동 삭제 없음** + 409 `index_locked` 안내 + 확인 후 "남은 lock 지우기"
- 잡 슬롯 두 칸(index·common) — push 중 commit 허용, pull 은 두 칸
- amend 메시지 전용 허용(반영됨)
- 인코딩 왕복(x/text) + 자동판별 + 수동 다시 열기 + UTF-8 변환 저장
- LSP 경로는 서버 설정 + UI
- git Diff 뷰는 편집기 문서 모델 공유(VS Code 방식)
- 기본값으로 정한 것(사용자에게 알림 완료): Run 격리 repoLock 180s 대기, pull 두 칸, Diff dirty 중 hunk 비활성, 결과 미상 커밋은 초안 유지, UTF-8 변환 저장 확인창

## 7. 착수 블록

```
git status && git log --oneline -3   # 맨 위가 05 인계 갱신 커밋, 그 아래 b5a7f7ef(F-9), 트리 깨끗
make e2e 를 8샤드로 전량 돌린다(Makefile 의 e2e 목표·샤드 방식 확인). 실패는 단독 반복으로 flaky 여부를 가르고,
진짜 실패는 원인 커밋을 찾아 고친다(§5 flaky 목록 참고).
재감사: tmp/REPO_AUDIT_2026-09-24.md 의 항목을 01~05 추적표(각 REQUIREMENTS 의 §3A 끝)와 대조해 닫히지 않은 것을 찾는다.
```
