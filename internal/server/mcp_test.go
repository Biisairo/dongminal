package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/mcptool"
)

func TestMCPSessionRegistry(t *testing.T) {
	r := NewMCPSessionRegistry()
	if len(r.sessions) != 0 {
		t.Fatal("expected empty")
	}

	s := r.New()
	if s == nil || s.ID == "" {
		t.Fatal("expected session with ID")
	}
	if s.Ch == nil || s.Done == nil {
		t.Fatal("expected channels")
	}

	got := r.Get(s.ID)
	if got != s {
		t.Fatal("Get returned wrong session")
	}

	// Close idempotent
	r.Close(s)
	if r.Get(s.ID) != nil {
		t.Fatal("session should be removed")
	}
	r.Close(s)   // second close should not panic
	r.Close(nil) // nil should not panic
}

func TestHandleMCPMessage_MethodNotAllowed(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/mcp/message", nil)
	resp, _ := http.DefaultClient.Do(req)
	defer resp.Body.Close()
	if resp.StatusCode != 405 {
		t.Fatalf("status=%d want 405", resp.StatusCode)
	}
}

func TestHandleMCPMessage_SessionNotFound(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/mcp/message?sessionId=bad", "application/json", strings.NewReader("{}"))
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestHandleMCPMessage_InvalidJSON(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	resp, _ := http.Post(ts.URL+"/mcp/message?sessionId="+sess.ID, "application/json", strings.NewReader("{bad"))
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
}

// TestHandleMCPRequest_Initialize calls the synchronous handler directly.
func TestHandleMCPRequest_Initialize(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	req := &jsonRPCReq{JSONRPC: "2.0", ID: []byte("1"), Method: "initialize"}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		var r jsonRPCResp
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if r.Error != nil {
			t.Fatalf("unexpected error: %+v", r.Error)
		}
		m, ok := r.Result.(map[string]interface{})
		if !ok {
			t.Fatalf("result type=%T", r.Result)
		}
		if m["protocolVersion"] != "2024-11-05" {
			t.Fatalf("protocolVersion=%v", m["protocolVersion"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHandleMCPRequest_ToolsList(t *testing.T) {
	ft := newFakeToolDispatcher()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: ft})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	req := &jsonRPCReq{JSONRPC: "2.0", ID: []byte("2"), Method: "tools/list"}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		var r struct {
			Result struct {
				Tools []map[string]any `json:"tools"`
			} `json:"result"`
		}
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(r.Result.Tools) != 1 {
			t.Fatalf("tools len=%d want 1", len(r.Result.Tools))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHandleMCPRequest_ToolsList_NilTools(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	req := &jsonRPCReq{JSONRPC: "2.0", ID: []byte("3"), Method: "tools/list"}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		var r struct {
			Result struct {
				Tools []map[string]any `json:"tools"`
			} `json:"result"`
		}
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(r.Result.Tools) != 0 {
			t.Fatalf("tools len=%d want 0", len(r.Result.Tools))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHandleMCPRequest_ToolsCall(t *testing.T) {
	ft := newFakeToolDispatcher()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: ft})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	params := `{"name":"fake_tool","arguments":{}}`
	req := &jsonRPCReq{JSONRPC: "2.0", ID: []byte("4"), Method: "tools/call", Params: json.RawMessage(params)}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		var r jsonRPCResp
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if r.Error != nil {
			t.Fatalf("unexpected error: %+v", r.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHandleMCPRequest_ToolsCall_UnknownTool(t *testing.T) {
	ft := newFakeToolDispatcher()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: ft})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	params := `{"name":"unknown","arguments":{}}`
	req := &jsonRPCReq{JSONRPC: "2.0", ID: []byte("5"), Method: "tools/call", Params: json.RawMessage(params)}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		var r jsonRPCResp
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if r.Error == nil {
			t.Fatal("expected error for unknown tool")
		}
		if r.Error.Code != -32601 {
			t.Fatalf("error code=%d want -32601", r.Error.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHandleMCPRequest_ToolsCall_NilTools(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	params := `{"name":"any","arguments":{}}`
	req := &jsonRPCReq{JSONRPC: "2.0", ID: []byte("6"), Method: "tools/call", Params: json.RawMessage(params)}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		var r jsonRPCResp
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if r.Error == nil {
			t.Fatal("expected error for nil tools")
		}
		if r.Error.Code != -32601 {
			t.Fatalf("error code=%d want -32601", r.Error.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHandleMCPRequest_Ping(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	req := &jsonRPCReq{JSONRPC: "2.0", ID: []byte("7"), Method: "ping"}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		var r jsonRPCResp
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if r.Error != nil {
			t.Fatalf("unexpected error: %+v", r.Error)
		}
		m, ok := r.Result.(map[string]interface{})
		if !ok || len(m) != 0 {
			t.Fatalf("expected empty result, got %v", r.Result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHandleMCPRequest_UnknownMethod(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	req := &jsonRPCReq{JSONRPC: "2.0", ID: []byte("8"), Method: "unknown/method"}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		var r jsonRPCResp
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if r.Error == nil {
			t.Fatal("expected error")
		}
		if r.Error.Code != -32601 {
			t.Fatalf("error code=%d want -32601", r.Error.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHandleMCPRequest_NotifyNoResponse(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	// notification with no ID
	req := &jsonRPCReq{JSONRPC: "2.0", Method: "initialized"}
	srv.handleMCPRequest(sess, req)

	select {
	case msg := <-sess.Ch:
		t.Fatalf("expected no response for notification, got %s", msg)
	case <-time.After(200 * time.Millisecond):
		// expected
	}
}

func TestHandleMCPSSE_EndpointEvent(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/mcp/sse")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type=%q want text/event-stream", ct)
	}
	if ac := resp.Header.Get("Access-Control-Allow-Origin"); ac != "*" {
		t.Fatalf("CORS=%q want *", ac)
	}

	// Read first event (endpoint)
	buf := make([]byte, 1024)
	n, _ := resp.Body.Read(buf)
	if n == 0 {
		t.Fatal("empty SSE stream")
	}
	if !bytes.Contains(buf[:n], []byte("event: endpoint")) {
		t.Fatalf("expected endpoint event, got %q", buf[:n])
	}
}

func TestMCPHandler_Isolated(t *testing.T) {
	s1, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	s2, _ := New(Config{DataDir: t.TempDir()}, Deps{})

	m1 := httptest.NewServer(s1.MCPHandler())
	defer m1.Close()
	m2 := httptest.NewServer(s2.MCPHandler())
	defer m2.Close()

	if m1.URL == m2.URL {
		t.Fatal("MCP handlers share URL")
	}
}

// TestRemoteAddrInContext verifies mcptool.WithRemoteAddr integration.
func TestRemoteAddrInContext(t *testing.T) {
	ctx := mcptool.WithRemoteAddr(context.Background(), "127.0.0.1:9999")
	if got := mcptool.RemoteAddrFromContext(ctx); got != "127.0.0.1:9999" {
		t.Fatalf("remoteAddr=%q want 127.0.0.1:9999", got)
	}
	if got := mcptool.RemoteAddrFromContext(context.Background()); got != "" {
		t.Fatalf("empty context should return empty string, got %q", got)
	}
}
