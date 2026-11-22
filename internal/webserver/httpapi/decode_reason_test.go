package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// QUALITY_GO_SRS TC-QG-1: 형이 틀린 JSON 의 답에 Go 타입 이름이 없고 필드 경로는 있다.
// 상태와 코드는 종전과 같다 (FR-QG-1·4).
//
// 이전: `json: cannot unmarshal number into Go struct field fsDeleteReq.paths of type []string`
// 를 본문에 실었다 — 내부 타입 이름이 드러났다(PROD3 GH-F3).
func TestDecodeFailHidesGoTypes(t *testing.T) {
	post := func(body string) *http.Request {
		return httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	}
	s := &Server{}
	cases := []struct {
		name   string
		run    func(w http.ResponseWriter)
		status int
		code   string
		field  string
	}{
		{"fs", func(w http.ResponseWriter) { var v fsDeleteReq; fsDecode(w, post(`{"path":1}`), &v) },
			400, "bad_request", "path"},
		{"toolio", func(w http.ResponseWriter) {
			var v struct {
				ID string `json:"id"`
			}
			decodeJSONBody(w, post(`{"id":1}`), &v)
		}, 400, "bad_request", "id"},
		{"file stamps", func(w http.ResponseWriter) {
			s.apiFileStamps(w, post(`{"paths":1}`))
		}, 400, "invalid_json", "paths"},
		{"file write", func(w http.ResponseWriter) {
			s.parseFileWrite(w, post(`{"path":1}`))
		}, 400, "invalid_json", "path"},
		{"commands", func(w http.ResponseWriter) {
			parseCommandPost(w, post(`{"action":1}`))
		}, 400, "invalid_json", "action"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.run(w)
			body := w.Body.String()
			if w.Code != tc.status || w.Header().Get("X-Error-Code") != tc.code {
				t.Fatalf("got %d %q, want %d %q", w.Code, w.Header().Get("X-Error-Code"), tc.status, tc.code)
			}
			for _, leak := range []string{"Go struct", "Go value", "Req", "[]string", "of type"} {
				if strings.Contains(body, leak) {
					t.Fatalf("본문에 %q 가 샌다: %s", leak, body)
				}
			}
			if !strings.Contains(body, tc.field+": number 값은 맞지 않다") {
				t.Fatalf("본문에 요청 자리가 없다: %s", body)
			}
		})
	}
}
