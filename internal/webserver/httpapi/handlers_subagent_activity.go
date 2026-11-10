package httpapi

import (
	"sync"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/statusline"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/sse"
)

// ACTIVITY_STATE_SUBAGENT_SRS 묶음 S — 서브에이전트 활동 (FR-ASV-10~13).
//
// `dmctl activity` 가 서브에이전트 훅(`agent_id` 가 있는 훅)을 `agentId` 와 함께 보낸다.
// main 활동과 따로 두는 이유는 §2.3 C-3 이다 — 섞으면 main 이 쉬는 동안에도 카드가
// working 이 되고 서브에이전트의 도구가 main 의 내용으로 보인다.

// subagentDoneKeep 은 done 이 된 서브에이전트 활동을 남겨 두는 기한이다 (FR-ASV-12).
const subagentDoneKeep = 30 * time.Second

type subagentActivity struct {
	AgentType string
	State     string
	Tool      string
	Detail    string
	UpdatedAt time.Time
}

type subagentActivityStore struct {
	mu sync.Mutex
	m  map[string]map[string]subagentActivity
}

// put 은 활동 하나를 덮어쓴다. 도구마다 statusline.SubagentMaxTasks 를 넘으면 가장
// 오래 갱신되지 않은 것을 버린다 (FR-ASV-11).
func (st *subagentActivityStore) put(toolID, agentID string, a subagentActivity, now time.Time) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.m == nil {
		st.m = map[string]map[string]subagentActivity{}
	}
	byAgent := st.m[toolID]
	if byAgent == nil {
		byAgent = map[string]subagentActivity{}
		st.m[toolID] = byAgent
	}
	a.UpdatedAt = now
	byAgent[agentID] = a
	for len(byAgent) > statusline.SubagentMaxTasks {
		oldest := ""
		for id, v := range byAgent {
			if oldest == "" || v.UpdatedAt.Before(byAgent[oldest].UpdatedAt) {
				oldest = id
			}
		}
		delete(byAgent, oldest)
	}
}

// list 는 now 기준으로 살아 있는 활동이다. 기한이 지난 done 은 여기서 지운다 (FR-ASV-12).
func (st *subagentActivityStore) list(toolID string, now time.Time) map[string]subagentActivity {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := map[string]subagentActivity{}
	for id, v := range st.m[toolID] {
		if v.State == activity.Done && now.Sub(v.UpdatedAt) > subagentDoneKeep {
			delete(st.m[toolID], id)
			continue
		}
		out[id] = v
	}
	return out
}

// dropTool 은 그 도구의 활동을 모두 지운다 — main 이 ended 일 때다 (FR-ASV-12).
func (st *subagentActivityStore) dropTool(toolID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.m, toolID)
}

// prune 은 live 가 거짓인 도구의 활동을 지우고 지운 도구 수를 돌려준다 (FR-ASV-12).
func (st *subagentActivityStore) prune(live func(toolID string) bool) int {
	st.mu.Lock()
	defer st.mu.Unlock()
	n := 0
	for id := range st.m {
		if !live(id) {
			delete(st.m, id)
			n++
		}
	}
	return n
}

// validSubagentState 는 서브에이전트 활동이 가질 수 있는 상태인가다 (FR-ASV-10).
func validSubagentState(s string) bool {
	return s == activity.Working || s == activity.Waiting || s == activity.Done
}

// reportSubagentActivity 는 서브에이전트 활동을 저장하고 방송한다 (FR-ASV-10·13).
// main 활동·알람·턴 표시는 건드리지 않는다.
func (s *Server) reportSubagentActivity(toolID, agentID, agentType, state, tool, detail string) {
	a := subagentActivity{
		AgentType: hub.SanitizeActivityField(agentType, hub.ActivityToolMax),
		State:     state,
		Tool:      hub.SanitizeActivityField(tool, hub.ActivityToolMax),
		Detail:    hub.SanitizeActivityField(detail, hub.ActivityDetailMax),
	}
	s.subActs.put(toolID, agentID, a, time.Now())
	if s.Commands != nil {
		s.Commands.Broadcast(sse.Payload("tool_subagent_activity", map[string]any{"toolId": toolID, "agentId": agentID,
			"agentType": a.AgentType, "state": a.State, "tool": a.Tool, "detail": a.Detail}))
	}
}
