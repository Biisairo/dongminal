package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-1-10 (HTTP-29): 상한을 넘은 LSP 본문은 413 이다.
// 종전에는 LimitReader 가 조용히 잘라, 잘린 JSON 이 400 'bad request' 로 나갔다 —
// 사용자는 "형식이 틀렸다" 로 읽고 나눠 보낼 생각을 하지 못한다.
func TestLSP_OversizeBodyIs413(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: &fakeLSP{}})
	h := srv.Handler()
	pad := strings.Repeat("x", lspAskMaxBody)
	cases := []struct {
		method, path string
	}{
		{http.MethodPost, "/api/lsp/install"},
		{http.MethodPut, "/api/lsp/paths"},
		{http.MethodPost, "/api/lsp/close"},
		{http.MethodPost, "/api/lsp/definition"},
	}
	for _, c := range cases {
		body := `{"id":"gopls","path":"/a","text":"` + pad + `"}`
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, apiTestRequest(c.method, c.path, strings.NewReader(body)))
		if rec.Code != http.StatusRequestEntityTooLarge || rec.Header().Get(apierr.CodeHeader) != apierr.CodeTooLarge {
			t.Errorf("%s %s = %d %q, want 413 %q", c.method, c.path, rec.Code, rec.Header().Get(apierr.CodeHeader), apierr.CodeTooLarge)
		}
	}
}

// 상한과 같은 크기는 받는다 — 한 바이트 더 읽는 판정이 경계를 먹지 않는다.
func TestLSP_BodyAtLimitIsRead(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: &fakeLSP{}})
	prefix, suffix := `{"id":"gopls","x":"`, `"}`
	body := prefix + strings.Repeat("x", lspMaxBody-len(prefix)-len(suffix)) + suffix
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, apiTestRequest(http.MethodPost, "/api/lsp/install", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("상한과 같은 본문 = %d %q, want 200", rec.Code, rec.Body.String())
	}
}
