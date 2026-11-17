// Package peerrelay 는 노드 포트의 바이트 통로다 (PEER_DAEMON_SRS 묶음 L).
//
// 노드는 데몬이다. 서버는 망이 통하게만 한다 (D-PDM-2):
//
//   - 들어오는 연결: 서버가 노드 포트(TCP)로 받아 데몬의 노드 소켓으로 넘긴다
//     (Port → ListenNode). 서버는 출발지 주소 한 줄(프리앰블)만 앞에 붙인다.
//   - 나가는 연결: 데몬이 서버의 발신 소켓에 연결을 부탁한다 (Dialer → ServeDial).
//
// 두 방향 모두 서버는 TLS 를 끝내지 않고 내용을 읽지 않는다. TLS 와 지문 판정은
// 데몬의 peer.Listener·peer.Client 가 한다.
package peerrelay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/peer"
	"dongminal/internal/shared/platform"
)

const (
	// NodeSocketFile 은 데몬이 여는 노드 소켓이다 (FR-PDM-11).
	NodeSocketFile = "node.sock"
	// DialSocketFile 은 서버가 여는 발신 소켓이다 (FR-PDM-12).
	DialSocketFile = "dial.sock"

	preambleTag = "DMRELAY1 "
	dialTag     = "DMDIAL1 "
	replyOK     = "OK"
	replyErr    = "ERR "
	// lineMax 는 프리앰블·요청·답 한 줄의 상한이다. 주소 한 개면 충분하다.
	lineMax = 256
	// handshakeTimeout 은 프리앰블·요청·답을 기다리는 시한이다.
	handshakeTimeout = 5 * time.Second
	// localDialTimeout 은 로컬 소켓에 붙는 시한이다.
	localDialTimeout = 2 * time.Second
	// drainTimeout 은 한쪽이 끝난 뒤 다른 쪽을 기다리는 시한이다. 보내는 쪽의 요청
	// 한도보다 길다 (FR-PNW-44).
	drainTimeout = peer.RequestTimeout + 5*time.Second
)

var (
	errBadLine    = errors.New("통로 줄 형식이 틀렸습니다")
	errNotTCP     = errors.New("발신 소켓은 tcp 연결만 엽니다")
	errSocketBusy = errors.New("다른 프로세스가 이 소켓을 듣고 있습니다")
)

// NodeSocketPath 는 home 의 노드 소켓 경로다. 데몬 IPC 종단과 같은 폴더(0700)에 둔다.
func NodeSocketPath(home string) string { return socketPath(home, NodeSocketFile) }

// DialSocketPath 는 home 의 발신 소켓 경로다.
func DialSocketPath(home string) string { return socketPath(home, DialSocketFile) }

func socketPath(home, name string) string {
	return filepath.Join(filepath.Dir(platform.Current().IPC.Endpoint(home)), name)
}

func preamble(addr string) string { return preambleTag + addr + "\n" }

// listenFresh 는 path 에 소켓을 연다. 남은 소켓이 죽어 있으면 치우고, 살아 있으면 거절한다.
func listenFresh(path string) (net.Listener, error) {
	ipc := platform.Current().IPC
	if ipc.Exists(path) {
		if c, err := ipc.Dial(path, localDialTimeout); err == nil {
			c.Close()
			return nil, fmt.Errorf("%s: %w", path, errSocketBusy)
		}
		if err := ipc.Remove(path); err != nil {
			return nil, err
		}
	}
	return ipc.Listen(path)
}

// readLine 은 '\n' 까지 한 바이트씩 읽는다. 버퍼를 두면 줄 뒤의 TLS 바이트를 먹는다.
func readLine(c net.Conn) (string, error) {
	var b strings.Builder
	one := make([]byte, 1)
	for b.Len() < lineMax {
		if _, err := c.Read(one); err != nil {
			return "", err
		}
		if one[0] == '\n' {
			return b.String(), nil
		}
		b.WriteByte(one[0])
	}
	return "", errBadLine
}

// splice 는 a 와 b 사이의 바이트를 양방향으로 옮긴다. 한쪽이 끝나면 반대쪽의 쓰기를
// 닫고, 다른 쪽을 drainTimeout 까지 기다린 뒤 둘 다 닫는다.
func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	pump := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
		done <- struct{}{}
	}
	go pump(a, b)
	go pump(b, a)
	<-done
	select {
	case <-done:
	case <-time.After(drainTimeout):
	}
	_ = a.Close()
	_ = b.Close()
}

