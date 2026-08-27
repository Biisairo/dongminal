package core

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
	// FR-GIT-224: 충돌 파일을 한쪽으로 덮는다 — 워킹 트리의 손댄 내용을 잃는다.
	ActionResolveSide = "resolve_side"
	// FR-GIT-250.1: 동작 표면 완성판이 여는 것들. 되돌리려면 reflog 가 필요하거나
	// 아예 되살릴 수 없는 것이 파괴적이다 — 판정은 하위 명령이 아니라 옵션에서
	// 파생한다 (`reset --soft` 는 안전하고 `--hard` 는 아니다).
	ActionRebase         = "rebase"          // 커밋 해시가 바뀐다
	ActionCommitDrop     = "commit_drop"     // 커밋 하나를 히스토리에서 뺀다
	ActionCleanUntracked = "clean_untracked" // 추적되지 않는 파일은 되살릴 수 없다
	ActionOperationAbort = "operation_abort" // 진행 중 작업의 해결 내용이 사라진다
)

// DestructiveActions 는 2단계 확인과 recovery hint 를 반드시 거치는 동작이다
// (FR-GIT-89). **API 로 노출한다** — 클라이언트가 목록을 복제하면 서버에 새 파괴적
// 동작이 생겨도 클라이언트가 그것을 막지 못한다.
var DestructiveActions = []string{
	ActionDiscard, ActionBranchDelete, ActionStashDrop, ActionTagDelete,
	ActionResetHard, ActionForcePush, ActionRemoteRefDelete, ActionResolveSide,
	ActionRebase, ActionCommitDrop, ActionCleanUntracked, ActionOperationAbort,
}
