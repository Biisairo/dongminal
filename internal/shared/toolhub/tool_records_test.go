package toolhub

import (
	"encoding/json"
	"testing"

	"dongminal/internal/shared/activity"
)

// AGENT_RECORD_DAEMON_SRS FR-ARD-10 — 데몬 Tool 이 드는 에이전트 기록.

func TestTool_AgentStateRoundTrip(t *testing.T) {
	src := NewDetachedTool("a", nil)
	src.SetActivity(activity.Working, "Bash", "ls")
	src.NoteUserPrompt()
	src.SignalAttention(activity.Waiting)
	src.Attend()
	src.LastOutputAt.Store(42)

	st := src.AgentState()
	if st.Activity == nil || st.Activity.State != activity.Working || st.Activity.Tool != "Bash" {
		t.Fatalf("activity=%+v", st.Activity)
	}
	if !st.AgentSeen || !st.Turn.UserTurn || !st.Turn.InProgress || !st.Turn.WaitingSignaled {
		t.Fatalf("state=%+v", st)
	}
	if st.Attention || st.Armed || !st.RearmLocked || st.LastOutputAt != 42 {
		t.Fatalf("attention 필드=%+v", st)
	}

	dst := NewDetachedTool("b", nil)
	dst.LastOutputAt.Store(7)
	dst.RestoreAgentState(st)
	got := dst.AgentState()
	// 마지막 출력 시각은 데몬이 스스로 적는 값이다 — 쓰기로 바뀌지 않는다.
	want := st
	want.LastOutputAt = 7
	if a, b := mustJSON(t, got), mustJSON(t, want); a != b {
		t.Fatalf("복원\n got=%s\nwant=%s", a, b)
	}
	// 복원한 턴 표시가 판정에 쓰인다: 사용자 턴은 한 번 소비된다.
	if !dst.turn.AllowSignal(activity.Done) || dst.turn.AllowSignal(activity.Done) {
		t.Fatal("복원한 userTurn 이 판정에 쓰이지 않는다")
	}
}

func TestTool_RestoreAgentStateNoNotify(t *testing.T) {
	var calls int
	p := NewDetachedTool("a", &ToolHooks{
		OnAttention: func(string, string) { calls++ }, OnAttentionClear: func(string) { calls++ },
		OnActivity: func(string, string, string, string) { calls++ },
	})
	p.RestoreAgentState(AgentState{Attention: true, Activity: &ActivityState{State: activity.Done}})
	if calls != 0 {
		t.Fatalf("복원이 알림을 %d 번 불렀다", calls)
	}
	if !p.Attention() || p.Activity().State != activity.Done {
		t.Fatalf("복원되지 않았다: %+v", p.AgentState())
	}
}

func TestTool_RecordsSetDeleteCopy(t *testing.T) {
	p := NewDetachedTool("a", nil)
	if len(p.Records()) != 0 {
		t.Fatal("처음부터 기록이 있다")
	}
	p.SetRecord("usage", json.RawMessage(`{"x":1}`))
	p.SetRecord("subagents", json.RawMessage(`[1]`))
	p.SetRecord("subagents", nil)
	p.SetRecord("usage", json.RawMessage(`null`))
	p.SetRecord("migrationTold", json.RawMessage(`true`))
	r := p.Records()
	if len(r) != 1 || string(r["migrationTold"]) != "true" {
		t.Fatalf("records=%v", r)
	}
	r["migrationTold"] = json.RawMessage(`false`)
	if string(p.Records()["migrationTold"]) != "true" {
		t.Fatal("Records 가 사본이 아니다")
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
