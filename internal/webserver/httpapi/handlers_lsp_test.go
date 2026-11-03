package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/ext"
	"dongminal/internal/webserver/domain/lsp"
)

type fakeLSP struct {
	statuses  []ext.Status
	problems  []string
	installID string
	outcome   ext.Outcome

	paths    map[string]string
	setPaths map[string]string
	setErr   error

	notified chan []lsp.FileEvent

	tunnel       lsp.Tunnel
	tunnelErr    error
	tunnelRoot   string
	tunnelDesc   string
	tunnelOpened int
}

func (f *fakeLSP) Status() ([]ext.Status, []string) {
	return f.statuses, f.problems
}

func (f *fakeLSP) Paths() map[string]string { return f.paths }

func (f *fakeLSP) NotifyFiles(e []lsp.FileEvent) {
	if f.notified != nil {
		f.notified <- e
	}
}

func (f *fakeLSP) SetPaths(p map[string]string) (map[string]string, error) {
	f.setPaths = p
	if f.setErr != nil {
		return nil, f.setErr
	}
	f.paths = p
	return p, nil
}

func (f *fakeLSP) Install(_ context.Context, id string) ext.Outcome {
	f.installID = id
	return f.outcome
}

// TC-LSP-30 (FR-LSP-46): 상태 조회가 서술자 목록을 돌려준다.
func TestLSPStatus(t *testing.T) {
	f := &fakeLSP{statuses: []ext.Status{
		{Pack: "gopls", ID: "gopls", Langs: []string{"go"}, Found: true, Exe: "/usr/bin/gopls", Origin: ext.OriginPath, CanInstall: true},
		{Pack: "pyright", ID: "pyright", Langs: []string{"python"},
			Missing: &ext.Missing{Kind: ext.MissingRuntime, Name: "node"}},
	}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: f})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/lsp/status", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("상태 조회가 %d 를 냈다", resp.StatusCode)
	}
	var got struct {
		Servers []ext.Status `json:"servers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Servers) != 2 {
		t.Fatalf("서술자 줄 수가 다르다: %d", len(got.Servers))
	}
	if got.Servers[0].Origin != ext.OriginPath {
		t.Fatalf("어디서 찾았는지가 실리지 않았다: %+v", got.Servers[0])
	}
}

// REPO_FIX 02 §3A-3: 경로 표는 서버가 보관한다 — 조회 GET, 저장 PUT(전체 교체).
func TestLSPPaths_GetPut(t *testing.T) {
	f := &fakeLSP{paths: map[string]string{"gopls/gopls": "/opt/gopls"}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: f})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/lsp/paths")
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Paths map[string]string `json:"paths"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&got)
	resp.Body.Close()
	if resp.StatusCode != 200 || got.Paths["gopls/gopls"] != "/opt/gopls" {
		t.Fatalf("GET = %d %+v", resp.StatusCode, got)
	}

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/lsp/paths", strings.NewReader(`{"paths":{"gopls/gopls":"/usr/local/bin/gopls"}}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || f.setPaths["gopls/gopls"] != "/usr/local/bin/gopls" {
		t.Fatalf("PUT = %d, 받은 표 %+v", resp.StatusCode, f.setPaths)
	}
}

// 거부 코드: 모르는 서버 400 bad_request, 상대경로 400 path_must_be_absolute, 저장 실패
// 500 save_failed.
func TestLSPPaths_PutErrors(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{lsp.ErrUnknownServer, 400, "bad_request"},
		{lsp.ErrPathNotAbsolute, 400, "path_must_be_absolute"},
		{lsp.ErrPathsSave, 500, "save_failed"},
	}
	for _, c := range cases {
		f := &fakeLSP{setErr: c.err}
		srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: f})
		ts := httptest.NewServer(srv.Handler())
		req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/lsp/paths", strings.NewReader(`{"paths":{"x":"y"}}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		ts.Close()
		if resp.StatusCode != c.status || resp.Header.Get("X-Error-Code") != c.code {
			t.Fatalf("%v = %d %s, want %d %s", c.err, resp.StatusCode, resp.Header.Get("X-Error-Code"), c.status, c.code)
		}
	}
}

