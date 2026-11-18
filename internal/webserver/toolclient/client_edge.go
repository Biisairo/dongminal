package toolclient

import (
	"time"

	"dongminal/internal/shared/toolipc"
)

// PEER_DAEMON_SRS §3.5a — 데몬이 노드다. 아래 메서드는 데몬이 FeatureEdge 를 말할 때만 부른다.

// edgeCallWithin 은 edge 한 번의 상한이다. 데몬의 상한(30초)보다 길어야 한다 — 시한을 넘긴
// 호출은 연결 전체를 끊는다.
const edgeCallWithin = 35 * time.Second

// EdgeReady 는 붙은 데몬이 노드 기능을 말하는가다 (FR-PDM-50). 데몬이 바뀔 수 있으므로
// 부를 때마다 묻는다.
func (pc *ToolClient) EdgeReady() bool { return pc.HasFeature(toolipc.FeatureEdge) }

// Edge 는 로컬 API 연산 하나를 데몬의 노드에 넘긴다 (FR-PDM-30).
func (pc *ToolClient) Edge(p toolipc.EdgeParams) (toolipc.EdgeResult, error) {
	return callWithinT[toolipc.EdgeResult](pc, toolipc.MethodEdge, p, edgeCallWithin)
}

// EdgePort 는 서버가 연 노드 포트의 상태를 데몬에 알린다 (FR-PDM-14).
func (pc *ToolClient) EdgePort(p toolipc.EdgePortParams) error {
	_, err := pc.call(toolipc.MethodEdgePort, p)
	return err
}

// SetOnEdges 는 edges push 콜백을 건다. 콜백은 읽기 루프에서 돌므로 데몬 RPC 를 기다리면
// 안 된다 — 다시 읽기는 큐로 뗀다.
func (pc *ToolClient) SetOnEdges(cb func(ev toolipc.EdgesEvent)) {
	pc.mu.Lock()
	pc.onEdges = cb
	pc.mu.Unlock()
}

func (pc *ToolClient) pushEdges(m *wireMsg) {
	pc.mu.Lock()
	cb := pc.onEdges
	pc.mu.Unlock()
	if cb != nil {
		cb(toolipc.EdgesEvent{Event: m.Event, Paired: m.Paired, Removed: m.Removed, ByPeer: m.ByPeer, Invited: m.Invited})
	}
}

// SetOnEdgeResync 는 재접속 뒤의 간선 재동기 콜백을 건다 (FR-PDM-33). supervise 고루틴에서
// 돈다. 기록의 재동기(SetOnResync)와 따로 둔다 — 그쪽은 알람 추적기가 있을 때만 걸린다.
func (pc *ToolClient) SetOnEdgeResync(cb func()) {
	pc.mu.Lock()
	pc.onEdgeResync = cb
	pc.mu.Unlock()
}

func (pc *ToolClient) resyncEdge() {
	pc.mu.Lock()
	cb := pc.onEdgeResync
	pc.mu.Unlock()
	if cb != nil {
		cb()
	}
}
