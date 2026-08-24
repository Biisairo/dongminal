package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestHandlerToolsGetUsesFake: fake ToolHub 주입 → GET /api/state 응답의
// tools 배열이 fake 데이터를 반영함을 검증한다.
// (라우트 테이블에 /api/tools GET 이 없어 /api/state 경유로 List() 를 호출)
func TestHandlerToolsGetUsesFake(t *testing.T) {
	fp := newFakePaneHub()
	fp.seed("fake-a", "Alpha")
	fp.seed("fake-b", "Beta")

	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Tools: fp})
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
		Tools []map[string]interface{} `json:"tools"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Tools) != 2 {
		t.Fatalf("want 2 tools, got %d: %+v", len(body.Tools), body.Tools)
	}
	ids := map[string]bool{}
	for _, p := range body.Tools {
		ids[p["id"].(string)] = true
	}
	if !ids["fake-a"] || !ids["fake-b"] {
		t.Fatalf("missing fake tool ids: %+v", body.Tools)
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
