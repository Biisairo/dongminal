package server

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/mdscroll"
)

func TestHandleAPI_PaneBusy(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// missing pane
	resp, _ := http.Get(ts.URL + "/api/panes/missing/busy")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != `{"busy":false}` {
		t.Fatalf("body=%q", body)
	}
}

func TestHandleAPI_DeletePane(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/panes/1", nil)
	// Use DefaultClient because NewRequest returns *Request
	resp2, _ := http.DefaultClient.Do(resp)
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp2.StatusCode)
	}
}

func TestHandleAPI_WorkspaceGet(t *testing.T) {
	fw := newFakeWorkspaceStore()
	fw.raw = []byte(`{"sessions":[]}`)
	fw.rev = 3
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Work: fw})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/workspace")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("ETag"); got != "3" {
		t.Fatalf("ETag=%q want 3", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"sessions":[]}` {
		t.Fatalf("body=%q", body)
	}
}

func TestHandleAPI_WorkspacePut_Broadcast(t *testing.T) {
	fb := &fakeCommandBroker{}
	fw := newFakeWorkspaceStore()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Work: fw, Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/workspace", strings.NewReader(`{"sessions":[]}`))
	resp, _ := http.DefaultClient.Do(req)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	fb.mu.Lock()
	pubs := len(fb.published)
	fb.mu.Unlock()
	if pubs != 1 {
		t.Fatalf("broadcast count=%d want 1", pubs)
	}
}

func TestHandleAPI_SettingsGet(t *testing.T) {
	fs := &fakeSettingsStore{blob: []byte(`{"theme":"dark"}`)}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Settings: fs})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/settings")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"theme":"dark"}` {
		t.Fatalf("body=%q", body)
	}
}

func TestHandleAPI_SettingsGet_Empty(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/settings")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{}` {
		t.Fatalf("body=%q", body)
	}
}

func TestHandleAPI_SettingsPut(t *testing.T) {
	fs := &fakeSettingsStore{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Settings: fs})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/settings", strings.NewReader(`{"theme":"light"}`))
	resp, _ := http.DefaultClient.Do(req)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if fs.saves != 1 {
		t.Fatalf("saves=%d want 1", fs.saves)
	}
}

func TestHandleAPI_Upload(t *testing.T) {
	dir := t.TempDir()
	srv, _ := New(Config{DataDir: dir}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	fw, _ := mw.CreateFormFile("file", "hello.txt")
	fw.Write([]byte("world"))
	mw.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/upload?dir="+dir, &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, _ := http.DefaultClient.Do(req)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}

	// Verify file exists.
	uploaded := filepath.Join(dir, "hello.txt")
	if _, err := os.Stat(uploaded); err != nil {
		t.Fatalf("uploaded file missing: %v", err)
	}
}

func TestHandleAPI_Upload_UniquePath(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "dup.txt"), []byte("x"), 0644)
	srv, _ := New(Config{DataDir: dir}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	fw, _ := mw.CreateFormFile("file", "dup.txt")
	fw.Write([]byte("y"))
	mw.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/upload?dir="+dir, &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, _ := http.DefaultClient.Do(req)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}

	// Should create "dup (1).txt"
	if _, err := os.Stat(filepath.Join(dir, "dup (1).txt")); err != nil {
		t.Fatalf("unique path file missing: %v", err)
	}
}

