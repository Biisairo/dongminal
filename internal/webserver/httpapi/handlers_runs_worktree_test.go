package httpapi

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"

	"dongminal/internal/shared/testpath"
)

// 묶음 W 의 접합 절반 (RUN_ORCHESTRATION_SRS §3.4, TC-WKT-1/2/6/8/12).
//
// 여기 테스트는 전부 **격리된 임시 저장소**를 쓴다. 운영 저장소·사용자 홈을
// 대상으로 하지 않는다 (§4.3, 함정 1~3).

func gitBin(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git 이 없다 — 격리 테스트를 건너뛴다")
	}
	return p
}

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(gitBin(t), args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func tempGitRepo(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "init", "-b", "main")
	gitRun(t, dir, "config", "user.email", "t@example.com")
	gitRun(t, dir, "config", "user.name", "tester")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	return dir
}

// isolatedServer wires a Run server with a worktree manager over a temp home.
func isolatedServer(t *testing.T, caller string) (*Server, string, *worktree.Manager) {
	t.Helper()
	s, _, _, _ := runsServer(t, caller)
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	mgr := worktree.New(filepath.Join(home, "worktrees"))
	s.Worktrees = mgr
	return s, tempGitRepo(t), mgr
}

// mustWorktreePath 는 응답에서 작업 트리 경로를 꺼내되, **관리 루트 아래인지
// 확인한 뒤에야** 돌려준다.
//
// 이 가드가 있는 이유는 실제로 밟았기 때문이다: 구현이 없던 RED 단계에서 응답에
// worktree 가 없어 경로가 빈 문자열이 됐고, filepath.Join("", "작업물.txt") 가
// 테스트의 cwd — 즉 **운영 저장소** — 에 파일을 썼다 (§4.3 함정 1~3).
func mustWorktreePath(t *testing.T, mgr *worktree.Manager, out map[string]any) string {
	t.Helper()
	wt, _ := out["worktree"].(map[string]any)
	path, _ := wt["path"].(string)
	if path == "" {
		t.Fatalf("응답에 worktree 경로가 없다: %+v", out)
	}
	if !strings.HasPrefix(path, mgr.Root()+string(filepath.Separator)) {
		t.Fatalf("경로가 관리 루트 밖이다 — 이 경로에 파일을 쓰지 않는다: %q", path)
	}
	return path
}

func startIsolated(t *testing.T, s *Server, repo, isolation string) (string, map[string]any) {
	t.Helper()
	code, out := postRun(t, s, "/api/runs",
		`{"objective":"격리 팬아웃","projection":"dedicated-window","isolation":`+testpath.JSONQuote(isolation)+`,"cwd":`+testpath.JSONQuote(repo)+`}`)
	if code != http.StatusOK {
		t.Fatalf("격리 Run 시작 want 200, got %d (%+v)", code, out)
	}
	id, _ := out["id"].(string)
	return id, out
}

// TC-WKT-1 / FR-WKT-2/3: per-member 격리는 멤버마다 worktree 를 만들고, 경로는
// uuid 에서 파생하며, base 를 repo config 에 남긴다.
func TestApiRun_PerMemberCreatesWorktrees(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	runID, rec := startIsolated(t, s, repo, "per-member")
	if rec["repo"] != repo || rec["base"] != "main" {
		t.Fatalf("Run 이 저장소·base 를 기록하지 않았다: %+v", rec)
	}

	paths := map[string]bool{}
	for _, tab := range []string{"tab-a", "tab-b"} {
		code, out := postRun(t, s, "/api/runs/members",
			`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":`+testpath.JSONQuote(tab)+`}`)
		if code != http.StatusOK {
			t.Fatalf("멤버 등록 want 200, got %d (%+v)", code, out)
		}
		wt, _ := out["worktree"].(map[string]any)
		if wt == nil {
			t.Fatalf("격리 멤버에 worktree 가 없다: %+v", out)
		}
		path, _ := wt["path"].(string)
		branch, _ := wt["branch"].(string)
		if !strings.HasPrefix(path, mgr.Root()) {
			t.Fatalf("worktree 가 관리 루트 밖이다: %q", path)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("worktree 가 실제로 만들어지지 않았다: %v", err)
		}
		if got := gitRun(t, repo, "config", "--get", "branch."+branch+".base"); got != "main" {
			t.Fatalf("base 가 기록되지 않았다: %q", got)
		}
		if paths[path] {
			t.Fatalf("두 멤버가 같은 경로를 쓴다: %q", path)
		}
		paths[path] = true
		// FR-PRE-4: 프리앰블이 작업 트리를 말해 준다.
		if pre, _ := out["preamble"].(string); !strings.Contains(pre, path) {
			t.Fatalf("프리앰블에 worktree 경로가 없다: %s", pre)
		}
	}
}

