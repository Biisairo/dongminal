# 설계 계약 — M1 2단계 서버측 (묶음 B·C 서버, FR-GIT-9~24·60~63)

GIT_SRS.md §3.2·§3.3·§3.8 을 코드 계약으로 확정한 문서다.
검증은 V3·V5·V13·V16·V18·V28·V29, 그리고 **V4(stale 가드)의 서버측 절반**.

전제: 1단계(`internal/git` 의 `Service`·`Exec`·`RepoRoot`)가 완료돼 있다.
계약 문서: `./GIT_M1_STEP1_CONTRACT.md`.

## 0. 파일 배치

| 파일 | 내용 |
|---|---|
| `internal/git/dirs.go` | `GitDirs` — gitdir·common-dir 해석 |
| `internal/git/status.go` | `Status`·`FileEntry`·`ParseStatusV2`·`Service.Status` |
| `internal/git/signature.go` | `Signature`·`Service.Signature` (git 실행 없음) |
| `internal/git/store.go` | `Store` — single-flight + TTL 캐시 + 마지막 관측값 |
| `internal/server/handlers_git.go` | `/api/git/repos`·`/pin`·`/unpin`·`/status`·`/signature` |
| `internal/server/git_pins.go` | `workspace.json` 최상위 `git.pinned[]` 읽기·쓰기 (O1) |

## 1. 상태 (FR-GIT-32~37, 이 단계는 서버측 파싱까지)

### 1.1 타입

```go
// FileEntry 는 변경 파일 한 개다. porcelain v2 의 XY 를 그대로 보존한다 —
// 표시 계층이 해석을 바꿀 수 있어야 하고, 서버가 의미를 미리 뭉개면 되돌릴 수 없다.
type FileEntry struct {
    Path     string `json:"path"`
    OrigPath string `json:"origPath,omitempty"` // rename/copy 원본 (FR-GIT-36)
    XY       string `json:"xy"`                 // 2문자. '.' 는 변화 없음
    Staged   bool   `json:"staged"`             // X != '.'
    Unstaged bool   `json:"unstaged"`           // Y != '.'
    Conflict bool   `json:"conflict"`           // porcelain 레코드 종류가 'u'
    Untracked bool  `json:"untracked"`          // 레코드 종류가 '?'
    Score    int    `json:"score,omitempty"`    // rename/copy 유사도 (R100 의 100)
    Sub      string `json:"sub,omitempty"`      // 서브모듈 상태 필드. "N..." 이면 생략
}

// Status 는 한 리포의 관측 결과다.
type Status struct {
    Repo        string      `json:"repo"`
    Oid         string      `json:"oid"`         // HEAD 커밋. 초기 커밋 전이면 ""
    Branch      string      `json:"branch"`      // detached 면 ""
    Detached    bool        `json:"detached"`    // FR-GIT-33
    Initial     bool        `json:"initial"`     // 커밋이 없는 저장소
    Upstream    string      `json:"upstream"`
    HasUpstream bool        `json:"hasUpstream"` // FR-GIT-33
    Ahead       int         `json:"ahead"`
    Behind      int         `json:"behind"`
    Staged      []FileEntry `json:"staged"`
    Changes     []FileEntry `json:"changes"`
    Untracked   []FileEntry `json:"untracked"`
    Conflicts   []FileEntry `json:"conflicts"`
    Total       int         `json:"total"`       // **서로 다른 경로의 개수.** 배지용 (FR-GIT-14)
}
```

분류 규칙 (FR-GIT-34·37):

| 레코드 | 소속 |
|---|---|
| `1`/`2` 에서 `X != '.'` | `Staged` |
| `1`/`2` 에서 `Y != '.'` | `Changes` |
| `u` | `Conflicts` **만** (Staged·Changes 에 넣지 않는다) |
| `?` | `Untracked` |
| `!` | 버린다 (`--ignored` 를 주지 않으므로 나오지 않아야 한다) |

한 파일이 `Staged` 와 `Changes` 에 동시에 들 수 있다 — 그것이 사실이며, M2 의
indeterminate 표시(FR-GIT-70)가 그 사실 위에 선다. `Total` 은 그래서 합이 아니라
**서로 다른 경로의 개수**다.

각 그룹은 경로 오름차순으로 정렬한다 — git 의 출력 순서에 UI 가 의존하지 않게 한다.

### 1.2 파싱 (FR-GIT-35·36, 검증 V9)

