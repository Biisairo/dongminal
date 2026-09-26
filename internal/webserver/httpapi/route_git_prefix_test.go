package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-2 (HTTP-25) — /api/git/* 는 httpapi 표를 훑지 않고 곧바로
// git 표면으로 간다. 그것이 안전한 근거는 httpapi 표에 git 경로를 잡는 항목이 없다는
// 것이며, 이 검사가 그 불변식을 지킨다.
func TestAPIRoutes_DoNotClaimGitPaths(t *testing.T) {
	for _, p := range []string{"/api/git/status", "/api/git/job/events", "/api/git/", "/api/git/anything/deep"} {
		for i, rt := range apiRoutes {
			if rt.Match(p) {
				t.Fatalf("apiRoutes[%d] 가 git 경로 %s 를 잡는다 — 접두 분기가 그것을 가린다", i, p)
			}
		}
	}
}

// git 이 없으면 종전처럼 404 다.
func TestHandleAPI_GitPrefixWithoutGitIs404(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleAPI(rec, httptest.NewRequest(http.MethodGet, "/api/git/status", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d", rec.Code)
	}
}

func BenchmarkHandleAPI_GitPath(b *testing.B) {
	s := &Server{}
	r := httptest.NewRequest(http.MethodGet, "/api/git/status", nil)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s.handleAPI(httptest.NewRecorder(), r)
	}
}
