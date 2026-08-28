package httpapi

import (
	"encoding/json"
	"net/http"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
)

// 주의(attention)·활동(activity)·배경(background) 종단. 셋은 직교하는 레이어지만
// 모두 "도구가 지금 어떤 상태인가"를 브라우저에 알리는 같은 목적이고, AttnTracker
// 라는 같은 상태를 읽는다.

// apiToolsAttention returns the ids of tools currently needing attention, so a
// late-joining / reconnecting client can restore highlights (FR-PAN-8).
func (s *Server) apiToolsAttention(w http.ResponseWriter, r *http.Request) {
	ids := []string{}
	if s.AttnTracker != nil {
		ids = s.AttnTracker.AttentionIDs()
	} else if al, ok := s.Tools.(interface{ AttentionIDs() []string }); ok {
		if got := al.AttentionIDs(); got != nil {
			ids = got
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"toolIds": ids})
}

// apiToolAttentionSet flags a tool as needing attention. Used by `dmctl notify`
// (agent hook bridge) which identifies its tool via DONGMINAL_TOOL_ID — this
// works from detached hooks that have no controlling terminal. Body:
// {"toolId":"...","reason":"done|waiting|..."}. Unknown tool is a 200 no-op;
// missing toolId is 400.
func (s *Server) apiToolAttentionSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ToolID string `json:"toolId"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ToolID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	reason := req.Reason
	if reason == "" {
		reason = "signaled"
	}
	if s.Tools != nil {
		if s.AttnTracker != nil {
			// Verify tool exists before flagging attention
			if s.Tools.Get(req.ToolID) != nil {
				s.AttnTracker.SignalAttention(req.ToolID, reason)
			}
		} else if tool := s.Tools.Get(req.ToolID); tool != nil {
			tool.SignalAttention(reason)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// apiToolAttentionClear clears a tool's attention (and broadcasts the clear)
// when the user focuses/opens it. Body: {"toolId":"..."}. Unknown/idle tool is
// a no-op (200) so a stale focus event never errors.
func (s *Server) apiToolAttentionClear(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ToolID string `json:"toolId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ToolID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if s.Tools != nil {
		if s.AttnTracker != nil {
			s.AttnTracker.Attend(req.ToolID)
		} else if tool := s.Tools.Get(req.ToolID); tool != nil {
			tool.Attend()
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// apiToolAttentionClearAll dismisses every tool's attention at once (FR-PAN-17).
func (s *Server) apiToolAttentionClearAll(w http.ResponseWriter, r *http.Request) {
	cleared := 0
	if s.AttnTracker != nil {
		cleared = s.AttnTracker.ClearAllAttention()
	} else if ca, ok := s.Tools.(interface{ ClearAllAttention() int }); ok {
		cleared = ca.ClearAllAttention()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"cleared": cleared})
}

// apiToolsActivity returns the current activity snapshot of every tool that has
// reported one, so a late-joining / reconnecting client can restore cards
// (FR-AAP-4).
func (s *Server) apiToolsActivity(w http.ResponseWriter, r *http.Request) {
	acts := []toolhub.ActivitySnap{}
	if s.AttnTracker != nil {
		acts = s.AttnTracker.ActivitySnapshot()
	} else if al, ok := s.Tools.(interface{ ActivitySnapshot() []toolhub.ActivitySnap }); ok {
		if got := al.ActivitySnapshot(); got != nil {
			acts = got
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"activities": acts})
}

// apiToolActivitySet records what an agent in a tool is currently doing. Used by
// `dmctl activity` (agent hook bridge), identified via DONGMINAL_TOOL_ID. Body:
// {"toolId":"...","state":"working|done|waiting|idle","tool":"...","detail":"..."}.
// Unknown tool is a 200 no-op; missing toolId or invalid state is 400 (FR-AAP-3).
func (s *Server) apiToolActivitySet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ToolID string `json:"toolId"`
		State  string `json:"state"`
		Tool   string `json:"tool"`
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ToolID == "" || !hub.ValidActivityState(req.State) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if s.Tools != nil {
		if s.AttnTracker != nil {
			s.AttnTracker.SetActivity(req.ToolID, req.State,
				hub.SanitizeActivityField(req.Tool, hub.ActivityToolMax),
				hub.SanitizeActivityField(req.Detail, hub.ActivityDetailMax))
		} else if tool := s.Tools.Get(req.ToolID); tool != nil {
			tool.SetActivity(req.State, hub.SanitizeActivityField(req.Tool, hub.ActivityToolMax), hub.SanitizeActivityField(req.Detail, hub.ActivityDetailMax))
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// backgroundRow is a background tool plus its Run membership, when it has one
// (FR-HLM-9). 필드를 더하기만 하므로 기존 소비자(detach --list, ⏻ 모달)는 그대로
// 동작한다.
//
// 헤드리스 멤버는 ⏻ 목록에 **함께** 나타난다 (FR-HLM-2). 그러면 사용자에게는
// "떼어 둔 내 도구"와 "Run 이 만든 팀원"이 한 목록에 섞이므로, 어느 쪽인지 말해
// 주지 않으면 구분할 수 없다 — 그것이 이 세 필드다.
type backgroundRow struct {
	toolhub.BackgroundEntry
	RunID    string `json:"runId,omitempty"`
	MemberID string `json:"memberId,omitempty"`
	Role     string `json:"role,omitempty"`
}

// apiToolsBackground lists the tools currently sent to the background,
// oldest transition first (FR-BG-6).
func (s *Server) apiToolsBackground(w http.ResponseWriter, r *http.Request) {
	list := []toolhub.BackgroundEntry{}
	if s.Tools != nil {
		if got := s.Tools.BackgroundList(); got != nil {
			list = got
		}
	}
	rows := make([]backgroundRow, 0, len(list))
	for _, e := range list {
		row := backgroundRow{BackgroundEntry: e}
		// 열린 Run 의 멤버만 표시한다 — 끝난 Run 의 도구는 더 이상 그 Run 의
		// 것이 아니고(store.findByTool), 그쪽은 run status 의 고아 목록이 맡는다
		// (FR-HLM-5).
		if s.Runs != nil {
			if m, ok := s.Runs.MemberByTool(e.ToolID); ok {
				row.RunID, row.MemberID, row.Role = m.RunID, m.ID, m.Role
			}
		}
		rows = append(rows, row)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"background": rows})
}

// apiToolBackgroundSet detaches a tool from its tab or restores it.
// Body: {"toolId":"...","background":true|false} (FR-BG-2/4/7).
// An unknown tool is a 404 — the caller asked about something that is gone,
// and silently succeeding would hide a stale id.
func (s *Server) apiToolBackgroundSet(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID     string `json:"toolId"`
		Background bool   `json:"background"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ToolID == "" {
		http.Error(w, "toolId 필요", http.StatusBadRequest)
		return
	}
	if s.Tools == nil || !s.Tools.SetBackground(body.ToolID, body.Background) {
		http.Error(w, "toolId="+body.ToolID+" 존재하지 않음", http.StatusNotFound)
		return
	}
	if !body.Background {
		s.reconcileMemberTab(body.ToolID)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
