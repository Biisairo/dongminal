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
	"dongminal/internal/shared/edge"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpreq"
	"dongminal/internal/webserver/httpresp"
)

// 노드 포트 (PEER_NETWORK_SRS 묶음 N·P).
//
// UI 리스너와 따로 연다. 이 포트에는 access 게이트와 요청 게이트를 세우지 않는다
// (FR-PNW-7) — 짝맞춤(인증서)이 문을 지킨다.

const (
	// edgePathPrefix 는 노드 포트가 받는 유일한 경로다 (FR-PNW-6).
	edgePathPrefix  = "/edge/v1/"
	edgePairPath    = edgePathPrefix + "pair"
	edgeConfirmPath = edgePathPrefix + "pair/confirm"
	// edgePairRateKey 는 등록 요청 상한의 키 머리다. 짝의 지문 키와 섞이지 않는다.
	edgePairRateKey = "pair-addr:"
	// edgeProto 는 이 서버가 말하는 프로토콜 판이다. 등록 요청에 싣는다 (FR-PNW-50).
	edgeProto = 1
	// legacyPeerSpawnsFile 은 원격 기동 기록의 옛 파일이다. 노드 계층이 설 때 지운다
	// (PEER_DAEMON_SRS FR-PDM-64).
	legacyPeerSpawnsFile = "peer-spawns.json"
	// jsonBodyLimit 은 요청 본문 상한이다 (FR-PNW-43).
	jsonBodyLimit = 64 << 10
)

// initEdge 는 노드 신원·설정·리스너를 세운다. 신원을 읽지 못하면 노드 포트를
// 세우지 않을 뿐 서버는 선다.
func (s *Server) initEdge() {
	if s.cfg.DataDir == "" {
		return
	}
	if err := edge.MigrateLegacyFiles(s.cfg.DataDir); err != nil {
		dmlog.Infof(nil, "edge config: 옛 홈 파일을 정리하지 못했다: %v", err)
	}
	hostname, _ := os.Hostname()
	s.edges = edge.OpenStore(filepath.Join(s.cfg.DataDir, dmenv.EdgesFile), hostname)
	id, err := edge.LoadOrCreateIdentity(s.cfg.DataDir)
	if err != nil {
		dmlog.Infof(nil, "edge identity: %v — 노드 포트를 열지 않는다", err)
		return
	}
	s.edgeID = id
	s.edgeClient = edge.NewClient(id)
	s.pairing = edge.NewPairing(time.Now)
	s.edgeLimiter = edge.NewRateLimiter(time.Now)
	if err := os.Remove(filepath.Join(s.cfg.DataDir, legacyPeerSpawnsFile)); err != nil && !os.IsNotExist(err) {
		dmlog.Infof(nil, "peer-spawns.json 을 지우지 못했다: %v", err)
	}
	s.edgeLn = edge.NewListener(id, s.edgeAdmission(), s.edgeHandler())
}

// edgeAdmission 은 노드 포트의 두 단계 판정이다 (I-1, FR-PNW-24·27·41).
func (s *Server) edgeAdmission() edge.Admission {
	return edge.Admission{
		TLS: func(fp string) bool {
			return s.edges.IsEdge(fp) || s.edges.IsPendingOut(fp) || s.pairing.HasInvite()
		},
		Request: func(fp, path string) bool {
			switch path {
			case edgePairPath:
				// 짝이 아닌 상대는 초대가 살아 있을 때만이다. 초대가 있을 때 연 keep-alive
				// 연결로 그 뒤에도 닿지 못하게 한다. 짝·대기는 만료 안내(edge_no_invite)를 받는다.
				return s.pairing.HasInvite() || s.edges.IsEdge(fp) || s.edges.IsPendingOut(fp)
			case edgeConfirmPath:
				return s.edges.IsEdge(fp) || s.edges.IsPendingOut(fp)
			}
			return s.edges.IsEdge(fp)
		},
	}
}

// edgeHandler 는 노드 포트의 핸들러다. 짝맞춤 경로 둘 밖은 전부 404 다
// (FR-PNW-6, PEER_DAEMON_SRS FR-PDM-60).
func (s *Server) edgeHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+edgePairPath, s.edgePair)
	mux.HandleFunc("POST "+edgeConfirmPath, s.edgePairConfirm)
	mux.HandleFunc(edgePathPrefix, func(w http.ResponseWriter, r *http.Request) {
		codeFail(w, http.StatusNotFound, apierr.CodeNotFound, "unknown command")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		codeFail(w, http.StatusNotFound, apierr.CodeNotFound, "not found")
	})
	return reqIDMiddleware(recoverMiddleware(mux))
}

// codeFail 은 노드 포트·로컬 API 의 오류 하나다 — fs 방언과 같은 `{code,message}`
// (FR-PNW-42, I-7).
func codeFail(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set(apierr.CodeHeader, code)
	httpresp.JSON(w, status, map[string]string{"code": code, "message": msg})
}

