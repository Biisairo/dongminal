package core

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// 실행 층의 단일화 (GIT_EXEC_UNIFY_SRS §3.1~3.2, 검증 V1·V2·V5·V6·V7).
//
// 여기서 시험하는 것은 **인가를 지나지 않는 실행 진입점**이다. `Exec`·`ExecWrite`
// 와 같은 몸통을 쓰되 화이트리스트만 건너뛴다 — 두 도메인(`worktree`·`submodule`)이
// 자기 인가를 이미 갖고 있고, 그 하위 명령이 `argv[0]` 키잉과 맞지 않기 때문이다
// (FR-GIT-246 · D-9).

// unguardedRunner 는 호출 사실과 인자를 붙잡는 쓰기 실행기다. 인가를 지나지
// 않았음을 "runner 에 닿았는가" 로 관찰한다.
func unguardedRunner(seen *[]string, out Output) WriteRunner {
	return func(_ context.Context, _ string, args []string, _ string) (Output, error) {
		*seen = append([]string(nil), args...)
		return out, nil
	}
}

// V1 (FR-GXU-1): 화이트리스트에 없는 하위 명령이 ExecUnguarded 로는 실행되고
// Exec 으로는 거부된다. 이 대비가 "층을 갈랐다"의 전부다.
func TestExecUnguarded_RunsCommandOutsideAllowlist(t *testing.T) {
	// worktree 는 readCommands·writeCommands 어디에도 없다 — 그것이 이 SRS 의 전제다.
	if readCommands["worktree"] || writeCommands["worktree"] {
		t.Fatal("worktree 가 허용 목록에 들어갔다 — GIT_EXEC_UNIFY_SRS N1 위반")
	}
	argv := []string{"worktree", "list", "--porcelain"}

	var seen []string
	s := New(WithWriteRunner(unguardedRunner(&seen, Output{Stdout: "worktree /x\n"})))

	out, err := s.ExecUnguarded(context.Background(), "/repo", UnguardedSpec{
		Argv:   argv,
		Reason: "worktree 도메인",
	})
	if err != nil {
		t.Fatalf("ExecUnguarded 가 거부했다: %v", err)
	}
	if strings.Join(seen, " ") != strings.Join(argv, " ") {
		t.Fatalf("argv 가 그대로 전달되지 않았다: %q", seen)
	}
	if out.Stdout != "worktree /x\n" {
		t.Fatalf("stdout 이 돌아오지 않았다: %q", out.Stdout)
	}

	// 같은 argv 를 인가 층에 주면 막혀야 한다. 막히지 않으면 화이트리스트가
	// 뜻을 잃은 것이다.
	if _, derr := s.Exec(context.Background(), "/repo", argv...); !errors.Is(derr, ErrWriteCommand) {
		t.Fatalf("Exec 이 worktree 를 거부하지 않았다: %v", derr)
	}
}

// V2 (FR-GXU-1): Reason 이 비면 실행하지 않는다. 이 진입점을 쓰는 이유를 적지
// 않고 쓰는 것을 막는다 — 기록에 남는 값이기도 하다.
func TestExecUnguarded_RequiresReason(t *testing.T) {
	var seen []string
	s := New(WithWriteRunner(unguardedRunner(&seen, Output{})))

	_, err := s.ExecUnguarded(context.Background(), "/repo", UnguardedSpec{
		Argv: []string{"worktree", "list"},
	})
	if err == nil {
		t.Fatal("Reason 없이 통과했다")
	}
	if len(seen) != 0 {
		t.Fatalf("거부해야 하는데 실행했다: %q", seen)
	}
}

// V2 (FR-GXU-1): dir 검사는 인가가 아니라 실행의 전제이므로 유지된다.
func TestExecUnguarded_RejectsRelativeDir(t *testing.T) {
	var seen []string
	s := New(WithWriteRunner(unguardedRunner(&seen, Output{})))

	_, err := s.ExecUnguarded(context.Background(), "relative/path", UnguardedSpec{
		Argv:   []string{"worktree", "list"},
		Reason: "테스트",
	})
	if !errors.Is(err, ErrUnsafeArgument) {
		t.Fatalf("상대 경로를 거부하지 않았다: %v", err)
	}
	if len(seen) != 0 {
		t.Fatalf("거부해야 하는데 실행했다: %q", seen)
	}
}

// V4 (FR-GXU-3): spec.Timeout 이 Service 기본 마감을 대신한다. 세 도메인의 마감은
// 기본 30초보다 길어(180초), 이 필드가 없으면 이관이 곧 동작 변경이 된다.
func TestExecUnguarded_SpecTimeoutOverridesDefault(t *testing.T) {
	var deadline time.Time
	s := New(WithWriteRunner(func(ctx context.Context, _ string, _ []string, _ string) (Output, error) {
		if dl, ok := ctx.Deadline(); ok {
			deadline = dl
		}
		return Output{}, nil
	}))

	const want = 180 * time.Second
	start := time.Now()
	if _, err := s.ExecUnguarded(context.Background(), "/repo", UnguardedSpec{
		Argv:    []string{"submodule", "update", "--init"},
		Reason:  "submodule 도메인",
		Timeout: want,
	}); err != nil {
		t.Fatalf("ExecUnguarded: %v", err)
	}
	if deadline.IsZero() {
		t.Fatal("마감이 서지 않았다")
	}
	// 기본 30초를 그대로 썼다면 이 여유로는 설명되지 않는다.
	if got := deadline.Sub(start); got < want-time.Second {
		t.Fatalf("spec.Timeout 이 무시됐다: 마감이 %v 뒤다 (기대 %v)", got, want)
	}
}

