package gitapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/worktree"
	"net/url"
)

// 묶음 W7 서버측 — /api/git/worktrees* (GIT_REVIEW4_SRS §3.6.5, 검증 V145·V148).
//
// **실제 git 을 쓴다.** fake 로는 이 표면의 요점(경로 충돌·소유 판정·checkPath 의
// 구조적 거부)을 확인할 수 없다 — domain/worktree 의 테스트 관용구와 같은 이유다.

func wtGitBin(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git 이 없다 — worktree 표면 테스트를 건너뛴다")
	}
	return p
}

func wtGitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(wtGitBin(t), args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func wtTempRepo(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	wtGitRun(t, dir, "init", "-b", "main")
	wtGitRun(t, dir, "config", "user.email", "t@example.com")
	wtGitRun(t, dir, "config", "user.name", "tester")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	wtGitRun(t, dir, "add", ".")
	wtGitRun(t, dir, "commit", "-m", "init")
	return dir
}

// worktreeTestServer 는 실제 git 을 쓰는 GitServer 를 세운다. RunWorktreeRoot 는
// 실제로 만들 필요가 없다 — gitWorktreeOwner 는 경로 prefix 비교만 한다.
func worktreeTestServer(t *testing.T) (s *GitServer, repo string, userMgr *worktree.Manager) {
	t.Helper()
	repo = wtTempRepo(t)
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	userMgr = worktree.New(filepath.Join(home, "git-worktrees"))
	runRoot := filepath.Join(home, "worktrees")
	gitStore := store.NewStore(core.New())
	s = &GitServer{Git: gitStore, UserWorktrees: userMgr, RunWorktreeRoot: runRoot}
	return s, repo, userMgr
}

func wtReq(t *testing.T, s *GitServer, method, path, body string) (int, map[string]any) {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// wantNoOK 는 4xx/409 응답에 "ok" 필드 자체가 없는지 본다(V164) — `out["ok"]!=true`
// 만으로는 "false 로 왔다"와 "아예 없다"를 못 가른다. 이 표면의 쓰기 성공 응답은
// 전부 `"ok":true` 를 명시적으로 싣고(handlers_git_worktree.go), 실패는 gitFail/
// gitJSON 의 {"error",...} 모양이라 "ok" 를 아예 안 담는다 — 그 부재까지 고정한다.
func wantNoOK(t *testing.T, out map[string]any) {
	t.Helper()
	if _, has := out["ok"]; has {
		t.Fatalf("실패 응답에 ok 가 있으면 안 된다: %+v", out)
	}
}

// 라우팅 등록 + UserWorktrees 없으면 503 (기존 M5 라우팅 스모크 테스트와 같은 규약).
func TestGitWorktreeRoutes_RegisteredAndUnavailable(t *testing.T) {
	s := &GitServer{}
	endpoints := []struct{ method, path, body string }{
		{http.MethodGet, "/api/git/worktrees?repo=" + url.QueryEscape(absX), ""},
		{http.MethodPost, "/api/git/worktrees/create", `{}`},
		{http.MethodPost, "/api/git/worktrees/remove", `{}`},
	}
	for _, ep := range endpoints {
		found := false
		for _, rt := range routes {
			if rt.method != "" && rt.method != ep.method {
				continue
			}
			if rt.match(strings.SplitN(ep.path, "?", 2)[0]) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s %s 가 routes 에 없다", ep.method, ep.path)
			continue
		}
		code, out := wtReq(t, s, ep.method, ep.path, ep.body)
		if code != http.StatusServiceUnavailable || out["error"] != gitErrUnavailable {
			t.Errorf("%s %s → %d %v, want 503 git_unavailable", ep.method, ep.path, code, out["error"])
		}
		wantNoOK(t, out)
	}
}

// V145 (FR-GIT-240): 소유는 경로로만 판정한다.
func TestGitWorktreeOwner_ClassifiesByPath(t *testing.T) {
	userRoot := "/home/x/git-worktrees"
	runRoot := absHomeXWorktrees
	cases := []struct{ path, want string }{
		{filepath.Join(userRoot, "app-abc12345", "feature"), worktreeOwnerUser},
		{filepath.Join(runRoot, "run1", "mem1"), worktreeOwnerRun},
		{absOtherRepo, worktreeOwnerOutside},
		// 이름이 닮았을 뿐인 형제 아닌 경로 — prefix 판정이 정확히 root+separator 인지 확인.
		{userRoot + "-decoy/x", worktreeOwnerOutside},
		// root 자신은 checkPath(worktree.go:515,529-531)가 "루트 자신"이라는 별도
		// 사유로 거부한다 — 제거 대상이 아니다. gitUnderRoot 가 여기서도 "user"라고
		// 답하면 UI 는 지울 수 있다고 보이는데 서버는 거부하는 어긋남이 생긴다. 그래서
		// root 자신은 어느 영역에도 속하지 않는다(outside) — checkPath 와 정확히
		// 같은 뜻이어야 한다.
		{userRoot, worktreeOwnerOutside},
		{runRoot, worktreeOwnerOutside},
	}
	for _, c := range cases {
		if got := gitWorktreeOwner(c.path, userRoot, runRoot); got != c.want {
			t.Errorf("%s: got %s want %s", c.path, got, c.want)
		}
	}
}

// V148 (FR-GIT-242, FR-WKT-6): 이름이 - 로 시작하면 거부한다.
func TestAPIGitWorktreeCreate_RejectsDashLeadingName(t *testing.T) {
	s, repo, _ := worktreeTestServer(t)
	body := fmt.Sprintf(`{"repo":%q,"name":"-x","ref":"main"}`, repo)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusBadRequest || out["error"] != gitErrRefName {
		t.Fatalf("want 400 ref_name_invalid, got %d %+v", code, out)
	}
	wantNoOK(t, out)
}

// V148: 이미 있는 이름(경로)을 거부한다 — 조용히 다른 경로를 고르지 않는다.
func TestAPIGitWorktreeCreate_RejectsExistingName(t *testing.T) {
	s, repo, mgr := worktreeTestServer(t)
	// main 은 이미 repo 자신에 체크아웃돼 있다 — 별도 브랜치를 대상 ref 로 쓴다.
	wtGitRun(t, repo, "branch", "other")

	body := fmt.Sprintf(`{"repo":%q,"name":"feature","ref":"other"}`, repo)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusOK {
		t.Fatalf("첫 생성 want 200, got %d %+v", code, out)
	}
	// V164: 성공 응답은 ok:true 를 싣는다 — panel.post(panel.js) 는 HTTP 200 만으로
	// 성공을 판정하지 않고 이 필드를 본다.
	if out["ok"] != true {
		t.Fatalf("성공 응답에 ok:true 가 없다: %+v", out)
	}
	path, _ := out["path"].(string)
	if path == "" || !strings.HasPrefix(path, mgr.Root()+string(filepath.Separator)) {
		t.Fatalf("경로가 사용자 영역 밖이다: %+v", out)
	}

	code, out = wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusConflict || out["error"] != gitErrWorktreeExists {
		t.Fatalf("같은 이름 재생성이 거부되지 않았다: %d %+v", code, out)
	}
	wantNoOK(t, out)
}

// V148: 새 브랜치를 요청했는데 그 이름의 로컬 브랜치가 이미 있으면 거부한다.
func TestAPIGitWorktreeCreate_RejectsExistingBranch(t *testing.T) {
	s, repo, _ := worktreeTestServer(t)
	wtGitRun(t, repo, "branch", "taken")

	body := fmt.Sprintf(`{"repo":%q,"name":"taken","ref":"main","newBranch":true}`, repo)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusConflict || out["error"] != gitErrBranchExists {
		t.Fatalf("want 409 branch_exists, got %d %+v", code, out)
	}
	wantNoOK(t, out)
}

// FR-GIT-240/242: 생성 → 목록(소유·main 표식) → 확인 없는 제거 거부 → 제거, 순서로
// 표면 전체를 왕복한다.
func TestAPIGitWorktree_CreateListRemove(t *testing.T) {
	s, repo, _ := worktreeTestServer(t)

	body := fmt.Sprintf(`{"repo":%q,"name":"feature","ref":"main","newBranch":true}`, repo)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusOK {
		t.Fatalf("create want 200, got %d %+v", code, out)
	}
	// V164: ok:true 가 없으면 panel.post 가 성공을 실패로 읽는다 — 대화상자가 닫히지
	// 않고 목록이 갱신되지 않았던 결함이 바로 이 자리였다.
	if out["ok"] != true {
		t.Fatalf("create 성공 응답에 ok:true 가 없다: %+v", out)
	}
	path, _ := out["path"].(string)
	if out["branch"] != "feature" {
		t.Fatalf("branch 가 응답에 없다: %+v", out)
	}

	code, out = wtReq(t, s, http.MethodGet, "/api/git/worktrees?repo="+repo, "")
	if code != http.StatusOK {
		t.Fatalf("list want 200, got %d %+v", code, out)
	}
	entries, _ := out["worktrees"].([]any)
	foundNew, foundMain := false, false
	for _, raw := range entries {
		e, _ := raw.(map[string]any)
		if e["path"] == path {
			foundNew = true
			if e["owner"] != worktreeOwnerUser || e["branch"] != "feature" {
				t.Fatalf("새 worktree 항목이 어긋난다: %+v", e)
			}
		}
		if e["path"] == repo {
			foundMain = true
			if e["main"] != true {
				t.Fatalf("main worktree 표식이 없다: %+v", e)
			}
		}
	}
	if !foundNew {
		t.Fatalf("새 worktree 가 목록에 없다: %+v", entries)
	}
	if !foundMain {
		t.Fatalf("main worktree 가 목록에 없다 (FR-GIT-240: git worktree list 와 같아야 한다): %+v", entries)
	}

	rmNoConfirm := fmt.Sprintf(`{"repo":%q,"path":%q}`, repo, path)
	code, out = wtReq(t, s, http.MethodPost, "/api/git/worktrees/remove", rmNoConfirm)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("확인 없는 제거가 통과했다: %d %+v", code, out)
	}
	wantNoOK(t, out)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("확인 없이 제거됐다: %v", err)
	}

	rmConfirm := fmt.Sprintf(`{"repo":%q,"path":%q,"confirm":true}`, repo, path)
	code, out = wtReq(t, s, http.MethodPost, "/api/git/worktrees/remove", rmConfirm)
	if code != http.StatusOK || out["removed"] != true {
		t.Fatalf("제거 실패: %d %+v", code, out)
	}
	// V164: ok 와 removed 는 다른 뜻이다 — ok 는 "요청을 처리했다", removed 는
	// "실제로 지웠다". 여기서는 둘 다 true 여야 한다.
	if out["ok"] != true {
		t.Fatalf("remove 성공 응답에 ok:true 가 없다: %+v", out)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("경로가 남았다")
	}
}

