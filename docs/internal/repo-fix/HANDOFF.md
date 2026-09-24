# REPO_FIX 인계 — 다음 세션 착수 문서

> 작성 2026-09-24. 직전 세션이 01(git 백엔드)의 A~D 를 끝내고 넘긴다.
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

**아직 안 한 01 항목**: `store.WithRoot` 는 만들었지만 **서버 루트 ctx 배선은 안 됐다**(기본 `Background`, G 에서 한다 — 쓰기·사후 단계는 이미 `s.Git.Root()` 에서 파생하므로 G 는 배선만 하면 된다).

**01-E 에서 F·G 로 넘긴 것**:
- (F) 잡 완료 처리의 lock 판정·`errorCode`/`lock` 필드, 잡 결과의 lock 버튼. 지금 잡 칸 규칙은 `jobs.SlotsOf`(kind→칸)에 있고 commit 등 index kind 는 그대로 index 칸이 된다
- (G) Manager 경유 쓰기(submodule sync·worktree remove)의 lock 필드 — Manager 가 `%v` 로 감싸 sentinel 이 사라진다(§5.6 `%w` 전환과 함께), 180s 단계 마감·루트 ctx
- (G) `writeLocks` 의 worktrees/create·remove·submodules/update 는 현행(잠금 없음) — §5.6 순서로 바꾼다. Run 격리에 `Deps.GitExclusion` 주입(지금은 GitServer 만 받는다)
- (G) common-dir 키 헬퍼의 Service nil 동작(FR-GXU-4) — 지금은 `store.CommonDir` 경유(Git 이 있어야 한다). Git 없는 배선의 잡 키는 `jobKeys` 가 루트로 대신한다

## 3. 남은 일 — 순서

1. ~~**01-E**~~ 완료 (§5.1·5.4·5.5·7.1·7.2): 배타 상태 단일 인스턴스(`buildDeps` 에서 생성·주입), 저장소 뮤텍스(ctx 존중·5s)·common-dir 잠금(stash 5종)·index/common 두 칸 잡 슬롯, 판정 순서, 단계별 마감(대기 5·사전 10·쓰기 30·사후 15, 쓰기는 루트 ctx 파생), `ErrIndexLocked` 분류 + 모든 동기 쓰기 실패에 lock 필드, `POST /api/git/lock/remove`, 프런트 `GIT_WRITE_FETCH_TIMEOUT_MS` 35000→100000, resolve 의 index_locked 우선
2. **01-F** (§6): 잡 전환(commit·checkout·operation·branch merge/rebase·checkout:true·cherry-pick/revert·drop·worktree add), `jobKinds`·모양 제약, stdin, 사전 단계 위치, 완료 처리 순서(①~⑧), Job JSON `slots`·`result.*`, undo 토큰 기점, 원격 전용 판정 한정, 프런트 **일반화 잡 표시기**(remote.js 상태기계 → kind 무관, §6.4 표 두 개)
3. **01-G** (§5.6·8): repoLock ctx·common-dir 키, Runner ctx, worktree add 잡·remove 순서(요청 worktree 칸·뮤텍스 안 봄), Run 격리 TryLock·잔여물, 서버 루트 ctx(`serve` 에서 WithCancel → buildDeps, AfterFunc, shutdownSteps 인덱스 0, 7s), `server_shutdown`
4. **02 gitwatch·LSP** — `02-lsp-gitwatch/REQUIREMENTS.md` (§3A 필독: LSP 경로는 **서버 설정 `<dataDir>/lsp-paths.json` + GET/PUT `/api/lsp/paths` + 설정 ▸ Code UI**, 사용자 결정)
5. **03 에디터** — 인코딩 왕복(x/text 의존성 추가 승인됨, 자동판별 BOM→UTF-8→CP949 + 다시 열기 4종 + "UTF-8 로 변환해 저장" 확인창), 권한·심링크 보존, 응답 후 재확인 장치, slot 인식 조회, 문서 이동 API(undo 소실 허용), tab.dirty 비영속
6. **04 탐색기** — 로드 세대·coalesce, 폴더 관측 상태 4종, 대소문자 이름변경(같은 부모+대소문자만 다름+SameFile), status 응답 `mark` 는 04 가 추가
7. **05 git 프런트** — Delete both(가장 위험), Diff 는 **편집기 문서 모델 공유**(사용자 결정), 저장소 최상위 기준 경로, 커밋 초안/amend 슬롯 분리 등. 01 이 만든 잡 UI 를 전제로 한다
8. 마무리: `make e2e`(전량 8샤드) + 재감사

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
- `e2e/branch-menu-unify.spec.ts` "원격이 실제로 지워지면 조용하다" 가 부하 중 1회 flaky(재시도 없이 5/5 통과, 알려진 flaky 목록에는 없음) — 전량에서 다시 보라

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
git status && git log --oneline -3   # 인계 문서 커밋(docs(repo-fix): 다음 세션 인계 문서) 이 맨 위, 그 아래 a74ee758, 트리 깨끗
docs/internal/repo-fix/01-git-backend/REQUIREMENTS.md 의 §5.1·5.4·5.5·7.1·7.2 를 읽고 01-E 부터 시작한다.
먼저 internal/webserver/gitapi/gitwrite.go(beginWrite→resolve→snapshot→apply→ok 파이프라인)와
internal/webserver/domain/git/jobs/job.go(active 맵·Start·StartUnguarded)를 읽어 배타 상태를 어디에 둘지 정한다.
```