```go
// ParseStatusV2 는 `git status --porcelain=v2 -z --branch` 의 stdout 을 해석한다.
// 레코드는 NUL 로 끝난다 — 헤더(`# ...`)도 마찬가지다 (git 2.50 확인).
func ParseStatusV2(out string) (Status, error)
```

토큰 규칙:

- 입력을 `\x00` 으로 쪼갠다. 마지막 빈 조각은 버린다.
- 헤더: `# branch.oid <oid|(initial)>`, `# branch.head <name|(detached)>`,
  `# branch.upstream <name>`, `# branch.ab +<n> -<n>`.
  - `(initial)` → `Initial=true`, `Oid=""`
  - `(detached)` → `Detached=true`, `Branch=""`
  - `branch.upstream` 이 없으면 `HasUpstream=false`
  - `branch.ab` 이 없으면 Ahead·Behind 는 0
  - 모르는 `#` 헤더는 조용히 무시한다 (git 이 헤더를 늘려도 깨지지 않게)
- `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — 필드는 공백 8개로 나뉘고
  **9번째 필드부터 끝까지가 경로다** (경로에 공백이 있을 수 있으므로
  `strings.SplitN(rest, " ", 8)` 로 앞 8개만 떼고 나머지를 경로로 삼는다).
- `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` +
  **다음 토큰이 `origPath`** 다. rename/copy 는 NUL 조각 2개를 소비한다.
  `<X><score>` 는 `R100`·`C75` 형태 — 첫 글자는 버리고 숫자를 `Score` 로 둔다.
- `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — 앞 10개 필드.
- `? <path>` / `! <path>` — 접두 2글자 뒤 전부가 경로.
- 필드 수가 모자란 레코드는 **오류로 반환한다.** 조용히 건너뛰면 목록이 조용히
  틀린다.

### 1.3 조회

```go
// Status 는 리포 하나의 상태를 관측한다. 캐시·single-flight 는 Store 의 일이다.
func (s *Service) Status(ctx context.Context, repo string) (Status, error)
```

`git status --porcelain=v2 -z --branch` 를 `dir=repo` 로 실행한다.
`--ignored` 를 주지 않는다 — 무시된 파일은 관심 대상이 아니고 비용만 든다.

## 2. 시그니처 (FR-GIT-19, 검증 V5)

```go
// Signature 는 .git 상태 변화를 싸게 감지하는 값이다 (§2.6: 0.02ms).
// **git 을 실행하지 않는다** — read 1회 + stat 2회다.
type Signature struct {
    Head         string `json:"head"`         // .git/HEAD 내용 (trim)
    RefName      string `json:"refName"`      // HEAD 가 심볼릭이면 그 ref. 아니면 ""
    IndexMtimeNs int64  `json:"indexMtimeNs"`
    IndexSize    int64  `json:"indexSize"`
    RefMtimeNs   int64  `json:"refMtimeNs"`
    Value        string `json:"value"`        // 위 전부를 합친 비교용 문자열
}

func (s *Service) Signature(ctx context.Context, repo string) (Signature, error)
```

- `GitDirs` 로 gitdir·common-dir 을 얻는다 (§3).
- `head` = `<gitdir>/HEAD` 의 내용을 TrimSpace.
- `index` = `<gitdir>/index` 를 `os.Stat` — `ModTime().UnixNano()` 와 `Size()`.
  **size 를 함께 넣는 이유**: stat 한 번이 둘을 다 주므로 비용이 0 이고, mtime
  해상도가 낮은 파일시스템에서 같은 초 안의 두 번째 쓰기를 놓치지 않는다.
- `head` 가 `ref: ` 로 시작하면 `RefName` 은 그 뒤이고, ref 파일은
  `<commonDir>/<refName>` → 없으면 `<commonDir>/packed-refs` 를 stat 한다
  (packed 상태의 ref 는 개별 파일이 없다).
- 없는 파일의 mtime·size 는 0 이다. **오류가 아니다** — 초기 저장소에는 index 가
  없을 수 있다.
- `Value` = `head + "|" + indexMtimeNs + "|" + indexSize + "|" + refName + "|" + refMtimeNs`.

## 3. gitdir 해석

```go
// GitDirs 는 리포의 gitdir 과 common-dir 을 준다. worktree 에서는 둘이 다르다 —
// HEAD·index 는 gitdir 에, refs 는 common-dir 에 있다.
func (s *Service) GitDirs(ctx context.Context, repo string) (gitDir, commonDir string, err error)
```

