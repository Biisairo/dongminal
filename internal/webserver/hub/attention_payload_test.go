package hub

import (
	"bytes"
	"testing"
)

func TestToolAttentionPayload(t *testing.T) {
	p := toolAttentionPayload("7", "idle")
	if !bytes.Contains(p, []byte(`"action":"tool_attention"`)) ||
		!bytes.Contains(p, []byte(`"toolId":"7"`)) ||
		!bytes.Contains(p, []byte(`"reason":"idle"`)) {
		t.Fatalf("unexpected payload: %s", p)
	}
	c := toolAttentionClearPayload("7")
	if !bytes.Contains(c, []byte(`"action":"tool_attention_clear"`)) ||
		!bytes.Contains(c, []byte(`"toolId":"7"`)) {
		t.Fatalf("unexpected clear payload: %s", c)
	}
}
