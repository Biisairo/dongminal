package toolhub

import (
	"sync/atomic"

	"dongminal/internal/shared/activity"
)

// AgentTurn 은 에이전트 훅이 말한 **턴의 상태**다 (ATTENTION_FIRING_SRS 묶음 N).
//
// 이 타입이 있는 이유는 하나다: 알람은 **새 사건**에만 서야 하는데, 훅이 오는
// 모든 순간이 새 사건은 아니기 때문이다 (§2.7). 한 턴의 종료가 두 경로로 오는 것과
// 입력 유휴 알림은 사건이 아니라 같은 상태의 되풀이다.
//
// 세 표시로 그것을 가른다.
//
//	turnRan         — 마지막 done 알람 뒤 턴이 시작되었다 (FR-ATN-1·4)
//	inProgress      — 에이전트가 일하는 중이다 (FR-ATN-7)
//	waitingSignaled — 이 턴에서 waiting 알람을 이미 냈다 (FR-ATN-15)
//
// 시각을 견주지 않는다. 세움과 내림의 두 사건이 이미 순서를 말하고, 시각으로
// 견주면 "보고한 적 없음"과 "시각 0 에 보고함"이 구별되지 않는다.
//
// 직접 모드(`Tool`)와 데몬 모드(`hub.AttnTracker`)가 이 한 벌을 공유한다
// (FR-ATN-14·NFR-4). 두 벌로 적으면 한쪽만 고쳐지는 날이 온다.
type AgentTurn struct {
	inProgress atomic.Bool
	// turnRan 은 "마지막 done 알람 뒤 턴이 시작되었다(`working`)" 는 사실이다
	// (FR-ATN-1·4, D-12). 사용자 프롬프트든 배경 알림이든 턴이 깨어나면 `working` 을
	// 보고하므로 턴마다 한 번 울고, 같은 종료가 두 경로로 와도 한 번이다 (FR-AEV-13).
	turnRan atomic.Bool
	// waitingSignaled 는 "이 턴에서 waiting 알람을 이미 냈다" 는 사실이다
	// (FR-ATN-15). `Notification` 훅은 대기가 이어지는 동안 **되풀이 발화한다** —
	// 그 되풀이 하나하나를 새 사건으로 읽으면 같은 대기가 몇 번이고 운다 (B7).
	//
	// 내리는 것은 "사용자가 새 일을 시켰다" 는 신호들이다: `working` 활동 보고와
	// 키를 누른 주목이다 (FR-ATN-16).
	waitingSignaled atomic.Bool
}

// NoteActivity 는 활동 보고를 진행 표시에 반영한다 (FR-ATN-7·8).
//
// `waiting`·`idle` 이 표시를 건드리지 않는 것은 규약이다. `Notification` 훅에는
// `dmctl notify` 와 `dmctl activity` 가 함께 걸려 있고 둘의 도착 순서는 보장되지
// 않으므로, 판정의 재료가 판정 대상과 같은 훅에서 오면 경합이 판정을 뒤집는다.
func (t *AgentTurn) NoteActivity(state string) {
	switch state {
	case activity.Working:
		t.inProgress.Store(true)
		t.turnRan.Store(true)
		// FR-ATN-16: 다시 일하기 시작했다면 그다음의 대기는 **새 사건**이다.
		// 사용자가 권한 요청에 응답한 경로가 여기다 — 웹 UI 를 지나지 않고
		// 터미널에서 직접 눌렀을 때도 이 보고는 온다.
		t.waitingSignaled.Store(false)
	case activity.Done:
		t.inProgress.Store(false)
	case activity.Ended:
		// FR-ATN-5: 세션이 끝나면 표시를 함께 버린다. 남은 표시가 같은 도구의
		// 다음 세션을 흔들면 안 된다.
		t.inProgress.Store(false)
		t.waitingSignaled.Store(false)
		t.turnRan.Store(false)
	}
}

// InProgress 는 에이전트가 지금 일하는 중인지다 (FR-ATN-7).
func (t *AgentTurn) InProgress() bool { return t.inProgress.Load() }

