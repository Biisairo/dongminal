package httpapi

import (
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
)

// attentionService 는 attention/activity 종단이 부르는 상태의 자리다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-9-3 · HTTP-13). 관측은 이 프로세스의 hub.AttnTracker 가
// 갖는다(PTY 는 dongminald 에 있다).
//
// 추적기가 배선되지 않았으면 신호·해제·보고는 무동작이다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-12 —
// 도구 자신이 상태를 갖던 직접 모드 서비스는 없다).
type attentionService interface {
	// AttentionIDs 는 주의가 선 도구들이다.
	AttentionIDs() []string
	// SignalAttention 은 주의를 세운다. 모르는 도구에는 무동작이다.
	SignalAttention(toolID, reason string)
	// Attend 는 사용자의 주목이다. typed 는 키를 눌렀는가다 (FR-ATA-9).
	Attend(toolID string, typed bool)
	ClearAllAttention() int
	ActivitySnapshot() []toolhub.ActivitySnap
	// ReportActivity 는 활동 보고 하나다 — 활동·파생 알람 (FR-AEV-10).
	ReportActivity(toolID, state, tool, detail string, turnKnown bool)
	Activity(toolID string) *toolhub.ActivityState
	// LastOutputAt 은 마지막 출력 시각(unix ns)이다. 없으면 0.
	LastOutputAt(toolID string) int64
	// Forget 은 지운 도구의 상태를 버린다.
	Forget(toolID string)
}

func (s *Server) attention() attentionService {
	if s.AttnTracker != nil {
		return trackerAttention{t: s.AttnTracker, tools: s.Tools, d: s.AttnDaemon}
	}
	return noAttention{}
}

// trackerAttention 은 데몬 모드다. 데몬이 판정하면(§3.3a) 추적기는 거울이다 — 보고는
// 이미 판정된 report push 로만 여기 오므로 판정하지 않고, 해제는 데몬에 보낸다.
type trackerAttention struct {
	t     *hub.AttnTracker
	tools toolhub.ToolHub
	d     AttentionDaemon
}

func (a trackerAttention) judges() bool { return a.d != nil && a.d.Judges() }

func (a trackerAttention) AttentionIDs() []string { return a.t.AttentionIDs() }

func (a trackerAttention) SignalAttention(toolID, reason string) {
	if a.judges() {
		return
	}
	// 추적기는 모르는 도구에도 상태를 만든다 — 그래서 존재를 먼저 본다.
	if a.tools != nil && a.tools.Get(toolID) != nil {
		a.t.SignalAttention(toolID, reason)
	}
}

func (a trackerAttention) Attend(toolID string, typed bool) {
	if a.tools == nil {
		return
	}
	if a.judges() {
		if err := a.d.Attend(toolID, typed); err != nil {
			dmlog.Warnf(nil, "attention: 해제를 데몬에 보내지 못했다 tool=%s: %v", toolID, err)
		}
		return
	}
	if typed {
		a.t.AttendTyped(toolID)
	} else {
		a.t.Attend(toolID)
	}
}

func (a trackerAttention) ClearAllAttention() int {
	if !a.judges() {
		return a.t.ClearAllAttention()
	}
	n, err := a.d.AttendAll()
	if err != nil {
		dmlog.Warnf(nil, "attention: 전부 해제를 데몬에 보내지 못했다: %v", err)
	}
	return n
}

func (a trackerAttention) ActivitySnapshot() []toolhub.ActivitySnap { return a.t.ActivitySnapshot() }

func (a trackerAttention) ReportActivity(toolID, state, tool, detail string, turnKnown bool) {
	if a.tools == nil || a.judges() {
		return
	}
	a.t.SetActivity(toolID, state, tool, detail)
	if activity.Alarms(state) {
		a.t.SignalAgentEvent(toolID, state, turnKnown)
	}
}

func (a trackerAttention) Activity(toolID string) *toolhub.ActivityState { return a.t.Activity(toolID) }

func (a trackerAttention) LastOutputAt(toolID string) int64 { return a.t.LastOutputAt(toolID) }

// Forget: 데몬 모드에서 이미 죽어 있던 도구를 지우는 경로에는 OnExit 가 오지 않는다 (FR-ATL-5).
func (a trackerAttention) Forget(toolID string) { a.t.Forget(toolID) }

// noAttention 은 추적기가 없는 서버의 서비스다. 아무것도 갖지 않는다.
type noAttention struct{}

func (noAttention) AttentionIDs() []string                              { return []string{} }
func (noAttention) SignalAttention(string, string)                      {}
func (noAttention) Attend(string, bool)                                 {}
func (noAttention) ClearAllAttention() int                              { return 0 }
func (noAttention) ActivitySnapshot() []toolhub.ActivitySnap            { return []toolhub.ActivitySnap{} }
func (noAttention) ReportActivity(string, string, string, string, bool) {}
func (noAttention) Activity(string) *toolhub.ActivityState              { return nil }
func (noAttention) LastOutputAt(string) int64                           { return 0 }
func (noAttention) Forget(string)                                       {}
