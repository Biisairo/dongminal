# 설계 계약 — M2 10·11단계 스테이징·커밋 (묶음 H·I, FR-GIT-64~85)

GIT_SRS.md §3A.1·§3A.2 다. 검증은 V30·V31·V32·V33·V34·V35·V61.
전제: 9단계(안전 정책)가 **완성돼 있다.** 순서를 바꾸지 않는다.

## 0. 파일 배치

| 파일 | 변경 |
|---|---|
| `internal/git/stage.go` | stage / unstage / discard (묶음 H) |
| `internal/git/commit.go` | commit / undo-last (묶음 I) |
| `internal/server/handlers_git_write.go` | 6개 쓰기 라우트 |
| `web/js/git-panel.js` | 체크박스·일괄 버튼·커밋 영역 |
| `web/js/git-commit.js` | 커밋 영역(메시지·옵션·undo 토스트) |
| `web/style.css` | 스테이징·커밋 스타일 |
| `e2e/git-staging.spec.ts` · `e2e/git-commit.spec.ts` | **신규** |

## 1. 스테이징 (10단계, FR-GIT-64~73)

### 1.1 서버

```go
// Paths 는 경로 묶음이다. 항상 `--` 뒤에 온다 — 경로가 옵션으로 해석되는 것을
// 막는 유일한 방법이다.
type Paths []string

// Stage 는 경로들을 index 에 올린다 (FR-GIT-64·66·68·69).
func (s *Service) Stage(ctx context.Context, repo string, paths Paths) (Output, error)

// Unstage 는 경로들을 index 에서 내린다 (FR-GIT-65·67).
//
// **HEAD 가 없는 저장소(초기 커밋 전)에서는 `reset HEAD` 가 실패한다** —
// 되돌릴 트리가 없다. 그 경우 `rm --cached` 로 간다 (FR-GIT-65, 검증 V31).
func (s *Service) Unstage(ctx context.Context, repo string, paths Paths) (Output, error)

// Discard 는 워킹 트리의 변경을 버린다. **파괴적이다** (FR-GIT-89).
// tracked 는 `checkout -- <paths>`, untracked 는 `clean -f -- <paths>` 로
// 갈라지므로 호출자가 어느 쪽인지 알려 준다.
func (s *Service) Discard(ctx context.Context, repo string, tracked, untracked Paths) (Output, error)
```

명령 매핑:

| 동작 | argv |
|---|---|
| Stage | `add -- <paths…>` |
| Unstage (HEAD 있음) | `reset -q HEAD -- <paths…>` |
| Unstage (HEAD 없음) | `rm --cached -q -- <paths…>` |
| Discard tracked | `checkout -q -- <paths…>` |
| Discard untracked | `clean -q -f -- <paths…>` |

- HEAD 존재 판정: `rev-parse --verify HEAD` 의 성공 여부. 읽기 경로다.
- 경로는 **리포 상대경로**여야 한다. 절대경로·`..` 포함은 거부(`ErrUnsafeArgument`).
- 경로가 0개면 실행하지 않고 오류다. 빈 `add --` 는 의도치 않은 전체 add 가 될 수 있다.
- 경로 개수 상한을 둔다: `MaxPathsPerCall = 1000`. 초과하면 서버가 여러 번 나눠
  실행한다 (argv 길이 한계). **나눠 실행하다 중간에 실패하면 그 사실을 그대로
  보고한다** — 부분 적용을 조용히 넘기지 않는다 (FR-GIT-73).
- `Discard` 는 `WriteSpec{Destructive:true}` 로 실행하고, 실행 **전에**
  `HintLog.Add` 로 recovery hint 를 남긴다 (FR-GIT-92).

### 1.2 FR-GIT-73 — 실패 시 원상

git 의 `add`/`reset`/`checkout` 은 각각 원자적이지 않다(경로별로 처리한다).
**진짜 롤백은 불가능하다.** 그래서 요구사항을 이렇게 만족시킨다:

1. 실행 전 `git status --porcelain=v2 -z` 를 찍어 둔다 (이미 캐시에 있다).
2. 실패하면 **실행 후 상태를 즉시 다시 찍어** 실행 전과 비교한다.
3. 달라진 것이 있으면 오류 응답에 `partial: true` 와 **무엇이 바뀌었는지**를 담아
   사용자에게 보인다. 달라진 것이 없으면 `partial: false`.

