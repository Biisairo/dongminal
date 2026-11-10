package hub

import (
	"strings"
	"testing"
)

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
