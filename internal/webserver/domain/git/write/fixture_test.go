package write

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 실제 git 을 쓰는 테스트의 공용 픽스처다. core 의 같은 헬퍼를 복제한 것이며,
// 테스트 헬퍼는 패키지 경계를 넘지 못하므로 다른 길이 없다.

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
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull)
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

// gitRun 은 준비 단계의 git 이다. 이 패키지의 진입점을 쓰지 않는 이유는 준비에
// 필요한 명령(remote add·push)이 허용 목록에 없기 때문이다.
func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath(t), args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// writeFake 는 쓰기 실행기를 대신해 argv 와 stdin 을 모은다. core 의 같은 픽스처를
// 복제한 것이며, 테스트 헬퍼는 패키지 경계를 넘지 못한다.
type writeFake struct {
	argvs  [][]string
	stdins []string
	out    core.Output
	err    error
}

func (f *writeFake) runner(_ context.Context, _ string, args []string, stdin string) (core.Output, error) {
	f.argvs = append(f.argvs, append([]string(nil), args...))
	f.stdins = append(f.stdins, stdin)
	return f.out, f.err
}

// gitIn 은 준비 단계의 git 이다 — 허용 목록에 없는 명령까지 쓴다.
func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath(t), args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}
