# 요구조건 공격 검증 보고서 — 01 git 백엔드 (IEEE 29148 검증 기록, 11차)

- 대상: `docs/internal/repo-fix/01-git-backend/REQUIREMENTS.md` (§3J 10차 확정 반영본, 756줄)
- 검증일: 2026-09-24
- 이전 판: 10차 보고서(주요 2·경미 5)는 §3J-1~4 와 제자리 정정으로 해소 위치가 지정됐다. 이 판은 §3J 반영본 전체를 현 코드와 다시 대조한 결과다.
- 방법: 결정 분기 확인 + file:line 대조
  - `domain/worktree/worktree.go:157-180` `resolveSymlinksPrefix` 존재 확인. worktree 패키지는 이미 core 를 import 한다(worktree.go:22) — core 로 옮겨도 순환이 없다.
  - `domain/worktree/remove.go:44-47` 자기 제거 거부(Clean 비교), `:53-55` `repoLock` 무기한 `Lock()`, `:57-62` 경로 부재 시 prune 후 성공.
  - `gitapi/handlers_git_worktree.go:183-227`: 대상은 `List` 결과에서 `filepath.Clean(req.Path)` 로 찾는다.
  - `domain/git/write/stash.go:62-63,365` `ErrStashNotFound`, `apierr/tables.go:40`(404 `not_found`), `apierr/inventory.go:40`.
  - `domain/git/write/stash.go:309-322` `StashPreview` 는 index 인자, `ExecWrite` 경로.
- 판정: **불통과**. 주요 결함 0건, 경미 결함 6건.
- 10차 지적 해소 확인: M1(§5 반대 기대값) 해소 — §5 §3G 줄이 "대상 worktree index 잡 중 remove 409" 로 바뀜. M2(prunable 키) §3J-1 로 해소. m1 근거 정정(§3I-4) 해소. m2 §3J-2 로 해소(207s 가 §3B-3·§3D-7·§3E-3·§3I-4 에서 일치). m3 §3B-1·§3B-2(5)·§3B-8·§3C-3 정정 확인. m4 §1·§3C-3·§3J-4 해소. m5 §3J-3 해소.

## 1. 주요 결함 (major)

없음.

## 2. 경미 결함 (minor)

### m1. §3C-2 의 worktree remove 문장이 §3J-2 와 정면으로 모순된다
- §3C-2(357행): "같은 common dir 에 worktree 잡이 진행 중이거나 … 409 `job_busy`(**획득 전 확인 + 획득 후 재확인**) … 잠금 순서는 §3I-4(… **common-dir 잠금은 사전 단계 동안만**)".
- §3J-2 는 common-dir 잠금을 **없앴고**, 뮤텍스 획득 뒤 재확인하는 것은 대상 index 칸뿐이다(worktree 잡 재확인 없음 — 그 틈은 `repoLock` 대기 → 409 `repo_busy` 로 수용). 우선순위 규칙으로 풀리긴 하지만, 10차에서 잔존 문구를 "제자리 정정"한다고 한 목록에 §3C-2 의 이 문장이 빠졌다.
- 권고: §3C-2 remove 문장을 "순서는 §3J-2(common-dir 잠금 없음, 뮤텍스 뒤 재확인은 대상 index 칸만 — worktree 잡과의 틈은 `repoLock` 대기가 409 `repo_busy` 로 막는다)" 로 고친다.

### m2. 순서 권위를 §3I-4 로 가리키는 잔존 참조 — §3I-4 순서에는 common-dir 잠금이 들어 있다
- §3D-7(474행) "worktree remove 단계 소속: **§3I-4 순서로 대체**", §3E-3(519·520행) "worktree remove 는 §3I-4", "순서는 **§3I-4 가 확정한다**", §5 "§3F 추가 인수: worktree remove 의 **§3I-4 순서**", "§3E 추가 인수: … 잠금 순서(**§3I-4**)".
- §3I-4 본문의 순서(① common-dir 잠금 … ⑤ 반납)는 §3J-2 가 대체했다. 테스트 단계가 §5 를 직접 입력으로 쓰면 없어진 common-dir 잠금을 검증하는 테스트가 나올 수 있다.
- 권고: 다섯 곳 모두 §3J-2 로 바꾼다.

### m3. §3H-5 가 §3I-1 과 반대 실행 방식을 적은 채 이력 표시가 없다
- §3H-5: "서버가 목록에서 **현재 위치를 찾아** 미리보기". §3I-1: "`stash show … <oid>` — **위치를 거치지 않는다**, 목록은 409 판정에만". R-6.1 본문은 "미리보기도 oid 로 조회한다(§3H-5)" 로 §3H-5 를 가리킨다.
- 권고: §3H-5 에 "실행 방식은 §3I-1 로 대체" 를 붙이거나 문장을 고치고, R-6.1 참조를 §3I-1 로 바꾼다.

### m4. 기존 `ErrStashNotFound`(404 `not_found`)의 처리와 `stash_moved` 의 관계가 정해지지 않았다
- 현행 `write.ErrStashNotFound`("그 인덱스의 stash 가 없다", stash.go:63·365)는 apierr 에서 404 `not_found`(tables.go:40)로, `Inventory`(inventory.go:40)에 등록돼 있다. index 입력을 없애면(§3G-2·§3H-4) "인덱스 범위 밖"은 생길 수 없고, "대상 stash 가 없다"는 새 409 `stash_moved` 가 맡는다.
- 두 sentinel 의 관계(제거·통합·병존)가 없어서, 구현이 `ErrStashNotFound` 를 남기면 쓰이지 않는 코드(DoD 위반)가 되고, 반대로 일부 경로(예: `StashPopChecked` 의 `stashMissing`, show 의 목록 확인)가 여전히 그것을 반환하면 같은 상황이 404 와 409 로 갈린다.
- 권고: "`ErrStashNotFound` 와 그 tables·inventory·apierr_test 항목은 제거하고, oid 가 목록에 없는 모든 경로(apply·pop·drop·branch·show)는 `ErrStashMoved` 409 로 통일한다" 처럼 한 줄로 정한다(이전/새/이유 포함).

