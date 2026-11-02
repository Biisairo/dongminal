package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"dongminal/internal/webserver/domain/lsp"
)

// fakeTunnel 은 언어 서버 프로세스 대신이다. 브라우저가 보낸 것은 sent 로, 서버가 낼
// 것은 out 으로 넣는다. out 을 닫으면 프로세스가 끝난 것이다.
type fakeTunnel struct {
	sent   chan []byte
	out    chan []byte
	closed chan struct{}
	once   sync.Once
}

func newFakeTunnel() *fakeTunnel {
	return &fakeTunnel{sent: make(chan []byte, 8), out: make(chan []byte, 8), closed: make(chan struct{})}
}

func (f *fakeTunnel) Send(b []byte) error { f.sent <- b; return nil }
func (f *fakeTunnel) Recv() ([]byte, error) {
	select {
	case b, ok := <-f.out:
		if !ok {
			return nil, errors.New("exit")
		}
		return b, nil
	case <-f.closed:
		return nil, errors.New("closed")
	}
}
func (f *fakeTunnel) Close()             { f.once.Do(func() { close(f.closed) }) }
func (f *fakeTunnel) LastUse() time.Time { return time.Time{} }

func lspWSURL(ts *httptest.Server, root, server string) string {
	q := url.Values{}
	if root != "" {
		q.Set("root", root)
	}
	if server != "" {
		q.Set("server", server)
	}
	return strings.Replace(ts.URL, "http://", "ws://", 1) + "/api/lsp/ws?" + q.Encode()
}

func dialLSPWS(t *testing.T, ts *httptest.Server, root, server string, hdr http.Header) (*websocket.Conn, int) {
	t.Helper()
	c, resp, err := websocket.DefaultDialer.Dial(lspWSURL(ts, root, server), hdr)
	if resp != nil {
		resp.Body.Close()
	}
	if c != nil {
		t.Cleanup(func() { c.Close() })
		return c, resp.StatusCode
	}
	if resp == nil {
		t.Fatalf("dial: %v", err)
	}
	return nil, resp.StatusCode
}

// closeOf 는 서버가 보낸 close 의 (code, reason) 이다.
func closeOf(t *testing.T, c *websocket.Conn) (int, string) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, _, err := c.ReadMessage()
		if err == nil {
			continue
		}
		var ce *websocket.CloseError
		if errors.As(err, &ce) {
			return ce.Code, ce.Text
		}
		t.Fatalf("close 가 아닌 오류: %v", err)
	}
}

func waitClosed(t *testing.T, ft *fakeTunnel, why string) {
	t.Helper()
	select {
	case <-ft.closed:
	case <-time.After(3 * time.Second):
		t.Fatal(why)
	}
}

// FR-CMR-101: 메시지가 양쪽으로 그대로 지나고, 루트·서술자가 도메인에 간다.
func TestLSPWS_RelaysBothWays(t *testing.T) {
	ft := newFakeTunnel()
	f := &fakeLSP{tunnel: ft}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()

	c, code := dialLSPWS(t, ts, lspTestRoot, "gopls/gopls", nil)
	if code != http.StatusSwitchingProtocols {
		t.Fatalf("status=%d", code)
	}
	up := `{"jsonrpc":"2.0","method":"initialized","params":"한글"}`
	if err := c.WriteMessage(websocket.TextMessage, []byte(up)); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-ft.sent:
		if string(b) != up {
			t.Fatalf("통로에 %q", b)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("브라우저 메시지가 통로에 닿지 않았다")
	}
	// 101 은 통로를 열기 전에 오므로, 메시지가 통로에 닿은 뒤에 기록을 읽는다.
	if f.tunnelDesc != "gopls/gopls" || f.tunnelRoot == "" {
		t.Fatalf("도메인에 간 값: root=%q desc=%q", f.tunnelRoot, f.tunnelDesc)
	}
	down := `{"jsonrpc":"2.0","id":1,"result":"값"}`
	ft.out <- []byte(down)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	mt, b, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if mt != websocket.TextMessage || string(b) != down {
		t.Fatalf("받은 것 type=%d %q", mt, b)
	}
}

// FR-CMR-103: WebSocket 이 닫히면 통로(프로세스)를 닫는다.
func TestLSPWS_ClientCloseClosesTunnel(t *testing.T) {
	ft := newFakeTunnel()
	_, ts := lspServerWithRoot(t, &fakeLSP{tunnel: ft})
	defer ts.Close()
	c, _ := dialLSPWS(t, ts, lspTestRoot, "gopls/gopls", nil)
	_ = c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	c.Close()
	waitClosed(t, ft, "WebSocket 이 닫혔는데 통로가 남았다")
}

