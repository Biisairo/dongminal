package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestHandlerPanesGetUsesFake: fake PaneHub 주입 → GET /api/state 응답의
// panes 배열이 fake 데이터를 반영함을 검증한다.
// (라우트 테이블에 /api/panes GET 이 없어 /api/state 경유로 List() 를 호출)
func TestHandlerPanesGetUsesFake(t *testing.T) {
	fp := newFakePaneHub()
	fp.seed("fake-a", "Alpha")
	fp.seed("fake-b", "Beta")

	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Panes: fp})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/state")
	if err != nil {
		t.Fatalf("GET /api/state: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	var body struct {
		Panes []map[string]interface{} `json:"panes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Panes) != 2 {
		t.Fatalf("want 2 panes, got %d: %+v", len(body.Panes), body.Panes)
	}
	ids := map[string]bool{}
	for _, p := range body.Panes {
		ids[p["id"].(string)] = true
	}
	if !ids["fake-a"] || !ids["fake-b"] {
		t.Fatalf("missing fake pane ids: %+v", body.Panes)
	}
}

// TestHandlerWorkspacePutIfMatch: fake Work 가 ErrStale 을 반환하면 409 +
// 현재 rev 가 담긴 ETag 헤더가 응답에 포함되어야 한다.
func TestHandlerWorkspacePutIfMatch(t *testing.T) {
	fw := newFakeWorkspaceStore()
	fw.rev = 7
	fw.stale = true

	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Work: fw})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/workspace", bytes.NewReader([]byte(`{}`)))
	req.Header.Set("If-Match", "3")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status=%d want 409", resp.StatusCode)
	}
	if got := resp.Header.Get("ETag"); got != "7" {
		t.Fatalf("ETag=%q want 7", got)
	}

	// sanity: stale=false 상태에서는 200 + 신 rev 반환
	fw.stale = false
	req2, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/workspace", bytes.NewReader([]byte(`{}`)))
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("PUT2: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp2.StatusCode)
	}
	if got := resp2.Header.Get("ETag"); got != "8" {
		t.Fatalf("ETag=%q want 8", got)
	}
}

// TestMCPDispatchUsesFakeTools: fake ToolDispatcher 에 tools/call 을 보내면
// Dispatch 가 올바른 이름·args 로 호출되고 응답이 세션 채널로 흘러온다.
func TestMCPDispatchUsesFakeTools(t *testing.T) {
	ft := newFakeToolDispatcher()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Tools: ft})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 직접 MCP 세션 생성 (SSE handshake 없이 테스트 가능하도록).
	sess := srv.MCP.New()
	defer srv.MCP.Close(sess)

	rpcBody := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fake_tool","arguments":{"hello":"world"}}}`
	resp, err := http.Post(ts.URL+"/mcp/message?sessionId="+sess.ID, "application/json", strings.NewReader(rpcBody))
	if err != nil {
		t.Fatalf("POST /mcp/message: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status=%d want 202", resp.StatusCode)
	}

	select {
	case msg := <-sess.Ch:
		var r struct {
			Result map[string]any `json:"result"`
		}
		if err := json.Unmarshal(msg, &r); err != nil {
			t.Fatalf("unmarshal rpc response: %v; raw=%s", err, msg)
		}
		if r.Result == nil {
			t.Fatalf("expected non-nil result; raw=%s", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no MCP response within 3s")
	}

	ft.mu.Lock()
	defer ft.mu.Unlock()
	if len(ft.calls) != 1 {
		t.Fatalf("Dispatch call count=%d want 1", len(ft.calls))
	}
	if ft.calls[0].Name != "fake_tool" {
		t.Fatalf("tool name=%q want fake_tool", ft.calls[0].Name)
	}
	var args map[string]string
	if err := json.Unmarshal(ft.calls[0].Args, &args); err != nil {
		t.Fatalf("args unmarshal: %v", err)
	}
	if args["hello"] != "world" {
		t.Fatalf("args=%+v want {hello:world}", args)
	}
}
