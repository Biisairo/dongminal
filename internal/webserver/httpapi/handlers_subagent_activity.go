package httpapi

import (
	"sync"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/sse"
)

// ACTIVITY_STATE_SUBAGENT_SRS 묶음 S — 서브에이전트 활동 (FR-ASV-10~13).
//
// `dmctl activity` 가 서브에이전트 훅(`agent_id` 가 있는 훅)을 `agentId` 와 함께 보낸다.
// main 활동과 따로 두는 이유는 §2.3 C-3 이다 — 섞으면 main 이 쉬는 동안에도 카드가
// working 이 되고 서브에이전트의 도구가 main 의 내용으로 보인다.

// subagentActivity 는 서브에이전트 하나의 훅 활동이다. 모양은 데몬과 함께 쓴다 (§3.2a).
type subagentActivity = agentrec.SubagentActivity

type subagentActivityStore struct {
	mu sync.Mutex
	m  map[string]map[string]subagentActivity
}

// put 은 활동 하나를 덮어쓴다. 상한 규칙은 agentrec.PutSubagentActivity 다 (FR-ASV-11).
func (st *subagentActivityStore) put(toolID, agentID string, a subagentActivity, now time.Time) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.m == nil {
		st.m = map[string]map[string]subagentActivity{}
	}
	st.m[toolID] = agentrec.PutSubagentActivity(st.m[toolID], agentID, a, now)
}

// list 는 now 기준으로 살아 있는 활동이다. 기한이 지난 done 은 여기서 지운다 (FR-ASV-12).
func (st *subagentActivityStore) list(toolID string, now time.Time) map[string]subagentActivity {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := map[string]subagentActivity{}
	for id, v := range st.m[toolID] {
		if v.State == activity.Done && now.Sub(v.UpdatedAt) > agentrec.SubagentDoneKeep {
			delete(st.m[toolID], id)
			continue
		}
		out[id] = v
	}
	return out
}

// dropStale 은 신호를 놓친 활동을 지운다 (FR-ASV-12 안전망, C-10·D-ASV-14). done 이 아니고
// SubagentStaleKeep 동안 갱신이 없으며, main 이 쉬고(mainBusy 거짓) statusLine 이 running 이라
// 하지 않는 것이다. 도는 서브에이전트는 main 이 바쁘거나 statusLine 이 running 으로 알린다.
func (st *subagentActivityStore) dropStale(toolID string, now time.Time, mainBusy bool, running map[string]bool) {
	if mainBusy {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	for id, v := range st.m[toolID] {
		if v.State != activity.Done && !running[id] && now.Sub(v.UpdatedAt) > agentrec.SubagentStaleKeep {
			delete(st.m[toolID], id)
		}
	}
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

// reportSubagentActivity 는 서브에이전트 활동을 저장하고 방송한다 (FR-ASV-10·13).
// main 활동·알람·턴 표시는 건드리지 않는다.
func (s *Server) reportSubagentActivity(req agentrec.ActivityReport) {
	toolID, agentID := req.ToolID, req.AgentID
	a := agentrec.SubagentActivityOf(req)
	s.subActs.put(toolID, agentID, a, time.Now())
	s.putRecord(toolipc.RecordSubagentActs, toolID, s.subActs.byTool(toolID))
	if s.Commands != nil {
		s.Commands.Broadcast(sse.Payload("tool_subagent_activity", map[string]any{"toolId": toolID, "agentId": agentID,
			"agentType": a.AgentType, "state": a.State, "tool": a.Tool, "detail": a.Detail}))
	}
}