이것이 "부분 적용 상태로 조용히 남기지 않는다" 의 실체다. 조용히 남기지 않는 것이
요구사항이고, git 이 주지 않는 원자성을 흉내 내는 것은 요구사항이 아니다.
**이 해석을 코드 주석과 SRS 변경 기록에 남긴다.**

### 1.3 라우트

| 메서드 | 경로 | 본문 |
|---|---|---|
| POST | `/api/git/stage` | `{"repo":"…","paths":["…"]}` |
| POST | `/api/git/unstage` | `{"repo":"…","paths":["…"]}` |
| POST | `/api/git/discard` | `{"repo":"…","tracked":["…"],"untracked":["…"],"confirm":true}` |

응답: `{"requested":"…","repo":"…","ok":true,"partial":false,"status":{…}}`
— **실행 후 상태를 응답에 함께 담는다** (FR-GIT-71: 폴링 주기를 기다리지 않는다).

`/discard` 는 `confirm:true` 가 없으면 400 `confirmation_required`.
서버도 확인을 요구한다 — 클라이언트만 막으면 `dmctl git discard` 가 우회한다.

### 1.4 클라이언트 (FR-GIT-66~72)

- 파일 행에 체크박스를 둔다. 다중 선택(FR-GIT-69)은 체크박스 + `Shift` 범위 선택.
- 그룹 헤더에 일괄 버튼:
  - `changes` 그룹 → `모두 스테이지`
  - `untracked` 그룹 → `모두 스테이지`
  - `staged` 그룹 → `모두 언스테이지`
  - **tracked 만 / untracked 만** (FR-GIT-68): `changes`·`untracked` 가 이미
    그 구분이므로 그룹별 일괄이 곧 그것이다. 추가 버튼을 만들지 않는다.
- 파일 행 hover 시 `+`(stage) / `−`(unstage) / `↺`(discard) 인라인 버튼.
- **indeterminate (FR-GIT-70)**: `staged && unstaged` 인 파일은
  `input.indeterminate = true` 와 `.git-file.partial` 로 구분한다. `title` 에
  "일부만 스테이지됨".
- **충돌 파일 stage (FR-GIT-72)**: 실행 **전에** "충돌을 해결됨으로 표시합니다"
  확인을 보인다. `GitConfirm` 을 쓰되 파괴적이 아니므로 1단계 확인이다.
- discard 는 `GitConfirm.open({action:'discard', targets:<파일 목록>, hint})` 를
  거친다. 서버의 `/api/git/policy` 목록으로 파괴적임을 판정한다 (9단계 §4).
- 성공 응답의 `status` 로 화면을 즉시 갱신한다. 폴링을 기다리지 않는다 (FR-GIT-71).
- `partial:true` 면 `.git-partial-note` 로 무엇이 바뀌었는지 보인다.

## 2. 커밋 (11단계, FR-GIT-74~85)

### 2.1 서버

```go
// CommitOpts 는 커밋 한 번의 옵션이다. 조합 명령을 만들지 않는다 — VSCode 의
// 20개 조합 명령을 이 구조체 하나가 대체한다 (FR-GIT-79).
type CommitOpts struct {
    Message  string // stdin 으로 전달한다. 인자로 넘기지 않는다 (FR-GIT-77)
    Amend    bool
    SignOff  bool
    NoVerify bool
    All      bool // -a
}

// Commit 은 staged 내용을 커밋한다.
//   git commit --file=- --cleanup=strip [--amend] [--signoff] [--no-verify] [-a]
// 메시지는 stdin 이다 — 인자에 넣으면 프로세스 목록과 실행 기록에 남는다.
func (s *Service) Commit(ctx context.Context, repo string, o CommitOpts) (Output, error)

// UndoLast 는 직전 커밋을 되돌린다. `reset --soft HEAD@{1}` 이다 (FR-GIT-82) —
// 워킹 트리와 index 를 건드리지 않으므로 파괴적이 아니다.
func (s *Service) UndoLast(ctx context.Context, repo string) (Output, error)

// LastCommitMessage 는 amend 토글이 채울 메시지다 (FR-GIT-78).
//   git log -1 --pretty=%B
func (s *Service) LastCommitMessage(ctx context.Context, repo string) (string, error)
```

- `--cleanup=strip` 은 주석·후행 공백을 정리한다.
- `Amend` 이면 `--amend` 를 더한다. `--no-edit` 은 **주지 않는다** —
  `--file=-` 이 이미 메시지를 정하므로 에디터가 열리지 않는다.
- `git commit` 은 `writeCommands` 에 있다. `ExecWrite` 로 실행하고
  `Destructive:false` 다 (amend 는 되돌릴 수 있다 — `HEAD@{1}` 이 남는다).
