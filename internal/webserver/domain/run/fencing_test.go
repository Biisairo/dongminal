package run

import (
	"testing"
)

// `FBE-03`(PRODUCTION_ROADMAP §M3) — **웹서버만 재시작해도 헤드리스 멤버가 죽는다.**
//
// 펜싱 기준이 `epoch`(웹서버 기동)였다. 그래서 `dongminal stop && start` 로
// 서버만 갈아 끼우면 — 데몬이 보존되어 **도구는 그대로 살아 있는데** — 그 Run 이
// aborted 로 확정되고, 회수기가 15초 안에 멤버를 죽인다.
//
// 종전 코드의 주석이 그 전제를 적고 있었다: *"백그라운드 도구가 재기동을 넘지
// 못하므로 되살릴 실체가 없다"*. 데몬 모드에서 그 전제는 **거짓**이다 — PTY 를
// 가진 것은 데몬이고, 데몬은 서버보다 오래 산다.
//
// 그래서 기준을 바꾼다: **그 멤버의 도구가 실제로 살아 있는가.**

func fenceRunWithMember(t *testing.T, s *Store, toolID string) Record {
	t.Helper()
	rec, err := s.Start(StartOptions{Objective: "x", Projection: Background, Isolation: IsolationNone})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "worker", Agent: "claude", ToolID: toolID}); err != nil {
		t.Fatal(err)
	}
	return rec
}

// 도구가 살아 있으면 **펜싱하지 않는다** — 이것이 접수한 증상이다.
func TestFenceKeepsRunWhoseToolIsAlive(t *testing.T) {
	dir := t.TempDir()
	s1 := NewStore(dir, "epoch-1")
	if err := s1.Load(); err != nil {
		t.Fatal(err)
	}
	fenceRunWithMember(t, s1, "tool-a")

	// 새 웹서버 기동. 도구는 데몬이 들고 있어 살아 있다.
	s2 := NewStore(dir, "epoch-2", WithLiveness(func(id string) bool { return id == "tool-a" }))
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	got := s2.List()
	if len(got) != 1 {
		t.Fatalf("Run 수=%d", len(got))
	}
	if got[0].State != Open {
		t.Fatalf("state=%v want Open — 도구가 살아 있는데 펜싱했다 (FBE-03)", got[0].State)
	}
}

// 도구가 죽었으면 종전대로 펜싱한다 (회귀).
func TestFenceAbortsRunWhoseToolIsGone(t *testing.T) {
	dir := t.TempDir()
	s1 := NewStore(dir, "epoch-1")
	if err := s1.Load(); err != nil {
		t.Fatal(err)
	}
	fenceRunWithMember(t, s1, "tool-a")

	s2 := NewStore(dir, "epoch-2", WithLiveness(func(string) bool { return false }))
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	got := s2.List()
	if got[0].State != Aborted {
		t.Fatalf("state=%v want Aborted — 실체가 없는 Run 은 닫아야 한다", got[0].State)
	}
}

// **생존을 물을 길이 없으면 종전대로다.** 모른다고 살려 두면 고아 Run 이 영원히
// 열린 채 남는다 — 이 갈래는 direct 모드와 옛 배선의 길이다.
func TestFenceWithoutLivenessAbortsAsBefore(t *testing.T) {
	dir := t.TempDir()
	s1 := NewStore(dir, "epoch-1")
	if err := s1.Load(); err != nil {
		t.Fatal(err)
	}
	fenceRunWithMember(t, s1, "tool-a")

	s2 := NewStore(dir, "epoch-2")
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	if got := s2.List(); got[0].State != Aborted {
		t.Fatalf("state=%v want Aborted", got[0].State)
	}
}
