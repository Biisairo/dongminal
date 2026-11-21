package boot

import (
	"context"
	"net"
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
// 지난다. 노드를 세우지 못해도 데몬은 뜬다 — edge 는 503 으로 답한다. 노드가 서면 간선 계층의
// 간선 연결을 유지하고(EDGE_MESH_SRS FR-EGM-1), 그 위에 채팅을 세운다. 돌려준 함수가 채팅·간선
// 연결·노드 소켓을 닫는다.
func startEdge(home string, ps *ipc.PanedServer, pm *toolhub.ToolManager) func() {
	hostname, _ := os.Hostname()
	var ln *edge.Listener
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
		Mesh:   true,
	})
	if err != nil {
		dmlog.Errorf(nil, "edge identity: %v — 노드 기능 없이 뜬다", err)
		return func() {}
	}
	stopChat := startChat(home, n, chatTools{pm}, ps)
	ctx, cancel := context.WithCancel(context.Background())
	go n.Run(ctx)
	ln = edge.NewListener(n.Identity(), n.Admission(), n.Handler())
	nodeSock := edgerelay.NodeSocketPath(home)
	ln.UseListen(func(string, int) (net.Listener, error) { return edgerelay.ListenNode(nodeSock) })
	ln.Apply(n.Config())
	ps.SetEdge(n)
	return func() {
		stopChat()
		cancel()
		n.Close()
		ln.Close()
	}
}

// startChat 은 채팅을 간선 계층의 위층으로 세운다 (EDGE_MESH_SRS FR-EGM-40). 채팅 소켓을 열어
// MCP 연결을 참가자로 받는다 (PEER_CHAT_SRS §3.10). 소켓을 열지 못하면 MCP 를 주입하지 않을 뿐
// 채팅은 그대로 선다. 사람 참가자를 세워 서버에 잇는다 (§3.11).
func startChat(home string, n *edgenode.Node, tools chatsock.Tools, ps *ipc.PanedServer) func() {
	var sock atomic.Pointer[chatsock.Server]
	name := func() string { return n.Config().Name }
	s := chat.New(chat.Options{
		Identity: n.Identity(),
		Mesh:     n.Mesh(),
		Edges:    func() []edge.Edge { return n.Config().Edges },
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
	helper := humancmd.Client{Path: humancmd.SocketPath}
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
	go watchHelper(ctx, helper, s)
	return func() {
		cancel()
		cs.Close()
		s.Close()
	}
}

// 도우미를 묻는 간격과 키를 비우기까지의 연속 실패 수다 (PEER_CHAT_SRS §3.12·§3.12a R-7).
const (
	helperEvery = 30 * time.Second
	helperDrop  = 3
)

// watchHelper 는 시작할 때와 그 뒤 helperEvery 마다 도우미의 공개키를 물어 채팅에 싣는다. 도우미가
// 없거나 닿지 않는 것이 helperDrop 번 이어지면 키를 비운다 — 화면은 사람 명령 메뉴를 숨긴다 (FR-PCH-78).
func watchHelper(ctx context.Context, h humancmd.Client, s *chat.Service) {
	t := time.NewTicker(helperEvery)
	defer t.Stop()
	var w helperWatch
	for {
		info, err := h.Info()
		if key, set := w.next(info.Key, err); set {
			s.SetHelper(key)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// helperWatch 는 도우미 확인의 연속 실패 수다.
type helperWatch struct{ fails int }

// next 는 확인 한 번의 결과로 실을 키와 실을지를 정한다. 얻으면 바로 싣고, 비우는 것은 연속
// helperDrop 번 실패한 뒤다. 한 번의 시한 초과가 사람 명령과 엇갈려 키를 비우지 않게 한다.
func (w *helperWatch) next(key string, err error) (string, bool) {
	if err == nil && key != "" {
		w.fails = 0
		return key, true
	}
	w.fails++
	return "", w.fails >= helperDrop
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
