package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/lsp"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-15-1: LSP 요청 본문 상한은 텍스트 상한(`lsp.MaxTextBytes`)
// 의 JSON 이스케이프 최악을 담는다. 종전에는 텍스트 상한 + 64 KiB 여서, 상한 안의
// 텍스트라도 개행이 많으면 본문이 413 으로 거절됐다.
func TestLSPAsk_WorstCaseEscapedTextAtLimit(t *testing.T) {
	f := &fakeLSP{hover: "h"}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()

	text := strings.Repeat("\n", lsp.MaxTextBytes)
	quoted, _ := json.Marshal(text)
	body := lspBody("a.go", `"text":`+string(quoted)+`,"line":1,"col":1`)
	resp, err := http.Post(ts.URL+"/api/lsp/hover", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("상한 안의 텍스트가 %d 로 거절됐다", resp.StatusCode)
	}
	if len(f.askText) != lsp.MaxTextBytes {
		t.Fatalf("텍스트가 온전히 넘어가지 않았다: %d want %d", len(f.askText), lsp.MaxTextBytes)
	}
}
