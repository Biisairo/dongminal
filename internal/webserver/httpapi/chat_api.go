package httpapi

import (
	"encoding/json"
	"net/http"

	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/httpreq"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/sse"
)

// 로컬 API `/api/chat` (PEER_CHAT_SRS §3.11).
//
// 채팅은 데몬에 있다(NFR-PCH-5). 서버는 화면의 요청을 데몬의 사람 참가자 연산 하나로 넘기고,
// 데몬이 민 글과 바뀜을 SSE 로 방송한다. 서버는 글을 들지 않는다 (FR-PCH-85).

// chatErrors 는 데몬의 채팅 코드 → HTTP 상태와 와이어 코드다. 없는 코드는 400 chat_bad_request 다.
var chatErrors = map[string]struct {
	status int
	code   string
}{
	chatwire.CodeBadRequest:        {http.StatusBadRequest, apierr.CodeChatBadRequest},
	"too_large":                    {http.StatusRequestEntityTooLarge, apierr.CodeChatTooLarge},
	"rate_limited":                 {http.StatusTooManyRequests, apierr.CodeChatRateLimited},
	"not_in_room":                  {http.StatusConflict, apierr.CodeChatNotInRoom},
	"no_such_room":                 {http.StatusNotFound, apierr.CodeChatNoSuchRoom},
	"no_such_participant":          {http.StatusNotFound, apierr.CodeChatNoSuchParticipant},
	chatwire.CodeDaemonUnavailable: {http.StatusServiceUnavailable, apierr.CodeChatUnavailable},
	chatwire.CodeBadCode:           {http.StatusForbidden, apierr.CodeChatBadCode},
	chatwire.CodeLocked:            {http.StatusLocked, apierr.CodeChatLocked},
	chatwire.CodeNoHelper:          {http.StatusConflict, apierr.CodeChatNoHelper},
}

func (s *Server) apiChatGet(w http.ResponseWriter, r *http.Request) { s.chatDo(w, r, chatwire.OpState) }
func (s *Server) apiChatCreate(w http.ResponseWriter, r *http.Request) {
	s.chatDo(w, r, chatwire.OpCreate)
}
func (s *Server) apiChatDirect(w http.ResponseWriter, r *http.Request) {
	s.chatDo(w, r, chatwire.OpDirect)
}
func (s *Server) apiChatJoin(w http.ResponseWriter, r *http.Request) { s.chatDo(w, r, chatwire.OpJoin) }
func (s *Server) apiChatLeave(w http.ResponseWriter, r *http.Request) {
	s.chatDo(w, r, chatwire.OpLeave)
}
func (s *Server) apiChatSend(w http.ResponseWriter, r *http.Request) { s.chatDo(w, r, chatwire.OpSend) }

// apiChatKill·apiChatKick 은 사람 명령이다. 본문에 OTP 코드가 든다 (§3.12).
func (s *Server) apiChatKill(w http.ResponseWriter, r *http.Request) { s.chatDo(w, r, chatwire.OpKill) }
func (s *Server) apiChatKick(w http.ResponseWriter, r *http.Request) { s.chatDo(w, r, chatwire.OpKick) }

// chatDo 는 연산 op 하나를 데몬에 넘긴다. state 가 아니면 요청 본문이 그 op 의 인자다.
func (s *Server) chatDo(w http.ResponseWriter, r *http.Request, op string) {
	// 데몬이 배선되지 않은 서버는 준비되지 않은 데몬과 같다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-22).
	if s.ChatDaemon == nil || !s.ChatDaemon.ChatReady() {
		codeFail(w, http.StatusConflict, apierr.CodeChatDaemonRestart, "restart the daemon to use chat")
		return
	}
	p := toolipc.ChatParams{Op: op}
	if op != chatwire.OpState {
		raw, err := httpreq.Read(w, r, jsonBodyLimit)
		if err != nil {
			codeFail(w, httpreq.Status(err), apierr.BodyReadCode(err), "read body")
			return
		}
		if !json.Valid(raw) {
			codeFail(w, http.StatusBadRequest, apierr.CodeChatBadRequest, "body is not JSON")
			return
		}
		p.Args = raw
	}
	res, err := s.ChatDaemon.Chat(p)
	if err != nil {
		codeFail(w, http.StatusBadGateway, apierr.CodeChatUnreachable, "daemon: "+err.Error())
		return
	}
	if res.Error != nil {
		e, ok := chatErrors[res.Error.Code]
		if !ok {
			e = chatErrors[chatwire.CodeBadRequest]
		}
		codeFail(w, e.status, e.code, res.Error.Message)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(append(res.Result, '\n'))
}

// ChatPushed 는 데몬의 chat push 다. 글은 chat_message 로, 바뀜은 chat_changed 로 방송한다.
// 읽기 루프에서 불리므로 데몬 RPC 를 기다리지 않는다.
func (s *Server) ChatPushed(ev toolipc.ChatEvent) {
	if s.Commands == nil {
		return
	}
	switch {
	case ev.ChatKind == toolipc.ChatKindMsg && ev.Chat != nil:
		s.Commands.Broadcast(sse.Payload("chat_message", map[string]any{"msg": ev.Chat}))
	case ev.ChatKind == toolipc.ChatKindChanged:
		s.Commands.Broadcast(sse.Payload("chat_changed", map[string]any{}))
	}
}

// ChatResync 는 데몬에 다시 붙은 뒤다. 끊긴 동안의 바뀜을 잃었으므로 화면이 다시 읽게 한다.
func (s *Server) ChatResync() {
	if s.Commands == nil {
		return
	}
	s.Commands.Broadcast(sse.Payload("chat_changed", map[string]any{}))
}
