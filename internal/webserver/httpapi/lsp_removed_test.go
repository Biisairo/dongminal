package httpapi

import (
	"net/http"
	"strings"
	"testing"
)

// CODEMIRROR_MIGRATION_SRS FR-CMR-105 · §11.6 R: REST 코드 탐색과 문서 닫기 경로는 걷혔다 — 404 다.
func TestLSP_RemovedRoutes404(t *testing.T) {
	_, ts := lspServerWithRoot(t, &fakeLSP{})
	defer ts.Close()
	for _, p := range []string{"/api/lsp/definition", "/api/lsp/references", "/api/lsp/hover", "/api/lsp/close"} {
		resp, err := http.Post(ts.URL+p, "application/json", strings.NewReader(lspBody("a.go", "")))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", p, resp.StatusCode)
		}
	}
}