`git rev-parse --absolute-git-dir --git-common-dir` 한 번으로 두 줄을 얻는다.
둘째 줄이 상대경로면 `repo` 기준으로 절대화한다 (git 2.50 은 `.git` 을 준다).

## 4. `Store` — 캐시·single-flight·마지막 관측값 (FR-GIT-21·24·63, O3)

```go
// Store 는 git 조회 앞에 서서 세 가지를 한다.
//   ① single-flight — 같은 리포의 같은 조회가 겹치면 한 번만 실행한다 (FR-GIT-21)
//   ② TTL 캐시 — 브라우저 창이 여러 개여도 실행 횟수가 창 수에 비례하지 않는다 (FR-GIT-63)
//   ③ 마지막 관측값 보관 — 활성이 아닌 리포의 배지가 딛는 값이다 (FR-GIT-24, O4)
type Store struct { /* 비공개 */ }

const (
    DefaultStatusTTL   = 200 * time.Millisecond // O3. status 폴링 주기(1s)보다 짧다
    DefaultRepoRootTTL = 2 * time.Second
    DefaultGitDirsTTL  = 30 * time.Second
    DefaultObservedCap = 64 // 관측값을 들고 있을 리포 수 상한
)

func NewStore(svc *Service, opts ...StoreOption) *Store
func WithStatusTTL(d time.Duration) StoreOption // 0 이면 캐시 없음 (FR-GIT-23 의 정신)
func WithClock(now func() time.Time) StoreOption // 테스트가 시간을 지배해야 한다

// Observation 은 관측 한 번 + 언제 관측했는지다.
type Observation struct {
    Status         Status    `json:"status"`
    Signature      Signature `json:"signature"`
    ObservedAtUnixMs int64   `json:"observedAtUnixMs"`
}

// Status 는 캐시가 유효하면 그것을, 아니면 새로 관측해 돌려준다.
// cached 는 git 을 실행하지 않았음을 뜻한다.
func (st *Store) Status(ctx context.Context, repo string) (obs Observation, cached bool, err error)

// Observed 는 캐시를 **만료 여부와 무관하게** 준다. 활성이 아닌 리포의 배지가
// 이것을 쓴다 — 그래서 폴링 대상이 활성 1개로 유지된다 (FR-GIT-24).
func (st *Store) Observed(repo string) (Observation, bool)

func (st *Store) Signature(ctx context.Context, repo string) (Signature, error)
func (st *Store) RepoRoot(ctx context.Context, cwd string) (string, error) // TTL 캐시
func (st *Store) Service() *Service
```

- `Status` 는 관측할 때 Signature 도 함께 채운다 (2 syscall, 사실상 무료). 클라이언트가
  status 직후 signature 를 또 부르지 않게 한다.
- single-flight 는 **리포별**이다. 서로 다른 리포의 조회는 서로를 막지 않는다.
- `Observed` 는 `DefaultObservedCap` 개까지 LRU 로 들고 있는다. 무한히 자라지 않는다.
- `WithStatusTTL(0)` 이면 매번 실행한다. single-flight 는 그래도 동작한다.

## 5. HTTP 표면 (FR-GIT-60~63)

라우트는 `internal/server/handlers_api.go` 의 `apiRoutes` 테이블에 등록한다
(FR-GIT-61). `s.Git == nil` 이면 전부 `503` 이고 다른 동작에는 영향이 없다.

### 5.1 오류 규약

모든 실패는 JSON 본문이다. **클라이언트가 종류를 구분할 수 있어야 한다.**

```json
{"error":"not_a_git_repo","message":"…"}
```

| 사유 | 상태 | `error` |
|---|:--:|---|
| `repo` 누락·상대경로 | 400 | `bad_request` |
| `ErrNotRepo` | 404 | `not_a_git_repo` |
| `ErrGitMissing` | 503 | `git_missing` |
| `ErrTimeout` | 504 | `git_timeout` |
| `s.Git == nil` | 503 | `git_unavailable` |
| 그 밖 | 500 | `git_failed` (`message` 에 stderr tail) |

### 5.2 `GET /api/git/repos?tool=<toolId>`

```json
{
  "follow": {
    "cwd": "/abs/cwd",
    "isRepo": true,
    "path": "/abs/root",
    "name": "dongminal",
    "reason": "",
    "badge": {"total": 3, "branch": "git", "detached": false, "observedAtUnixMs": 1756...}
  },
  "pinned": [
    {"path": "/abs/other", "name": "gitmaster", "isRepo": true, "reason": "",
     "badge": {"total": 1, "branch": "main", "detached": false, "observedAtUnixMs": 1756...}}
  ]
}
```

