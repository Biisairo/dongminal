package httpapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/run"
)

// ISSUE_TREE_CLOSE_SRS TC-ITX-7: 조율 승계 (FR-ITX-7·8).

func TestRunCoordinate_MovesCallersOpenRunsAndNotifiesRoot(t *testing.T) {
	t.Setenv(dmenv.EnvHome, t.TempDir())
	s, _, store, who := runsServer(t, "tool-a")
	io := s.ToolIO.(*fakeToolIO)
	io.setHas("tool-c", true)
	start := func(coord, tree string) run.Record {
		rec, err := store.Start(run.StartOptions{Objective: "t", Projection: run.DedicatedWindow, Isolation: run.IsolationNone, CoordinatorToolID: coord, Tree: tree})
		if err != nil {
			t.Fatal(err)
		}
		return rec
	}
	treeRec := start("tool-a", "o/r#32")
	root, err := store.AddMember(treeRec.ID, run.MemberSpec{Role: "ccr#32", Agent: "claude", ToolID: "tool-b", TabID: "tab-b", Assign: &run.Assignment{Issue: "o/r#32"}})
	if err != nil {
		t.Fatal(err)
	}
	plain := start("tool-a", "")
	other := start("tool-b", "")
	closed := start("tool-a", "")
	if _, _, err := store.Close(closed.ID, true); err != nil {
		t.Fatal(err)
	}

	who.toolID = "tool-a"
	code, out := postRun(t, s, "/api/runs/coordinate", `{"to":"tool-c"}`)
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	moved, _ := out["moved"].([]any)
	if len(moved) != 2 {
		t.Fatalf("옮긴 Run 이 둘이 아니다: %v", out)
	}
	for id, want := range map[string]string{treeRec.ID: "tool-c", plain.ID: "tool-c", other.ID: "tool-b", closed.ID: "tool-a"} {
		rec, ok := store.Get(id)
		if !ok {
			t.Fatalf("Run %s 이 없다", id)
		}
		if rec.CoordinatorToolID != want {
			t.Errorf("Run %s 의 조율 = %q, want %q", id, rec.CoordinatorToolID, want)
		}
	}
	notified := false
	for _, p := range io.pastes {
		if p.ToolID == "tool-b" && strings.Contains(p.Text, "조율 새 toolId=tool-c") {
			notified = true
		}
	}
	if !notified {
		t.Errorf("루트 노드에 새 조율을 알리지 않았다: %+v", io.pastes)
	}
	_, pre := getRun(t, s, "/api/runs/preamble?member="+root.ID)
	if p, _ := pre["preamble"].(string); !strings.Contains(p, "부모: tool-c — 조율 에이전트") {
		t.Errorf("루트 프리앰블의 부모가 새 조율이 아니다:\n%s", p)
	}
}

func TestRunCoordinate_RejectsDeadOrSelfTarget(t *testing.T) {
	s, _, _, who := runsServer(t, "tool-a")
	who.toolID = "tool-a"
	for _, to := range []string{"tool-z", "tool-a", ""} {
		if code, out := postRun(t, s, "/api/runs/coordinate", `{"to":"`+to+`"}`); code != http.StatusBadRequest {
			t.Errorf("to=%q 를 받았다: %d %v", to, code, out)
		}
	}
}

// ISSUE_TREE_CLOSE_SRS TC-ITX-9 (FR-ITX-47·48): 연결된 worktree 에서 연 Run 의 저장소는
// 메인 경로이고, 기록의 저장소 경로가 사라져도 정리는 메인 경로로 돈다.
func TestApiRun_LinkedWorktreeRecordsMainRepo(t *testing.T) {
	s, repo, mgr := isolatedServer(t, "tool-a")
	linked := filepath.Join(t.TempDir(), "feat")
	gitRun(t, repo, "worktree", "add", "-b", "feat", linked)
	code, rec := postRun(t, s, "/api/runs",
		`{"objective":"가지","projection":"dedicated-window","isolation":"per-run","tree":"o/r#1","cwd":`+testpath.JSONQuote(linked)+`}`)
	if code != http.StatusOK {
		t.Fatalf("Run 시작 want 200, got %d (%+v)", code, rec)
	}
	if rec["repo"] != repo {
		t.Fatalf("repo = %v, want 메인 경로 %s", rec["repo"], repo)
	}
	if rec["mergeInto"] != "feat" {
		t.Fatalf("mergeInto = %v, want feat", rec["mergeInto"])
	}
	path := mustWorktreePath(t, mgr, rec)

	old, ok := s.Runs.Get(rec["id"].(string))
	if !ok {
		t.Fatal("Run 이 없다")
	}
	old.Repo = filepath.Join(t.TempDir(), "지워진-부모-worktree")
	res := s.cleanupWorktrees(context.Background(), old, false)
	if len(res) != 1 || !res[0].Removed {
		t.Fatalf("기록의 저장소가 없어도 메인 경로로 정리한다: %+v", res)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("worktree 가 남았다: %v", err)
	}
}
