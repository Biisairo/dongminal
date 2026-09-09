//go:build !windows

package runtime

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// bash-hook.sh 는 자기 훅을 걸기 전에 사용자 rc 를 되살린다
// (HOST_PARITY_SRS FR-HPR-8). `--rcfile` 은 로그인 셸과 함께 쓸 수 없으므로,
// 로그인 셸이 읽던 것을 훅이 같은 순서로 대신 읽어야 한다.

func TestBashHookSourcesUserRcBeforeHooks(t *testing.T) {
	// V-HPR-5: 골든 — 순서가 뜻이다.
	bin := t.TempDir()
	if err := installShellHooks(bin); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(filepath.Join(bin, "bash-hook.sh"))
	if err != nil {
		t.Skip("이 호스트의 훅 루트는 posix 가 아니다")
	}
	src := string(blob)

	order := []string{"/etc/profile", ".bash_profile", ".bashrc", "_rt_cwd_hook", "claude()"}
	at := -1
	for _, needle := range order {
		i := strings.Index(src, needle)
		if i < 0 {
			t.Fatalf("bash-hook.sh 에 %q 가 없다", needle)
		}
		if i < at {
			t.Fatalf("%q 가 앞선 항목보다 먼저 나온다 — 순서가 뜻이다", needle)
		}
		at = i
	}
}

// V-HPR-6: 실기 bash 로 훅이 실제 로드되는지 본다. 이 검사가 종전 배선
// (`BASH_ENV`)에서는 실패한다 — 그것이 이 묶음의 존재 이유다.
func TestBashHookLoadsInInteractiveShell(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash 가 없다")
	}
	bin := t.TempDir()
	if err := installShellHooks(bin); err != nil {
		t.Fatal(err)
	}
	hook := filepath.Join(bin, "bash-hook.sh")
	if _, err := os.Stat(hook); err != nil {
		t.Skip("이 호스트의 훅 루트는 posix 가 아니다")
	}

	// 사용자 홈을 빈 곳으로 돌린다 — 개발 호스트의 rc 가 결과를 흔들면 안 된다.
	home := t.TempDir()
	cmd := exec.Command(bash, "--rcfile", hook, "-i", "-c", "type -t claude; type -t _rt_cwd_hook")
	cmd.Env = append(os.Environ(), "HOME="+home, "DONGMINAL_HOME="+filepath.Dir(bin))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("bash: %v\n%s", err, out)
	}
	// `type -t` 는 정의된 함수마다 "function" 한 줄을 낸다. 둘 다 서야 한다 —
	// 하나만 서면 훅이 중간에 끊긴 것이다.
	if got := strings.Count(string(out), "function"); got != 2 {
		t.Fatalf("claude·_rt_cwd_hook 이 모두 정의되지 않았다 (function %d줄):\n%s", got, out)
	}
}

// 사용자 rc 가 깨져 있어도 셸은 뜨고 훅은 걸린다 (FR-HPR-10).
func TestBashHookSurvivesBrokenUserRc(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash 가 없다")
	}
	bin := t.TempDir()
	if err := installShellHooks(bin); err != nil {
		t.Fatal(err)
	}
	hook := filepath.Join(bin, "bash-hook.sh")
	if _, err := os.Stat(hook); err != nil {
		t.Skip("이 호스트의 훅 루트는 posix 가 아니다")
	}
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte("this-command-does-not-exist\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bash, "--rcfile", hook, "-i", "-c", "type -t claude")
	cmd.Env = append(os.Environ(), "HOME="+home, "DONGMINAL_HOME="+filepath.Dir(bin))
	out, _ := cmd.CombinedOutput()
	if !strings.Contains(string(out), "function") {
		t.Fatalf("깨진 rc 가 훅을 막았다:\n%s", out)
	}
}
