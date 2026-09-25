package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 기본값은 상수로 못박는다 — 호출 지점마다 다른 숫자가 흩어지면 상한이 상한이
// 아니게 된다.
const (
	DefaultTimeout   = 30 * time.Second // FR-GIT-3
	DefaultMaxOutput = 1 << 20          // 1MiB, FR-GIT-6
	DefaultRecordCap = 500              // FR-GIT-5 링 버퍼 길이
)

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

type Service struct {
	run       Runner
	writeRun  WriteRunner // 쓰기 경로(ExecWrite)의 실행기. nil 이면 실제 git 이다
	timeout   time.Duration
	maxOutput int
	rec       *Recorder
	hints     HintLog // FR-GIT-93. 제로값이 곧 기본 용량의 링이다
}

type Option func(*Service)

func WithRunner(r Runner) Option { return func(s *Service) { s.run = r } }

func WithTimeout(d time.Duration) Option { return func(s *Service) { s.timeout = d } }

func WithMaxOutput(n int) Option { return func(s *Service) { s.maxOutput = n } }

func WithRecorder(rec *Recorder) Option { return func(s *Service) { s.rec = rec } }

func New(opts ...Option) *Service {
	s := &Service{timeout: DefaultTimeout, maxOutput: DefaultMaxOutput}
	for _, o := range opts {
		o(s)
	}
	if s.timeout <= 0 {
		s.timeout = DefaultTimeout
	}
	if s.maxOutput <= 0 {
		s.maxOutput = DefaultMaxOutput
	}
	// Service 는 항상 기록을 갖는다 — "기록이 없어서 남기지 못했다"는 경로를
	// 만들지 않는다 (FR-GIT-5).
	if s.rec == nil {
		s.rec = NewRecorder(DefaultRecordCap)
	}
	if s.run == nil {
		limit := s.maxOutput
		s.run = func(ctx context.Context, dir string, args []string) (Output, error) {
			return execGit(ctx, dir, args, limit, "")
		}
	}
	return s
}

// Records 는 최근 기록을 준다 (최신이 마지막). n<=0 이면 보유분 전부다.
func (s *Service) Records(n int) []Record { return s.rec.Recent(n) }

// MaxOutput 은 출력 상한이다 (FR-GIT-6). 상한에서 잘린 출력을 "온전한 결과"로
// 답할 수 없는 조회들이 사유에 이 값을 적으므로, 패키지 밖에서도 읽어야 한다.
func (s *Service) MaxOutput() int { return s.maxOutput }

// Exec 은 이 패키지의 단일 진입점이다 (FR-GIT-1).
//
// 거부된 호출도 기록에 남는다 (FR-GIT-5) — 무엇이 왜 거부됐는지 Console 이
// 보여야 하고, 조용한 거부는 디버깅할 수 없다.
func (s *Service) Exec(ctx context.Context, dir string, args ...string) (Output, error) {
	rec := func(out Output, err error) { s.record(dir, args, out, err) }
	if err := checkCwd(dir); err != nil {
		return reject(err, rec)
	}
	if err := guardArgs(args); err != nil {
		return reject(err, rec)
	}

	// 호출자가 더 짧은 마감을 주면 그것이 이긴다 (FR-GIT-3).
	ctx2, cancel := deadline(ctx, s.timeout)
	defer cancel()

	out, err := s.run(ctx2, dir, args)
	err = finishExec(ctx2, dir, args, out, err)
	rec(out, err)
	return out, err
}

// checkCwd 는 세 진입점의 공통 전제다. 상대 경로는 해석 기준이 없어 어느 저장소에서
// 도는지 말할 수 없다.
func checkCwd(dir string) error {
	if strings.TrimSpace(dir) == "" || !filepath.IsAbs(dir) {
		return fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", ErrUnsafeArgument, dir)
	}
	return nil
}

