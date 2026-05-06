package server

import (
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

func TestHandleWS_NewPane(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?cols=80&rows=24")
	defer ws.Close()

	// First message should be OpSID with pane ID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("expected binary, got %d", mt)
	}
	if len(msg) == 0 || msg[0] != OpSID {
		t.Fatalf("expected OpSID, got op=0x%02x", msg[0])
	}
	paneID := string(msg[1:])
	if paneID == "" {
		t.Fatal("empty pane id")
	}

	// Pane should exist in manager.
	p := pm.Get(paneID)
	if p == nil {
		t.Fatalf("pane %s not found", paneID)
	}

	// Cleanup.
	pm.Delete(paneID)
}

func TestHandleWS_ExistingPane(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Create a pane first.
	p, err := pm.Create("", 80, 24)
	if err != nil {
		t.Fatalf("create pane: %v", err)
	}
	defer pm.Delete(p.ID)

	// Write something to PTY so snapshot is non-empty.
	if _, err := p.PTMX().Write([]byte("echo hello\n")); err != nil {
		t.Fatalf("write ptmx: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	ws := mustWS(t, ts, "/ws?pane="+p.ID+"&cols=80&rows=24")
	defer ws.Close()

	// First message: OpSID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read sid: %v", err)
	}
	if msg[0] != OpSID {
		t.Fatalf("expected OpSID, got 0x%02x", msg[0])
	}

	// Next message should be OpOutput (snapshot).
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err = ws.ReadMessage()
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("expected binary, got %d", mt)
	}
	if len(msg) == 0 || msg[0] != OpOutput {
		t.Fatalf("expected OpOutput, got op=0x%02x", msg[0])
	}
	if len(msg) <= 1 {
		t.Fatal("empty snapshot")
	}
}

func TestHandleWS_OpInput(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?cols=80&rows=24")
	defer ws.Close()

	// Read OpSID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, _ := ws.ReadMessage()
	paneID := string(msg[1:])
	defer pm.Delete(paneID)

	// Send OpInput.
	input := []byte("echo ws_test\n")
	m := make([]byte, 1+len(input))
	m[0] = OpInput
	copy(m[1:], input)
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := ws.WriteMessage(websocket.BinaryMessage, m); err != nil {
		t.Fatalf("write input: %v", err)
	}

	// Wait for OpOutput containing our input or shell prompt.
	found := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		ws.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		mt, msg, err := ws.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.BinaryMessage && len(msg) > 0 && msg[0] == OpOutput {
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
	pm := NewPaneManager(t.TempDir(), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?cols=80&rows=24")
	defer ws.Close()

	// Read OpSID.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, _ := ws.ReadMessage()
	paneID := string(msg[1:])
	defer pm.Delete(paneID)

	// Send OpResize: cols=100, rows=30.
	m := make([]byte, 5)
	m[0] = OpResize
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

func TestHandleWS_MissingPane(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?pane=9999")
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage || len(msg) == 0 || msg[0] != OpError {
		t.Fatalf("expected OpError, got mt=%d op=0x%02x", mt, msg[0])
	}
}

func TestHandleWS_NilPanes(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// httptest to websocket upgrade will fail with 500 because Panes is nil.
	wsURL := strings.Replace(ts.URL, "http://", "ws://", 1) + "/ws"
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("expected dial error when panes is nil")
	}
	if resp != nil && resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}