### m5. worktree remove 순서(§3J-2)에 "쓰기 단계 직전 요청 ctx 확인"이 없다
- 일반 동기 쓰기는 §3B-2 판정 1④ 에서 쓰기 단계 직전 요청 ctx 를 확인해 이미 떠난 클라이언트의 쓰기를 실행하지 않는다(R-2.3 "아직 시작하지 않은 쓰기는 클라이언트가 떠나면 실행하지 않는다"). §3B-2(5)는 remove 가 "1①~③ 대신" §3J-2 를 따른다고 하는데, §3J-2 ①~④ 에는 ④(요청 ctx 확인)에 해당하는 단계가 없다. 뮤텍스 대기(≤5s) 중 브라우저가 떠나면 remove 가 실행되는지가 모호하다.
- 권고: §3J-2 에 "③ 뒤, 쓰기 단계 전 요청 ctx 확인 — 떠났으면 반납·미실행" 을 명시한다(§3B-2 1④ 와 같다).

### m6. `repoLock` 5s 상한이 만드는 사용자 remove 의 동작 변경이 기록되지 않았다
- 현행 `Manager.Remove` 는 `repoLock` 을 무기한 `Lock()` 한다(remove.go:53-55) — 같은 저장소의 두 remove 는 직렬로 둘 다 성공한다. §3J-2 ④ 는 `repoLock` 대기를 ≤5s 로 잘라 초과 시 409 `repo_busy` 로 끝낸다. `repoLock` 키가 common dir(§3C-2)이므로 **서로 다른 worktree** 를 연달아 지우는 경우(Worktrees 목록에서 두 개를 빠르게 제거 — remove 컨트롤은 동기 쓰기라 `slots` 로 잠기지 않는다)나 Run 격리 Create/Remove(git 1회 ≤180s)가 `repoLock` 을 쥔 동안에도 두 번째 remove 가 5s 뒤 실패한다. `Remove` 는 재시도·브랜치 삭제를 포함해 5s 를 쉽게 넘는다.
- §3I-4·§3H-2 는 "worktree add 잡과의 틈"만 수용 근거로 적었고, 이 일상 경로의 이전/새/이유는 없다(§6 DoD "조용한 동작 변경 없음").
- 권고: 택일 — (a) 수용하고 이전(직렬 대기 후 둘 다 성공)/새(두 번째 409 `repo_busy`)/이유를 기록하며 프런트가 진행 중 remove 동안 같은 저장소의 다른 remove 컨트롤을 busy 로 둔다, (b) remove 의 `repoLock` 대기를 쓰기 단계 마감(180s) 안에서 기다리게 한다(최악 시간 207s → 5s 항목이 180s 안에 흡수되므로 불변). 권장 (b) — 상한은 이미 쓰기 단계 마감이 보장하고, 사용자 흐름의 퇴행이 없다.

## 3. 결정 간 미해결 의존성

- m6 → §3J-2 ④·§3D-7·§5: `repoLock` 대기 규칙을 정해야 remove 최악 시간(207s)의 구성과 "연속 remove" 인수 테스트를 쓸 수 있다.
- m4 → §3B-6·§3G-2·§3I-1: `ErrStashNotFound` 처리가 정해져야 apierr 등록 목록(tables·inventory·apierr_test)과 stash 경로별 응답 코드가 확정된다.
- m1·m2 → §5: 순서 참조가 §3J-2 로 통일돼야 테스트 단계가 잘못된(없어진) common-dir 잠금을 검증하지 않는다.

## 4. 후속 단계를 막는 미결 질문

1. worktree remove 의 `repoLock` 대기는 5s 상한인가, 쓰기 단계 마감(180s) 안의 대기인가? (m6, 권장: 쓰기 단계 마감 안)
2. `ErrStashNotFound`(404)를 제거하고 `stash_moved`(409)로 통일하는가? (m4, 권장: 통일)

## 5. 통과 확인 항목 (결함 없음)

- §3J-1: `resolveSymlinksPrefix` 는 존재하는 가장 깊은 조상까지 풀고 나머지를 붙인다(worktree.go:157-180). core 로 옮겨도 worktree→core 방향이 기존과 같아 순환이 없다. 존재 경로에서는 `EvalSymlinks` 결과와 같아 기존 키와 일치한다.
- §3J-2 교착: 모든 경로가 "common-dir(stash 만) → toplevel 하나 → repoLock" 의 부분열이다. Run 격리 Remove(대상 TryLock → repoLock)와도 순서가 같다.
- §3J-2 요청=대상: 대상은 `List` 결과(git 출력)에서, `Repo` 는 `RepoRoot`(git 출력)에서 오므로 remove.go:44 의 Clean 비교가 같은 표기끼리 이뤄진다.
- §3J-4: `write.Stash` 가 이미 `Oid` 를 JSON 으로 싣는다(stash.go:67-73) — 프런트 선택 키 전환에 추가 서버 필드가 필요 없다.
- §5: 10차 M1 의 반대 기대값은 제거됐다. 최악 시간 207s 가 §3B-3·§3D-7·§3E-3·§3I-4·§3J-2 에서 일치한다.
