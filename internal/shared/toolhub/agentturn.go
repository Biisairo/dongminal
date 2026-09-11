package toolhub

import "sync/atomic"

// AgentTurn 은 에이전트 훅이 말한 **턴의 상태**다 (ATTENTION_FIRING_SRS 묶음 N).
//
// 이 타입이 있는 이유는 하나다: 알람은 **새 사건**에만 서야 하는데, 훅이 오는
// 모든 순간이 새 사건은 아니기 때문이다 (§2.7). 배경 이벤트로 깨어난 턴의 종료와
// 입력 유휴 알림은 사건이 아니라 같은 상태의 되풀이다.
//
// 두 표시로 그 둘을 가른다.
//
//	userTurn   — 사용자 프롬프트로 시작된 턴이 아직 끝나지 않았다 (FR-ATN-1)
//	inProgress — 에이전트가 일하는 중이다 (FR-ATN-7)
//
// 시각을 견주지 않는다. 세움과 내림의 두 사건이 이미 순서를 말하고, 시각으로
// 견주면 "보고한 적 없음"과 "시각 0 에 보고함"이 구별되지 않는다.
//
// 직접 모드(`Tool`)와 데몬 모드(`hub.AttnTracker`)가 이 한 벌을 공유한다
// (FR-ATN-14·NFR-4). 두 벌로 적으면 한쪽만 고쳐지는 날이 온다.
type AgentTurn struct {
	userTurn   atomic.Bool
	inProgress atomic.Bool
	// waitingSignaled 는 "이 턴에서 waiting 알람을 이미 냈다" 는 사실이다
	// (FR-ATN-15). `Notification` 훅은 대기가 이어지는 동안 **되풀이 발화한다** —
	// 그 되풀이 하나하나를 새 사건으로 읽으면 같은 대기가 몇 번이고 운다 (B7).
	//
	// 내리는 것은 "사용자가 새 일을 시켰다" 는 신호들이다: `working` 활동 보고와
	// 키를 누른 주목이다 (FR-ATN-16).
	waitingSignaled atomic.Bool
}

// NoteUserPrompt 는 사용자 프롬프트로 턴이 시작되었음을 기록한다 (FR-ATN-1).
//
// 부르는 자리는 `UserPromptSubmit` 활동 보고 **하나뿐**이다 (FR-ATN-3).
// `PreToolUse`·`PostToolUse`·`SubagentStop`·`PreCompact` 도 `working` 을
// 보고하지만, 그것들은 턴이 왜 시작되었는지 말하지 않는다.
func (t *AgentTurn) NoteUserPrompt() { t.userTurn.Store(true) }

// NoteActivity 는 활동 보고를 진행 표시에 반영한다 (FR-ATN-7·8).
//
// `waiting`·`idle` 이 표시를 건드리지 않는 것은 규약이다. `Notification` 훅에는
// `dmctl notify` 와 `dmctl activity` 가 함께 걸려 있고 둘의 도착 순서는 보장되지
// 않으므로, 판정의 재료가 판정 대상과 같은 훅에서 오면 경합이 판정을 뒤집는다.
func (t *AgentTurn) NoteActivity(state string) {
	switch state {
	case "working":
		t.inProgress.Store(true)
		// FR-ATN-16: 다시 일하기 시작했다면 그다음의 대기는 **새 사건**이다.
		// 사용자가 권한 요청에 응답한 경로가 여기다 — 웹 UI 를 지나지 않고
		// 터미널에서 직접 눌렀을 때도 이 보고는 온다.
		t.waitingSignaled.Store(false)
	case "done":
		t.inProgress.Store(false)
	case "ended":
		// FR-ATN-5: 세션이 끝나면 표시를 함께 버린다. 남은 표시가 같은 도구의
		// 다음 세션을 흔들면 안 된다.
		t.userTurn.Store(false)
		t.inProgress.Store(false)
		t.waitingSignaled.Store(false)
	}
}

// InProgress 는 에이전트가 지금 일하는 중인지다 (FR-ATN-7).
func (t *AgentTurn) InProgress() bool { return t.inProgress.Load() }

