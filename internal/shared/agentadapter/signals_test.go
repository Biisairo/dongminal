package agentadapter

import "testing"

// AGENT_EVENT_ABSTRACTION_SRS 묶음 E — 선언과 구현의 대조 (V-AEV-7·8).
//
// **선언이 거짓말하면 알람이 조용히 사라진다.** codex 가 그 자리였다 — 턴 출처
// 이벤트가 없는데 규칙은 "사용자 턴이 아니었다" 로 읽어 영원히 침묵한다(§2.4).
// 그래서 `Signals` 는 주석이 아니라 **대조되는 값**이어야 한다 (FR-AEV-4).

// nativeEvents 는 그 에이전트의 **알려진 네이티브 이벤트 전부**다. 여기 없는
// 이벤트가 생기면 선언이 낡았다는 뜻이므로, 이 표를 늘리는 것이 곧 이 검사를
// 살아 있게 하는 일이다.
var nativeEvents = map[string][][]byte{
	"claude": {
		[]byte(`{"hook_event_name":"SessionStart"}`),
		[]byte(`{"hook_event_name":"UserPromptSubmit"}`),
		[]byte(`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}`),
		[]byte(`{"hook_event_name":"PostToolUse","tool_name":"Bash"}`),
		[]byte(`{"hook_event_name":"SubagentStop"}`),
		[]byte(`{"hook_event_name":"PreCompact"}`),
		[]byte(`{"hook_event_name":"Notification"}`),
		[]byte(`{"hook_event_name":"Stop"}`),
		[]byte(`{"hook_event_name":"SessionEnd"}`),
	},
	"omp": {
		[]byte(`{"event":"session_start"}`),
		[]byte(`{"event":"agent_start"}`),
		[]byte(`{"event":"turn_start"}`),
		[]byte(`{"event":"turn_end"}`),
		[]byte(`{"event":"tool_call","tool":"bash","detail":"ls"}`),
		[]byte(`{"event":"tool_result","tool":"bash"}`),
		[]byte(`{"event":"compaction"}`),
		[]byte(`{"event":"agent_end"}`),
		[]byte(`{"event":"session_shutdown"}`),
	},
	"codex": {
		[]byte(`{"type":"agent-turn-complete"}`),
	},
}

// observed 는 그 에이전트가 실제로 낸 것을 모은 선언이다.
func observed(t *testing.T, id string) Signals {
	t.Helper()
	a, err := Get(id)
	if err != nil {
		t.Fatalf("Get(%q): %v", id, err)
	}
	var got Signals
	for _, ev := range nativeEvents[id] {
		rep, ok := a.HookParse(ev)
		if !ok {
			t.Fatalf("%s: 알려진 이벤트를 파싱하지 못했다: %s", id, ev)
		}
		switch rep.State {
		case "idle":
			got.Idle = true
		case "working":
			got.Working = true
		case "waiting":
			got.Waiting = true
		case "done":
			got.Done = true
		case "ended":
			got.Ended = true
		default:
			t.Fatalf("%s: 어휘 밖의 상태 %q — %s", id, rep.State, ev)
		}
		if rep.UserPrompt {
			got.UserTurn = true
		}
		if rep.Compacted {
			got.Compaction = true
		}
		if rep.Tool != "" || rep.Detail != "" {
			got.ToolDetail = true
		}
	}
	return got
}

// V-AEV-7: 선언과 실제 산출이 일치한다.
//
// `Session`(sessionId/transcript)은 이 표의 픽스처가 싣지 않으므로 여기서 재지
// 않는다 — 그것은 훅 페이로드의 유무이지 파서의 산출이 아니다.
func TestSignalsMatchHookParse(t *testing.T) {
	for _, id := range IDs() {
		t.Run(id, func(t *testing.T) {
			a, err := Get(id)
			if err != nil {
				t.Fatal(err)
			}
			if len(nativeEvents[id]) == 0 {
				t.Fatalf("%s: 네이티브 이벤트 표가 비었다 — 새 에이전트를 더했으면 이 표도 더해라", id)
			}
			got := observed(t, id)
			w := a.Signals
			check := func(name string, want, have bool) {
				t.Helper()
				if want != have {
					t.Errorf("%s.%s: 선언=%v 실제=%v", id, name, want, have)
				}
			}
			check("Idle", w.Idle, got.Idle)
			check("Working", w.Working, got.Working)
			check("Waiting", w.Waiting, got.Waiting)
			check("Done", w.Done, got.Done)
			check("Ended", w.Ended, got.Ended)
			check("UserTurn", w.UserTurn, got.UserTurn)
			check("Compaction", w.Compaction, got.Compaction)
			check("ToolDetail", w.ToolDetail, got.ToolDetail)
		})
	}
}

// V-AEV-8: `Readiness.Hooks` 와 `Signals.Idle` 은 **같은 사실**이다 (FR-AEV-5).
// 한 사실을 두 이름으로 두면 한쪽만 고쳐지는 날이 온다.
func TestReadinessHooksMatchesIdleSignal(t *testing.T) {
	for _, id := range IDs() {
		a, err := Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if a.Readiness.Hooks != a.Signals.Idle {
			t.Errorf("%s: Readiness.Hooks=%v 인데 Signals.Idle=%v — 같은 사실이어야 한다",
				id, a.Readiness.Hooks, a.Signals.Idle)
		}
	}
}
