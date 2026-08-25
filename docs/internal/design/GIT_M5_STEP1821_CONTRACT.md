# 설계 계약 — M5 18~21단계 참조 (묶음 N·O·P, FR-GIT-147~178)

GIT_SRS.md §3D 다. 검증은 V53~V59·V67·V68·V69·V60.
전제: M1~M4 가 끝나 있다.

## 0. 열린 결정 확정 (M5 해당분)

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| O13 | 브랜치 즐겨찾기 저장 위치 | `workspace.json` 최상위 `git.favorites{<repo>:[names]}` | O1·O6 과 같은 곳. 리포별 키가 필요하다는 요구를 그대로 만족한다 |
| O14 | dirty checkout 기본 선택 | **취소** | FR-GIT-97 — 기본은 항상 안전한 쪽이다. stash 도 사용자의 작업 상태를 옮기는 행위이므로 기본이 아니다 |

## 1. 18단계 — Branches 탭 (묶음 N, FR-GIT-147~160)

14단계의 `Service.Refs` 를 그대로 쓴다. 새 조회를 만들지 않는다.

### 1.1 쓰기 연산

```go
// internal/git/branch.go

type CheckoutOpts struct {
    Ref    string
    Create string // 비어 있지 않으면 이 이름으로 새 브랜치를 만들며 checkout
    Track  string // upstream 으로 설정할 원격 ref
    Detach bool
    Force  bool   // **기본 false.** 파괴적이다
}
func (s *Service) Checkout(ctx context.Context, repo string, o CheckoutOpts) (Output, error)

type BranchCreateOpts struct {
    Name     string
    StartRef string // 비면 HEAD
    Checkout bool
}
func (s *Service) BranchCreate(ctx context.Context, repo string, o BranchCreateOpts) (Output, error)

// ValidBranchName 은 git 의 이름 규칙을 확인한다 (FR-GIT-159).
// `git check-ref-format --branch <name>` 을 쓴다 — 규칙을 직접 구현하지 않는다.
//
// 실측 (git 2.50.1): 유효하면 exit 0 + 이름을 그대로 출력, 무효하면 exit 128 +
// stderr `fatal: 'x' is not a valid branch name`. 이름이 `-` 로 시작할 수 있으니
// **`--` 뒤에 두거나 guardArgs 가 거부하지 않는지 먼저 확인해라** — 현재
// guardArgs 는 `-` 로 시작하는 args[0] 만 막으므로 뒤따르는 인자는 통과하지만,
// git 이 그것을 옵션으로 읽는다. `--branch` 다음 인자로 오므로 실제로는 안전하다.
func (s *Service) ValidBranchName(ctx context.Context, repo, name string) error
```

- `check-ref-format` 을 `readCommands` 에 더한다 (순수 검사이며 쓰기가 아니다).
- `Checkout{Force:true}` 는 `ExecWrite{Destructive:true}` 다 — 워킹 트리 변경을
  버린다.
- **원격 브랜치 checkout (FR-GIT-156)**: `origin/feat` 에 대해
  `Create:"feat", Track:"origin/feat"` 로 간다 (`checkout -b feat --track origin/feat`).
  같은 이름의 로컬이 이미 있으면 서버가 409 `branch_exists` 를 주고, 클라이언트가
  선택지를 보인다: 기존 브랜치로 checkout / 다른 이름으로 생성 / 취소.

### 1.2 라우트

| 메서드 | 경로 | 본문 |
|---|---|---|
| POST | `/api/git/checkout` | `{"repo":"…","ref":"…","create":"","track":"","detach":false,"force":false,"confirm":false}` |
| POST | `/api/git/branch` | `{"repo":"…","name":"…","startRef":"","checkout":true}` |
| GET | `/api/git/branch/validate?repo=&name=` | `{"ok":true}` 또는 `{"ok":false,"reason":"…"}` |

`force:true` 는 `confirm:true` 없이 400.

### 1.3 UI

