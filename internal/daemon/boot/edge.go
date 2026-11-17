package boot

import (
	"net"
	"os"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/edgerelay"
)

// startEdge 는 데몬의 노드를 세우고 노드 소켓을 듣는다 (PEER_DAEMON_SRS FR-PDM-20~22, §3.5a).
// 서버가 노드 포트로 받은 연결을 노드 소켓으로 넘기고, 이 노드의 발신은 서버의 발신 소켓을
// 지난다. 노드를 세우지 못해도 데몬은 뜬다 — edge 는 503 으로 답한다. 돌려준 함수가 노드
// 소켓을 닫는다.
func startEdge(home string, ps *ipc.PanedServer) func() {
	hostname, _ := os.Hostname()
	var ln *edge.Listener
	n, err := edgenode.New(edgenode.Options{
		Home:       home,
		Hostname:   hostname,
		Dial:       edgerelay.Dialer(edgerelay.DialSocketPath(home)),
		PortStatus: ps.EdgePort,
		OnConfig: func(c edge.Config) {
			if ln != nil {
				ln.Apply(c)
			}
		},
		Notify: ps.PushEdges,
	})
	if err != nil {
		dmlog.Errorf(nil, "edge identity: %v — 노드 기능 없이 뜬다", err)
		return func() {}
	}
	ln = edge.NewListener(n.Identity(), n.Admission(), n.Handler())
	nodeSock := edgerelay.NodeSocketPath(home)
	ln.UseListen(func(string, int) (net.Listener, error) { return edgerelay.ListenNode(nodeSock) })
	ln.Apply(n.Config())
	ps.SetEdge(n)
	return ln.Close
}
