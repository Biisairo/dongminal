package hub

import (
	"strings"
	"testing"
	"unicode/utf8"
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

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-6 (IPC-27) — 상한에서 자를 때 글자 중간을 끊지 않는다.
func TestSanitizeActivityField_CutsOnRuneBoundary(t *testing.T) {
	s := strings.Repeat("가", 200) // 3 바이트 × 200
	got := SanitizeActivityField(s, ActivityDetailMax)
	if !utf8.ValidString(got) {
		t.Fatalf("잘린 결과가 UTF-8 이 아니다: % x", got[len(got)-3:])
	}
	if len(got) > ActivityDetailMax || len(got) != 510 {
		t.Fatalf("len = %d, want 510 (상한 이하의 마지막 글자 경계)", len(got))
	}
	if got := SanitizeActivityField("abc", 2); got != "ab" {
		t.Fatalf("ASCII = %q", got)
	}
}
