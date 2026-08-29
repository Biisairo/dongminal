package platform

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
)

// fakeEnv 는 표에 있는 키만 답하는 os.Getenv 대역이다.
func fakeEnv(kv map[string]string) envFn {
	return func(k string) string { return kv[k] }
}

// fakeStat 은 주어진 경로들만 존재하는 파일시스템 대역이다.
func fakeStat(exist ...string) statFn {
	return func(p string) error {
		if slices.Contains(exist, p) {
			return nil
		}
		return os.ErrNotExist
	}
}

func TestPosixShellPrefersSHELL(t *testing.T) {
	s := posixShell{
		env:  fakeEnv(map[string]string{"SHELL": "/usr/local/bin/fish"}),
		stat: fakeStat("/usr/local/bin/fish", "/bin/bash", "/bin/sh"),
	}
	spec := s.Shell("/home/u/.dongminal/bin")
	if spec.Path != "/usr/local/bin/fish" {
		t.Fatalf("Path = %q", spec.Path)
	}
	if !reflect.DeepEqual(spec.Args, []string{"-l"}) {
		t.Fatalf("Args = %v — 로그인 셸이어야 한다", spec.Args)
	}
	if !slices.Contains(spec.Env, "SHELL=/usr/local/bin/fish") {
		t.Fatalf("Env 에 SHELL 이 없다: %v", spec.Env)
	}
}

// $SHELL 이 가리키는 것이 **실재하지 않으면** 차선으로 내려가야 한다.
// 값이 있다는 이유로 그대로 쓰면 도구가 아예 뜨지 않는다.
func TestPosixShellFallsBackWhenSHELLMissing(t *testing.T) {
	s := posixShell{
		env:  fakeEnv(map[string]string{"SHELL": "/opt/removed/zsh"}),
		stat: fakeStat("/bin/bash", "/bin/sh"),
	}
	if got := s.Shell("/b").Path; got != "/bin/bash" {
		t.Fatalf("Path = %q, want /bin/bash", got)
	}
}

func TestPosixShellFallsBackToSh(t *testing.T) {
	s := posixShell{env: fakeEnv(nil), stat: fakeStat("/bin/sh")}
	if got := s.Shell("/b").Path; got != "/bin/sh" {
		t.Fatalf("Path = %q, want /bin/sh", got)
	}
}

// 아무것도 못 찾아도 무언가는 시도해야 한다 — 빈 Path 는 곧바로 기동 실패다.
func TestPosixShellNeverReturnsEmpty(t *testing.T) {
	s := posixShell{env: fakeEnv(nil), stat: fakeStat()}
	if got := s.Shell("/b").Path; got == "" {
		t.Fatal("Path 가 비었다")
	}
}

// 셸마다 rc 를 읽는 변수가 다르다. 잘못 주입하면 훅이 조용히 안 걸린다.
func TestPosixShellHookEnv(t *testing.T) {
	bin := filepath.Join("/home", "u", "bin")
	cases := []struct {
		shell string
		want  string
	}{
		{"/bin/zsh", "ZDOTDIR=" + filepath.Join(bin, "zdotdir")},
		{"/bin/bash", "BASH_ENV=" + filepath.Join(bin, "bash-hook.sh")},
	}
	for _, tc := range cases {
		t.Run(tc.shell, func(t *testing.T) {
			s := posixShell{env: fakeEnv(map[string]string{"SHELL": tc.shell}), stat: fakeStat(tc.shell)}
			if env := s.Shell(bin).Env; !slices.Contains(env, tc.want) {
				t.Fatalf("Env 에 %q 가 없다: %v", tc.want, env)
			}
		})
	}
}

// fish 처럼 훅을 모르는 셸에는 훅 변수를 주지 않는다 — 엉뚱한 변수를 심으면
// 그 셸이 시작 시 오류를 낸다.
func TestPosixShellNoHookForUnknownShell(t *testing.T) {
	s := posixShell{env: fakeEnv(map[string]string{"SHELL": "/bin/fish"}), stat: fakeStat("/bin/fish")}
	for _, e := range s.Shell("/b").Env {
		if len(e) > 8 && (e[:8] == "ZDOTDIR=" || e[:9] == "BASH_ENV=") {
			t.Fatalf("fish 에 훅 변수가 붙었다: %q", e)
		}
	}
}

func TestPosixHookRoot(t *testing.T) {
	if got := (posixShell{}).HookRoot(); got != PosixHookRoot {
		t.Fatalf("HookRoot = %q", got)
	}
}

// ── windows ──────────────────────────────────────────

func TestWindowsShellPrefersPwsh(t *testing.T) {
	s := windowsShell{env: fakeEnv(nil), look: fakeLook("pwsh.exe", "powershell.exe", "cmd.exe")}
	spec := s.Shell(`C:\home\bin`)
	if spec.Path != "/usr/bin/pwsh.exe" {
		t.Fatalf("Path = %q", spec.Path)
	}
	want := filepath.Join(`C:\home\bin`, PowerShellHookFile)
	if !slices.Contains(spec.Args, want) {
		t.Fatalf("훅 스크립트가 인자에 없다: %v", spec.Args)
	}
	if !slices.Contains(spec.Args, "-NoExit") {
		t.Fatalf("-NoExit 이 없다 — 훅 실행 후 셸이 즉시 끝난다: %v", spec.Args)
	}
}

func TestWindowsShellHonorsOverride(t *testing.T) {
	s := windowsShell{
		env:  fakeEnv(map[string]string{"DONGMINAL_SHELL": `C:\nu\nu.exe`}),
		look: fakeLook("pwsh.exe"),
	}
	if got := s.Shell(`C:\b`).Path; got != `C:\nu\nu.exe` {
		t.Fatalf("Path = %q — 사용자 지정이 우선이어야 한다", got)
	}
}

// cmd.exe 에는 프롬프트 후크 자리가 없다. 훅 인자를 붙이면 그대로 실행돼
// 오류만 낸다 — 인자 없이 띄우고 훅 기능만 포기한다 (FR-XSH-3).
func TestWindowsShellCmdGetsNoHook(t *testing.T) {
	s := windowsShell{env: fakeEnv(nil), look: fakeLook("cmd.exe")}
	spec := s.Shell(`C:\b`)
	if spec.Path != "/usr/bin/cmd.exe" {
		t.Fatalf("Path = %q", spec.Path)
	}
	if len(spec.Args) != 0 {
		t.Fatalf("cmd.exe 에 인자가 붙었다: %v", spec.Args)
	}
}

// 아무것도 못 찾아도 빈 Path 를 내지 않는다.
func TestWindowsShellNeverReturnsEmpty(t *testing.T) {
	s := windowsShell{env: fakeEnv(nil), look: fakeLook()}
	if got := s.Shell(`C:\b`).Path; got == "" {
		t.Fatal("Path 가 비었다")
	}
}

func TestWindowsHookRoot(t *testing.T) {
	if got := (windowsShell{}).HookRoot(); got != WindowsHookRoot {
		t.Fatalf("HookRoot = %q", got)
	}
}
