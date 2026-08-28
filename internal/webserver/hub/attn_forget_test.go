package hub

import (
	"bytes"
	"testing"
)

// ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS V-ATL-3·4: 도구가 사라지면 그 주의 상태도
// 사라진다. 지금까지 AttnTracker 에는 제거 경로가 아예 없어, 죽은 도구의 알람이
// `모두 제거` 전까지 남았다 (A2).
func TestAttnTrackerForgetClearsAndDrops(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.SignalAttention("t1", "done")
	if !tr.Attention("t1") {
		t.Fatalf("주의가 서지 않았다")
	}

	tr.Forget("t1")

	if tr.Attention("t1") {
		t.Fatalf("Forget 후에도 주의가 남았다")
	}
	for _, id := range tr.AttentionIDs() {
		if id == "t1" {
			t.Fatalf("AttentionIDs 에 t1 이 남았다")
		}
	}
	var cleared bool
	for _, p := range fb.sent {
		if bytes.Contains(p, []byte(`"action":"tool_attention_clear"`)) &&
			bytes.Contains(p, []byte(`"toolId":"t1"`)) {
			cleared = true
		}
	}
	if !cleared {
		t.Fatalf("해제 브로드캐스트가 없다: %q", fb.sent)
	}
}

// V-ATL-4: 에지다 — 주의가 없던 도구를 잊어도 해제를 발행하지 않는다 (NFR-PAN-3).
func TestAttnTrackerForgetIsEdge(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.SetActivity("t1", "working", "bash", "")
	before := fb.count()

	tr.Forget("t1")

	for _, p := range fb.sent[before:] {
		if bytes.Contains(p, []byte(`"action":"tool_attention_clear"`)) {
			t.Fatalf("주의가 없었는데 해제를 발행했다: %s", p)
		}
	}
	// 상태 자체는 사라진다 — 활동도 함께 버린다.
	if tr.Activity("t1") != nil {
		t.Fatalf("Forget 후에도 활동이 남았다")
	}
}

// 모르는 도구를 잊는 것은 no-op 이다.
func TestAttnTrackerForgetUnknown(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.Forget("nope")
	if fb.count() != 0 {
		t.Fatalf("no-op 이어야 한다: %q", fb.sent)
	}
}

// V-ATL-5: liveness probe 가 거짓을 답하는 도구는 복원 목록에 실리지 않는다.
// 데몬이 재시작하거나 종료 통지를 놓쳐도 유령 알람이 브라우저로 복원되지 않게
// 하는 두 번째 방어선이다 (FR-ATL-6).
func TestAttnTrackerAttentionIDsFiltersDeadTools(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.SignalAttention("alive", "done")
	tr.SignalAttention("dead", "done")
	tr.SetLiveProbe(func(id string) bool { return id == "alive" })

	ids := tr.AttentionIDs()
	if len(ids) != 1 || ids[0] != "alive" {
		t.Fatalf("살아 있는 도구만 남아야 한다: %v", ids)
	}
}

// probe 가 없으면 지금과 같다 — 전부 답한다 (FR-ATL-6).
func TestAttnTrackerAttentionIDsWithoutProbe(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.SignalAttention("a", "done")
	tr.SignalAttention("b", "done")
	if got := len(tr.AttentionIDs()); got != 2 {
		t.Fatalf("probe 가 없으면 전부여야 한다: %d", got)
	}
}