// V164: dirty 거부는 **처리 성공(ok:true)이면서 removed:false** 다. ok 가 removed 와
// 같은 값으로 묶여 있으면(수정 전 결함) 이 사유 분기가 클라이언트에 도달하지 못한다
// — FR-GIT-243 의 "조용히 넘기지 않는다"가 무력화된다.
func TestAPIGitWorktreeRemove_DirtyIsOkButNotRemoved(t *testing.T) {
	s, repo, _ := worktreeTestServer(t)
	body := fmt.Sprintf(`{"repo":%q,"name":"feature","ref":"main","newBranch":true}`, repo)
	_, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	path, _ := out["path"].(string)
	if path == "" {
		t.Fatalf("생성 실패: %+v", out)
	}
	if err := os.WriteFile(filepath.Join(path, "작업물.txt"), []byte("지우면 안 된다\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rmBody := fmt.Sprintf(`{"repo":%q,"path":%q,"confirm":true}`, repo, path)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/remove", rmBody)
	if code != http.StatusOK {
		t.Fatalf("dirty 거부도 200 이어야 한다: %d %+v", code, out)
	}
	if out["ok"] != true {
		t.Fatalf("dirty 거부 응답에 ok:true 가 없다 — 사유가 클라이언트에 도달 못 한다: %+v", out)
	}
	if out["removed"] != false || out["residue"] != "dirty" {
		t.Fatalf("removed/residue 가 어긋난다: %+v", out)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("dirty worktree 가 지워졌다: %v", err)
	}
	if _, err := os.Stat(filepath.Join(path, "작업물.txt")); err != nil {
		t.Fatalf("사용자 작업이 사라졌다: %v", err)
	}
}

// V162 (API 수준): 사용자가 새 worktree 를 "Open"(활성 리포로 전환)한 뒤 다시
// 목록을 조회해도(=쿼리의 repo 가 그 링크드 worktree 자신이 된다) main 배지는
// 원래 저장소에 남는다. domain/worktree 의 TestList_MainStaysOnOriginRegardlessOfQueryPath
// 가 파싱 단위에서 같은 것을 본다 — 여기서는 HTTP 응답까지 그 사실이 그대로
// 전달되는지를 본다(gitapi 가 다시 판정을 세우지 않는지).
func TestAPIGitWorktrees_MainStaysOnOriginWhenQueriedFromLinkedWorktree(t *testing.T) {
	s, repo, _ := worktreeTestServer(t)
	body := fmt.Sprintf(`{"repo":%q,"name":"feature","ref":"main","newBranch":true}`, repo)
	_, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	path, _ := out["path"].(string)
	if path == "" {
		t.Fatalf("생성 실패: %+v", out)
	}

	// "Open" 을 흉내낸다 — 방금 만든 worktree 를 활성 리포로 삼아 다시 조회한다.
	code, out := wtReq(t, s, http.MethodGet, "/api/git/worktrees?repo="+path, "")
	if code != http.StatusOK {
		t.Fatalf("list want 200, got %d %+v", code, out)
	}
	entries, _ := out["worktrees"].([]any)
	for _, raw := range entries {
		e, _ := raw.(map[string]any)
		if e["path"] == repo && e["main"] != true {
			t.Fatalf("main worktree(repo) 의 main 표식이 사라졌다: %+v", e)
		}
		if e["path"] == path && e["main"] == true {
			t.Fatalf("조회에 쓴 링크드 worktree 에 main 이 잘못 섰다: %+v", e)
		}
	}
}

// FR-GIT-241/243: 사용자 영역 밖의 worktree(직접 git 으로 만든 것)는 제거되지
// 않는다 — checkPath 의 구조적 거부이지 별도 소유 판정이 아니다.
func TestAPIGitWorktreeRemove_RejectsOutsideUserArea(t *testing.T) {
	s, repo, _ := worktreeTestServer(t)
	// 심볼릭 링크를 미리 푼다 — git 이 물리 경로로 답하므로(맥OS /var → /private/var)
	// 안 풀면 List() 의 경로 비교가 어긋난다.
	outsideParent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(outsideParent, "outside")
	wtGitRun(t, repo, "worktree", "add", "--no-track", "-b", "outside-branch", outside)

	body := fmt.Sprintf(`{"repo":%q,"path":%q,"confirm":true}`, repo, outside)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/remove", body)
	if code != http.StatusOK || out["removed"] != false || out["residue"] != "unsafe-path" {
		t.Fatalf("사용자 영역 밖 경로가 거부되지 않았다: %d %+v", code, out)
	}
	// V164: checkPath 의 구조적 거부도 "요청은 처리했다"이므로 ok:true 다 — 거부
	// 사유(residue)를 클라이언트가 읽으려면 이 필드가 있어야 한다.
	if out["ok"] != true {
		t.Fatalf("거부 응답에 ok:true 가 없다: %+v", out)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("경로가 지워졌다: %v", err)
	}
	if br := wtGitRun(t, repo, "branch", "--list", "outside-branch"); br == "" {
		t.Fatal("브랜치가 사라졌다")
	}
}

// FR-GIT-243: 이 저장소의 worktree 가 아닌 경로는 404 다.
func TestAPIGitWorktreeRemove_RejectsUnknownPath(t *testing.T) {
	s, repo, _ := worktreeTestServer(t)
	body := fmt.Sprintf(`{"repo":%q,"path":`+qNopeNope+`,"confirm":true}`, repo)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/remove", body)
	if code != http.StatusNotFound || out["error"] != gitErrNotFound {
		t.Fatalf("want 404 not_found, got %d %+v", code, out)
	}
	wantNoOK(t, out)
}
