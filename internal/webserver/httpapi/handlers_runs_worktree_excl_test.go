package httpapi

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/write"
	"dongminal/internal/webserver/domain/worktree"
)

// REPO_FIX 01 §5.6 — Run 격리 정리는 사용 중인 worktree 를 지우지 않는다. 생성·제거는
// 사용자 worktree 잡과 같은 repoLock(common-dir 키)을 문다.

func memberTree(t *testing.T, s *Server, mgr *worktree.Manager, runID string) string {
	t.Helper()
	_, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"w","agent":"claude","id":"tab-a"}`)
	return mustWorktreePath(t, mgr, out)
}

func closeTrees(t *testing.T, s *Server, runID string) map[string]any {
	t.Helper()
	code, out := postRun(t, s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(runID)+`,"force":true}`)
	if code != http.StatusOK {
		t.Fatalf("close = %d %+v", code, out)
	}
	trees, _ := out["worktrees"].([]any)
	if len(trees) != 1 {
		t.Fatalf("정리 결과 = %+v", out["worktrees"])
	}
	e, _ := trees[0].(map[string]any)
	return e
}

// 대상 worktree 의 index 칸이 차 있으면 지우지 않고 잔여물로 보고한다.
func TestRunCleanup_IndexJobInTargetIsResidue(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	s.GitExclusion = jobs.NewExclusion()
	runID, _ := startIsolated(t, s, repo, "per-member")
	path := memberTree(t, s, mgr, runID)
	release := make(chan struct{})
	defer close(release)
	h := jobs.NewJobs(core.New(), jobs.WithExclusion(s.GitExclusion),
		jobs.WithJobRunner(func(ctx context.Context, _ string, _ []string, _ string, _ func(string, string)) (int, error) {
			select {
			case <-release:
			case <-ctx.Done():
			}
			return 0, nil
		}))
	keys := jobs.Keys{Top: core.ExclusionKey(path), Common: core.ExclusionKey(path)}
	if _, err := h.Start(path, keys, "commit", write.CommitSpec(write.CommitOpts{Message: "x"})); err != nil {
		t.Fatal(err)
	}
	e := closeTrees(t, s, runID)
	if e["removed"] == true || e["residue"] != worktree.ResidueRemoveFailed || e["detail"] != runTreeBusyDetail {
		t.Fatalf("= %+v, want 잔여물(%s)", e, runTreeBusyDetail)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("사용 중인 worktree 가 지워졌다: %v", err)
	}
}

// 대상 toplevel 뮤텍스를 TryLock 하지 못하면(동기 쓰기 중) 잔여물이다.
func TestRunCleanup_SyncWriteInTargetIsResidue(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	s.GitExclusion = jobs.NewExclusion()
	runID, _ := startIsolated(t, s, repo, "per-member")
	path := memberTree(t, s, mgr, runID)
	rel, err := s.GitExclusion.LockTop(context.Background(), core.ExclusionKey(path), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer rel()
	e := closeTrees(t, s, runID)
	if e["removed"] == true || e["residue"] != worktree.ResidueRemoveFailed || e["detail"] != runTreeBusyDetail {
		t.Fatalf("= %+v, want 잔여물(%s)", e, runTreeBusyDetail)
	}
}

// 밖에서 지운 worktree 도 정리된다(키가 나온다).
func TestRunCleanup_GoneOutsideIsRemoved(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	s.GitExclusion = jobs.NewExclusion()
	runID, _ := startIsolated(t, s, repo, "per-member")
	path := memberTree(t, s, mgr, runID)
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
	if e := closeTrees(t, s, runID); e["removed"] != true {
		t.Fatalf("= %+v, want removed", e)
	}
}

// 멤버 생성은 common-dir 키의 repoLock 을 문다 — 사용자 worktree 잡이 쥐고 있으면
// 대기 상한 뒤 실패한다(여기서는 상한을 줄인 Manager).
func TestRunProvision_WaitsOnCommonDirRepoLock(t *testing.T) {
	s, repo, _ := isolatedServer(t, "tool-a")
	mgr := worktree.New(s.Worktrees.Root(), worktree.WithLockWait(50*time.Millisecond))
	s.Worktrees = mgr
	runID, _ := startIsolated(t, s, repo, "per-member")
	key, err := core.New().CommonDirKey(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	release, err := worktree.LockRepo(context.Background(), key, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	code, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"w","agent":"claude","id":"tab-a"}`)
	if code != http.StatusConflict || out["error"] != "repo_busy" {
		t.Fatalf("= %d %+v, want 409 repo_busy", code, out)
	}
}
