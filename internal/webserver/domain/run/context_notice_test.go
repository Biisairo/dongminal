package run

import "testing"

// AGENT_RECORD_DAEMON_SRS FR-ARD-6 (TC-ARD-5) — 맥락 경고 통지 기록은 멤버 기록에
// 둔다. 서버가 다시 떠도 같은 멤버·등급에 두 번 통지하지 않는다.
func TestClaimContextNoticeSurvivesReload(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	rec, err := s.Start(StartOptions{Objective: "x", Projection: Background, Isolation: IsolationNone, CoordinatorToolID: "coord"})
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.AddMember(rec.ID, MemberSpec{Role: "worker", Agent: "claude", ToolID: "tool-a"})
	if err != nil {
		t.Fatal(err)
	}

	if !s.ClaimContextNotice(m.ID, LevelWarn) {
		t.Fatal("첫 통지는 권한을 받아야 한다")
	}
	if s.ClaimContextNotice(m.ID, LevelWarn) {
		t.Fatal("같은 등급의 두 번째 통지는 거절해야 한다")
	}

	s2 := NewStore(dir)
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	if s2.ClaimContextNotice(m.ID, LevelWarn) {
		t.Fatal("다시 읽은 저장소가 통지 기록을 잃었다 (FR-ARD-6)")
	}
	if !s2.ClaimContextNotice(m.ID, LevelCritical) {
		t.Fatal("다른 등급은 통지해야 한다")
	}
	_, got, _ := s2.FindMember(m.ID)
	if len(got.ContextNotified) != 2 {
		t.Fatalf("contextNotified=%v want [warn critical]", got.ContextNotified)
	}
}

func TestClaimContextNoticeUnknownMember(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	if s.ClaimContextNotice("no-such-member", LevelWarn) {
		t.Fatal("없는 멤버에는 통지 권한을 주지 않는다")
	}
}

// 돌려준 멤버의 목록을 고쳐도 저장소에 닿지 않는다 (FR-SAF-4).
func TestContextNotifiedIsCloned(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Background, Isolation: IsolationNone})
	m, _ := s.AddMember(rec.ID, MemberSpec{Role: "worker", Agent: "claude", ToolID: "tool-a"})
	s.ClaimContextNotice(m.ID, LevelWarn)
	_, got, _ := s.FindMember(m.ID)
	got.ContextNotified[0] = "changed"
	_, again, _ := s.FindMember(m.ID)
	if again.ContextNotified[0] != LevelWarn {
		t.Fatalf("저장소 내부가 새어 나갔다: %v", again.ContextNotified)
	}
}
