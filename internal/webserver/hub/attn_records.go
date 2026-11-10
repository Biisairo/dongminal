package hub

import (
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
)

// AGENT_RECORD_DAEMON_SRS 단계 1 — 추적기는 데몬 기록의 거울이다 (FR-ARD-11·13).
// 상태의 모양은 데몬 Tool 과 같은 toolhub.AgentState 한 벌이다 (D-ARD-8).

// SetOnChange 는 판정이 상태를 바꾼 뒤의 콜백을 건다.
func (t *AttnTracker) SetOnChange(f func(id string, st toolhub.AgentState)) {
	t.mu.Lock()
	t.onChange = f
	t.mu.Unlock()
}

func (t *AttnTracker) changed(ps *attnPaneState) {
	if t.mirroring() {
		return
	}
	t.mu.Lock()
	f := t.onChange
	t.mu.Unlock()
	if f != nil {
		f(ps.id, ps.agentState())
	}
}

func (ps *attnPaneState) agentState() toolhub.AgentState {
	var a *toolhub.ActivityState
	if cur := ps.activity.Load(); cur != nil {
		c := *cur
		a = &c
	}
	return toolhub.AgentState{
		Activity: a, AgentSeen: ps.agentSeen.Load(), Armed: ps.attnArmed.Load(), Attention: ps.attention.Load(),
		LastOutputAt: ps.lastOutputAt.Load(), RearmLocked: ps.attnRearmLocked.Load(), Turn: ps.turn.State(),
	}
}

// restore 는 st 를 되세우고 활동 카드가 바뀌었는지 돌려준다.
func (ps *attnPaneState) restore(st toolhub.AgentState) bool {
	prev := ps.activity.Load()
	if st.Activity != nil {
		a := *st.Activity
		ps.activity.Store(&a)
	} else {
		ps.activity.Store(nil)
	}
	ps.agentSeen.Store(st.AgentSeen)
	ps.attnArmed.Store(st.Armed)
	ps.attention.Store(st.Attention)
	ps.attnRearmLocked.Store(st.RearmLocked)
	ps.lastOutputAt.Store(st.LastOutputAt)
	ps.turn.Restore(st.Turn)
	return !sameCard(prev, st.Activity)
}

func sameCard(a, b *toolhub.ActivityState) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.State == b.State && a.Tool == b.Tool && a.Detail == b.Detail
}

// AgentStateOf 는 도구의 지금 상태다. 모르는 도구는 제로값이다.
func (t *AttnTracker) AgentStateOf(toolID string) toolhub.AgentState {
	t.mu.Lock()
	ps := t.tools[toolID]
	t.mu.Unlock()
	if ps == nil {
		return toolhub.AgentState{}
	}
	return ps.agentState()
}

// Restore 는 데몬 기록 하나를 반영한다 (record push). 알람은 울리지 않고, 카드가
// 바뀌었으면 활동만 방송한다.
func (t *AttnTracker) Restore(toolID string, st toolhub.AgentState) {
	if t.state(toolID).restore(st) {
		t.broadcastCard(toolID, st.Activity)
	}
}

// RestoreAll 은 스냅샷으로 거울을 통째로 바꾼다 (FR-ARD-13). 스냅샷에 없는 도구는
// 데몬에 없는 도구이므로 잊는다.
func (t *AttnTracker) RestoreAll(states map[string]toolhub.AgentState) {
	t.mu.Lock()
	var gone []string
	for id := range t.tools {
		if _, ok := states[id]; !ok {
			gone = append(gone, id)
		}
	}
	t.mu.Unlock()
	for _, id := range gone {
		had := t.Activity(id) != nil
		t.Forget(id)
		if had {
			t.broadcastCard(id, nil)
		}
	}
	for id, st := range states {
		t.Restore(id, st)
	}
}

func (t *AttnTracker) broadcastCard(toolID string, a *toolhub.ActivityState) {
	if a == nil {
		t.onActivity(toolID, activity.Ended, "", "")
		return
	}
	t.onActivity(toolID, a.State, a.Tool, a.Detail)
}
