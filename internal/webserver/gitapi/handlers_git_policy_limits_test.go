package gitapi

import (
	"net/http"
	"testing"

	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
)

// SERVER_DRIVEN_ACTIONS_SRS K-a·K-b (K3·K5 · FR-SDA-80): 화면이 그대로 쓰는 상한은 서버가 보낸다.
func TestAPIGitPolicyLimits(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	code, out := gitReq(t, s, http.MethodGet, "/api/git/policy", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if out["jobLineCap"] != float64(jobs.JobLineCap) {
		t.Fatalf("jobLineCap = %v, want %d", out["jobLineCap"], jobs.JobLineCap)
	}
	lim, ok := out["logLimits"].(map[string]any)
	if !ok {
		t.Fatalf("logLimits 가 없다: %v", out)
	}
	for key, want := range map[string]int{"initial": query.LogInitialLimit, "page": query.LogPageLimit, "max": query.LogMaxLimit} {
		if lim[key] != float64(want) {
			t.Fatalf("logLimits.%s = %v, want %d", key, lim[key], want)
		}
	}
}
