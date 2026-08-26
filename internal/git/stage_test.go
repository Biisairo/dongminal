package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 묶음 H — 스테이징 (GIT_SRS §3A.1 FR-GIT-64~73, 검증 V30·V31·V32).

// headRunner 는 HEAD 가 있는 저장소를 흉내 내는 읽기 실행기다. Unstage 의 경로
// 판정이 읽기 경로(`rev-parse --verify HEAD`)를 거치므로 쓰기 실행기만 주면
// 격리되지 않는다.
func headRunner(_ context.Context, _ string, _ []string) (Output, error) { return Output{}, nil }

// S1 (V30, FR-GIT-64·65): 경로는 항상 `--` 뒤에 온다 — 경로가 옵션으로 해석되는
// 것을 막는 유일한 방법이다.
func TestStageUnstage_PathsAfterSeparator(t *testing.T) {
	ctx := context.Background()
	paths := Paths{"-x.txt", "d ir/한글 파일.txt"}

	f := &writeFake{}
	s := New(WithRunner(headRunner), WithWriteRunner(f.runner))
	if _, err := s.Stage(ctx, "/tmp/repo", paths); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if _, err := s.Unstage(ctx, "/tmp/repo", paths); err != nil {
		t.Fatalf("Unstage: %v", err)
	}
	want := [][]string{
		{"add", "--", "-x.txt", "d ir/한글 파일.txt"},
		{"reset", "-q", "HEAD", "--", "-x.txt", "d ir/한글 파일.txt"},
	}
	if got := fmt.Sprint(f.argvs); got != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
}

// S2 (V31, FR-GIT-65): **HEAD 가 없는 저장소**(초기 커밋 전)의 unstage 는
// `rm --cached` 로 간다 — 되돌릴 트리가 없어 `reset HEAD` 가 실패한다.
//
// 실제 저장소로 확인한다. argv 만 보면 "그 명령이 실제로 성공하는지" 를 알 수 없고,
// 이 요구사항의 본질은 그것이다.
func TestUnstage_NoHeadUsesRmCached(t *testing.T) {
	repo := tempRepoNoCommit(t)
	s := New()
	ctx := context.Background()

	if _, err := s.Unstage(ctx, repo, Paths{"a.txt"}); err != nil {
		t.Fatalf("Unstage: %v", err)
	}
	st, err := s.Status(ctx, repo)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if len(st.Staged) != 0 {
		t.Fatalf("staged 가 남았다: %+v", st.Staged)
	}
	if len(st.Untracked) != 1 || st.Untracked[0].Path != "a.txt" {
		t.Fatalf("untracked = %+v", st.Untracked)
	}
	// 파일 자체는 남아야 한다 — unstage 는 index 만 건드린다.
	if _, err := os.Stat(filepath.Join(repo, "a.txt")); err != nil {
		t.Fatalf("워킹 트리의 파일이 사라졌다: %v", err)
	}
	// 실행된 것이 rm --cached 임을 기록으로 고정한다.
	var argv []string
	for _, rec := range s.Records(0) {
		if len(rec.Argv) > 0 && rec.Argv[0] == "rm" {
			argv = rec.Argv
		}
		if len(rec.Argv) > 0 && rec.Argv[0] == "reset" {
			t.Fatalf("HEAD 없는 저장소에 reset 을 실행했다: %v", rec.Argv)
		}
	}
	if fmt.Sprint(argv) != fmt.Sprint([]string{"rm", "--cached", "-q", "--", "a.txt"}) {
		t.Fatalf("argv = %v", argv)
	}
}

