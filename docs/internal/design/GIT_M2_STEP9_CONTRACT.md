# 설계 계약 — M2 9단계 안전 정책 (묶음 J, FR-GIT-86~97)

GIT_SRS.md §3A.3 이다. 검증은 V36·V37·V38·V39.

**이 단계는 10·11단계보다 반드시 먼저 완성된다.** 파괴적 경로가 열리는 시점과
방어가 서는 시점이 같아야 한다 (SRS §1.2.1·§6).

이 단계 자체는 **저장소를 바꾸지 않는다.** 쓰기 경로의 골격·preflight·확인 절차·
recovery hint 기록만 세운다. 실제 쓰기 명령은 10·11단계가 이 골격 위에 얹는다.

## 0. 열린 결정 확정 (M2 해당분)

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| O6 | 커밋 draft 저장 위치 | `workspace.json` 최상위 `git.drafts{<repo>:<msg>}` | O1 과 같은 곳. dongminal 은 여러 기기에서 같은 워크스페이스를 보므로 draft 도 따라가야 한다 |
| O7 | undo 토스트 지속 시간 | **5초 고정** | 설정 항목을 늘릴 값어치가 없다 (최소 구현) |
| O8 | discard recovery hint | **안내만.** stash 를 자동 생성하지 않는다 | 자동 생성은 사용자의 stash 목록을 오염시키고, 그 오염을 되돌릴 방법이 없다 |

## 1. `internal/git` — 쓰기 경로의 단일 지점 (FR-GIT-95)

1단계는 읽기 허용 목록(`readCommands`)만 두었다. 여기서 **두 번째 목록**을 만든다.

```go
// internal/git/write.go

// writeCommands 는 저장소를 변경할 수 있는 하위 명령이다. 읽기 목록과 분리해
// 두는 이유는 진입 함수가 다르기 때문이다 — Exec 은 이 목록을 실행하지 못한다.
var writeCommands = map[string]bool{
    "add": true, "reset": true, "rm": true, "commit": true,
    "checkout": true, "restore": true, "clean": true,
    "stash": true, "branch": true, "tag": true,
    "fetch": true, "pull": true, "push": true,
    "merge": true, "rebase": true, "cherry-pick": true, "revert": true,
    "update-ref": true, "symbolic-ref": true,
}

// destructive 는 되돌리기 어려운 동작이다 (FR-GIT-89). 판정은 하위 명령만으로는
// 안 된다 — `git reset --soft` 는 안전하고 `--hard` 는 아니다. 그래서 호출자가
// 선언하고, 그 선언이 기록에 남는다.
type WriteSpec struct {
    Argv        []string
    Destructive bool
    // Stdin 은 인자로 넘길 수 없는 값(커밋 메시지)을 위한 것이다 (FR-GIT-77).
    Stdin string
}

// ExecWrite 는 저장소를 변경하는 유일한 경로다 (FR-GIT-95).
// **Exec 은 쓰기 명령을 실행하지 못하고, ExecWrite 는 읽기만 하는 호출을 위해
// 쓰이지 않는다.** 두 목록이 겹치지 않는 것을 테스트로 고정한다.
func (s *Service) ExecWrite(ctx context.Context, dir string, spec WriteSpec) (Output, error)
```

- `guardWriteArgs` 는 `guardArgs` 와 같은 안전 검사(전역 옵션 거부·NUL 거부·
  `--upload-pack` 류 거부)를 하고, 허용 목록만 `writeCommands` 로 바꾼다.
  공통 검사는 한 함수로 뽑아 두 곳이 같은 규칙을 쓰게 한다.
- `Record.Destructive` 에 `spec.Destructive` 를 넣는다 (FR-GIT-95).
- `Stdin` 은 `cmd.Stdin = strings.NewReader(spec.Stdin)` 로 전달한다.
  **`Stdin` 의 내용은 기록에 남기지 않는다** — 커밋 메시지가 실행 로그에 중복되고,
  더 나쁘게는 사람이 붙여넣은 것이 무엇이든 로그로 흐른다.
  기록에는 `StdinBytes int` 만 남긴다.
- `writeCommands` 와 `readCommands` 의 교집합이 비어 있어야 한다. 겹치면
  "어느 경로로도 실행 가능한 명령"이 생겨 FR-GIT-95 가 무너진다.
  (`symbolic-ref` 는 읽기 목록에도 있다 — **읽기 목록에서 뺀다.** 읽기에는
  `rev-parse --abbrev-ref` 로 충분하다.)
