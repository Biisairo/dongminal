package toolhub

import (
	"encoding/json"
	"maps"
	"sync"
)

// AGENT_RECORD_DAEMON_SRS FR-ARD-10 — 데몬이 도구에 매달아 두는 에이전트 기록.

// AgentState 는 도구 하나의 활동·알람 상태를 옮기는 모양이다. 서버의 거울
// (`hub.AttnTracker`)과 데몬의 Tool 이 같은 한 벌을 쓴다 (D-ARD-8).
type AgentState struct {
	Activity     *ActivityState `json:"activity,omitempty"`
	AgentSeen    bool           `json:"agentSeen"`
	Armed        bool           `json:"armed"`
	Attention    bool           `json:"attention"`
	LastOutputAt int64          `json:"lastOutputAt"`
	RearmLocked  bool           `json:"rearmLocked"`
	Turn         TurnState      `json:"turn"`
}

// AgentState 는 지금의 상태다.
func (p *Tool) AgentState() AgentState {
	var a *ActivityState
	if cur := p.activity.Load(); cur != nil {
		c := *cur
		a = &c
	}
	return AgentState{
		Activity: a, AgentSeen: p.agentSeen.Load(), Armed: p.attnArmed.Load(), Attention: p.attention.Load(),
		LastOutputAt: p.LastOutputAt.Load(), RearmLocked: p.attnRearmLocked.Load(), Turn: p.turn.State(),
	}
}

// RestoreAgentState 는 상태를 st 로 되세운다. 알림은 부르지 않는다 — 판정이 아니라
// 기록의 반영이다. 마지막 출력 시각은 출력을 보는 이 Tool 이 적는 값이라 그대로 둔다.
func (p *Tool) RestoreAgentState(st AgentState) {
	if st.Activity != nil {
		a := *st.Activity
		p.activity.Store(&a)
	} else {
		p.activity.Store(nil)
	}
	p.agentSeen.Store(st.AgentSeen)
	p.attnArmed.Store(st.Armed)
	p.attention.Store(st.Attention)
	p.attnRearmLocked.Store(st.RearmLocked)
	p.turn.Restore(st.Turn)
}

// toolRecords 는 kind 마다 값 하나다. 값은 서버가 정한 JSON 이고 여기서는 해석하지 않는다.
type toolRecords struct {
	mu sync.Mutex
	m  map[string]json.RawMessage
}

// SetRecord 는 kind 의 값을 바꾼다. 비었거나 `null` 이면 지운다.
func (p *Tool) SetRecord(kind string, v json.RawMessage) {
	r := &p.records
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(v) == 0 || string(v) == "null" {
		delete(r.m, kind)
		return
	}
	if r.m == nil {
		r.m = map[string]json.RawMessage{}
	}
	r.m[kind] = append(json.RawMessage(nil), v...)
}

// Records 는 기록의 사본이다.
func (p *Tool) Records() map[string]json.RawMessage {
	r := &p.records
	r.mu.Lock()
	defer r.mu.Unlock()
	return maps.Clone(r.m)
}