- `tool` 이 비면 `follow.cwd` 는 서버의 cwd 다 (`/api/cwd` 와 같은 규약).
- `follow.isRepo=false` 면 `path` 는 `""`, `reason` 은 사유다.
  **마지막 유효 리포를 유지하지 않는다** (FR-GIT-10).
- `badge` 는 **`Store.Observed` 만 읽는다. 이 엔드포인트는 `git status` 를 실행하지
  않는다** (FR-GIT-24). 관측 이력이 없으면 `badge` 는 `null`.
- `badge.observedAtUnixMs` 로 클라이언트가 최신 여부를 판정한다 (O4).
- 핀 항목의 `isRepo` 는 `Store.RepoRoot` (TTL 캐시)로 확인한다. 저장소가 아니게 된
  핀은 **목록에서 지우지 않고** `isRepo:false` 로 보인다 — 사용자가 지울지 정한다.
- `name` 은 `filepath.Base(path)`.

### 5.3 `POST /api/git/repos/pin`

요청 `{"path":"/abs/any/where"}` → 응답 `{"root":"/abs/root","pinned":["/abs/root", …]}`

- `path` 는 절대경로여야 한다 (400 `bad_request`).
- `Store.RepoRoot` 로 **재확인한 뒤** 그 결과(`root`)를 핀한다 (FR-GIT-12·62).
  클라이언트가 보낸 경로를 그대로 저장하지 않는다.
- 이미 있으면 중복 추가하지 않는다 (멱등). 200 을 준다.
- `pinned` 는 정렬하지 않는다 — 사용자가 추가한 순서가 목록 순서다.

### 5.4 `POST /api/git/repos/unpin`

요청 `{"path":"/abs/root"}` → 응답 `{"pinned":[…]}`

- 저장된 값과 문자열이 정확히 같은 항목을 지운다. `rev-parse` 를 하지 않는다 —
  저장소가 아니게 된 핀도 지울 수 있어야 한다.

### 5.5 핀 영속 (O1 — `workspace.json` 최상위 `git.pinned[]`)

```go
// gitPinsRead 는 workspace.json 의 git.pinned[] 를 읽는다. 없으면 빈 목록이다.
func (s *Server) gitPinsRead() ([]string, error)

// gitPinsMutate 는 git.pinned[] **만** 고쳐 저장한다. 다른 키는 건드리지 않는다.
// 낙관적 동시성으로 저장하고, 경합(ErrStale)이면 한 번 다시 읽어 재시도한다.
func (s *Server) gitPinsMutate(fn func([]string) []string) ([]string, error)
```

- `Snapshot()` 의 블롭을 `map[string]any` 로 풀어 `git` 키만 손대고 다시 마샬한다.
  나머지 키(`schemaVersion`·`windows` 등)는 그대로 지나간다.
- 저장 성공 시 `apiWorkspacePut` 과 같은 `workspace_changed` 브로드캐스트를 보낸다
  (FR-GIT-31).
- 블롭이 비었으면 `{"schemaVersion":2}` 를 기반으로 만든다.

### 5.6 `GET /api/git/status?repo=<abs>`

```json
{
  "repo": "/abs/root",
  "requested": "/abs/root",
  "cached": false,
  "observedAtUnixMs": 1756…,
  "signature": { … },
  "status": { … Status … }
}
```

- **`requested` 는 클라이언트가 보낸 값을 그대로 되돌려준다.** stale 가드
  (FR-GIT-16)의 서버측 절반이다 — 클라이언트가 응답만 보고 자기 요청과 짝을 맞출 수
  있어야 한다.
- `repo` 는 `rev-parse` 로 재확인한 정규 루트다 (FR-GIT-62). `requested` 와 다를 수 있다.
- `Store.Status` 를 쓴다 → single-flight + TTL.

### 5.7 `GET /api/git/signature?repo=<abs>`

```json
{"repo":"/abs/root","requested":"/abs/root","signature":{ … }}
```

`repo` 정규화 규칙과 stale 가드 규약은 §5.6 과 같다.

## 6. 배선

- `Deps` 와 `Server` 에 `Git *git.Store` 를 더한다. 주석으로 nil 의 뜻을 남긴다
  (기존 `Runs`·`Worktrees` 주석의 밀도에 맞춘다).
