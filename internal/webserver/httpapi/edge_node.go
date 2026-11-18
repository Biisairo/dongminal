package httpapi

import (
	"os"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
)

// 노드 계층 — 직접 모드 (PEER_DAEMON_SRS FR-PDM-52).
//
// 노드의 판정·짝맞춤·저장은 `edgenode` 가 한다. 여기는 노드를 세우고 노드 포트를 여닫는다.
// 노드 포트에는 access 게이트와 요청 게이트를 세우지 않는다 (FR-PNW-7) — 간선 맺기(인증서)가
// 문을 지킨다.

// initEdge 는 노드와 노드 포트 리스너를 세운다. 신원을 읽지 못하면 노드 포트를 세우지
// 않을 뿐 서버는 선다.
func (s *Server) initEdge() {
	if s.cfg.DataDir == "" {
		return
	}
	hostname, _ := os.Hostname()
	var ln *edge.Listener
	n, err := edgenode.New(edgenode.Options{
		Home:     s.cfg.DataDir,
		Hostname: hostname,
		PortStatus: func() edge.Status {
			if ln == nil {
				return edge.Status{}
			}
			return ln.Status()
		},
		OnConfig: func(c edge.Config) {
			if ln != nil {
				ln.Apply(c)
			}
		},
		Notify: s.edgesChanged,
	})
	if err != nil {
		dmlog.Infof(nil, "edge identity: %v — 노드 포트를 열지 않는다", err)
		return
	}
	ln = edge.NewListener(n.Identity(), n.Admission(), n.Handler())
	s.edgeNode, s.edgeLn = n, ln
}

// StartEdge 는 설정대로 노드 포트를 열고, stop 이 닫히면 닫는다. 돌려준 채널은
// 닫기가 끝나면 닫힌다. 노드 포트가 없는 배선에서는 아무것도 하지 않는다.
func (s *Server) StartEdge(stop <-chan struct{}) <-chan struct{} {
	done := make(chan struct{})
	if s.EdgeDaemon != nil {
		s.startEdgeRelay(stop, done)
		return done
	}
	if s.edgeLn == nil {
		close(done)
		return done
	}
	s.edgeLn.Apply(s.edgeNode.Config())
	go func() {
		<-stop
		s.edgeLn.Close()
		close(done)
	}()
	return done
}
