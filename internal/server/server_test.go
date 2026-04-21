package server

import (
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
	// handleAPI 를 흉내내는 가짜 핸들러 — /api/panes GET 은 빈 배열을 돌려준다.
	fakeAPI := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/panes" && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("[]"))
			return
		}
		http.NotFound(w, r)
	})
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{
		Handlers: Handlers{API: fakeAPI},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/panes")
	if err != nil {
		t.Fatalf("GET /api/panes: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "[]" {
		t.Fatalf("body=%q; want []", body)
	}
}

func TestTwoServersInSameProcess(t *testing.T) {
	mk := func(marker string) *Server {
		api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(marker))
		})
		s, err := New(Config{DataDir: t.TempDir()}, Deps{
			Handlers: Handlers{API: api},
		})
		if err != nil {
			t.Fatalf("New(%s): %v", marker, err)
		}
		return s
	}

	s1 := mk("first")
	s2 := mk("second")

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

	for _, tc := range []struct {
		url, want string
	}{
		{ts1.URL + "/api/anything", "first"},
		{ts2.URL + "/api/anything", "second"},
	} {
		resp, err := http.Get(tc.url)
		if err != nil {
			t.Fatalf("GET %s: %v", tc.url, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(body) != tc.want {
			t.Fatalf("GET %s body=%q; want %q", tc.url, body, tc.want)
		}
	}
}
