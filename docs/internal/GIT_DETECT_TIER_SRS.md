# SRS: 감지는 두 단이다 — 싼 것을 자주, 비싼 것을 필요할 때 — IEEE 29148

> **문서 상태**: 초안

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

사용자가 접수한 진단은 이것이었다.

> **"지금 구조는 변경이 없어도 1초마다 git 을 돌린다."**

**그 진단은 정확했다**(`11 GP-7`). `hub/gitwatch.go:242` 가 감시 회차마다
`Store.Status()` 를 부르고, 그것은 TTL 200ms 캐시를 지나지만 1초 주기에서는
**매 회차 실제 `git status --porcelain=v2` 프로세스가 뜬다.** 최대 16개 저장소가
동시에, 브라우저가 숨어도 최대 90초 동안.

그리고 **그 설계를 정당화한 문서가 무효다.** `GIT_PUSH_OBSERVE_SRS §1.2` 는
fsnotify 를 기각하며 *"`ReadSignature` = read 1회 + stat 2회 = 0.02ms"* 를
근거로 들었다. 구현은 그 자리에서 `git status` 를 돌린다 — SRS 가 약속한
**"비용은 옮겨질 뿐 늘지 않는다"** 가 성립하지 않는다.

본 SRS 는 **서버가 원래 쓰기로 했던 signature 를 1차 게이트로 되세운다.**
그리고 signature 가 보지 못하는 구멍(`GP-11`)을 stat 서너 번으로 메운다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 감사 ID |
|---|---|---|
| **A** 2단 게이트 | 1초 회차는 `ReadSignature` 만. `git status` 는 ① signature 가 바뀐 회차 ② 저빈도 워크트리 회차에서만 | GP-7 |
| **B** 병렬·시한 | 회차를 세마포어로 병렬화하고 회차당 `context.WithTimeout` 을 준다 | GP-8 (=GO-33) |
| **C** signature 의 구멍 | `.git/config` · `logs/refs/stash` · `.git/worktrees` 를 본다 | GP-11 a·b·c·d |
| **D** obsMark 의 구멍 | `Operation.Kind` 를 싣는다 | GP-11e |
| **E** 특수 상태 | `bisect` 감지·출구 · `am` 과 `rebase` 구분 · 빈 저장소 | GP-11g · GP-18 · GP-17 |
| **F** 상한 | status 응답의 파일 목록에 상한을 둔다 | GP-15 |
| **G** 문서 개정 | `GIT_PUSH_OBSERVE_SRS §1.2` 의 비용표를 실제 구현에 맞춘다 | GP-7(b) |

**미포함**: `fsnotify` 도입 — `11 D-3·D-4` 가 근거 넷으로 기각했고 본 SRS 는
그 기각을 유지한다. 갱신 계층은 [`./GIT_REFRESH_LIFECYCLE_SRS.md`](./GIT_REFRESH_LIFECYCLE_SRS.md) 다.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **1차 게이트** | 회차마다 도는 싼 판정. `query.ReadSignature` — read 1회 + stat 몇 번 |
| **2차 관측** | `Store.Status()` = 실제 `git status` 프로세스 |
| **변화 회차** | signature 가 직전과 다른 회차. 2차 관측을 반드시 한다 |
| **워크트리 회차** | signature 가 같아도 2차 관측을 하는 저빈도 회차. 작업 트리 변화를 잡는 유일한 길이다 |
| **obsMark** | 관측 하나를 비교 가능한 한 줄로 접은 값. 방송의 근거이자 식별자 |

### 1.4 참조 (References)

- [`./GIT_PUSH_OBSERVE_SRS.md`](./GIT_PUSH_OBSERVE_SRS.md) §1.2 — **본 SRS 가
  개정하는 대상.** 그 절의 비용 논거가 현재 구현에 대해 무효다
- [`./production/11-git-polling.md`](./production/11-git-polling.md) §4·§7 —
  감지되는 것과 되지 않는 것의 확정 목록, 그리고 fsnotify 기각의 근거 넷
- [`./CI_E2E_MATRIX_SRS.md`](./CI_E2E_MATRIX_SRS.md) FR-CEM-32 — *"Windows
  러너에서 `git branch` 뒤 `refs/heads` mtime 이 45초 동안 그대로였다."*
  `RefsShape` 가 그 실측 위에 서 있다. 묶음 C 가 mtime 을 더할 때 **그 실측을
  잊지 않는다** — 더하는 것이지 갈아타는 것이 아니다
- [`./PERFORMANCE_BUDGET.md`](./PERFORMANCE_BUDGET.md) — 묶음 A 의 before/after
  를 재는 자리(`scripts/perf-probe.sh`)

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 감시 회차가 곧 `git status` 다

