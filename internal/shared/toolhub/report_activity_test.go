package toolhub

import (
	"testing"

	"dongminal/internal/shared/activity"
)

// AGENT_RECORD_DAEMON_SRS §3.2a — main 활동 반영은 한 함수다. 직접 모드와 데몬이 함께 쓴다.

func TestReportActivity_UserTurnDoneRaisesAttention(t *testing.T) {
	var fired []string
	p := NewDetachedTool("r1", &ToolHooks{OnAttention: func(_, reason string) { fired = append(fired, reason) }})
	p.ReportActivity(activity.Working, "Bash", "ls", true)
	if a := p.Activity(); a == nil || a.State != activity.Working || a.Tool != "Bash" {
		t.Fatalf("활동 = %+v", a)
	}
	p.ReportActivity(activity.Done, "", "", true)
	if !p.Attention() || len(fired) != 1 || fired[0] != activity.Done {
		t.Fatalf("done 알람: attention=%v fired=%v", p.Attention(), fired)
	}
}

func TestReportActivity_WorkingDoesNotAlarm(t *testing.T) {
	p := NewDetachedTool("r2", nil)
	p.ReportActivity(activity.Working, "", "", true)
	if p.Attention() {
		t.Fatal("working 이 알람을 세웠다")
	}
	if !p.AgentState().AgentSeen {
		t.Fatal("agentSeen 이 서지 않았다")
	}
}

func TestReportActivity_EndedDropsCard(t *testing.T) {
	p := NewDetachedTool("r3", nil)
	p.ReportActivity(activity.Working, "", "", true)
	p.ReportActivity(activity.Ended, "", "", true)
	if p.Activity() != nil || p.AgentState().AgentSeen {
		t.Fatal("ended 뒤에도 카드나 agentSeen 이 남았다")
	}
}

// startTurn 은 턴이 시작되었다는 보고(`working`)만 판정에 반영한다. 활동 카드와
// 에이전트 표시는 건드리지 않는다.
func startTurn(p *Tool) { p.turn.NoteActivity(activity.Working) }
