package server

import (
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/git"
)

// 묶음 J 서버측 — /api/git/preflight·policy·recovery (GIT_SRS §3A.3, 검증 V36·V37).

var gitPolicyEndpoints = []string{
	"/api/git/preflight?repo=/work/repo",
	"/api/git/policy",
	"/api/git/recovery",
}

// J1: preflight 응답 형태와 requested 에코. 클라이언트가 응답만 보고 자기 요청과
// 짝을 맞출 수 있어야 한다 (FR-GIT-16 의 서버측 절반).
func TestAPIGitPreflight(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/preflight?repo=/work/repo", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if out["requested"] != "/work/repo" || out["repo"] != "/work/repo" {
		t.Fatalf("requested/repo = %v / %v", out["requested"], out["repo"])
	}
	pf, ok := out["preflight"].(map[string]any)
	if !ok {
		t.Fatalf("preflight = %v", out["preflight"])
	}
	for _, key := range []string{"blocks", "warnings", "gpgSign", "template"} {
		if _, ok := pf[key]; !ok {
			t.Fatalf("preflight 에 %q 가 없다: %v", key, pf)
		}
	}
	// 이 더블의 config 는 비어 있다 → identity 차단이며, 사유와 해소법이 함께 온다.
	blocks, ok := pf["blocks"].([]any)
	if !ok || len(blocks) != 1 {
		t.Fatalf("blocks = %v", pf["blocks"])
	}
	b := blocks[0].(map[string]any)
	if b["code"] != "identity_missing" || b["reason"] == "" || b["fix"] == "" {
		t.Fatalf("block = %v", b)
	}
}

// J1: repo 인자 규약은 다른 git 엔드포인트와 같다.
func TestAPIGitPreflight_RepoParam(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	for _, path := range []string{"/api/git/preflight", "/api/git/preflight?repo=relative"} {
		code, out := gitReq(t, s, http.MethodGet, path, "")
		if code != http.StatusBadRequest {
			t.Fatalf("%s → %d, want 400 (%v)", path, code, out)
		}
	}
}

// J2 (FR-GIT-89): 파괴적 동작 목록을 그대로 준다. 클라이언트가 목록을 복제하면
// 서버에 새 동작이 생겨도 클라이언트가 막지 못한다.
func TestAPIGitPolicy(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/policy", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	got, ok := out["destructive"].([]any)
	if !ok || len(got) != len(git.DestructiveActions) {
		t.Fatalf("destructive = %v, want %v", out["destructive"], git.DestructiveActions)
	}
	for i, want := range git.DestructiveActions {
		if got[i] != want {
			t.Fatalf("destructive[%d] = %v, want %q", i, got[i], want)
		}
	}
}

// J3 (FR-GIT-93): 세션 동안 기록된 recovery hint 를 조회할 수 있다.
func TestAPIGitRecovery(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/recovery", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if hints, ok := out["hints"].([]any); !ok || len(hints) != 0 {
		t.Fatalf("초기 hints = %v", out["hints"])
	}

	s.Git.Service().AddHint(git.Hint{
		Repo:    "/work/repo",
		Action:  git.ActionBranchDelete,
		Targets: []string{"feature"},
		Values:  []string{"1111111111111111111111111111111111111111"},
		Command: "git branch feature 1111111111111111111111111111111111111111",
	})
	code, out = gitReq(t, s, http.MethodGet, "/api/git/recovery", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	hints, ok := out["hints"].([]any)
	if !ok || len(hints) != 1 {
		t.Fatalf("hints = %v", out["hints"])
	}
	h := hints[0].(map[string]any)
	if h["action"] != git.ActionBranchDelete || h["seq"] != float64(1) {
		t.Fatalf("hint = %v", h)
	}
	if h["command"] == "" || h["atUnixMs"] == float64(0) {
		t.Fatalf("hint 에 명령·시각이 없다: %v", h)
	}
}

// J4: s.Git == nil 이면 3개 전부 503 이다. git 표면만 닫힌다.
func TestGitPolicyEndpoints_Unavailable(t *testing.T) {
	s := &Server{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, path := range gitPolicyEndpoints {
		code, out := gitReq(t, s, http.MethodGet, path, "")
		if code != http.StatusServiceUnavailable {
			t.Errorf("%s → %d, want 503", path, code)
		}
		if out["error"] != gitErrUnavailable {
			t.Errorf("%s error = %v, want %q", path, out["error"], gitErrUnavailable)
		}
	}
}

// J1~J3: 3개 라우트가 apiRoutes 에 등록돼 있다. UI 는 이 표면 위에만 선다.
func TestGitPolicyRoutesRegistered(t *testing.T) {
	for _, ep := range gitPolicyEndpoints {
		path := strings.SplitN(ep, "?", 2)[0]
		found := false
		for _, rt := range apiRoutes {
			if rt.method != "" && rt.method != http.MethodGet {
				continue
			}
			if rt.match(path) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s 가 apiRoutes 에 없다", path)
		}
	}
}
