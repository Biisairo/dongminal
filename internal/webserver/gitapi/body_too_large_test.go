package gitapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/httpreq"
	"dongminal/internal/webserver/apierr"
)

// REFACTOR3_DEFECTS_SRS TC-RD3-30: git 방언도 413 + body_too_large 다 (이전: 413 bad_request).
func TestGitDecode_BodyTooLarge(t *testing.T) {
	big := `{"path":"` + strings.Repeat("x", int(httpreq.DefaultLimit)+1024) + `"}`
	cases := map[string]func(http.ResponseWriter, *http.Request){
		"gitDecodeBody":    func(w http.ResponseWriter, r *http.Request) { var v map[string]any; gitDecodeBody(w, r, &v) },
		"gitDecodeRawPath": func(w http.ResponseWriter, r *http.Request) { gitDecodeRawPath(w, r) },
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			run(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(big)))
			if w.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status=%d want 413", w.Code)
			}
			if got := w.Header().Get(apierr.CodeHeader); got != apierr.CodeBodyTooBig {
				t.Fatalf("%s=%q want %q", apierr.CodeHeader, got, apierr.CodeBodyTooBig)
			}
		})
	}
}
