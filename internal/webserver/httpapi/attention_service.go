package httpapi

import (
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
)

// attentionService 는 attention/activity 종단이 부르는 상태의 자리다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-9-3 · HTTP-13). 데몬 모드는 관측을 이 프로세스의
// hub.AttnTracker 가 갖고(PTY 는 dongminald 에 있다), 직접 모드는 toolhub.Tool 이
// 스스로 갖는다. 모드는 attention() 한 자리에서만 가른다 — 종단마다 두 갈래를 두면
// 새 신호를 더할 때 한쪽만 고쳐진다.
//
// 도구 허브가 없으면 신호·해제·보고는 무동작이다 (종전 동작).
type attentionService interface {
	// AttentionIDs 는 주의가 선 도구들이다.
	AttentionIDs() []string
	// SignalAttention 은 주의를 세운다. 모르는 도구에는 무동작이다.
	SignalAttention(toolID, reason string)
	// Attend 는 사용자의 주목이다. typed 는 키를 눌렀는가다 (FR-ATA-9).
	Attend(toolID string, typed bool)
	ClearAllAttention() int
	ActivitySnapshot() []toolhub.ActivitySnap
	// ReportActivity 는 활동 보고 하나다 — 턴 표시·활동·파생 알람 (FR-ATN-1 · FR-AEV-10).
	ReportActivity(toolID, state, tool, detail string, userPrompt, turnKnown bool)
	Activity(toolID string) *toolhub.ActivityState
	// LastOutputAt 은 마지막 출력 시각(unix ns)이다. 없으면 0.
	LastOutputAt(toolID string) int64
	// Forget 은 지운 도구의 상태를 버린다.
	Forget(toolID string)
}

func (s *Server) attention() attentionService {
	if s.AttnTracker != nil {
		return trackerAttention{t: s.AttnTracker, tools: s.Tools}
	}
	return directAttention{tools: s.Tools}
}

// alarmState 는 활동 보고에서 알람을 파생할 상태다 (FR-AEV-10).
func alarmState(state string) bool { return state == activity.Done || state == activity.Waiting }

// trackerAttention 은 데몬 모드다.
type trackerAttention struct {
	t     *hub.AttnTracker
	tools toolhub.ToolHub
}

func (a trackerAttention) AttentionIDs() []string { return a.t.AttentionIDs() }

func (a trackerAttention) SignalAttention(toolID, reason string) {
	// 추적기는 모르는 도구에도 상태를 만든다 — 그래서 존재를 먼저 본다.
	if a.tools != nil && a.tools.Get(toolID) != nil {
		a.t.SignalAttention(toolID, reason)
	}
}

func (a trackerAttention) Attend(toolID string, typed bool) {
	if a.tools == nil {
		return
	}
	if typed {
		a.t.AttendTyped(toolID)
	} else {
		a.t.Attend(toolID)
	}
}

func (a trackerAttention) ClearAllAttention() int { return a.t.ClearAllAttention() }

func (a trackerAttention) ActivitySnapshot() []toolhub.ActivitySnap { return a.t.ActivitySnapshot() }

func (a trackerAttention) ReportActivity(toolID, state, tool, detail string, userPrompt, turnKnown bool) {
	if a.tools == nil {
		return
	}
	// FR-ATN-1: 표시를 먼저 세운다. 활동 보고와 별도 경로인 것은 둘이
	// 다른 것을 말하기 때문이다 — 활동은 "지금 무엇을 하는가", 이것은
	// "이 턴이 왜 시작되었는가" 다.
	if userPrompt {
		a.t.NoteUserPrompt(toolID)
	}
	a.t.SetActivity(toolID, state, tool, detail)
	if alarmState(state) {
		a.t.SignalAgentEvent(toolID, state, turnKnown)
	}
}

func (a trackerAttention) Activity(toolID string) *toolhub.ActivityState { return a.t.Activity(toolID) }

func (a trackerAttention) LastOutputAt(toolID string) int64 { return a.t.LastOutputAt(toolID) }

// Forget: 데몬 모드에서 이미 죽어 있던 도구를 지우는 경로에는 OnExit 가 오지 않는다 (FR-ATL-5).
func (a trackerAttention) Forget(toolID string) { a.t.Forget(toolID) }

// directAttention 은 직접 모드다 — 상태는 도구 자신에 있다.
type directAttention struct {
	tools toolhub.ToolHub
}

func (a directAttention) tool(toolID string) *toolhub.Tool {
	if a.tools == nil {
		return nil
	}
	return a.tools.Get(toolID)
}

func (a directAttention) AttentionIDs() []string {
	if al, ok := a.tools.(interface{ AttentionIDs() []string }); ok {
		if got := al.AttentionIDs(); got != nil {
			return got
		}
	}
	return []string{}
}

func (a directAttention) SignalAttention(toolID, reason string) {
	if t := a.tool(toolID); t != nil {
		t.SignalAttention(reason)
	}
}

func (a directAttention) Attend(toolID string, typed bool) {
	t := a.tool(toolID)
	switch {
	case t == nil:
	case typed:
		t.AttendTyped()
	default:
		t.Attend()
	}
}

func (a directAttention) ClearAllAttention() int {
	if ca, ok := a.tools.(interface{ ClearAllAttention() int }); ok {
		return ca.ClearAllAttention()
	}
	return 0
}

func (a directAttention) ActivitySnapshot() []toolhub.ActivitySnap {
	if al, ok := a.tools.(interface{ ActivitySnapshot() []toolhub.ActivitySnap }); ok {
		if got := al.ActivitySnapshot(); got != nil {
			return got
		}
	}
	return []toolhub.ActivitySnap{}
}

func (a directAttention) ReportActivity(toolID, state, tool, detail string, userPrompt, turnKnown bool) {
	t := a.tool(toolID)
	if t == nil {
		return
	}
	if userPrompt {
		t.NoteUserPrompt()
	}
	t.SetActivity(state, tool, detail)
	if alarmState(state) {
		t.SignalAgentEvent(state, turnKnown)
	}
}

func (a directAttention) Activity(toolID string) *toolhub.ActivityState {
	if t := a.tool(toolID); t != nil {
		return t.Activity()
	}
	return nil
}

func (a directAttention) LastOutputAt(toolID string) int64 {
	if t := a.tool(toolID); t != nil {
		return t.LastOutputAt.Load()
	}
	return 0
}

// Forget: 직접 모드는 Delete → kill() 이 이미 해제한다.
func (directAttention) Forget(string) {}
