package apierr

// 채팅 API(`/api/chat`)의 코드 (PEER_CHAT_SRS §3.11). 데몬의 채팅 코드에 `chat_` 를 붙인다.
const (
	CodeChatBadRequest        = "chat_bad_request"
	CodeChatTooLarge          = "chat_too_large"
	CodeChatRateLimited       = "chat_rate_limited"
	CodeChatNotInRoom         = "chat_not_in_room"
	CodeChatNoSuchRoom        = "chat_no_such_room"
	CodeChatNoSuchParticipant = "chat_no_such_participant"
	CodeChatUnavailable       = "chat_unavailable"
	CodeChatDaemonRestart     = "chat_daemon_restart"
	CodeChatUnreachable       = "chat_unreachable"
	// 사람 명령(§3.12)의 코드다.
	CodeChatBadCode  = "chat_bad_code"
	CodeChatLocked   = "chat_locked"
	CodeChatNoHelper = "chat_no_helper"
)

var chatCodes = []string{
	CodeChatBadRequest, CodeChatTooLarge, CodeChatRateLimited, CodeChatNotInRoom, CodeChatNoSuchRoom,
	CodeChatNoSuchParticipant, CodeChatUnavailable, CodeChatDaemonRestart, CodeChatUnreachable,
	CodeChatBadCode, CodeChatLocked, CodeChatNoHelper,
}