// S3 (V32): 경로 0개와 안전하지 않은 경로는 실행 전에 거부된다. 빈 `add --` 는
// 의도치 않은 전체 add 가 될 수 있다.
func TestStagePaths_Rejected(t *testing.T) {
	cases := []struct {
		name  string
		paths Paths
	}{
		{"경로 0개", nil},
		{"빈 경로", Paths{""}},
		{"절대경로", Paths{"/etc/passwd"}},
		{"부모 참조", Paths{"a/../../b"}},
		{"정규화 안 됨", Paths{"./a.txt"}},
		{"NUL", Paths{"a\x00b"}},
	}
	ctx := context.Background()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deny := func(_ context.Context, _ string, args []string, _ string) (Output, error) {
				t.Fatalf("거부돼야 할 호출이 실행됐다: %v", args)
				return Output{}, nil
			}
			s := New(WithRunner(headRunner), WithWriteRunner(deny))
			if _, err := s.Stage(ctx, "/tmp/repo", c.paths); !errors.Is(err, ErrUnsafeArgument) {
				t.Fatalf("Stage = %v, want ErrUnsafeArgument", err)
			}
			if _, err := s.Unstage(ctx, "/tmp/repo", c.paths); !errors.Is(err, ErrUnsafeArgument) {
				t.Fatalf("Unstage = %v, want ErrUnsafeArgument", err)
			}
			if _, err := s.Discard(ctx, "/tmp/repo", c.paths, nil); !errors.Is(err, ErrUnsafeArgument) {
				t.Fatalf("Discard(tracked) = %v, want ErrUnsafeArgument", err)
			}
			if _, err := s.Discard(ctx, "/tmp/repo", nil, c.paths); !errors.Is(err, ErrUnsafeArgument) {
				t.Fatalf("Discard(untracked) = %v, want ErrUnsafeArgument", err)
			}
		})
	}
}

// S4 (V32, FR-GIT-73): 상한을 넘은 묶음은 나눠 실행하고, 중간 실패는 **몇 개까지
// 적용됐는지**와 함께 보고된다. 부분 적용을 조용히 넘기지 않는다 (§7.1 I2).
func TestStage_SplitsAndReportsPartial(t *testing.T) {
	paths := make(Paths, MaxPathsPerCall*2+1)
	for i := range paths {
		paths[i] = fmt.Sprintf("f%04d.txt", i)
	}

	// 전부 성공하면 3번 나눠 실행되고 마지막 묶음만 짧다.
	f := &writeFake{}
	s := New(WithRunner(headRunner), WithWriteRunner(f.runner))
	if _, err := s.Stage(context.Background(), "/tmp/repo", paths); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if len(f.argvs) != 3 {
		t.Fatalf("실행 %d 회, want 3", len(f.argvs))
	}
	for i, want := range []int{MaxPathsPerCall, MaxPathsPerCall, 1} {
		// argv = add + "--" + 경로들
		if got := len(f.argvs[i]) - 2; got != want {
			t.Fatalf("%d 번째 묶음의 경로 %d 개, want %d", i, got, want)
		}
		if f.argvs[i][1] != "--" {
			t.Fatalf("%d 번째 묶음에 `--` 가 없다: %v", i, f.argvs[i][:2])
		}
	}

	// 두 번째 묶음에서 실패하면 첫 묶음은 이미 적용된 상태다.
	boom := errors.New("index.lock")
	calls := 0
	fail := func(_ context.Context, _ string, _ []string, _ string) (Output, error) {
		calls++
		if calls == 2 {
			return Output{ExitCode: 1, Stderr: boom.Error()}, nil
		}
		return Output{}, nil
	}
	s2 := New(WithRunner(headRunner), WithWriteRunner(fail))
	_, err := s2.Stage(context.Background(), "/tmp/repo", paths)
	var be *BatchError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v, want *BatchError", err)
	}
	if !be.Partial() || be.Applied != MaxPathsPerCall || be.Total != len(paths) {
		t.Fatalf("BatchError = %+v", be)
	}
	// 실패 뒤 남은 묶음은 실행하지 않는다.
	if calls != 2 {
		t.Fatalf("실행 %d 회, want 2 (실패 후 중단)", calls)
	}
	if !strings.Contains(be.Error(), "index.lock") {
		t.Fatalf("실패 사유가 사라졌다: %v", be)
	}
}

