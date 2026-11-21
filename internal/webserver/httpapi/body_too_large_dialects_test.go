package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
)

// REFACTOR3_DEFECTS_SRS TC-RD3-30: 상한을 넘은 본문은 방언과 무관하게 413 + body_too_large 다.
//
//	이전: toolio·lsp 는 413 too_large, fs 는 400 bad_request 였다
func TestBodyTooLarge_Dialects(t *testing.T) {
	big := oversized()
	cases := []struct {
		name string
		run  func(w http.ResponseWriter, r *http.Request)
	}{
		{"toolio", func(w http.ResponseWriter, r *http.Request) { var v map[string]any; decodeJSONBody(w, r, &v) }},
		{"lsp", func(w http.ResponseWriter, r *http.Request) { lspReadBody(w, r, 16) }},
		{"fs", func(w http.ResponseWriter, r *http.Request) { var v map[string]any; fsDecode(w, r, &v) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.run(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(big)))
			if w.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status=%d want 413", w.Code)
			}
			if got := w.Header().Get(apierr.CodeHeader); got != apierr.CodeBodyTooBig {
				t.Fatalf("%s=%q want %q", apierr.CodeHeader, got, apierr.CodeBodyTooBig)
			}
			if tc.name == "fs" {
				var b struct{ Code string }
				_ = json.Unmarshal(w.Body.Bytes(), &b)
				if b.Code != apierr.CodeBodyTooBig {
					t.Fatalf("본문 code=%q want %q", b.Code, apierr.CodeBodyTooBig)
				}
			}
		})
	}
}

// FR-RD3-34: 상한 안의 깨진 JSON 은 종전과 같다.
func TestBodyTooLarge_BrokenJSONUnchanged(t *testing.T) {
	w := httptest.NewRecorder()
	var v map[string]any
	fsDecode(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("{")), &v)
	if w.Code != http.StatusBadRequest || w.Header().Get(apierr.CodeHeader) != apierr.CodeBadRequest {
		t.Fatalf("fs 깨진 JSON: %d %q", w.Code, w.Header().Get(apierr.CodeHeader))
	}
	w = httptest.NewRecorder()
	decodeJSONBody(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("{")), &v)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("toolio 깨진 JSON: %d", w.Code)
	}
}