// TC-WKT-2 / FR-WKT-4: 같은 role 로 두 번째 Run 을 열어도 경로가 다르다.
func TestApiRun_PathsAreNeverReused(t *testing.T) {
	s, repo, _ := isolatedServer(t, "tool-a")
	first := ""
	for i := 0; i < 2; i++ {
		runID, _ := startIsolated(t, s, repo, "per-member")
		_, out := postRun(t, s, "/api/runs/members",
			`{"runId":`+testpath.JSONQuote(runID)+`,"role":"writer","agent":"claude","id":"tab-a"}`)
		wt, _ := out["worktree"].(map[string]any)
		if wt == nil {
			t.Fatalf("worktree 가 없다: %+v", out)
		}
		path, _ := wt["path"].(string)
		branch, _ := wt["branch"].(string)
		if i == 0 {
			first = path
			// 다음 Run 이 같은 도구를 다시 멤버로 삼을 수 있도록 닫는다.
			postRun(t, s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(runID)+`,"force":true,"keepWorktrees":true}`)
			continue
		}
		if path == first {
			t.Fatalf("경로가 재사용됐다 — 남의 대화 이력을 물려받는다: %q", path)
		}
		if !strings.Contains(branch, "writer") {
			t.Fatalf("브랜치가 역할에서 파생되지 않았다: %q", branch)
		}
	}
}

// FR-WKT-1: per-run 은 트리 하나를 공유한다.
func TestApiRun_PerRunSharesOneWorktree(t *testing.T) {
	s, repo, _ := isolatedServer(t, "tool-a")
	runID, rec := startIsolated(t, s, repo, "per-run")
	shared, _ := rec["worktree"].(map[string]any)
	if shared == nil {
		t.Fatalf("per-run 은 Run 시작에 트리를 만든다: %+v", rec)
	}
	sharedPath, _ := shared["path"].(string)
	if _, err := os.Stat(sharedPath); err != nil {
		t.Fatalf("공유 worktree 가 없다: %v", err)
	}
	for _, tab := range []string{"tab-a", "tab-b"} {
		_, out := postRun(t, s, "/api/runs/members",
			`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":`+testpath.JSONQuote(tab)+`}`)
		wt, _ := out["worktree"].(map[string]any)
		if wt == nil || wt["path"] != sharedPath {
			t.Fatalf("멤버가 공유 트리를 받지 못했다: %+v", out)
		}
	}
}

// TC-WKT-8 / FR-WKT-11: 비git 디렉터리에서 격리 Run 은 명확히 실패한다.
// **none 으로 조용히 낮추지 않는다.**
func TestApiRun_IsolationFailsOutsideRepo(t *testing.T) {
	s, _, _ := isolatedServer(t, "tool-a")
	plain, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	code, out := postRun(t, s, "/api/runs",
		`{"objective":"격리","projection":"dedicated-window","isolation":"per-member","cwd":`+testpath.JSONQuote(plain)+`}`)
	if code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d (%+v)", code, out)
	}
	if out["error"] != "not_a_git_repo" {
		t.Fatalf("사유가 뭉뚱그려졌다: %+v", out)
	}
	if len(s.Runs.List()) != 0 {
		t.Fatal("실패한 격리 Run 이 기록에 남았다")
	}

	// cwd 자체를 주지 않은 경우도 마찬가지다 — 추측해서 진행하지 않는다.
	if code, out := postRun(t, s, "/api/runs",
		`{"objective":"격리","projection":"dedicated-window","isolation":"per-run"}`); code != http.StatusBadRequest {
		t.Fatalf("cwd 없는 격리 Run: want 400, got %d (%+v)", code, out)
	}
	// 비격리는 영향이 없다 (NFR-RUN-1).
	if code, _ := postRun(t, s, "/api/runs",
		`{"objective":"보통","projection":"dedicated-window","isolation":"none"}`); code != http.StatusOK {
		t.Fatalf("비격리 Run 이 깨졌다: %d", code)
	}
}