- `UndoLast` 도 `ExecWrite`, `Destructive:false`. `--soft` 는 아무것도 지우지 않는다.
  **`--hard` 를 여기에 쓰지 않는다.**

### 2.2 라우트

| 메서드 | 경로 | 본문 / 응답 |
|---|---|---|
| POST | `/api/git/commit` | `{"repo":"…","message":"…","amend":false,"signoff":false,"noVerify":false,"all":false}` → `{"ok":true,"oid":"…","status":{…},"undoToken":"…"}` |
| POST | `/api/git/undo-last` | `{"repo":"…","undoToken":"…"}` → `{"ok":true,"message":"…","status":{…}}` |

- 메시지는 **본문으로만** 받는다. 쿼리 파라미터로 받지 않는다 (FR-GIT-61 표의 명시).
- 커밋 전 `Preflight` 를 서버가 다시 돌린다. `Blocks` 가 비어 있지 않으면
  409 `preflight_blocked` + `{"preflight":{…}}`. **클라이언트만 막으면
  `dmctl git commit` 이 우회한다.**
- 빈 메시지 → 400 `empty_message`. staged 가 없고 `all:false` → 400
  `nothing_staged` (FR-GIT-84). `--allow-empty` 는 M2 범위 밖이다.

### 2.3 undo 토큰 (FR-GIT-81·83, 검증 V35)

**만료된 undo 가 실행될 수 있어서는 안 된다.** 클라이언트 타이머만으로는 보장할 수
없다 — 탭을 멈춰 두거나 요청을 직접 보내면 우회된다. 그래서 서버가 토큰을 쥔다.

```go
// undoTicket 은 방금 만든 커밋 하나에 대한 되돌리기 권한이다.
// 5초 뒤(UndoTTL) 만료되고, 같은 리포에 새 커밋이 생기면 즉시 무효가 된다
// (FR-GIT-83).
const UndoTTL = 5 * time.Second
```

- `/commit` 성공 시 토큰을 발급한다. 리포별로 **하나만** 유지한다 — 새 커밋이
  이전 토큰을 밀어낸다.
- `/undo-last` 는 토큰이 없거나·만료됐거나·리포가 다르면 409 `undo_expired`.
- 성공 시 토큰을 즉시 소비한다 (재실행 불가).
- 응답의 `message` 로 클라이언트가 메시지 입력을 커밋 직전으로 되돌린다 (FR-GIT-82).

### 2.4 클라이언트 커밋 영역 (`web/js/git-commit.js`)

5단계가 만든 `.git-commit` 자리를 살린다 (FR-GIT-39 의 고정 영역을 유지한다).

```
.git-commit
├ textarea.git-commit-msg      ← auto-grow. 기본 2줄
├ .git-commit-resize           ← 경계 드래그 (FR-GIT-74)
└ .git-commit-side
    ☐ amend        [Commit ▾]
```

- **auto-grow (FR-GIT-74)**: 입력마다 `scrollHeight` 로 높이를 맞추고
  `GIT_COMMIT_MAX_ROWS`(기본 12) 를 넘으면 내부 스크롤로 넘긴다.
- **경계 드래그**: `.git-commit-resize` 를 잡아 높이를 바꾼다. 값은
  `localStorage`(기기별)에 남긴다.
- **draft 영속 (FR-GIT-75, O6)**: `ws.git.drafts[<repo>]`. 입력이 멈춘 뒤
  300ms 디바운스로 `_save()` 한다. 리포·창 전환·새로고침에서 보존된다.
  서버가 `git.drafts` 를 건드리지 않으므로(핀과 달리) 클라이언트가 주인이다.
- **template (FR-GIT-76)**: draft 가 비어 있고 preflight 의 `template` 이 있으면
  그것으로 채운다. draft 가 있으면 덮지 않는다.
- **amend 토글 (FR-GIT-78)**: 켜면 현재 draft 를 `_amendStash` 에 넣고
  `LastCommitMessage` 로 채운다. 끄면 `_amendStash` 를 되돌린다. 왕복이 손실 없어야
  한다 (검증 V33).
- **`Commit ▾` (FR-GIT-79)**: sign-off / no-verify / commit all 체크박스 3개.
  기본 전부 off. 선택은 `localStorage` 에 남기지 **않는다** — no-verify 가 기억되면
  훅이 조용히 계속 꺼진다.
