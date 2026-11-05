package gitapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/submodule"
)

// gtBranchRepo 는 GT-2 의 판정 재료를 모두 가진 실제 저장소다.
//
//	main   현재 브랜치, origin/main 추적
//	feat   origin/feat 추적 — 양쪽 삭제의 짝
//	lone   upstream 없음
//	origin/other  추적하는 로컬 없음
//	origin/dup    추적하는 로컬 둘(dupA·dupB)
func gtBranchRepo(t *testing.T) (*GitServer, string, string) {
	t.Helper()
	tmp, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bare := filepath.Join(tmp, "remote.git")
	repo := filepath.Join(tmp, "repo")
	run := func(dir string, args ...string) {
		t.Helper()
		args = append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)
		if out, err := submodule.ExecGit(context.Background(), dir, args...); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run(tmp, "init", "-q", "--bare", bare)
	run(tmp, "init", "-q", "-b", "main", repo)
	run(repo, "commit", "-q", "--allow-empty", "-m", "c1")
	run(repo, "remote", "add", "origin", bare)
	run(repo, "push", "-q", "-u", "origin", "main")
	run(repo, "branch", "feat")
	run(repo, "push", "-q", "-u", "origin", "feat")
	run(repo, "branch", "lone")
	run(repo, "push", "-q", "origin", "main:other")
	run(repo, "push", "-q", "origin", "main:dup")
	run(repo, "fetch", "-q", "origin")
	run(repo, "branch", "dupA")
	run(repo, "branch", "dupB")
	run(repo, "branch", "-q", "--set-upstream-to=origin/dup", "dupA")
	run(repo, "branch", "-q", "--set-upstream-to=origin/dup", "dupB")
	s := &GitServer{Git: store.NewStore(core.New())}
	return s, repo, bare
}

func branchMenuAnswers(t *testing.T, s *GitServer, repo, ref string) (int, map[string]any) {
	t.Helper()
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/actions?repo="+url.QueryEscape(repo)+"&kind=branch&ref="+url.QueryEscape(ref), "")
	acts, _ := out["actions"].(map[string]any)
	return code, acts
}

// TC-SDA-1·6 (GT-d·e): 브랜치 메뉴의 답.
func TestBranchMenuAnswers(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	cases := []struct {
		ref  string
		want map[string]string // 동작 → 사유("" 이면 참)
	}{
		{"refs/heads/main", map[string]string{
			action.GitBranchCheckout: apierr.CodeBranchCurrent, action.GitBranchMerge: apierr.CodeTargetIsHead,
			action.GitBranchRebase: apierr.CodeTargetIsHead, action.GitBranchDelete: apierr.CodeBranchCurrent,
			action.GitBranchRename: "", action.GitBranchPush: "", action.GitBranchUpstreamUnset: "",
			action.GitBranchCheckoutLocal: apierr.CodeNotRemoteBranch, action.GitBranchFetch: apierr.CodeNotRemoteBranch,
			action.GitBranchDeleteBoth: apierr.CodeBranchCurrent}},
		{"refs/heads/lone", map[string]string{
			action.GitBranchCheckout: "", action.GitBranchUpstreamUnset: apierr.CodeNoUpstream,
			action.GitBranchDeleteBoth: apierr.CodeNoUpstream, action.GitBranchMerge: ""}},
		{"refs/remotes/origin/feat", map[string]string{
			action.GitBranchCheckout: apierr.CodeNotLocalBranch, action.GitBranchRename: apierr.CodeNotLocalBranch,
			action.GitBranchPush: apierr.CodeNotLocalBranch, action.GitBranchUpstreamSet: apierr.CodeNotLocalBranch,
			action.GitBranchCheckoutLocal: "", action.GitBranchFetch: "", action.GitBranchDeleteRemote: "",
			action.GitBranchDeleteBoth: ""}},
		{"refs/remotes/origin/other", map[string]string{action.GitBranchDeleteBoth: apierr.CodeNoTrackingBranch}},
		{"refs/remotes/origin/dup", map[string]string{action.GitBranchDeleteBoth: apierr.CodeManyTrackingBranch}},
	}
	for _, c := range cases {
		t.Run(c.ref, func(t *testing.T) {
			code, acts := branchMenuAnswers(t, s, repo, c.ref)
			if code != http.StatusOK {
				t.Fatalf("답 종단 = %d", code)
			}
			for id, why := range c.want {
				a, _ := acts[id].(map[string]any)
				if a == nil {
					t.Errorf("%s 의 답이 없다", id)
					continue
				}
				if a["ok"] != (why == "") || (why != "" && a["why"] != why) {
					t.Errorf("%s = %v, want why=%q", id, a, why)
				}
				if why != "" && !action.Catalog.MayGive(id, why) {
					t.Errorf("%s 가 동작 목록에 %s 를 갖지 않는다", id, why)
				}
			}
		})
	}
	if code, _ := branchMenuAnswers(t, s, repo, "refs/heads/nope"); code != http.StatusNotFound {
		t.Fatalf("없는 ref = %d, want 404", code)
	}
}

