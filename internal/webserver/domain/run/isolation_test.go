package run

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/uuid"
)

// 묶음 W 의 기록 절반 (RUN_ORCHESTRATION_SRS §3.4). 격리의 git 조작은
// internal/worktree 가 하고, 여기서는 **무엇이 누구의 것이며 무엇이 남았는가**를
// 기록으로 붙잡는다 (FR-WKT-9/12).

// FR-WKT-3/4/9: id 를 호출자가 미리 정할 수 있어야 worktree 를 **레코드가 생기기
// 전에** 만들 수 있다. 그래야 생성 실패가 고아 멤버를 남기지 않는다.
func TestStore_AcceptsPreassignedIdentifiers(t *testing.T) {
	s := newTestStore(t, "epoch-w")
	runID := "01920000-0000-7000-8000-00000000aaaa"
	wt := &Worktree{Path: "/home/worktrees/01920000/01920001", Branch: "dmn/01920000/writer", Base: "main"}

	rec, err := s.Start(StartOptions{
		ID: runID, Objective: "격리 팬아웃", Projection: DedicatedWindow,
		Isolation: IsolationPerRun, CoordinatorToolID: "t1",
		Repo: "/repo", Base: "main", Worktree: wt,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if rec.ID != runID || rec.Short != runID[:8] {
		t.Fatalf("미리 정한 id 가 반영되지 않았다: %+v", rec)
	}
	if rec.Repo != "/repo" || rec.Base != "main" || rec.Worktree == nil || rec.Worktree.Branch != wt.Branch {
		t.Fatalf("격리 정보가 기록되지 않았다: %+v", rec)
	}

	memberID := "01920000-0000-7000-8000-00000000bbbb"
	m, err := s.AddMember(runID, MemberSpec{
		ID: memberID, Role: "작가", Agent: "claude", ToolID: "tool-a", Worktree: wt,
	})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if m.ID != memberID || m.Worktree == nil || m.Worktree.Path != wt.Path {
		t.Fatalf("미리 정한 member id·worktree 가 반영되지 않았다: %+v", m)
	}

	// 영속을 통과하는가 — 정리 주체는 다음 세션일 수 있다.
	blob, err := os.ReadFile(filepath.Join(s.dir, "runs.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(blob) {
		t.Fatal("runs.json 이 깨졌다")
	}
	var body fileBody
	if err := json.Unmarshal(blob, &body); err != nil {
		t.Fatal(err)
	}
	if body.Runs[0].Worktree == nil || body.Runs[0].Members[0].Worktree == nil {
		t.Fatalf("worktree 가 영속되지 않았다: %s", blob)
	}
}

// FR-WKT-12: 정리하지 못한 자원은 기록에 남는다. run status 가 그 뒤에도
// 잔여물을 말할 수 있는 근거다 — 조용히 남기지 않는다.
func TestStore_MarksWorktreeResidue(t *testing.T) {
	s := newTestStore(t, "epoch-w")
	wtA := &Worktree{Path: "/home/worktrees/r/a", Branch: "dmn/r/a", Base: "main"}
	wtB := &Worktree{Path: "/home/worktrees/r/b", Branch: "dmn/r/b", Base: "main"}
	rec, err := s.Start(StartOptions{
		Objective: "격리", Projection: DedicatedWindow, Isolation: IsolationPerMember,
		CoordinatorToolID: "t1", Repo: "/repo", Base: "main",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "a", Agent: "claude", ToolID: "tool-a", Worktree: wtA}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "b", Agent: "claude", ToolID: "tool-b", Worktree: wtB}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	if err := s.MarkWorktrees(rec.ID, []WorktreeMark{
		{Path: wtA.Path, Removed: true},
		{Path: wtB.Path, Removed: false, Residue: "dirty"},
	}); err != nil {
		t.Fatalf("MarkWorktrees: %v", err)
	}

	got, ok := s.Get(rec.ID)
	if !ok {
		t.Fatal("Run 이 사라졌다")
	}
	if !got.Members[0].Worktree.Removed || got.Members[0].Worktree.Residue != "" {
		t.Fatalf("제거된 worktree 표시가 어긋난다: %+v", got.Members[0].Worktree)
	}
	if got.Members[1].Worktree.Removed || got.Members[1].Worktree.Residue != "dirty" {
		t.Fatalf("잔여물이 기록되지 않았다: %+v", got.Members[1].Worktree)
	}
	if err := s.MarkWorktrees("no-such-run", nil); err == nil {
		t.Fatal("알 수 없는 Run 은 거부한다")
	}
}

// FR-WKT-9: 정리 대상은 Run 이 등록한 것뿐이다. 목록의 근거를 레코드로 못박는다.
func TestRecord_WorktreeTargets(t *testing.T) {
	shared := &Worktree{Path: "/home/worktrees/r/shared", Branch: "dmn/r/run", Base: "main"}
	perRun := Record{
		Isolation: IsolationPerRun, Worktree: shared,
		Members: []Member{
			{ID: "m1", Role: "a", Worktree: shared},
			{ID: "m2", Role: "b", Worktree: shared},
		},
	}
	if got := perRun.WorktreeTargets(); len(got) != 1 || got[0].Path != shared.Path {
		t.Fatalf("per-run 은 공유 worktree 하나다: %+v", got)
	}

	perMember := Record{
		Isolation: IsolationPerMember,
		Members: []Member{
			{ID: "m1", Role: "a", Worktree: &Worktree{Path: "/home/worktrees/r/a"}},
			{ID: "m2", Role: "b", Worktree: &Worktree{Path: "/home/worktrees/r/b"}},
			{ID: "m3", Role: "c"},
		},
	}
	if got := perMember.WorktreeTargets(); len(got) != 2 {
		t.Fatalf("멤버별 worktree 만 대상이다: %+v", got)
	}
	if got := (Record{Isolation: IsolationNone, Members: []Member{{ID: "m1"}}}).WorktreeTargets(); len(got) != 0 {
		t.Fatalf("비격리 Run 은 정리 대상이 없다: %+v", got)
	}
}

// FR-WKT-4: 경로 조각은 **연속으로 만든 식별자에서도** 겹치지 않는다.
//
// 이 테스트가 있는 이유는 실제로 밟았기 때문이다 — short(앞 8자)로 경로를
// 만들었더니 같은 밀리초대에 만든 Run·Member 가 전부 같은 경로를 받았다.
// uuid v7 의 앞 48비트는 타임스탬프다.
func TestPathSlug_UniqueForConsecutiveIDs(t *testing.T) {
	const n = 16
	seen := map[string]bool{}
	sameShort := false
	prev := ""
	for i := 0; i < n; i++ {
		id := uuid.NewString()
		if prev != "" && Short(id) == Short(prev) {
			sameShort = true
		}
		slug := PathSlug(id)
		if seen[slug] {
			t.Fatalf("경로 조각이 겹쳤다: %q (%s)", slug, id)
		}
		seen[slug] = true
		prev = id
	}
	if !sameShort {
		t.Skip("이 실행에서는 short 가 겹치지 않았다 — 회귀 검출력이 없다")
	}
}
