package toolclient

import (
	"encoding/json"

	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS 단계 1 — 에이전트 기록의 쓰기·스냅샷·push (FR-ARD-11~13).
// 쓰는 쪽은 데몬이 FeatureRecords 를 말할 때만 부른다 (FR-ARD-14).

// RecordSet 은 기록 하나를 데몬에 쓴다. value 가 null 이면 지운다. 데몬이 거절하면
// *toolipc.RPCError 다 — 연결 오류와 가른다.
func (pc *ToolClient) RecordSet(kind, tool string, value json.RawMessage) error {
	if value == nil {
		value = json.RawMessage("null")
	}
	_, err := pc.call(toolipc.MethodRecordSet, toolipc.RecordSetParams{Kind: kind, Tool: tool, Value: value})
	return err
}

// Records 는 데몬의 기록 전부다 (FR-ARD-13).
func (pc *ToolClient) Records() (toolipc.RecordsResult, error) {
	return callT[toolipc.RecordsResult](pc, toolipc.MethodRecords, struct{}{})
}

// SetOnRecord 는 record push 콜백을 건다. 배선 전에 온 push 는 놓친다 — 붙은 직후의
// 스냅샷이 그 값을 싣는다.
func (pc *ToolClient) SetOnRecord(cb func(ev toolipc.RecordEvent)) {
	pc.mu.Lock()
	pc.onRecord = cb
	pc.mu.Unlock()
}

// SetOnResync 는 재접속 뒤 기록 재동기 콜백을 건다. 출력·종료의 재동기가 끝난 뒤
// supervise 고루틴에서 돈다.
func (pc *ToolClient) SetOnResync(cb func()) {
	pc.mu.Lock()
	pc.onResync = cb
	pc.mu.Unlock()
}

func (pc *ToolClient) resyncRecords() {
	pc.mu.Lock()
	cb := pc.onResync
	pc.mu.Unlock()
	if cb != nil {
		cb()
	}
}

// pushRecord 는 `record` push 다 (FR-ARD-12).
func (pc *ToolClient) pushRecord(m *wireMsg) {
	pc.mu.Lock()
	cb := pc.onRecord
	pc.mu.Unlock()
	if cb != nil {
		cb(toolipc.RecordEvent{Event: m.Event, Kind: m.Kind, Tool: m.Tool, Value: m.Value})
	}
}

// SetOnReport 는 report push 콜백을 건다 (§3.2a). 콜백은 읽기 루프에서 돈다 — 데몬 RPC 를
// 기다리는 일은 콜백 밖으로 떼어야 한다.
func (pc *ToolClient) SetOnReport(cb func(ev toolipc.ReportEvent)) {
	pc.mu.Lock()
	pc.onReport = cb
	pc.mu.Unlock()
}

// pushReport 는 `report` push 다 — 데몬의 보고 소켓이 받은 보고 그대로다.
func (pc *ToolClient) pushReport(m *wireMsg) {
	pc.mu.Lock()
	cb := pc.onReport
	pc.mu.Unlock()
	if cb != nil {
		cb(toolipc.ReportEvent{Event: m.Event, Method: m.Method, Body: m.Body})
	}
}
