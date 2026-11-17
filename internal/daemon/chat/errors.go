// Package chat 은 데몬의 채팅 핵심이다 (PEER_CHAT_SRS §3.9).
//
// 간선 상대마다 채팅 연결을 하나 열어 두고, 노드 상태 알림과 글을 서명해 망에 퍼뜨린다.
// 노드는 자기 참가자에 대해서만 말하고, 글은 그 순간 방에 있는 참가자에게 넘긴 뒤 버린다.
// 디스크에 아무것도 쓰지 않는다 (NFR-PCH-1).
package chat

import "errors"

// 채팅 연산의 오류 코드다 (FR-PCH-51). 단계 2 에서 MCP·IPC 로 그대로 나간다.
const (
	CodeNotInRoom         = "not_in_room"
	CodeNoSuchRoom        = "no_such_room"
	CodeNoSuchParticipant = "no_such_participant"
	CodeTooLarge          = "too_large"
	CodeRateLimited       = "rate_limited"
	CodeBadRequest        = "bad_request"
)

// Error 는 코드가 붙은 채팅 오류다.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Code + ": " + e.Msg }

func fail(code, msg string) error { return &Error{Code: code, Msg: msg} }

// ErrorCode 는 err 의 채팅 오류 코드다. 채팅 오류가 아니면 빈 값이다.
func ErrorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}
