package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/hub"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-6 (HTTP-28 · IPC-32) — 비생성 명령의 payload 전문은 Info
// 가 아니라 Debug 다. Info 에는 action·location·delivered·길이만 남는다.
func TestCommandPost_PayloadOnlyAtDebug(t *testing.T) {
	var buf bytes.Buffer
	dmlog.Init(dmlog.Options{Level: "info", Out: &buf})
	t.Cleanup(dmlog.Reset)

	s := &Server{Deps: Deps{Commands: hub.NewCommandHub()}}
	const secret = "SECRET-TAB-NAME-9f2"
	body := `{"action":"renameWindow","args":{"name":"` + secret + `"}}`
	rec := httptest.NewRecorder()
	s.handleCommandPost(rec, httptest.NewRequest(http.MethodPost, "/api/commands", strings.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("code = %d %s", rec.Code, rec.Body.String())
	}
	out := buf.String()
	if strings.Contains(out, secret) {
		t.Fatalf("Info 로그에 payload 전문이 실렸다:\n%s", out)
	}
	if !strings.Contains(out, "action=renameWindow") || !strings.Contains(out, "bytes=") {
		t.Fatalf("Info 로그에 action·길이가 없다:\n%s", out)
	}

	buf.Reset()
	dmlog.Init(dmlog.Options{Level: "debug", Out: &buf})
	s.handleCommandPost(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/commands", strings.NewReader(body)))
	if !strings.Contains(buf.String(), secret) {
		t.Fatalf("Debug 에는 전문이 남아야 한다:\n%s", buf.String())
	}
}