// ── 서버: 노드 포트 ──────────────────────────────────────────────────────────

type portKey struct {
	enabled bool
	bind    string
	port    int
}

// Port 는 서버의 노드 포트다. 받은 연결을 노드 소켓으로 넘긴다 (FR-PDM-10).
// 생명주기는 peer.Listener 와 같다 (FR-PNW-4·8·9).
type Port struct {
	nodeSock string

	mu      sync.Mutex
	applied bool
	closed  bool
	key     portKey
	ln      net.Listener
	status  peer.Status
	gen     uint64
}

// NewPort 는 nodeSock 으로 넘기는 노드 포트를 만든다. Apply 전에는 듣지 않는다.
func NewPort(nodeSock string) *Port { return &Port{nodeSock: nodeSock} }

// Apply 는 enabled·bind·port 에 맞춰 연다·닫는다·다시 연다. 셋이 같고 지금 상태가
// 그 값과 맞으면 아무것도 하지 않는다. 열지 못하면 사유를 Status 에 남긴다.
func (p *Port) Apply(enabled bool, bind string, port int) {
	key := portKey{enabled: enabled, bind: bind, port: port}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || (p.applied && key == p.key && p.status.Listening == key.enabled) {
		return
	}
	p.closeLocked()
	p.applied = true
	p.key = key
	if !enabled {
		return
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(bind, strconv.Itoa(port)))
	if err != nil {
		dmlog.Infof(nil, "peer relay port: %v", err)
		p.status = peer.Status{Err: err.Error()}
		return
	}
	p.gen++
	p.ln = ln
	p.status = peer.Status{Listening: true, Addr: ln.Addr().String(), Generation: p.gen}
	go p.serve(ln)
	dmlog.Infof(nil, "peer relay port on %s", ln.Addr())
}

func (p *Port) serve(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go p.forward(c)
	}
}

// forward 는 c 를 노드 소켓에 잇는다. 노드 소켓이 없으면(데몬이 안 떠 있음) c 를 닫는다.
func (p *Port) forward(c net.Conn) {
	d, err := platform.Current().IPC.Dial(p.nodeSock, localDialTimeout)
	if err != nil {
		_ = c.Close()
		return
	}
	_ = d.SetWriteDeadline(time.Now().Add(handshakeTimeout))
	if _, err := io.WriteString(d, preamble(c.RemoteAddr().String())); err != nil {
		_ = c.Close()
		_ = d.Close()
		return
	}
	_ = d.SetWriteDeadline(time.Time{})
	splice(c, d)
}

// Status 는 지금 상태의 사본이다.
func (p *Port) Status() peer.Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.status
}

// Close 는 포트를 닫는다. 그 뒤의 Apply 는 아무것도 열지 않는다.
func (p *Port) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closeLocked()
	p.applied = false
	p.closed = true
}

func (p *Port) closeLocked() {
	if p.ln != nil {
		_ = p.ln.Close()
		p.ln = nil
	}
	p.status = peer.Status{}
}

// ── 데몬: 노드 소켓 ──────────────────────────────────────────────────────────

// relayAddr 은 프리앰블이 알린 원래 출발지 주소다.
type relayAddr string

func (relayAddr) Network() string  { return "tcp" }
func (a relayAddr) String() string { return string(a) }

type relayConn struct {
	net.Conn
	remote relayAddr
}

func (c *relayConn) RemoteAddr() net.Addr { return c.remote }

// nodeListener 는 노드 소켓의 net.Listener 다. 프리앰블을 읽은 연결만 Accept 로 낸다.
// 프리앰블은 연결마다 따로 읽으므로, 느린 연결 하나가 다른 연결을 막지 않는다.
type nodeListener struct {
	ln    net.Listener
	ready chan net.Conn
	done  chan struct{}
	once  sync.Once
}

