package platform

import (
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// bash 훅은 인자로 건다 (HOST_PARITY_SRS 묶음 C).
//
// 종전에는 `BASH_ENV` 로 걸었는데 그것은 **비대화형 셸만** 읽는다. 도구 셸은
// 대화형이므로 훅이 아예 로드되지 않았고, 그래서 Linux 기본 환경에서 `claude`
// 래퍼·cwd 보고·`open` 가로채기가 전부 죽어 있었다 (§2.3).

func TestPosixShellBashUsesRcfile(t *testing.T) {
	// V-HPR-4
	bin := filepath.Join("/home", "u", "bin")
	s := posixShell{env: fakeEnv(map[string]string{"SHELL": "/bin/bash"}), stat: fakeStat("/bin/bash")}
	spec := s.Shell(bin)

	want := []string{"--rcfile", filepath.Join(bin, "bash-hook.sh")}
	if !reflect.DeepEqual(spec.Args, want) {
		t.Fatalf("Args = %v, want %v", spec.Args, want)
	}
	// `-l` 과 함께 쓸 수 없다 — bash 는 로그인 셸에서 --rcfile 을 읽지 않는다.
	if slices.Contains(spec.Args, "-l") {
		t.Error("로그인 셸이면 --rcfile 이 무시된다")
	}
	for _, e := range spec.Env {
		if strings.HasPrefix(e, "BASH_ENV=") {
			t.Errorf("BASH_ENV 가 남아 있다: %q — 대화형 셸은 읽지 않는다", e)
		}
	}
	// 셸이 바뀌어도 공통 환경은 그대로다.
	if !slices.Contains(spec.Env, "SHELL=/bin/bash") {
		t.Errorf("SHELL 이 없다: %v", spec.Env)
	}
}

// V-HPR-4 의 나머지 절반: zsh 는 한 글자도 바뀌지 않는다 (FR-HPR-9).
func TestPosixShellZshUnchanged(t *testing.T) {
	bin := filepath.Join("/home", "u", "bin")
	s := posixShell{env: fakeEnv(map[string]string{"SHELL": "/bin/zsh"}), stat: fakeStat("/bin/zsh")}
	spec := s.Shell(bin)

	if !reflect.DeepEqual(spec.Args, []string{"-l"}) {
		t.Fatalf("Args = %v — zsh 는 로그인 셸 그대로다", spec.Args)
	}
	if !slices.Contains(spec.Env, "ZDOTDIR="+filepath.Join(bin, "zdotdir")) {
		t.Fatalf("ZDOTDIR 이 없다: %v", spec.Env)
	}
}
