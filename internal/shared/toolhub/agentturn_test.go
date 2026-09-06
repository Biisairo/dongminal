package toolhub

import "testing"

// ATTENTION_FIRING_SRS 묶음 N 의 판정 단위. 여기서 재는 것은 **무엇을 새 사건으로
// 볼 것인가** 이며, 두 모드가 이 한 벌을 공유한다 (FR-ATN-14).

// V-ATN-4: 진행 표시를 세우는 것은 활동 상태 `working` 이고, 사용자 턴 표시를
// 세우는 것은 `UserPromptSubmit` 뿐이다. 둘은 다른 물음이다 — `PreToolUse` 도
// `working` 을 보고하지만 턴의 출처를 말하지 않는다 (FR-ATN-3).
func TestAgentTurn_UserPromptIsTheOnlySourceMark(t *testing.T) {
	var turn AgentTurn

	turn.NoteActivity("working") // PreToolUse
	if !turn.InProgress() {
		t.Fatalf("working 이 진행 표시를 세우지 않았다")
	}
	if turn.AllowSignal("done") {
		t.Fatalf("사용자 프롬프트 없이 done 이 알람이 되었다")
	}

	turn.NoteUserPrompt()
	if !turn.AllowSignal("done") {
		t.Fatalf("사용자 프롬프트 뒤의 done 이 알람이 되지 않았다")
	}
}

// V-ATN-3: 사용자 턴 표시는 **소비된다.** 한 번의 프롬프트가 낳는 done 알람은
// 한 번뿐이고, 이어지는 배경 턴들의 done 은 조용하다 (FR-ATN-1·4).
func TestAgentTurn_UserTurnMarkIsConsumedOnce(t *testing.T) {
	var turn AgentTurn
	turn.NoteUserPrompt()

	if !turn.AllowSignal("done") {
		t.Fatalf("첫 done 이 알람이 되지 않았다")
	}
	for i := range 3 {
		if turn.AllowSignal("done") {
			t.Fatalf("배경 턴 %d 의 done 이 알람이 되었다", i)
		}
	}
}

// V-ATN-5·6·7: `waiting` 은 진행 중일 때만 알람이다. 그때가 권한 요청이고,
// 그 밖은 입력 유휴다 (FR-ATN-6, AS-3).
func TestAgentTurn_WaitingFiresOnlyWhileInProgress(t *testing.T) {
	var turn AgentTurn

	// 한 번도 일을 시작하지 않았다 → 유휴다.
	if turn.AllowSignal("waiting") {
		t.Fatalf("일을 시작한 적 없는 도구의 waiting 이 알람이 되었다")
	}

	// 일하는 중 → 권한 요청이다.
	turn.NoteActivity("working")
	if !turn.AllowSignal("waiting") {
		t.Fatalf("진행 중의 waiting 이 알람이 되지 않았다")
	}

	// 끝났다고 보고한 뒤 → 유휴다.
	turn.NoteActivity("done")
	if turn.AllowSignal("waiting") {
		t.Fatalf("종결 뒤의 waiting 이 알람이 되었다")
	}
}

// V-ATN-8: `waiting`·`idle` 보고는 진행 표시를 건드리지 않는다. `Notification`
// 훅에는 notify 와 activity 가 함께 걸려 있어 도착 순서가 보장되지 않으므로,
// 판정의 재료가 판정 대상과 같은 훅에서 오면 안 된다 (FR-ATN-8).
func TestAgentTurn_WaitingAndIdleReportsDoNotMoveTheMark(t *testing.T) {
	var turn AgentTurn
	turn.NoteActivity("working")

	for _, state := range []string{"waiting", "idle"} {
		turn.NoteActivity(state)
		if !turn.InProgress() {
			t.Fatalf("%q 보고가 진행 표시를 내렸다", state)
		}
	}

	turn.NoteActivity("done")
	for _, state := range []string{"waiting", "idle"} {
		turn.NoteActivity(state)
		if turn.InProgress() {
			t.Fatalf("%q 보고가 진행 표시를 세웠다", state)
		}
	}
}

// V-ATN-11: 판정을 받는 것은 훅 배선이 실제로 쓰는 두 라벨뿐이다. 그 밖의
// 라벨은 누가 보냈든 알람이다 (FR-ATN-12 / FR-ATF-4).
func TestAgentTurn_OtherLabelsBypassTheGate(t *testing.T) {
	var turn AgentTurn // 아무것도 보고하지 않은 상태 — 두 표시 모두 없다

	for _, reason := range []string{"signaled", "codex", "attention", ""} {
		if !turn.AllowSignal(reason) {
			t.Fatalf("라벨 %q 가 판정에 걸렸다", reason)
		}
	}
}

// V-ATN-12: `ended` 는 두 표시를 함께 버린다. 에이전트가 끝난 뒤 같은 도구에
// 남은 표시가 다음 세션의 판정을 흔들면 안 된다 (FR-ATN-5).
func TestAgentTurn_EndedDropsBothMarks(t *testing.T) {
	var turn AgentTurn
	turn.NoteUserPrompt()
	turn.NoteActivity("working")

	turn.NoteActivity("ended")

	if turn.InProgress() {
		t.Fatalf("ended 뒤에도 진행 표시가 남았다")
	}
	if turn.AllowSignal("done") {
		t.Fatalf("ended 뒤에도 사용자 턴 표시가 남았다")
	}
}
