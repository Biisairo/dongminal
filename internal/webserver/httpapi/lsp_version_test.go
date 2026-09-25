package httpapi

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/lsp"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-6-2 — 판 협상. 옛 화면(판 없음)과는 바이트로 같고,
// 새 화면에는 판을 받았다는 답(version) 또는 전문 재요청(needText)이 간다.

func lspPost(t *testing.T, url, body string) string {
	t.Helper()
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(b))
}

// 판을 싣지 않은 요청(옛 화면)의 응답은 종전과 같다 — version·needText 가 없다.
func TestLSPVersion_OldClientBodyUnchanged(t *testing.T) {
	f := &fakeLSP{hover: "h"}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()
	if got := lspPost(t, ts.URL+"/api/lsp/hover", lspBody("a.go", `"text":"x","line":1,"col":1`)); got != `{"markdown":"h"}` {
		t.Fatalf("hover = %s", got)
	}
	if got := lspPost(t, ts.URL+"/api/lsp/definition", lspBody("a.go", `"text":"x","line":1,"col":1`)); got != `{"locations":[]}` {
		t.Fatalf("definition = %s", got)
	}
	// 텍스트도 판도 없으면 빈 텍스트다 (종전 동작).
	lspPost(t, ts.URL+"/api/lsp/definition", lspBody("a.go", `"line":1,"col":1`))
	if f.askDoc.NoText || f.askDoc.Text != "" {
		t.Fatalf("판 없는 요청이 생략으로 읽혔다: %+v", f.askDoc)
	}
}

// 판을 실으면 성공 응답이 그 판을 되돌린다. 텍스트를 빼면 NoText 로 넘어간다.
func TestLSPVersion_EchoAndNoText(t *testing.T) {
	f := &fakeLSP{hover: "h"}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()
	got := lspPost(t, ts.URL+"/api/lsp/hover", lspBody("a.go", `"text":"x","version":"p:1:5","line":1,"col":1`))
	if got != `{"markdown":"h","version":"p:1:5"}` {
		t.Fatalf("hover = %s", got)
	}
	if f.askDoc.NoText || f.askDoc.Text != "x" || f.askDoc.Version != "p:1:5" {
		t.Fatalf("doc = %+v", f.askDoc)
	}
	lspPost(t, ts.URL+"/api/lsp/references", lspBody("a.go", `"version":"p:1:5","line":1,"col":1`))
	if !f.askDoc.NoText || f.askDoc.Version != "p:1:5" {
		t.Fatalf("텍스트를 뺀 요청이 생략으로 넘어가지 않았다: %+v", f.askDoc)
	}
}

// 세션이 그 판을 모르면 needText — 사유를 싣지 않는다(화면이 알림으로 띄우지 않게).
// 다른 실패에는 판을 되돌리지 않는다 — 다음 요청이 전문을 싣는다.
func TestLSPVersion_NeedTextAndFailure(t *testing.T) {
	f := &fakeLSP{locErr: lsp.ErrNeedText}
	_, ts := lspServerWithRoot(t, f)
	defer ts.Close()
	if got := lspPost(t, ts.URL+"/api/lsp/definition", lspBody("a.go", `"version":"v","line":1,"col":1`)); got != `{"locations":[],"needText":true}` {
		t.Fatalf("definition = %s", got)
	}
	if got := lspPost(t, ts.URL+"/api/lsp/hover", lspBody("a.go", `"version":"v","line":1,"col":1`)); got != `{"markdown":"","needText":true}` {
		t.Fatalf("hover = %s", got)
	}
	f.locErr = io.ErrUnexpectedEOF
	got := lspPost(t, ts.URL+"/api/lsp/hover", lspBody("a.go", `"text":"x","version":"v","line":1,"col":1`))
	if strings.Contains(got, `"version"`) || !strings.Contains(got, `"reason"`) {
		t.Fatalf("실패에 판을 되돌렸다: %s", got)
	}
}
