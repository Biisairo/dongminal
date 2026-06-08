package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"dongminal/internal/workspace"
)

type fakeWhoAmIResolver struct {
	paneID   string
	shellPID int
	err      error
}

func (f fakeWhoAmIResolver) ResolveClientPane(string) (string, int, error) {
	return f.paneID, f.shellPID, f.err
}

// TC-API-WAI-1: 정상 매칭 + workspace entry 매칭.
func TestApiWhoAmI_HappyPath(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("p1", "Shell #1")
	pm.panes["p1"] = &Pane{ID: "p1", Name: "Shell #1"}
	// override List to inject sizeCols/sizeRows for paneID p1.
	fpm := &sizedPaneHub{fakePaneHub: pm, cols: 80, rows: 24}
	fw := newFakeWorkspaceStore()
	fw.entries = []workspace.PaneLabel{{
		PaneID: "p1", Label: "S1.P1.T1",
		SessionName: "Main", TabName: "Shell",
		IsActive:    true,
		SessionUUID: "su1", RegionUUID: "ru1",
		TabUUID: "tu1", ShortCode: "tu1short",
	}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{
		Panes:  fpm,
		Work:   fw,
		WhoAmI: fakeWhoAmIResolver{paneID: "p1", shellPID: 12345},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/whoami")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	var got map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&got)
	want := map[string]interface{}{
		"paneId":      "p1",
		"shellPid":    float64(12345),
		"label":       "S1.P1.T1",
		"uuid":        "tu1",
		"short":       "tu1short",
		"sizeCols":    float64(80),
		"sizeRows":    float64(24),
		"session":     "Main",
		"tab":         "Shell",
		"sessionUuid": "su1",
		"regionUuid":  "ru1",
		"focused":     true,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("key=%s got=%v want=%v", k, got[k], v)
		}
	}
}

// TC-API-WAI-2: 매칭 실패 → 404 + error JSON.
func TestApiWhoAmI_ResolveFails(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{
		Panes:  newFakePaneHub(),
		Work:   newFakeWorkspaceStore(),
		WhoAmI: fakeWhoAmIResolver{err: errors.New("clientPID=999 가 어느 pane 에도 속하지 않음")},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/whoami")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
	var got map[string]string
	json.NewDecoder(resp.Body).Decode(&got)
	if got["error"] == "" {
		t.Errorf("missing error field: %v", got)
	}
}

// TC-API-WAI-3: paneID 매칭은 됐으나 workspace entry 없음.
func TestApiWhoAmI_NoEntry(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("p1", "Shell #1")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{
		Panes:  pm,
		Work:   newFakeWorkspaceStore(),
		WhoAmI: fakeWhoAmIResolver{paneID: "p1", shellPID: 1234},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/whoami")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	var got map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&got)
	if got["paneId"] != "p1" || got["shellPid"] != float64(1234) {
		t.Errorf("paneId/shellPid mismatch: %v", got)
	}
	if got["label"] != "" || got["uuid"] != "" {
		t.Errorf("expected empty label/uuid: %v", got)
	}
}

// TC-API-WAI-5: POST → 404 (apiRoutes 패턴, method 미스 매칭 시 404).
func TestApiWhoAmI_MethodNotGet(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{
		Panes:  newFakePaneHub(),
		Work:   newFakeWorkspaceStore(),
		WhoAmI: fakeWhoAmIResolver{paneID: "p1"},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/whoami", "application/json", nil)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatalf("expected non-200 for POST, got 200")
	}
}

// WhoAmI 의존 미주입 → 500.
func TestApiWhoAmI_NilResolver(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{
		Panes: newFakePaneHub(), Work: newFakeWorkspaceStore(),
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/whoami")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

// sizedPaneHub은 fakePaneHub 위에 cols/rows 를 덧붙여 List() 응답에 sizeCols/sizeRows 를 넣는다.
type sizedPaneHub struct {
	*fakePaneHub
	cols int
	rows int
}

func (s *sizedPaneHub) List() []map[string]interface{} {
	out := s.fakePaneHub.List()
	for _, m := range out {
		m["sizeCols"] = s.cols
		m["sizeRows"] = s.rows
	}
	return out
}