- **stderr tail (FR-GIT-96)**: `Output` 에 `StderrTail(n int) string` 을 더한다.
  기본 `DefaultStderrTailLines = 200`.

정적 검증 V39: `internal/git` 밖에서 `ExecWrite` 를 부르는 곳은
`internal/server/handlers_git*.go` 뿐임을 테스트로 고정한다.

## 2. preflight (FR-GIT-86~88, 검증 V36)

```go
// internal/git/preflight.go

// Block 은 실행을 막은 이유 하나다. **무엇이 왜 막혔고 어떻게 푸는지**를 함께
// 준다 (FR-GIT-88) — 단순 실패 메시지로 끝내면 사용자가 갈 곳이 없다.
type Block struct {
    Code   string `json:"code"`   // identity_missing | merge_in_progress | …
    Reason string `json:"reason"` // 무엇이 왜
    Fix    string `json:"fix"`    // 어떻게 푸는지
}

// Warning 은 막지는 않되 알려야 하는 것이다 (FR-GIT-87 의 detached).
type Warning struct {
    Code   string `json:"code"`
    Reason string `json:"reason"`
}

type Preflight struct {
    Blocks   []Block   `json:"blocks"`
    Warnings []Warning `json:"warnings"`
    GPGSign  bool      `json:"gpgSign"`  // FR-GIT-85
    Template string    `json:"template"` // FR-GIT-76. commit.template 의 내용
}

func (s *Service) Preflight(ctx context.Context, repo string) (Preflight, error)
```

검사 항목:

| code | 판정 | Fix |
|---|---|---|
| `identity_missing` | `git config --get user.name` / `user.email` 둘 중 하나라도 비었다 | `git config --global user.name "…"` 를 안내 |
| `merge_in_progress` | `<gitdir>/MERGE_HEAD` 존재 | `git merge --abort` 또는 충돌 해결 후 커밋 |
| `rebase_in_progress` | `<gitdir>/rebase-merge` 또는 `rebase-apply` 존재 | `git rebase --abort` / `--continue` |
| `cherry_pick_in_progress` | `<gitdir>/CHERRY_PICK_HEAD` 존재 | `git cherry-pick --abort` |
| `revert_in_progress` | `<gitdir>/REVERT_HEAD` 존재 | `git revert --abort` |

| code (warning) | 판정 |
|---|---|
| `detached_head` | HEAD 가 심볼릭이 아니다. "이 커밋은 어느 브랜치에도 속하지 않는다" 를 명시 (FR-GIT-87) |

- `config --get` 은 **읽기다.** `readCommands` 에 `config` 를 더한다. 단
  `guardArgs` 가 `config` 뒤에 `--get`·`--get-all`·`--list`·`--type` 외의 인자를
  거부해야 한다 — `git config user.name x` 는 쓰기이므로 읽기 경로로 흘러선 안 된다.
  이 검사를 테스트로 고정한다.
- **실측 (git 2.50.1): 설정되지 않은 키는 exit 1 이고 stderr 가 비어 있다.**
  `Exec` 은 exit≠0 을 `*ExecError` 로 올리므로, preflight 는 **exit 1 을 "미설정"
  으로 다뤄야 한다.** 오류로 올려보내면 user.name 이 없는 저장소에서 preflight
  자체가 500 이 되어 차단 사유를 보여줄 수 없다. exit 1 이 아닌 실패는 오류다.
- `commit.gpgsign` 과 `commit.template` 도 `config --get` 으로 읽는다.
  template 은 경로이므로 그 파일을 읽어 내용을 담는다. 없으면 빈 문자열.
  파일 읽기는 크기 상한(`DiffMaxBytes` 재사용)을 건다.
- 진행 중 상태 판정은 파일 존재 확인이다 — git 을 실행하지 않는다.

`GET /api/git/preflight?repo=<abs>` → `{"requested":"…","repo":"…","preflight":{…}}`

## 3. recovery hint (FR-GIT-92·93, 검증 V37)

