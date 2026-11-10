package httpapi

import (
	"net/http"
	"os"
	"path/filepath"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/peer"
	"dongminal/internal/webserver/httpresp"
)

// 노드 포트 (PEER_NETWORK_SRS 묶음 N).
//
// UI 리스너와 따로 연다. 이 포트에는 access 게이트와 요청 게이트를 세우지 않는다
// (FR-PNW-7) — 짝맞춤(인증서)이 문을 지킨다.

// peerPathPrefix 는 노드 포트가 받는 유일한 경로다 (FR-PNW-6).
const peerPathPrefix = "/peer/v1/"

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
	s.peerLn = peer.NewListener(id, s.peers.IsPeer, s.peerHandler())
}

// peerHandler 는 노드 포트의 핸들러다. `/peer/v1/*` 밖은 전부 404 다 (FR-PNW-6).
func (s *Server) peerHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(peerPathPrefix, func(w http.ResponseWriter, r *http.Request) {
		peerFail(w, http.StatusNotFound, apierr.CodeNotFound, "unknown command")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		peerFail(w, http.StatusNotFound, apierr.CodeNotFound, "not found")
	})
	return reqIDMiddleware(recoverMiddleware(mux))
}

// peerFail 은 노드 포트의 오류 하나다 — fs 방언과 같은 `{code,message}` (FR-PNW-42).
func peerFail(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set(apierr.CodeHeader, code)
	httpresp.JSON(w, status, map[string]string{"code": code, "message": msg})
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
