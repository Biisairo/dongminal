package hub

import (
	"errors"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// 통보를 받아 적는 가짜 연결. 실패를 흉내낼 수 있다 (V-RPS-6).
type seatSpy struct {
	got  []byte
	fail bool
}

func (s *seatSpy) Send(op byte, payload []byte) error {
	if op != toolhub.OpReplySeat {
		return nil
	}
	if s.fail {
		return errors.New("소켓이 죽었다")
	}
	s.got = append(s.got, payload[0])
	return nil
}

// last 는 마지막으로 받은 통보다. 없으면 -1.
func (s *seatSpy) last() int {
	if len(s.got) == 0 {
		return -1
	}
	return int(s.got[len(s.got)-1])
}

// V-RPS-1: 첫 연결이 좌석의 주인이다.
func TestReplySeats_FirstOwns(t *testing.T) {
	r := NewReplySeats()
	a := &seatSpy{}
	r.Join("t1", a)
	if a.last() != 1 {
		t.Fatalf("첫 연결이 주인이 아니다: %v", a.got)
	}
}

// V-RPS-2: 둘째는 주인이 아니고, 첫째는 자기가 주인이라는 통보를 다시 받는다 —
// 승계는 전체 재통보이므로 붙을 때도 모두가 듣는다 (FR-RPS-5).
func TestReplySeats_SecondDoesNotOwn(t *testing.T) {
	r := NewReplySeats()
	a, b := &seatSpy{}, &seatSpy{}
	r.Join("t1", a)
	r.Join("t1", b)
	if a.last() != 1 {
		t.Errorf("첫 연결의 좌석이 흔들렸다: %v", a.got)
	}
	if b.last() != 0 {
		t.Errorf("둘째가 주인이 됐다: %v", b.got)
	}
	if len(a.got) != 2 {
		t.Errorf("붙을 때마다 모두에게 통보하지 않았다: %v", a.got)
	}
}

// V-RPS-3: 주인이 떠나면 남은 첫 연결이 승계한다.
func TestReplySeats_SuccessionOnLeave(t *testing.T) {
	r := NewReplySeats()
	a, b, c := &seatSpy{}, &seatSpy{}, &seatSpy{}
	r.Join("t1", a)
	r.Join("t1", b)
	r.Join("t1", c)
	r.Leave("t1", a)
	if b.last() != 1 {
		t.Errorf("승계가 오지 않았다: %v", b.got)
	}
	if c.last() != 0 {
		t.Errorf("셋째가 주인이 됐다: %v", c.got)
	}
}

// V-RPS-4: 주인이 아닌 연결이 떠나도 주인은 그대로다.
func TestReplySeats_NonOwnerLeaveKeepsSeat(t *testing.T) {
	r := NewReplySeats()
	a, b := &seatSpy{}, &seatSpy{}
	r.Join("t1", a)
	r.Join("t1", b)
	r.Leave("t1", b)
	if a.last() != 1 {
		t.Errorf("주인이 바뀌었다: %v", a.got)
	}
}

// 도구가 다르면 좌석도 다르다 — 각 도구가 자기 주인을 갖는다.
func TestReplySeats_PerTool(t *testing.T) {
	r := NewReplySeats()
	a, b := &seatSpy{}, &seatSpy{}
	r.Join("t1", a)
	r.Join("t2", b)
	if a.last() != 1 || b.last() != 1 {
		t.Errorf("도구마다 주인이 서지 않았다: a=%v b=%v", a.got, b.got)
	}
}

// V-RPS-5: 모르는 도구·연결의 해제는 아무 일도 아니다. 끊김은 순서를 보장하지
// 않는다 — 같은 연결이 두 번 떨어질 수도 있다.
func TestReplySeats_LeaveUnknownIsNoop(t *testing.T) {
	r := NewReplySeats()
	a := &seatSpy{}
	r.Leave("없는도구", a)
	r.Join("t1", a)
	r.Leave("t1", a)
	r.Leave("t1", a)
	if a.last() != 1 {
		t.Errorf("예상 밖의 통보: %v", a.got)
	}
}

// V-RPS-6: 통보가 실패하는 연결이 섞여도 나머지는 받는다 (FR-RPS-6).
func TestReplySeats_FailedNotifyDoesNotBlockOthers(t *testing.T) {
	r := NewReplySeats()
	dead, live := &seatSpy{fail: true}, &seatSpy{}
	r.Join("t1", dead)
	r.Join("t1", live)
	if live.last() != 0 {
		t.Fatalf("죽은 소켓이 뒤를 막았다: %v", live.got)
	}
	r.Leave("t1", dead)
	if live.last() != 1 {
		t.Fatalf("승계가 오지 않았다: %v", live.got)
	}
}
