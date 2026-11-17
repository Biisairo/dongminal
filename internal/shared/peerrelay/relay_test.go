package peerrelay

import (
	"bufio"
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// shortDir 는 유닉스 소켓 경로 상한(104바이트)을 넘지 않는 임시 폴더다. t.TempDir 은
// 시험 이름이 붙어 길다.
func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "pr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// echoOnce 는 ln 에서 연결 하나를 받아 한 줄을 읽고 그대로 돌려준다. 받은 연결의
// RemoteAddr 를 ch 로 보낸다.
func echoOnce(t *testing.T, ln net.Listener, remote chan<- string) {
	t.Helper()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		remote <- c.RemoteAddr().String()
		line, err := bufio.NewReader(c).ReadString('\n')
		if err != nil {
			return
		}
		_, _ = io.WriteString(c, line)
	}()
}

func roundTrip(t *testing.T, c net.Conn, msg string) string {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(c, msg+"\n"); err != nil {
		t.Fatal(err)
	}
	got, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSuffix(got, "\n")
}

// TC-PDM-2: 서버의 노드 포트는 받은 바이트를 노드 소켓으로 그대로 옮기고, 데몬은
// 프리앰블로 원래 출발지 주소를 받는다.
func TestPortForwardsToNodeSocket(t *testing.T) {
	sock := filepath.Join(shortDir(t), NodeSocketFile)
	node, err := ListenNode(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer node.Close()
	remote := make(chan string, 1)
	echoOnce(t, node, remote)

	p := NewPort(sock)
	defer p.Close()
	port := freePort(t)
	p.Apply(true, "127.0.0.1", port)
	if st := p.Status(); !st.Listening {
		t.Fatalf("status = %+v, want listening", st)
	}

	c, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if got := roundTrip(t, c, "hello"); got != "hello" {
		t.Fatalf("echo = %q", got)
	}
	select {
	case r := <-remote:
		if r != c.LocalAddr().String() {
			t.Fatalf("daemon RemoteAddr = %q, want client %q", r, c.LocalAddr())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no connection reached the node socket")
	}
}

// 프리앰블을 보내지 않는 연결 하나가 다른 연결의 Accept 를 막지 않는다.
func TestNodeListenerSlowPreambleDoesNotBlock(t *testing.T) {
	sock := filepath.Join(shortDir(t), NodeSocketFile)
	node, err := ListenNode(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer node.Close()

	stuck, err := platform.Current().IPC.Dial(sock, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer stuck.Close()

	good, err := platform.Current().IPC.Dial(sock, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer good.Close()
	if _, err := io.WriteString(good, preamble("10.0.0.9:4000")); err != nil {
		t.Fatal(err)
	}

	got := make(chan string, 1)
	go func() {
		c, err := node.Accept()
		if err == nil {
			got <- c.RemoteAddr().String()
		}
	}()
	select {
	case r := <-got:
		if r != "10.0.0.9:4000" {
			t.Fatalf("RemoteAddr = %q", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Accept blocked behind a connection without preamble")
	}
}

// 프리앰블이 틀린 연결은 Accept 로 나오지 않고 닫힌다.
func TestNodeListenerRejectsBadPreamble(t *testing.T) {
	sock := filepath.Join(shortDir(t), NodeSocketFile)
	node, err := ListenNode(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer node.Close()

	bad, err := platform.Current().IPC.Dial(sock, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer bad.Close()
	_, _ = io.WriteString(bad, "GET / HTTP/1.1\n")
	_ = bad.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := bad.Read(make([]byte, 1)); err == nil {
		t.Fatal("bad preamble connection stayed open")
	}

	accepted := make(chan struct{}, 1)
	go func() {
		if _, err := node.Accept(); err == nil {
			accepted <- struct{}{}
		}
	}()
	select {
	case <-accepted:
		t.Fatal("bad preamble connection was accepted")
	case <-time.After(300 * time.Millisecond):
	}
}

// 노드 소켓이 없으면(데몬이 안 떠 있음) 서버는 받은 연결을 바로 닫는다.
func TestPortClosesWhenNodeSocketMissing(t *testing.T) {
	sock := filepath.Join(shortDir(t), NodeSocketFile)
	p := NewPort(sock)
	defer p.Close()
	port := freePort(t)
	p.Apply(true, "127.0.0.1", port)

	c, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("connection stayed open without a node socket")
	}
}

// FR-PNW-4·8·9 의 생명주기를 그대로 지킨다.
func TestPortLifecycle(t *testing.T) {
	sock := filepath.Join(shortDir(t), NodeSocketFile)
	p := NewPort(sock)
	defer p.Close()

	port := freePort(t)
	p.Apply(false, "127.0.0.1", port)
	if p.Status().Listening {
		t.Fatal("disabled port is listening")
	}

	p.Apply(true, "127.0.0.1", port)
	g1 := p.Status().Generation
	p.Apply(true, "127.0.0.1", port)
	if p.Status().Generation != g1 {
		t.Fatal("same key reopened the port")
	}

	other := freePort(t)
	p.Apply(true, "127.0.0.1", other)
	if st := p.Status(); !st.Listening || !strings.HasSuffix(st.Addr, ":"+strconv.Itoa(other)) {
		t.Fatalf("status after port change = %+v", st)
	}

	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	p.Apply(true, "127.0.0.1", busy.Addr().(*net.TCPAddr).Port)
	if st := p.Status(); st.Listening || st.Err == "" {
		t.Fatalf("busy port status = %+v, want reason", st)
	}

	p.Apply(false, "127.0.0.1", port)
	if p.Status().Listening {
		t.Fatal("disable did not close")
	}
}

// TC-PDM-3: 발신 소켓으로 서버가 TCP 연결을 대신 열고 바이트를 잇는다.
func TestDialServiceConnects(t *testing.T) {
	sock := filepath.Join(shortDir(t), DialSocketFile)
	ln, err := ListenDial(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go ServeDial(ln)

	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	remote := make(chan string, 1)
	echoOnce(t, target, remote)

	c, err := Dialer(sock)(context.Background(), "tcp", target.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if got := roundTrip(t, c, "ping"); got != "ping" {
		t.Fatalf("echo = %q", got)
	}
}

// 상대에 닿지 못하면 Dialer 가 오류를 돌려준다.
func TestDialServiceUnreachable(t *testing.T) {
	sock := filepath.Join(shortDir(t), DialSocketFile)
	ln, err := ListenDial(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go ServeDial(ln)

	closed := freePort(t)
	_, err = Dialer(sock)(context.Background(), "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(closed)))
	if err == nil {
		t.Fatal("dial to a closed port succeeded")
	}
}

// 서버가 꺼져 있으면(발신 소켓 없음) 바로 실패한다 (FR-PDM-13).
func TestDialerWithoutServerFails(t *testing.T) {
	sock := filepath.Join(shortDir(t), DialSocketFile)
	start := time.Now()
	_, err := Dialer(sock)(context.Background(), "tcp", "127.0.0.1:1")
	if err == nil {
		t.Fatal("dial without server succeeded")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("dial without server took %s", time.Since(start))
	}
}

// 발신 소켓은 tcp 만 받는다.
func TestDialerRejectsNonTCP(t *testing.T) {
	sock := filepath.Join(shortDir(t), DialSocketFile)
	if _, err := Dialer(sock)(context.Background(), "unix", "/tmp/x"); err == nil {
		t.Fatal("non-tcp network accepted")
	}
}