// S5 (V37, FR-GIT-89·92): Discard 는 파괴적으로 기록되고, **실행 전에** recovery
// hint 가 남는다. 실행 후에 남기면 실행이 실패한 경로에서 hint 가 없다.
func TestDiscard_DestructiveAndHintBeforeExec(t *testing.T) {
	var hintsAtExec []int
	var argvs [][]string
	var destructive []bool
	// 실행 시점의 hint 수를 보려면 실행기가 Service 를 봐야 한다.
	var s *Service
	s = New(WithRunner(headRunner), WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (Output, error) {
		hintsAtExec = append(hintsAtExec, len(s.Hints(0)))
		argvs = append(argvs, append([]string(nil), args...))
		return Output{}, nil
	}))

	if _, err := s.Discard(context.Background(), "/tmp/repo", Paths{"a.txt"}, Paths{"n ew.txt"}); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	want := [][]string{
		{"checkout", "-q", "--", "a.txt"},
		{"clean", "-q", "-f", "--", "n ew.txt"},
	}
	if fmt.Sprint(argvs) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", argvs, want)
	}
	for i, n := range hintsAtExec {
		if n == 0 {
			t.Fatalf("%d 번째 실행 시점에 hint 가 없었다", i)
		}
	}

	hints := s.Hints(0)
	if len(hints) != 1 {
		t.Fatalf("hint %d 개, want 1: %+v", len(hints), hints)
	}
	h := hints[0]
	if h.Action != ActionDiscard || h.Repo != "/tmp/repo" || h.Note == "" {
		t.Fatalf("hint = %+v", h)
	}
	if fmt.Sprint(h.Targets) != fmt.Sprint([]string{"a.txt", "n ew.txt"}) {
		t.Fatalf("targets = %v", h.Targets)
	}

	for _, rec := range s.Records(0) {
		if len(rec.Argv) == 0 || rec.Argv[0] == "rev-parse" {
			continue
		}
		destructive = append(destructive, rec.Destructive)
	}
	if fmt.Sprint(destructive) != fmt.Sprint([]bool{true, true}) {
		t.Fatalf("파괴적 선언 = %v, want [true true]", destructive)
	}
}

// tempRepoNoCommit 은 커밋 0개 + staged 1개인 저장소다 (픽스처의 empty-no-commit
// 과 같은 상태) — V31 이 딛는 유일한 상태다.
func tempRepoNoCommit(t *testing.T) string {
	t.Helper()
	bin := gitPath(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "-b", "main")
	// 설정을 저장소 안에 박아 둔다 — 사용자의 전역 설정에 흔들리면 결정론을 잃는다.
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "tester")
	run("config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("staged before first commit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "a.txt")
	return dir
}

// S5 (FR-GIT-73): Discard 는 두 명령으로 갈리므로 둘째에서 실패하면 **첫째는 이미
// 적용된 상태다.** 그 사실이 partial 로 보고되지 않으면 사용자는 tracked 쪽이
// 버려진 것을 모른다.
func TestDiscard_PartialAcrossBothCommands(t *testing.T) {
	fail := func(_ context.Context, _ string, args []string, _ string) (Output, error) {
		if args[0] == "clean" {
			return Output{ExitCode: 1, Stderr: "fatal: clean 실패"}, nil
		}
		return Output{}, nil
	}
	s := New(WithRunner(headRunner), WithWriteRunner(fail))

	_, err := s.Discard(context.Background(), "/tmp/repo", Paths{"a.txt", "b.txt"}, Paths{"n.txt"})
	var be *BatchError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v, want *BatchError", err)
	}
	if !be.Partial() || be.Applied != 2 || be.Total != 3 {
		t.Fatalf("BatchError = %+v", be)
	}
}
