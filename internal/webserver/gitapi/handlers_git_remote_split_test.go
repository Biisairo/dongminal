package gitapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/submodule"
)

// SERVER_DRIVEN_ACTIONS_SRS GV-g (G-B8 · FR-SDA-42): `origin/x` 를 원격과 브랜치로 가르는
// 일은 서버가 한다. 화면은 원격 ref 를 그대로 보낸다.

func gvGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := submodule.ExecGit(context.Background(), dir,
		append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func gvBody(repo string, kv map[string]any) string {
	kv["repo"] = repo
	raw, _ := json.Marshal(kv)
	return string(raw)
}

// 원격 ref 를 전체 이름으로 보내면 서버가 갈라 원격 브랜치를 지운다.
func TestBranchDeleteRemoteByRef(t *testing.T) {
	s, repo, bare := gtBranchRepo(t)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/branch/delete-remote",
		gvBody(repo, map[string]any{"ref": "refs/remotes/origin/other", "confirm": true}))
	if code != http.StatusOK || out["job"] == nil {
		t.Fatalf("= %d %v, want 200 {job}", code, out)
	}
	if jb := gitJobDone(t, s, out); !jobSucceeded(jb) {
		t.Fatalf("잡 실패: %+v", jb)
	}
	if got := gvGit(t, bare, "branch", "--list", "other"); got != "" {
		t.Fatalf("원격의 other 가 남았다: %q", got)
	}
}

// 원격 ref 가 아니거나 없는 ref 는 400 not_remote_branch 다 — 가를 수 없는 이름을 git 에
// 넘기지 않는다.
func TestBranchRemoteRefRejects(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	cases := []struct{ name, path, ref string }{
		{"fetch · 로컬 ref", "/api/git/branch/fetch", "refs/heads/main"},
		{"fetch · 없는 원격", "/api/git/branch/fetch", "refs/remotes/nowhere/x"},
		{"fetch · 없는 원격 브랜치", "/api/git/branch/fetch", "refs/remotes/origin/nope"},
		{"원격 삭제 · 로컬 ref", "/api/git/branch/delete-remote", "refs/heads/feat"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, out := wtReq(t, s, http.MethodPost, c.path,
				gvBody(repo, map[string]any{"ref": c.ref, "confirm": true}))
			if code != http.StatusBadRequest || out["error"] != apierr.CodeNotRemoteBranch {
				t.Fatalf("= %d %v, want 400 not_remote_branch", code, out)
			}
		})
	}
}

// fetch-into 도 ref 로 받는다.
func TestBranchFetchIntoByRef(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/branch/fetch",
		gvBody(repo, map[string]any{"ref": "refs/remotes/origin/feat"}))
	if code != http.StatusOK || out["job"] == nil {
		t.Fatalf("= %d %v, want 200 {job}", code, out)
	}
	if jb := gitJobDone(t, s, out); !jobSucceeded(jb) {
		t.Fatalf("잡 실패: %+v", jb)
	}
}

// track 만 보내면 서버가 가른 브랜치 이름으로 로컬을 만들고 추적한다.
func TestCheckoutTrackDerivesName(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/checkout",
		gvBody(repo, map[string]any{"track": "origin/other"}))
	if code != http.StatusOK || out["job"] == nil {
		t.Fatalf("= %d %v, want 200 {job}", code, out)
	}
	if jb := gitJobDone(t, s, out); !jobSucceeded(jb) {
		t.Fatalf("잡 실패: %+v", jb)
	}
	if got := gvGit(t, repo, "rev-parse", "--abbrev-ref", "HEAD"); got != "other" {
		t.Fatalf("HEAD = %q, want other", got)
	}
	if got := gvGit(t, repo, "for-each-ref", "--format=%(upstream:short)", "refs/heads/other"); got != "origin/other" {
		t.Fatalf("upstream = %q, want origin/other", got)
	}
}

// 목록의 원격 ref 는 원격 이름을 싣는다 — 화면은 이름을 가르지 않는다.
func TestRefsCarryRemoteName(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	code, out := wtReq(t, s, http.MethodGet, "/api/git/refs?repo="+url.QueryEscape(repo), "")
	if code != http.StatusOK {
		t.Fatalf("= %d %v", code, out)
	}
	refs, _ := out["refs"].([]any)
	seen := 0
	for _, x := range refs {
		r, _ := x.(map[string]any)
		switch r["kind"] {
		case "remote":
			seen++
			if r["remote"] != "origin" {
				t.Fatalf("%v 의 remote = %v, want origin", r["short"], r["remote"])
			}
		case "local":
			if _, has := r["remote"]; has {
				t.Fatalf("로컬 ref 에 remote 가 실렸다: %v", r)
			}
		}
	}
	if seen == 0 {
		t.Fatal("원격 ref 가 없다")
	}
}
