package core

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 묶음 A — git 실행 단일 지점 (GIT_SRS §3.1 FR-GIT-1~8, 검증 V1·V2·V15).
//
// 기본은 **실제 git 없이 결정론적인** 단위 테스트다. Runner 주입(FR-GIT-4)이
// 그것을 가능하게 하며, 실제 git 이 필요한 것만 gitPath 로 건너뛴다.

func gitPath(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git 이 없다 — 이 테스트를 건너뛴다")
	}
	return p
}

// tempRepo 는 커밋 하나를 가진 임시 저장소를 만든다. 심링크를 푸는 이유는 git 이
// toplevel 을 물리 경로로 답하기 때문이다 (macOS 의 /var → /private/var).
func tempRepo(t *testing.T) string {
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
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "tester")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "init")
	return dir
}

// 케이스 1 (V2, FR-GIT-2): 주입한 Runner 가 받은 args 가 전달한 배열과 정확히 같다.
func TestExec_ArgsPassedVerbatim(t *testing.T) {
	want := []string{"log", "--format=%H %s", "-n", "3", "--", "a b;c$(x)"}
	var got []string
	var gotDir string
	s := New(WithRunner(func(_ context.Context, dir string, args []string) (Output, error) {
		gotDir, got = dir, args
		return Output{Stdout: "ok\n"}, nil
	}))
	out, err := s.Exec(context.Background(), absTmpRepo, want...)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if out.Stdout != "ok\n" {
		t.Fatalf("stdout %q", out.Stdout)
	}
	if gotDir != absTmpRepo {
		t.Fatalf("dir %q", gotDir)
	}
	if len(got) != len(want) {
		t.Fatalf("args %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("args[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// 케이스 2 (V2, FR-GIT-3): 기본 타임아웃보다 짧은 ctx 가 이기고, 마감 초과는 ErrTimeout.
func TestExec_CallerDeadlineWins(t *testing.T) {
	var budget time.Duration
	runner := func(ctx context.Context, _ string, _ []string) (Output, error) {
		if dl, ok := ctx.Deadline(); ok {
			budget = time.Until(dl)
		}
		<-ctx.Done()
		return Output{ExitCode: -1}, ctx.Err()
	}
	s := New(WithRunner(runner), WithTimeout(10*time.Second))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := s.Exec(ctx, absTmpRepo, "status"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if budget <= 0 || budget > time.Second {
		t.Fatalf("호출자의 짧은 마감이 이기지 않았다: 예산 %v", budget)
	}
}

// FR-GIT-217: 취소는 마감 초과의 대칭이다. 호출자가 요청을 거둬들인 것이지
// 서버가 실패한 것이 아니므로, 신호로 죽은 실행을 일반 실패로 올리면 안 된다.
func TestExec_CallerCancelIsErrCanceled(t *testing.T) {
	runner := func(ctx context.Context, _ string, _ []string) (Output, error) {
		<-ctx.Done()
		return Output{ExitCode: -1}, ctx.Err()
	}
	s := New(WithRunner(runner), WithTimeout(10*time.Second))

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	_, err := s.Exec(ctx, absTmpRepo, "status")
	if !errors.Is(err, ErrCanceled) {
		t.Fatalf("err = %v, want ErrCanceled", err)
	}
	// 마감 초과와 섞이지 않는다 — 둘은 다른 상태 코드로 간다 (504 vs 499).
	if errors.Is(err, ErrTimeout) {
		t.Fatalf("취소가 ErrTimeout 으로도 분류됐다: %v", err)
	}
}

// 케이스 2 의 반대편: 호출자가 마감을 주지 않으면 기본 상한이 걸린다 (FR-GIT-3).
func TestExec_DefaultTimeoutApplied(t *testing.T) {
	var budget time.Duration
	s := New(WithTimeout(2*time.Second), WithRunner(func(ctx context.Context, _ string, _ []string) (Output, error) {
		dl, ok := ctx.Deadline()
		if !ok {
			t.Error("기본 타임아웃이 걸리지 않았다 — ctx 에 마감이 없다")
			return Output{}, nil
		}
		budget = time.Until(dl)
		return Output{}, nil
	}))
	if _, err := s.Exec(context.Background(), absTmpRepo, "status"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if budget <= time.Second || budget > 2*time.Second {
		t.Fatalf("예산 %v, want ~2s", budget)
	}
}

// 케이스 3 (V2, FR-GIT-8): stderr 분류로 ErrNotRepo 를 구분한다.
func TestExec_ClassifiesStderr(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		exit   int
		want   error
	}{
		{"not a repo", "fatal: not a git repository (or any of the parent directories): .git\n", 128, ErrNotRepo},
		{"not a working tree", "fatal: 'x' is not a working tree\n", 128, ErrNotRepo},
		{"unclassified", "error: unknown option `zz'\n", 129, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
				return Output{Stderr: tc.stderr, ExitCode: tc.exit}, nil
			}))
			_, err := s.Exec(context.Background(), absTmpRepo, "status")
			if err == nil {
				t.Fatal("exit≠0 인데 오류가 없다 — 조용히 낮췄다")
			}
			var ee *ExecError
			if !errors.As(err, &ee) {
				t.Fatalf("err %T, want *ExecError", err)
			}
			if ee.ExitCode != tc.exit || ee.Stderr != tc.stderr || ee.Cwd != absTmpRepo {
				t.Fatalf("ExecError = %+v", ee)
			}
			if tc.want == nil {
				if errors.Unwrap(err) != nil {
					t.Fatalf("분류 불가인데 Unwrap = %v", errors.Unwrap(err))
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

// 케이스 4 (V2, FR-GIT-8): PATH 에 git 이 없으면 ErrGitMissing. 실제 기본 Runner 경로다.
func TestExec_GitMissing(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	s := New()
	_, err := s.Exec(context.Background(), t.TempDir(), "rev-parse", "--show-toplevel")
	if !errors.Is(err, ErrGitMissing) {
		t.Fatalf("err = %v, want ErrGitMissing", err)
	}
	recs := s.Records(0)
	if len(recs) != 1 || recs[0].Err == "" || recs[0].ExitCode != -1 {
		t.Fatalf("git 없음도 기록에 남아야 한다: %+v", recs)
	}
}

// FR-GIT-2 의 전제: dir 은 절대경로여야 한다. 상대경로는 실행 위치에 따라 대상이
// 달라지므로 받지 않는다.
func TestExec_RejectsBadDir(t *testing.T) {
	for _, dir := range []string{"", "  ", "relative/path", "./x"} {
		s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
			t.Fatal("Runner 가 호출되면 안 된다")
			return Output{}, nil
		}))
		if _, err := s.Exec(context.Background(), dir, "status"); !errors.Is(err, ErrUnsafeArgument) {
			t.Fatalf("dir %q: err = %v, want ErrUnsafeArgument", dir, err)
		}
	}
}

// 케이스 8 (V15, FR-GIT-6): 상한을 넘은 출력은 잘리고 잘렸음이 표시된다.
func TestCappedBuffer_Truncates(t *testing.T) {
	b := &cappedBuffer{limit: 4}
	n, err := b.Write([]byte("abc"))
	if n != 3 || err != nil {
		t.Fatalf("Write = %d, %v", n, err)
	}
	// 짧은 쓰기를 보고하면 io.Copy 가 실패로 본다 — 버려도 전량을 썼다고 답한다.
	if n, err := b.Write([]byte("defgh")); n != 5 || err != nil {
		t.Fatalf("Write = %d, %v", n, err)
	}
	if got := b.String(); got != "abcd" {
		t.Fatalf("보존 %q, want %q", got, "abcd")
	}
	if !b.truncated {
		t.Fatal("truncated 가 서지 않았다")
	}
}

func TestExec_MaxOutputTruncates(t *testing.T) {
	if testing.Short() {
		t.Skip("실제 git 이 필요하다")
	}
	repo := tempRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "big.txt"), []byte(strings.Repeat("0123456789", 500)), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(gitPath(t), "add", "big.txt")
	cmd.Dir = repo
	if o, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, o)
	}

	s := New(WithMaxOutput(1024))
	out, err := s.Exec(context.Background(), repo, "show", ":big.txt")
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !out.StdoutTruncated {
		t.Fatal("StdoutTruncated 가 서지 않았다")
	}
	if len(out.Stdout) > 1024 {
		t.Fatalf("보존량 %d > 상한 1024", len(out.Stdout))
	}
	recs := s.Records(1)
	if len(recs) != 1 || !recs[0].StdoutTruncated || recs[0].StdoutBytes > 1024 {
		t.Fatalf("기록에 절단이 남지 않았다: %+v", recs)
	}
}

// 케이스 12 (V1, FR-GIT-2): 기본 Runner 는 셸을 경유하지 않는다. 위험한 인자는
// 해석되지 않고 그대로 git 에 전달되어 git 이 거부한다.
func TestExecGit_NoShell(t *testing.T) {
	if testing.Short() {
		t.Skip("실제 git 이 필요하다")
	}
	repo := tempRepo(t)
	marker := filepath.Join(repo, "pwned")
	s := New()
	arg := "$(touch " + marker + ");touch " + marker
	_, err := s.Exec(context.Background(), repo, "rev-parse", "--verify", arg)
	if err == nil {
		t.Fatal("git 이 이상 인자를 받아들였다")
	}
	var ee *ExecError
	if !errors.As(err, &ee) {
		t.Fatalf("err %T, want *ExecError", err)
	}
	if ee.Argv[2] != arg {
		t.Fatalf("argv[2] = %q, want %q — 인자가 변형됐다", ee.Argv[2], arg)
	}
	if _, serr := os.Stat(marker); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("셸이 인자를 해석했다 — %s 가 생겼다", marker)
	}
}

