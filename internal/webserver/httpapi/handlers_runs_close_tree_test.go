package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/worktree"
)

// ISSUE_TREE_CLOSE_SRS 묶음 G — 트리 Run 은 병합 대상에 병합된 뒤에만 worktree 를
// 지운다 (TC-ITX-4·5·6 HTTP 쪽).

func startTreeRun(t *testing.T, s *Server, repo string) (string, map[string]any) {
	t.Helper()
	code, out := postRun(t, s, "/api/runs",
		`{"objective":"트리","projection":"dedicated-window","isolation":"per-run","tree":"o/r#1","cwd":`+testpath.JSONQuote(repo)+`}`)
	if code != http.StatusOK {
		t.Fatalf("트리 Run 시작 want 200, got %d (%+v)", code, out)
	}
	return out["id"].(string), out
}

func closeRun(t *testing.T, s *Server, runID string, force bool) map[string]any {
	t.Helper()
	body := `{"runId":` + testpath.JSONQuote(runID) + `}`
	if force {
		body = `{"runId":` + testpath.JSONQuote(runID) + `,"force":true}`
	}
	code, out := postRun(t, s, "/api/runs/close", body)
	if code != http.StatusOK {
		t.Fatalf("close want 200, got %d (%+v)", code, out)
	}
	return out
}

func firstTreeResult(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	trees, _ := out["worktrees"].([]any)
	if len(trees) != 1 {
		t.Fatalf("worktree 결과가 하나가 아니다: %+v", out["worktrees"])
	}
	return trees[0].(map[string]any)
}

// FR-ITX-40: 격리 Run 은 cwd 의 현재 브랜치를 병합 대상으로 남긴다.
func TestApiRun_RecordsMergeInto(t *testing.T) {
	s, repo, _ := isolatedServer(t, "tool-a")
	_, rec := startTreeRun(t, s, repo)
	if rec["mergeInto"] != "main" {
		t.Fatalf("mergeInto = %v, want main", rec["mergeInto"])
	}
}

// FR-ITX-40: --base 를 줘도 병합 대상은 cwd 의 브랜치다(가지 Run).
func TestApiRun_RecordsMergeIntoWithBase(t *testing.T) {
	s, repo, _ := isolatedServer(t, "tool-a")
	head := gitRun(t, repo, "rev-parse", "HEAD")
	code, out := postRun(t, s, "/api/runs",
		`{"objective":"가지","projection":"dedicated-window","isolation":"per-run","tree":"o/r#1","base":`+testpath.JSONQuote(head)+`,"cwd":`+testpath.JSONQuote(repo)+`}`)
	if code != http.StatusOK {
		t.Fatalf("가지 Run 시작 want 200, got %d (%+v)", code, out)
	}
	if out["mergeInto"] != "main" {
		t.Fatalf("mergeInto = %v, want main", out["mergeInto"])
	}
}

// FR-ITX-41·46: 병합되지 않은 트리 Run 의 worktree 는 남고 기록도 남는다. 병합한 뒤
// 정리 전용 진입은 지운다.
func TestApiRunClose_TreeKeepsUnmergedThenSweeps(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	runID, rec := startTreeRun(t, s, repo)
	path := mustWorktreePath(t, mgr, rec)
	branch := rec["worktree"].(map[string]any)["branch"].(string)
	if err := os.WriteFile(filepath.Join(path, "작업물.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, path, "add", ".")
	gitRun(t, path, "commit", "-m", "work")

	got := firstTreeResult(t, closeRun(t, s, runID, false))
	if got["removed"] == true || got["residue"] != worktree.ResidueUnmerged {
		t.Fatalf("병합되지 않은 트리는 unmerged 다: %+v", got)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("worktree 를 지웠다: %v", err)
	}
	if _, ok := s.Runs.Get(runID); !ok {
		t.Fatal("잔여물이 있는데 Run 기록을 지웠다")
	}

	gitRun(t, repo, "merge", "--ff-only", branch)
	got = firstTreeResult(t, closeRun(t, s, runID, true))
	if got["removed"] != true {
		t.Fatalf("병합 뒤 정리 전용 진입은 지운다: %+v", got)
	}
	if out := gitRun(t, repo, "branch", "--list", branch); out != "" {
		t.Errorf("병합된 트리 브랜치가 남았다: %q", out)
	}
}

// FR-ITX-45: 트리가 아닌 Run 은 지금처럼 병합 여부와 관계없이 깨끗하면 worktree 를 지운다.
func TestApiRunClose_NonTreeUnchanged(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	runID, rec := startIsolated(t, s, repo, "per-run")
	path := mustWorktreePath(t, mgr, rec)
	if err := os.WriteFile(filepath.Join(path, "작업물.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, path, "add", ".")
	gitRun(t, path, "commit", "-m", "work")

	got := firstTreeResult(t, closeRun(t, s, runID, false))
	if got["removed"] != true || got["residue"] != worktree.ResidueBranchRetained {
		t.Fatalf("트리가 아닌 Run 의 정리 규칙이 바뀌었다: %+v", got)
	}
}
