package httpapi

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/peer"
	"dongminal/internal/webserver/httpreq"
	"dongminal/internal/webserver/httpresp"
)

// 노드 포트 (PEER_NETWORK_SRS 묶음 N·P).
//
// UI 리스너와 따로 연다. 이 포트에는 access 게이트와 요청 게이트를 세우지 않는다
// (FR-PNW-7) — 짝맞춤(인증서)이 문을 지킨다.

const (
	// peerPathPrefix 는 노드 포트가 받는 유일한 경로다 (FR-PNW-6).
	peerPathPrefix  = "/peer/v1/"
	peerPairPath    = peerPathPrefix + "pair"
	peerConfirmPath = peerPathPrefix + "pair/confirm"
	// peerPairRateKey 는 등록 요청 상한의 키 머리다. 짝의 지문 키와 섞이지 않는다.
	peerPairRateKey = "pair-addr:"
	// peerProto 는 이 서버가 말하는 프로토콜 판이다 (FR-PNW-50).
	peerProto = 1
	// peerBodyLimit 은 요청 본문 상한이다 (FR-PNW-43).
	peerBodyLimit = 64 << 10
)

// initPeer 는 노드 신원·설정·리스너를 세운다. 신원을 읽지 못하면 노드 포트를
// 세우지 않을 뿐 서버는 선다.
func (s *Server) initPeer() {
	if s.cfg.DataDir == "" {
		return
	}
	hostname, _ := os.Hostname()
	s.peers = peer.OpenStore(filepath.Join(s.cfg.DataDir, dmenv.PeersFile), hostname)
	id, err := peer.LoadOrCreateIdentity(s.cfg.DataDir)
	if err != nil {
		dmlog.Infof(nil, "peer identity: %v — 노드 포트를 열지 않는다", err)
		return
	}
	s.peerID = id
	s.peerClient = peer.NewClient(id)
	s.pairing = peer.NewPairing(time.Now)
	s.peerLimiter = peer.NewRateLimiter(time.Now)
	s.peerSeen = peer.NewLastSeen()
	s.peerSpawns = peer.OpenSpawnLog(filepath.Join(s.cfg.DataDir, dmenv.PeerSpawnsFile))
	s.peerLn = peer.NewListener(id, s.peerAdmission(), s.peerHandler())
}

// peerAdmission 은 노드 포트의 두 단계 판정이다 (I-1, FR-PNW-24·27·41).
func (s *Server) peerAdmission() peer.Admission {
	return peer.Admission{
		TLS: func(fp string) bool {
			return s.peers.IsPeer(fp) || s.peers.IsPendingOut(fp) || s.pairing.HasInvite()
		},
		Request: func(fp, path string) bool {
			switch path {
			case peerPairPath:
				// 짝이 아닌 상대는 초대가 살아 있을 때만이다. 초대가 있을 때 연 keep-alive
				// 연결로 그 뒤에도 닿지 못하게 한다. 짝·대기는 만료 안내(peer_no_invite)를 받는다.
				return s.pairing.HasInvite() || s.peers.IsPeer(fp) || s.peers.IsPendingOut(fp)
			case peerConfirmPath:
				return s.peers.IsPeer(fp) || s.peers.IsPendingOut(fp)
			}
			return s.peers.IsPeer(fp)
		},
	}
}

// peerHandler 는 노드 포트의 핸들러다. `/peer/v1/*` 밖은 전부 404 다 (FR-PNW-6).
func (s *Server) peerHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+peerPairPath, s.peerPair)
	mux.HandleFunc("POST "+peerConfirmPath, s.peerPairConfirm)
	for op, fn := range peerCommands() {
		mux.HandleFunc("POST "+peerPathPrefix+op, s.peerCmd(op, fn))
	}
	mux.HandleFunc(peerPathPrefix, func(w http.ResponseWriter, r *http.Request) {
		peerFail(w, http.StatusNotFound, apierr.CodeNotFound, "unknown command")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		peerFail(w, http.StatusNotFound, apierr.CodeNotFound, "not found")
	})
	return reqIDMiddleware(recoverMiddleware(mux))
}

// peerFail 은 노드 포트·로컬 API 의 오류 하나다 — fs 방언과 같은 `{code,message}`
// (FR-PNW-42, I-7).
func peerFail(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set(apierr.CodeHeader, code)
	httpresp.JSON(w, status, map[string]string{"code": code, "message": msg})
}

// peerReadJSON 은 본문을 상한 안에서 읽어 v 에 푼다. 실패하면 답하고 거짓이다.
func peerReadJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return peerReadStatus(w, r, v) == 0
}

// peerReadStatus 는 peerReadJSON 과 같고, 실패하면 이미 써 보낸 응답 상태를 돌려준다.
// 감사 로그가 실제 결과 코드를 남기기 위해서다 (FR-PNW-94). 성공이면 0 이다.
func peerReadStatus(w http.ResponseWriter, r *http.Request, v any) int {
	raw, err := httpreq.Read(w, r, peerBodyLimit)
	if err != nil {
		st := httpreq.Status(err)
		peerFail(w, st, bodyReadCode(err), "read body")
		return st
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		peerFail(w, http.StatusBadRequest, apierr.CodeInvalidJSON, "invalid json")
		return http.StatusBadRequest
	}
	return 0
}