```
StartGitWatch → 1초 티커 → Tick(ctx)
  → 감시 대상마다 w.git.Status(ctx, repo)   ← 여기가 git status 프로세스
  → obsMark 비교 → 바뀌었으면 Broadcast
```

`gitwatch.go:29-36` 이 그 전환의 이유를 적어 두었다 — *"signature 는 작업
트리를 못 본다. 작업 트리에 파일을 만드는 e2e 가 방송을 받지 못했다."*
**그 사실은 옳다.** 틀린 것은 그 결론에서 signature 를 **통째로 버린 것**이다.

### 2.2 회차가 순차다

`for _, repo := range repos { w.git.Status(...) }` 하나의 고루틴이다. 저장소
하나가 3초 걸리면 그 회차 전체가 3초 이상이고, `time.Ticker` 는 밀린 틱을
버리므로 **다른 저장소의 감지가 함께 늦어진다.** `ctx` 는
`context.Background()`(`:291`)라 개별 관측에 시한도 없다(`GO-33` 과 같은 줄).

대조로 `gitObservePins`(`handlers_git.go:123`)는 `gitObserveMax=4` 의 세마포어로
병렬화돼 있다 — 같은 문제를 아는 자리가 이미 있는데 감시 회차만 순차다.

### 2.3 signature 가 보지 않는 것

`query/signature.go` = `.git/HEAD` 내용 + `index` mtime·size + 현재 브랜치 ref
mtime(없으면 `packed-refs`) + `refs/` **디렉터리** mtime 합 + `refs/` **항목
이름** 해시.

| 놓치는 것 | 왜 |
|---|---|
| `stash drop`/`clear` | `refs/stash` **내용**만 바뀐다. `refsTree` 는 디렉터리 mtime 과 **이름**만 본다 |
| `git remote add/set-url`, `git config` | `.git/config` 가 signature 에 **한 톨도** 없다 |
| `worktree prune`/`remove` | `.git/worktrees/` 가 signature 밖 |
| operation 표식 제거 (`cherry-pick --quit`) | 표식 파일이 signature 밖이고 `obsMark` 에 `Operation` 이 없다 |

### 2.4 특수 상태 셋이 깨져 있다

- **bisect**: `DetectOperation`(`operation.go:44-50`)에 표식이 없다 — detached
  HEAD 로만 보이고 나갈 길이 화면에 없다
- **`git am`**: `rebase-apply` 디렉터리는 `git am` 도 만든다. 화면은 "리베이스
  중"이라 적고 출구 버튼이 `git rebase --continue/--abort` 를 낸다 — **맞지 않는
  명령이다**
- **빈 저장소**: `Status.Initial` 을 프론트가 읽지 않는다(`grep` 0건). "커밋이
  아직 없다"가 "불러오지 못했습니다"로 보인다

### 2.5 status 응답에 크기 상한이 없다

변경/미추적 파일이 수만 개인 저장소에서 `/api/git/status` 가 목록 전체를 JSON
으로 싣는다. History 는 300/100 페이징이 있는데 status 만 상한이 없다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 2단 게이트 (GP-7)

**FR-GDT-1** 감시 회차는 저장소마다 **먼저 signature 를 읽는다.**

**FR-GDT-2** 2차 관측(`git status`)을 하는 회차는 셋 중 하나다:
1. signature 가 직전 회차와 **다르다**
2. 이 저장소의 **워크트리 회차**다 (저빈도)
3. signature 를 **읽지 못했다** (판정할 수 없으면 관측한다 — 오류의 임자는
   2차가 가린다)

**FR-GDT-3** 워크트리 회차의 간격은 상수 하나다
(`GitWatchWorktreeEvery`). 값은 **4회차**(= 약 4초)다.

**FR-GDT-4** 워크트리 회차는 저장소마다 **어긋나게** 돈다. 전부 같은 회차에
몰리면 4초마다 16개의 `git status` 가 동시에 뜬다.

**FR-GDT-5** `.git` 안의 변화(커밋·체크아웃·브랜치·index)는 **지금과 같은 1초
반응을 유지한다** — signature 가 그것을 보기 때문이다.

**FR-GDT-6** 작업 트리 변화의 최악 지연은 워크트리 회차 간격이다. 그 값은
브라우저 안전망(30초)보다 훨씬 작으므로 사용자가 겪는 갱신은 여전히 서버 푸시다.

**FR-GDT-7** 2차 관측을 건너뛴 회차는 **방송하지 않는다.** 비교할 obsMark 를
만들지 않았으므로 "바뀌었다" 를 말할 근거가 없다.