```go
// internal/git/recovery.go

// Hint 는 파괴적 동작 직전에 기록한 복구 수단이다. **값을 기록하는 것이 본질이다**
// — 안내문만으로는 지워진 ref 를 되살릴 수 없다 (FR-GIT-92).
type Hint struct {
    Seq      uint64   `json:"seq"`
    AtUnixMs int64    `json:"atUnixMs"`
    Repo     string   `json:"repo"`
    Action   string   `json:"action"`   // discard | branch_delete | stash_drop | …
    Targets  []string `json:"targets"`  // 대상 목록 (경로·ref 이름)
    Values   []string `json:"values"`   // 되살리는 데 필요한 값 (ref 의 sha 등)
    Command  string   `json:"command"`  // 사용자가 터미널에 붙여넣을 명령
    Note     string   `json:"note"`
}

// HintLog 는 세션 동안의 hint 를 들고 있다 (FR-GIT-93). 링 버퍼다.
type HintLog struct { /* 비공개 */ }
func NewHintLog(cap int) *HintLog
func (l *HintLog) Add(h Hint) Hint      // Seq 를 채워 돌려준다
func (l *HintLog) Recent(n int) []Hint
```

`const DefaultHintCap = 200`

`GET /api/git/recovery` → `{"hints":[…]}` (FR-GIT-93 의 "세션 동안 조회 가능").

동작별 hint 내용:

| Action | Values | Command |
|---|---|---|
| `discard` | (없음) | `git stash push -- <경로들>` — **폐기 전에 이것을 실행하라는 안내다** (O8: 자동 실행하지 않는다) |
| `branch_delete` | 지워질 브랜치의 sha | `git branch <name> <sha>` |
| `stash_drop` | `stash@{n}` 의 sha | `git stash store -m "<msg>" <sha>` |
| `tag_delete` | 태그가 가리키던 sha | `git tag <name> <sha>` |
| `reset_hard` | 현재 HEAD sha | `git reset --hard <sha>` |
| `force_push` | 원격 ref 의 sha (알 수 있으면) | `git push <remote> <sha>:<ref>` |

값을 못 얻으면 `Values` 를 비우고 `Note` 에 **왜 못 얻었는지**를 남긴다.
조용히 빈 hint 를 만들지 않는다.

## 4. 파괴적 동작 목록 (FR-GIT-89)

```go
// internal/git/destructive.go

// DestructiveActions 는 확인과 recovery hint 를 반드시 거치는 동작이다
// (FR-GIT-89). 이 목록은 서버·클라이언트가 같은 것을 봐야 하므로 API 로 노출한다.
var DestructiveActions = []string{
    "discard", "branch_delete", "stash_drop", "tag_delete",
    "reset_hard", "force_push", "remote_ref_delete",
}
```

`GET /api/git/policy` → `{"destructive":[…]}`.
클라이언트는 이 목록으로 확인 절차를 켠다 — 목록을 프론트에 복제하지 않는다.
새 파괴적 동작이 서버에 생기면 클라이언트가 자동으로 그것을 막는다.

## 5. 클라이언트 — 파괴적 확인 (FR-GIT-90·91·94·97, 검증 V37·V38)

> **개정 (CONFIRM_ONE_STAGE_SRS FR-COS-1·8).** 이 절은 원래 두 걸음을 규정했다.
> 지금은 **한 걸음**이며, 영향 범위와 recovery hint 를 한 화면에 함께 보인다.
> 아래 규약 중 걸음 수에 매인 것만 개정되었고 나머지 — 기본 선택지·키 규약·모바일
> 배치·실패 표시 — 는 그대로 유효하다.

```js
// web/js/git/confirm.js

/**
 * 파괴적 동작의 확인 (FR-GIT-90).
 *
 * 한 화면이 **영향 범위**와 **recovery hint** 를 함께 보인다. 영향 범위는 무엇이
 * 몇 개 사라지는지의 목록이며, 개수만 보이면 사용자가 무엇을 잃는지 모른다
 * (FR-GIT-91).
 *
 * 기본 선택지는 항상 안전한 쪽이다 (FR-GIT-97) — 기본 포커스는 취소이고,
 * Enter 의 기본 동작도 취소다 (FR-GIT-176).
 */
class GitConfirm {
  // open 은 확인을 띄우고 사용자가 끝까지 진행했을 때만 true 로 resolve 한다.
  static async open({action, title, targets, hint, mobile, run, stages})
}
```

규약:

- **한 화면**: 제목 + 대상 목록(스크롤 가능) + 개수 + recovery hint + `Run` / `Cancel`.
- 파괴적이면 hint 자리는 hint 가 없어도 열려 "되돌릴 수 없다"를 말한다. 파괴적이
  아닌 확인(`stages:1`)은 hint 가 있을 때만 연다 (FR-COS-3).
