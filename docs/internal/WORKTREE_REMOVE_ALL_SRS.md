# SRS: Worktrees 탭 — 모든 worktree 의 제거 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 말은 두 줄이다.

> 1. worktree 목록에 추가만 있고 제거는 없어
> 2. (어느 것을 지울 수 있어야 하는가에 대해) 워크트리라면 전부

1 은 결함 보고처럼 보이나 설계였다 — [`GIT_REVIEW4_SRS`](./GIT_REVIEW4_SRS.md)
FR-GIT-241 이 Run 것과 바깥 것의 제거 진입점을 만들지 않게 했고, 사용자 영역
(`$DONGMINAL_HOME/git-worktrees`) 에서 만든 것이 하나도 없으면 목록 어디에도
제거가 없다. 2 가 그 선을 거둔다.

인터뷰로 확정한 것:

| 질문 | 답 |
|---|---|
| Run 격리 worktree 도 지울 수 있는가 | **무조건 허용** — Run 의 상태를 보지 않는다 |
| 더러운(dirty) worktree 는 | **강제 제거 허용** — 한 번 더 확인한 뒤 `--force` 로 지운다 |

### 1.2 범위 (Scope)

**포함:** Worktrees 탭의 행 제거 진입점, `/api/git/worktrees/remove`, 그것이 지나는
`domain/worktree` 의 제거 경로.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **등록된 worktree** | 대상 저장소의 `git worktree list --porcelain` 에 나오는 항목 |
| **main worktree** | 그 목록의 첫 항목 (`Entry.Main`) — 저장소 자신 |
| **소유** | `user` / `run` / `outside` — 경로로 판정 (FR-GIT-240, 변경 없음) |

### 1.4 참조 (References)

- [`./GIT_REVIEW4_SRS.md`](./GIT_REVIEW4_SRS.md) — FR-GIT-240~246
- `internal/webserver/domain/worktree/remove.go` — FR-WKT-8 정리 규칙

## 2. 전반 기술 (Overall Description)

### 2.1 근거

제거 가능 여부의 판정은 지금 두 곳에 있다: UI 의 `_actsOf`(`owner==='user'`) 와
서버의 `checkPath`(사용자 영역 아래만). 둘 다 **경로의 위치**로 권한을 정한다.

"워크트리라면 전부" 의 권한 근거는 위치가 아니라 **등록**이다 — 그 저장소의
`git worktree list` 에 main 이 아닌 항목으로 있으면 지울 수 있다. 이 근거는 git 이
보증하므로 임의 경로 삭제의 표면을 열지 않는다: `git worktree remove` 는 등록되지
않은 경로를 거부하고, 우리는 그 전에 목록에서 한 번 더 확인한다.

### 2.2 제약

- worktree 의 git 실행은 `domain/worktree` 안에서만 한다 (FR-GIT-246, 변경 없음).
- 인가는 `domain/worktree` 가 진다 — 핸들러가 따로 판정하지 않는다 (FR-GIT-243 의
  "판정을 두 벌로 두지 않는다").
- Run 격리 Manager 의 `Remove`·`checkPath` 와 사용자 영역의 생성(`AddSpec`)·
  `Rollback` 은 바꾸지 않는다 — 그쪽의 영역 제한은 여전히 옳다.

## 3. 요구사항 (Specific Requirements)

### 3.1 개정 (Amended)

- **FR-GIT-241 (개정)** main worktree 를 **제외한 모든** worktree 에 제거 진입점이
  있다. 소유(`user`·`run`·`outside`)는 표식으로만 쓰이며 제거 여부를 정하지 않는다.
  - 이전: Run 것과 바깥 것은 제거할 수 없다 — 진입점을 만들지 않는다.
  - 이유: 사용자 지시(§1.1).
- **FR-GIT-243 (개정)** 제거 대상은 **등록된 worktree 중 main 이 아닌 것**이다.
  더러운 worktree 는 첫 요청에서 거부하고(`residue:"dirty"`), 사용자가 다시 확인하면
  강제로 지운다 (FR-WRA-5). 트리만 지운다는 규칙(브랜치 삭제를 싣지 않는다)은 그대로다.

### 3.2 도메인 (`internal/webserver/domain/worktree`)

- **FR-WRA-1** `Manager.RemoveListed(ctx, RemoveSpec) Result` 를 둔다. 경로 인가가
  `checkPath`(영역 아래) 대신 **등록 확인**이며, 나머지 흐름(repoLock·사라진 경로의
  prune·dirty 판정·재시도·브랜치 정리·잔여물 보고)은 `Remove` 와 같다.
  `Service` 인터페이스에 더한다.
- **FR-WRA-2** `RemoveListed` 는 아래 중 하나면 지우지 않고
  `residue:"unsafe-path"` 로 답한다. git 을 실행하지 않는다(목록 조회 제외).
  - 빈 경로 · 절대 경로가 아님 · 조각 `..` 포함 · 파일시스템 루트
  - 경로가 `Repo` 와 같다
  - repoLock 을 쥔 뒤의 `List(Repo)` 에 그 경로가 없다
  - 그 항목이 `Main` 이다
  - 목록 조회가 실패하면 `residue:"remove-failed"` 다 (확인할 수 없으면 지우지 않는다).
