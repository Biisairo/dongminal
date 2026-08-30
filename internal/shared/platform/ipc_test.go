package platform

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testIPC() unixSocketIPC { return unixSocketIPC{isSocket: posixIsSocket} }

func TestIPCEndpointIsUnderHome(t *testing.T) {
	home := t.TempDir()
	if got := testIPC().Endpoint(home); got != filepath.Join(home, SocketFileName) {
		t.Fatalf("Endpoint = %q", got)
	}
}

// Listen → Dial → 왕복 → Remove 를 한 번에 확인한다.
func TestIPCRoundTrip(t *testing.T) {
	ep := testIPC().Endpoint(t.TempDir())
	i := testIPC()

	if i.Exists(ep) {
		t.Fatal("아직 없는 종단이 있다고 한다")
	}
	ln, err := i.Listen(ep)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()
	if !i.Exists(ep) {
		t.Fatal("만든 종단을 못 본다")
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 4)
		n, _ := c.Read(buf)
		c.Write(buf[:n])
	}()

	conn, err := i.Dial(ep, 2*time.Second)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	buf := make([]byte, 4)
	if _, err := conn.Read(buf); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(buf) != "ping" {
		t.Fatalf("왕복 = %q", buf)
	}
	<-done

	ln.Close()
	if err := i.Remove(ep); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if i.Exists(ep) {
		t.Fatal("지운 종단이 남아 있다")
	}
}

// 없는 종단을 지우는 것은 오류가 아니다 — 잔여물 정리는 멱등이어야 한다.
func TestIPCRemoveMissingIsOK(t *testing.T) {
	if err := testIPC().Remove(filepath.Join(t.TempDir(), "nope.sock")); err != nil {
		t.Fatalf("Remove: %v", err)
	}
}

// 평범한 파일은 종단이 아니다. POSIX 판정이 이것을 가르지 못하면 낡은
// 파일 하나로 데몬이 살아 있다고 오판한다.
func TestIPCExistsRejectsPlainFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "plain")
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if testIPC().Exists(p) {
		t.Fatal("평범한 파일을 종단으로 봤다")
	}
	// Windows 판정은 존재만 본다 — AF_UNIX 종단에 소켓 비트가 없기 때문이다.
	if !(unixSocketIPC{isSocket: windowsIsSocket}).Exists(p) {
		t.Fatal("Windows 판정이 존재하는 파일을 못 봤다")
	}
}

var _ net.Listener = (net.Listener)(nil)
