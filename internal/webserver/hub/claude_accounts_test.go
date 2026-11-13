package hub

import "testing"

// CLAUDE_ACCOUNTS_SRS FR-CAC-100a: 알림 SSE 본문.

func TestClaudeAccountAlertPayload(t *testing.T) {
	got := string(ClaudeAccountAlertPayload(map[string]any{"kind": "relogin", "name": "ab***@"}))
	want := `{"action":"claude_account_alert","args":{"kind":"relogin","name":"ab***@"}}`
	if got != want {
		t.Fatalf("%s", got)
	}
}
