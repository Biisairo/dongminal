package hub

import "testing"

// AGENT_EVENT_ABSTRACTION_SRS V-AEV-10 — 데몬 모드의 알람 파생.
//
// 직접 모드(`toolhub.Tool`)와 **같은 항목을 같은 순서로** 잰다 (FR-AEV-14 ·
// NFR-4). 한쪽에만 있는 판정을 만들면 두 모드가 조용히 갈라진다.

func agentEventTracker() (*AttnTracker, *fakeBroker) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.SetBusyProbe(func(string) bool { return true })
	return tr, fb
}

// V-AEV-1 의 데몬 판: 사용자 턴에서 시작한 일이 끝나면 알람이 선다.
func TestTrackerAgentEvent_DoneRaisesAfterUserTurn(t *testing.T) {
	tr, _ := agentEventTracker()
	tr.NoteUserPrompt("1")
	tr.SetActivity("1", "working", "", "")
	tr.SignalAgentEvent("1", "done", true)
	if !tr.Attention("1") {
		t.Fatal("데몬 모드에서 done 이 알람이 되지 않았다 (FR-AEV-14)")
	}
}

// V-AEV-3 의 데몬 판: 사용자 턴이 아니었으면 조용하다 (FR-ATN-4 무변경).
func TestTrackerAgentEvent_DoneWithoutUserTurnIsSilent(t *testing.T) {
	tr, _ := agentEventTracker()
	tr.SetActivity("1", "working", "", "")
	tr.SignalAgentEvent("1", "done", true)
	if tr.Attention("1") {
		t.Fatal("사용자 턴이 아니었는데 알람이 섰다")
	}
}

// V-AEV-4 의 데몬 판: 턴 출처를 **말할 수 없는** 에이전트는 무조건 운다
// (FR-AEV-12). 모르는 것을 "아니다" 로 읽으면 영원히 침묵한다.
func TestTrackerAgentEvent_UnknownTurnOriginAlwaysRaises(t *testing.T) {
	tr, _ := agentEventTracker()
	tr.SignalAgentEvent("1", "done", false)
	if !tr.Attention("1") {
		t.Fatal("턴 출처를 모르는 에이전트의 done 이 조용하다 (FR-CBG-5)")
	}
}

// V-AEV-5 의 데몬 판: waiting 은 진행 중일 때만이고 되풀이는 한 번만 운다.
func TestTrackerAgentEvent_WaitingRulesUnchanged(t *testing.T) {
	tr, _ := agentEventTracker()
	tr.SignalAgentEvent("1", "waiting", true)
	if tr.Attention("1") {
		t.Fatal("턴이 진행 중이 아닌데 waiting 이 알람이 됐다 (FR-ATN-6)")
	}
	tr.SetActivity("1", "working", "", "")
	tr.SignalAgentEvent("1", "waiting", true)
	if !tr.Attention("1") {
		t.Fatal("권한 요청이 알람이 되지 않았다")
	}
	tr.Attend("1")
	tr.SignalAgentEvent("1", "waiting", true)
	if tr.Attention("1") {
		t.Fatal("같은 대기가 두 번 울었다 (FR-ATN-15)")
	}
}
