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
	t.Cleanup(pm.StopSaving)
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
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Create a tool first.
	p, err := pm.Create("", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create tool: %v", err)
	}
	defer pm.Delete(p.ID)

	// Write something to PTY so snapshot is non-empty.
	if err := p.Write([]byte("echo hello\n")); err != nil {
		t.Fatalf("write ptmx: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	ws := mustWS(t, ts, "/ws?tool="+p.ID+"&cols=80&rows=24")
	defer ws.Close()

	// First message: toolhub.OpToolID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read sid: %v", err)
	}
	if msg[0] != toolhub.OpToolID {
		t.Fatalf("expected toolhub.OpToolID, got 0x%02x", msg[0])
	}

	// Next message should be toolhub.OpOutput (snapshot).
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := ws.ReadMessage()
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
	t.Cleanup(pm.StopSaving)
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

	// 에코를 기다린다. 재는 것은 **에코의 도착**이지 러너의 속도가 아니므로
	// 예산을 넉넉히 둔다 — ConPTY 가 셸을 띄우는 데 초 단위가 걸린다.
	//
	// **시한은 한 번만 세운다.** 짧은 시한을 걸고 초과할 때마다 `continue` 하던
	// 판이 있었는데, gorilla 는 읽기가 한 번 실패하면(시한 초과도 실패다) 그
	// 연결을 **영구 실패**로 표시하고 이후의 읽기를 곧바로 되돌린다 — 그러면
	// 루프가 빈틈없이 돌다가 1000회에서 그 패키지가 스스로 패닉한다
	// ("repeated read on failed websocket connection", Windows verify 실측).
	// 예산 전체를 한 시한으로 두면 시한 초과는 곧 "오지 않았다" 이고, 그 자리에서
	// 끝난다.
	found := false
	ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	for {
		mt, msg, err := ws.ReadMessage()
		if err != nil {
			break // 시한 초과이거나 연결이 끊겼다 — 둘 다 "오지 않았다" 이다
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
	t.Cleanup(pm.StopSaving)
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
	t.Cleanup(pm.StopSaving)
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
	// **먹인 것이 다 들어간 뒤에 센다.** 릴레이는 첫 건에서 끝나므로 그것을
	// 기다리는 것만으로는 feeder 가 어디까지 넣었는지 알 수 없고, 아직 넣지 않은
	// 것이 "릴레이가 삼킨 것" 으로 보인다 — 러너가 느릴수록 그렇다 (Windows
	// 실측: 13건만 들어온 채로 재고 "51건을 더 소비했다" 로 읽었다). 버퍼가 64 라
	// 이 대기는 릴레이가 멎어 있어도 반드시 풀린다.
	<-feeding
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

// REQUEST_GATE_SRS §4.2 — WebSocket 의 출처 (TC-RQG-14~16).
//
// 종전에는 `toolhub.Upgrader.CheckOrigin` 이 **항상 true** 였다. gorilla 의 기본값
// (nil)은 `Origin` 호스트가 `Host` 와 같아야 통과시키는데, 그것을 명시적으로 덮어
// 쓴 것이다.
//
// 브라우저의 WebSocket 은 CORS 프리플라이트가 없고 **응답도 읽을 수 있다.** 그래서
// 임의의 웹페이지가 `ws://127.0.0.1:58146/ws` 를 열면(`tool` 을 생략하면) 서버가
// 사용자 권한의 로그인 셸을 하나 만들고, 이후 프레임으로 명령을 타이핑·실행할 수
// 있었다. ACL 은 이것을 막지 못한다 — 출발지가 사용자 자신의 기기다.

// dialWS 는 헤더를 실어 업그레이드를 시도하고 HTTP 상태를 준다.
// 성공하면 101 이고 연결은 곧바로 닫는다.
func dialWS(t *testing.T, ts *httptest.Server, path string, hdr http.Header) int {
	t.Helper()
	wsURL := strings.Replace(ts.URL, "http://", "ws://", 1) + path
	c, resp, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if c != nil {
		c.Close()
	}
	if resp != nil {
		defer resp.Body.Close()
		return resp.StatusCode
	}
	t.Fatalf("dial 이 응답도 오류도 주지 않았다: %v", err)
	return 0
}

func wsGateServer(t *testing.T) *httptest.Server {
	t.Helper()
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// TC-RQG-14: 다른 출처가 연 WebSocket 은 **업그레이드 전에** 막힌다.
func TestHandleWS_CrossOriginRejected(t *testing.T) {
	ts := wsGateServer(t)
	h := http.Header{}
	h.Set("Origin", "https://evil.example")
	if got := dialWS(t, ts, "/ws?cols=80&rows=24", h); got != http.StatusForbidden {
		t.Fatalf("status=%d want 403 — 임의 웹페이지가 셸을 얻는다 (CSWSH → RCE)", got)
	}
}

// TC-RQG-15: `Origin` 없는 업그레이드는 통과한다 (비브라우저 클라이언트).
func TestHandleWS_NoOriginAllowed(t *testing.T) {
	ts := wsGateServer(t)
	if got := dialWS(t, ts, "/ws?cols=80&rows=24", nil); got != http.StatusSwitchingProtocols {
		t.Fatalf("status=%d want 101 — Origin 없는 클라이언트가 막혔다", got)
	}
}

// TC-RQG-16: 자기 출처는 통과한다. 게이트가 자기 화면을 막으면 안 된다.
func TestHandleWS_SameOriginAllowed(t *testing.T) {
	ts := wsGateServer(t)
	h := http.Header{}
	h.Set("Origin", ts.URL)
	if got := dialWS(t, ts, "/ws?cols=80&rows=24", h); got != http.StatusSwitchingProtocols {
		t.Fatalf("status=%d want 101 — 자기 화면의 WebSocket 이 막혔다", got)
	}
}
