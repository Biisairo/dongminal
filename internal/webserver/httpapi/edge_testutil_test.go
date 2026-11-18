package httpapi

import (
	"testing"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/webserver/apierr"
)

// 노드 포트의 경로 (edgenode 와 같은 값).
const (
	testEdgePrefix   = "/edge/v1/"
	testEdgePairPath = testEdgePrefix + "pair"
)

// edgeStatusOf 는 직접 모드 노드 포트의 지금 상태다.
func edgeStatusOf(s *Server) edge.Status {
	if s.edgeLn == nil {
		return edge.Status{}
	}
	return s.edgeLn.Status()
}

// PEER_DAEMON_SRS §3.5a: 노드가 내는 코드는 모두 오류 카탈로그에 있다.
func TestEdgeNodeCodesInCatalog(t *testing.T) {
	all := map[string]bool{}
	for _, c := range apierr.AllCodes() {
		all[c] = true
	}
	for _, c := range edgenode.Codes() {
		if !all[c] {
			t.Errorf("%s 가 카탈로그에 없다", c)
		}
	}
}
