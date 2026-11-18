package httpapi

// 노드 계층의 시작. 노드는 데몬이다 — 서버는 자기 안에 노드를 세우지 않는다
// (DIRECT_MODE_REMOVAL_SRS FR-DMR-20). 서버가 하는 일은 노드 포트의 통로뿐이다(edge_relay.go).

// StartEdge 는 노드 포트의 통로를 열고, stop 이 닫히면 닫는다. 돌려준 채널은 닫기가 끝나면
// 닫힌다. 데몬이 배선되지 않았으면 아무것도 열지 않는다.
func (s *Server) StartEdge(stop <-chan struct{}) <-chan struct{} {
	done := make(chan struct{})
	if s.EdgeDaemon == nil {
		close(done)
		return done
	}
	s.startEdgeRelay(stop, done)
	return done
}