// TC-SDA-1 (D-SDA-6 · D-SDA-3): 화면만 막던 것을 서버도 같은 코드로 거절한다.
func TestBranchRejections(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	q := func(v string) string { b, _ := json.Marshal(v); return string(b) }
	cases := []struct {
		name, path, body, why string
	}{
		{"현재 브랜치 checkout", "/api/git/checkout", `{"repo":` + q(repo) + `,"ref":"main"}`, apierr.CodeBranchCurrent},
		{"원격 ref checkout", "/api/git/checkout", `{"repo":` + q(repo) + `,"ref":"origin/feat"}`, apierr.CodeNotLocalBranch},
		{"없는 원격을 track", "/api/git/checkout", `{"repo":` + q(repo) + `,"create":"x","track":"origin/nope"}`, apierr.CodeNotRemoteBranch},
		{"원격 rename", "/api/git/branch/rename", `{"repo":` + q(repo) + `,"from":"origin/feat","to":"x"}`, apierr.CodeNotLocalBranch},
		{"upstream 없는데 해제", "/api/git/branch/upstream", `{"repo":` + q(repo) + `,"branch":"lone","unset":true}`, apierr.CodeNoUpstream},
		{"원격 push", "/api/git/branch/push", `{"repo":` + q(repo) + `,"branch":"origin/feat"}`, apierr.CodeNotLocalBranch},
		{"자기 자신 merge", "/api/git/branch/merge", `{"repo":` + q(repo) + `,"ref":"main"}`, apierr.CodeTargetIsHead},
		{"없는 원격 fetch", "/api/git/branch/fetch", `{"repo":` + q(repo) + `,"remote":"origin","branch":"nope"}`, apierr.CodeNotRemoteBranch},
		{"짝이 여럿", "/api/git/branch/delete-both", `{"repo":` + q(repo) + `,"ref":"refs/remotes/origin/dup","confirm":true}`, apierr.CodeManyTrackingBranch},
		{"짝 없음", "/api/git/branch/delete-both", `{"repo":` + q(repo) + `,"ref":"refs/heads/lone","confirm":true}`, apierr.CodeNoUpstream},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, out := wtReq(t, s, http.MethodPost, c.path, c.body)
			if out["error"] != c.why || code == http.StatusOK {
				t.Fatalf("= %d %v, want %s", code, out["error"], c.why)
			}
		})
	}
}

// GT-e: 양쪽 삭제는 확인을 요구하고, 로컬을 지운 뒤 원격 삭제 잡을 띄운다.
func TestBranchDeleteBoth(t *testing.T) {
	s, repo, bare := gtBranchRepo(t)
	body := func(extra string) string {
		b, _ := json.Marshal(repo)
		return `{"repo":` + string(b) + `,"ref":"refs/remotes/origin/feat"` + extra + `}`
	}
	if code, out := wtReq(t, s, http.MethodPost, "/api/git/branch/delete-both", body("")); code != http.StatusBadRequest || out["error"] != apierr.CodeConfirmRequired {
		t.Fatalf("확인 없이 = %d %v, want 400 confirmation_required", code, out["error"])
	}
	code, out := wtReq(t, s, http.MethodPost, "/api/git/branch/delete-both", body(`,"confirm":true`))
	if code != http.StatusOK || out["job"] == nil {
		t.Fatalf("= %d %v, want 200 {job}", code, out)
	}
	if jb := gitJobDone(t, s, out); !jobSucceeded(jb) {
		t.Fatalf("원격 삭제 잡이 실패했다: %+v", jb)
	}
	for _, dir := range []string{repo, bare} {
		if b, _ := submodule.ExecGit(context.Background(), dir, "branch", "--list", "feat"); strings.TrimSpace(b) != "" {
			t.Fatalf("%s 에 feat 가 남았다: %q", dir, b)
		}
	}
}
