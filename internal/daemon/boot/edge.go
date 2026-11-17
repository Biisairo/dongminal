package boot

import (
	"context"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"dongminal/internal/daemon/chat"
	"dongminal/internal/daemon/chatsock"
	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/edgerelay"
	"dongminal/internal/shared/humancmd"
	"dongminal/internal/shared/toolhub"
)

// startEdge 는 데몬의 노드를 세우고 노드 소켓을 듣는다 (PEER_DAEMON_SRS FR-PDM-20~22, §3.5a).
// 서버가 노드 포트로 받은 연결을 노드 소켓으로 넘기고, 이 노드의 발신은 서버의 발신 소켓을
// 지난다. 노드를 세우지 못해도 데몬은 뜬다 — edge 는 503 으로 답한다. 노드가 서면 채팅도
// 세운다 (PEER_CHAT_SRS §3.9). 돌려준 함수가 채팅과 노드 소켓을 닫는다.
func startEdge(home string, ps *ipc.PanedServer, pm *toolhub.ToolManager) func() {
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
	stopChat := startChat(home, n, dial, &svc, chatTools{pm}, ps)
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
// 채팅 소켓을 열어 MCP 연결을 참가자로 받는다 (§3.10). 소켓을 열지 못하면 MCP 를 주입하지
// 않을 뿐 채팅 연결은 그대로 선다. 사람 참가자를 세워 서버에 잇는다 (§3.11).
func startChat(home string, n *edgenode.Node, dial func(ctx context.Context, network, addr string) (net.Conn, error), slot *atomic.Pointer[chat.Service], tools chatsock.Tools, ps *ipc.PanedServer) func() {
	client := edge.NewClientVia(n.Identity(), dial)
	var sock atomic.Pointer[chatsock.Server]
	name := func() string { return n.Config().Name }
	s := chat.New(chat.Options{
		Identity: n.Identity(),
		Name:     name,
		Edges:    func() []edge.Edge { return n.Config().Edges },
		Dial: func(ctx context.Context, t edge.Target) (net.Conn, error) {
			return client.Upgrade(ctx, t, chat.Path, chat.Proto)
		},
		Deliver: func(pid string, m chat.Message) {
			if cs := sock.Load(); cs != nil {
				cs.Deliver(pid, m)
			}
		},
		Changed: ps.PushChatChanged,
		Pin: func(fp, key string) {
			if err := n.Store().PinHelper(fp, key); err != nil {
				dmlog.Errorf(nil, "chat: 도우미 키 고정: %v", err)
			}
		},
	})
	slot.Store(s)
	helper := humancmd.Client{Path: humancmd.SocketPath, Timeout: helperWait}
	cs := chatsock.New(chatsock.Options{Chat: s, Tools: tools, Name: name, OnUser: ps.PushChatMsg, Helper: helper})
	cs.StartUser()
	ps.SetChat(cs)
	if err := cs.Listen(chatwire.SocketPath(home)); err != nil {
		dmlog.Errorf(nil, "채팅 소켓: %v", err)
	} else {
		sock.Store(cs)
		go cs.Serve()
	}
	ctx, cancel := context.WithCancel(context.Background())
	go s.Run(ctx)
	go watchHelper(ctx, helper, s)
	return func() {
		cancel()
		cs.Close()
		s.Close()
	}
}

// 도우미를 묻는 간격과 한 번의 시한이다 (PEER_CHAT_SRS §3.12).
const (
	helperEvery = 30 * time.Second
	helperWait  = 3 * time.Second
)

// watchHelper 는 시작할 때와 그 뒤 helperEvery 마다 도우미의 공개키를 물어 채팅에 싣는다. 도우미가
// 없거나 닿지 않으면 빈 키다 — 화면은 사람 명령 메뉴를 숨긴다 (FR-PCH-78).
func watchHelper(ctx context.Context, h humancmd.Client, s *chat.Service) {
	t := time.NewTicker(helperEvery)
	defer t.Stop()
	for {
		key := ""
		if info, err := h.Info(); err == nil {
			key = info.Key
		}
		s.SetHelper(key)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// chatTools 는 채팅 소켓이 쓰는 도구 계층이다.
type chatTools struct{ pm *toolhub.ToolManager }

func (t chatTools) Resting(id string) bool {
	p := t.pm.Get(id)
	return p != nil && resting(p.Activity())
}

func (t chatTools) Paste(id, text string) error { return t.pm.SendPaste(id, []byte(text), true) }

// resting 은 쉬는 중(idle·done)인가다. 보고가 없으면 쉬는 중이 아니다 (FR-PCH-61).
func resting(a *toolhub.ActivityState) bool {
	return a != nil && (a.State == activity.Idle || a.State == activity.Done)
}
