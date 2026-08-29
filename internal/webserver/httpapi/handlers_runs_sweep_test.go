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
		`{"runId":`+jsonQ(runID)+`,"role":"작가","agent":"claude","id":"tab-a"}`)
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

	code, out := postRun(t, s, "/api/runs/close", `{"runId":`+jsonQ(runID)+`,"force":true}`)
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
	// UX_REVISION_SRS FR-DEL-12: 정리가 끝나고 잔여가 없으면 레코드는 사라진다.
	// 종료 경위는 **응답**이 말한다 (위의 state·swept) — 그것이 이제 그 사실을
	// 아는 마지막 자리다.
	if _, ok := s.Runs.Get(runID); ok {
		t.Fatal("잔여 없는 정리 뒤에도 레코드가 남아 있다 (FR-DEL-12)")
	}
}

// TC-WKT-5b: --force 없이는 종전대로 거부한다. 트리도 건드리지 않는다.
func TestApiRunClose_AbortedRunRefusedWithoutForce(t *testing.T) {
	s, runID, path, _ := fencedRun(t)

	code, out := postRun(t, s, "/api/runs/close", `{"runId":`+jsonQ(runID)+`}`)
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

// TC-WKT-5c 개정 (UX_REVISION_SRS FR-DEL-12): 잔여 없는 정리는 레코드를 지우므로
// **재진입할 대상이 없다.** 두 번째 호출은 unknown_run 이며, 이것이 멱등의 새
// 표현이다 — 같은 트리를 두 번 지우려 들지 않는다는 보장은 그대로다.
func TestApiRunClose_SweepLeavesNothingToReenter(t *testing.T) {
	s, runID, _, _ := fencedRun(t)

	postRun(t, s, "/api/runs/close", `{"runId":`+jsonQ(runID)+`,"force":true}`)
	code, out := postRun(t, s, "/api/runs/close", `{"runId":`+jsonQ(runID)+`,"force":true}`)
	if code != http.StatusNotFound {
		t.Fatalf("재호출 want 404, got %d (%+v)", code, out)
	}
	if out["error"] != "unknown_run" {
		t.Fatalf("사유가 다르다: %+v", out)
	}
}

// 잔여가 남은 정리는 레코드를 보존하므로 **재진입이 살아 있다** (FR-DEL-9a).
// 두 번째 호출이 "지우지 못했다"를 새로 만들어 내지 않는 것도 그대로다.
func TestApiRunClose_SweepIsIdempotentWhileResidueRemains(t *testing.T) {
	s, runID, path, _ := fencedRun(t)
	if err := os.WriteFile(path+"/작업물.txt", []byte("아직 안 끝났다\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	postRun(t, s, "/api/runs/close", `{"runId":`+jsonQ(runID)+`,"force":true}`)
	code, out := postRun(t, s, "/api/runs/close", `{"runId":`+jsonQ(runID)+`,"force":true}`)
	if code != http.StatusOK {
		t.Fatalf("재호출 want 200, got %d (%+v)", code, out)
	}
	if n, _ := out["residue"].(float64); n != 1 {
		t.Fatalf("잔여물 보고가 흔들렸다: %+v", out["worktrees"])
	}
}

// dirty 트리는 aborted Run 에서도 보존이 정답이다 (FR-WKT-8). 정리 진입이
// 열렸다고 해서 사용자 작업을 지우는 경로가 되면 안 된다.
func TestApiRunClose_SweepKeepsDirtyTree(t *testing.T) {
	s, runID, path, _ := fencedRun(t)
	if err := os.WriteFile(path+"/작업물.txt", []byte("아직 안 끝났다\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	code, out := postRun(t, s, "/api/runs/close", `{"runId":`+jsonQ(runID)+`,"force":true}`)
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
