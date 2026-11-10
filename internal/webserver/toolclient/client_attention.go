package toolclient

import (
	"encoding/json"

	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS 단계 3 — 알람 판정은 데몬이 한다 (FR-ARD-30~32, §3.3a). 아래
// 메서드는 데몬이 FeatureAttention 을 말할 때만 부른다. 데몬이 거절하면 *toolipc.RPCError 다.

// AttnConfig 는 판정 설정을 보낸다 (FR-ARD-31).
func (pc *ToolClient) AttnConfig(idleMS int64, allowBell bool) error {
	_, err := pc.call(toolipc.MethodAttnConfig, toolipc.AttnConfigParams{IdleMS: idleMS, AllowBell: allowBell})
	return err
}

// Attend 는 도구 하나의 알람 해제다 (FR-ARD-32).
func (pc *ToolClient) Attend(toolID string, typed bool) error {
	_, err := pc.call(toolipc.MethodAttend, toolipc.AttendParams{Tool: toolID, Typed: typed})
	return err
}

// AttendAll 은 알람 전부의 해제다. 해제한 수를 돌려준다.
func (pc *ToolClient) AttendAll() (int, error) {
	res, err := callT[toolipc.AttendAllResult](pc, toolipc.MethodAttendAll, struct{}{})
	return res.Cleared, err
}

// Report 는 서버 HTTP 로 온 보고를 데몬에 넘긴다. body 는 보고 본문이다.
func (pc *ToolClient) Report(method string, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = pc.call(toolipc.MethodReport, toolipc.ReportParams{Method: method, Body: raw})
	return err
}

// SetOnAttn 은 attn push 콜백을 건다. 콜백은 읽기 루프에서 돌므로 데몬 RPC 를 기다리면
// 안 된다. 배선 전에 온 push 는 놓친다 — 붙은 직후의 스냅샷이 그 상태를 싣는다.
func (pc *ToolClient) SetOnAttn(cb func(ev toolipc.AttnEvent)) {
	pc.mu.Lock()
	pc.onAttn = cb
	pc.mu.Unlock()
}

func (pc *ToolClient) pushAttn(m *wireMsg) {
	pc.mu.Lock()
	cb := pc.onAttn
	pc.mu.Unlock()
	if cb != nil {
		cb(toolipc.AttnEvent{Event: m.Event, Tool: m.Tool, Kind: m.Kind, Reason: m.Reason, Agent: m.Agent})
	}
}
