package write

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/gittest"
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

	if _, err := Resolve(s, context.Background(), absTmpRepo, ResolveOurs, Paths{"a.txt", "d ir/b.txt"}); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	// REPO_FIX 01 §7.4: 경로마다 따로 실행한다 — 한 경로의 실패가 다른 경로를
	// 막지 않는다.
	want := [][]string{
		{"checkout", "--ours", "--", "a.txt"},
		{"add", "--", "a.txt"},
		{"checkout", "--ours", "--", "d ir/b.txt"},
		{"add", "--", "d ir/b.txt"},
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
	if _, err := Resolve(s, context.Background(), absTmpRepo, ResolveTheirs, Paths{"a.txt"}); err != nil {
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
	if _, err := Resolve(s, context.Background(), absTmpRepo, ResolveOurs, Paths{"a.txt"}); err != nil {
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
	if _, err := Resolve(s, context.Background(), absTmpRepo, "mine", Paths{"a.txt"}); !errors.Is(err, core.ErrUnsafeArgument) {
		t.Fatalf("알 수 없는 side = %v, want ErrUnsafeArgument", err)
	}
	if _, err := Resolve(s, context.Background(), absTmpRepo, ResolveOurs, nil); !errors.Is(err, core.ErrUnsafeArgument) {
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
	res, err := Resolve(s, context.Background(), absTmpRepo, ResolveOurs, Paths{"a.txt"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(res) != 1 || res[0].OK || res[0].Error == "" {
		t.Fatalf("실패가 결과에 실리지 않았다: %+v", res)
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

// conflictRepo 는 경로 f 를 한쪽은 고치고(ours=main) 한쪽은 지운(theirs=del)
// 수정/삭제 충돌(UD)과, 경로 g 의 양쪽 수정 충돌(UU)을 만든다.
func conflictRepo(t *testing.T) string {
	t.Helper()
	repo := tempRepo(t)
	for _, f := range []string{"f", "g"} {
		if err := os.WriteFile(filepath.Join(repo, f), []byte("base\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	gitRun(t, repo, "add", "f", "g")
	gitRun(t, repo, "commit", "-q", "-m", "base")
	gitRun(t, repo, "checkout", "-q", "-b", "del")
	gitRun(t, repo, "rm", "-q", "f")
	if err := os.WriteFile(filepath.Join(repo, "g"), []byte("theirs\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "commit", "-q", "-am", "del f, edit g")
	gitRun(t, repo, "checkout", "-q", "main")
	for f, body := range map[string]string{"f": "ours\n", "g": "ours\n"} {
		if err := os.WriteFile(filepath.Join(repo, f), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	gitRun(t, repo, "commit", "-q", "-am", "edit f g")
	cmd := exec.Command("git", "merge", "-q", "del")
	cmd.Dir = repo
	_ = cmd.Run() // 충돌로 exit 1
	return repo
}

// REPO_FIX 01 §7.4: 선택한 쪽이 지운 경로는 `git rm` 이다. 종전에는 `checkout
// --theirs` 가 "does not have their version" 으로 실패했고, 같은 배치의 다른 경로도
// 적용되지 않았다(실측).
func TestResolve_DeletedSideRemovesAndBatchContinues(t *testing.T) {
	repo := conflictRepo(t)
	s := core.New()
	res, err := Resolve(s, context.Background(), repo, ResolveTheirs, Paths{"f", "g"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	for _, r := range res {
		if !r.OK {
			t.Fatalf("경로 %s 실패: %s", r.Path, r.Error)
		}
	}
	if _, err := os.Stat(filepath.Join(repo, "f")); !os.IsNotExist(err) {
		t.Fatal("theirs 가 지운 f 가 남아 있다")
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "g")); string(b) != "theirs\n" {
		t.Fatalf("g = %q, want theirs", b)
	}
	if out := gittest.Run(t, repo, "ls-files", "-u"); strings.TrimSpace(out) != "" {
		t.Fatalf("충돌이 남았다: %q", out)
	}
}

// §7.4: ours 가 남긴 쪽은 checkout+add 로 해결된다(UD 의 ours).
func TestResolve_KeptSideChecksOut(t *testing.T) {
	repo := conflictRepo(t)
	res, err := Resolve(core.New(), context.Background(), repo, ResolveOurs, Paths{"f"})
	if err != nil || len(res) != 1 || !res[0].OK {
		t.Fatalf("Resolve: %+v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "f")); string(b) != "ours\n" {
		t.Fatalf("f = %q, want ours", b)
	}
}

// §7.4: 쓰기 단계 마감이 지나면 남은 경로는 실행하지 않고 skipped 로 싣는다.
func TestResolve_DeadlineSkipsRemaining(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	s := core.New(core.WithRunner(headRunner), core.WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
		calls++
		if args[0] == "add" {
			cancel() // 첫 경로를 끝낸 순간 마감
		}
		return core.Output{}, nil
	}))
	res, err := Resolve(s, ctx, absTmpRepo, ResolveOurs, Paths{"a", "b", "c"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !res[0].OK || !res[1].Skipped || !res[2].Skipped || res[1].OK {
		t.Fatalf("결과 = %+v", res)
	}
	if calls != 2 {
		t.Fatalf("마감 뒤에도 실행했다: %d", calls)
	}
}