// peerAudit 는 프로토콜 요청 한 줄이다. 본문·토큰은 남기지 않는다 (FR-PNW-94·95).
func peerAudit(dir, peerName, op string, status int) {
	peerAuditCmd(dir, peerName, op, peerCmdResult{status: status})
}

// peerAuditCmd 는 대상 uuid 와 본문 길이까지 남긴다 (FR-PNW-94).
func peerAuditCmd(dir, peerName, op string, res peerCmdResult) {
	if peerName == "" {
		peerName = "-"
	}
	dmlog.Infof(nil, "peer audit dir=%s peer=%s op=%s target=%q len=%d status=%d",
		dir, peerName, op, res.target, res.n, res.status)
}

// peerPair 는 B 쪽 등록 요청이다 (FR-PNW-23~25).
func (s *Server) peerPair(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
		Name  string `json:"name"`
		Addr  string `json:"addr"`
		Port  int    `json:"port"`
		Proto int    `json:"proto"`
	}
	// S9: 짝이 아닌 상대도 닿는 경로다. 지문은 상대가 연결마다 바꿀 수 있으므로 출발지
	// 주소마다 센다(IPv6 는 /64). 넘은 요청은 감사 로그에 남기지 않는다 — 실패마다 쌓이면 로그가 공격
	// 대상이 된다.
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !s.peerLimiter.Allow(peerPairRateKey + peer.AddrRateKey(host)) {
		peerFail(w, http.StatusTooManyRequests, apierr.CodePeerRateLimited, "rate limited")
		return
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	if in.Port < 1 || in.Port > 65535 {
		peerFail(w, http.StatusBadRequest, apierr.CodeBadRequest, "port")
		return
	}
	// I-4: A 가 알릴 주소를 정하지 않았으면 이 연결의 출발지를 쓴다.
	addr := in.Addr
	if !peer.ValidAddr(addr) {
		addr, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	// 승인할 때 쓸 수 없는 주소(zone 이 붙은 link-local 등)면 초대를 쓰기 전에 거절한다.
	// 받아 두면 그 대기는 승인되지 않고 초대만 사라진다 (리뷰 C-15).
	if !peer.ValidAddr(addr) {
		peerAudit("in", "-", "pair", http.StatusBadRequest)
		peerFail(w, http.StatusBadRequest, apierr.CodePeerConfigInvalid, "addr: set advertise on the requesting node")
		return
	}
	switch err := s.pairing.Consume(in.Token); err {
	case nil:
	case peer.ErrNoInvite:
		peerAudit("in", "-", "pair", http.StatusForbidden)
		peerFail(w, http.StatusForbidden, apierr.CodePeerNoInvite, err.Error())
		return
	default:
		peerAudit("in", "-", "pair", http.StatusForbidden)
		peerFail(w, http.StatusForbidden, apierr.CodePeerTokenInvalid, err.Error())
		return
	}
	name := in.Name
	if peer.ValidName(name) != nil {
		name = peer.DefaultName(name)
	}
	s.pairing.AddPending(peer.Pending{Name: name, Addr: addr, Port: in.Port, Fingerprint: peer.ClientFingerprint(r)})
	peerAudit("in", name, "pair", http.StatusOK)
	s.peersChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"status": "pending", "name": s.peers.Config().Name})
}

// peerPairConfirm 은 A 쪽 승인 통지다 (FR-PNW-27).
func (s *Server) peerPairConfirm(w http.ResponseWriter, r *http.Request) {
	fp := peer.ClientFingerprint(r)
	err := s.peers.Promote(fp)
	switch {
	case err == nil, errors.Is(err, peer.ErrAlreadyPaired):
	case errors.Is(err, peer.ErrNotPending):
		peerAudit("in", "-", "pair.confirm", http.StatusForbidden)
		peerFail(w, http.StatusForbidden, apierr.CodePeerRejected, "not pending")
		return
	default:
		// pending-out 인데 바꾸지 못했으면 저장 실패다 (L-6).
		peerAudit("in", "-", "pair.confirm", http.StatusInternalServerError)
		peerFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, "save failed")
		return
	}
	name, _ := s.peers.NameOf(fp)
	peerAudit("in", name, "pair.confirm", http.StatusOK)
	// I-24: 이미 짝이었으면 바뀐 것이 없다.
	if err == nil {
		s.peersChanged("")
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"paired": true})
}

// StartPeer 는 설정대로 노드 포트를 열고, stop 이 닫히면 닫는다. 돌려준 채널은
// 닫기가 끝나면 닫힌다. 노드 포트가 없는 배선에서는 아무것도 하지 않는다.
func (s *Server) StartPeer(stop <-chan struct{}) <-chan struct{} {
	done := make(chan struct{})
	if s.peerLn == nil {
		close(done)
		return done
	}
	s.peerLn.Apply(s.peers.Config())
	go func() {
		<-stop
		s.peerLn.Close()
		close(done)
	}()
	return done
}

// peerStatus 는 노드 포트의 지금 상태다 (FR-PNW-9).
func (s *Server) peerStatus() peer.Status {
	if s.peerLn == nil {
		return peer.Status{}
	}
	return s.peerLn.Status()
}