// finishExec 는 세 진입점(Exec·ExecWrite·ExecUnguarded)의 오류 분류다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-7-1). 한 자리여야 한쪽만 고쳐지는 일이 없다.
func finishExec(ctx context.Context, dir string, argv []string, out Output, err error) error {
	switch {
	case err == nil && out.ExitCode != 0:
		return &ExecError{Argv: argv, Cwd: dir, ExitCode: out.ExitCode, Stderr: out.Stderr, kind: classify(ctx, out.Stderr)}
	case err != nil && !classified(err):
		// Runner 가 분류되지 않은 오류를 준 경우에도 종류는 붙인다 — 호출자가
		// errors.Is 로 구분할 수 있어야 한다 (FR-GIT-8).
		if k := classify(ctx, out.Stderr); k != nil {
			return fmt.Errorf("%w: %v", k, err)
		}
	}
	return err
}

// reject 는 실행 없이 거부한다. exit -1 은 "프로세스가 뜨지도 않았다"는 표시다.
// 거부도 기록에 남는다 (FR-GIT-5) — rec 가 진입점별 기록 방식이다.
func reject(err error, rec func(Output, error)) (Output, error) {
	out := Output{ExitCode: -1}
	rec(out, err)
	return out, err
}

// deadline 은 마감 d 를 걸되 호출자의 ctx 가 더 짧으면 그것이 이긴다 (FR-GIT-3).
func deadline(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if dl, ok := ctx.Deadline(); ok && time.Until(dl) <= d {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, d)
}

func (s *Service) record(dir string, args []string, out Output, err error) {
	s.rec.Add(newRecord(dir, args, out, err))
}

// execGit 은 기본 실행이다. **셸을 경유하지 않는다** (FR-GIT-2) — 인자는 배열로
// 그대로 전달되고, 문자열 결합으로 명령을 만들지 않는다.
//
// stdin 은 쓰기 경로만 쓴다 (FR-GIT-77). 프로세스를 띄우는 자리를 둘로 나누지 않는
// 이유는 환경·상한·마감 처리가 두 경로에서 갈라지면 안 되기 때문이다.
func execGit(ctx context.Context, dir string, args []string, limit int, stdin string) (Output, error) {
	started := time.Now()
	cmd, err := Command(ctx, dir, args, stdin)
	if err != nil {
		return Output{ExitCode: -1, DurationMs: elapsedMs(started)}, err
	}

	stdout := &cappedBuffer{limit: limit}
	stderr := &cappedBuffer{limit: limit}
	// REPO_FIX 01 P-1: 잡과 같은 기동 헬퍼다 — 그룹·그룹 SIGTERM·유예 뒤 KILL.
	runErr := Spawn(ctx, cmd, stdout.consume, stderr.consume)

	out := Output{
		Stdout:          stdout.String(),
		Stderr:          stderr.String(),
		ExitCode:        -1,
		StdoutTruncated: stdout.isTruncated(),
		StderrTruncated: stderr.isTruncated(),
		DurationMs:      elapsedMs(started),
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return out, fmt.Errorf("%w: git %s 가 %dms 에서 마감을 넘겼다", ErrTimeout, strings.Join(args, " "), out.DurationMs)
	}
	// 마감 초과 다음에 본다 — 마감 초과도 취소이지만 뜻이 이미 정해졌다.
	// stderr 의 `signal: killed` 로 판정하지 않는다: 사용자가 보낸 진짜 kill 과
	// 구분되지 않는다 (FR-GIT-217).
	if errors.Is(ctx.Err(), context.Canceled) {
		return out, fmt.Errorf("%w: git %s 를 호출자가 취소했다", ErrCanceled, strings.Join(args, " "))
	}
	if cmd.ProcessState != nil {
		out.ExitCode = cmd.ProcessState.ExitCode()
	}
	if runErr != nil && out.ExitCode <= 0 {
		// 프로세스를 시작조차 못했거나 신호로 죽었다 — exit 코드로 설명되지 않는다.
		//
		// FR-RMS-2: 그중 **작업 디렉터리가 없는 것**만 소실로 분류한다. git 은
		// 실행되지 못했으므로 읽을 stderr 가 없다 — 근거는 chdir 의 ENOENT 다.
		// `Op` 로 좁히는 이유는 git 바이너리가 사라진 경우도 ENOENT 이고 그것은
		// 이미 ErrGitMissing 의 몫이기 때문이다 (§2.2).
		//
		// 새 세션으로 띄우면(REPO_FIX 01 P-2) Go 는 posix_spawn 대신 fork 경로를
		// 타고, 그 경로의 chdir 실패는 `fork/exec <bin>` 오류로 온다. 그래서 오류
		// 모양 대신 **디렉터리가 실제로 없는가**를 본다.
		//
		//	이전 동작: 오류가 ENOENT 일 때만 소실로 봤다
		//	새 동작: 오류 종류는 보지 않고 PathError + dir 이 실제로 없음으로 판정한다
		//	이유: Windows 는 없는 작업 디렉터리를 ERROR_DIRECTORY("The directory
		//	      name is invalid")로 답해 소실이 일반 실패가 됐다(CI 실측)
		//
		// bin 은 캐시된 값이다 (FR-OPT-7-1). 그것이 사라졌으면(git 을 지우거나 옮김)
		// 캐시를 버리고 부재로 답한다 — 다음 실행이 PATH 를 다시 훑는다.
		if VanishedBin(cmd, runErr) {
			return out, fmt.Errorf("%w: %v", ErrGitMissing, runErr)
		}
		var pe *fs.PathError
		if errors.As(runErr, &pe) {
			if _, serr := os.Stat(dir); errors.Is(serr, fs.ErrNotExist) {
				return out, fmt.Errorf("%w: chdir %s: %v", ErrRepoMissing, dir, runErr)
			}
		}
		return out, fmt.Errorf("git %s: %w", strings.Join(args, " "), runErr)
	}
	return out, nil
}

