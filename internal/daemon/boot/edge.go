package boot

import (
	"context"
	"net"
	"net/http"
	"os"
	"sync/atomic"

	"dongminal/internal/daemon/chat"
	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/edgerelay"
)

// startEdge 는 데몬의 노드를 세우고 노드 소켓을 듣는다 (PEER_DAEMON_SRS FR-PDM-20~22, §3.5a).
// 서버가 노드 포트로 받은 연결을 노드 소켓으로 넘기고, 이 노드의 발신은 서버의 발신 소켓을
// 지난다. 노드를 세우지 못해도 데몬은 뜬다 — edge 는 503 으로 답한다. 노드가 서면 채팅도
// 세운다 (PEER_CHAT_SRS §3.9). 돌려준 함수가 채팅과 노드 소켓을 닫는다.
func startEdge(home string, ps *ipc.PanedServer) func() {
	hostname, _ := os.Hostname()
	var ln *edge.Listener
	var svc atomic.Pointer[chat.Service]
	dial := edgerelay.Dialer(edgerelay.DialSocketPath(home))
	n, err := edgenode.New(edgenode.Options{
		Home:       home,
		Hostname:   hostname,
		Dial:       dial,
		PortStatus: ps.EdgePort,
		OnConfig: func(c edge.Config) {
			if ln != nil {
				ln.Apply(c)
			}
		},
		Notify: ps.PushEdges,
		Chat: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s := svc.Load(); s != nil {
				s.Handler().ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
		}),
	})
	if err != nil {
		dmlog.Errorf(nil, "edge identity: %v — 노드 기능 없이 뜬다", err)
		return func() {}
	}
	stopChat := startChat(n, dial, &svc)
	ln = edge.NewListener(n.Identity(), n.Admission(), n.Handler())
	nodeSock := edgerelay.NodeSocketPath(home)
	ln.UseListen(func(string, int) (net.Listener, error) { return edgerelay.ListenNode(nodeSock) })
	ln.Apply(n.Config())
	ps.SetEdge(n)
	return func() {
		stopChat()
		ln.Close()
	}
}

// startChat 은 채팅을 세우고 간선 상대마다 채팅 연결을 유지한다 (PEER_CHAT_SRS FR-PCH-8).
func startChat(n *edgenode.Node, dial func(ctx context.Context, network, addr string) (net.Conn, error), slot *atomic.Pointer[chat.Service]) func() {
	client := edge.NewClientVia(n.Identity(), dial)
	s := chat.New(chat.Options{
		Identity: n.Identity(),
		Name:     func() string { return n.Config().Name },
		Edges:    func() []edge.Edge { return n.Config().Edges },
		Dial: func(ctx context.Context, t edge.Target) (net.Conn, error) {
			return client.Upgrade(ctx, t, chat.Path, chat.Proto)
		},
	})
	slot.Store(s)
	ctx, cancel := context.WithCancel(context.Background())
	go s.Run(ctx)
	return func() {
		cancel()
		s.Close()
	}
}
