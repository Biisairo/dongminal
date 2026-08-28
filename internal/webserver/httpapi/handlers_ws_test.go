package httpapi

import (
	"dongminal/internal/shared/toolhub"

	"bytes"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func mustWS(t *testing.T, srv *httptest.Server, path string) *websocket.Conn {
	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + path
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	return c
}

func TestHandleWS_NewTool(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?cols=80&rows=24")
	defer ws.Close()

	// First message should be toolhub.OpToolID with tool ID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("expected binary, got %d", mt)
	}
	if len(msg) == 0 || msg[0] != toolhub.OpToolID {
		t.Fatalf("expected toolhub.OpToolID, got op=0x%02x", msg[0])
	}
	toolID := string(msg[1:])
	if toolID == "" {
		t.Fatal("empty tool id")
	}

	// toolhub.Tool should exist in manager.
	p := pm.Get(toolID)
	if p == nil {
		t.Fatalf("tool %s not found", toolID)
	}

	// Cleanup.
	pm.Delete(toolID)
}

func TestHandleWS_ExistingTool(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Create a tool first.
	p, err := pm.Create("", 80, 24)
	if err != nil {
		t.Fatalf("create tool: %v", err)
	}
	defer pm.Delete(p.ID)

	// Write something to PTY so snapshot is non-empty.
	if _, err := p.PTMX().Write([]byte("echo hello\n")); err != nil {
		t.Fatalf("write ptmx: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	ws := mustWS(t, ts, "/ws?tool="+p.ID+"&cols=80&rows=24")
	defer ws.Close()

	// First message: toolhub.OpToolID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read sid: %v", err)
	}
	if msg[0] != toolhub.OpToolID {
		t.Fatalf("expected toolhub.OpToolID, got 0x%02x", msg[0])
	}

	// Next message should be toolhub.OpOutput (snapshot).
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err = ws.ReadMessage()
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("expected binary, got %d", mt)
	}
	if len(msg) == 0 || msg[0] != toolhub.OpOutput {
		t.Fatalf("expected toolhub.OpOutput, got op=0x%02x", msg[0])
	}
	if len(msg) <= 1 {
		t.Fatal("empty snapshot")
	}
}

func TestHandleWS_OpInput(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?cols=80&rows=24")
	defer ws.Close()

	// Read toolhub.OpToolID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, _ := ws.ReadMessage()
	toolID := string(msg[1:])
	defer pm.Delete(toolID)

	// Send toolhub.OpInput.
	input := []byte("echo ws_test\n")
	m := make([]byte, 1+len(input))
	m[0] = toolhub.OpInput
	copy(m[1:], input)
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := ws.WriteMessage(websocket.BinaryMessage, m); err != nil {
		t.Fatalf("write input: %v", err)
	}

	// Wait for toolhub.OpOutput containing our input or shell prompt.
	found := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		ws.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		mt, msg, err := ws.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.BinaryMessage && len(msg) > 0 && msg[0] == toolhub.OpOutput {
			if bytes.Contains(msg[1:], []byte("ws_test")) {
				found = true
				break
			}
		}
	}
	if !found {
		t.Fatal("did not receive echoed output")
	}
}

func TestHandleWS_OpResize(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?cols=80&rows=24")
	defer ws.Close()

	// Read toolhub.OpToolID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, _ := ws.ReadMessage()
	toolID := string(msg[1:])
	defer pm.Delete(toolID)

	// Send toolhub.OpResize: cols=100, rows=30.
	m := make([]byte, 5)
	m[0] = toolhub.OpResize
	binary.BigEndian.PutUint16(m[1:3], 100)
	binary.BigEndian.PutUint16(m[3:5], 30)
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := ws.WriteMessage(websocket.BinaryMessage, m); err != nil {
		t.Fatalf("write resize: %v", err)
	}

	// Resize should not panic; no easy way to verify size without platform-specific code.
	// We simply ensure the connection stays alive.
	ws.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, _, err := ws.ReadMessage()
	// May timeout if no output; that's ok.
	if err != nil && !strings.Contains(err.Error(), "timeout") && !strings.Contains(err.Error(), "i/o timeout") {
		t.Fatalf("unexpected read error: %v", err)
	}
}

func TestHandleWS_MissingTool(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?tool=9999")
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage || len(msg) == 0 || msg[0] != toolhub.OpExit {
		t.Fatalf("expected toolhub.OpExit, got mt=%d op=0x%02x", mt, msg[0])
	}
}

