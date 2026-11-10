package peer

import (
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// listenerFixture 는 노드 리스너 하나와 그 앞에 선 클라이언트 신원 둘이다.
type listenerFixture struct {
	ln       *Listener
	peerID   Identity // 짝으로 등록된 클라이언트
	strange  Identity // 짝이 아닌 클라이언트
	handled  atomic.Int64
	peerFP   string
	serverFP string
	server   Identity
	handler  http.Handler
}

func newListenerFixture(t *testing.T) *listenerFixture {
	t.Helper()
	server, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &listenerFixture{serverFP: server.Fingerprint, server: server}
	f.peerID, err = LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f.strange, err = LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f.peerFP = f.peerID.Fingerprint
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.handled.Add(1)
		w.WriteHeader(http.StatusNoContent)
	})
	f.handler = h
	f.ln = NewListener(server, PeersOnly(func(fp string) bool { return fp == f.peerFP }), h)
	t.Cleanup(f.ln.Close)
	return f
}

// freePort 는 지금 비어 있는 loopback 포트 하나다.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return p
}

func enabledAt(port int) Config {
	return Config{Enabled: true, Bind: "127.0.0.1", Port: port}
}

// clientFor 는 서버 지문을 고정해 확인하는 클라이언트다. 노드 인증서는 자기 서명이라
// 체인 검증 대신 지문을 대조한다 (D-3).
func (f *listenerFixture) clientFor(id *Identity, maxVer uint16) *http.Client {
	cfg := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, //nolint:gosec // 체인 대신 VerifyConnection 이 지문을 대조한다
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 || FingerprintOf(cs.PeerCertificates[0]) != f.serverFP {
				return errors.New("서버 지문 불일치")
			}
			return nil
		},
	}
	if maxVer != 0 {
		cfg.MaxVersion = maxVer
	}
	if id != nil {
		cfg.Certificates = []tls.Certificate{id.Certificate}
	}
	return &http.Client{
		Timeout:   3 * time.Second,
		Transport: &http.Transport{TLSClientConfig: cfg, DisableKeepAlives: true},
	}
}

