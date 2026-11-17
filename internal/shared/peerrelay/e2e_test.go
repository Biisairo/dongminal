package peerrelay_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/peer"
	"dongminal/internal/shared/peerrelay"
)

func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "pe")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func identity(t *testing.T) peer.Identity {
	t.Helper()
	id, err := peer.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// relayNode 는 서버(노드 포트·발신 소켓)와 데몬(노드 소켓 위 노드 리스너) 한 쌍이다.
type relayNode struct {
	id     peer.Identity
	port   int
	dial   string
	remote chan string
}

func startRelayNode(t *testing.T, admit func(fp string) bool) *relayNode {
	t.Helper()
	dir := shortDir(t)
	n := &relayNode{
		id:     identity(t),
		dial:   filepath.Join(dir, peerrelay.DialSocketFile),
		remote: make(chan string, 4),
	}
	nodeSock := filepath.Join(dir, peerrelay.NodeSocketFile)

	// 데몬: 노드 소켓 위에서 TLS 를 끝내고 판정한다.
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.remote <- r.RemoteAddr
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	ln := peer.NewListener(n.id, peer.PeersOnly(admit), h)
	ln.UseListen(func(string, int) (net.Listener, error) { return peerrelay.ListenNode(nodeSock) })
	t.Cleanup(ln.Close)

	// 서버: 노드 포트와 발신 소켓. TLS 를 모른다.
	p := peerrelay.NewPort(nodeSock)
	t.Cleanup(p.Close)
	dl, err := peerrelay.ListenDial(n.dial)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dl.Close() })
	go peerrelay.ServeDial(dl)

	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	n.port = probe.Addr().(*net.TCPAddr).Port
	probe.Close()

	cfg := peer.Config{Enabled: true, Bind: "127.0.0.1", Port: n.port}
	ln.Apply(cfg)
	p.Apply(cfg.Enabled, cfg.Bind, cfg.Port)
	return n
}

// TC-PDM-2·3: A 의 데몬이 A 의 발신 소켓으로 나가고, B 의 노드 포트를 지나 B 의 데몬이
// TLS 를 끝낸다. 두 서버는 바이트만 옮긴다.
func TestRelayEndToEndTLS(t *testing.T) {
	a := identity(t)
	aFP := a.Fingerprint
	b := startRelayNode(t, func(fp string) bool { return fp == aFP })
	aDial := startRelayNode(t, func(string) bool { return false }).dial

	c := peer.NewClientVia(a, peerrelay.Dialer(aDial))
	target := peer.Target{Addr: "127.0.0.1", Port: b.port, Fingerprint: b.id.Fingerprint}
	var out struct {
		OK bool `json:"ok"`
	}
	if err := c.Call(context.Background(), target, "/peer/v1/node.info", map[string]any{}, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK {
		t.Fatal("handler did not answer")
	}
	if r := <-b.remote; r == "" {
		t.Fatal("daemon saw no remote address")
	}
}

// 짝이 아닌 노드는 B 의 데몬이 TLS 단계에서 거절한다.
func TestRelayEndToEndRejectsNonPeer(t *testing.T) {
	stranger := identity(t)
	b := startRelayNode(t, func(string) bool { return false })
	aDial := startRelayNode(t, func(string) bool { return false }).dial

	c := peer.NewClientVia(stranger, peerrelay.Dialer(aDial))
	target := peer.Target{Addr: "127.0.0.1", Port: b.port, Fingerprint: b.id.Fingerprint}
	err := c.Call(context.Background(), target, "/peer/v1/node.info", map[string]any{}, nil)
	if !errors.Is(err, peer.ErrRejected) {
		t.Fatalf("err = %v, want ErrRejected", err)
	}
}

// 지문 고정은 발신 소켓을 지나도 그대로다.
func TestRelayEndToEndFingerprintPinned(t *testing.T) {
	a := identity(t)
	aFP := a.Fingerprint
	b := startRelayNode(t, func(fp string) bool { return fp == aFP })
	aDial := startRelayNode(t, func(string) bool { return false }).dial

	c := peer.NewClientVia(a, peerrelay.Dialer(aDial))
	wrong := peer.Target{Addr: "127.0.0.1", Port: b.port, Fingerprint: identity(t).Fingerprint}
	err := c.Call(context.Background(), wrong, "/peer/v1/node.info", map[string]any{}, nil)
	if !errors.Is(err, peer.ErrFingerprintMismatch) {
		t.Fatalf("err = %v, want ErrFingerprintMismatch", err)
	}
}