// Command 는 git 프로세스 하나를 만든다 — 동기 실행(execGit)과 잡(jobs)이 함께
// 쓰는 **유일한 기동 자리**다 (OPTIMIZE_REFACTOR_SRS FR-OPT-7-1).
//
//	이전 동작: 두 경로가 각자 LookPath·CommandContext 를 했고, 잡 경로에는
//	          launchArgs(`-c log.showSignature=false`)가 없었다
//	새  동작: bin 탐색·launchArgs·Env·Dir·Stdin 을 여기서 한 번에 붙인다
//	이유:     REPO_FIX 01 R-4.1 은 **모든** git 실행에 중립화를 강제한다
//
// 띄우는 것은 호출자다 — Spawn 으로 띄워야 그룹·신호 시퀀스가 붙는다.
func Command(ctx context.Context, dir string, args []string, stdin string) (*exec.Cmd, error) {
	bin, err := lookGit()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrGitMissing, err)
	}
	cmd := exec.CommandContext(ctx, bin, launchArgs(args)...)
	cmd.Dir = dir
	// 빈 stdin 에 파이프를 만들지 않는다 — 읽기 폴링이 매번 지불할 비용이 아니다.
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	cmd.Env = Env()
	return cmd, nil
}

// gitBin 은 git 실행 파일의 탐색 결과다. status 폴링을 포함한 모든 실행이 PATH 를
// 훑지 않게 한다 (FR-OPT-7-1). 키는 PATH 값이다 — PATH 가 바뀌면 다시 찾는다.
// 찾지 못한 결과는 담지 않는다: git 을 설치하면 다음 실행이 곧 찾는다.
var gitBin struct {
	mu   sync.Mutex
	path string
	bin  string
}

func lookGit() (string, error) {
	path := os.Getenv("PATH")
	gitBin.mu.Lock()
	defer gitBin.mu.Unlock()
	if gitBin.bin != "" && gitBin.path == path {
		return gitBin.bin, nil
	}
	bin, err := exec.LookPath("git")
	if err != nil {
		return "", err
	}
	gitBin.path, gitBin.bin = path, bin
	return bin, nil
}

// VanishedBin 은 기동 실패가 **캐시된 bin 이 사라진 탓**인지 본다. 그렇다면 캐시를
// 버린다 — 다음 실행이 PATH 를 다시 훑는다. 동기 실행과 잡이 함께 쓴다 (FR-OPT-7-1).
func VanishedBin(cmd *exec.Cmd, runErr error) bool {
	var pe *fs.PathError
	if !errors.As(runErr, &pe) {
		return false
	}
	if _, serr := os.Stat(cmd.Path); !errors.Is(serr, fs.ErrNotExist) {
		return false
	}
	forgetGit()
	return true
}

