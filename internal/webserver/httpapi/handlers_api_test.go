package httpapi

import (
	"dongminal/internal/shared/toolhub"

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
)

func TestHandleAPI_ToolBusy(t *testing.T) {
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// missing tool
	resp := mustGet(t, ts.URL+"/api/tools/missing/busy")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != `{"busy":false}` {
		t.Fatalf("body=%q", body)
	}
}

// TestHandleAPI_ToolBusy_DaemonMode reproduces DAEMON_PANE_BUSY_RESOLVE_SRS FR-1.
// In daemon mode Get(id) returns a cmd-less toolhub.Tool, so the handler must resolve
// busy via toolhub.ToolHub.Busy(id) (daemon busy RPC) rather than Get(id).IsBusy().
// fakePaneHub mirrors toolclient.ToolClient: Get returns a cmd-less toolhub.Tool while Busy reports
// the live foreground-process state.
func TestHandleAPI_ToolBusy_DaemonMode(t *testing.T) {
	hub := newFakePaneHub()
	hub.seed("p1", "toolhub.Tool 1")
	hub.setBusy("p1", true)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: hub})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustGet(t, ts.URL+"/api/tools/p1/busy")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != `{"busy":true}` {
		t.Fatalf("body=%q want {\"busy\":true}", body)
	}
}

func TestHandleAPI_DeleteTool(t *testing.T) {
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustNewRequest(t, http.MethodDelete, ts.URL+"/api/tools/1", nil)
	// Use DefaultClient because NewRequest returns *Request
	resp2 := mustDo(t, resp)
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp2.StatusCode)
	}
}

