package httpapi

import (
	"cmp"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/statusline"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/hub"
)

// SUBAGENT_USAGE_SRS — 도구별 서브에이전트 목록 (FR-SAU-10~15).
//
// `dmctl subagent-statusline` 이 Claude Code 의 subagentStatusLine 입력에서 꺼낸 목록을
// 틱(약 5초)마다 보낸다. 보일 행이 없으면 틱이 멈추고 빈 목록도 오지 않으므로, 받은 지
// subagentStale 이 지난 목록은 없는 것으로 본다 (FR-SAU-12).

// subagentStale 은 목록이 신선한 기한이다 — 틱 셋이다 (FR-SAU-12).
const subagentStale = 15 * time.Second

type subagentList struct {
	tasks      []statusline.Subagent
	observedAt time.Time
}

type subagentStore struct {
	mu sync.Mutex
	m  map[string]subagentList
}

func (st *subagentStore) put(toolID string, tasks []statusline.Subagent, at time.Time) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.m == nil {
		st.m = map[string]subagentList{}
	}
	st.m[toolID] = subagentList{tasks: tasks, observedAt: at}
}

// get 은 now 기준으로 신선한 목록이다. 없거나 기한이 지났으면 ok 가 거짓이다.
func (st *subagentStore) get(toolID string, now time.Time) ([]statusline.Subagent, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	l, ok := st.m[toolID]
	if !ok || now.Sub(l.observedAt) > subagentStale {
		return nil, false
	}
	return l.tasks, true
}

// prune 은 live 가 거짓인 도구의 목록을 지우고 지운 수를 돌려준다 (FR-SAU-11).
func (st *subagentStore) prune(live func(toolID string) bool) int {
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

// apiToolSubagents implements POST /api/tools/subagents (FR-SAU-10).
func (s *Server) apiToolSubagents(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID string                `json:"toolId"`
		Tasks  []statusline.Subagent `json:"tasks"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	toolID := s.callerToolID(r, body.ToolID)
	if toolID == "" {
		httpErr(w, "toolId required", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	s.subagents.put(toolID, body.Tasks, time.Now())
	writeJSON(w, map[string]any{"ok": true})
}

// freshSubagents 는 상태 응답에 얹을 목록이다. 비었으면 nil 이다 (FR-SAU-15).
func (s *Server) freshSubagents(toolID string) []statusline.Subagent {
	tasks, ok := s.subagents.get(toolID, time.Now())
	if !ok || len(tasks) == 0 {
		return nil
	}
	return tasks
}

// cardSubagent 는 활동 목록 항목의 서브에이전트 하나다 (FR-SAU-13).
type cardSubagent struct {
	ID           string   `json:"id"`
	AgentType    string   `json:"agentType,omitempty"`
	Status       string   `json:"status,omitempty"`
	Model        string   `json:"model,omitempty"`
	Effort       string   `json:"effort,omitempty"`
	Tokens       *float64 `json:"tokens,omitempty"`
	WindowTokens *float64 `json:"windowTokens,omitempty"`
	CtxPct       *float64 `json:"ctxPct,omitempty"`
	CtxLevel     string   `json:"ctxLevel,omitempty"`
	StartTime    *float64 `json:"startTime,omitempty"`
	// ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-15: 훅 활동과 작업 설명.
	State       string `json:"state,omitempty"`
	Tool        string `json:"tool,omitempty"`
	Detail      string `json:"detail,omitempty"`
	Description string `json:"description,omitempty"`
}

// cardSubagentsOf 는 statusLine 목록과 훅 활동을 합쳐 카드 원소로 바꾼다 (FR-SAU-13·14,
// ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-14·15). statusLine 원소는 startTime 순이고, startTime
// 이 없는 원소는 받은 순서로 그 뒤에 선다. statusLine 에 없는 활동은 맨 끝에 updatedAt 순이다.
// 비었으면 nil 이다.
func cardSubagentsOf(tasks []statusline.Subagent, acts map[string]subagentActivity, p run.ContextPolicy) []cardSubagent {
	if len(tasks) == 0 && len(acts) == 0 {
		return nil
	}
	out := make([]cardSubagent, 0, len(tasks)+len(acts))
	listed := map[string]bool{}
	for _, t := range tasks {
		c := cardSubagent{
			ID: deref(t.ID), AgentType: deref(t.AgentType), Status: deref(t.Status), Model: deref(t.Model),
			Effort: deref(t.Effort), Tokens: t.Tokens, WindowTokens: t.WindowTokens, StartTime: t.StartTime,
			Description: hub.SanitizeActivityField(deref(t.Description), hub.ActivityDetailMax),
		}
		listed[c.ID] = true
		c.State = activity.Done
		if c.Status == "running" {
			c.State = activity.Working
		}
		if a, ok := acts[c.ID]; ok {
			c.State, c.Tool, c.Detail = a.State, a.Tool, a.Detail
			if c.AgentType == "" {
				c.AgentType = a.AgentType
			}
		}
		if c.Effort == "" && t.EffortBudget != nil {
			c.Effort = strconv.FormatFloat(*t.EffortBudget, 'f', -1, 64)
		}
		if t.Tokens != nil && t.WindowTokens != nil && *t.WindowTokens > 0 {
			pct := *t.Tokens * 100 / *t.WindowTokens
			c.CtxPct = &pct
			c.CtxLevel = p.Grade(pct/100, 0)
		}
		out = append(out, c)
	}
	slices.SortStableFunc(out, func(a, b cardSubagent) int {
		switch {
		case a.StartTime == nil && b.StartTime == nil:
			return 0
		case a.StartTime == nil:
			return 1
		case b.StartTime == nil:
			return -1
		}
		return cmp.Compare(*a.StartTime, *b.StartTime)
	})
	var extra []cardSubagent
	var extraAt []time.Time
	for id, a := range acts {
		if listed[id] {
			continue
		}
		extra = append(extra, cardSubagent{ID: id, AgentType: a.AgentType, State: a.State, Tool: a.Tool, Detail: a.Detail})
		extraAt = append(extraAt, a.UpdatedAt)
	}
	idx := make([]int, len(extra))
	for i := range idx {
		idx[i] = i
	}
	slices.SortFunc(idx, func(i, j int) int {
		if c := extraAt[i].Compare(extraAt[j]); c != 0 {
			return c
		}
		return cmp.Compare(extra[i].ID, extra[j].ID)
	})
	for _, i := range idx {
		out = append(out, extra[i])
	}
	return out
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
