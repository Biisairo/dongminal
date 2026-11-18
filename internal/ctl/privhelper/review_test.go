package privhelper

import (
	"bytes"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/humancmd"
	"dongminal/internal/shared/platform"
)

// PEER_CHAT_SRS §3.12a — 독립 리뷰 수정.

func testEnv(t *testing.T, uid int, launch error) (installEnv, *bytes.Buffer) {
	t.Helper()
	d := shortDir(t)
	self := filepath.Join(d, "self")
	if err := os.WriteFile(self, []byte("new-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	return installEnv{
		uid: uid, user: "u", self: self,
		binDir: filepath.Join(d, "PrivilegedHelperTools"), bin: filepath.Join(d, "PrivilegedHelperTools", "h"),
		plist: filepath.Join(d, "h.plist"), secret: filepath.Join(d, "sec", "secret.json"),
		out: out, errw: &bytes.Buffer{},
		own:      func(string) error { return nil },
		launch:   func() error { return launch },
		nopasswd: func() bool { return false },
	}, out
}

// R-1: 처음 설치에서 launchctl 이 실패해도 비밀은 이미 보였다. R-8: 프로그램 폴더가 없으면 만든다.
func TestInstallShowsSecretBeforeLaunch(t *testing.T) {
	e, out := testEnv(t, 501, errors.New("bootstrap failed"))
	if err := runInstall(e); err == nil {
		t.Fatal("launchctl 실패를 숨겼다")
	}
	sec, err := loadSecret(e.secret)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), groupBy4(sec.TOTP)) {
		t.Fatalf("비밀이 보이지 않았다:\n%s", out.String())
	}
	if _, err := os.Stat(e.bin); err != nil {
		t.Fatalf("폴더를 만들어 복사하지 않았다: %v", err)
	}
}

// R-8: 다른 사용자로 등록되어 있으면 프로그램을 바꾸기 전에 멈춘다.
func TestInstallOtherUserKeepsBinary(t *testing.T) {
	e, _ := testEnv(t, 501, nil)
	if err := runInstall(e); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(e.bin, []byte("installed"), 0o755); err != nil {
		t.Fatal(err)
	}
	e.uid = 502
	if err := runInstall(e); err == nil {
		t.Fatal("다른 사용자의 설치를 받았다")
	}
	if raw, _ := os.ReadFile(e.bin); string(raw) != "installed" {
		t.Fatalf("확인 전에 프로그램을 덮어썼다: %q", raw)
	}
}

// R-5: 복구 코드는 맞는데 저장이 실패하면 unavailable 이고 틀린 횟수에 넣지 않는다.
func TestRecoverySaveFailureNotCounted(t *testing.T) {
	s, codes := testSecret(t)
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	g, err := newGuard(&s, c.now, func(Secret) error { return errors.New("disk full") })
	if err != nil {
		t.Fatal(err)
	}
	for i := range maxFails + 1 {
		if got := codeOf(g.check(codes[0])); got != humancmd.CodeUnavailable {
			t.Fatalf("%d번째 = %q, unavailable 을 기대", i+1, got)
		}
	}
	if !g.lockedUntil().IsZero() {
		t.Fatal("저장 실패로 잠겼다")
	}
}

// R-4: 복구 코드 서명과 info 가 동시에 와도 경합이 없다(-race).
func TestServerConcurrentRecovery(t *testing.T) {
	s, codes := testSecret(t)
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	srv, err := NewServer(&s, c.now, func(Secret) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	srv.peerUID = func(net.Conn) (int, error) { return os.Getuid(), nil }
	path := filepath.Join(shortDir(t), "h.sock")
	ln, err := platform.Current().IPC.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go srv.Serve(ln)
	cl := humancmd.Client{Path: path, Timeout: 2 * time.Second}
	var wg sync.WaitGroup
	for _, code := range codes {
		wg.Add(2)
		go func() { defer wg.Done(); _, _ = cl.Sign(code, killReq()) }()
		go func() { defer wg.Done(); _, _ = cl.Info() }()
	}
	wg.Wait()
}