func TestHandleWS_NilTools(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// httptest to websocket upgrade will fail with 500 because Tools is nil.
	wsURL := strings.Replace(ts.URL, "http://", "ws://", 1) + "/ws"
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("expected dial error when tools is nil")
	}
	if resp != nil && resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

// wsPair는 업그레이드된 서버측 toolhub.SafeConn 과 클라이언트 conn 을 돌려준다.
// relayOutput 은 데몬 모드에서만 도는 goroutine 이라 핸들러를 통째로 세우지 않고
// 소켓만 만들어 직접 검사한다.
func wsPair(t *testing.T) (*toolhub.SafeConn, *websocket.Conn, func()) {
	t.Helper()
	ch := make(chan *toolhub.SafeConn, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := toolhub.Upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		ch <- toolhub.NewSafeConn(raw)
		<-r.Context().Done()
	}))
	cli := mustWS(t, ts, "/")
	srv := <-ch
	return srv, cli, func() { cli.Close(); ts.Close() }
}

// 죽은 소켓에 쓰기가 실패하면 릴레이는 **그 자리에서 끝난다.**
// 예전에는 실패를 로그만 남기고 계속 펌프해 broken pipe 로그가 폭주했다
// (실측 2026-08-25: 26초에 7.7MB).
func TestRelayOutput_StopsOnWriteFailure(t *testing.T) {
	srvConn, _, cleanup := wsPair(t)
	defer cleanup()

	out := make(chan []byte, 64)
	exit := make(chan struct{})
	done := make(chan struct{})
	defer close(done)

	srvConn.Close() // 상대가 사라진 상태를 만든다: 이후 쓰기는 전부 실패한다.

	// 릴레이가 멈추지 않으면 이 채널을 계속 비워 낸다. 멈추면 곧 가득 찬다.
	feeding := make(chan struct{})
	go func() {
		defer close(feeding)
		for i := 0; i < 64; i++ {
			out <- []byte("x")
		}
	}()

	fin := make(chan struct{})
	go func() { relayOutput(srvConn, "t1", out, exit, done); close(fin) }()

	select {
	case <-fin:
	case <-time.After(3 * time.Second):
		t.Fatal("쓰기 실패 후에도 릴레이가 살아 있다 — 폭주 경로가 되살아났다")
	}
	if got := len(out); got < 60 {
		t.Fatalf("릴레이가 실패 후에도 %d 건을 더 소비했다; 첫 실패에서 끊어야 한다", 64-got)
	}
}

// 반증: 소켓이 살아 있으면 릴레이는 멈추지 않는다 — 위 규칙이 정상 경로까지
// 끊어 버리는 형태로 통과하지 않음을 확인한다.
func TestRelayOutput_KeepsPumpingWhileHealthy(t *testing.T) {
	srvConn, cli, cleanup := wsPair(t)
	defer cleanup()

	out := make(chan []byte, 4)
	exit := make(chan struct{})
	done := make(chan struct{})
	fin := make(chan struct{})
	go func() { relayOutput(srvConn, "t1", out, exit, done); close(fin) }()

	for i := 0; i < 3; i++ {
		out <- []byte("hello")
		cli.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, msg, err := cli.ReadMessage()
		if err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		if len(msg) == 0 || msg[0] != toolhub.OpOutput || string(msg[1:]) != "hello" {
			t.Fatalf("read %d: 예상 밖 프레임 %q", i, msg)
		}
	}
	select {
	case <-fin:
		t.Fatal("정상 소켓인데 릴레이가 끝났다")
	default:
	}

	close(done)
	select {
	case <-fin:
	case <-time.After(3 * time.Second):
		t.Fatal("done 신호에도 릴레이가 끝나지 않는다")
	}
}

// 도구가 종료되면 toolhub.OpExit 를 보내고 소켓을 닫는다 (직접 모드와 동일).
func TestRelayOutput_SendsExitOnToolExit(t *testing.T) {
	srvConn, cli, cleanup := wsPair(t)
	defer cleanup()

	out := make(chan []byte)
	exit := make(chan struct{})
	done := make(chan struct{})
	defer close(done)

	fin := make(chan struct{})
	go func() { relayOutput(srvConn, "t1", out, exit, done); close(fin) }()
	close(exit)

	cli.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := cli.ReadMessage()
	if err != nil {
		t.Fatalf("read exit: %v", err)
	}
	if len(msg) == 0 || msg[0] != toolhub.OpExit {
		t.Fatalf("toolhub.OpExit 가 아니다: %q", msg)
	}
	select {
	case <-fin:
	case <-time.After(3 * time.Second):
		t.Fatal("exit 후에도 릴레이가 살아 있다")
	}
}