// FR-GIT-2/104: 기본 Runner 의 환경은 대화형 프롬프트·페이저를 끈다.
func TestExecGit_Environment(t *testing.T) {
	if testing.Short() {
		t.Skip("실제 git 이 필요하다")
	}
	repo := tempRepo(t)
	s := New()
	out, err := s.Exec(context.Background(), repo, "rev-parse", "--show-toplevel")
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if strings.TrimSpace(out.Stdout) != repo {
		t.Fatalf("toplevel %q, want %q", out.Stdout, repo)
	}
	if out.DurationMs < 0 {
		t.Fatalf("DurationMs = %d", out.DurationMs)
	}
}

// ── 소실 (GIT_REPO_MISSING_SRS FR-RMS-1·2·5, 검증 V-RMS-1·3) ──

// 작업 디렉터리가 없으면 ErrRepoMissing 이다. git 은 실행조차 되지 못했으므로
// 읽을 stderr 가 없다 — 판정은 chdir 의 ENOENT 로 한다 (D-RMS-1).
func TestExec_RepoMissing(t *testing.T) {
	gitPath(t)
	gone := filepath.Join(t.TempDir(), "gone")
	s := New()
	_, err := s.Exec(context.Background(), gone, "rev-parse", "--show-toplevel")
	if !errors.Is(err, ErrRepoMissing) {
		t.Fatalf("err = %v, want ErrRepoMissing", err)
	}
	// 사라진 경로가 사유에 실려야 한다 — 사용자가 어느 폴더인지 알아야 한다.
	if !strings.Contains(err.Error(), gone) {
		t.Fatalf("사유에 경로가 없다: %v", err)
	}
}

