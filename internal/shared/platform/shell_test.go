package platform

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
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
	want := dotSource(filepath.Join(`C:\home\bin`, PowerShellHookFile))
	if !slices.Contains(spec.Args, want) {
		t.Fatalf("훅 닷소싱이 인자에 없다: %v", spec.Args)
	}
	if !slices.Contains(spec.Args, "-NoExit") {
		t.Fatalf("-NoExit 이 없다 — 훅 실행 후 셸이 즉시 끝난다: %v", spec.Args)
	}
	// -File 은 쓰지 않는다 (dotSource 주석).
	if slices.Contains(spec.Args, "-File") {
		t.Fatalf("-File 을 쓰고 있다 — 대화형 유지가 불확실하다: %v", spec.Args)
	}
}

// 경로에 아포스트로피가 있어도 문자열이 깨지지 않아야 한다. 깨지면 PowerShell
// 이 구문 오류를 내고 훅이 통째로 실행되지 않는다.
func TestDotSourceEscapesQuote(t *testing.T) {
	got := dotSource(`C:\Users\O'Brien\bin\hook.ps1`)
	want := `. 'C:\Users\O''Brien\bin\hook.ps1'`
	if got != want {
		t.Fatalf("dotSource = %s, want %s", got, want)
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

// ── 인용 ─────────────────────────────────────────────

// 두 셸의 인용법은 **서로 호환되지 않는다**. 홑따옴표 안의 홑따옴표를 POSIX 는
// 닫았다 이스케이프하고 다시 열지만, PowerShell 은 겹쳐 쓴다. 한쪽 규칙을 다른
// 셸에 그대로 쓰면 문자열이 닫히지 않아 명령 전체가 깨진다 — 프롬프트에
// 아포스트로피가 하나만 있어도 그렇다.
func TestShellQuoteEscapesApostrophe(t *testing.T) {
	const in = `it's "quoted" $HOME`
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"posix", posixShell{}.Quote(in), `'it'\''s "quoted" $HOME'`},
		{"windows", windowsShell{}.Quote(in), `'it''s "quoted" $HOME'`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Fatalf("Quote = %s, want %s", tc.got, tc.want)
			}
		})
	}
}

// 훅 닷소싱과 기동줄 인용이 **한 구현**을 쓰는지 본다. 두 벌로 두면 한쪽만
// 고쳐도 컴파일이 통과하고, 그때 아포스트로피가 든 경로에서 조용히 갈린다.
func TestDotSourceUsesTheWindowsQuoting(t *testing.T) {
	const p = `C:\Users\O'Brien\bin\hook.ps1`
	if got, want := dotSource(p), ". "+(windowsShell{}).Quote(p); got != want {
		t.Fatalf("dotSource = %s, want %s", got, want)
	}
}

// 성질 검사 — 인용된 문자열을 **그 셸의 파서**로 되돌리면 원본이 나와야 한다.
// unquote* 는 생성기가 아니라 파서 쪽 규칙을 따로 옮긴 것이라 동어반복이 아니다.
func TestShellQuoteRoundTrips(t *testing.T) {
	inputs := []string{
		"",
		"plain",
		"it's",
		"'",
		"''",
		`a'b'c`,
		"여러\n줄",
		"$HOME `date` \"q\" \\ *",
		`C:\Users\O'Brien\bin`,
	}
	for _, in := range inputs {
		t.Run(in, func(t *testing.T) {
			if got, ok := unquotePosix(posixShell{}.Quote(in)); !ok || got != in {
				t.Fatalf("posix 왕복 실패: %q → %s → %q (ok=%v)", in, posixShell{}.Quote(in), got, ok)
			}
			if got, ok := unquotePowerShell(windowsShell{}.Quote(in)); !ok || got != in {
				t.Fatalf("windows 왕복 실패: %q → %s → %q (ok=%v)", in, windowsShell{}.Quote(in), got, ok)
			}
		})
	}
}

// 규칙을 바꿔치면 실제로 깨진다는 것을 못박는다. 이것이 성립하지 않으면 위
// 왕복 검사는 아무것도 증명하지 못한다 (파서가 뭐든 받아들인다는 뜻이므로).
func TestShellQuoteRulesAreNotInterchangeable(t *testing.T) {
	const in = "it's"
	if _, ok := unquotePowerShell(posixShell{}.Quote(in)); ok {
		t.Fatal("POSIX 인용이 PowerShell 파서를 통과했다 — 파서가 너무 관대하다")
	}
	if got, ok := unquotePosix(windowsShell{}.Quote(in)); ok && got == in {
		t.Fatal("PowerShell 인용이 POSIX 에서 원본으로 되돌아왔다")
	}
}

// unquotePosix 는 sh 의 인용 해제 규칙이다. 홑따옴표 리터럴과 역슬래시 이스케이프가
// 이어 붙은 형태만 받아들인다 — 인용 밖에 맨 문자가 남아 있으면 그것은 전개될 수
// 있다는 뜻이므로 실패로 본다.
func unquotePosix(s string) (string, bool) {
	var out strings.Builder
	for i := 0; i < len(s); {
		switch s[i] {
		case '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return "", false // 닫히지 않았다
			}
			out.WriteString(s[i+1 : i+1+j])
			i += j + 2
		case '\\':
			if i+1 >= len(s) {
				return "", false
			}
			out.WriteByte(s[i+1])
			i += 2
		default:
			return "", false // 보호되지 않은 문자
		}
	}
	return out.String(), true
}

// unquotePowerShell 은 축자 문자열('...')의 해제 규칙이다. 안쪽 홑따옴표는 반드시
// 짝을 이뤄야 하며, 홀수로 나타나면 문자열이 거기서 닫힌 것이다.
func unquotePowerShell(s string) (string, bool) {
	if len(s) < 2 || s[0] != '\'' || s[len(s)-1] != '\'' {
		return "", false
	}
	body := s[1 : len(s)-1]
	var out strings.Builder
	for i := 0; i < len(body); i++ {
		if body[i] != '\'' {
			out.WriteByte(body[i])
			continue
		}
		if i+1 >= len(body) || body[i+1] != '\'' {
			return "", false
		}
		out.WriteByte('\'')
		i++
	}
	return out.String(), true
}
