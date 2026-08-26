package hub

import (
	"strings"
	"testing"
)

// NFR-AAP-3 / TC-AAP-5: SanitizeActivityField strips control chars and bounds length.
func TestSanitizeActivityField(t *testing.T) {
	in := "a" + string(rune(0x07)) + "b" + string(rune(0x7f)) + "c"
	if got := SanitizeActivityField(in, ActivityDetailMax); got != "abc" {
		t.Fatalf("control chars must be stripped, got %q", got)
	}
	long := strings.Repeat("x", ActivityDetailMax+88)
	if got := SanitizeActivityField(long, ActivityDetailMax); len(got) != ActivityDetailMax {
		t.Fatalf("length must be bounded to %d, got %d", ActivityDetailMax, len(got))
	}
}

// FR-AAP-4 / TC-AAP-7: activity snapshot endpoint returns reported tools.
// FR-AAP-5: tool_activity SSE payload shape (server-published; lowerCamelCase).
func TestToolActivityPayload(t *testing.T) {
	s := string(toolActivityPayload("3", "working", "Bash", "ls"))
	if !strings.Contains(s, `"action":"tool_activity"`) ||
		!strings.Contains(s, `"toolId":"3"`) ||
		!strings.Contains(s, `"state":"working"`) ||
		!strings.Contains(s, `"tool":"Bash"`) ||
		!strings.Contains(s, `"detail":"ls"`) {
		t.Fatalf("unexpected payload: %s", s)
	}
}
