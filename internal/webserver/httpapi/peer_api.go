package httpapi

import (
	"errors"
	"net/http"
	"time"
	"unicode"
	"unicode/utf8"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/peer"
	"dongminal/internal/webserver/httpresp"
	"dongminal/internal/webserver/sse"
)

// 로컬 API `/api/peers/*` (PEER_NETWORK_SRS FR-PNW-70, 단계 2 범위).
//
// UI 리스너(loopback)에만 있다. 상대 노드와의 TLS·지문 확인·시간 한도는 이 서버가
// 맡는다 (FR-PNW-71).

// peerNodeView 는 이 노드의 설정과 노드 포트 상태다 (FR-PNW-80 "이 노드").
type peerNodeView struct {
	Enabled     bool     `json:"enabled"`
	Port        int      `json:"port"`
	Bind        string   `json:"bind"`
	Name        string   `json:"name"`
	Advertise   string   `json:"advertise"`
	AllowedDirs []string `json:"allowedDirs"`
	Fingerprint string   `json:"fingerprint"`
	Listening   bool     `json:"listening"`
	Addr        string   `json:"addr,omitempty"`
	Error       string   `json:"error,omitempty"`
}

// peerItemView 는 짝 하나에 마지막 응답 시각을 얹은 것이다 (FR-PNW-73).
type peerItemView struct {
	peer.Peer
	LastSeen *time.Time `json:"lastSeen,omitempty"`
}

type peerInviteView struct {
	Expires time.Time `json:"expires"`
}

// peersView 는 GET /api/peers 다. 초대 토큰은 싣지 않는다 (FR-PNW-95, I-3).
type peersView struct {
	Node    peerNodeView    `json:"node"`
	Peers   []peerItemView  `json:"peers"`
	Pending []peer.Pending  `json:"pending"`
	Invite  *peerInviteView `json:"invite"`
}

// peerReady 는 노드 계층이 섰는가다. 아니면 503 으로 답하고 거짓이다.
func (s *Server) peerReady(w http.ResponseWriter) bool {
	if s.peers == nil || s.peerLn == nil {
		peerFail(w, http.StatusServiceUnavailable, apierr.CodePeerUnavailable, "peer layer unavailable")
		return false
	}
	return true
}

func (s *Server) peersView() peersView {
	cfg := s.peers.Config()
	st := s.peerStatus()
	v := peersView{
		Node: peerNodeView{
			Enabled: cfg.Enabled, Port: cfg.Port, Bind: cfg.Bind, Name: cfg.Name,
			Advertise: cfg.Advertise, AllowedDirs: cfg.AllowedDirs, Fingerprint: s.peerID.Fingerprint,
			Listening: st.Listening, Addr: st.Addr, Error: st.Err,
		},
		Peers:   make([]peerItemView, 0, len(cfg.Peers)),
		Pending: s.pairing.Pending(),
	}
	for _, p := range cfg.Peers {
		item := peerItemView{Peer: p}
		if t, ok := s.peerSeen.Get(p.Fingerprint); ok {
			item.LastSeen = &t
		}
		v.Peers = append(v.Peers, item)
	}
	if exp, ok := s.pairing.InviteExpires(); ok {
		v.Invite = &peerInviteView{Expires: exp}
	}
	return v
}

// peersChanged 는 짝 상태가 바뀐 **뒤에** 화면에 알린다. 화면은 `GET /api/peers` 로
// 다시 읽는다 (FR-PNW-81). `paired` 는 이 노드가 승인해 짝맞춤을 마친 이름이다 (FR-PNW-82).
func (s *Server) peersChanged(paired string) {
	if s.Commands == nil {
		return
	}
	args := map[string]any{}
	if paired != "" {
		args["paired"] = paired
	}
	s.Commands.Broadcast(sse.Payload("peers_changed", args))
}

func (s *Server) apiPeersGet(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	httpresp.JSON(w, http.StatusOK, s.peersView())
}

// apiPeersNodePut 는 노드 설정을 바꾸고 노드 포트에 바로 적용한다 (FR-PNW-8, I-8).
func (s *Server) apiPeersNodePut(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	var in peer.Config
	if !peerReadJSON(w, r, &in) {
		return
	}
	if err := s.peers.SetNode(in); err != nil {
		if errors.Is(err, peer.ErrSaveFailed) {
			peerFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, err.Error())
			return
		}
		peerFail(w, http.StatusBadRequest, apierr.CodePeerConfigInvalid, err.Error())
		return
	}
	s.peerLn.Apply(s.peers.Config())
	s.peersChanged("")
	httpresp.JSON(w, http.StatusOK, s.peersView())
}