// TC-WKT-4/5 / FR-WKT-8/12: close 는 clean 을 지우고 dirty 를 보존·보고한다.
func TestApiRunClose_CleansCleanKeepsDirty(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	runID, _ := startIsolated(t, s, repo, "per-member")

	paths := map[string]string{}
	for _, tab := range []string{"tab-a", "tab-b"} {
		_, out := postRun(t, s, "/api/runs/members",
			`{"runId":`+testpath.JSONQuote(runID)+`,"role":`+testpath.JSONQuote(tab)+`,"agent":"claude","id":`+testpath.JSONQuote(tab)+`}`)
		paths[tab] = mustWorktreePath(t, mgr, out)
	}
	dirtyFile := filepath.Join(paths["tab-b"], "작업물.txt")
	if err := os.WriteFile(dirtyFile, []byte("지우면 안 된다\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out := postRun(t, s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(runID)+`,"force":true}`)
	if code != http.StatusOK {
		t.Fatalf("close want 200, got %d (%+v)", code, out)
	}
	trees, _ := out["worktrees"].([]any)
	if len(trees) != 2 {
		t.Fatalf("정리 결과가 멤버 수와 다르다: %+v", out["worktrees"])
	}
	byPath := map[string]map[string]any{}
	for _, tv := range trees {
		e, _ := tv.(map[string]any)
		p, _ := e["path"].(string)
		byPath[p] = e
	}
	if e := byPath[paths["tab-a"]]; e == nil || e["removed"] != true {
		t.Fatalf("clean worktree 가 정리되지 않았다: %+v", e)
	}
	if _, err := os.Stat(paths["tab-a"]); !os.IsNotExist(err) {
		t.Error("clean worktree 경로가 남았다")
	}
	if e := byPath[paths["tab-b"]]; e == nil || e["removed"] == true || e["residue"] != "dirty" {
		t.Fatalf("dirty 가 잔여물로 보고되지 않았다: %+v", e)
	}
	if _, err := os.Stat(dirtyFile); err != nil {
		t.Fatalf("사용자 작업이 삭제됐다: %v", err)
	}

	// FR-WKT-12: 닫힌 뒤에도 기록이 잔여물을 말한다 (run status).
	_, st := getRun(t, s, "/api/runs?id="+runID)
	members, _ := st["members"].([]any)
	found := false
	for _, mv := range members {
		m, _ := mv.(map[string]any)
		wt, _ := m["worktree"].(map[string]any)
		if wt != nil && wt["residue"] == "dirty" {
			found = true
		}
	}
	if !found {
		t.Fatalf("기록에 잔여물이 남지 않았다: %+v", st)
	}
}

// TC-WKT-6 / FR-WKT-9: 등록되지 않은 worktree 는 발견되더라도 건드리지 않는다.
func TestApiRunClose_LeavesUnregisteredWorktrees(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	runID, _ := startIsolated(t, s, repo, "per-member")
	_, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"writer","agent":"claude","id":"tab-a"}`)
	wt, _ := out["worktree"].(map[string]any)
	if wt == nil {
		t.Fatalf("worktree 가 없다: %+v", out)
	}

	// 사용자가 손으로 만든 것 — 같은 루트 아래에 있어도 Run 의 것이 아니다.
	mine := filepath.Join(mgr.Root(), "사용자", "직접만든것")
	if err := os.MkdirAll(filepath.Dir(mine), 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "worktree", "add", "--no-track", "-b", "mine", mine)

	if code, out := postRun(t, s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(runID)+`,"force":true}`); code != http.StatusOK {
		t.Fatalf("close want 200, got %d (%+v)", code, out)
	}
	if _, err := os.Stat(mine); err != nil {
		t.Fatalf("사용자의 worktree 가 사라졌다: %v", err)
	}
	if br := gitRun(t, repo, "branch", "--list", "mine"); br == "" {
		t.Fatal("사용자의 브랜치가 사라졌다")
	}
}

// FR-WKT-8: --keep-worktrees 는 전부 보존하고 그 사실을 보고한다.
func TestApiRunClose_KeepWorktrees(t *testing.T) {
	s, repo, _ := isolatedServer(t, "tool-a")
	runID, _ := startIsolated(t, s, repo, "per-run")
	_, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"writer","agent":"claude","id":"tab-a"}`)
	wt, _ := out["worktree"].(map[string]any)
	path, _ := wt["path"].(string)

	_, closed := postRun(t, s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(runID)+`,"force":true,"keepWorktrees":true}`)
	trees, _ := closed["worktrees"].([]any)
	if len(trees) != 1 {
		t.Fatalf("per-run 은 공유 트리 하나를 보고한다: %+v", closed["worktrees"])
	}
	e, _ := trees[0].(map[string]any)
	if e["removed"] == true || e["residue"] != "kept" {
		t.Fatalf("보존이 보고되지 않았다: %+v", e)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("보존을 요청했는데 지워졌다: %v", err)
	}
}