- `Esc` → 취소. `Enter` → **취소** (파괴적 다이얼로그에서 Enter 가 실행하지
  않는다, FR-GIT-176). 실행은 마우스·탭 이동 후 Space/클릭으로만.
- 초기 포커스는 `취소` 버튼이다.
- **모바일 (FR-GIT-94·177)**: 실행 버튼을 목록과 **분리된 별도 행**에 두고,
  목록과 버튼 사이에 시각적 구분(구분선 + 여백)을 둔다. 목록 영역은
  `max-height` + `overflow-y:auto` 로 버튼이 화면 밖으로 밀리지 않게 한다.
  `app.isMobile` 로 판정한다.
- 실행 중에는 두 버튼을 disable 하고 진행 표시를 보인다 (FR-GIT-174).
- 실패하면 사유와 stderr tail 을 보이고 **복사 버튼**을 준다 (FR-GIT-96·175).
- 다이얼로그가 열린 동안에도 폴링은 계속되고, 대상 상태가 바뀌면 1단계 목록 위에
  "대상이 변경되었습니다" 를 보인다 (FR-GIT-178). 다시 열게 강제하지는 않는다.

이 클래스는 M5 묶음 P 의 공통 다이얼로그 규약이 흡수할 자리다. 지금은
파괴적 동작 전용으로 최소하게 만들고, **규약(§5 의 항목들)을 코드 주석에 남긴다.**

## 6. 테스트

`internal/git`:

| # | 검증 | 내용 |
|---|---|---|
| W1 | V39 | `Exec` 이 쓰기 명령을 거부하고 `ExecWrite` 가 읽기 전용 명령을 거부한다 |
| W2 | V39 | `readCommands` ∩ `writeCommands` = ∅ |
| W3 | V39 | 정적: `internal/git` 밖의 `ExecWrite` 호출이 `internal/server` 로 한정된다 |
| W4 | FR-GIT-95 | `Destructive:true` 가 기록에 남는다 |
| W5 | FR-GIT-77 | `Stdin` 이 프로세스에 전달되고 **기록에는 바이트 수만 남는다** |
| W6 | FR-GIT-96 | `StderrTail(200)` 이 마지막 200줄을 준다 |
| W7 | V36 | preflight — identity 미설정 / 머지·리베이스·체리픽·리버트 진행 중 각각 |
| W8 | V36 | 각 Block 이 `Reason` 과 `Fix` 를 모두 갖는다 (빈 문자열 금지) |
| W9 | FR-GIT-87 | detached 는 Block 이 아니라 Warning 이다 |
| W10 | — | `config` 인자 가드: `--get`·`--get-all`·`--list`·`--type` 만 통과, `git config user.name x` 는 거부 |
| W11 | FR-GIT-76 | `commit.template` 의 파일 내용이 담기고, 없으면 빈 문자열 |
| W12 | FR-GIT-93 | `HintLog` — Seq 단조 증가, 링 축출, 동시 접근 안전 |

`internal/server`:

| # | 내용 |
|---|---|
| J1 | `/api/git/preflight` 응답 형태와 `requested` 에코 |
| J2 | `/api/git/policy` 가 `DestructiveActions` 를 그대로 준다 |
| J3 | `/api/git/recovery` 가 hint 목록을 준다 |
| J4 | `s.Git == nil` 이면 3개 전부 503 |

e2e (`e2e/git-confirm.spec.ts`):

| # | 검증 | 내용 |
|---|---|---|
| J5 | V38 | 초기 포커스가 취소 버튼이다 |
| J6 | V38 | 파괴적 다이얼로그에서 Enter 가 실행하지 않는다 |
| J7 | V37 | 대상 목록을 보인다 (개수만이 아니다) |
| J8 | V37 | 한 화면이 영향 범위와 recovery hint 를 함께 보인다 |
| J9 | FR-GIT-94 | 모바일 폭에서 실행 버튼이 목록과 분리돼 보이고 잘리지 않는다 |
| J10 | FR-GIT-175 | 실패 시 stderr tail 과 복사 버튼이 보인다 |

10단계(discard)가 실제 파괴적 동작을 붙이기 전이므로, e2e 는
`window.GitConfirm.open(...)` 을 직접 불러 검사한다.

## 7. 하지 않는 것

- 실제 stage/unstage/discard/commit — 10·11단계.
- 원격 작업 — M3.
- 공통 다이얼로그 프레임워크 — M5 묶음 P.
