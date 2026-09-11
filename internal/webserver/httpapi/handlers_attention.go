package httpapi

import (
	"encoding/json"
	"net/http"

	"dongminal/internal/shared/agentadapter"
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
// when the user actually touches it. Body: {"toolId":"...","typed":bool}.
// Unknown/idle tool is a no-op (200) so a stale event never errors.
//
// `typed` 는 사용자가 그 도구에 **키를 눌렀는가** 다 (ATTENTION_FIRING_SRS
// FR-ATA-9). 보기만 한 해제는 재무장을 잠그고, 키를 누른 해제는 잠금을 푼다 —
// 일을 시켰으면 그 결과를 다시 기다리게 되기 때문이다. 없으면 거짓, 즉 "보기만
// 했다" 로 읽는다.
func (s *Server) apiToolAttentionClear(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ToolID string `json:"toolId"`
		Typed  bool   `json:"typed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ToolID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if s.Tools != nil {
		if s.AttnTracker != nil {
			if req.Typed {
				s.AttnTracker.AttendTyped(req.ToolID)
			} else {
				s.AttnTracker.Attend(req.ToolID)
			}
		} else if tool := s.Tools.Get(req.ToolID); tool != nil {
			if req.Typed {
				tool.AttendTyped()
			} else {
				tool.Attend()
			}
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

// agentReportsUserTurn 은 그 에이전트가 **턴의 출처를 말할 수 있는지**다
// (FR-AEV-12). 선언을 읽을 뿐 추측하지 않는다.
//
// 모르는 id 에는 **참**을 준다 — 종전 판정 그대로 간다는 뜻이다. 거짓을 주면
// 알 수 없는 보고자의 모든 `done` 이 무조건 알람이 되고, 그것은 이 문서가
// 고치려는 것과 반대 방향의 소음이다.
func agentReportsUserTurn(id string) bool {
	if id == "" {
		return true
	}
	a, err := agentadapter.Get(id)
	if err != nil {
		return true
	}
	return a.Signals.UserTurn
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
		// UserPrompt 는 이 턴이 사용자 프롬프트에서 시작되었다는 곁들이 값이다
		// (FR-ATN-2). 활동 상태 어휘는 이것으로 바뀌지 않는다.
		UserPrompt bool `json:"userPrompt"`
		// Agent 는 보고한 에이전트의 id 다 (AGENT_EVENT_ABSTRACTION_SRS
		// FR-AEV-10). 서버가 그 에이전트의 **이벤트 선언**(`Signals`)을 봐야
		// `done` 알람의 판정을 옳게 할 수 있다 (FR-AEV-12).
		//
		// 비어 있으면 **종전 판정 그대로** 간다 — 알 수 없는 보고자에게 알람을
		// 지어내지 않는다.
		Agent string `json:"agent"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ToolID == "" || !hub.ValidActivityState(req.State) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if s.Tools != nil {
		// FR-AEV-10: **알람은 활동 이벤트에서 파생한다.** 에이전트마다 `dmctl
		// notify` 를 따로 배선하지 않는다 — 그 배선이 없던 omp 는 상태만 바뀌고
		// 알람이 울리지 않았다 (SRS §2.1).
		//
		// 파생의 자리가 서버인 이유는 D-1 이다: `dmctl` 이 한 번 더 POST 하면
		// 왕복이 늘고 **두 요청의 순서가 다시 문제가 된다.** 한 요청 안에서는
		// 순서가 확정되고, 직접·데몬 두 모드가 같은 자리를 지난다 (FR-AEV-14).
		alarm := req.State == "done" || req.State == "waiting"
		turnKnown := agentReportsUserTurn(req.Agent)
		if s.AttnTracker != nil {
			// FR-ATN-1: 표시를 먼저 세운다. 활동 보고와 별도 경로인 것은 둘이
			// 다른 것을 말하기 때문이다 — 활동은 "지금 무엇을 하는가", 이것은
			// "이 턴이 왜 시작되었는가" 다.
			if req.UserPrompt {
				s.AttnTracker.NoteUserPrompt(req.ToolID)
			}
			s.AttnTracker.SetActivity(req.ToolID, req.State,
				hub.SanitizeActivityField(req.Tool, hub.ActivityToolMax),
				hub.SanitizeActivityField(req.Detail, hub.ActivityDetailMax))
			if alarm {
				s.AttnTracker.SignalAgentEvent(req.ToolID, req.State, turnKnown)
			}
		} else if tool := s.Tools.Get(req.ToolID); tool != nil {
			if req.UserPrompt {
				tool.NoteUserPrompt()
			}
			tool.SetActivity(req.State, hub.SanitizeActivityField(req.Tool, hub.ActivityToolMax), hub.SanitizeActivityField(req.Detail, hub.ActivityDetailMax))
			if alarm {
				tool.SignalAgentEvent(req.State, turnKnown)
			}
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
	/**
	 * UX_BATCH6_SRS FR-BGP-2: 목록이 바뀌었음을 **모든 구독자에게** 알린다.
	 *
	 *   이전 동작: 아무것도 알리지 않았다. 이 요청을 보낸 브라우저만 자기
	 *             `_bgRefresh` 로 배지를 고쳤다
	 *   새  동작: `tools_background_changed` 를 방송한다 (FR-BGV-1 이 이미 정의한
	 *             그 사건이며, 종전에는 헤드리스 생성 한 곳만 냈다)
	 *   이유:     접수 ⑮ — "background 버튼에 있는 갯수가 다른 브라우저에서
	 *             갱신되는 경우 갱신되지 않는다". 다른 브라우저는 SSE 재연결
	 *             전까지 낡은 수를 보인다
	 *
	 * 이 자리인 이유는 **두 모드가 공유하는 유일한 자리**이기 때문이다. 데몬
	 * 모드에서 `SetBackground` 는 웹서버가 아니라 데몬 프로세스에서 돌아 알릴
	 * 구독자가 없다.
	 */
	s.broadcastLayout("tools_background_changed", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
