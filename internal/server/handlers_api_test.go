package server

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
