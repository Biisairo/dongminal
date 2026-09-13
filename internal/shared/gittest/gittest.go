// Package gittest 는 Go 테스트의 git 저장소 픽스처 한 벌이다 (M8 D-A-20, TEST-23).
//
// 종전에는 `init -b main` + `user.*` + 첫 커밋 블록이 일곱 패키지에 복제돼 있었고,
// 그중 넷만 전역·시스템 gitconfig 를 차단했다 — 호스트의 `commit.gpgsign`·
// `init.templateDir` 이 새어 들어오는 자리가 셋 남아 있었다. `testpath` 와 같은
// "테스트 전용 shared" 이며 제품 코드는 import 하지 않는다.
package gittest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Path 는 git 실행 파일이다. 없으면 검사를 건너뛴다 — 없는 git 은 결함이 아니라
// 환경이다.
func Path(t testing.TB) string {
	t.Helper()
	p, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git 이 없다 — 이 검사를 건너뛴다")
	}
	return p
}

// Run 은 준비 단계의 git 이다 — 전역·시스템 gitconfig 를 차단하고, 실패는 곧
// 검사 실패다. 다듬은 stdout+stderr 를 돌려준다.
func Run(t testing.TB, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(Path(t), args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// Init 은 `main` 브랜치의 빈 저장소다. 심볼릭 링크를 푸는 이유는 git 이 toplevel 을
// 물리 경로로 답하기 때문이다 (macOS 의 /var → /private/var).
func Init(t testing.TB) string {
	t.Helper()
	Path(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	Run(t, dir, "init", "-b", "main")
	Run(t, dir, "config", "user.email", "t@example.com")
	Run(t, dir, "config", "user.name", "tester")
	return dir
}

// Repo 는 커밋 하나(README.md)를 가진 임시 저장소다.
func Repo(t testing.TB) string {
	t.Helper()
	dir := Init(t)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	Run(t, dir, "add", ".")
	Run(t, dir, "commit", "-m", "init")
	return dir
}
