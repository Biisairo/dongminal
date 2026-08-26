# 설계 계약 — M1 1단계 `internal/git` (묶음 A, FR-GIT-1~8)

GIT_SRS.md §3.1 의 FR-GIT-1~8 을 코드 계약으로 확정한 문서다. 검증은 V1·V2·V15.
이 문서 밖의 것을 만들지 않는다 (최소 구현 원칙).

## 0. 파일 배치

| 파일 | 내용 |
|---|---|
| `internal/git/doc.go` | 패키지 주석 — 이 패키지가 "무엇을 하지 않는가" |
| `internal/git/errors.go` | 오류 종류 (FR-GIT-8) |
| `internal/git/exec.go` | `Service`·`Runner`·`Exec` (FR-GIT-1~4, 6) |
| `internal/git/guard.go` | 인자 안전 검사 + 읽기 전용 허용 목록 (FR-GIT-2, 7) |
| `internal/git/record.go` | 실행 기록 링 버퍼 (FR-GIT-5, 6) |
| `internal/git/repo.go` | `RepoRoot` — ErrNotRepo 를 만드는 원시 연산 (FR-GIT-8) |

테스트는 각 파일에 대응하는 `*_test.go`. 테스트가 먼저다 (RED → GREEN).

## 1. 오류 (FR-GIT-8)

```go
var (
    ErrGitMissing     = errors.New("git_missing")      // exec.LookPath 실패
    ErrNotRepo        = errors.New("not_a_git_repo")   // 대상이 저장소가 아님
    ErrTimeout        = errors.New("git_timeout")      // ctx 마감 초과
    ErrUnsafeArgument = errors.New("unsafe_argument")  // 인자 안전 검사 거부
    ErrWriteCommand   = errors.New("write_command_not_allowed") // FR-GIT-7
)
```

- 조용히 빈 결과로 낮추지 않는다. `Exec` 이 오류를 반환하면 호출자는
  `errors.Is` 로 종류를 구분할 수 있어야 한다.
- git 이 0 아닌 코드로 끝난 경우는 `*ExecError` 를 반환한다. 위 sentinel 중
  하나로 분류되면 `Unwrap` 이 그것을 준다. 분류 불가면 `Unwrap` 은 nil.

```go
// ExecError 는 실패한 실행 그 자체다. stderr 를 잃지 않는 것이 목적이다.
type ExecError struct {
    Argv     []string
    Cwd      string
    ExitCode int
    Stderr   string
    kind     error // sentinel or nil
}
func (e *ExecError) Error() string
func (e *ExecError) Unwrap() error // kind
```

분류 규칙 (stderr 소문자 비교):
- `not a git repository` 또는 `not a working tree` 포함 → `ErrNotRepo`
- `ctx.Err() == context.DeadlineExceeded` → `ErrTimeout`
- 그 밖 → kind nil

## 2. 실행 (FR-GIT-1~4, 6)

```go
// Runner 는 git 한 번이다. 테스트가 결정론적이려면 주입 가능해야 한다 (FR-GIT-4).
// 구현체는 stdout·stderr 를 분리해 돌려준다 — 상태 파싱과 오류 표시가 서로를
// 오염시키면 안 된다.
type Runner func(ctx context.Context, dir string, args []string) (Output, error)

// Output 은 실행 한 번의 결과다.
type Output struct {
    Stdout          string
    Stderr          string
    ExitCode        int
    StdoutTruncated bool
    StderrTruncated bool
    DurationMs      int64
}

type Service struct { /* 비공개 */ }

type Option func(*Service)

func New(opts ...Option) *Service
func WithRunner(r Runner) Option        // FR-GIT-4
func WithTimeout(d time.Duration) Option // FR-GIT-3
func WithMaxOutput(n int) Option        // FR-GIT-6
func WithRecorder(rec *Recorder) Option // FR-GIT-5

// Exec 은 이 패키지의 단일 진입점이다 (FR-GIT-1).
func (s *Service) Exec(ctx context.Context, dir string, args ...string) (Output, error)
```

기본값 상수 (하드코딩 금지 — 상수로 선언한다):

```go
const (
    DefaultTimeout   = 30 * time.Second // FR-GIT-3
    DefaultMaxOutput = 1 << 20          // 1MiB, FR-GIT-6
    DefaultRecordCap = 500              // FR-GIT-5 링 버퍼 길이
)
```

`Exec` 의 순서:

1. `dir` 이 비었거나 절대경로가 아니면 `ErrUnsafeArgument`.
2. `guardArgs(args)` — 실패 시 `ErrUnsafeArgument` 또는 `ErrWriteCommand`.
   **실패한 호출도 기록에 남긴다** (FR-GIT-5. 무엇이 왜 거부됐는지 Console 이
   보여야 한다). 거부는 `ExitCode: -1`.