- `cmd/dongminal` 에서 `git.NewStore(git.New())` 를 만들어 주입한다.
- `apiRoutes` 에 5개 라우트를 등록한다. 등록 위치는 `/api/stats` 앞이며 묶음 주석을
  붙인다.

## 7. 테스트 요구

`internal/git`:

| # | 검증 | 내용 |
|---|---|---|
| P1 | V9 | `ParseStatusV2` — 공백·개행·유니코드가 든 경로 |
| P2 | V9 | rename(`2 R.`)·copy(`2 C.`) 가 `OrigPath`·`Score` 를 채운다. NUL 조각 2개 소비 확인 |
| P3 | V9 | `1 MM` 이 Staged·Changes 양쪽에 들고 `Total` 은 1 |
| P4 | V9 | `u UU` 는 Conflicts 에만 든다 |
| P5 | — | `(initial)`·`(detached)`·upstream 없음·`branch.ab` 없음 각각 |
| P6 | — | 필드 수 부족 레코드는 오류 |
| P7 | — | 모르는 `#` 헤더는 무시 |
| P8 | V5 | `Signature` — 실제 임시 저장소에서 index 를 건드리면 값이 바뀌고, 안 건드리면 같다 |
| P9 | V5 | packed-refs 만 있는 상태에서도 Signature 가 오류 없이 나온다 |
| P10 | V5·V13 | `Store.Status` — 동시 10 요청이 Runner 를 **1회만** 부른다 (single-flight) |
| P11 | V5·V13 | TTL 안의 두 번째 요청은 `cached=true` 이고 Runner 를 부르지 않는다 |
| P12 | V18 | `WithStatusTTL(0)` 이면 매번 Runner 를 부른다 |
| P13 | V7·V24 | `Observed` 는 만료된 값도 준다. 관측 없는 리포는 false |
| P14 | V7 | 서로 다른 리포의 조회가 서로를 막지 않는다 (single-flight 가 리포별) |
| P15 | — | `Observed` LRU 가 cap 을 넘으면 오래된 것이 밀려난다 |
| P16 | V3 | `Store.RepoRoot` TTL 캐시 — 두 번째 호출이 Runner 를 부르지 않는다 |
| P17 | — | `GitDirs` — 두 줄 파싱, 둘째 줄 상대경로 절대화 |

`internal/server`:

| # | 검증 | 내용 |
|---|---|---|
| H1 | V28 | 5개 라우트가 `apiRoutes` 에 등록돼 있다 |
| H2 | — | `s.Git == nil` 이면 5개 전부 503 `git_unavailable` |
| H3 | V3 | `/api/git/repos` — follow 가 저장소일 때 / 아닐 때 (`isRepo:false`, `path:""`) |
| H4 | V24 | `/api/git/repos` 가 **`git status` 를 실행하지 않는다** (주입 Runner 의 호출 argv 로 확인) |
| H5 | V16 | `/pin` 이 저장소가 아닌 경로를 404 로 거부하고 `git.pinned` 를 바꾸지 않는다 |
| H6 | V16 | `/pin` 이 `rev-parse` 결과(루트)를 저장한다 — 보낸 하위 경로가 아니다 |
| H7 | V16 | `/pin` 멱등. `/unpin` 이 지운다. `workspace.json` 의 다른 키가 보존된다 |
| H8 | V16·V21 | `/pin`·`/unpin` 이 `workspace_changed` 를 브로드캐스트한다 |
| H9 | V4 | `/status`·`/signature` 응답의 `requested` 가 요청값과 같다 |
| H10 | V29 | `/status` 의 `repo` 는 `rev-parse` 로 재확인된 값이다 (보낸 하위 경로가 아님) |
| H11 | — | 오류 매핑 5종(400/404/503/504/500)의 `error` 코드 |
| H12 | V13 | 동시 N 요청이 status 를 1회만 실행한다 (핸들러 경유) |

기존 테스트 픽스처(`internal/server/fakes_test.go`·`httptest_helpers_test.go`)를 쓴다.
새 fake 를 만들기 전에 있는 것을 먼저 본다.

## 8. 하지 않는 것

- diff 내용 조회 — 7단계.
- 폴링·디바운스·가시성 게이팅 — 6단계(클라이언트측)의 일이다. 서버는 요청을 받을 뿐이다.
- 프론트엔드 어느 것도. 이 단계는 서버측이다.
- 쓰기 명령. 1단계의 허용 목록을 늘리지 않는다.
