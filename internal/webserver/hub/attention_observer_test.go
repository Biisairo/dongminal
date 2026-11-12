package hub

import "testing"

// TELEGRAM_BRIDGE_SRS FR-TGB-50: 알람 방송은 관찰자에게도 같은 판정을 넘긴다. 관찰자가
// 없으면 방송만 한다. 직접·데몬 모드가 같은 콜백 묶음을 쓴다.
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