```
.git-view.git-branches
├ .git-br-bar    이름 검색 (부분 일치, FR-GIT-151)  [+ 새 브랜치]
└ .git-br-tree
    ▾ ★ 즐겨찾기            ← FR-GIT-149
    ▾ 로컬                  ← FR-GIT-148
        ▾ feature/          ← 접두사 그룹핑 (FR-GIT-150)
            feature/a
        main ✓  ↑2 ↓0  (origin/main)   ← FR-GIT-152·153
    ▾ 원격
        ▾ origin
    ▾ 태그
```

- **즐겨찾기 (FR-GIT-149, O13)**: 행의 `★` 토글. `ws.git.favorites[repo]` 에 영속.
- **접두사 그룹핑 (FR-GIT-150)**: 이름에 `/` 가 있으면 첫 조각으로 그룹. 접힘
  상태는 `localStorage`.
- **검색 (FR-GIT-151)**: 부분 일치. 일치 항목의 상위 그룹을 자동으로 펼친다.
- **현재 브랜치 (FR-GIT-152)**: `✓` + `.current`.
- **upstream·ahead/behind (FR-GIT-153)**: `↑n ↓m (upstream)`. 0 은 숨긴다.
- 우클릭 (FR-GIT-154·155·160): 17단계의 `GitMenu` 에 `branch`·`tag` kind 를
  선언한다. 항목: Checkout / Copy Name / (원격이면) Checkout as local.
  **새 메뉴 코드를 쓰지 않는다.**
- **dirty checkout (FR-GIT-157, 검증 V55, O14)**: 워킹 트리가 dirty 면
  `취소` / `stash 후 진행` / `강제(변경 버림)` 3선택. **기본 포커스는 취소**이고
  강제는 파괴적이므로 `GitConfirm` 2단계를 거친다.
- **브랜치 생성 다이얼로그 (FR-GIT-158, 검증 V68)**: 이름 / 시작점(현재 HEAD 또는
  지정 커밋) / 생성 후 checkout 여부 3필드. 이름은 입력 중
  `/api/git/branch/validate` 로 검사하고 위반이면 실행을 막는다 (FR-GIT-159).
- 조작 후 목록·상태 갱신 (FR-GIT-160).

## 2. 19단계 — Stash 탭 (묶음 O, FR-GIT-161~170)

```go
// internal/git/stash.go

type Stash struct {
    Index    int    `json:"index"`    // stash@{n} 의 n
    Oid      string `json:"oid"`
    Message  string `json:"message"`
    Base     string `json:"base"`     // 기준 브랜치
    AtUnixMs int64  `json:"atUnixMs"`
}
func (s *Service) StashList(ctx context.Context, repo string) ([]Stash, error)

type StashPushOpts struct {
    Message         string
    IncludeUntracked bool
    KeepIndex        bool
}
func (s *Service) StashPush(ctx context.Context, repo string, o StashPushOpts) (Output, error)
func (s *Service) StashApply(ctx context.Context, repo string, index int, withIndex bool) (Output, error)
func (s *Service) StashPop(ctx context.Context, repo string, index int, withIndex bool) (Output, error)
// StashDrop 은 파괴적이다 (FR-GIT-89·168).
func (s *Service) StashDrop(ctx context.Context, repo string, index int) (Output, error)
func (s *Service) StashPreview(ctx context.Context, repo string, index int) ([]CommitFile, error)
```

- 목록: `stash list --format=%gd%x00%H%x00%gs%x00%ct%x00` (NUL 구분).
  `%gs` 는 `WIP on main: abc123 subject` 형태 — `on <base>:` 를 뽑는다.
- **FR-GIT-165 (검증 V57)**: `pop` 이 충돌로 끝나면 **git 이 stash 를 남긴다.**
  그것을 확인해 응답에 `stashKept: true` 와 사유를 담고, 클라이언트가
  "충돌로 stash 를 남겨 두었습니다" 를 명시한다. **조용히 넘기면 사용자가 작업을
  잃었다고 오해한다.**
  판정: pop 실행 후 `StashList` 를 다시 찍어 그 인덱스가 남아 있는지 본다.
- **FR-GIT-168**: `drop` 은 실행 **전에** 그 stash 의 sha·메시지·시각을
  `HintLog` 에 남기고(9단계), `GitConfirm` 2단계를 거친다.
  hint 의 command 는 `git stash store -m "<msg>" <sha>`.
