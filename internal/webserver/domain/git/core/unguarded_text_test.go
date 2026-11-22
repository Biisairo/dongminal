package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-61: worktree·submodule 의 runGit 은 이 함수 하나다.
// 다른 것(git 부재의 오류 매핑·다듬기)은 인자다.
func TestExecUnguardedText(t *testing.T) {
	errDomain := errors.New("도메인 사유")
	missing := func(err error) error { return fmt.Errorf("%w: %v", errDomain, err) }
	spec := UnguardedSpec{Argv: []string{"status"}, Reason: "시험"}

	run := func(out Output, err error) *Service {
		return New(WithWriteRunner(func(context.Context, string, []string, string) (Output, error) {
			return out, err
		}))
	}

	// 성공: stdout 만, 다듬기는 인자를 따른다.
	got, err := run(Output{Stdout: " a\n", Stderr: "warn\n"}, nil).
		ExecUnguardedText(context.Background(), absRepo, spec, missing, strings.TrimSpace)
	if err != nil || got != "a" {
		t.Fatalf("성공 = %q, %v", got, err)
	}

	// git 부재: 텍스트는 비고 오류는 도메인 매핑을 지난다.
	got, err = run(Output{Stdout: "x"}, ErrGitMissing).
		ExecUnguardedText(context.Background(), absRepo, spec, missing, strings.TrimSpace)
	if got != "" || !errors.Is(err, errDomain) {
		t.Fatalf("git 부재 = %q, %v", got, err)
	}

	// 그 밖의 실패: stdout 다음 stderr, core 의 분류를 %w 로 잇는다.
	got, err = run(Output{Stdout: "o\n", Stderr: "e\n", ExitCode: 1}, nil).
		ExecUnguardedText(context.Background(), absRepo, spec, missing, strings.TrimSpace)
	var ee *ExecError
	if got != "o\ne" || !errors.As(err, &ee) || errors.Is(err, errDomain) {
		t.Fatalf("실패 = %q, %v", got, err)
	}
	if !strings.HasPrefix(err.Error(), "git status: ") {
		t.Fatalf("실패 문구 = %q", err.Error())
	}

	// nil 수신자도 ExecUnguarded 와 같이 안전하다 — Reason 이 비면 거부한다.
	var nilSvc *Service
	if _, err := nilSvc.ExecUnguardedText(context.Background(), absRepo, UnguardedSpec{Argv: []string{"status"}}, missing, strings.TrimSpace); !errors.Is(err, ErrUnsafeArgument) {
		t.Fatalf("nil 수신자 거부 = %v", err)
	}
}

// FR-RDG-61: 새 진입점도 호출처 게이트(FR-GXU-12)의 대상이다.
func TestUnguardedCallPatternCoversText(t *testing.T) {
	for _, s := range []string{`svc.` + `ExecUnguarded(ctx`, `svc.` + `ExecUnguardedText(ctx`,
		`svc.` + `UnguardedTextRunner(opTimeout`} {
		if !unguardedCall.MatchString(s) {
			t.Fatalf("게이트가 놓친다: %s", s)
		}
	}
}

// QUALITY_GO_SRS FR-QG-50 (PROD3 GD-3): worktree·submodule 의 감싸개는 이 실행기 하나다.
// 마감·사유는 spec 으로, 위치 인자는 argv 로 간다. 결과는 ExecUnguardedText 와 같다.
func TestUnguardedTextRunner(t *testing.T) {
	var gotArgv []string
	svc := New(WithWriteRunner(func(_ context.Context, _ string, argv []string, _ string) (Output, error) {
		gotArgv = argv
		return Output{Stdout: " a\n"}, nil
	}))
	run := svc.UnguardedTextRunner(time.Minute, "시험", func(err error) error { return err }, strings.TrimSpace)
	got, err := run(context.Background(), absRepo, "status", "--porcelain")
	if err != nil || got != "a" || strings.Join(gotArgv, " ") != "status --porcelain" {
		t.Fatalf("= %q, %v, argv %v", got, err, gotArgv)
	}
	// 사유가 비면 ExecUnguarded 와 같이 거부한다.
	var nilSvc *Service
	if _, err := nilSvc.UnguardedTextRunner(0, "", func(err error) error { return err }, strings.TrimSpace)(
		context.Background(), absRepo, "status"); !errors.Is(err, ErrUnsafeArgument) {
		t.Fatalf("사유 없음 = %v", err)
	}
}
