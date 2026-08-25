package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	timeout   time.Duration
	maxOutput int
	rec       *Recorder
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
			return execGit(ctx, dir, args, limit)
		}
	}
	return s
}

// Records 는 최근 기록을 준다 (최신이 마지막). n<=0 이면 보유분 전부다.
func (s *Service) Records(n int) []Record { return s.rec.Recent(n) }

// Exec 은 이 패키지의 단일 진입점이다 (FR-GIT-1).
//
// 거부된 호출도 기록에 남는다 (FR-GIT-5) — 무엇이 왜 거부됐는지 Console 이
// 보여야 하고, 조용한 거부는 디버깅할 수 없다.
func (s *Service) Exec(ctx context.Context, dir string, args ...string) (Output, error) {
	if strings.TrimSpace(dir) == "" || !filepath.IsAbs(dir) {
		return s.deny(dir, args, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", ErrUnsafeArgument, dir))
	}
	if err := guardArgs(args); err != nil {
		return s.deny(dir, args, err)
	}

	// 호출자가 더 짧은 마감을 주면 그것이 이긴다 (FR-GIT-3).
	ctx2, cancel := s.withTimeout(ctx)
	defer cancel()

	out, err := s.run(ctx2, dir, args)
	switch {
	case err == nil && out.ExitCode != 0:
		err = &ExecError{Argv: args, Cwd: dir, ExitCode: out.ExitCode, Stderr: out.Stderr, kind: classify(ctx2, out.Stderr)}
	case err != nil && !classified(err):
		// Runner 가 분류되지 않은 오류를 준 경우에도 종류는 붙인다 — 호출자가
		// errors.Is 로 구분할 수 있어야 한다 (FR-GIT-8).
		if k := classify(ctx2, out.Stderr); k != nil {
			err = fmt.Errorf("%w: %v", k, err)
		}
	}
	s.record(dir, args, out, err)
	return out, err
}

// deny 는 실행 없이 거부한다. exit -1 은 "프로세스가 뜨지도 않았다"는 표시다.
func (s *Service) deny(dir string, args []string, err error) (Output, error) {
	out := Output{ExitCode: -1}
	s.record(dir, args, out, err)
	return out, err
}

func (s *Service) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if dl, ok := ctx.Deadline(); ok && time.Until(dl) <= s.timeout {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, s.timeout)
}

func (s *Service) record(dir string, args []string, out Output, err error) {
	rec := Record{
		AtUnixMs:        time.Now().UnixMilli(),
		Argv:            append([]string(nil), args...),
		Cwd:             dir,
		ExitCode:        out.ExitCode,
		DurationMs:      out.DurationMs,
		Stderr:          out.Stderr,
		StdoutBytes:     len(out.Stdout),
		StdoutTruncated: out.StdoutTruncated,
		StderrTruncated: out.StderrTruncated,
	}
	if err != nil {
		rec.Err = err.Error()
	}
	s.rec.Add(rec)
}

// execGit 은 기본 Runner 다. **셸을 경유하지 않는다** (FR-GIT-2) — 인자는 배열로
// 그대로 전달되고, 문자열 결합으로 명령을 만들지 않는다.
func execGit(ctx context.Context, dir string, args []string, limit int) (Output, error) {
	started := time.Now()
	bin, err := exec.LookPath("git")
	if err != nil {
		return Output{ExitCode: -1, DurationMs: elapsedMs(started)}, fmt.Errorf("%w: %v", ErrGitMissing, err)
	}

	stdout := &cappedBuffer{limit: limit}
	stderr := &cappedBuffer{limit: limit}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = gitEnv()
	runErr := cmd.Run()

	out := Output{
		Stdout:          stdout.String(),
		Stderr:          stderr.String(),
		ExitCode:        -1,
		StdoutTruncated: stdout.truncated,
		StderrTruncated: stderr.truncated,
		DurationMs:      elapsedMs(started),
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return out, fmt.Errorf("%w: git %s 가 %dms 에서 마감을 넘겼다", ErrTimeout, strings.Join(args, " "), out.DurationMs)
	}
	if cmd.ProcessState != nil {
		out.ExitCode = cmd.ProcessState.ExitCode()
	}
	if runErr != nil && out.ExitCode <= 0 {
		// 프로세스를 시작조차 못했거나 신호로 죽었다 — exit 코드로 설명되지 않는다.
		return out, fmt.Errorf("git %s: %w", strings.Join(args, " "), runErr)
	}
	return out, nil
}

// gitEnv 는 git 이 사람을 기다리거나 로케일에 흔들리지 않게 만든다.
func gitEnv() []string {
	return append(os.Environ(),
		// 대화형 프롬프트로 프로세스가 매달리지 않게 한다. 자격증명은 dongminal 을
		// 통과하지 않는다 (FR-GIT-104).
		"GIT_TERMINAL_PROMPT=0",
		// status 폴링(FR-GIT-18~24)이 index.lock 을 잡아 사용자의 터미널 git 과
		// 경합하지 않게 한다.
		"GIT_OPTIONAL_LOCKS=0",
		// 페이저는 출력을 붙잡는다.
		"GIT_PAGER=cat",
		"PAGER=cat",
		// stderr 분류가 로케일에 흔들리지 않게 한다.
		"LC_ALL=C",
	)
}

func elapsedMs(started time.Time) int64 { return time.Since(started).Milliseconds() }

// cappedBuffer 는 상한까지만 보존하고 초과분을 버린다 (FR-GIT-6). 큰 diff 하나가
// 프로세스 메모리를 삼키는 것을 막는 것이 목적이다.
type cappedBuffer struct {
	limit     int
	buf       []byte
	truncated bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
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
	// 짧은 쓰기를 보고하면 os/exec 의 복사가 오류로 끝난다 — 버린 분량도 썼다고
	// 답하고, 잘렸다는 사실은 truncated 로만 알린다.
	return len(p), nil
}

func (b *cappedBuffer) String() string { return string(b.buf) }
