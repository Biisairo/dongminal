package git

// 파괴적 동작의 이름. 서버 응답·recovery hint·클라이언트의 확인 절차가 같은
// 문자열을 봐야 하므로 한 자리에 둔다.
const (
	ActionDiscard         = "discard"
	ActionBranchDelete    = "branch_delete"
	ActionStashDrop       = "stash_drop"
	ActionTagDelete       = "tag_delete"
	ActionResetHard       = "reset_hard"
	ActionForcePush       = "force_push"
	ActionRemoteRefDelete = "remote_ref_delete"
)

// DestructiveActions 는 2단계 확인과 recovery hint 를 반드시 거치는 동작이다
// (FR-GIT-89). **API 로 노출한다** — 클라이언트가 목록을 복제하면 서버에 새 파괴적
// 동작이 생겨도 클라이언트가 그것을 막지 못한다.
var DestructiveActions = []string{
	ActionDiscard, ActionBranchDelete, ActionStashDrop, ActionTagDelete,
	ActionResetHard, ActionForcePush, ActionRemoteRefDelete,
}