// V4 (FR-GXU-3): 호출자의 ctx 가 더 짧으면 여전히 그것이 이긴다 (FR-GIT-3 과 같은 규칙).
func TestExecUnguarded_ShorterContextWins(t *testing.T) {
	var deadline time.Time
	s := New(WithWriteRunner(func(ctx context.Context, _ string, _ []string, _ string) (Output, error) {
		if dl, ok := ctx.Deadline(); ok {
			deadline = dl
		}
		return Output{}, nil
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := s.ExecUnguarded(ctx, "/repo", UnguardedSpec{
		Argv:    []string{"worktree", "prune"},
		Reason:  "worktree 도메인",
		Timeout: 180 * time.Second,
	}); err != nil {
		t.Fatalf("ExecUnguarded: %v", err)
	}
	if got := deadline.Sub(start); got > time.Second {
		t.Fatalf("더 짧은 ctx 가 지지 않았다: 마감이 %v 뒤다", got)
	}
}

// V5 (FR-GXU-4): Service 가 nil 이어도 실행되고 규약이 적용된다. 기록만 없다.
// httpapi 의 s.Git 은 nil 일 수 있는 배선이며(deps.go:106), 그때 checkIgnore 가
// 죽거나 규약 없이 실행되는 것은 둘 다 답이 아니다.
func TestExecUnguarded_NilServiceIsSafe(t *testing.T) {
	var s *Service
	// 실제 git 이 필요하다 — nil Service 는 주입 러너를 가질 수 없다.
	dir := tempRepo(t)

	out, err := s.ExecUnguarded(context.Background(), dir, UnguardedSpec{
		Argv:   []string{"status", "--porcelain"},
		Reason: "nil 안전성",
	})
	if err != nil {
		t.Fatalf("nil Service 에서 실패했다: %v", err)
	}
	if out.ExitCode != 0 {
		t.Fatalf("exit=%d stderr=%q", out.ExitCode, out.Stderr)
	}
}

// V6 (FR-GXU-5): 인가를 지나지 않은 실행이 기록에 표식과 사유를 달고 남는다.
// 표식이 없으면 Console 에서 화이트리스트를 지난 실행과 섞이고, 그 목록을 근거로
// 삼는 판단이 틀린다.
func TestExecUnguarded_RecordCarriesMark(t *testing.T) {
	var seen []string
	s := New(WithWriteRunner(unguardedRunner(&seen, Output{Stdout: "x"})))

	const reason = "worktree 도메인"
	if _, err := s.ExecUnguarded(context.Background(), "/repo", UnguardedSpec{
		Argv:   []string{"worktree", "list"},
		Reason: reason,
	}); err != nil {
		t.Fatalf("ExecUnguarded: %v", err)
	}

	recs := s.Records(0)
	if len(recs) != 1 {
		t.Fatalf("기록이 %d 개다 — 하나여야 한다", len(recs))
	}
	if !recs[0].Unguarded {
		t.Fatal("Unguarded 표식이 없다 — Console 이 구분할 수 없다")
	}
	if recs[0].Reason != reason {
		t.Fatalf("Reason 이 %q 다 (기대 %q)", recs[0].Reason, reason)
	}
	// Write 는 IsWriteCommand 그대로다. worktree 는 목록에 없으므로 false 이며,
	// 그 값이 뜻하는 것은 "쓰기가 아니다"가 아니라 "쓰기 목록에 없다"이다.
	if recs[0].Write {
		t.Fatal("Write 판정이 목록과 어긋난다")
	}
}

// V6 (FR-GXU-5): 인가를 지난 실행에는 표식이 붙지 않는다 — 표식이 늘 켜져 있으면
// 구분이 되지 않는다.
func TestExec_RecordHasNoUnguardedMark(t *testing.T) {
	s := New(WithRunner(func(context.Context, string, []string) (Output, error) {
		return Output{}, nil
	}))
	if _, err := s.Exec(context.Background(), "/repo", "status", "--porcelain"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	recs := s.Records(0)
	if len(recs) != 1 {
		t.Fatalf("기록이 %d 개다", len(recs))
	}
	if recs[0].Unguarded {
		t.Fatal("인가를 지난 실행에 Unguarded 표식이 붙었다")
	}
}

// V2 (FR-GXU-1): 거부된 호출도 기록에 남는다 (FR-GIT-5). 조용한 거부는 디버깅할
// 수 없다 — Exec·ExecWrite 와 같은 규약이다.
func TestExecUnguarded_DeniedCallIsRecorded(t *testing.T) {
	s := New(WithWriteRunner(func(context.Context, string, []string, string) (Output, error) {
		return Output{}, nil
	}))
	_, err := s.ExecUnguarded(context.Background(), "relative", UnguardedSpec{
		Argv:   []string{"worktree", "list"},
		Reason: "테스트",
	})
	if err == nil {
		t.Fatal("거부되지 않았다")
	}
	if recs := s.Records(0); len(recs) != 1 {
		t.Fatalf("거부가 기록되지 않았다: %d 개", len(recs))
	}
}