// ListenNode 는 path 에 노드 소켓을 연다 (FR-PDM-11). 받은 연결의 RemoteAddr 는
// 서버가 프리앰블로 알린 출발지 주소다.
func ListenNode(path string) (net.Listener, error) {
	ln, err := listenFresh(path)
	if err != nil {
		return nil, err
	}
	n := &nodeListener{ln: ln, ready: make(chan net.Conn), done: make(chan struct{})}
	go n.acceptLoop()
	return n, nil
}

func (n *nodeListener) acceptLoop() {
	for {
		c, err := n.ln.Accept()
		if err != nil {
			_ = n.Close()
			return
		}
		go n.admit(c)
	}
}

func (n *nodeListener) admit(c net.Conn) {
	_ = c.SetReadDeadline(time.Now().Add(handshakeTimeout))
	line, err := readLine(c)
	if err != nil || !strings.HasPrefix(line, preambleTag) {
		_ = c.Close()
		return
	}
	addr := strings.TrimPrefix(line, preambleTag)
	if _, _, err := net.SplitHostPort(addr); err != nil {
		_ = c.Close()
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	select {
	case n.ready <- &relayConn{Conn: c, remote: relayAddr(addr)}:
	case <-n.done:
		_ = c.Close()
	}
}

func (n *nodeListener) Accept() (net.Conn, error) {
	select {
	case c := <-n.ready:
		return c, nil
	case <-n.done:
		return nil, net.ErrClosed
	}
}

func (n *nodeListener) Close() error {
	n.once.Do(func() {
		close(n.done)
		_ = n.ln.Close()
	})
	return nil
}

func (n *nodeListener) Addr() net.Addr { return n.ln.Addr() }

// ── 발신 소켓 ────────────────────────────────────────────────────────────────

// ListenDial 은 서버의 발신 소켓을 path 에 연다 (FR-PDM-12).
func ListenDial(path string) (net.Listener, error) { return listenFresh(path) }

// ServeDial 은 ln 이 닫힐 때까지 발신 요청을 받는다. 요청마다 TCP 로 연결하고
// 결과를 알린 뒤 바이트를 잇는다.
func ServeDial(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go serveDialOne(c)
	}
}

func serveDialOne(c net.Conn) {
	_ = c.SetDeadline(time.Now().Add(handshakeTimeout))
	line, err := readLine(c)
	if err != nil || !strings.HasPrefix(line, dialTag) {
		_ = c.Close()
		return
	}
	addr := strings.TrimPrefix(line, dialTag)
	if _, _, err := net.SplitHostPort(addr); err != nil {
		replyFail(c, errBadLine)
		return
	}
	r, err := net.DialTimeout("tcp", addr, peer.DialTimeout)
	if err != nil {
		replyFail(c, err)
		return
	}
	if _, err := io.WriteString(c, replyOK+"\n"); err != nil {
		_ = c.Close()
		_ = r.Close()
		return
	}
	_ = c.SetDeadline(time.Time{})
	splice(c, r)
}

func replyFail(c net.Conn, err error) {
	msg := strings.ReplaceAll(err.Error(), "\n", " ")
	if len(msg) > lineMax-len(replyErr)-1 {
		msg = msg[:lineMax-len(replyErr)-1]
	}
	_, _ = io.WriteString(c, replyErr+msg+"\n")
	_ = c.Close()
}

// Dialer 는 발신 소켓 sock 을 지나 TCP 연결을 얻는 DialContext 다 (FR-PDM-22).
// 서버가 꺼져 있으면(소켓 없음) 바로 실패한다 (FR-PDM-13).
func Dialer(sock string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		switch network {
		case "tcp", "tcp4", "tcp6":
		default:
			return nil, errNotTCP
		}
		c, err := platform.Current().IPC.Dial(sock, localDialTimeout)
		if err != nil {
			return nil, err
		}
		deadline := time.Now().Add(peer.DialTimeout + handshakeTimeout)
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		_ = c.SetDeadline(deadline)
		if _, err := io.WriteString(c, dialTag+addr+"\n"); err != nil {
			_ = c.Close()
			return nil, err
		}
		line, err := readLine(c)
		if err != nil {
			_ = c.Close()
			return nil, err
		}
		if line != replyOK {
			_ = c.Close()
			return nil, errors.New(strings.TrimPrefix(line, replyErr))
		}
		_ = c.SetDeadline(time.Time{})
		return c, nil
	}
}
