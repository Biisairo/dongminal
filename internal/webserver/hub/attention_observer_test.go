package hub

import "testing"

// TELEGRAM_BRIDGE_SRS FR-TGB-50: 알람 방송은 관찰자에게도 같은 판정을 넘긴다. 관찰자가
// 없으면 방송만 한다.
func TestAttnBroadcasts_Observer(t *testing.T) {
	h := NewCommandHub()
	attnBroadcastsOf(h).attention("t1", "done") // 관찰자 없음

	var got []string
	h.SetAttentionObserver(func(id, reason string) { got = append(got, id+":"+reason) })
	attnBroadcastsOf(h).attention("t1", "waiting")
	if len(got) != 1 || got[0] != "t1:waiting" {
		t.Fatalf("got=%v", got)
	}
	h.SetAttentionObserver(nil)
	attnBroadcastsOf(h).attention("t1", "done")
	if len(got) != 1 {
		t.Fatalf("관찰자를 걷었는데 불렸다: %v", got)
	}
}

// TELEGRAM_BRIDGE_SRS FR-TGB-58b: 알람 해제도 관찰자에게 넘긴다.
func TestAttnBroadcasts_ClearObserver(t *testing.T) {
	h := NewCommandHub()
	attnBroadcastsOf(h).attentionClear("t1") // 관찰자 없음

	var got []string
	h.SetAttentionClearObserver(func(id string) { got = append(got, id) })
	attnBroadcastsOf(h).attentionClear("t2")
	if len(got) != 1 || got[0] != "t2" {
		t.Fatalf("got=%v", got)
	}
	h.SetAttentionClearObserver(nil)
	attnBroadcastsOf(h).attentionClear("t3")
	if len(got) != 1 {
		t.Fatalf("관찰자를 걷었는데 불렸다: %v", got)
	}
}

// REFACTOR3_GO_STRUCT_SRS GD-12: 도구를 잊으면(종료·삭제) 관찰자에게 알린다 — 추적기가 그
// 도구를 몰랐어도 알린다(이미 죽은 도구의 삭제). Telegram 브리지가 탭 상태를 걷는다.
func TestAttnTracker_ForgetNotifiesGone(t *testing.T) {
	h := NewCommandHub()
	tr := NewAttnTracker(h, 0)
	tr.Forget("t0") // 관찰자 없음

	var got []string
	h.SetToolGoneObserver(func(id string) { got = append(got, id) })
	tr.SignalAttention("t1", "done")
	tr.Forget("t1")
	tr.Forget("never-seen")
	if len(got) != 2 || got[0] != "t1" || got[1] != "never-seen" {
		t.Fatalf("got=%v", got)
	}
	h.SetToolGoneObserver(nil)
	tr.Forget("t2")
	if len(got) != 2 {
		t.Fatalf("관찰자를 걷었는데 불렸다: %v", got)
	}
}
