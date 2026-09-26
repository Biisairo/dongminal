package sse

import (
	"encoding/json"
	"testing"
)

// 봉투는 종전 map 조립과 바이트가 같다 (FR-OPT-0-3).
func TestPayload_ByteCompatibleWithMap(t *testing.T) {
	cases := []struct {
		action string
		args   any
		old    map[string]any
	}{
		{"update_changed", nil, map[string]any{"action": "update_changed"}},
		{"access_changed", map[string]any{}, map[string]any{"action": "access_changed", "args": map[string]any{}}},
		{"tool_attention", map[string]any{"toolId": "t", "reason": "r"},
			map[string]any{"action": "tool_attention", "args": map[string]any{"toolId": "t", "reason": "r"}}},
	}
	for _, c := range cases {
		want, _ := json.Marshal(c.old)
		if got := Payload(c.action, c.args); string(got) != string(want) {
			t.Errorf("%s: %s, want %s", c.action, got, want)
		}
	}
	want, _ := json.Marshal(map[string]any{"action": "workspace_changed", "args": map[string]any{"rev": uint64(7)}})
	if got := WorkspaceChanged(7); string(got) != string(want) {
		t.Errorf("workspace_changed: %s, want %s", got, want)
	}
}

func TestPayload_MarshalErrorKeepsAction(t *testing.T) {
	if got := string(Payload("x", map[string]any{"c": make(chan int)})); got != `{"action":"x"}` {
		t.Fatalf("got %s", got)
	}
}