### 3.2 묶음 B — 병렬·시한 (GP-8 / GO-33)

**FR-GDT-8** 회차는 세마포어로 병렬화한다. 상한은 `gitObservePins` 와 같은
값(4)이며 **이름이 하나다** — 두 자리에 다른 숫자를 두지 않는다.

**FR-GDT-9** 회차마다 `context.WithTimeout` 을 건다. 값은
`GitWatchRoundTimeout` = 20초. 회차가 끝나면 반드시 취소한다.

**FR-GDT-10** 종료 신호(`stopCh`)는 진행 중인 회차의 컨텍스트를 취소한다 —
`GO-33` 이 지적한 "종료 시 진행 중 `git status` 를 취소하지 못한다" 가 그것이다.

**FR-GDT-11** 방송의 **순서**는 보장하지 않는다. 저장소마다 독립이고 브라우저는
`repo` 로 가른다.

### 3.3 묶음 C — signature 의 구멍 (GP-11 a·b·c·d)

**FR-GDT-12** signature 는 `.git/config` 의 mtime·size 를 본다 (stat 1회).

**FR-GDT-13** signature 는 `logs/refs/stash` 의 mtime·size 를 본다 (stat 1회) —
`stash drop`/`clear` 가 그 파일을 건드린다.

**FR-GDT-14** signature 는 `.git/worktrees` 디렉터리의 mtime 과 **항목 이름**을
본다 (`RefsShape` 와 같은 방식) — mtime 을 믿을 수 없는 플랫폼에서도 이름은 참이다.

**FR-GDT-15** `refs/stash` **파일 자체**의 mtime·size 도 본다 — reflog 가 꺼진
저장소에서는 `logs/refs/stash` 가 없다.

**FR-GDT-16** 없는 파일은 **없다는 사실이 값이다.** 생겼다 사라지는 것도 변화다.

### 3.4 묶음 D — obsMark 의 구멍 (GP-11e)

**FR-GDT-17** `obsMark` 는 `Status.Operation.Kind` 와 진행 위치(`At`/`Total`)를
싣는다. `cherry-pick --quit` 뒤 진행 바가 사라진다.

### 3.5 묶음 E — 특수 상태 (GP-11g · GP-18 · GP-17)

**FR-GDT-18** `DetectOperation` 은 `BISECT_LOG` 를 보고 `bisect` 를 답한다.

**FR-GDT-19** `git am` 과 `rebase` 를 가른다. `rebase-apply/applying` 이 있으면
`am` 이고 없으면 `rebase` 다.

**FR-GDT-20** 각 상태의 **출구가 그 상태의 명령이어야 한다** — `am` 은
`git am --continue/--skip/--abort`, `bisect` 는 `git bisect reset`.

**FR-GDT-21** 빈 저장소(`Status.Initial`)에서 History 는 *"커밋이 아직
없습니다"* 를 보인다. *"불러오지 못했습니다"* 는 실패의 문구이며 빈 저장소는
실패가 아니다.

### 3.6 묶음 F — 상한 (GP-15)

**FR-GDT-22** status 응답의 각 그룹(staged·changes·untracked·conflicts)에
항목 수 상한을 둔다. 값은 `StatusGroupCap` = 2000.

**FR-GDT-23** 잘렸다는 **사실을 싣는다** — 그룹마다 `truncated` 와 원래 개수.
조용히 자르면 사용자는 파일이 없어진 것으로 읽는다.

**FR-GDT-24** 화면은 잘린 그룹에 그 사실을 보인다.

### 3.7 비기능 요구 (Non-functional)

**NFR-GDT-1** **아무 변화가 없는 저장소 하나를 열어 둔 채 1분** 동안 뜨는
`git status` 프로세스 수가 **60에서 15 이하**로 준다 (워크트리 회차분).

**NFR-GDT-2** 1차 게이트의 비용은 `.git` 안의 read 1회 + stat 6회 이하다.

**NFR-GDT-3** 묶음 C 가 더하는 stat 은 회차당 **4회 이하**다.

---

## 4. 설계 결정 (Design Decisions)

**D-GDT-1: signature 를 되세우되 status 를 버리지 않는다.**
`gitwatch.go:29-36` 이 실측으로 확인한 사실 — signature 는 작업 트리를 보지
못한다 — 은 여전히 참이다. 그러므로 signature 로 **갈아타는** 것이 아니라
**앞에 세운다.** 두 값 다 필요하고, 하나는 싸고 하나는 비싸다.