func get(c *http.Client, addr, path string) (int, error) {
	resp, err := c.Get("https://" + addr + path)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

func dialable(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// FR-PNW-4 · NFR-PNW-1: 꺼져 있으면 아무것도 듣지 않는다.
func TestListenerDisabledDoesNotListen(t *testing.T) {
	f := newListenerFixture(t)
	port := freePort(t)
	f.ln.Apply(Config{Enabled: false, Bind: "127.0.0.1", Port: port})
	st := f.ln.Status()
	if st.Listening || st.Err != "" {
		t.Fatalf("꺼짐인데 상태가 %+v", st)
	}
	if dialable(net.JoinHostPort("127.0.0.1", strconv.Itoa(port))) {
		t.Fatal("꺼짐인데 포트가 열려 있다")
	}
}

// FR-PNW-5 · FR-PNW-41: 짝의 인증서면 핸들러까지 닿는다.
func TestListenerServesPeer(t *testing.T) {
	f := newListenerFixture(t)
	f.ln.Apply(enabledAt(freePort(t)))
	st := f.ln.Status()
	if !st.Listening {
		t.Fatalf("켜짐인데 듣지 않는다: %+v", st)
	}
	code, err := get(f.clientFor(&f.peerID, 0), st.Addr, "/peer/v1/x")
	if err != nil || code != http.StatusNoContent {
		t.Fatalf("짝의 요청: code=%d err=%v", code, err)
	}
}

// FR-PNW-5: 클라이언트 인증서가 없으면 끊는다.
func TestListenerRequiresClientCert(t *testing.T) {
	f := newListenerFixture(t)
	f.ln.Apply(enabledAt(freePort(t)))
	if _, err := get(f.clientFor(nil, 0), f.ln.Status().Addr, "/peer/v1/x"); err == nil {
		t.Fatal("인증서 없는 요청이 통과했다")
	}
	if f.handled.Load() != 0 {
		t.Fatal("핸들러에 닿았다")
	}
}

// FR-PNW-41: 짝이 아닌 지문은 TLS 단계에서 끊는다.
func TestListenerRejectsNonPeer(t *testing.T) {
	f := newListenerFixture(t)
	f.ln.Apply(enabledAt(freePort(t)))
	if _, err := get(f.clientFor(&f.strange, 0), f.ln.Status().Addr, "/peer/v1/x"); err == nil {
		t.Fatal("짝이 아닌 인증서가 통과했다")
	}
	if f.handled.Load() != 0 {
		t.Fatal("핸들러에 닿았다")
	}
}

// FR-PNW-5: TLS 1.3 만 받는다.
func TestListenerRejectsTLS12(t *testing.T) {
	f := newListenerFixture(t)
	f.ln.Apply(enabledAt(freePort(t)))
	if _, err := get(f.clientFor(&f.peerID, tls.VersionTLS12), f.ln.Status().Addr, "/peer/v1/x"); err == nil {
		t.Fatal("TLS 1.2 가 통과했다")
	}
}

// FR-PNW-8: 포트가 바뀌면 다시 연다 — 옛 포트는 닫힌다.
func TestListenerReappliesOnPortChange(t *testing.T) {
	f := newListenerFixture(t)
	a, b := freePort(t), freePort(t)
	f.ln.Apply(enabledAt(a))
	oldAddr := f.ln.Status().Addr
	f.ln.Apply(enabledAt(b))
	st := f.ln.Status()
	if !st.Listening || st.Addr == oldAddr {
		t.Fatalf("다시 열지 않았다: %+v (옛 %s)", st, oldAddr)
	}
	if dialable(oldAddr) {
		t.Fatal("옛 포트가 열려 있다")
	}
	if code, err := get(f.clientFor(&f.peerID, 0), st.Addr, "/peer/v1/x"); err != nil || code != http.StatusNoContent {
		t.Fatalf("새 포트: code=%d err=%v", code, err)
	}
}

// 같은 값이면 리스너를 건드리지 않는다.
func TestListenerApplySameKeeps(t *testing.T) {
	f := newListenerFixture(t)
	cfg := enabledAt(freePort(t))
	f.ln.Apply(cfg)
	before := f.ln.Status()
	cfg.Name = "renamed"
	cfg.Peers = []Peer{{Name: "x"}}
	f.ln.Apply(cfg)
	after := f.ln.Status()
	if before != after || before.Generation != after.Generation {
		t.Fatalf("같은 듣기 값인데 다시 열었다: %+v → %+v", before, after)
	}
}

// FR-PNW-8: 끄면 닫는다.
func TestListenerDisableCloses(t *testing.T) {
	f := newListenerFixture(t)
	cfg := enabledAt(freePort(t))
	f.ln.Apply(cfg)
	addr := f.ln.Status().Addr
	cfg.Enabled = false
	f.ln.Apply(cfg)
	if st := f.ln.Status(); st.Listening {
		t.Fatalf("끈 뒤에도 듣는다: %+v", st)
	}
	if dialable(addr) {
		t.Fatal("끈 뒤에도 포트가 열려 있다")
	}
}

// FR-PNW-9: 열지 못하면 사유를 들고, 다른 값으로 다시 열 수 있다.
func TestListenerPortBusyReportsReason(t *testing.T) {
	f := newListenerFixture(t)
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	f.ln.Apply(enabledAt(busy.Addr().(*net.TCPAddr).Port))
	st := f.ln.Status()
	if st.Listening || st.Err == "" {
		t.Fatalf("사용 중인 포트인데 상태가 %+v", st)
	}
	f.ln.Apply(enabledAt(freePort(t)))
	st = f.ln.Status()
	if !st.Listening || st.Err != "" {
		t.Fatalf("빈 포트로 바꿨는데 상태가 %+v", st)
	}
}

// Close 뒤에는 듣지 않는다. 두 번 불러도 된다.
func TestListenerClose(t *testing.T) {
	f := newListenerFixture(t)
	f.ln.Apply(enabledAt(freePort(t)))
	addr := f.ln.Status().Addr
	f.ln.Close()
	f.ln.Close()
	if dialable(addr) {
		t.Fatal("Close 뒤에도 포트가 열려 있다")
	}
}

// FR-PNW-31: 짝을 해제하면 이미 열린 연결로도 더는 닿지 않는다.
func TestListenerRevokedPeerOnOpenConnection(t *testing.T) {
	f := newListenerFixture(t)
	var allowed atomic.Bool
	allowed.Store(true)
	f.ln = NewListener(f.server, PeersOnly(func(fp string) bool { return allowed.Load() && fp == f.peerFP }), f.handler)
	t.Cleanup(f.ln.Close)
	f.ln.Apply(enabledAt(freePort(t)))
	addr := f.ln.Status().Addr

	c := f.clientFor(&f.peerID, 0)
	c.Transport.(*http.Transport).DisableKeepAlives = false
	if code, err := get(c, addr, "/peer/v1/x"); err != nil || code != http.StatusNoContent {
		t.Fatalf("첫 요청: code=%d err=%v", code, err)
	}
	allowed.Store(false)
	if code, err := get(c, addr, "/peer/v1/x"); err == nil && code == http.StatusNoContent {
		t.Fatal("해제한 짝이 열린 연결로 닿았다")
	}
	if f.handled.Load() != 1 {
		t.Fatalf("핸들러 호출 %d, 기대 1", f.handled.Load())
	}
}

// FR-PNW-31: 해제한 짝이 TLS 세션 재개로 인증서 검사를 건너뛰지 못한다.
func TestListenerRevokedPeerOnResumedSession(t *testing.T) {
	f := newListenerFixture(t)
	var allowed atomic.Bool
	allowed.Store(true)
	f.ln = NewListener(f.server, PeersOnly(func(fp string) bool { return allowed.Load() && fp == f.peerFP }), f.handler)
	t.Cleanup(f.ln.Close)
	f.ln.Apply(enabledAt(freePort(t)))
	addr := f.ln.Status().Addr

	c := f.clientFor(&f.peerID, 0)
	c.Transport.(*http.Transport).TLSClientConfig.ClientSessionCache = tls.NewLRUClientSessionCache(4)
	if code, err := get(c, addr, "/peer/v1/x"); err != nil || code != http.StatusNoContent {
		t.Fatalf("첫 요청: code=%d err=%v", code, err)
	}
	allowed.Store(false)
	if code, err := get(c, addr, "/peer/v1/x"); err == nil && code == http.StatusNoContent {
		t.Fatal("해제한 짝이 세션 재개로 닿았다")
	}
	if f.handled.Load() != 1 {
		t.Fatalf("핸들러 호출 %d, 기대 1", f.handled.Load())
	}
}

// I-1: TLS 단계가 받아도 요청 단계가 경로별로 다시 거른다.
func TestListenerRequestAdmissionByPath(t *testing.T) {
	f := newListenerFixture(t)
	strangeFP := f.strange.Fingerprint
	f.ln = NewListener(f.server, Admission{
		TLS:     func(fp string) bool { return fp == strangeFP },
		Request: func(fp, path string) bool { return fp == strangeFP && path == "/peer/v1/pair" },
	}, f.handler)
	t.Cleanup(f.ln.Close)
	f.ln.Apply(enabledAt(freePort(t)))
	addr := f.ln.Status().Addr
	c := f.clientFor(&f.strange, 0)
	if code, err := get(c, addr, "/peer/v1/pair"); err != nil || code != http.StatusNoContent {
		t.Fatalf("허용 경로: code=%d err=%v", code, err)
	}
	if code, err := get(c, addr, "/peer/v1/node.info"); err != nil || code != http.StatusForbidden {
		t.Fatalf("막힌 경로: code=%d err=%v", code, err)
	}
	if f.handled.Load() != 1 {
		t.Fatalf("핸들러 호출 %d, 기대 1", f.handled.Load())
	}
}
