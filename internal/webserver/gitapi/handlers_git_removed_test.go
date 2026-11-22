package gitapi

import (
	"net/http"
	"testing"
)

// REFACTOR3_FE_FIX_SRS TC-FFX-13 (FX-6, FR-FFX-16): 부르는 곳이 없어진 두 종단은 라우트 표에
// 없고, 요청은 다른 없는 `/api/git/*` 처럼 처리되지 않는다(호출자가 404 를 낸다).
func TestGitRoutes_DeadEndpointsRemoved(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	for _, ep := range []struct{ method, path string }{
		{http.MethodGet, "/api/git/repo-at"},
		{http.MethodPost, "/api/git/repos/reorder"},
	} {
		for _, rt := range routes {
			if (rt.Method == "" || rt.Method == ep.method) && rt.Match(ep.path) {
				t.Errorf("%s %s 가 gitapi.routes 에 남아 있다", ep.method, ep.path)
			}
		}
		if _, ok := writeLocks[ep.path]; ok {
			t.Errorf("%s 가 writeLocks 에 남아 있다", ep.path)
		}
		if code, _ := gitReq(t, s, ep.method, ep.path, "{}"); code != http.StatusNotFound {
			t.Errorf("%s %s → %d, want 404", ep.method, ep.path, code)
		}
	}
}
