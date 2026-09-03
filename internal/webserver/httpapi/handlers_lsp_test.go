package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/lsp"
)

type fakeLSP struct {
	statuses   []lsp.Status
	gotOverrid map[string]string
	installID  string
	outcome    lsp.InstallOutcome

	locs    []lsp.Location
	locErr  error
	askRoot string
	askPath string
	askText string
	askLine int
	askCol  int
	askIncl bool
}

func (f *fakeLSP) Status(overrides map[string]string) []lsp.Status {
	f.gotOverrid = overrides
	return f.statuses
}

func (f *fakeLSP) Install(_ context.Context, id string) lsp.InstallOutcome {
	f.installID = id
	return f.outcome
}

func (f *fakeLSP) Definition(_ context.Context, root, path, text string, line, col int) ([]lsp.Location, error) {
	f.askRoot, f.askPath, f.askText, f.askLine, f.askCol = root, path, text, line, col
	return f.locs, f.locErr
}

func (f *fakeLSP) References(_ context.Context, root, path, text string, line, col int, incl bool) ([]lsp.Location, error) {
	f.askRoot, f.askPath, f.askText, f.askLine, f.askCol, f.askIncl = root, path, text, line, col, incl
	return f.locs, f.locErr
}

// TC-LSP-30 (FR-LSP-46): 상태 조회가 서술자 목록을 돌려준다.
func TestLSPStatus(t *testing.T) {
	f := &fakeLSP{statuses: []lsp.Status{
		{ID: "gopls", Langs: []string{"go"}, Found: true, Exe: "/usr/bin/gopls", Origin: lsp.OriginPath, CanInstall: true},
		{ID: "pyright", Langs: []string{"python"}, Installer: "npm"},
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
		Servers []lsp.Status `json:"servers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Servers) != 2 {
		t.Fatalf("서술자 줄 수가 다르다: %d", len(got.Servers))
	}
	if got.Servers[0].Origin != lsp.OriginPath {
		t.Fatalf("어디서 찾았는지가 실리지 않았다: %+v", got.Servers[0])
	}
}

// TC-LSP-31 (FR-LSP-4b): 요청이 실은 절대경로 표가 서비스로 그대로 넘어간다.
// 설정 블롭은 서버가 해석하지 않으므로 이 길이 유일하다.
func TestLSPStatus_PassesOverrides(t *testing.T) {
	f := &fakeLSP{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: f})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"overrides":{"gopls":"/opt/gopls"}}`
	resp, err := http.Post(ts.URL+"/api/lsp/status", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if f.gotOverrid["gopls"] != "/opt/gopls" {
		t.Fatalf("절대경로 표가 넘어가지 않았다: %+v", f.gotOverrid)
	}
}

// TC-LSP-32 (FR-LSP-8·10): 설치는 id 를 받아 결과를 돌려준다. 실패도 200 으로
// **사유와 함께** 온다 — 조용히 실패하지 않는다.
func TestLSPInstall(t *testing.T) {
	f := &fakeLSP{outcome: lsp.InstallOutcome{Reason: "go 가 이 기계에 없어…"}}
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
	var got lsp.InstallOutcome
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

// TC-LSP-35 (FR-LSP-21·23 / D-3): 정의 요청은 **현재 텍스트를 함께** 싣고, 줄·열은
// 1 부터다. 텍스트가 없으면 디스크만 보는 서버가 방금 쓴 함수를 모른다.
func TestLSPDefinition(t *testing.T) {
	f := &fakeLSP{locs: []lsp.Location{{Path: "/root/other.go", Line: 42, Col: 8}}}
	srv, ts := lspServerWithRoot(t, f)
	defer ts.Close()

	body := `{"root":"` + lspTestRoot + `","path":"` + lspTestRoot + `/a.go","text":"package a\n","line":3,"col":5}`
	resp, err := http.Post(ts.URL+"/api/lsp/definition", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("정의 종단이 %d 를 냈다", resp.StatusCode)
	}
	var got struct {
		Locations []lsp.Location `json:"locations"`
		Reason    string         `json:"reason"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Locations) != 1 || got.Locations[0].Line != 42 {
		t.Fatalf("자리가 오지 않았다: %+v", got)
	}
	if f.askText != "package a\n" {
		t.Fatalf("현재 텍스트가 넘어가지 않았다: %q", f.askText)
	}
	if f.askLine != 3 || f.askCol != 5 {
		t.Fatalf("좌표가 넘어가지 않았다: %d,%d", f.askLine, f.askCol)
	}
	_ = srv
}

// TC-LSP-36 (FR-LSP-28 / D-9): 답하지 못한 이유가 **사유로** 온다. 침묵은 고장과
// 구별되지 않는다.
func TestLSPDefinition_ReasonOnFailure(t *testing.T) {
	f := &fakeLSP{locErr: errors.New("gopls 가 없어 코드 탐색을 할 수 없습니다")}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()

	body := `{"root":"` + lspTestRoot + `","path":"` + lspTestRoot + `/a.go","text":"x","line":1,"col":1}`
	resp, err := http.Post(ts.URL+"/api/lsp/definition", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("사유를 실은 결과는 200 이다: %d", resp.StatusCode)
	}
	var got struct {
		Locations []lsp.Location `json:"locations"`
		Reason    string         `json:"reason"`
	}
	json.NewDecoder(resp.Body).Decode(&got)
	if got.Reason == "" {
		t.Fatal("사유가 없다 — 조용한 실패다")
	}
	if got.Locations == nil {
		t.Fatal("locations 가 null 이다 — 빈 배열이어야 화면이 그것을 셀 수 있다")
	}
}

// TC-LSP-37 (FR-LSP-22): 참조는 선언 포함 여부를 그대로 넘긴다.
func TestLSPReferences_PassesIncludeDeclaration(t *testing.T) {
	f := &fakeLSP{}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()

	body := `{"root":"` + lspTestRoot + `","path":"` + lspTestRoot + `/a.go","text":"x","line":1,"col":1,"includeDeclaration":true}`
	resp, err := http.Post(ts.URL+"/api/lsp/references", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !f.askIncl {
		t.Fatal("includeDeclaration 이 넘어가지 않았다")
	}
}

// TC-LSP-38 (FR-LSP-24·49): 루트 가드는 `fsRoot` 다 — Editor 목록에 없는 루트는
// 거절된다. 새 가드를 쓰지 않는 것이 규칙이다 (두 벌이면 한쪽만 고쳐진다).
func TestLSPDefinition_RootGuard(t *testing.T) {
	f := &fakeLSP{}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()

	body := `{"root":"/not/registered","path":"/not/registered/a.go","text":"x","line":1,"col":1}`
	resp, err := http.Post(ts.URL+"/api/lsp/definition", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	code := resp.StatusCode
	resp.Body.Close()
	if code == 200 {
		t.Fatal("등록되지 않은 루트가 통과했다")
	}
	if f.askPath != "" {
		t.Fatalf("가드를 지나기 전에 서비스가 불렸다: %q", f.askPath)
	}
}
