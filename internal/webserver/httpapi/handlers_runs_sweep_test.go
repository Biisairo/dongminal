package httpapi

import (
	"net/http"
	"os"
	"testing"

	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"
)

// FR-WKT-8a — 종료된 Run 의 정리 진입 (TC-WKT-5a/5b/5c).
//
// epoch 펜싱으로 aborted 된 Run 은 `open` 이 아니라서 close 가 받지 않았고, 그
// worktree 는 기록에만 남고 지울 경로가 없었다 (묶음 W 인계 항목).

// fencedRun 은 멤버 하나로 격리 Run 을 열고, 서버 재기동을 흉내내 그 Run 을
// aborted 로 만든다. 돌려주는 경로는 그 멤버의 작업 트리다.
func fencedRun(t *testing.T) (*Server, string, string, *worktree.Manager) {
	t.Helper()
	s, repo, mgr := isolatedServer(t, "tool-a")

	dir := t.TempDir()
	first := run.NewStore(dir, "epoch-1")
	if err := first.Load(); err != nil {
		t.Fatalf("store load: %v", err)
	}
	s.Runs = first

	runID, _ := startIsolated(t, s, repo, "per-member")
	code, out := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"작가","agent":"claude","id":"tab-a"}`)
	if code != http.StatusOK {
		t.Fatalf("멤버 등록 want 200, got %d (%+v)", code, out)
	}
	path := mustWorktreePath(t, mgr, out)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("worktree 가 만들어지지 않았다: %v", err)
	}

	// 서버 재기동: 다음 세대가 이 Run 을 aborted 로 확정한다 (FR-RUN-5).
	next := run.NewStore(dir, "epoch-2")
	if err := next.Load(); err != nil {
		t.Fatalf("재기동 store load: %v", err)
	}
	s.Runs = next
	rec, ok := next.Get(runID)
	if !ok || rec.State != run.Aborted {
		t.Fatalf("펜싱이 되지 않았다: %+v", rec)
	}
	return s, runID, path, mgr
}

// TC-WKT-5a: aborted Run 을 --force 로 닫으면 트리를 정리한다. 종료 경위는
// 기록이므로 state·abortReason 은 그대로 둔다.
func TestApiRunClose_SweepsAbortedRun(t *testing.T) {
	s, runID, path, _ := fencedRun(t)

	code, out := postRun(t, s, "/api/runs/close", `{"runId":"`+runID+`","force":true}`)
	if code != http.StatusOK {
		t.Fatalf("정리 진입 want 200, got %d (%+v)", code, out)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("clean 인 worktree 가 남았다: %s (err=%v)", path, err)
	}
	if out["state"] != string(run.Aborted) {
		t.Fatalf("정리가 종료 경위를 고쳐 썼다: state=%v", out["state"])
	}
	if out["swept"] != true {
		t.Fatalf("정리 전용 진입임을 알리지 않았다: %+v", out)
	}
	rec, _ := s.Runs.Get(runID)
	if rec.State != run.Aborted || rec.AbortReason != run.AbortDaemonRestart {
		t.Fatalf("레코드가 바뀌었다: state=%s reason=%s", rec.State, rec.AbortReason)
	}
	if n := len(rec.WorktreeTargets()); n != 0 {
		t.Fatalf("정리된 트리가 아직 대상으로 남아 있다: %d건", n)
	}
}

// TC-WKT-5b: --force 없이는 종전대로 거부한다. 트리도 건드리지 않는다.
func TestApiRunClose_AbortedRunRefusedWithoutForce(t *testing.T) {
	s, runID, path, _ := fencedRun(t)

	code, out := postRun(t, s, "/api/runs/close", `{"runId":"`+runID+`"}`)
	if code != http.StatusConflict {
		t.Fatalf("want 409, got %d (%+v)", code, out)
	}
	if out["error"] != run.ErrRunClosed.Error() {
		t.Fatalf("사유가 다르다: %+v", out)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("거부인데 트리가 사라졌다: %v", err)
	}
}

// TC-WKT-5c: 정리는 멱등이다. 이미 제거된 트리는 다시 대상이 되지 않는다 —
// 두 번째 호출이 "지우지 못했다"를 새로 만들어 내면 안 된다.
func TestApiRunClose_SweepIsIdempotent(t *testing.T) {
	s, runID, _, _ := fencedRun(t)

	postRun(t, s, "/api/runs/close", `{"runId":"`+runID+`","force":true}`)
	code, out := postRun(t, s, "/api/runs/close", `{"runId":"`+runID+`","force":true}`)
	if code != http.StatusOK {
		t.Fatalf("재호출 want 200, got %d (%+v)", code, out)
	}
	if n, _ := out["residue"].(float64); n != 0 {
		t.Fatalf("두 번째 정리가 잔여물을 만들어 냈다: %+v", out["worktrees"])
	}
	if wts, _ := out["worktrees"].([]any); len(wts) != 0 {
		t.Fatalf("이미 제거된 트리를 다시 대상으로 삼았다: %+v", wts)
	}
}

// dirty 트리는 aborted Run 에서도 보존이 정답이다 (FR-WKT-8). 정리 진입이
// 열렸다고 해서 사용자 작업을 지우는 경로가 되면 안 된다.
func TestApiRunClose_SweepKeepsDirtyTree(t *testing.T) {
	s, runID, path, _ := fencedRun(t)
	if err := os.WriteFile(path+"/작업물.txt", []byte("아직 안 끝났다\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	code, out := postRun(t, s, "/api/runs/close", `{"runId":"`+runID+`","force":true}`)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, out)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("dirty 트리를 지웠다: %v", err)
	}
	if n, _ := out["residue"].(float64); n != 1 {
		t.Fatalf("잔여물을 보고하지 않았다: %+v", out)
	}
}
