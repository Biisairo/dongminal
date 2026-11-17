package httpapi

import (
	"errors"
	"net/http"
	"time"
	"unicode"
	"unicode/utf8"

	"dongminal/internal/shared/edge"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpresp"
	"dongminal/internal/webserver/sse"
)

// 로컬 API `/api/edges/*` (PEER_NETWORK_SRS FR-PNW-70, 단계 2 범위).
//
// UI 리스너(loopback)에만 있다. 상대 노드와의 TLS·지문 확인·시간 한도는 이 서버가
// 맡는다 (FR-PNW-71).

// edgeNodeView 는 이 노드의 설정과 노드 포트 상태다 (FR-PNW-80 "이 노드").
type edgeNodeView struct {
	Enabled     bool   `json:"enabled"`
	Port        int    `json:"port"`
	Bind        string `json:"bind"`
	Name        string `json:"name"`
	Advertise   string `json:"advertise"`
	Fingerprint string `json:"fingerprint"`
	Listening   bool   `json:"listening"`
	Addr        string `json:"addr,omitempty"`
	Error       string `json:"error,omitempty"`
}

type edgeInviteView struct {
	Expires time.Time `json:"expires"`
}

// edgesView 는 GET /api/edges 다. 초대 토큰은 싣지 않는다 (FR-PNW-95, I-3).
type edgesView struct {
	Node    edgeNodeView    `json:"node"`
	Edges   []edge.Edge     `json:"edges"`
	Pending []edge.Pending  `json:"pending"`
	Invite  *edgeInviteView `json:"invite"`
}

// edgeReady 는 노드 계층이 섰는가다. 아니면 503 으로 답하고 거짓이다.
func (s *Server) edgeReady(w http.ResponseWriter) bool {
	if s.edges == nil || s.edgeLn == nil {
		codeFail(w, http.StatusServiceUnavailable, apierr.CodeEdgeUnavailable, "edge layer unavailable")
		return false
	}
	return true
}

func (s *Server) edgesView() edgesView {
	cfg := s.edges.Config()
	st := s.edgeStatus()
	v := edgesView{
		Node: edgeNodeView{
			Enabled: cfg.Enabled, Port: cfg.Port, Bind: cfg.Bind, Name: cfg.Name,
			Advertise: cfg.Advertise, Fingerprint: s.edgeID.Fingerprint,
			Listening: st.Listening, Addr: st.Addr, Error: st.Err,
		},
		Edges:   append([]edge.Edge{}, cfg.Edges...),
		Pending: s.pairing.Pending(),
	}
	if exp, ok := s.pairing.InviteExpires(); ok {
		v.Invite = &edgeInviteView{Expires: exp}
	}
	return v
}

// edgesChanged 는 짝 상태가 바뀐 **뒤에** 화면에 알린다. 화면은 `GET /api/edges` 로
// 다시 읽는다 (FR-PNW-81). `paired` 는 이 노드가 승인해 짝맞춤을 마친 이름이다 (FR-PNW-82).
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

func (s *Server) apiEdgesGet(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	w.Header().Set("ETag", settingsTag(s.edges.Config()))
	httpresp.JSON(w, http.StatusOK, s.edgesView())
}

// apiEdgesNodePut 는 노드 설정을 바꾸고 노드 포트에 바로 적용한다 (FR-PNW-8, I-8).
func (s *Server) apiEdgesNodePut(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	var in edge.Config
	if !readJSONBody(w, r, &in) {
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if cur := settingsTag(s.edges.Config()); settingsStale(r, cur) {
		w.Header().Set("ETag", cur)
		codeFail(w, http.StatusConflict, apierr.CodeStaleRev, "stale revision")
		return
	}
	if err := s.edges.SetNode(in); err != nil {
		if errors.Is(err, edge.ErrSaveFailed) {
			codeFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, err.Error())
			return
		}
		codeFail(w, http.StatusBadRequest, apierr.CodeEdgeConfigInvalid, err.Error())
		return
	}
	s.edgeLn.Apply(s.edges.Config())
	s.edgesChanged("")
	w.Header().Set("ETag", settingsTag(s.edges.Config()))
	httpresp.JSON(w, http.StatusOK, s.edgesView())
}

// apiEdgesInvite 는 초대 코드를 만든다 (FR-PNW-20·21, I-6).
func (s *Server) apiEdgesInvite(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	var in struct {
		Addr string `json:"addr"`
	}
	if !readJSONBody(w, r, &in) {
		return
	}
	if !s.edgeStatus().Listening {
		codeFail(w, http.StatusConflict, apierr.CodeEdgePortClosed, "node port is not listening")
		return
	}
	cfg := s.edges.Config()
	addr := in.Addr
	if addr == "" {
		addr = cfg.Advertise
	}
	if addr == "" {
		codeFail(w, http.StatusBadRequest, apierr.CodeEdgeAddrRequired, "addr required")
		return
	}
	if !edge.ValidAddr(addr) {
		codeFail(w, http.StatusBadRequest, apierr.CodeEdgeConfigInvalid, "addr")
		return
	}
	token, expires := s.pairing.NewInvite()
	code := edge.EncodeInvite(edge.InviteCode{Addr: addr, Port: cfg.Port, Fingerprint: s.edgeID.Fingerprint, Token: token})
	s.edgesChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"code": code, "expires": expires})
}