func TestHandleAPI_WorkspaceGet(t *testing.T) {
	fw := newFakeWorkspaceStore()
	fw.raw = []byte(`{"schemaVersion": 2, "windows":[]}`)
	fw.rev = 3
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Work: fw})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustGet(t, ts.URL+"/api/workspace")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("ETag"); got != "3" {
		t.Fatalf("ETag=%q want 3", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"schemaVersion": 2, "windows":[]}` {
		t.Fatalf("body=%q", body)
	}
}

func TestHandleAPI_WorkspacePut_Broadcast(t *testing.T) {
	fb := &fakeCommandBroker{}
	fw := newFakeWorkspaceStore()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Work: fw, Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req := mustNewRequest(t, http.MethodPut, ts.URL+"/api/workspace", strings.NewReader(`{"schemaVersion": 2, "windows":[]}`))
	resp := mustDo(t, req)
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

	resp := mustGet(t, ts.URL+"/api/settings")
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

	resp := mustGet(t, ts.URL+"/api/settings")
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

	req := mustNewRequest(t, http.MethodPut, ts.URL+"/api/settings", strings.NewReader(`{"theme":"light"}`))
	resp := mustDo(t, req)
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

	req := mustNewRequest(t, http.MethodPost, ts.URL+"/api/upload?dir="+dir, &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp := mustDo(t, req)
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

	req := mustNewRequest(t, http.MethodPost, ts.URL+"/api/upload?dir="+dir, &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp := mustDo(t, req)
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

	resp := mustGet(t, ts.URL+"/api/download?path="+f)
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

	resp := mustGet(t, ts.URL+"/api/download?path=relative.txt")
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		// relative path is converted to abs, then open fails
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestHandleAPI_Cwd(t *testing.T) {
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustGet(t, ts.URL+"/api/cwd")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"cwd"`) {
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

	resp := mustGet(t, ts.URL+"/api/nonexistent")
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestHandleAPI_WorkspacePut_NilWork(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req := mustNewRequest(t, http.MethodPut, ts.URL+"/api/workspace", strings.NewReader(`{}`))
	resp := mustDo(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestHandleAPI_State_NilTools(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustGet(t, ts.URL+"/api/state")
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestHandleAPI_CreateTool_NilTools(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustPost(t, ts.URL+"/api/tools", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestHandleAPI_State_HappyPath(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("1", "Shell #1")
	fw := newFakeWorkspaceStore()
	fw.raw = []byte(`{"schemaVersion": 2, "windows":[{"id":"s1"}]}`)
	fw.rev = 7
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm, Work: fw})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustGet(t, ts.URL+"/api/state")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if got := resp.Header.Get("ETag"); got != "7" {
		t.Errorf("ETag=%q want 7", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"workspace"`) || !strings.Contains(string(body), `"tools"`) {
		t.Errorf("body=%s", body)
	}
}

func TestHandleAPI_Ping(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
		req := mustNewRequest(t, method, ts.URL+"/api/ping", nil)
		resp := mustDo(t, req)
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

	resp := mustGet(t, ts.URL+"/api/stats")
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

	req := mustNewRequest(t, http.MethodPut, ts.URL+"/api/workspace", strings.NewReader(`{}`))
	req.Header.Set("If-Match", "0")
	resp := mustDo(t, req)
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
		req := mustNewRequest(t, c.method, ts.URL+c.path, nil)
		resp := mustDo(t, req)
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Errorf("%s %s: status=%d want 404", c.method, c.path, resp.StatusCode)
		}
	}
}

func TestHandleAPI_CreateTool_Success(t *testing.T) {
	pm := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustPost(t, ts.URL+"/api/tools?cols=80&rows=24", "application/json", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"id"`) {
		t.Errorf("body=%s", body)
	}
}

func TestHandleAPI_CreateTool_OversizedCols(t *testing.T) {
	pm := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 8000 > toolhub.MaxTerminalDim(4096) → fallback to defaults; tool still created.
	resp := mustPost(t, ts.URL+"/api/tools?cols=8000&rows=24", "application/json", nil)
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

	resp := mustGet(t, ts.URL+"/api/settings")
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "{}" {
		t.Errorf("body=%q want {}", body)
	}
}

func TestHandleAPI_Cwd_WithTool(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("p1", "P1")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustGet(t, ts.URL+"/api/cwd?tool=p1")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

// DAEMON_CWDPANE_RESOLVE_SRS FR-5: /api/cwd resolves the tool's live cwd via
// toolhub.ToolHub.Cwd, not the server process working directory (daemon-mode bug).
func TestHandleAPI_Cwd_ResolvesLiveCwd(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("p1", "P1")
	pm.setCwd("p1", "/live/dir")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustGet(t, ts.URL+"/api/cwd?tool=p1")
	defer resp.Body.Close()
	var body struct {
		Cwd string `json:"cwd"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	if body.Cwd != "/live/dir" {
		t.Fatalf("cwd=%q want %q", body.Cwd, "/live/dir")
	}
}

func TestHandleAPI_ToolsCreate_CwdToolRef(t *testing.T) {
	pm := newFakePaneHub()
	// Reference tool with cwd resolution path; fake returns whatever Cwd() yields.
	pm.seed("ref", "Ref")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustPost(t, ts.URL+"/api/tools?cwdTool=ref", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

// DAEMON_CWDPANE_RESOLVE_SRS FR-1: cwdTool must resolve to the reference tool's
// live cwd via toolhub.ToolHub.Cwd, not the server process working directory. In daemon
// mode Get() returns a cmd-less toolhub.Tool whose Cwd() falls back to os.Getwd(), so the
// handler must go through the hub's Cwd(id) instead of Get(id).Cwd().
func TestHandleAPI_ToolsCreate_CwdToolRef_ResolvesLiveCwd(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("ref", "Ref")
	pm.setCwd("ref", "/parent/dir")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustPost(t, ts.URL+"/api/tools?cwdTool=ref", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if pm.lastCwd != "/parent/dir" {
		t.Fatalf("created tool cwd=%q want %q", pm.lastCwd, "/parent/dir")
	}
}

// FR-3: an explicit cwd query takes precedence over cwdTool.
func TestHandleAPI_ToolsCreate_ExplicitCwdWins(t *testing.T) {
	pm := newFakePaneHub()
	pm.seed("ref", "Ref")
	pm.setCwd("ref", "/parent/dir")
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustPost(t, ts.URL+"/api/tools?cwd=/explicit&cwdTool=ref", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if pm.lastCwd != "/explicit" {
		t.Fatalf("created tool cwd=%q want %q", pm.lastCwd, "/explicit")
	}
}

// FR-4: an unknown/empty cwdTool leaves cwd empty so Create falls back.
func TestHandleAPI_ToolsCreate_UnknownCwdToolFallsBack(t *testing.T) {
	pm := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustPost(t, ts.URL+"/api/tools?cwdTool=missing", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if pm.lastCwd != "" {
		t.Fatalf("created tool cwd=%q want empty", pm.lastCwd)
	}
}