- **FR-WRA-3** `RemoveSpec.Force bool` 을 둔다. `RemoveListed` 에서 `Force` 면
  dirty 판정을 건너뛰고 `git worktree remove --force <path>` 를 실행한다. `Force` 가
  아니면 종전과 같다(dirty → `residue:"dirty"`, `removed:false`).
  - `Remove`(Run 격리·FR-WKT-8)는 `Force` 를 무시한다 — 사용자 작업의 조용한 삭제
    금지는 자동 정리의 규칙이고, 거기에는 다시 확인할 사람이 없다.
- **FR-WRA-4** 잠긴 worktree(`git worktree lock`)는 `--force` 한 번으로 지워지지
  않는다. 그 실패는 `residue:"remove-failed"` 와 git 의 stderr 로 그대로 보고한다.

### 3.3 서버 (`/api/git/worktrees/remove`)

- **FR-WRA-5** 본문에 `force bool` 을 받는다(없으면 false). 핸들러는
  `UserWorktrees.RemoveListed` 를 부른다. 응답 모양(`removed`·`residue`·`detail`)과
  배타 규칙(REPO_FIX 01 §5.6)은 바꾸지 않는다.
- **FR-WRA-6** 목록 응답의 `owner` 판정(`gitWorktreeOwner`)은 바꾸지 않는다 — 표식이다.

### 3.4 UI (`web/js/git/worktrees.js`)

- **FR-WRA-7** `_actsOf` 는 `!e.main` 이면 `remove` 를 붙인다. 소유를 보지 않는다.
- **FR-WRA-8** 제거 응답이 `residue:"dirty"` 이면 같은 자리에서 **두 번째 파괴적
  확인**을 연다 — 제목 "변경이 있는 worktree 를 강제로 지웁니다", 힌트 명령
  `git worktree remove --force <path>`. 확인하면 `force:true` 로 다시 요청하고,
  취소하면 종전과 같이 dirty 사유를 안내 줄에 남긴다.
  - 근거: 첫 확인은 "지운다"에 대한 동의이고, 저장하지 않은 변경을 잃는 것은 그와
    다른 동의다 — FR-GIT-243 이 "한 동작에 창을 둘 띄우지 않는다" 고 한 것은
    **옵션 폼**에 대한 것이며, 이것은 첫 요청의 결과에 따른 별개의 확인이다.
- **FR-WRA-9** 첫 확인의 안내 문구는 "저장하지 않은 변경이 있으면 한 번 더
  묻습니다" 로 바꾼다 — 종전 "거부됩니다" 는 더 이상 사실이 아니다.

## 4. 검증 (Verification)

| ID | 대상 | 방법 |
|---|---|---|
| W1 | FR-WRA-1·2 | 단위: 사용자 영역 **밖**의 등록 worktree 를 `RemoveListed` 로 지운다 → `removed:true`, 디스크·목록에서 사라짐 |
| W2 | FR-WRA-2 | 단위: main 경로 / 미등록 경로 / 상대 경로 / `..` / `/` → `unsafe-path`, 디스크 그대로 |
| W3 | FR-WRA-3 | 단위: dirty + `Force:false` → `dirty`·남음 / dirty + `Force:true` → 지워짐 |
| W4 | FR-WRA-3 | 단위: `Remove`(영역 Manager)에 `Force:true` 를 줘도 dirty 는 남는다 |
| W5 | FR-WRA-4 | 단위: 잠긴 worktree + `Force:true` → `remove-failed`, 남음 |
| W6 | FR-WRA-5 | 핸들러: 바깥 worktree 제거 200·`removed:true` (종전 `RejectsOutsideUserArea` 대체) / dirty+`force:true` → 지워짐 |
| W7 | FR-WRA-7 | e2e: Run 것·바깥 것 행에 Remove 가 있고 main 행엔 없다 (V146 대체) |
| W8 | FR-WRA-8 | e2e: dirty 제거 → 두 번째 확인 → 확인 시 사라짐 / 취소 시 남고 사유 표시 (V149 개정) |

## 5. 비기능 (Non-functional)

- 동작 변경 기록(DoD):
  - 이전: user 소유·비main 만 제거 가능, dirty 는 항상 거부
  - 새: 비main 전부 제거 가능, dirty 는 재확인 후 강제 제거
  - 이유: 사용자 지시(§1.1)

## 6. 비목표 (Non-goals)

- 잠긴 worktree 의 해제·이중 force(`-f -f`).
- 브랜치 삭제 옵션 (FR-GIT-243 그대로).
- Run 기록(`run.Record` 의 worktree 마크) 갱신 — Run close 가 나중에 그 경로를 지나면
  `Remove` 가 "이미 없다 → prune → 성공" 으로 처리한다 (remove.go 의 기존 경로).
- 여러 행 일괄 제거.

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-10-01 | 초판. 사용자 인터뷰(Run 무조건 허용 · dirty 강제 제거 허용)로 FR-GIT-241·243 개정 |
