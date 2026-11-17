package httpapi

import (
	"net/http"

	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/httpreq"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/sse"
)

// 로컬 API `/api/edges/*` (PEER_NETWORK_SRS FR-PNW-70, PEER_DAEMON_SRS FR-PDM-30).
//
// UI 리스너(loopback)에만 있다. 요청 하나를 노드의 연산 하나로 넘기고 답을 그대로 쓴다.
// 노드의 판정·저장은 여기에 없다 (FR-PDM-53).

// edgesChanged 는 간선 상태가 바뀐 **뒤에** 화면에 알린다. 화면은 `GET /api/edges` 로
// 다시 읽는다 (FR-PNW-81). `paired` 는 이 노드가 승인해 간선 맺기를 마친 이름이다 (FR-PNW-82).
func (s *Server) edgesChanged(paired string) {
	if s.Commands == nil {
		return
	}
	args := map[string]any{}
	if paired != "" {
		args["paired"] = paired
	}
	s.Commands.Broadcast(sse.Payload("edges_changed", args))
}

// edgeDo 는 연산 op 하나를 처리한다. withBody 면 요청 본문을 Args 로 넘긴다.
func (s *Server) edgeDo(w http.ResponseWriter, r *http.Request, op string, withBody bool) {
	if s.edgeNode == nil {
		codeFail(w, http.StatusServiceUnavailable, apierr.CodeEdgeUnavailable, "edge layer unavailable")
		return
	}
	var raw []byte
	if withBody {
		var err error
		if raw, err = httpreq.Read(w, r, jsonBodyLimit); err != nil {
			codeFail(w, httpreq.Status(err), bodyReadCode(err), "read body")
			return
		}
	}
	res := s.edgeNode.Do(r.Context(), edgenode.Request{Op: op, Args: raw, IfMatch: r.Header.Get("If-Match")})
	writeEdgeResponse(w, res)
}

// writeEdgeResponse 는 노드의 답을 그대로 쓴다. ETag 는 오류(409 포함)에도 싣는다.
func writeEdgeResponse(w http.ResponseWriter, res edgenode.Response) {
	if res.ETag != "" {
		w.Header().Set("ETag", res.ETag)
	}
	if res.Code != "" {
		codeFail(w, res.Status, res.Code, res.Message)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.Status)
	_, _ = w.Write(append(res.Body, '\n'))
}

func (s *Server) apiEdgesGet(w http.ResponseWriter, r *http.Request) { s.edgeDo(w, r, "get", false) }

// apiEdgesNodePut 는 노드 설정을 바꾸고 노드 포트에 바로 적용한다 (FR-PNW-8, I-8).
func (s *Server) apiEdgesNodePut(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "node", true)
}

func (s *Server) apiEdgesInvite(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "invite", true)
}
func (s *Server) apiEdgesAdd(w http.ResponseWriter, r *http.Request) { s.edgeDo(w, r, "add", true) }
func (s *Server) apiEdgesPending(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "pending", false)
}
func (s *Server) apiEdgesApprove(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "approve", true)
}
func (s *Server) apiEdgesReject(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "reject", true)
}
func (s *Server) apiEdgesRemove(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "remove", true)
}
func (s *Server) apiEdgesAddress(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "address", true)
}