- **FR-GIT-167**: 변경이 없으면(status 의 `Total==0`) 생성 버튼을 disable 하고
  사유를 보인다.
- **FR-GIT-169**: 선택한 stash 의 미리보기 — 변경 파일 목록
  (`stash show --name-status -z stash@{n}`). 파일 클릭 → Diff 탭
  (축은 `commit-parent`, `oid=stash@{n}`, `parentOid=stash@{n}^`).
- 라우트: `GET /api/git/stash`, `POST /api/git/stash/{push,apply,pop,drop}`.
  `drop` 은 `confirm:true` 필수.

## 3. 20단계 — 다이얼로그 공통 규약 (묶음 P, FR-GIT-171~178)

M1~M5 를 지나며 다이얼로그가 여럿 생겼다. **이 단계는 새 다이얼로그를 만드는
단계가 아니라, 이미 만든 것들을 하나의 골격 아래로 모으는 단계다.**

```js
// web/js/git-dialog.js

/**
 * Git 다이얼로그의 공통 골격 (FR-GIT-171).
 *
 * 제목 · 본문 · 옵션 · 실행/취소 · 실행 중 표시 · 결과 표시. 파괴적 동작은
 * 9단계의 2단계 확인을 그대로 거친다 (FR-GIT-172) — 여기서 다시 구현하지 않는다.
 *
 * 옵션의 기본값은 항상 안전한 쪽이다 (FR-GIT-173): force 아님, 삭제 아님,
 * 기본 포커스는 취소. Enter 는 기본 동작을 실행하지만 **파괴적 다이얼로그에서
 * Enter 의 기본 동작은 취소다** (FR-GIT-176).
 */
class GitDialog {
  static async open({title, body, fields, destructive, run})
}
```

흡수 대상:
- 9단계 `GitConfirm` — 파괴적 확인. `GitDialog` 가 `destructive:true` 로 위임한다.
- M3 fetch/pull/push 다이얼로그 (FR-GIT-109·110)
- M5 브랜치 생성 (FR-GIT-158), stash 생성 (FR-GIT-166), dirty checkout (FR-GIT-157)

규약 (검증 V59):

| FR | 규약 |
|---|---|
| 171 | 골격 공유 — 제목·본문·옵션·실행/취소·진행·결과 |
| 172 | 파괴적이면 2단계 확인 |
| 173 | 옵션 기본값은 안전한 쪽 |
| 174 | 실행 중 중복 실행 차단 + 진행 표시 |
| 175 | 실패 시 사유 + stderr tail + 복사 |
| 176 | `Esc` 취소. `Enter` 는 기본 동작 — **파괴적이면 기본 동작이 취소** |
| 177 | 모바일 폭에서 옵션·확인 버튼이 잘리지 않고, 확인 버튼이 목록과 분리 |
| 178 | 열린 동안에도 폴링 계속. 대상 상태 변화를 알림 |

FR-GIT-178 의 구현: 다이얼로그가 열릴 때 대상의 상태 지문(예: 대상 파일들의
`xy` 조합, 대상 ref 의 sha)을 뜨고, `GitPanel` 이 새 상태를 관측할 때마다 비교해
달라졌으면 다이얼로그 상단에 `.git-dialog-changed` 를 보인다.
**실행을 막지는 않는다** — 사용자가 알고 결정할 수 있게 한다.

## 4. 21단계 — MVP 전체 수동 검증 (V60)

`docs/internal/test-checklist.md` 에 Git 창 절을 추가한다. 항목은
`GIT_SURFACE_MAP.md` 의 P0 38개 전부 + SRS §4 의 성능·보안 기준이다.

대상 저장소 둘:
1. dongminal 자기 저장소 (실사용)
2. 테스트 저장소 — 초기 커밋 전 / detached / 머지 진행 중 / 충돌 / 대량 파일 /
   대량 커밋 / bare remote / LFS 포인터 / 바이너리 / 유니코드·공백 경로

## 5. 하지 않는 것

- 브랜치 삭제 · 태그 생성/삭제 — P1. 메뉴 자리만 프레임워크가 열어 둔다
  (파괴적 정책은 이미 서 있다).
- 인터랙티브 rebase · 3-way merge editor — P2.
- submodule · worktree UI — P2.
- clone / init — P2.
