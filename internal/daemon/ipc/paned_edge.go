package ipc

import (
	"context"
	"net/http"
	"sync"
	"time"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/toolipc"
)

// PEER_DAEMON_SRS §3.5a — 데몬이 노드다. 노드(edgenode)는 boot 가 세워 SetEdge 로 싣는다.
// 서버는 로컬 API 를 edge 로 넘기고, 연 노드 포트의 상태를 edgeport 로 알린다.

// edgeCallTimeout 은 edge 한 번의 상한이다. 상대 호출(15초)과 연결·핸드셰이크를 넘긴다.
const edgeCallTimeout = 30 * time.Second

// panedEdgeSlowMax 는 한 연결에서 동시에 도는 edge 의 수다. create·restore 의 풀과 나눈다 —
// 상대를 기다리는 간선 맺기가 도구 생성을 막지 않는다 (FR-PDM-31).
const panedEdgeSlowMax = 2

// edgeState 는 데몬의 노드와 서버가 알린 노드 포트 상태다. 연결이 바뀌어도 남는다.
type edgeState struct {
	mu   sync.Mutex
	node *edgenode.Node
	port edge.Status
}

// SetEdge 는 노드를 싣는다. 싣지 않으면 edge 는 503 edge_unavailable 이다.
func (ps *PanedServer) SetEdge(n *edgenode.Node) {
	ps.edge.mu.Lock()
	ps.edge.node = n
	ps.edge.mu.Unlock()
}

func (ps *PanedServer) edgeNode() *edgenode.Node {
	ps.edge.mu.Lock()
	defer ps.edge.mu.Unlock()
	return ps.edge.node
}

// EdgePort 는 서버가 마지막으로 알린 노드 포트 상태다. 노드의 PortStatus 로 쓴다.
func (ps *PanedServer) EdgePort() edge.Status {
	ps.edge.mu.Lock()
	defer ps.edge.mu.Unlock()
	return ps.edge.port
}

// PushEdges 는 간선 상태가 바뀌었다고 서버에 알린다 (FR-PDM-27). edges push 를 모르는 서버나
// 서버가 없으면 보내지 않는다 — 서버는 붙을 때 다시 읽는다. 노드의 Notify 로 쓴다.
func (ps *PanedServer) PushEdges(ch edgenode.Change) {
	ps.mu.Lock()
	c := ps.currConn
	ps.mu.Unlock()
	if c == nil || !c.edge.Load() {
		return
	}
	ev := toolipc.EdgesEvent{Event: toolipc.EventEdges}
	if r := ch.Paired; r != nil {
		ev.Paired = &toolipc.EdgeRef{FP: r.FP, Name: r.Name}
	}
	if r := ch.Removed; r != nil {
		ev.Removed = &toolipc.EdgeRef{FP: r.FP, Name: r.Name}
	}
	c.enqueue(ev, false)
}

// edgeOp 는 로컬 API 연산 하나다 (FR-PDM-30).
func (pc *panedConn) edgeOp(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.EdgeParams](req)
	if perr != nil {
		return *perr
	}
	var n *edgenode.Node
	if pc.srv != nil {
		n = pc.srv.edgeNode()
	}
	if n == nil {
		return okResp(req, toolipc.EdgeResult{Status: http.StatusServiceUnavailable, Code: edge.CodeUnavailable, Message: "edge layer unavailable"})
	}
	ctx, cancel := context.WithTimeout(context.Background(), edgeCallTimeout)
	defer cancel()
	res := n.Do(ctx, edgenode.Request{Op: p.Op, Args: p.Args, IfMatch: p.IfMatch})
	return okResp(req, toolipc.EdgeResult{Body: res.Body, Code: res.Code, ETag: res.ETag, Message: res.Message, Status: res.Status})
}

// edgePort 는 서버가 연 노드 포트의 상태다 (FR-PDM-14).
func (pc *panedConn) edgePort(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.EdgePortParams](req)
	if perr != nil {
		return *perr
	}
	if pc.srv != nil {
		pc.srv.edge.mu.Lock()
		pc.srv.edge.port = edge.Status{Listening: p.Listening, Addr: p.Addr, Err: p.Error}
		pc.srv.edge.mu.Unlock()
	}
	return okResp(req, struct{}{})
}

// goEdge 는 edge 를 읽기 루프 밖에서 돌린다. 풀은 create·restore 와 따로다.
func (pc *panedConn) goEdge(fn func() interface{}) {
	if pc.edgeSlow == nil {
		pc.enqueue(fn(), false)
		return
	}
	go func() {
		select {
		case pc.edgeSlow <- struct{}{}:
		case <-pc.done:
			return
		}
		defer func() { <-pc.edgeSlow }()
		pc.enqueue(fn(), false)
	}()
}
