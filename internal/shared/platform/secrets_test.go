package platform

import (
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-2: 키체인 어댑터의 명령 인자와 종료 코드 해석.

type secCall struct {
	stdin string
	name  string
	args  []string
}

type fakeSec struct {
	calls []secCall
	out   []byte
	code  int
	err   error
}

func (f *fakeSec) run(stdin []byte, name string, args ...string) ([]byte, int, error) {
	f.calls = append(f.calls, secCall{string(stdin), name, append([]string(nil), args...)})
	return f.out, f.code, f.err
}

func newFakeKeychain(f *fakeSec, env map[string]string) macKeychain {
	return macKeychain{run: f.run, env: func(k string) string { return env[k] }, home: func() (string, error) { return "/Users/someone", nil }}
}

func TestKeychainGetFound(t *testing.T) {
	f := &fakeSec{out: []byte("{\"a\":1}\n")}
	k := newFakeKeychain(f, nil)
	v, ok, err := k.Get("svc", "acct")
	if err != nil || !ok || v != "{\"a\":1}" {
		t.Fatalf("got %q %v %v", v, ok, err)
	}
	want := []string{"find-generic-password", "-a", "acct", "-w", "-s", "svc"}
	if f.calls[0].name != keychainSecurityBin || strings.Join(f.calls[0].args, " ") != strings.Join(want, " ") {
		t.Fatalf("call %+v", f.calls[0])
	}
}

func TestKeychainGetStripsOnlyOneNewline(t *testing.T) {
	f := &fakeSec{out: []byte("x\n\n")}
	v, _, _ := newFakeKeychain(f, nil).Get("s", "a")
	if v != "x\n" {
		t.Fatalf("got %q", v)
	}
}

func TestKeychainGetNotFound(t *testing.T) {
	f := &fakeSec{code: keychainNotFound}
	_, ok, err := newFakeKeychain(f, nil).Get("s", "a")
	if ok || err != nil {
		t.Fatalf("not found must be (false, nil): %v %v", ok, err)
	}
}

func TestKeychainGetErrorHidesOutput(t *testing.T) {
	f := &fakeSec{code: 51, out: []byte("SECRET-VALUE")}
	_, _, err := newFakeKeychain(f, nil).Get("s", "a")
	if err == nil {
		t.Fatal("want error")
	}
	if strings.Contains(err.Error(), "SECRET-VALUE") {
		t.Fatalf("error leaks output: %v", err)
	}
}

func TestKeychainSetUsesStdin(t *testing.T) {
	f := &fakeSec{}
	if err := newFakeKeychain(f, nil).Set("Claude Code-credentials", "me", "tok\"en"); err != nil {
		t.Fatal(err)
	}
	c := f.calls[0]
	if strings.Join(c.args, " ") != "-i" {
		t.Fatalf("args %v", c.args)
	}
	want := `add-generic-password -U -a "me" -s "Claude Code-credentials" -X ` + hex.EncodeToString([]byte("tok\"en")) + "\n"
	if c.stdin != want {
		t.Fatalf("stdin %q want %q", c.stdin, want)
	}
	if strings.Contains(c.stdin, "tok\"en") {
		t.Fatal("value must be hex encoded")
	}
}

func TestKeychainSetQuotesEscapes(t *testing.T) {
	f := &fakeSec{}
	_ = newFakeKeychain(f, nil).Set(`s"v\c`, "a", "v")
	if !strings.Contains(f.calls[0].stdin, `-s "s\"v\\c"`) {
		t.Fatalf("stdin %q", f.calls[0].stdin)
	}
}

// 값을 argv 로 넘기면 같은 컴퓨터의 다른 사용자가 ps 로 볼 수 있다. 줄이 길면 쓰지 않고 실패로 돌려,
// 호출하는 쪽이 권한 600 파일로 내려가게 한다 (FR-CAC-4·6).
func TestKeychainSetLongRefusesArgv(t *testing.T) {
	f := &fakeSec{}
	long := strings.Repeat("x", keychainLineMax)
	if err := newFakeKeychain(f, nil).Set("s", "a", long); !errors.Is(err, ErrSecretTooLong) {
		t.Fatalf("err=%v", err)
	}
	if len(f.calls) != 0 {
		t.Fatalf("security 를 부르지 않는다: %+v", f.calls)
	}
}

func TestKeychainSetLineBoundary(t *testing.T) {
	// 줄 길이가 정확히 상한이면 표준 입력으로 보낸다.
	prefix := `add-generic-password -U -a "a" -s "s" -X `
	n := (keychainLineMax - len(prefix) - 1) / 2
	f := &fakeSec{}
	_ = newFakeKeychain(f, nil).Set("s", "a", strings.Repeat("y", n))
	if len(f.calls[0].stdin) > keychainLineMax || f.calls[0].args[0] != "-i" {
		t.Fatalf("len %d args %v", len(f.calls[0].stdin), f.calls[0].args)
	}
}

func TestKeychainSetFailure(t *testing.T) {
	f := &fakeSec{code: 1}
	if err := newFakeKeychain(f, nil).Set("s", "a", "v"); err == nil {
		t.Fatal("want error")
	}
	f = &fakeSec{err: errors.New("timeout")}
	if err := newFakeKeychain(f, nil).Set("s", "a", "v"); err == nil {
		t.Fatal("want error")
	}
}

func TestKeychainDelete(t *testing.T) {
	for _, code := range []int{0, keychainNotFound} {
		f := &fakeSec{code: code}
		if err := newFakeKeychain(f, nil).Delete("s", "a"); err != nil {
			t.Fatalf("code %d: %v", code, err)
		}
		if strings.Join(f.calls[0].args, " ") != "delete-generic-password -a a -s s" {
			t.Fatalf("args %v", f.calls[0].args)
		}
	}
	f := &fakeSec{code: 2}
	if err := newFakeKeychain(f, nil).Delete("s", "a"); err == nil {
		t.Fatal("want error")
	}
}

func TestKeychainAccount(t *testing.T) {
	if got := newFakeKeychain(&fakeSec{}, map[string]string{"USER": "alice"}).Account(); got != "alice" {
		t.Fatalf("got %q", got)
	}
	if got := newFakeKeychain(&fakeSec{}, nil).Account(); got != "someone" {
		t.Fatalf("got %q", got)
	}
	k := macKeychain{env: func(string) string { return "" }, home: func() (string, error) { return "", errors.New("x") }}
	if got := k.Account(); got != keychainDefaultAccount {
		t.Fatalf("got %q", got)
	}
}

func TestNoSecrets(t *testing.T) {
	var s Secrets = noSecrets{}
	if s.Available() {
		t.Fatal("must be unavailable")
	}
	if _, _, err := s.Get("s", "a"); !errors.Is(err, ErrSecretsUnavailable) {
		t.Fatalf("err %v", err)
	}
	if err := s.Set("s", "a", "v"); !errors.Is(err, ErrSecretsUnavailable) {
		t.Fatalf("err %v", err)
	}
	if err := s.Delete("s", "a"); err != nil {
		t.Fatalf("delete on unavailable is a no-op: %v", err)
	}
}
