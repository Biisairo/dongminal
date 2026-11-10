package hub

import (
	"bytes"
	"testing"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
)

// AGENT_RECORD_DAEMON_SRS FR-ARD-11·13 — 추적기는 판정한 뒤의 상태를 알리고, 스냅샷을
// 알람 없이 반영한다.

type changeLog struct {
	st map[string][]toolhub.AgentState
}

func (c *changeLog) on(id string, st toolhub.AgentState) {
	if c.st == nil {
		c.st = map[string][]toolhub.AgentState{}
	}
	c.st[id] = append(c.st[id], st)
}

func (c *changeLog) last(t *testing.T, id string) toolhub.AgentState {
	t.Helper()
	s := c.st[id]
	if len(s) == 0 {
		t.Fatalf("%s 의 변화 알림이 없다", id)
	}
	return s[len(s)-1]
}

func TestAttnTracker_OnChangeCarriesJudgedState(t *testing.T) {
	tr := NewAttnTracker(&fakeBroker{}, 0)
	var log changeLog
	tr.SetOnChange(log.on)

	tr.SetActivity("t1", activity.Working, "Bash", "ls")
	if st := log.last(t, "t1"); st.Activity == nil || st.Activity.Tool != "Bash" || !st.AgentSeen || !st.Turn.InProgress {
		t.Fatalf("SetActivity 뒤=%+v", st)
	}
	tr.NoteUserPrompt("t1")
	if !log.last(t, "t1").Turn.UserTurn {
		t.Fatal("NoteUserPrompt 가 알리지 않았다")
	}
	tr.SignalAttention("t1", activity.Done)
	// 판정이 사용자 턴 표시를 소비한 뒤의 상태를 알린다.
	if st := log.last(t, "t1"); !st.Attention || st.Turn.UserTurn {
		t.Fatalf("done 판정 뒤=%+v", st)
	}
	tr.Attend("t1")
	if st := log.last(t, "t1"); st.Attention || !st.RearmLocked {
		t.Fatalf("Attend 뒤=%+v", st)
	}
	tr.AttendTyped("t1")
	if log.last(t, "t1").RearmLocked {
		t.Fatal("AttendTyped 가 알리지 않았다")
	}
	tr.SignalAgentEvent("t1", activity.Done, false)
	if !log.last(t, "t1").Attention {
		t.Fatal("SignalAgentEvent 가 알리지 않았다")
	}
	n := len(log.st["t1"])
	tr.ClearAllAttention()
	if len(log.st["t1"]) != n+1 || log.last(t, "t1").Attention {
		t.Fatalf("ClearAllAttention 뒤=%+v", log.st["t1"][len(log.st["t1"])-1])
	}
}

func TestAttnTracker_OnChangeFeedOutputOnlyOnSignal(t *testing.T) {
	tr := NewAttnTracker(&fakeBroker{}, 0)
	var log changeLog
	tr.SetOnChange(log.on)
	tr.FeedOutput("t1", []byte("plain"))
	if len(log.st["t1"]) != 0 {
		t.Fatalf("신호 없는 출력이 알렸다: %+v", log.st["t1"])
	}
	tr.FeedOutput("t1", []byte("\x1b]9;hi\x07"))
	if !log.last(t, "t1").Attention {
		t.Fatal("알림 시퀀스의 알람이 알리지 않았다")
	}
}

func TestAttnTracker_OnChangeSweepDisarm(t *testing.T) {
	tr := NewAttnTracker(&fakeBroker{}, 1000)
	var log changeLog
	tr.SetOnChange(log.on)
	tr.SetBusyProbe(func(ids []string) (map[string]bool, bool) { return map[string]bool{"t1": true}, true })
	tr.FeedOutput("t1", []byte("x"))
	tr.SweepIdleAt(tr.LastOutputAt("t1") + int64(2e9))
	if log.last(t, "t1").Armed {
		t.Fatal("유휴 판정이 무장을 내린 것을 알리지 않았다")
	}
}

func TestAttnTracker_RestoreAllSilent(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	var log changeLog
	tr.SetOnChange(log.on)
	tr.SetActivity("gone", activity.Working, "", "")
	tr.SetActivity("same", activity.Waiting, "", "")
	before := fb.count()

	tr.RestoreAll(map[string]toolhub.AgentState{
		"t1": {Activity: &toolhub.ActivityState{State: activity.Working, Tool: "Bash", UpdatedAt: 9}, AgentSeen: true,
			Attention: true, LastOutputAt: 77, Turn: toolhub.TurnState{UserTurn: true, InProgress: true}},
		"same": {Activity: &toolhub.ActivityState{State: activity.Waiting}, AgentSeen: true},
	})

	if !tr.Attention("t1") || tr.LastOutputAt("t1") != 77 || tr.Activity("t1").Tool != "Bash" {
		t.Fatalf("t1 이 복원되지 않았다: %+v", tr.AgentStateOf("t1"))
	}
	if tr.Activity("gone") != nil {
		t.Fatal("스냅샷에 없는 도구가 남았다")
	}
	var acts []string
	for _, p := range fb.sent[before:] {
		if bytes.Contains(p, []byte(`"action":"tool_attention"`)) {
			t.Fatalf("반영이 알람을 방송했다: %s", p)
		}
		if bytes.Contains(p, []byte(`"action":"tool_activity"`)) {
			acts = append(acts, string(p))
		}
	}
	// 바뀐 카드만: t1(새로 생김)과 gone(사라짐). same 은 그대로다.
	if len(acts) != 2 {
		t.Fatalf("활동 방송=%v", acts)
	}
	if len(log.st) != 2 || len(log.st["t1"]) != 0 {
		t.Fatalf("반영이 데몬 쓰기를 일으켰다: %+v", log.st)
	}
	// 복원한 턴 표시로 판정한다: 사용자 턴의 done 은 한 번 운다.
	tr.SignalAttention("t1", activity.Done)
	if !log.last(t, "t1").Attention || log.last(t, "t1").Turn.UserTurn {
		t.Fatalf("복원한 턴 표시가 판정에 쓰이지 않았다: %+v", log.last(t, "t1"))
	}
}

func TestAttnTracker_RestoreOne(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.SetActivity("other", activity.Working, "", "")
	tr.Restore("t1", toolhub.AgentState{Activity: &toolhub.ActivityState{State: activity.Done}, AgentSeen: true})
	if tr.Activity("t1") == nil || tr.Activity("other") == nil {
		t.Fatal("하나만 반영해야 한다")
	}
}