// edgeCallFail 은 상대 호출의 실패를 이쪽 응답으로 옮긴다 (FR-PNW-71·74).
func edgeCallFail(w http.ResponseWriter, err error) {
	var re *edge.RemoteError
	switch {
	case errors.Is(err, edge.ErrFingerprintMismatch):
		codeFail(w, http.StatusBadGateway, apierr.CodeEdgeFPMismatch, err.Error())
	case errors.Is(err, edge.ErrRejected):
		codeFail(w, http.StatusBadGateway, apierr.CodeEdgeRejected, err.Error())
	case errors.As(err, &re) && re.Code != "":
		codeFail(w, remoteStatus(re.Status), remoteCode(re.Code), cleanRemoteText(re.Message))
	default:
		codeFail(w, http.StatusBadGateway, apierr.CodeEdgeUnreachable, err.Error())
	}
}

// apiEdgesAdd 는 초대 코드로 상대에 등록을 요청한다 (FR-PNW-22·23·26·33, I-5).
func (s *Server) apiEdgesAdd(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	var in struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if !readJSONBody(w, r, &in) {
		return
	}
	ic, err := edge.DecodeInvite(in.Code)
	if err != nil {
		codeFail(w, http.StatusBadRequest, apierr.CodeEdgeInviteInvalid, err.Error())
		return
	}
	if in.Name != "" {
		if err := edge.ValidName(in.Name); err != nil {
			codeFail(w, http.StatusBadRequest, apierr.CodeEdgeConfigInvalid, err.Error())
			return
		}
		if s.edges.NameTakenExcept(in.Name, ic.Fingerprint) {
			codeFail(w, http.StatusConflict, apierr.CodeEdgeNameTaken, in.Name)
			return
		}
	}
	cfg := s.edges.Config()
	req := map[string]any{"token": ic.Token, "name": cfg.Name, "addr": cfg.Advertise, "port": cfg.Port, "proto": edgeProto}
	var resp struct {
		Name string `json:"name"`
	}
	tgt := edge.Target{Addr: ic.Addr, Port: ic.Port, Fingerprint: ic.Fingerprint}
	if err := s.edgeClient.Call(r.Context(), tgt, edgePairPath, req, &resp); err != nil {
		edgeAudit("out", "-", "pair", http.StatusBadGateway)
		// 상대는 초대가 없으면 TLS 단계에서 거절한다 (I-1). 짝이 아닌 이 노드가 거절당하는
		// 이유는 그것뿐이다.
		if errors.Is(err, edge.ErrRejected) {
			codeFail(w, http.StatusForbidden, apierr.CodeEdgeNoInvite, "no live invite")
			return
		}
		edgeCallFail(w, err)
		return
	}
	name := in.Name
	if name == "" {
		base := resp.Name
		if edge.ValidName(base) != nil {
			base = edge.DefaultName(base)
		}
		name = s.edges.FreeNameFor(base, ic.Fingerprint)
	}
	p := edge.Edge{Name: name, Addr: ic.Addr, Port: ic.Port, Fingerprint: ic.Fingerprint,
		State: edge.StatePendingOut, Expires: time.Now().Add(edge.PendingTTL)}
	if err := s.edges.AddEdge(p); err != nil {
		edgeStoreFail(w, err)
		return
	}
	edgeAudit("out", name, "pair", http.StatusOK)
	s.edgesChanged("")
	// 이미 짝이던 지문이면 짝으로 남는다 (I-37). 저장된 상태를 그대로 알린다.
	state := edge.StatePendingOut
	if s.edges.IsEdge(ic.Fingerprint) {
		state = edge.StatePaired
	}
	out := map[string]any{"name": name, "state": state}
	// FR-PNW-33: 내 포트가 닫혀 있으면 상대가 나에게 보낼 수 없다. 등록은 막지 않는다.
	if !cfg.Enabled || !s.edgeStatus().Listening {
		out["warning"] = "port_closed"
	}
	httpresp.JSON(w, http.StatusOK, out)
}

func (s *Server) apiEdgesPending(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"pending": s.pairing.Pending()})
}

