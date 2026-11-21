package gitapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS TC-RDG-1: git 방언 `{error,message}` 의 상태·헤더·본문 바이트가
// 렌더러를 `shared/httpresp` 로 옮기기 전과 같다.
func TestGitDialectGolden(t *testing.T) {
	post := func(s string) *http.Request {
		return httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(s))
	}
	cases := []struct {
		name   string
		run    func(w http.ResponseWriter)
		status int
		code   string
		body   string
	}{
		{"gitFail", func(w http.ResponseWriter) { gitFail(w, http.StatusConflict, "exists", "<x>") },
			409, "exists", "{\"error\":\"exists\",\"message\":\"\\u003cx\\u003e\"}\n"},
		{"gitUnavailable", func(w http.ResponseWriter) { gitUnavailable(w) },
			503, "git_unavailable", "{\"error\":\"git_unavailable\",\"message\":\"git 서비스가 구성되지 않았다\"}\n"},
		{"깨진 JSON", func(w http.ResponseWriter) { var v map[string]any; gitDecodeBody(w, post("{"), &v) },
			400, "bad_request", "{\"error\":\"bad_request\",\"message\":\"본문이 JSON 이 아니다: unexpected end of JSON input\"}\n"},
		{"path 깨진 JSON", func(w http.ResponseWriter) { gitDecodeRawPath(w, post("[")) },
			400, "bad_request", "{\"error\":\"bad_request\",\"message\":\"본문이 JSON 이 아니다: unexpected end of JSON input\"}\n"},
		{"빈 본문", func(w http.ResponseWriter) { var v map[string]any; gitDecodeBody(w, post(""), &v) },
			400, "bad_request", "{\"error\":\"bad_request\",\"message\":\"본문이 JSON 이 아니다: unexpected end of JSON input\"}\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.run(w)
			if w.Code != tc.status || w.Body.String() != tc.body {
				t.Fatalf("got %d %q, want %d %q", w.Code, w.Body.String(), tc.status, tc.body)
			}
			if len(w.Header()) != 2 || w.Header().Get("X-Error-Code") != tc.code ||
				w.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("headers %v", w.Header())
			}
		})
	}
}

// FR-RDG-8: git 가드는 라우트 등록에서 한 번 감싼다. Git 이 없으면 처리기를 부르지 않고
// 종전과 같은 503 을 낸다.
func TestNeedGit_GuardsAtRoute(t *testing.T) {
	called := false
	h := needGit(func(*GitServer, http.ResponseWriter, *http.Request) { called = true })

	w := httptest.NewRecorder()
	h(&GitServer{}, w, httptest.NewRequest(http.MethodGet, "/api/git/repos", nil))
	if called || w.Code != http.StatusServiceUnavailable || w.Header().Get("X-Error-Code") != "git_unavailable" {
		t.Fatalf("called=%v %d %v", called, w.Code, w.Header())
	}
}

// 첫 줄 가드를 지운 처리기 전부가 Git 없이 503 이다 — 라우트에서 감싼 것을 빠뜨리지 않았다.
func TestGitRoutes_UnavailableWithoutGit(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}}
	for _, ep := range []struct{ method, path string }{
		{http.MethodGet, "/api/git/repos"},
		{http.MethodGet, "/api/git/repo-at"},
		{http.MethodPost, "/api/git/init"},
		{http.MethodPost, "/api/git/repos/pin"},
		{http.MethodPost, "/api/git/repos/unpin"},
		{http.MethodPost, "/api/git/repos/reorder"},
		{http.MethodGet, "/api/git/policy"},
		{http.MethodGet, "/api/git/recovery"},
		{http.MethodGet, "/api/git/jobs"},
		{http.MethodGet, "/api/git/job/events"},
	} {
		w := httptest.NewRecorder()
		s.Handle(w, httptest.NewRequest(ep.method, ep.path, strings.NewReader("{")))
		want := "{\"error\":\"git_unavailable\",\"message\":\"git 서비스가 구성되지 않았다\"}\n"
		if w.Code != http.StatusServiceUnavailable || w.Body.String() != want {
			t.Errorf("%s %s → %d %q", ep.method, ep.path, w.Code, w.Body.String())
		}
	}
}
