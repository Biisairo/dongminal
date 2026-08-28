package run

import (
	"errors"
	"strconv"
	"testing"
)

// 묶음 V — 메시지 로그의 검증 (ORCHESTRATION_V2_SRS FR-RVZ-14).
//
// 여기서 고정하는 것은 셋이다: 상한(500), 팀 밖 통신의 배제, 그리고 본문이
// 애초에 들어올 자리가 없다는 것(NFR-RVZ-3).

func msgStore(t *testing.T) (*Store, Record, Member) {
	t.Helper()
	s := NewStore(t.TempDir(), "epoch-v")
	if err := s.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	rec, err := s.Start(StartOptions{
		Objective: "합평", Projection: Inline, Isolation: IsolationNone,
		CoordinatorToolID: "tool-coord",
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	m, err := s.AddMember(rec.ID, MemberSpec{Role: "작가", Agent: "claude", ToolID: "tool-a"})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	return s, rec, m
}

// V-RVZ-11 / FR-RVZ-14: 501건을 적으면 500건이 남고, **앞에서** 버려진다.
func TestAppendMessage_CapsAtFiveHundredDroppingTheOldest(t *testing.T) {
	s, rec, m := msgStore(t)
	total := MaxMessages + 1
	for i := 0; i < total; i++ {
		ev := MsgEvent{From: CoordinatorParty, To: m.ID, At: int64(i + 1), Kind: MsgKindAgent, Size: i}
		if err := s.AppendMessage(rec.ID, ev); err != nil {
			t.Fatalf("AppendMessage(%d): %v", i, err)
		}
	}
	got, ok := s.Get(rec.ID)
	if !ok {
		t.Fatal("Run 이 사라졌다")
	}
	if len(got.Messages) != MaxMessages {
		t.Fatalf("want %d건, got %d건", MaxMessages, len(got.Messages))
	}
	// 버려진 것은 가장 오래된 1건이다 — 남은 첫 건이 두 번째로 적은 것이어야 한다.
	if got.Messages[0].At != 2 {
		t.Fatalf("앞에서 버리지 않았다: 첫 건 at=%d", got.Messages[0].At)
	}
	if got.Messages[len(got.Messages)-1].At != int64(total) {
		t.Fatalf("최근 건이 남지 않았다: 마지막 at=%d", got.Messages[len(got.Messages)-1].At)
	}
}

// FR-RVZ-14: 상한을 넘긴 뒤에도 **이미 나간 복사본이 뒤에서 바뀌지 않는다.**
// 제자리에서 밀면 잠금 밖의 독자가 읽는 배열이 조용히 달라진다.
func TestAppendMessage_DoesNotMutateAlreadyReturnedRecords(t *testing.T) {
	s, rec, m := msgStore(t)
	for i := 0; i < MaxMessages; i++ {
		if err := s.AppendMessage(rec.ID, MsgEvent{
			From: CoordinatorParty, To: m.ID, At: int64(i + 1), Size: i,
		}); err != nil {
			t.Fatalf("AppendMessage(%d): %v", i, err)
		}
	}
	snapshot, _ := s.Get(rec.ID)
	first := snapshot.Messages[0].At

	if err := s.AppendMessage(rec.ID, MsgEvent{From: CoordinatorParty, To: m.ID, At: 9999}); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if snapshot.Messages[0].At != first {
		t.Fatalf("이미 나간 복사본이 뒤에서 바뀌었다: %d → %d", first, snapshot.Messages[0].At)
	}
}

// FR-RVZ-14: 발신·수신 중 어느 쪽도 그 Run 의 멤버가 아니면 기록하지 않는다.
// 조정자끼리의 통신도 여기서 걸린다 — 멤버가 하나도 없다.
func TestAppendMessage_RejectsTrafficWithNoMemberOnEitherSide(t *testing.T) {
	s, rec, _ := msgStore(t)
	for _, ev := range []MsgEvent{
		{From: "outsider-1", To: "outsider-2"},
		{From: CoordinatorParty, To: CoordinatorParty},
		{From: CoordinatorParty, To: "남의-run-멤버"},
	} {
		if err := s.AppendMessage(rec.ID, ev); !errors.Is(err, ErrNotRunParticipant) {
			t.Fatalf("팀 밖 통신이 기록됐다 (%+v): err=%v", ev, err)
		}
	}
	if got, _ := s.Get(rec.ID); len(got.Messages) != 0 {
		t.Fatalf("거부된 통신이 남았다: %+v", got.Messages)
	}
}

// FR-RVZ-14: **조정자는 멤버가 아니지만** 조정자→멤버는 기록 대상이다. 규칙은
// "어느 쪽도 아니면" 이지 "양쪽 다여야" 가 아니다.
func TestAppendMessage_RecordsCoordinatorToMember(t *testing.T) {
	s, rec, m := msgStore(t)
	if err := s.AppendMessage(rec.ID, MsgEvent{
		From: CoordinatorParty, To: m.ID, Kind: MsgKindAgent, Size: 128,
	}); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	got, _ := s.Get(rec.ID)
	if len(got.Messages) != 1 {
		t.Fatalf("조정자→멤버가 기록되지 않았다: %+v", got.Messages)
	}
	ev := got.Messages[0]
	if ev.From != CoordinatorParty || ev.To != m.ID || ev.Size != 128 {
		t.Fatalf("이벤트가 어긋난다: %+v", ev)
	}
	// At 은 저장소 시계로 채워진다 — 호출자가 시각을 몰라도 사실이 온전해야 한다.
	if ev.At == 0 {
		t.Fatalf("시각이 비었다: %+v", ev)
	}
}

// 거부 사유를 뭉뚱그리지 않는다 (FR-PRE-6) — "그런 Run 이 없다"와 "이 Run 과
// 무관한 통신이다"는 호출자가 다르게 다뤄야 하는 사실이다.
func TestAppendMessage_RejectsUnknownRunAndEmptyParties(t *testing.T) {
	s, rec, m := msgStore(t)
	if err := s.AppendMessage("없는-run", MsgEvent{From: CoordinatorParty, To: m.ID}); !errors.Is(err, ErrUnknownRun) {
		t.Fatalf("want ErrUnknownRun, got %v", err)
	}
	for _, ev := range []MsgEvent{{From: "", To: m.ID}, {From: m.ID, To: ""}} {
		if err := s.AppendMessage(rec.ID, ev); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("빈 당사자가 통과했다 (%+v): err=%v", ev, err)
		}
	}
}

// FR-RVZ-14: 메시지 로그는 영속된다 — 그래프는 재시작 뒤에도 같은 팀 모양이다.
func TestAppendMessage_SurvivesReload(t *testing.T) {
	s, rec, m := msgStore(t)
	for i := 0; i < 3; i++ {
		if err := s.AppendMessage(rec.ID, MsgEvent{
			From: m.ID, To: CoordinatorParty, At: int64(i + 1), Size: len(strconv.Itoa(i)),
		}); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
	}
	reloaded := NewStore(s.dir, "epoch-v")
	if err := reloaded.Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	got, ok := reloaded.Get(rec.ID)
	if !ok || len(got.Messages) != 3 {
		t.Fatalf("메시지가 살아남지 못했다: ok=%v %+v", ok, got.Messages)
	}
}
