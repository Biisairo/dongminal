package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS TC-RDG-1: 방언마다 같은 실패가 바꾸기 전과 같은 상태·헤더·본문
// 바이트를 낸다. 기대값은 렌더러를 `shared/httpresp` 로 옮기기 전의 출력이다.
type golden struct {
	status  int
	headers map[string]string
	body    string
}

const (
	ctJSON = "application/json"
	ctText = "text/plain; charset=utf-8"
)

func jsonHeaders(code string) map[string]string {
	return map[string]string{"X-Error-Code": code, "Content-Type": ctJSON}
}

func assertGolden(t *testing.T, w *httptest.ResponseRecorder, want golden) {
	t.Helper()
	if w.Code != want.status || w.Body.String() != want.body {
		t.Fatalf("got %d %q, want %d %q", w.Code, w.Body.String(), want.status, want.body)
	}
	if len(w.Header()) != len(want.headers) {
		t.Fatalf("headers %v, want %v", w.Header(), want.headers)
	}
	for k, v := range want.headers {
		if got := w.Header().Get(k); got != v {
			t.Fatalf("header %s=%q, want %q", k, got, v)
		}
	}
}

func TestDialectGolden(t *testing.T) {
	post := func(s string) *http.Request {
		return httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(s))
	}
	big := oversized()
	cases := []struct {
		name string
		run  func(w http.ResponseWriter)
		want golden
	}{
		{"평문", func(w http.ResponseWriter) { httpErr(w, "file changed on disk", http.StatusConflict, "file_changed") },
			golden{409, map[string]string{"X-Error-Code": "file_changed", "Content-Type": ctText, "X-Content-Type-Options": "nosniff"},
				"file changed on disk\n"}},
		{"평문 코드 없음", func(w http.ResponseWriter) { httpErr(w, "nope", http.StatusNotFound, "") },
			golden{404, map[string]string{"X-Error-Code": "not_found", "Content-Type": ctText, "X-Content-Type-Options": "nosniff"},
				"nope\n"}},
		{"평문 상한 초과", func(w http.ResponseWriter) { var v map[string]any; readBodyHTTP(w, post(big), &v) },
			golden{413, map[string]string{"X-Error-Code": "body_too_large", "Content-Type": ctText, "X-Content-Type-Options": "nosniff"},
				"read body\n"}},
		{"toolio", func(w http.ResponseWriter) { writeToolIOError(w, http.StatusNotFound, "tool not found: <x>") },
			golden{404, jsonHeaders("not_found"), "{\"error\":\"tool not found: \\u003cx\\u003e\"}\n"}},
		{"toolio 깨진 JSON", func(w http.ResponseWriter) { var v map[string]any; decodeJSONBody(w, post("{"), &v) },
			golden{400, jsonHeaders("bad_request"), "{\"error\":\"잘못된 JSON: unexpected end of JSON input\"}\n"}},
		{"toolio 상한 초과", func(w http.ResponseWriter) { var v map[string]any; decodeJSONBody(w, post(big), &v) },
			golden{413, map[string]string{"X-Error-Code": "body_too_large", "Content-Type": ctJSON},
				"{\"error\":\"본문을 읽지 못했다: 본문이 상한을 넘었다\"}\n"}},
		{"lsp 상한 초과", func(w http.ResponseWriter) { lspReadBody(w, post(big), 16) },
			golden{413, jsonHeaders("body_too_large"), "{\"error\":\"body too large\"}\n"}},
		{"code", func(w http.ResponseWriter) { codeFail(w, http.StatusBadRequest, "invalid_json", "invalid json") },
			golden{400, jsonHeaders("invalid_json"), "{\"code\":\"invalid_json\",\"message\":\"invalid json\"}\n"}},
		{"code 깨진 JSON", func(w http.ResponseWriter) { var v map[string]any; readJSONBody(w, post("{"), &v) },
			golden{400, jsonHeaders("invalid_json"), "{\"code\":\"invalid_json\",\"message\":\"invalid json\"}\n"}},
		{"code 상한 초과", func(w http.ResponseWriter) { var v map[string]any; readJSONBody(w, post(big), &v) },
			golden{413, map[string]string{"X-Error-Code": "body_too_large", "Content-Type": ctJSON},
				"{\"code\":\"body_too_large\",\"message\":\"read body\"}\n"}},
		{"jsonFail", func(w http.ResponseWriter) { jsonFail(w)(http.StatusNotFound, "not_found", "x") },
			golden{404, jsonHeaders("not_found"), "{\"code\":\"not_found\",\"message\":\"x\"}\n"}},
		{"fs", func(w http.ResponseWriter) { fsFail(w, fsErrNotFound, "경로를 찾을 수 없다") },
			golden{404, jsonHeaders(fsErrNotFound), "{\"code\":\"" + fsErrNotFound + "\",\"message\":\"경로를 찾을 수 없다\"}\n"}},
		{"fs 본문", func(w http.ResponseWriter) {
			fsFailBody(w, fsErrExists, map[string]any{"code": fsErrExists, "args": map[string]string{"name": "a"}})
		}, golden{409, jsonHeaders(fsErrExists), "{\"args\":{\"name\":\"a\"},\"code\":\"" + fsErrExists + "\"}\n"}},
		{"fs 깨진 JSON", func(w http.ResponseWriter) { var v map[string]any; fsDecode(w, post("{"), &v) },
			golden{400, jsonHeaders("bad_request"), "{\"code\":\"bad_request\",\"message\":\"본문이 JSON 이 아니다: unexpected end of JSON input\"}\n"}},
		{"runs", func(w http.ResponseWriter) { writeRunError(w, errors.New("boom"), map[string]any{"memberId": "m"}) },
			// REFACTOR3_GO_STRUCT_SRS FR-RGS-7: 미분류 실패는 고정 코드다 — 전문은 로그로 간다.
			golden{500, jsonHeaders("internal_error"), "{\"detail\":\"internal_error\",\"error\":\"internal_error\",\"memberId\":\"m\"}\n"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.run(w)
			assertGolden(t, w, tc.want)
		})
	}
}