// AllowActivitySignal 은 **활동 이벤트에서 파생한** 알람의 판정이다
// (AGENT_EVENT_ABSTRACTION_SRS FR-AEV-10·12).
//
// 판정은 `AllowSignal` 그대로다 — 규칙을 두 벌로 두지 않는다. 다른 것은 하나뿐:
// **턴의 시작을 알릴 수 없는 에이전트**(`Signals.Working=false`)의 `done` 은
// 판정 없이 울린다.
//
// 그 예외가 있는 이유는 `FR-CBG-5` 다 — **모른다 ≠ 괜찮다.** `done` 의 판정은
// 턴 시작 표시를 보는데, 그 표시를 세우는 이벤트가 아예 없는 에이전트에서는
// 표시가 영원히 서지 않는다. 그것을 "턴이 시작되지 않았다" 로 읽으면 그 에이전트는
// **한 번도 울지 않는다** (codex 가 그 자리다 — SRS §2.4).
func (t *AgentTurn) AllowActivitySignal(state string, turnKnown bool) bool {
	if state == activity.Done && !turnKnown {
		return true
	}
	return t.AllowSignal(state)
}

// AllowSignal 은 명시 신호(L1 훅 — `dmctl notify`)가 알람이 되는지 판정한다.
//
//	done    — 마지막 done 알람 뒤 `working` 이 보고되었을 때만 (FR-ATN-4 개정,
//	          D-12). 배경 턴(서브에이전트·백그라운드 작업이 깨운 턴)의 종료도
//	          사건이다. 표시는 **소비된다**: 한 턴의 종료는 한 번만 운다
//	waiting — 턴이 진행 중이고 이 턴에서 아직 대기를 알리지 않았을 때만
//	          (FR-ATN-6·15). 그때가 권한 요청이고, 그 밖은 입력 유휴다 (AS-3).
//	          표시는 done 과 같이 **소비된다** — `Notification` 훅의 되풀이가
//	          같은 대기를 몇 번이고 울리던 자리다 (B7)
//	그 밖   — 판정하지 않는다 (FR-ATN-12). 훅 배선이 쓰는 두 라벨 말고는 누가
//	          보냈든 알람이다 (FR-ATF-4). codex 의 `notify codex` 가 여기다
func (t *AgentTurn) AllowSignal(reason string) bool {
	switch reason {
	case activity.Done:
		return t.turnRan.CompareAndSwap(true, false)
	case activity.Waiting:
		// FR-ATN-15: 표시는 **소비된다** — done 이 턴 시작 표시를 소비하는
		// 것과 같은 규약이다. 한 번의 대기가 낳는 알람은 한 번뿐이고, 훅이
		// 되풀이 보내는 그다음의 waiting 은 조용하다.
		return t.inProgress.Load() && t.waitingSignaled.CompareAndSwap(false, true)
	}
	return true
}

// TurnState 는 AgentTurn 의 표시 셋을 옮기는 모양이다 (AGENT_RECORD_DAEMON_SRS FR-ARD-10).
type TurnState struct {
	InProgress      bool `json:"inProgress"`
	WaitingSignaled bool `json:"waitingSignaled"`
	TurnRan         bool `json:"turnRan"`
}

// State 는 지금의 표시다.
func (t *AgentTurn) State() TurnState {
	return TurnState{InProgress: t.inProgress.Load(), WaitingSignaled: t.waitingSignaled.Load(), TurnRan: t.turnRan.Load()}
}

// Restore 는 표시를 st 로 되세운다.
func (t *AgentTurn) Restore(st TurnState) {
	t.inProgress.Store(st.InProgress)
	t.waitingSignaled.Store(st.WaitingSignaled)
	// turnRan 이 없는 옛 스냅샷도 진행 중이던 턴의 종료를 울린다 — 진행 표시는
	// 마지막 done 뒤에 `working` 이 왔다는 뜻이다.
	t.turnRan.Store(st.TurnRan || st.InProgress)
}