// FR-RMS-5: git 이 실행되어 stderr 로 실패한 것은 소실이 아니다. 여기가 넓어지면
// 오탐이 소실로 위장해 "사라졌다는 표시가 참인지" 판정할 수 없게 된다 (D-RMS-2).
func TestExec_RepoMissingDoesNotSwallowOtherFailures(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		exit   int
	}{
		{"권한 오류", "fatal: could not read Username for 'https://x': Permission denied\n", 128},
		{"손상된 .git", "fatal: not a git repository: '.git'\n", 128},
		{"알 수 없는 옵션", "error: unknown option `zz'\n", 129},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
				return Output{Stderr: tc.stderr, ExitCode: tc.exit}, nil
			}))
			_, err := s.Exec(context.Background(), absTmpRepo, "status")
			if errors.Is(err, ErrRepoMissing) {
				t.Fatalf("stderr 로 실패한 것을 소실로 승격했다: %v", err)
			}
		})
	}
}

// git 바이너리가 없는 것은 소실이 아니다 — 그것은 ErrGitMissing 의 몫이다.
// 둘 다 ENOENT 라 Op 로 좁히지 않으면 섞인다 (§2.2).
func TestExec_GitMissingIsNotRepoMissing(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	s := New()
	_, err := s.Exec(context.Background(), t.TempDir(), "rev-parse", "--show-toplevel")
	if errors.Is(err, ErrRepoMissing) {
		t.Fatalf("git 없음을 소실로 분류했다: %v", err)
	}
	if !errors.Is(err, ErrGitMissing) {
		t.Fatalf("err = %v, want ErrGitMissing", err)
	}
}