// FR-CMR-103: 프로세스가 끝나면 WebSocket 을 4003 ended 로 닫는다.
func TestLSPWS_ProcessExitClosesSocket(t *testing.T) {
	ft := newFakeTunnel()
	_, ts := lspServerWithRoot(t, &fakeLSP{tunnel: ft})
	defer ts.Close()
	c, _ := dialLSPWS(t, ts, lspTestRoot, "gopls/gopls", nil)
	close(ft.out)
	if code, reason := closeOf(t, c); code != lspWSCloseEnded || reason != "ended" {
		t.Fatalf("close=%d %q want %d ended", code, reason, lspWSCloseEnded)
	}
	waitClosed(t, ft, "프로세스가 끝난 뒤 통로를 닫지 않았다")
}

// FR-CMR-102: 상한이면 4001 limit 로 닫는다.
func TestLSPWS_LimitClose(t *testing.T) {
	_, ts := lspServerWithRoot(t, &fakeLSP{tunnelErr: lsp.ErrLimit})
	defer ts.Close()
	c, code := dialLSPWS(t, ts, lspTestRoot, "gopls/gopls", nil)
	if code != http.StatusSwitchingProtocols {
		t.Fatalf("status=%d — 상한은 업그레이드 뒤 close code 로 알린다", code)
	}
	if code, reason := closeOf(t, c); code != lspWSCloseLimit || reason != "limit" {
		t.Fatalf("close=%d %q want %d limit", code, reason, lspWSCloseLimit)
	}
}

// 기동 실패는 4002 이고 사유를 싣는다 — close 프레임 한도(123바이트) 안의 온전한 UTF-8 이다.
func TestLSPWS_StartFailureClose(t *testing.T) {
	long := strings.Repeat("가", 100) // 300바이트
	_, ts := lspServerWithRoot(t, &fakeLSP{tunnelErr: errors.New(long)})
	defer ts.Close()
	c, _ := dialLSPWS(t, ts, lspTestRoot, "gopls/gopls", nil)
	code, reason := closeOf(t, c)
	if code != lspWSCloseStart {
		t.Fatalf("close=%d want %d", code, lspWSCloseStart)
	}
	if len(reason) == 0 || len(reason) > 123 || !utf8.ValidString(reason) || !strings.HasPrefix(long, reason) {
		t.Fatalf("reason 이 잘못 잘렸다: %d바이트 %q", len(reason), reason)
	}
}

// FR-CMR-104: 상한을 넘는 메시지가 오면 연결을 닫고 통로도 닫는다.
func TestLSPWS_ReadLimit(t *testing.T) {
	old := lspWSReadLimit
	lspWSReadLimit = 64
	t.Cleanup(func() { lspWSReadLimit = old })
	ft := newFakeTunnel()
	_, ts := lspServerWithRoot(t, &fakeLSP{tunnel: ft})
	defer ts.Close()
	c, _ := dialLSPWS(t, ts, lspTestRoot, "gopls/gopls", nil)
	_ = c.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", 65)))
	if code, _ := closeOf(t, c); code != websocket.CloseMessageTooBig {
		t.Fatalf("close=%d want 1009", code)
	}
	waitClosed(t, ft, "상한을 넘은 연결의 통로가 남았다")
	select {
	case b := <-ft.sent:
		t.Fatalf("상한을 넘은 메시지가 통로에 갔다: %d바이트", len(b))
	default:
	}
}

// FR-CMR-100: 다른 출처는 업그레이드 전에 막히고 프로세스를 띄우지 않는다.
func TestLSPWS_CrossOriginRejected(t *testing.T) {
	f := &fakeLSP{tunnel: newFakeTunnel()}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()
	h := http.Header{}
	h.Set("Origin", "https://evil.example")
	if _, code := dialLSPWS(t, ts, lspTestRoot, "gopls/gopls", h); code != http.StatusForbidden {
		t.Fatalf("status=%d want 403", code)
	}
	if f.tunnelOpened != 0 {
		t.Fatal("거절된 요청이 통로를 열었다")
	}
}

// 루트·서술자가 틀리면 업그레이드 전에 HTTP 로 거절하고 통로를 열지 않는다.
func TestLSPWS_BadRequest(t *testing.T) {
	f := &fakeLSP{tunnel: newFakeTunnel()}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()
	for _, tc := range []struct{ root, server string }{
		{lspTestRoot, ""},
		{"", "gopls/gopls"},
		{"/not/registered", "gopls/gopls"},
	} {
		if _, code := dialLSPWS(t, ts, tc.root, tc.server, nil); code == http.StatusSwitchingProtocols || code < 400 {
			t.Fatalf("%+v: status=%d", tc, code)
		}
	}
	if f.tunnelOpened != 0 {
		t.Fatal("거절된 요청이 통로를 열었다")
	}
}
