package hub

import "dongminal/internal/webserver/sse"

// Claude 다중 계정 변화의 SSE (CLAUDE_ACCOUNTS_SRS FR-CAC-122).
//
// 본문을 싣지 않는다 — 받은 브라우저가 `/api/claude-accounts` 를 다시 받는다
// (`update_changed` 와 같은 규약).
func ClaudeAccountsChangedPayload() []byte {
	return sse.Payload("claude_accounts_changed", nil)
}
