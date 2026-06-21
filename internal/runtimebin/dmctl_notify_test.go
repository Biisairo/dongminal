package runtimebin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// pointDmctlAtServer points dmctl's HTTP client at ts and sets a pane id.
func pointDmctlAtServer(t *testing.T, ts *httptest.Server, paneID string) {
	t.Helper()
	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	t.Setenv("DONGMINAL_HOST", u.Hostname())
	t.Setenv("DONGMINAL_PORT", u.Port())
	t.Setenv("DONGMINAL_PANE_ID", paneID)
}

func TestDmctlNotify_PostsToServer(t *testing.T) {
	var gotPath string
	var got struct {
		PaneID string `json:"paneId"`
		Reason string `json:"reason"`
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer ts.Close()
	pointDmctlAtServer(t, ts, "7")

	if code := runDmctlNotify([]string{"done"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if gotPath != "/api/panes/attention/set" {
		t.Fatalf("POST path = %q, want /api/panes/attention/set", gotPath)
	}
	if got.PaneID != "7" || got.Reason != "done" {
		t.Fatalf("server received %+v, want {PaneID:7 Reason:done}", got)
	}
}

func TestDmctlNotify_DefaultReason(t *testing.T) {
	var got struct {
		Reason string `json:"reason"`
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer ts.Close()
	pointDmctlAtServer(t, ts, "1")

	runDmctlNotify(nil, io.Discard, io.Discard)
	if got.Reason != "attention" {
		t.Fatalf("default reason = %q, want attention", got.Reason)
	}
}

func TestDmctlNotify_RequiresPaneID(t *testing.T) {
	// No server should be hit; just assert it fails clearly without a pane id.
	t.Setenv("DONGMINAL_PANE_ID", "")
	if code := runDmctlNotify([]string{"done"}, io.Discard, io.Discard); code == 0 {
		t.Fatalf("expected non-zero exit without DONGMINAL_PANE_ID")
	}
}

func TestSanitizeNotifyLabel(t *testing.T) {
	if got := sanitizeNotifyLabel("a\x07b\x1bc"); got != "abc" {
		t.Fatalf("sanitize control chars: got %q", got)
	}
	if got := sanitizeNotifyLabel(""); got != "attention" {
		t.Fatalf("empty -> %q, want attention", got)
	}
}
