package hub

import (
	"encoding/json"
	"testing"
)

// V-ATD-4: 알람 방송은 늘어나는 번호를 싣는다 (ATTENTION_FIRING_SRS FR-ATD-1).
func TestToolAttentionPayload_CarriesIncreasingSeq(t *testing.T) {
	seqOf := func(b []byte) uint64 {
		t.Helper()
		raw := b
		if i := len("data: "); len(raw) > i && string(raw[:i]) == "data: " {
			raw = raw[i:]
		}
		var m struct {
			Args struct {
				Seq uint64 `json:"seq"`
			} `json:"args"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("payload %q: %v", b, err)
		}
		return m.Args.Seq
	}
	a := seqOf(toolAttentionPayload("t", "done"))
	b := seqOf(toolAttentionPayload("t", "done"))
	if a == 0 || b <= a {
		t.Fatalf("seq 가 늘지 않는다: %d → %d", a, b)
	}
}