// apiPeersInvite 는 초대 코드를 만든다 (FR-PNW-20·21, I-6).
func (s *Server) apiPeersInvite(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	var in struct {
		Addr string `json:"addr"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	if !s.peerStatus().Listening {
		peerFail(w, http.StatusConflict, apierr.CodePeerPortClosed, "node port is not listening")
		return
	}
	cfg := s.peers.Config()
	addr := in.Addr
	if addr == "" {
		addr = cfg.Advertise
	}
	if addr == "" {
		peerFail(w, http.StatusBadRequest, apierr.CodePeerAddrRequired, "addr required")
		return
	}
	if !peer.ValidAddr(addr) {
		peerFail(w, http.StatusBadRequest, apierr.CodePeerConfigInvalid, "addr")
		return
	}
	token, expires := s.pairing.NewInvite()
	code := peer.EncodeInvite(peer.InviteCode{Addr: addr, Port: cfg.Port, Fingerprint: s.peerID.Fingerprint, Token: token})
	s.peersChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"code": code, "expires": expires})
}

// peerCallFail 은 상대 호출의 실패를 이쪽 응답으로 옮긴다 (FR-PNW-71·74).
func peerCallFail(w http.ResponseWriter, err error) {
	var re *peer.RemoteError
	switch {
	case errors.Is(err, peer.ErrFingerprintMismatch):
		peerFail(w, http.StatusBadGateway, apierr.CodePeerFPMismatch, err.Error())
	case errors.Is(err, peer.ErrRejected):
		peerFail(w, http.StatusBadGateway, apierr.CodePeerRejected, err.Error())
	case errors.As(err, &re) && re.Code != "":
		peerFail(w, remoteStatus(re.Status), remoteCode(re.Code), cleanRemoteText(re.Message))
	default:
		peerFail(w, http.StatusBadGateway, apierr.CodePeerUnreachable, err.Error())
	}
}

// apiPeersAdd 는 초대 코드로 상대에 등록을 요청한다 (FR-PNW-22·23·26·33, I-5).
func (s *Server) apiPeersAdd(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	var in struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	ic, err := peer.DecodeInvite(in.Code)
	if err != nil {
		peerFail(w, http.StatusBadRequest, apierr.CodePeerInviteInvalid, err.Error())
		return
	}
	if in.Name != "" {
		if err := peer.ValidName(in.Name); err != nil {
			peerFail(w, http.StatusBadRequest, apierr.CodePeerConfigInvalid, err.Error())
			return
		}
		if s.peers.NameTaken(in.Name) {
			peerFail(w, http.StatusConflict, apierr.CodePeerNameTaken, in.Name)
			return
		}
	}
	cfg := s.peers.Config()
	req := map[string]any{"token": ic.Token, "name": cfg.Name, "addr": cfg.Advertise, "port": cfg.Port, "proto": peerProto}
	var resp struct {
		Name string `json:"name"`
	}
	tgt := peer.Target{Addr: ic.Addr, Port: ic.Port, Fingerprint: ic.Fingerprint}
	if err := s.peerClient.Call(r.Context(), tgt, peerPairPath, req, &resp); err != nil {
		peerAudit("out", "-", "pair", http.StatusBadGateway)
		peerCallFail(w, err)
		return
	}
	name := in.Name
	if name == "" {
		base := resp.Name
		if peer.ValidName(base) != nil {
			base = peer.DefaultName(base)
		}
		name = s.peers.FreeNameFor(base, ic.Fingerprint)
	}
	p := peer.Peer{Name: name, Addr: ic.Addr, Port: ic.Port, Fingerprint: ic.Fingerprint,
		State: peer.StatePendingOut, Expires: time.Now().Add(peer.PendingTTL)}
	if err := s.peers.AddPeer(p); err != nil {
		peerFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, err.Error())
		return
	}
	peerAudit("out", name, "pair", http.StatusOK)
	s.peersChanged("")
	out := map[string]any{"name": name, "state": peer.StatePendingOut}
	// FR-PNW-33: 내 포트가 닫혀 있으면 상대가 나에게 보낼 수 없다. 등록은 막지 않는다.
	if !cfg.Enabled || !s.peerStatus().Listening {
		out["warning"] = "port_closed"
	}
	httpresp.JSON(w, http.StatusOK, out)
}

func (s *Server) apiPeersPending(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"pending": s.pairing.Pending()})
}

// apiPeersApprove 는 승인 대기를 짝으로 저장하고 A 에 confirm 을 보낸다
// (FR-PNW-27·30, I-9).
func (s *Server) apiPeersApprove(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	e, ok := s.pairing.TakePending(in.ID)
	if !ok {
		peerFail(w, http.StatusNotFound, apierr.CodePeerPendingMissing, in.ID)
		return
	}
	name := in.Name
	if name == "" {
		name = e.Name
	}
	err := s.peers.AddPeer(peer.Peer{Name: name, Addr: e.Addr, Port: e.Port, Fingerprint: e.Fingerprint})
	switch {
	case errors.Is(err, peer.ErrNameTaken):
		s.pairing.PutBack(e)
		peerFail(w, http.StatusConflict, apierr.CodePeerNameTaken, name)
		return
	case errors.Is(err, peer.ErrSaveFailed):
		s.pairing.PutBack(e)
		peerFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, err.Error())
		return
	case err != nil:
		s.pairing.PutBack(e)
		peerFail(w, http.StatusBadRequest, apierr.CodePeerConfigInvalid, err.Error())
		return
	}
	out := map[string]any{"name": name, "confirmed": true}
	tgt := peer.Target{Addr: e.Addr, Port: e.Port, Fingerprint: e.Fingerprint}
	if err := s.peerClient.Call(r.Context(), tgt, peerConfirmPath, map[string]any{}, nil); err != nil {
		out["confirmed"] = false
		out["reason"] = err.Error()
		peerAudit("out", name, "pair.confirm", http.StatusBadGateway)
	} else {
		peerAudit("out", name, "pair.confirm", http.StatusOK)
	}
	s.peersChanged(name)
	httpresp.JSON(w, http.StatusOK, out)
}

func (s *Server) apiPeersReject(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	var in struct {
		ID string `json:"id"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	if _, ok := s.pairing.TakePending(in.ID); !ok {
		peerFail(w, http.StatusNotFound, apierr.CodePeerPendingMissing, in.ID)
		return
	}
	s.peersChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"rejected": true})
}

