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
	"sync"
	"testing"

	"dongminal/internal/shared/platform"
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

// Counter 는 PATH 로 뜬 git 프로세스를 센다 (OPTIMIZE_REFACTOR_SRS FR-OPT-7-3).
//
// PATH 맨 앞에 진짜 git 을 부르는 얇은 스크립트를 두고, 스크립트가 argv 를 한 줄씩
// 기록한다. 셸 스크립트이므로 Windows 에서는 건너뛴다. PATH 를 바꾸므로 병렬
// 검사에서는 쓸 수 없다 (t.Setenv).
type Counter struct {
	log string
}

// Count 는 설치된 Counter 를 준다. 설치 뒤의 준비 단계(Run)도 세어지므로, 잴 호출
// 직전에 Reset 한다.
func Count(t testing.TB) *Counter {
	t.Helper()
	if platform.Current().OS == platform.Windows {
		t.Skip("git 계수는 셸 스크립트를 쓴다 — Windows 에서는 건너뛴다")
	}
	dir, err := countShim(Path(t))
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "calls.log")
	t.Setenv(countLogEnv, log)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &Counter{log: log}
}

// countLogEnv 는 계수 스크립트가 줄을 적을 파일이다 — 시험마다 다르다.
const countLogEnv = "DM_GITTEST_LOG"

// 계수 스크립트는 시험 실행(프로세스)마다 **한 번만** 만든다.
//
//	이전 동작: 시험마다 새 임시 폴더에 새 `git` 스크립트를 만들었다
//	새  동작: 한 번 만든 스크립트를 다시 쓰고, 기록 파일만 시험마다 환경 변수로 넘긴다
//	이유:     macOS 는 처음 보는 실행 파일을 띄울 때 보안 검사를 한다 — 실측 12초(두 번째는
//	          0.06초). 부하가 겹치면 git 의 30초 마감을 넘겨 시험이 흔들렸다
//	          (TestResolve_BatchesPaths · TestStashPopChecked_ThreeProcesses, 2026-11-22)
var (
	shimOnce sync.Once
	shimDir  string
	shimErr  error
)

func countShim(real string) (string, error) {
	shimOnce.Do(func() {
		shimDir, shimErr = os.MkdirTemp("", "dm-gittest-")
		if shimErr != nil {
			return
		}
		script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$" + countLogEnv + "\"\nexec '" + real + "' \"$@\"\n"
		shimErr = os.WriteFile(filepath.Join(shimDir, "git"), []byte(script), 0o755)
	})
	return shimDir, shimErr
}

// Calls 는 지금까지 뜬 git 의 argv 다 (공백으로 이은 한 줄씩).
func (c *Counter) Calls() []string {
	b, err := os.ReadFile(c.log)
	if err != nil {
		return nil
	}
	s := strings.TrimRight(string(b), "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// N 은 지금까지 뜬 git 프로세스 수다.
func (c *Counter) N() int { return len(c.Calls()) }

// Reset 은 셈을 0 으로 되돌린다.
func (c *Counter) Reset() { _ = os.Remove(c.log) }