3. `ctx` 에 이미 더 짧은 마감이 있으면 그것을 쓰고, 없으면
   `context.WithTimeout(ctx, s.timeout)`. **호출자가 축소할 수 있다**(FR-GIT-3)
   는 뜻은 더 짧은 ctx 를 주면 그것이 이긴다는 뜻이다.
4. `s.run(ctx2, dir, args)` 호출.
5. 결과를 `Recorder` 에 기록한다. 기록은 항상 남는다 — 성공·실패·거부 전부.

`execGit` (기본 Runner, `WithRunner` 미지정 시):

- `exec.LookPath("git")` 실패 → `ErrGitMissing` 을 감싼 오류. 기록도 남긴다.
- `exec.CommandContext(ctx, bin, args...)`. **셸을 경유하지 않는다** (FR-GIT-2).
- `cmd.Dir = dir`.
- `cmd.Stdout` / `cmd.Stderr` 는 각각 상한이 걸린 writer (`cappedBuffer`).
  상한 초과분은 버리고 `Truncated` 를 세운다 (FR-GIT-6).
- 환경은 `os.Environ()` 에 다음을 덧붙인다. 근거를 주석으로 남긴다.

  | 변수 | 값 | 이유 |
  |---|---|---|
  | `GIT_TERMINAL_PROMPT` | `0` | 대화형 프롬프트로 프로세스가 매달리지 않게 한다. 자격증명은 dongminal 을 통과하지 않는다 (FR-GIT-104) |
  | `GIT_OPTIONAL_LOCKS` | `0` | status 폴링(FR-GIT-18~24)이 index.lock 을 잡아 사용자의 터미널 git 과 경합하지 않게 한다 |
  | `GIT_PAGER` / `PAGER` | `cat` | 페이저 실행 방지 |
  | `LC_ALL` | `C` | stderr 분류(§1)가 로케일에 흔들리지 않게 한다 |

- `ExitCode`: 정상 종료면 `cmd.ProcessState.ExitCode()`. ctx 마감이면 `-1` 과
  `ErrTimeout`.
- `DurationMs`: 실행 전후 `time.Since` 의 밀리초.

## 3. 인자 안전 검사와 읽기 전용 허용 목록 (FR-GIT-2, 7)

```go
// readCommands 는 M1 이 실행할 수 있는 git 하위 명령 전부다.
// **여기 없는 것은 실행되지 않는다.** M1 에 파괴적 경로를 만들지 않는 것이
// 목적이며(FR-GIT-7), 목록을 늘리는 것은 해당 마일스톤의 일이다.
var readCommands = map[string]bool{
    "rev-parse": true, "status": true, "diff": true, "diff-tree": true,
    "diff-index": true, "show": true, "log": true, "for-each-ref": true,
    "cat-file": true, "ls-files": true, "symbolic-ref": true,
}
```

`guardArgs(args []string) error`:

1. `len(args) == 0` → `ErrUnsafeArgument`.
2. `args[0]` 이 `-` 로 시작 → `ErrUnsafeArgument`. **하위 명령이 먼저 온다.**
   git 전역 옵션(`-c`, `--exec-path`, `--upload-pack` 등)은 임의 실행 경로가
   되므로 이 패키지는 아예 받지 않는다.
3. `readCommands[args[0]]` 이 false → `ErrWriteCommand`.
4. 모든 인자에 대해: NUL(`\x00`) 포함 → `ErrUnsafeArgument`.
5. 다음 접두사를 가진 인자는 거부 → `ErrUnsafeArgument`:
   `--upload-pack`, `--receive-pack`, `--exec-path`, `--output`, `-o`
   (임의 명령 실행 또는 파일 쓰기 경로).

## 4. 실행 기록 (FR-GIT-5, 6)

```go
// Record 는 실행 한 번의 구조화된 기록이다. M1 은 기록만 하고 표시하지 않는다 —
// Console 탭(M6)이 이것을 읽는다.
type Record struct {
    Seq             uint64   `json:"seq"`
    AtUnixMs        int64    `json:"atUnixMs"`
    Argv            []string `json:"argv"`
    Cwd             string   `json:"cwd"`
    ExitCode        int      `json:"exitCode"`
    DurationMs      int64    `json:"durationMs"`
    Stderr          string   `json:"stderr"`
    StdoutBytes     int      `json:"stdoutBytes"`
    StdoutTruncated bool     `json:"stdoutTruncated"`
    StderrTruncated bool     `json:"stderrTruncated"`
    Destructive     bool     `json:"destructive"` // FR-GIT-95. M1 은 항상 false
    Err             string   `json:"err,omitempty"`
}

// Recorder 는 고정 길이 링 버퍼다. 무한히 자라지 않는다.
type Recorder struct { /* 비공개, sync.Mutex 로 보호 */ }

func NewRecorder(cap int) *Recorder // cap <= 0 이면 DefaultRecordCap
func (r *Recorder) Add(rec Record)
func (r *Recorder) Recent(n int) []Record // 최신이 마지막. n<=0 이면 전부
func (r *Recorder) Len() int
```