// peerStoreFail 은 짝 목록 조작의 실패를 옮긴다.
func peerStoreFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, peer.ErrPeerNotFound):
		peerFail(w, http.StatusNotFound, apierr.CodePeerNotFound, err.Error())
	case errors.Is(err, peer.ErrSaveFailed):
		peerFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, err.Error())
	default:
		peerFail(w, http.StatusBadRequest, apierr.CodePeerConfigInvalid, err.Error())
	}
}

// apiPeersRemove 는 짝을 해제한다 (FR-PNW-31). 열린 연결도 다음 요청에서 끊긴다.
func (s *Server) apiPeersRemove(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	if err := s.peers.Remove(in.Name); err != nil {
		peerStoreFail(w, err)
		return
	}
	s.peersChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"removed": in.Name})
}

// apiPeersAddress 는 짝의 주소를 고친다 (FR-PNW-32).
func (s *Server) apiPeersAddress(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	var in struct {
		Name string `json:"name"`
		Addr string `json:"addr"`
		Port int    `json:"port"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	if err := s.peers.SetAddress(in.Name, in.Addr, in.Port); err != nil {
		peerStoreFail(w, err)
		return
	}
	s.peersChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"name": in.Name, "addr": in.Addr, "port": in.Port})
}

// peerRemoteTextMax 는 상대가 보낸 문구를 옮길 때의 상한(바이트)이다.
const peerRemoteTextMax = 512

// remoteStatus 는 상대의 상태를 옮긴다. 요청의 잘못(4xx)만 그대로 두고 나머지는
// 502 다 — 상대의 5xx·3xx 는 이쪽 서버의 사정이 아니다.
func remoteStatus(st int) int {
	if st >= 400 && st < 500 {
		return st
	}
	return http.StatusBadGateway
}

// remoteCode 는 카탈로그에 있는 코드만 옮긴다. 모르는 코드는 peer_rejected 다.
func remoteCode(code string) string {
	for _, c := range apierr.AllCodes() {
		if c == code {
			return code
		}
	}
	return apierr.CodePeerRejected
}

// cleanRemoteText 는 제어 문자를 지우고 길이를 자른다. 이 문구는 터미널에 찍힌다.
func cleanRemoteText(s string) string {
	out := make([]rune, 0, len(s))
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) {
			continue
		}
		n += utf8.RuneLen(r)
		if n > peerRemoteTextMax {
			break
		}
		out = append(out, r)
	}
	return string(out)
}