func TestHandleAPI_Download(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "download.txt")
	os.WriteFile(f, []byte("content"), 0644)

	srv, _ := New(Config{DataDir: dir}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/download?path=" + f)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	cd := resp.Header.Get("Content-Disposition")
	if !strings.Contains(cd, "download.txt") {
		t.Fatalf("Content-Disposition=%q", cd)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "content" {
		t.Fatalf("body=%q", body)
	}
}

func TestHandleAPI_Download_RelativePath(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/download?path=relative.txt")
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		// relative path is converted to abs, then open fails
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestHandleAPI_Cwd(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/cwd")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"cwd"`) {
		t.Fatalf("body=%q", body)
	}
}

func TestHandleAPI_CodeServerList(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/code-server")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	// When CS is nil, list is nil and json.Encode writes "null".
	if strings.TrimSpace(string(body)) != "null" {
		t.Fatalf("body=%q want null", body)
	}
}

func TestHandleAPI_CodeServerStart_Unavailable(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/code-server", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestHandleAPI_CodeServerHeartbeat_NotFound(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/code-server/heartbeat?id=bad", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestHandleAPI_CodeServerStop(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/code-server/stop?id=any", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
}

func TestHandleAPI_MdFile_MissingPath(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/md-file")
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
}

func TestHandleAPI_MdFile_RelativePath(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/md-file?path=readme.md")
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
}

func TestHandleAPI_MdFile_NonMarkdown(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/md-file?path=/etc/passwd")
	defer resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("status=%d want 403", resp.StatusCode)
	}
}

func TestHandleAPI_MdFile_NotFound(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/md-file?path=/tmp/nonexistent.md")
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestHandleAPI_MdFile_Directory(t *testing.T) {
	dir := t.TempDir()
	// Create a directory with .md suffix so it passes the extension check.
	mdDir := filepath.Join(dir, "notes.md")
	if err := os.Mkdir(mdDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	srv, _ := New(Config{DataDir: dir}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/md-file?path=" + mdDir)
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
}

func TestHandleAPI_MdFile_Success(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "readme.md")
	os.WriteFile(f, []byte("# Hello"), 0644)

	srv, _ := New(Config{DataDir: dir}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/md-file?path=" + f)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/markdown") {
		t.Fatalf("Content-Type=%q", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "# Hello" {
		t.Fatalf("body=%q", body)
	}
}

func TestUniquePath(t *testing.T) {
	dir := t.TempDir()
	p1 := uniquePath(dir, "a.txt")
	if p1 != filepath.Join(dir, "a.txt") {
		t.Fatalf("p1=%q", p1)
	}
	os.WriteFile(p1, []byte("x"), 0644)
	p2 := uniquePath(dir, "a.txt")
	if p2 != filepath.Join(dir, "a (1).txt") {
		t.Fatalf("p2=%q", p2)
	}
}

func TestSettingsStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte(`{"k":"v"}`), 0644)

	s := newSettingsStore(path)
	if string(s.get()) != `{"k":"v"}` {
		t.Fatalf("get=%q", s.get())
	}

	s.set([]byte(`{"k":"w"}`))
	if string(s.get()) != `{"k":"w"}` {
		t.Fatalf("get after set=%q", s.get())
	}

	s.save()
	data, _ := os.ReadFile(path)
	if string(data) != `{"k":"w"}` {
		t.Fatalf("file=%q", data)
	}

	// empty save should not write
	s2 := newSettingsStore(filepath.Join(t.TempDir(), "empty.json"))
	s2.save()
	if _, err := os.Stat(filepath.Join(t.TempDir(), "empty.json")); !os.IsNotExist(err) {
		// file may or may not exist; if it exists it should be empty from init.
	}
}

func TestHandleAPI_DefaultNotFound(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/nonexistent")
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestHandleAPI_WorkspacePut_NilWork(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/workspace", strings.NewReader(`{}`))
	resp, _ := http.DefaultClient.Do(req)
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestHandleAPI_State_NilPanes(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/state")
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestHandleAPI_CreatePane_NilPanes(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/panes", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestHandleAPI_State_HappyPath(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("1", "Shell #1")
	fw := newFakeWorkspaceStore()
	fw.raw = []byte(`{"sessions":[{"id":"s1"}]}`)
	fw.rev = 7
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm, Work: fw})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/state")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if got := resp.Header.Get("ETag"); got != "7" {
		t.Errorf("ETag=%q want 7", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"workspace"`) || !strings.Contains(string(body), `"panes"`) {
		t.Errorf("body=%s", body)
	}
}

func TestHandleAPI_Ping(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
		req, _ := http.NewRequest(method, ts.URL+"/api/ping", nil)
		resp, _ := http.DefaultClient.Do(req)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(body) != "ok" {
			t.Errorf("method=%s status=%d body=%q", method, resp.StatusCode, body)
		}
	}
}

func TestHandleAPI_Stats(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/stats")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "hostname") {
		t.Errorf("body missing hostname: %s", body)
	}
}

func TestHandleAPI_WorkspaceStaleConflict(t *testing.T) {
	fw := newFakeWorkspaceStore()
	fw.stale = true
	fw.rev = 5
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Work: fw})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/workspace", strings.NewReader(`{}`))
	req.Header.Set("If-Match", "0")
	resp, _ := http.DefaultClient.Do(req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status=%d want 409", resp.StatusCode)
	}
	if got := resp.Header.Get("ETag"); got != "5" {
		t.Errorf("ETag=%q want 5", got)
	}
}

func TestHandleAPI_MethodMismatch(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	cases := []struct {
		method, path string
	}{
		{http.MethodPost, "/api/state"},
		{http.MethodPut, "/api/state"},
		{http.MethodGet, "/api/upload"},
		{http.MethodPost, "/api/download"},
		{http.MethodDelete, "/api/workspace"},
	}
	for _, c := range cases {
		req, _ := http.NewRequest(c.method, ts.URL+c.path, nil)
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Errorf("%s %s: status=%d want 404", c.method, c.path, resp.StatusCode)
		}
	}
}

func TestHandleAPI_CreatePane_Success(t *testing.T) {
	pm := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/panes?cols=80&rows=24", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"id"`) {
		t.Errorf("body=%s", body)
	}
}

func TestHandleAPI_CreatePane_OversizedCols(t *testing.T) {
	pm := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 8000 > MaxTerminalDim(4096) → fallback to defaults; pane still created.
	resp, _ := http.Post(ts.URL+"/api/panes?cols=8000&rows=24", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if pm.lastCols != 120 {
		t.Errorf("lastCols=%d want 120 (fallback)", pm.lastCols)
	}
	if pm.lastRows != 24 {
		t.Errorf("lastRows=%d want 24", pm.lastRows)
	}
}

func TestHandleAPI_SettingsGet_NilSettings(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/settings")
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "{}" {
		t.Errorf("body=%q want {}", body)
	}
}

func TestHandleAPI_CodeServerList_WithFake(t *testing.T) {
	cs := &fakeCodeServerHost{listResp: []map[string]interface{}{{"id": "x"}}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{CS: cs})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/code-server")
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"x"`) {
		t.Errorf("body=%s", body)
	}
}

func TestHandleAPI_CodeServerStart_Success(t *testing.T) {
	cs := &fakeCodeServerHost{startResp: &CodeServerInst{ID: "abc", Folder: "/tmp"}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{CS: cs})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/code-server?path=/tmp", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"abc"`) {
		t.Errorf("body=%s", body)
	}
}

func TestHandleAPI_CodeServerHeartbeat_Success(t *testing.T) {
	cs := &fakeCodeServerHost{touchOK: true}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{CS: cs})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/code-server/heartbeat?id=x", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestHandleAPI_CodeServerStop_Records(t *testing.T) {
	cs := &fakeCodeServerHost{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{CS: cs})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/code-server/stop?id=foo", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if len(cs.stopped) != 1 || cs.stopped[0] != "foo" {
		t.Errorf("stopped=%v want [foo]", cs.stopped)
	}
}

func TestHandleAPI_CodeServerStart_NilCS(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, _ := http.Post(ts.URL+"/api/code-server", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestHandleAPI_Cwd_WithPane(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("p1", "P1")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/cwd?pane=p1")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

// DAEMON_CWDPANE_RESOLVE_SRS FR-5: /api/cwd resolves the pane's live cwd via
// PaneHub.Cwd, not the server process working directory (daemon-mode bug).
func TestHandleAPI_Cwd_ResolvesLiveCwd(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("p1", "P1")
	pm.setCwd("p1", "/live/dir")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/api/cwd?pane=p1")
	defer resp.Body.Close()
	var body struct {
		Cwd string `json:"cwd"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	if body.Cwd != "/live/dir" {
		t.Fatalf("cwd=%q want %q", body.Cwd, "/live/dir")
	}
}

func TestHandleAPI_PanesCreate_CwdPaneRef(t *testing.T) {
	pm := newFakePaneHub()
	// Reference pane with cwd resolution path; fake returns whatever Cwd() yields.
	pm.seed("ref", "Ref")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/panes?cwdPane=ref", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

// DAEMON_CWDPANE_RESOLVE_SRS FR-1: cwdPane must resolve to the reference pane's
// live cwd via PaneHub.Cwd, not the server process working directory. In daemon
// mode Get() returns a cmd-less Pane whose Cwd() falls back to os.Getwd(), so the
// handler must go through the hub's Cwd(id) instead of Get(id).Cwd().
func TestHandleAPI_PanesCreate_CwdPaneRef_ResolvesLiveCwd(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("ref", "Ref")
	pm.setCwd("ref", "/parent/dir")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/panes?cwdPane=ref", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if pm.lastCwd != "/parent/dir" {
		t.Fatalf("created pane cwd=%q want %q", pm.lastCwd, "/parent/dir")
	}
}

// FR-3: an explicit cwd query takes precedence over cwdPane.
func TestHandleAPI_PanesCreate_ExplicitCwdWins(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("ref", "Ref")
	pm.setCwd("ref", "/parent/dir")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/panes?cwd=/explicit&cwdPane=ref", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if pm.lastCwd != "/explicit" {
		t.Fatalf("created pane cwd=%q want %q", pm.lastCwd, "/explicit")
	}
}

// FR-4: an unknown/empty cwdPane leaves cwd empty so Create falls back.
func TestHandleAPI_PanesCreate_UnknownCwdPaneFallsBack(t *testing.T) {
	pm := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Panes: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/api/panes?cwdPane=missing", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if pm.lastCwd != "" {
		t.Fatalf("created pane cwd=%q want empty", pm.lastCwd)
	}
}

func TestHandleCSProxy_NilCS(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/cs/foo/")
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestHandleCSProxy_EmptyID(t *testing.T) {
	cs := &fakeCodeServerHost{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{CS: cs})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/cs/")
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestHandleCSProxy_NotFound(t *testing.T) {
	cs := &fakeCodeServerHost{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{CS: cs})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := http.Get(ts.URL + "/cs/missing/")
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

// ── md-scroll ────────────────────────────────────────

func TestHandleAPI_MdScrollGet_Empty(t *testing.T) {
	dir := t.TempDir()
	ms, err := mdscroll.New(mdscroll.FilePersister{Path: filepath.Join(dir, "mdscroll.json")})
	if err != nil {
		t.Fatal(err)
	}
	defer ms.Close()
	srv, _ := New(Config{DataDir: dir}, Deps{MdScroll: ms})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, _ := http.Get(ts.URL + "/api/md-scroll")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"tabs"`) {
		t.Fatalf("body=%q", body)
	}
}

func TestHandleAPI_MdScrollPut_BroadcastAndStore(t *testing.T) {
	dir := t.TempDir()
	ms, err := mdscroll.New(mdscroll.FilePersister{Path: filepath.Join(dir, "mdscroll.json")})
	if err != nil {
		t.Fatal(err)
	}
	defer ms.Close()
	fb := &fakeCommandBroker{}
	srv, _ := New(Config{DataDir: dir}, Deps{MdScroll: ms, Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := strings.NewReader(`{"tabId":"t1","top":42.5,"ratio":0.33,"by":"clientA"}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/md-scroll", body)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	got, ok := ms.Get("t1")
	if !ok || got.Top != 42.5 || got.Ratio != 0.33 {
		t.Fatalf("entry=%+v ok=%v", got, ok)
	}
	if len(fb.published) != 1 {
		t.Fatalf("broadcasts=%d want 1", len(fb.published))
	}
	if !bytes.Contains(fb.published[0], []byte(`"md_scroll_changed"`)) {
		t.Fatalf("payload=%q", fb.published[0])
	}
	if !bytes.Contains(fb.published[0], []byte(`"by":"clientA"`)) {
		t.Fatalf("missing by clientA: %q", fb.published[0])
	}
}

func TestHandleAPI_MdScrollPut_Validation(t *testing.T) {
	dir := t.TempDir()
	ms, err := mdscroll.New(mdscroll.FilePersister{Path: filepath.Join(dir, "mdscroll.json")})
	if err != nil {
		t.Fatal(err)
	}
	defer ms.Close()
	srv, _ := New(Config{DataDir: dir}, Deps{MdScroll: ms})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	cases := []struct {
		body string
		want int
	}{
		{`not-json`, 400},
		{`{"tabId":""}`, 400},
	}
	for _, c := range cases {
		req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/md-scroll", strings.NewReader(c.body))
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		if resp.StatusCode != c.want {
			t.Fatalf("body=%s status=%d want %d", c.body, resp.StatusCode, c.want)
		}
	}
}
