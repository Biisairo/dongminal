package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"testing"
	"time"
)

// ── Protocol tests ──────────────────────────────────────────────────────

func TestPanedJSONLinesFraming(t *testing.T) {
	req := panedRequest{ID: 1, Method: "hello", Params: json.RawMessage(`{"server_pid":123}`)}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	b = append(b, '\n')
	var decoded panedRequest
	if err := json.Unmarshal(bytes.TrimSuffix(b, []byte{'\n'}), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.ID != 1 || decoded.Method != "hello" {
		t.Fatalf("decoded=%+v", decoded)
	}
}

func TestPanedBase64RoundTrip(t *testing.T) {
	for _, input := range [][]byte{
		{}, []byte("hello"), []byte("\x1b[31mred\x1b[0m"), []byte("\x00\x01\xff"),
		bytes.Repeat([]byte("x"), 4096),
	} {
		enc := base64.StdEncoding.EncodeToString(input)
		dec, _ := base64.StdEncoding.DecodeString(enc)
		if !bytes.Equal(dec, input) {
			t.Fatalf("round-trip mismatch")
		}
	}
}

// ── Method dispatch tests ──────────────────────────────────────────────

// newTestConn builds a panedConn over an in-memory pipe via the real
// newPanedConn path (queue + writeLoop). The peer end is drained so writes
// never block.
func newTestConn(pm *PaneManager) *panedConn {
	c1, c2 := net.Pipe()
	pc := newPanedConn(c1, pm)
	go func() { _, _ = io.Copy(io.Discard, c2) }()
	return pc
}

func TestPanedMethodDispatch(t *testing.T) {
	pc := newTestConn(NewPaneManager(t.TempDir(), nil))
	tests := []struct {
		name   string
		method string
		params string
	}{
		{"hello", "hello", `{"server_pid":1}`},
		{"create", "create", `{"cwd":"/tmp","cols":80,"rows":24}`},
		{"restore", "restore", `{"id":"9","name":"R","cwd":"/tmp","cols":80,"rows":24}`},
		{"kill", "kill", `{"id":"1"}`},
		{"write", "write", `{"id":"1","data":"` + base64.StdEncoding.EncodeToString([]byte("hi")) + `"}`},
		{"resize", "resize", `{"id":"1","cols":100,"rows":30}`},
		{"list", "list", `{}`},
		{"snapshot", "snapshot", `{"id":"1"}`},
		{"cwd", "cwd", `{"id":"1"}`},
		{"busy", "busy", `{"id":"1"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pc.dispatch(&panedRequest{ID: 1, Method: tt.method, Params: json.RawMessage(tt.params)})
		})
	}
}

func TestPanedUnknownMethod(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{pm: NewPaneManager(t.TempDir(), nil), encoder: json.NewEncoder(&buf)}
	pc.dispatch(&panedRequest{ID: 1, Method: "bogus", Params: json.RawMessage(`{}`)})

	raw := bytes.TrimRight(buf.Bytes(), "\n")
	t.Logf("raw output: %s", raw)
	var resp panedError
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Error.Code != -32601 {
		t.Fatalf("code=%d want -32601", resp.Error.Code)
	}
}

func TestPanedHelloReturnsPaneIDs(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	pm.Create("/tmp", 80, 24)
	pm.Create("/tmp", 80, 24)

	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}
	pc.dispatch(&panedRequest{ID: 1, Method: "hello", Params: json.RawMessage(`{"server_pid":1}`)})

	var resp panedResponse
	json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &resp)
	resultMap := resp.Result.(map[string]interface{})
	paneIDs := resultMap["pane_ids"].([]interface{})
	if len(paneIDs) != 2 {
		t.Fatalf("pane_ids len=%d want 2", len(paneIDs))
	}
}

func TestPanedKillRemovesPane(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	pm.Create("/tmp", 80, 24)
	pc := newTestConn(pm)

	if !pm.IsLive("1") {
		t.Fatal("pane should be live before kill")
	}
	pc.dispatch(&panedRequest{ID: 1, Method: "kill", Params: json.RawMessage(`{"id":"1"}`)})
	time.Sleep(200 * time.Millisecond) // allow async cleanup
	if pm.IsLive("1") {
		t.Fatal("pane should be dead after kill")
	}
}

// ── Push event tests ────────────────────────────────────────────────────

func TestPanedPushOutputBase64(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{encoder: json.NewEncoder(&buf)}
	raw := []byte("hello\x1b[31mworld\x1b[0m\n")
	pc.pushOutputData("1", raw)

	var ev struct {
		Event string `json:"event"`
		Pane  string `json:"pane"`
		Data  string `json:"data"`
	}
	json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &ev)
	if ev.Event != "output" || ev.Pane != "1" {
		t.Fatalf("ev=%+v", ev)
	}
	dec, _ := base64.StdEncoding.DecodeString(ev.Data)
	if !bytes.Equal(dec, raw) {
		t.Fatalf("round-trip mismatch")
	}
}

func TestPanedPushExit(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{encoder: json.NewEncoder(&buf)}
	pc.pushExit("1", 0)

	var ev struct {
		Event string `json:"event"`
		Pane  string `json:"pane"`
		Code  int    `json:"code"`
	}
	json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &ev)
	if ev.Event != "exit" || ev.Pane != "1" {
		t.Fatalf("ev=%+v", ev)
	}
}

func TestPanedPushOutputStopped(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{encoder: json.NewEncoder(&buf)}
	pc.stopped.Store(true)
	pc.pushOutputData("1", []byte("x"))
	if buf.Len() > 0 {
		t.Fatal("pushOutputData should no-op when stopped")
	}
}

// ── Integration tests ───────────────────────────────────────────────────

func shortPath(t *testing.T, name string) string { return t.TempDir() + "/" + name }

func TestPanedServerListenAccept(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	pm.Create("/tmp", 80, 24)

	sockPath := shortPath(t, "t.sock")
	pidPath := shortPath(t, "t.pid")
	ps := NewPanedServer(pm, sockPath, pidPath)
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()

	if _, err := os.Stat(sockPath); os.IsNotExist(err) {
		t.Fatal("socket not created")
	}

	// Accept in a loop so multiple connections work
	go func() {
		for {
			if err := ps.Accept(); err != nil {
				return
			}
		}
	}()

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	enc.Encode(panedRequest{ID: 1, Method: "hello", Params: json.RawMessage(`{"server_pid":1}`)})
	var resp panedResponse
	if err := dec.Decode(&resp); err != nil {
		t.Fatalf("hello response: %v", err)
	}
	if resp.ID != 1 {
		t.Fatalf("id=%d want 1", resp.ID)
	}
	conn.Close()
}

func TestPanedServerCloseCleanup(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	sockPath := shortPath(t, "c.sock")
	pidPath := shortPath(t, "c.pid")

	ps := NewPanedServer(pm, sockPath, pidPath)
	ps.Listen()
	ps.Close()

	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Fatal("socket not removed")
	}
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatal("pidfile not removed")
	}
}

func TestPanedCreateWriteSnapshotFlow(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}

	pc.dispatch(&panedRequest{ID: 1, Method: "create", Params: json.RawMessage(`{"cwd":"/tmp","cols":80,"rows":24}`)})
	buf.Reset()

	data := base64.StdEncoding.EncodeToString([]byte("echo test\n"))
	pc.dispatch(&panedRequest{ID: 2, Method: "write", Params: json.RawMessage(fmt.Sprintf(`{"id":"1","data":"%s"}`, data))})

	buf.Reset()
	pc.dispatch(&panedRequest{ID: 3, Method: "snapshot", Params: json.RawMessage(`{"id":"1"}`)})

	var resp panedResponse
	json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &resp)
	if _, ok := resp.Result.(map[string]interface{})["data"]; !ok {
		t.Fatal("snapshot missing data")
	}
}

func TestPanedRestore(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}

	pc.dispatch(&panedRequest{ID: 1, Method: "restore", Params: json.RawMessage(`{"id":"5","name":"R","cwd":"/home","cols":100,"rows":30}`)})

	if !pm.IsLive("5") {
		t.Fatal("restored pane should be live")
	}
}

// TestPanedListenRejectsLiveSocket verifies Listen refuses to clobber a socket
// already served by a live daemon (concurrent cold-start guard).
func TestPanedListenRejectsLiveSocket(t *testing.T) {
	sock := t.TempDir() + "/s"
	ps1 := NewPanedServer(NewPaneManager(t.TempDir(), nil), sock, "")
	if err := ps1.Listen(); err != nil {
		t.Fatalf("Listen1: %v", err)
	}
	defer ps1.Close()
	go func() { ps1.Accept() }()

	ps2 := NewPanedServer(NewPaneManager(t.TempDir(), nil), sock, "")
	if err := ps2.Listen(); err == nil {
		ps2.Close()
		t.Fatal("Listen2 should reject a live socket, got nil error")
	}
}

// TestPanedListenRemovesStaleSocket verifies a stale (dead) socket is replaced.
func TestPanedListenRemovesStaleSocket(t *testing.T) {
	sock := t.TempDir() + "/s"
	ps1 := NewPanedServer(NewPaneManager(t.TempDir(), nil), sock, "")
	if err := ps1.Listen(); err != nil {
		t.Fatalf("Listen1: %v", err)
	}
	ps1.Close() // socket file may linger but no listener

	ps2 := NewPanedServer(NewPaneManager(t.TempDir(), nil), sock, "")
	if err := ps2.Listen(); err != nil {
		t.Fatalf("Listen2 should reclaim stale socket: %v", err)
	}
	ps2.Close()
}