// V154 (FR-WKT-14): Run 정리가 사용자 worktree 경로를 **동작으로** 거부한다.
//
// 지금 코드에서 Run 레코드의 Worktree 필드는 provisionRun/provisionMember 가
// s.Worktrees.Path(...) 로 직접 만든 경로만 갖는다 — 사용자 영역 경로가 그 필드에
// 들어올 입력 경로는 없다(조사로 확인). 그래서 이 테스트는 **"만약 들어온다면"을
// 강제로 만들어 고정한다** — 이름 규약이 아니라 checkPath 의 구조적 거부가 실제로
// 작동하는지를 cleanupWorktrees 경로 그대로 지나가며 확인한다 (FR-WKT-13).
func TestCleanupWorktrees_RejectsUserAreaSiblingPath(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")

	// FR-WKT-13: 사용자 영역은 <home>/git-worktrees 로, Run 영역(mgr.Root() ==
	// <home>/worktrees)의 형제다.
	userArea := filepath.Join(filepath.Dir(mgr.Root()), "git-worktrees", "repo", "feature")
	if err := os.MkdirAll(filepath.Dir(userArea), 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "worktree", "add", "--no-track", "-b", "user-branch", userArea)
	if _, err := os.Stat(userArea); err != nil {
		t.Fatalf("사용자 worktree 준비 실패: %v", err)
	}

	// Run 레코드를 직접 조립한다 — HTTP 경로로는 이런 레코드가 만들어질 수 없다는
	// 것이 바로 위 주석의 사실이다. 여기서는 cleanupWorktrees 자체의 거부를 본다.
	rec := run.Record{
		ID:        "forged-run",
		Repo:      repo,
		Isolation: run.IsolationPerRun,
		Worktree:  &run.Worktree{Path: userArea, Branch: "user-branch"},
	}

	trees := s.cleanupWorktrees(rec, false)
	if len(trees) != 1 {
		t.Fatalf("정리 대상 1개를 기대했다: %+v", trees)
	}
	if trees[0].Removed || trees[0].Residue != worktree.ResidueUnsafePath {
		t.Fatalf("사용자 영역 경로가 거부되지 않았다: %+v", trees[0])
	}
	if _, err := os.Stat(userArea); err != nil {
		t.Fatalf("사용자 worktree 가 지워졌다: %v", err)
	}
	if br := gitRun(t, repo, "branch", "--list", "user-branch"); br == "" {
		t.Fatal("사용자의 브랜치가 사라졌다")
	}
}
