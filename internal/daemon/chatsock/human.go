package chatsock

import (
	"encoding/json"
	"errors"
	"time"

	"dongminal/internal/daemon/chat"
	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/humancmd"
)

// Helper 는 사람 명령의 도우미다. humancmd.Client 가 구현한다 (PEER_CHAT_SRS §3.12).
type Helper interface {
	Sign(code string, r humancmd.Request) (humancmd.Signed, error)
}

// human 은 사람 참가자의 kill·kick 이다. 도우미에게 코드와 묶음을 보내 서명을 받고, 채팅에 적용해
// 망에 낸다 (FR-PCH-70~73). 도우미 저장 실패(unavailable)는 no_helper 로 본다 (§3.12a R-5). 에이전트의 MCP 연결로는 닿지 않는다 — UserCall 만 부른다.
func (s *Server) human(op string, args json.RawMessage) (json.RawMessage, *chatwire.Error) {
	var a chatwire.HumanArgs
	if err := decode(args, &a); err != nil {
		return nil, &chatwire.Error{Code: chatwire.CodeBadRequest, Message: err.Error()}
	}
	req := humancmd.Request{Node: s.o.Chat.Node(), Op: op, Rooms: a.Rooms}
	for _, k := range a.Kicks {
		req.Kicks = append(req.Kicks, humancmd.Kick{Room: k.Room, Participant: k.Participant})
	}
	if !req.Valid() {
		return nil, &chatwire.Error{Code: chatwire.CodeBadRequest, Message: "targets"}
	}
	if s.o.Helper == nil {
		return nil, &chatwire.Error{Code: chatwire.CodeNoHelper, Message: "no helper"}
	}
	// 도우미는 한 번만 부른다. 서명 본문의 키를 Command 가 싣는다 (§3.12a R-3).
	sg, err := s.o.Helper.Sign(a.Code, req)
	if err != nil {
		return nil, helperError(err)
	}
	if err := s.o.Chat.Command(sg); err != nil {
		return nil, &chatwire.Error{Code: chat.ErrorCode(err), Message: err.Error()}
	}
	raw, _ := json.Marshal(chatwire.OK{OK: true})
	return raw, nil
}

// helperError 는 도우미의 거절을 채팅 코드로 바꾼다. locked 의 메시지는 풀리는 시각이다.
func helperError(err error) *chatwire.Error {
	var he *humancmd.Error
	if !errors.As(err, &he) {
		return &chatwire.Error{Code: chatwire.CodeNoHelper, Message: err.Error()}
	}
	switch he.Code {
	case humancmd.CodeLocked:
		return &chatwire.Error{Code: chatwire.CodeLocked, Message: time.UnixMilli(he.Until).UTC().Format(time.RFC3339)}
	case humancmd.CodeBadCode:
		return &chatwire.Error{Code: chatwire.CodeBadCode, Message: "wrong code"}
	case humancmd.CodeBadRequest:
		return &chatwire.Error{Code: chatwire.CodeBadRequest, Message: "helper refused the request"}
	}
	return &chatwire.Error{Code: chatwire.CodeNoHelper, Message: "helper unavailable"}
}
