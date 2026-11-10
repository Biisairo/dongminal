package hub

import (
	"bytes"
	"testing"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-33 — 데몬이 판정하면 추적기는 거울이다 (§3.3a).

func mirrorTracker(t *testing.T, judges *bool) (*AttnTracker, *fakeBroker, *changeLog) {
	t.Helper()
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 1000)
	tr.SetBusyProbe(func(ids []string) (map[string]bool, bool) {
		out := map[string]bool{}
		for _, id := range ids {
			out[id] = true
		}
		return out, true
	})
	var log changeLog
	tr.SetOnChange(log.on)
	tr.SetMirror(func() bool { return *judges })
	return tr, fb, &log
}

func (f *fakeBroker) has(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.sent {
		if bytes.Contains(p, []byte(sub)) {
			return true
		}
	}
	return false
}

// 출력은 마지막 출력 시각만 남긴다 — 알림 시퀀스로 판정하지 않고 데몬에 되쓰지도 않는다.
func TestMirror_OutputRecordsTimeOnly(t *testing.T) {
	judges := true
	tr, fb, log := mirrorTracker(t, &judges)
	tr.nowFn = func() int64 { return 77 }
	tr.FeedOutput("t1", []byte("\x1b]9;hi\x07"))
	if tr.Attention("t1") || fb.count() != 0 {
		t.Fatalf("거울이 출력으로 판정했다: attn=%v 방송=%d", tr.Attention("t1"), fb.count())
	}
	if tr.LastOutputAt("t1") != 77 {
		t.Fatalf("마지막 출력 시각=%d", tr.LastOutputAt("t1"))
	}
	if len(log.st) != 0 {
		t.Fatalf("거울이 데몬에 되썼다: %+v", log.st)
	}
}

func TestMirror_SweeperIdle(t *testing.T) {
	judges := true
	tr, fb, _ := mirrorTracker(t, &judges)
	tr.Restore("t1", toolhub.AgentState{AgentSeen: true, Armed: true, Activity: &toolhub.ActivityState{State: activity.Idle}, Turn: toolhub.TurnState{InProgress: true}})
	n := fb.count()
	tr.SweepIdleAt(int64(1e12))
	if tr.Attention("t1") || fb.count() != n {
		t.Fatal("거울의 스위퍼가 판정했다")
	}
	// 옛 데몬이면 같은 상태에서 종전처럼 운다.
	judges = false
	tr.SweepIdleAt(int64(1e12))
	if !tr.Attention("t1") {
		t.Fatal("옛 데몬인데 스위퍼가 판정하지 않았다")
	}
}

func TestMirror_ApplyAttnBroadcastsByKind(t *testing.T) {
	judges := true
	tr, fb, log := mirrorTracker(t, &judges)
	card := &toolhub.ActivityState{State: activity.Done, Tool: "Bash"}

	tr.ApplyAttn(toolipc.AttnEvent{Tool: "t1", Kind: toolipc.AttnKindActivity, Agent: toolhub.AgentState{Activity: card, AgentSeen: true}})
	if !fb.has(`"tool_activity"`) || tr.Activity("t1") == nil || tr.Activity("t1").Tool != "Bash" {
		t.Fatal("활동 push 가 거울·방송에 닿지 않았다")
	}
	// 카드가 같아도 방송한다 — 직접 모드의 onActivity 와 같다.
	n := fb.count()
	tr.ApplyAttn(toolipc.AttnEvent{Tool: "t1", Kind: toolipc.AttnKindActivity, Agent: toolhub.AgentState{Activity: card, AgentSeen: true}})
	if fb.count() != n+1 {
		t.Fatal("같은 카드의 활동 push 를 방송하지 않았다")
	}

	tr.ApplyAttn(toolipc.AttnEvent{Tool: "t1", Kind: toolipc.AttnKindAttention, Reason: activity.Done, Agent: toolhub.AgentState{Activity: card, Attention: true}})
	if !tr.Attention("t1") || !fb.has(`"reason":"done"`) {
		t.Fatal("알람 push 가 사유와 함께 방송되지 않았다")
	}
	tr.ApplyAttn(toolipc.AttnEvent{Tool: "t1", Kind: toolipc.AttnKindClear, Agent: toolhub.AgentState{Activity: card, RearmLocked: true}})
	if tr.Attention("t1") || !fb.has(`"tool_attention_clear"`) || !tr.AgentStateOf("t1").RearmLocked {
		t.Fatal("해제 push 가 거울·방송에 닿지 않았다")
	}
	if len(log.st) != 0 {
		t.Fatalf("push 반영이 데몬에 되썼다: %+v", log.st)
	}
}

// 거울은 데몬보다 늦게 출력을 볼 수 있다 — push 의 시각이 서버가 적은 것을 뒤로 돌리지 않는다.
func TestMirror_ApplyAttnKeepsNewerOutputTime(t *testing.T) {
	judges := true
	tr, _, _ := mirrorTracker(t, &judges)
	tr.nowFn = func() int64 { return 500 }
	tr.FeedOutput("t1", []byte("x"))
	tr.ApplyAttn(toolipc.AttnEvent{Tool: "t1", Kind: toolipc.AttnKindAttention, Agent: toolhub.AgentState{Attention: true, LastOutputAt: 100}})
	if tr.LastOutputAt("t1") != 500 {
		t.Fatalf("마지막 출력 시각=%d", tr.LastOutputAt("t1"))
	}
}

// 옛 데몬이면 거울이 아니다 — 종전처럼 판정하고 되쓴다.
func TestMirror_OldDaemonJudges(t *testing.T) {
	judges := false
	tr, fb, log := mirrorTracker(t, &judges)
	tr.FeedOutput("t1", []byte("\x1b]9;hi\x07"))
	if !tr.Attention("t1") || fb.count() == 0 || len(log.st["t1"]) == 0 {
		t.Fatal("옛 데몬인데 판정·되쓰기가 없다")
	}
}
