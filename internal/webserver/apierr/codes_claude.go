package apierr

// Claude 다중 계정 API(`/api/claude-accounts/*`)의 코드 (CLAUDE_ACCOUNTS_SRS FR-CAC-121).
// 본문은 fs 방언 `{code,message}` 다.
const (
	CodeClaudeAccountsUnavailable = "claude_accounts_unavailable"
	CodeClaudeAccountNotFound     = "claude_account_not_found"
	CodeClaudeAccountInvalid      = "claude_account_invalid"
	CodeClaudeNotLoggedIn         = "claude_not_logged_in"
	CodeClaudeBackupEmpty         = "claude_backup_empty"
	CodeClaudeLocked              = "claude_locked"
	CodeClaudeLiveChanged         = "claude_live_changed"
	CodeClaudeNoCandidate         = "claude_no_candidate"
	CodeClaudeKeychain            = "claude_keychain_unavailable"
	CodeClaudeTooSoon             = "claude_too_soon"
)

var claudeCodes = []string{
	CodeClaudeAccountsUnavailable, CodeClaudeAccountNotFound, CodeClaudeAccountInvalid,
	CodeClaudeNotLoggedIn, CodeClaudeBackupEmpty, CodeClaudeLocked, CodeClaudeLiveChanged,
	CodeClaudeNoCandidate, CodeClaudeKeychain, CodeClaudeTooSoon,
}