func forgetGit() {
	gitBin.mu.Lock()
	defer gitBin.mu.Unlock()
	gitBin.path, gitBin.bin = "", ""
}

// launchArgs 는 가드를 지난 argv 앞에 사용자 설정을 중립화하는 전역 인자를 붙인다
// (REPO_FIX 01 P-4). 기록에는 원래 argv 가 남는다 — 붙이는 자리가 실행 직전이다.
//
// `log.showSignature=true` 면 서명된 커밋에서 log·`--format=%P`·`%B` 출력 앞에 서명
// 검증 문구가 섞여 레코드 파싱·부모 판정(머지 오판)·amend 메시지가 오염됐다(실측).
// 환경변수(GIT_CONFIG_COUNT)는 사용자의 GIT_CONFIG_* 를 덮으므로 쓰지 않는다.
func launchArgs(args []string) []string {
	return append([]string{"-c", "log.showSignature=false"}, args...)
}

// Env 는 git 이 사람을 기다리거나 로케일에 흔들리지 않게 만든다.
func Env() []string {
	return append(os.Environ(),
		// 대화형 프롬프트로 프로세스가 매달리지 않게 한다. 자격증명은 dongminal 을
		// 통과하지 않는다 (FR-GIT-104).
		"GIT_TERMINAL_PROMPT=0",
		// GIT_TERMINAL_PROMPT=0 만으로는 askpass 헬퍼가 **GUI 프롬프트**를 띄울 수
		// 있다 — 그러면 프로세스는 보이지 않는 창을 기다리며 매달린다 (O10).
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
		"SSH_ASKPASS_REQUIRE=never",
		// status 폴링(FR-GIT-18~24)이 index.lock 을 잡아 사용자의 터미널 git 과
		// 경합하지 않게 한다.
		"GIT_OPTIONAL_LOCKS=0",
		// 페이저는 출력을 붙잡는다.
		"GIT_PAGER=cat",
		"PAGER=cat",
		// 편집기를 기다리며 매달리지 않게 한다 (FR-GIT-252 의 `--continue` 경로).
		// `true` 는 파일을 고치지 않고 즉시 성공하므로 git 이 준비해 둔 메시지
		// (MERGE_MSG·rebase 의 todo)를 **그대로** 쓴다 — 사람이 없는 자리에서
		// 편집기를 여는 것은 매달림이지 선택이 아니다.
		"GIT_EDITOR=true",
		"GIT_SEQUENCE_EDITOR=true",
		// stderr 분류가 로케일에 흔들리지 않게 한다.
		"LC_ALL=C",
	)
}

func elapsedMs(started time.Time) int64 { return time.Since(started).Milliseconds() }

// cappedBuffer 는 상한까지만 보존하고 초과분을 버린다 (FR-GIT-6). 큰 diff 하나가
// 프로세스 메모리를 삼키는 것을 막는 것이 목적이다.
//
// 잠금을 갖는 이유: Spawn 은 그룹 밖 손자가 파이프를 쥐면 읽기단을 닫고 돌아오며,
// 그때 소비 고루틴이 아직 쓰고 있을 수 있다.
type cappedBuffer struct {
	mu        sync.Mutex
	limit     int
	buf       []byte
	truncated bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	room := b.limit - len(b.buf)
	switch {
	case room >= len(p):
		b.buf = append(b.buf, p...)
	case room > 0:
		b.buf = append(b.buf, p[:room]...)
		b.truncated = true
	case len(p) > 0:
		b.truncated = true
	}
	// 짧은 쓰기를 보고하면 복사가 오류로 끝난다 — 버린 분량도 썼다고 답하고,
	// 잘렸다는 사실은 truncated 로만 알린다.
	return len(p), nil
}

// consume 은 Spawn 의 소비자다.
func (b *cappedBuffer) consume(r io.Reader) { _, _ = io.Copy(b, r) }

func (b *cappedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

func (b *cappedBuffer) isTruncated() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.truncated
}
