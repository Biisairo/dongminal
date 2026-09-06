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
	case "done":
		t.inProgress.Store(false)
	case "ended":
		// FR-ATN-5: 세션이 끝나면 두 표시를 함께 버린다. 남은 표시가 같은
		// 도구의 다음 세션을 흔들면 안 된다.
		t.userTurn.Store(false)
		t.inProgress.Store(false)
	}
}

// InProgress 는 에이전트가 지금 일하는 중인지다 (FR-ATN-7).
func (t *AgentTurn) InProgress() bool { return t.inProgress.Load() }

// AllowSignal 은 명시 신호(L1 훅 — `dmctl notify`)가 알람이 되는지 판정한다.
//
//	done    — 사용자 프롬프트로 시작된 턴이 끝났을 때만 (FR-ATN-4). 표시는
//	          **소비된다**: 한 번의 프롬프트가 낳는 알람은 한 번뿐이고, 이어지는
//	          배경 턴들의 done 은 조용하다
//	waiting — 턴이 진행 중일 때만 (FR-ATN-6). 그때가 권한 요청이고, 그 밖은
//	          입력 유휴다 (AS-3)
//	그 밖   — 판정하지 않는다 (FR-ATN-12). 훅 배선이 쓰는 두 라벨 말고는 누가
//	          보냈든 알람이다 (FR-ATF-4). codex 의 `notify codex` 가 여기다
func (t *AgentTurn) AllowSignal(reason string) bool {
	switch reason {
	case "done":
		return t.userTurn.CompareAndSwap(true, false)
	case "waiting":
		return t.inProgress.Load()
	}
	return true
}