**D-GDT-2: 워크트리 회차를 저장소마다 어긋나게 돈다.**
전부 같은 회차에 몰리면 4초마다 16개의 `git status` 가 동시에 뜬다 — 그것은
1초마다 하나씩 뜨는 것보다 나쁜 모양이다(피크가 높다). 저장소 경로의 해시로
위상을 준다.

**D-GDT-3: fsnotify 를 쓰지 않는다 (기각을 유지한다).**
`11 D-4` 의 근거 넷이 그대로 유효하다. 특히 넷째 — *"의존성 제약을 깨서 얻는
것이 1초 `git status` 를 없애는 것 하나인데, 그 하나는 2단 signature 로
의존성 없이 얻는다"* — 가 본 SRS 그 자체다.

**D-GDT-4: `.git/config` 를 내용이 아니라 mtime·size 로 본다.**
내용을 읽으면 큰 config 에서 회차마다 파싱이 돈다. mtime·size 는 stat 1회이고,
같은 크기로 같은 자리를 고치는 편집은 이 감지가 놓친다 — 그 한계는
`signature.go:132-137` 이 ref in-place 이동에 대해 이미 적어 둔 것과 같은
성질이며, 같은 이유로 수용한다.

**D-GDT-5: 상한을 서버에서 자른다 (클라이언트에서 자르지 않는다).**
자르는 목적이 **전송·직렬화·해시 비용**이다. 클라이언트에서 자르면 그 셋이 그대로
남는다.

**D-GDT-6: `am` 판정을 `applying` 파일로 한다.**
`rebase-apply` 는 둘 다 만든다. `git rebase --apply` 갈래는 `rebase-apply/` 에
`applying` 을 만들지 않고 `git am` 은 만든다 — git 자신이 `wt-status.c` 에서
같은 판정을 한다.

**D-GDT-7: 시한은 회차의 것이지 저장소의 것이 아니다.**
저장소마다 시한을 걸면 느린 저장소 하나가 회차를 늘 20초까지 붙든다. 회차
하나에 걸면 그 안의 병렬 관측이 함께 끊긴다 — 다음 회차가 1초 뒤에 오므로
잃는 것이 없다.

---

## 5. 검증 (Verification)

| ID | 검증 | 자리 |
|---|---|---|
| **V-GDT-1** | 변화 없는 저장소에서 회차가 `Status` 를 부르지 않는다 | Go 단위 |
| **V-GDT-2** | signature 가 바뀐 회차는 `Status` 를 부른다 | Go 단위 |
| **V-GDT-3** | 워크트리 회차는 signature 가 같아도 `Status` 를 부른다 | Go 단위 |
| **V-GDT-4** | 저장소마다 워크트리 회차의 위상이 다르다 | Go 단위 |
| **V-GDT-5** | 느린 저장소가 다른 저장소의 감지를 막지 않는다 (병렬) | Go 단위 |
| **V-GDT-6** | 회차에 시한이 있고 종료가 그것을 취소한다 | Go 단위 |
| **V-GDT-7** | 터미널에서 `git remote add` 후 원격 목록이 갱신된다 | e2e |
| **V-GDT-8** | `git stash drop` 후 Stash 목록이 갱신된다 | e2e |
| **V-GDT-9** | `cherry-pick --quit` 후 진행 바가 사라진다 | e2e |
| **V-GDT-10** | `git bisect start` 가 화면에 뜨고 출구가 `bisect reset` 이다 | e2e |
| **V-GDT-11** | `git am` 진행 중이 `am` 으로 표시되고 출구가 `git am` 이다 | Go 단위 + e2e |
| **V-GDT-12** | 빈 저장소에서 History 가 "커밋이 아직 없습니다" 를 보인다 | e2e |
| **V-GDT-13** | 상한을 넘는 그룹이 잘리고 그 사실이 응답에 실린다 | Go 단위 |
| **V-GDT-14** | 작업 트리에 파일을 만들면 여전히 방송이 온다 | e2e (회귀) |
| **NFR-GDT-1** | 1분간 `git status` 프로세스 수 60 → 15 이하 | `scripts/perf-probe.sh` |

---

## 6. 비목표 (Non-goals)

- **fsnotify** (D-GDT-3)
- **signature 로 작업 트리를 보려는 시도** — `.gitignore` 를 다시 구현하는
  일이며 그것이 `11 D-3` 이 fsnotify 를 기각한 이유의 하나다
- **원격의 새 커밋 감지** — fetch 없이는 정의상 불가능하다 (`GP-11h`)
- **감시 상한 16 을 늘리는 것** — 퇴출 로그는 이미 M6 이전에 섰다
