package git

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// 거부·실패 사유는 열거한다 — 호출자가 errors.Is 로 종류를 구분할 수 있어야
// 한다 (FR-GIT-8). 조용히 빈 결과로 낮추지 않는다.
var (
	ErrGitMissing = errors.New("git_missing")
	ErrNotRepo    = errors.New("not_a_git_repo")
	ErrTimeout    = errors.New("git_timeout")
	// 호출자가 요청을 거둬들였다 (FR-GIT-217). 서버의 실패가 아니므로 마감
	// 초과(ErrTimeout)와도, 일반 실패와도 갈라 둔다.
	ErrCanceled       = errors.New("git_canceled")
	ErrUnsafeArgument = errors.New("unsafe_argument")
	ErrWriteCommand   = errors.New("write_command_not_allowed")
)

// kinds 는 분류 가능한 사유 전부다. 이미 분류된 오류를 다시 감싸지 않기 위한
// 판정에도 쓴다.
var kinds = []error{ErrGitMissing, ErrNotRepo, ErrTimeout, ErrCanceled, ErrUnsafeArgument, ErrWriteCommand}

// ExecError 는 실패한 실행 그 자체다. stderr 를 잃지 않는 것이 목적이다.
type ExecError struct {
	Argv     []string
	Cwd      string
	ExitCode int
	Stderr   string
	kind     error // sentinel or nil
}

func (e *ExecError) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" {
		msg = "(stderr 없음)"
	}
	if e.kind != nil {
		return fmt.Sprintf("%v: git %s (exit %d): %s", e.kind, strings.Join(e.Argv, " "), e.ExitCode, msg)
	}
	return fmt.Sprintf("git %s (exit %d): %s", strings.Join(e.Argv, " "), e.ExitCode, msg)
}

// Unwrap 은 분류된 사유를 준다. 분류 불가면 nil 이다 — 그 경우 호출자가 볼 것은
// exit 코드와 stderr 뿐이다.
func (e *ExecError) Unwrap() error { return e.kind }

// classify 는 stderr 와 ctx 로 실패의 종류를 정한다. 비교를 소문자로 하고 기본
// Runner 가 LC_ALL=C 를 거는 이유가 같다 — 분류가 로케일에 흔들리면 안 된다.
func classify(ctx context.Context, stderr string) error {
	if ctx != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return ErrTimeout
	}
	// 마감 초과 다음이다 — 마감 초과도 취소이지만 뜻이 이미 정해졌다 (FR-GIT-217).
	if ctx != nil && errors.Is(ctx.Err(), context.Canceled) {
		return ErrCanceled
	}
	low := strings.ToLower(stderr)
	if strings.Contains(low, "not a git repository") || strings.Contains(low, "not a working tree") {
		return ErrNotRepo
	}
	return nil
}

// classified reports whether err already carries one of the enumerated kinds.
func classified(err error) bool {
	for _, k := range kinds {
		if errors.Is(err, k) {
			return true
		}
	}
	return false
}
