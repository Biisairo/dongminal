package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewServerInTempDir(t *testing.T) {
	cfg := Config{Port: "0", DataDir: t.TempDir()}
	srv, err := New(cfg, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if srv == nil {
		t.Fatal("srv nil")
	}
	if srv.MCP == nil {
		t.Fatal("MCP registry nil — Server must own its session registry")
	}
	if srv.Started().IsZero() {
		t.Fatal("Started() zero — expected NewServer timestamp")
	}
}

func TestHandlerBasics(t *testing.T) {
	// handleAPI 의 /api/panes GET 은 현재 route 테이블에서 404(내부 switch default)로
	// 떨어진다. 대신 /api/ping 을 사용해 mux + loggingMiddleware 체인이 살아있는지 검증.
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/ping")
	if err != nil {
		t.Fatalf("GET /api/ping: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "ok" {
		t.Fatalf("body=%q; want ok", body)
	}
}

func TestTwoServersInSameProcess(t *testing.T) {
	mk := func() *Server {
		s, err := New(Config{DataDir: t.TempDir()}, Deps{})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		return s
	}

	s1 := mk()
	s2 := mk()

	ts1 := httptest.NewServer(s1.Handler())
	defer ts1.Close()
	ts2 := httptest.NewServer(s2.Handler())
	defer ts2.Close()

	if ts1.URL == ts2.URL {
		t.Fatalf("listeners share URL: %s", ts1.URL)
	}
	if s1.MCP == s2.MCP {
		t.Fatal("two servers must own distinct MCP registries")
	}
	if s1.Commands == s2.Commands {
		t.Fatal("two servers must own distinct command hubs")
	}
}

// TestCreatePaneViaServer: POST /api/panes 가 실제 PaneManager 경유로 pane 을
// 생성하고 id/name 을 JSON 으로 돌려주는지 검증한다. Fake DataDir 에 저장되는
// panes.json 쓰기가 go-routine 으로 돌아가지만 테스트 종료에 의해 정리된다.
func TestCreatePaneViaServer(t *testing.T) {
	dir := t.TempDir()
	pm := NewPaneManager(dir, nil)
	srv, err := New(Config{DataDir: dir}, Deps{Panes: pm})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/panes?cols=80&rows=24", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /api/panes: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	var out struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.ID == "" || out.Name == "" {
		t.Fatalf("missing id/name: %+v", out)
	}
	if pm.Get(out.ID) == nil {
		t.Fatalf("pane %s not registered in manager", out.ID)
	}
	// Cleanup: kill the shell so the PTY goroutines wind down.
	pm.Delete(out.ID)
}