// TC-LSP-32 (FR-LSP-8·10): 설치는 id 를 받아 결과를 돌려준다. 실패도 200 으로
// **사유와 함께** 온다 — 조용히 실패하지 않는다.
func TestLSPInstall(t *testing.T) {
	f := &fakeLSP{outcome: ext.Outcome{Reason: "go 가 이 기계에 없어…"}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: f})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/lsp/install", "application/json",
		strings.NewReader(`{"id":"gopls"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("설치 종단이 %d 를 냈다 — 사유를 실은 결과는 200 이다", resp.StatusCode)
	}
	if f.installID != "gopls" {
		t.Fatalf("id 가 넘어가지 않았다: %q", f.installID)
	}
	var got ext.Outcome
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.OK || got.Reason == "" {
		t.Fatalf("사유가 실리지 않았다: %+v", got)
	}
}

// TC-LSP-33 (FR-LSP-8): id 없는 설치는 거절된다.
func TestLSPInstall_NeedsID(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: &fakeLSP{}})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/lsp/install", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatal("id 없이 설치가 받아들여졌다")
	}
}

// TC-LSP-34: LSP 가 배선되지 않은 서버는 503 이며, **그 밖의 동작에는 영향이 없다** —
// 코드 탐색이 없는 편집기는 종전의 편집기다 (NFR-RUN-1 과 같은 근거).
func TestLSP_UnwiredIs503(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, path := range []string{"/api/lsp/status", "/api/lsp/install"} {
		resp, err := http.Post(ts.URL+path, "application/json", strings.NewReader(`{"id":"gopls"}`))
		if err != nil {
			t.Fatal(err)
		}
		code := resp.StatusCode
		resp.Body.Close()
		if code != http.StatusServiceUnavailable {
			t.Fatalf("%s 가 %d 를 냈다 — 배선이 없으면 503 이다", path, code)
		}
	}
	// 다른 종단은 멀쩡하다.
	resp := mustGet(t, ts.URL+"/api/ping")
	if resp.StatusCode != 200 {
		t.Fatalf("LSP 가 없다고 /api/ping 이 %d 를 냈다", resp.StatusCode)
	}
	resp.Body.Close()
}

// lspTestRoot 는 Editor 목록에 심을 루트다. 서버는 클라이언트가 보낸 root 를
// 신뢰하지 않으므로(FR-EDT-113) 가드를 지나려면 실제로 등록돼 있어야 한다.
var lspTestRoot = testpath.Root()

// lspServerWithRoot 는 루트가 등록된 서버를 세운다 — `fsRoot` 가드가 통과할 수
// 있는 최소 배선이다.
func lspServerWithRoot(t *testing.T, f LSPService) (*Server, *httptest.Server) {
	t.Helper()
	ws := newFakeWorkspaceStore()
	seedRoot(t, ws, lspTestRoot)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: f, Work: ws})
	return srv, httptest.NewServer(srv.Handler())
}

// lspBody 는 루트 아래 파일 하나를 가리키는 요청 본문이다.
//
// **경로를 날것으로 끼우지 않는다** (WINDOWS_TEST_PARITY_SRS FR-WTP-20). `C:\Users`
// 의 `\U` 는 유효하지 않은 JSON 이스케이프이므로 본문 전체가 깨지고, 오류가 파싱
// 단계에서 나므로 정작 재려던 것은 시작도 못 한다 — 종단이 400 을 내고 그 400 은
// 가드의 400 과 구별되지 않는다. 파일 이름을 잇는 것도 `filepath.Join` 이다:
// `root + "/a.go"` 는 Windows 에서 구분자가 섞인 경로가 된다.
func lspBody(name, extra string) string {
	b := `{"root":` + testpath.JSONQuote(lspTestRoot) +
		`,"path":` + testpath.JSONQuote(filepath.Join(lspTestRoot, name))
	if extra != "" {
		b += "," + extra
	}
	return b + "}"
}

func (f *fakeLSP) OpenTunnel(root, descID string) (lsp.Tunnel, error) {
	f.tunnelRoot, f.tunnelDesc = root, descID
	f.tunnelOpened++
	if f.tunnelErr != nil {
		return nil, f.tunnelErr
	}
	return f.tunnel, nil
}

// CODEMIRROR_MIGRATION_SRS FR-CMR-110: 파일을 쓰면 통로에 알린다 — 없던 파일은 Created, 있던 파일은 Changed.
func TestFileWrite_NotifiesWatchedFiles(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeLSP{notified: make(chan []lsp.FileEvent, 2)}
	ws := newFakeWorkspaceStore()
	seedRoot(t, ws, root)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: f, Work: ws})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	p := filepath.Join(root, "a.go")
	write := func() {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"path": p, "content": "package a\n"})
		resp, err := http.Post(ts.URL+"/api/file/write", "application/json", strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("write = %d", resp.StatusCode)
		}
	}
	for i, want := range []int{lsp.WatchCreated, lsp.WatchChanged} {
		write()
		select {
		case got := <-f.notified:
			if len(got) != 1 || got[0].Path != p || got[0].Type != want {
				t.Fatalf("%d번째 쓰기의 알림 = %+v (want %s %d)", i+1, got, p, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%d번째 쓰기 뒤 알림이 없다", i+1)
		}
	}
}
