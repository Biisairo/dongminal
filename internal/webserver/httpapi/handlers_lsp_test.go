package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/lsp"
)

type fakeLSP struct {
	statuses   []lsp.Status
	gotOverrid map[string]string
	installID  string
	outcome    lsp.InstallOutcome
}

func (f *fakeLSP) Status(overrides map[string]string) []lsp.Status {
	f.gotOverrid = overrides
	return f.statuses
}

func (f *fakeLSP) Install(_ context.Context, id string) lsp.InstallOutcome {
	f.installID = id
	return f.outcome
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
