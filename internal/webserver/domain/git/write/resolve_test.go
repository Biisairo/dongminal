package write

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// FR-GIT-224 (V101) — 충돌 파일 하나를 한쪽으로 해결한다.
//
// **실측이 이 설계를 정했다**: `git checkout --ours -- <path>` 는 워킹 트리만
// 바꾸고 index 의 unmerged stage 를 그대로 둔다 (git 2.50.1). `add` 가 뒤따르지
// 않으면 파일이 Conflicts 그룹에서 빠지지 않는다.
func TestResolve_CheckoutThenAdd(t *testing.T) {
	var argvs [][]string
	var destructive []bool
	s := core.New(core.WithRunner(headRunner), core.WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
		argvs = append(argvs, append([]string(nil), args...))
		return core.Output{}, nil
	}))

	if _, err := Resolve(s, context.Background(), "/tmp/repo", ResolveOurs, Paths{"a.txt", "d ir/b.txt"}); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := [][]string{
		{"checkout", "--ours", "--", "a.txt", "d ir/b.txt"},
		{"add", "--", "a.txt", "d ir/b.txt"},
	}
	if fmt.Sprint(argvs) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", argvs, want)
	}
	_ = destructive

	// 되살릴 값이 없는 동작이므로 hint 가 실행 전에 남아야 한다 (FR-GIT-92).
	hints := s.Hints(0)
	if len(hints) != 1 || hints[0].Action != core.ActionResolveSide {
		t.Fatalf("hint = %+v", hints)
	}
	if len(hints[0].Targets) != 2 {
		t.Fatalf("hint targets = %v", hints[0].Targets)
	}
}

func TestResolve_TheirsSide(t *testing.T) {
	var argvs [][]string
	s := core.New(core.WithRunner(headRunner), core.WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
		argvs = append(argvs, append([]string(nil), args...))
		return core.Output{}, nil
	}))
	if _, err := Resolve(s, context.Background(), "/tmp/repo", ResolveTheirs, Paths{"a.txt"}); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if argvs[0][1] != "--theirs" {
		t.Fatalf("argv = %v", argvs)
	}
}

// checkout 은 파괴적으로 선언한다 (FR-GIT-95, 해석 I5) — 워킹 트리의 충돌 표식과
// 사용자가 손댄 내용이 사라지고 git 에 저장된 적이 없어 되살릴 값이 없다.
func TestResolve_CheckoutIsDeclaredDestructive(t *testing.T) {
	var seen []bool
	s := core.New(core.WithRunner(headRunner), core.WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
		return core.Output{}, nil
	}), core.WithRecorder(core.NewRecorder(core.DefaultRecordCap)))
	if _, err := Resolve(s, context.Background(), "/tmp/repo", ResolveOurs, Paths{"a.txt"}); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	for _, r := range s.Records(0) {
		if len(r.Argv) > 0 && r.Argv[0] == "checkout" {
			seen = append(seen, r.Destructive)
		}
	}
	if len(seen) != 1 || !seen[0] {
		t.Fatalf("checkout 의 파괴적 선언 = %v", seen)
	}
}

func TestResolve_RejectsBadSideAndEmptyPaths(t *testing.T) {
	s := core.New(core.WithRunner(headRunner), core.WithWriteRunner(func(_ context.Context, _ string, _ []string, _ string) (core.Output, error) {
		return core.Output{}, nil
	}))
	if _, err := Resolve(s, context.Background(), "/tmp/repo", "mine", Paths{"a.txt"}); !errors.Is(err, core.ErrUnsafeArgument) {
		t.Fatalf("알 수 없는 side = %v, want ErrUnsafeArgument", err)
	}
	if _, err := Resolve(s, context.Background(), "/tmp/repo", ResolveOurs, nil); !errors.Is(err, core.ErrUnsafeArgument) {
		t.Fatalf("빈 경로 = %v, want ErrUnsafeArgument", err)
	}
}

// checkout 이 실패하면 add 를 실행하지 않는다 — 받아 오지 못한 것을 해결됨으로
// 표시하면 충돌이 조용히 사라진다.
func TestResolve_StopsWhenCheckoutFails(t *testing.T) {
	var argvs [][]string
	s := core.New(core.WithRunner(headRunner), core.WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
		argvs = append(argvs, append([]string(nil), args...))
		if args[0] == "checkout" {
			return core.Output{ExitCode: 1, Stderr: "fatal: 실패\n"}, nil
		}
		return core.Output{}, nil
	}))
	if _, err := Resolve(s, context.Background(), "/tmp/repo", ResolveOurs, Paths{"a.txt"}); err == nil {
		t.Fatal("실패가 올라오지 않았다")
	}
	if len(argvs) != 1 {
		t.Fatalf("checkout 실패 뒤에도 실행했다: %v", argvs)
	}
}

// 파괴적 목록에 들어야 2단계 확인과 recovery hint 를 반드시 거친다 (FR-GIT-89).
func TestResolveSide_IsDestructiveAction(t *testing.T) {
	for _, a := range core.DestructiveActions {
		if a == core.ActionResolveSide {
			return
		}
	}
	t.Fatalf("%q 가 core.DestructiveActions 에 없다", core.ActionResolveSide)
}