- **비활성 사유 (FR-GIT-84)**: 메시지가 비었거나 staged 가 없으면 disable 하고
  버튼 옆(또는 `title`)에 사유를 보인다. **왜 못 누르는지 보이지 않으면 실패다.**
- **GPG (FR-GIT-85)**: preflight 의 `gpgSign` 이 참이면 `.git-commit-gpg` 배지를
  보인다("서명 커밋"). 서명 실패는 커밋 실패이므로 별도 처리 없이 stderr 를 그대로
  보인다.
- **preflight 차단 표시 (FR-GIT-88)**: 409 `preflight_blocked` 응답의 `blocks` 를
  `.git-preflight` 패널에 `Reason` + `Fix` 로 보인다. Fix 는 복사 가능해야 한다.
- **detached 경고 (FR-GIT-87)**: `warnings` 에 `detached_head` 가 있으면 커밋 전
  1단계 확인을 띄운다("이 커밋은 어느 브랜치에도 속하지 않습니다").
- **성공 (FR-GIT-80·81)**: 메시지 입력을 비우고 draft 를 지운다. 응답 `status` 로
  화면을 갱신한다. `undoToken` 으로 토스트를 5초 띄운다.
- **토스트 (FR-GIT-83)**: 5초 뒤 사라진다. 사라진 뒤에는 진입점이 DOM 에 없다.
  서버 토큰도 만료되므로 **두 겹으로 막힌다.**

## 3. 테스트

`internal/git`:

| # | 검증 | 내용 |
|---|---|---|
| S1 | V30 | Stage/Unstage 의 argv 가 `-- <paths>` 형태다 |
| S2 | V31 | **HEAD 없는 저장소**에서 Unstage 가 `rm --cached` 로 간다 (실제 임시 저장소) |
| S3 | V32 | 경로 0개 거부, 절대경로·`..` 거부 |
| S4 | V32 | `MaxPathsPerCall` 초과 시 나눠 실행하고, 중간 실패가 `partial` 로 보고된다 |
| S5 | V37 | Discard 가 `Destructive:true` 로 기록되고 실행 전 hint 가 남는다 |
| S6 | V34 | **Commit 의 메시지가 stdin 으로 전달되고 argv 에 없다** |
| S7 | V34 | 기록의 `Argv` 에 메시지가 없고 `StdinBytes` 만 있다 |
| S8 | V33 | CommitOpts 조합이 정확한 플래그를 만든다 (amend/signoff/no-verify/-a) |
| S9 | V35 | UndoLast 가 `reset --soft HEAD@{1}` 이다. `--hard` 가 나오지 않는다 |
| S10 | V33 | `LastCommitMessage` 가 여러 줄 메시지를 그대로 준다 |

`internal/server`:

| # | 검증 | 내용 |
|---|---|---|
| S11 | V35 | undo 토큰: 발급 → 5초 후 409 `undo_expired` (시계 주입) |
| S12 | V35 | 새 커밋이 이전 토큰을 무효화한다 |
| S13 | V35 | 소비된 토큰의 재사용이 409 |
| S14 | V36 | preflight 차단 시 `/commit` 이 409 이고 **커밋이 만들어지지 않는다** |
| S15 | V30 | 응답에 실행 후 `status` 가 함께 온다 |
| S16 | V37 | `/discard` 가 `confirm` 없이는 400 |
| S17 | — | 빈 메시지 400, staged 없음 400 |

e2e:

| # | 검증 | 내용 |
|---|---|---|
| E1 | V30 | 파일·그룹·다중선택 stage/unstage 가 목록에 반영된다 |
| E2 | V32 | indeterminate 파일이 구분 표시된다 |
| E3 | V33 | draft 가 새로고침 후 보존된다 |
| E4 | V33 | amend 토글 왕복이 메시지를 손실 없이 되돌린다 |
| E5 | V33 | 메시지가 비면 Commit 이 disabled 이고 사유가 보인다 |
| E6 | V35 | 커밋 후 5초 안에 undo 가 동작하고, 5초 뒤 진입점이 사라진다 |
| E7 | V35 | 진입점이 사라진 뒤 API 직접 호출도 409 다 |
| E8 | V37 | discard 가 2단계 확인을 거치고 파일 목록을 보인다 |
| E9 | V36 | identity 를 지운 임시 저장소에서 커밋이 차단되고 Fix 가 보인다 |

## 4. 하지 않는 것

- hunk/line 단위 스테이징 — 비목표.
- `--allow-empty` — 범위 밖 (FR-GIT-84 명시).
- 충돌 해결 UI — 범위 밖.
- 원격 작업 — M3.