// apiEdgesApprove 는 승인 대기를 짝으로 저장하고 A 에 confirm 을 보낸다
// (FR-PNW-27·30, I-9).
func (s *Server) apiEdgesApprove(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !readJSONBody(w, r, &in) {
		return
	}
	e, ok := s.pairing.TakePending(in.ID)
	if !ok {
		codeFail(w, http.StatusNotFound, apierr.CodeEdgePendingMissing, in.ID)
		return
	}
	name := in.Name
	if name == "" {
		name = e.Name
	}
	err := s.edges.AddEdge(edge.Edge{Name: name, Addr: e.Addr, Port: e.Port, Fingerprint: e.Fingerprint})
	switch {
	case errors.Is(err, edge.ErrNameTaken):
		s.pairing.PutBack(e)
		codeFail(w, http.StatusConflict, apierr.CodeEdgeNameTaken, name)
		return
	case errors.Is(err, edge.ErrSaveFailed):
		s.pairing.PutBack(e)
		codeFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, err.Error())
		return
	case err != nil:
		s.pairing.PutBack(e)
		codeFail(w, http.StatusBadRequest, apierr.CodeEdgeConfigInvalid, err.Error())
		return
	}
	out := map[string]any{"name": name, "fp": e.Fingerprint, "confirmed": true}
	tgt := edge.Target{Addr: e.Addr, Port: e.Port, Fingerprint: e.Fingerprint}
	if err := s.edgeClient.Call(r.Context(), tgt, edgeConfirmPath, map[string]any{}, nil); err != nil {
		out["confirmed"] = false
		out["reason"] = err.Error()
		edgeAudit("out", name, "pair.confirm", http.StatusBadGateway)
	} else {
		edgeAudit("out", name, "pair.confirm", http.StatusOK)
	}
	s.edgesChanged(name)
	httpresp.JSON(w, http.StatusOK, out)
}

func (s *Server) apiEdgesReject(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	var in struct {
		ID string `json:"id"`
	}
	if !readJSONBody(w, r, &in) {
		return
	}
	if _, ok := s.pairing.TakePending(in.ID); !ok {
		codeFail(w, http.StatusNotFound, apierr.CodeEdgePendingMissing, in.ID)
		return
	}
	s.edgesChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"rejected": true})
}

// edgeStoreFail 은 짝 목록 조작의 실패를 옮긴다.
func edgeStoreFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, edge.ErrEdgeNotFound):
		codeFail(w, http.StatusNotFound, apierr.CodeEdgeNotFound, err.Error())
	case errors.Is(err, edge.ErrSaveFailed):
		codeFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, err.Error())
	case errors.Is(err, edge.ErrNameTaken):
		codeFail(w, http.StatusConflict, apierr.CodeEdgeNameTaken, err.Error())
	default:
		codeFail(w, http.StatusBadRequest, apierr.CodeEdgeConfigInvalid, err.Error())
	}
}

// apiEdgesRemove 는 짝을 해제한다 (FR-PNW-31). 열린 연결도 다음 요청에서 끊긴다.
func (s *Server) apiEdgesRemove(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !readJSONBody(w, r, &in) {
		return
	}
	if err := s.edges.Remove(in.Name); err != nil {
		edgeStoreFail(w, err)
		return
	}
	s.edgesChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"removed": in.Name})
}

// apiEdgesAddress 는 짝의 주소를 고친다 (FR-PNW-32).
func (s *Server) apiEdgesAddress(w http.ResponseWriter, r *http.Request) {
	if !s.edgeReady(w) {
		return
	}
	var in struct {
		Name string `json:"name"`
		Addr string `json:"addr"`
		Port int    `json:"port"`
	}
	if !readJSONBody(w, r, &in) {
		return
	}
	if err := s.edges.SetAddress(in.Name, in.Addr, in.Port); err != nil {
		edgeStoreFail(w, err)
		return
	}
	s.edgesChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"name": in.Name, "addr": in.Addr, "port": in.Port})
}

// edgeRemoteTextMax 는 상대가 보낸 문구를 옮길 때의 상한(바이트)이다.
const edgeRemoteTextMax = 512

// remoteStatus 는 상대의 상태를 옮긴다. 요청의 잘못(4xx)만 그대로 두고 나머지는
// 502 다 — 상대의 5xx·3xx 는 이쪽 서버의 사정이 아니다.
func remoteStatus(st int) int {
	if st >= 400 && st < 500 {
		return st
	}
	return http.StatusBadGateway
}

// remoteCode 는 카탈로그에 있는 코드만 옮긴다. 모르는 코드는 edge_rejected 다.
func remoteCode(code string) string {
	for _, c := range apierr.AllCodes() {
		if c == code {
			return code
		}
	}
	return apierr.CodeEdgeRejected
}

// cleanRemoteText 는 제어 문자를 지우고 길이를 자른다. 이 문구는 터미널에 찍힌다.
func cleanRemoteText(s string) string {
	out := make([]rune, 0, len(s))
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		n += utf8.RuneLen(r)
		if n > edgeRemoteTextMax {
			break
		}
		out = append(out, r)
	}
	return string(out)
}