/*
NoteAttendTyped 는 사용자가 그 도구에 **키를 눌러** 주목했음을 기록한다.

**대기 표시는 건드리지 않는다** (FR-ATN-16a, 사용자 보고 `U-24`).

	이전 동작 — `waitingSignaled` 를 풀어 다음 대기를 새 사건으로 만들었다
	새 동작   — 풀지 않는다. 대기가 끝났다고 말할 수 있는 것은 `working` 뿐이다
	이유     — FR-ATN-16 은 "일을 시켰으므로 그 결과를 다시 기다린다" 를 전제했다.
	           그러나 **권한 요청을 기다리는 중에 그 터미널을 만진 것은 일을 시킨
	           것이 아니다.** 대기는 그대로인데 표시만 풀리고, 에이전트가 같은
	           대기로 `Notification` 을 재전송하면 또 운다 — 사용자가 접수한
	           *"한 번 봐도 여전히 waiting 상태이기 때문에 울리면 안 된다"* 가
	           이것이다

`NoteActivity("working")` 의 리셋은 **그대로 둔다.** 그쪽은 에이전트가 실제로 다시
일을 시작했다는 보고이며, 그것이 곧 이전 대기의 해소다. 없애면 한 턴 안의 두 번째
권한 요청이 조용해진다.

재무장 잠금을 가르는 `Attend`/`AttendTyped` 의 구분(FR-ATF-5·6)은 그대로다 — 그것은
정적 감지(idle)의 것이고, 이 함수가 만지던 것은 명시 신호(waiting)의 것이다.
*/
func (t *AgentTurn) NoteAttendTyped() {}

// AllowActivitySignal 은 **활동 이벤트에서 파생한** 알람의 판정이다
// (AGENT_EVENT_ABSTRACTION_SRS FR-AEV-10·12).
//
// 판정은 `AllowSignal` 그대로다 — 규칙을 두 벌로 두지 않는다. 다른 것은 하나뿐:
// **턴의 출처를 말할 수 없는 에이전트**(`Signals.UserTurn=false`)의 `done` 은
// 판정 없이 울린다.
//
// 그 예외가 있는 이유는 `FR-CBG-5` 다 — **모른다 ≠ 괜찮다.** `done` 의 판정은
// 사용자 턴 표시를 보는데, 그 표시를 세우는 이벤트가 아예 없는 에이전트에서는
// 표시가 영원히 서지 않는다. 그것을 "사용자 턴이 아니었다" 로 읽으면 그 에이전트는
// **한 번도 울지 않는다** (codex 가 그 자리였고, 지금은 라벨로 규칙을 우회하고
// 있다 — SRS §2.4).
func (t *AgentTurn) AllowActivitySignal(state string, turnKnown bool) bool {
	if state == "done" && !turnKnown {
		return true
	}
	return t.AllowSignal(state)
}

// AllowSignal 은 명시 신호(L1 훅 — `dmctl notify`)가 알람이 되는지 판정한다.
//
//	done    — 사용자 프롬프트로 시작된 턴이 끝났을 때만 (FR-ATN-4). 표시는
//	          **소비된다**: 한 번의 프롬프트가 낳는 알람은 한 번뿐이고, 이어지는
//	          배경 턴들의 done 은 조용하다
//	waiting — 턴이 진행 중이고 이 턴에서 아직 대기를 알리지 않았을 때만
//	          (FR-ATN-6·15). 그때가 권한 요청이고, 그 밖은 입력 유휴다 (AS-3).
//	          표시는 done 과 같이 **소비된다** — `Notification` 훅의 되풀이가
//	          같은 대기를 몇 번이고 울리던 자리다 (B7)
//	그 밖   — 판정하지 않는다 (FR-ATN-12). 훅 배선이 쓰는 두 라벨 말고는 누가
//	          보냈든 알람이다 (FR-ATF-4). codex 의 `notify codex` 가 여기다
func (t *AgentTurn) AllowSignal(reason string) bool {
	switch reason {
	case "done":
		return t.userTurn.CompareAndSwap(true, false)
	case "waiting":
		// FR-ATN-15: 표시는 **소비된다** — done 이 사용자 턴 표시를 소비하는
		// 것과 같은 규약이다. 한 번의 대기가 낳는 알람은 한 번뿐이고, 훅이
		// 되풀이 보내는 그다음의 waiting 은 조용하다.
		return t.inProgress.Load() && t.waitingSignaled.CompareAndSwap(false, true)
	}
	return true
}
