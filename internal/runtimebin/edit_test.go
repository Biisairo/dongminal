package runtimebin

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func withServer(t *testing.T, handler http.HandlerFunc) func() {
	t.Helper()
	srv := httptest.NewServer(handler)
	u, _ := url.Parse(srv.URL)
	t.Setenv("DONGMINAL_HOST", u.Hostname())
	t.Setenv("DONGMINAL_PORT", u.Port())
	return srv.Close
}

func TestRunEditHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runEdit(nil, &stdout, &stderr)
	if rc != 0 || !strings.Contains(stdout.String(), "edit") {
		t.Errorf("rc=%d out=%s", rc, stdout.String())
	}
}

func TestRunEditList(t *testing.T) {
	cleanup := withServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":"a","path":"/cs/a/","folder":"/foo"}]`))
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	rc := runEdit([]string{"--list"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if !strings.Contains(stdout.String(), "\033]777;CodeServerList;") {
		t.Errorf("missing OSC: %q", stdout.String())
	}
}

func TestRunEditStopAll(t *testing.T) {
	var stops int32
	cleanup := withServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Write([]byte(`[{"id":"a"},{"id":"b"}]`))
		case http.MethodPost:
			atomic.AddInt32(&stops, 1)
		}
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	rc := runEdit([]string{"-s", "all"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if stops != 2 {
		t.Errorf("stops=%d want 2", stops)
	}
}

func TestRunEditMissingPath(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runEdit([]string{"/no/such/path/at-all-xyz"}, &stdout, &stderr)
	if rc != 1 {
		t.Errorf("rc=%d", rc)
	}
}

func TestRunEditOpenPath(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "f.txt")
	os.WriteFile(target, []byte("x"), 0o644)
	cleanup := withServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"abc","path":"/cs/abc/","folder":"` + dir + `"}`))
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	rc := runEdit([]string{target}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if !strings.Contains(stdout.String(), "\033]777;OpenCodeServer;abc|") {
		t.Errorf("OSC missing: %q", stdout.String())
	}
}

func TestExtractCodeServerIDs(t *testing.T) {
	got := extractCodeServerIDs([]byte(`{"items":[{"id":"x"},{"id":"y"}]}`))
	if len(got) != 2 || got[0] != "x" || got[1] != "y" {
		t.Errorf("got=%v", got)
	}
}