`Seq` 는 1 부터 단조 증가한다. 링이 넘쳐 오래된 것이 버려져도 `Seq` 는 되돌아가지
않는다 — Console 이 "무엇이 유실됐는지" 알 수 있어야 한다.

`Service` 는 항상 Recorder 를 갖는다 (`New` 이 기본 것을 만든다).
`func (s *Service) Records(n int) []Record` 로 노출한다.

## 5. 저장소 해석 (FR-GIT-8, FR-GIT-9 의 서버측 원시 연산)

```go
// RepoRoot 는 cwd 가 속한 저장소의 루트 절대경로를 확정한다.
// 저장소가 아니면 ErrNotRepo 다 — 빈 문자열로 낮추지 않는다 (FR-GIT-8).
func (s *Service) RepoRoot(ctx context.Context, cwd string) (string, error)
```

- `git rev-parse --show-toplevel` 을 쓴다.
- stdout 을 `strings.TrimSpace` 한 값이 비면 `ErrNotRepo`.
- 결과가 절대경로가 아니면 `ErrNotRepo` (bare 저장소·이상 응답 방어).
- macOS 의 `/tmp` → `/private/tmp` 같은 심링크 차이는 **정규화하지 않는다.**
  git 이 준 값이 진실이다. 호출자가 비교할 때는 이 함수의 출력끼리 비교한다.

## 6. 테스트 요구 (V1, V2, V15)

`internal/git/*_test.go` 는 실제 git 바이너리에 의존하지 않는 단위 테스트를
기본으로 하고, 실제 git 이 필요한 것만 `testing.Short()` 로 건너뛸 수 있게 한다.

필수 케이스:

| # | 검증 | 내용 |
|---|---|---|
| 1 | V2 | `WithRunner` 로 주입한 Runner 가 받은 `args` 가 **정확히 전달한 배열**과 같다 (FR-GIT-2) |
| 2 | V2 | ctx 마감이 짧으면 `ErrTimeout`. 기본 타임아웃보다 짧은 ctx 가 이긴다 (FR-GIT-3) |
| 3 | V2 | stderr 에 `not a git repository` 가 있고 exit≠0 이면 `errors.Is(err, ErrNotRepo)` |
| 4 | V2 | `exec.LookPath` 실패 경로에서 `errors.Is(err, ErrGitMissing)` — 실제 Runner 를 PATH 조작으로 시험 |
| 5 | V1 | `Exec(ctx, dir, "commit", ...)` 이 `ErrWriteCommand` 로 거부된다. `push`·`add`·`reset`·`checkout`·`stash`·`clean` 각각 거부 |
| 6 | V1 | `-c`, `--exec-path=/x`, `--upload-pack=x`, NUL 포함 인자, 빈 args 가 거부된다 |
| 7 | V15 | 기록에 argv·cwd·exitCode·durationMs·stderr 가 남는다. 성공·실패·거부 3경로 전부 |
| 8 | V15 | 출력이 `WithMaxOutput` 상한을 넘으면 `StdoutTruncated` 가 참이고 보존량이 상한 이하 |
| 9 | V15 | Recorder 링이 cap 을 넘으면 오래된 것이 밀려나고 `Seq` 는 단조 증가 |
| 10 | V15 | Recorder 동시 접근이 race detector 에서 깨끗하다 |
| 11 | — | `RepoRoot` — 정상 / 저장소 아님 / 빈 출력 / 상대경로 출력 |
| 12 | V1 | 기본 `execGit` 이 셸을 경유하지 않음: 인자에 `;`·`$(...)` 가 있어도 그대로 git 에 전달됨을 실제 git 으로 확인 (예: `rev-parse --show-toplevel` 에 이상 인자 → git 이 거부) |

정적 검증 V1 은 별도 테스트로 고정한다:

```
internal/git/static_test.go
  TestNoDirectGitExecOutsidePackage —
    저장소 내 *.go 를 훑어 `exec.Command("git"` / `exec.CommandContext(` + `"git"` 을
    찾는다. 허용 예외는 internal/worktree/** 와 internal/git/** 뿐이다.
    (FR-GIT-1 의 명시된 예외)
```

## 7. 하지 않는 것

- 상태 파싱·diff·signature — 2단계·7단계의 일이다.
- 쓰기 명령·파괴적 동작 — M2 의 일이다. 이 패키지에 자리도 만들지 않는다.
- Console 탭 표시 — M6.
- `Service` 를 `internal/server/deps.go` 에 배선하는 것 — 2단계의 일이다.