// readJSONBody 은 본문을 상한 안에서 읽어 v 에 푼다. 실패하면 답하고 거짓이다.
func readJSONBody(w http.ResponseWriter, r *http.Request, v any) bool {
	raw, err := httpreq.Read(w, r, jsonBodyLimit)
	if err != nil {
		codeFail(w, httpreq.Status(err), bodyReadCode(err), "read body")
		return false
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		codeFail(w, http.StatusBadRequest, apierr.CodeInvalidJSON, "invalid json")
		return false
	}
	return true
}

// edgeAudit 는 짝맞춤 요청 한 줄이다. 본문·토큰은 남기지 않는다 (FR-PNW-94·95).
func edgeAudit(dir, edgeName, op string, status int) {
	if edgeName == "" {
		edgeName = "-"
	}
	dmlog.Infof(nil, "edge audit dir=%s edge=%s op=%s status=%d", dir, edgeName, op, status)
}

// edgePair 는 B 쪽 등록 요청이다 (FR-PNW-23~25).
func (s *Server) edgePair(w http.ResponseWriter, r *http.Request) {
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
	if !s.edgeLimiter.Allow(edgePairRateKey + edge.AddrRateKey(host)) {
		codeFail(w, http.StatusTooManyRequests, apierr.CodeEdgeRateLimited, "rate limited")
		return
	}
	if !readJSONBody(w, r, &in) {
		return
	}
	if in.Port < 1 || in.Port > 65535 {
		codeFail(w, http.StatusBadRequest, apierr.CodeBadRequest, "port")
		return
	}
	// I-4: A 가 알릴 주소를 정하지 않았으면 이 연결의 출발지를 쓴다.
	addr := in.Addr
	if !edge.ValidAddr(addr) {
		addr, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	// 승인할 때 쓸 수 없는 주소(zone 이 붙은 link-local 등)면 초대를 쓰기 전에 거절한다.
	// 받아 두면 그 대기는 승인되지 않고 초대만 사라진다 (리뷰 C-15).
	if !edge.ValidAddr(addr) {
		edgeAudit("in", "-", "pair", http.StatusBadRequest)
		codeFail(w, http.StatusBadRequest, apierr.CodeEdgeConfigInvalid, "addr: set advertise on the requesting node")
		return
	}
	switch err := s.pairing.Consume(in.Token); err {
	case nil:
	case edge.ErrNoInvite:
		edgeAudit("in", "-", "pair", http.StatusForbidden)
		codeFail(w, http.StatusForbidden, apierr.CodeEdgeNoInvite, err.Error())
		return
	default:
		edgeAudit("in", "-", "pair", http.StatusForbidden)
		codeFail(w, http.StatusForbidden, apierr.CodeEdgeTokenInvalid, err.Error())
		return
	}
	name := in.Name
	if edge.ValidName(name) != nil {
		name = edge.DefaultName(name)
	}
	s.pairing.AddPending(edge.Pending{Name: name, Addr: addr, Port: in.Port, Fingerprint: edge.ClientFingerprint(r)})
	edgeAudit("in", name, "pair", http.StatusOK)
	s.edgesChanged("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"status": "pending", "name": s.edges.Config().Name})
}

// edgePairConfirm 은 A 쪽 승인 통지다 (FR-PNW-27).
func (s *Server) edgePairConfirm(w http.ResponseWriter, r *http.Request) {
	fp := edge.ClientFingerprint(r)
	err := s.edges.Promote(fp)
	switch {
	case err == nil, errors.Is(err, edge.ErrAlreadyPaired):
	case errors.Is(err, edge.ErrNotPending):
		edgeAudit("in", "-", "pair.confirm", http.StatusForbidden)
		codeFail(w, http.StatusForbidden, apierr.CodeEdgeRejected, "not pending")
		return
	default:
		// pending-out 인데 바꾸지 못했으면 저장 실패다 (L-6).
		edgeAudit("in", "-", "pair.confirm", http.StatusInternalServerError)
		codeFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, "save failed")
		return
	}
	name, _ := s.edges.NameOf(fp)
	edgeAudit("in", name, "pair.confirm", http.StatusOK)
	// I-24: 이미 짝이었으면 바뀐 것이 없다.
	if err == nil {
		s.edgesChanged("")
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"paired": true})
}

// StartEdge 는 설정대로 노드 포트를 열고, stop 이 닫히면 닫는다. 돌려준 채널은
// 닫기가 끝나면 닫힌다. 노드 포트가 없는 배선에서는 아무것도 하지 않는다.
func (s *Server) StartEdge(stop <-chan struct{}) <-chan struct{} {
	done := make(chan struct{})
	if s.edgeLn == nil {
		close(done)
		return done
	}
	s.edgeLn.Apply(s.edges.Config())
	go func() {
		<-stop
		s.edgeLn.Close()
		close(done)
	}()
	return done
}

// edgeStatus 는 노드 포트의 지금 상태다 (FR-PNW-9).
func (s *Server) edgeStatus() edge.Status {
	if s.edgeLn == nil {
		return edge.Status{}
	}
	return s.edgeLn.Status()
}
