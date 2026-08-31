package apierr

// 와이어 코드 — 클라이언트가 분기하는 오류 식별 문자열의 **단일 소유자**다
// (FR-DPN-3).
//
// 여기 모아 둔 이유는 문자열이 두 벌이 될 자리를 없애는 것이다. 이전에는 같은
// 문자열이 sentinel 의 메시지와 HTTP 레이어의 상수로 두 번 선언돼 있었다:
//
//	domain/git/write/ignore.go:34  var ErrIgnorePath = errors.New("unsafe_ignore_path")
//	gitapi/handlers_git_ignore.go  gitErrIgnorePath = "unsafe_ignore_path"
//
// sentinel 의 메시지는 건드리지 않는다 (비목표 N7) — 대신 HTTP 쪽 선언을 여기
// 하나로 모으고, 값이 겹치는 코드는 **상수 하나를 공유**한다. 겹침이 남으면
// 전수성 테스트(V6)가 실패한다.
//
// 코드가 sentinel 문자열과 다른 자리가 있다. 그것은 실수가 아니라 설계다 —
// `write.ErrTagNotFound`("tag_not_found") 는 와이어에서 CodeNotFound("not_found")
// 이고, `write.ErrPatchStale`("patch_stale") 는 CodeStaleObservation 이다.
// 클라이언트는 종류가 아니라 **대응 방법**으로 갈라야 한다.
const (
	// ── 공용 ──
	CodeBadRequest = "bad_request"
	CodeNotFound   = "not_found"

	// ── git 실행 환경 ──
	CodeNotRepo     = "not_a_git_repo"
	CodeRepoMissing = "repo_missing"
	CodeGitMissing  = "git_missing"
	CodeTimeout     = "git_timeout"
	CodeCanceled    = "git_canceled"
	CodeUnavailable = "git_unavailable"
	CodeFailed      = "git_failed"

	// ── ref 이름·브랜치·태그 ──
	CodeRefName         = "ref_name_invalid"
	CodeBranchExists    = "branch_exists"
	CodeBranchNotMerged = "branch_not_merged"
	CodeBranchCurrent   = "branch_is_current"
	CodeTagExists       = "tag_exists"

	// ── 커밋 동작 ──
	CodeMergeParent = "merge_parent_required"
	CodeResetMode   = "reset_mode_invalid"

	// ── 원격·작업 ──
	CodeNoRemote        = "no_remote"
	CodeRemoteExists    = "remote_exists"
	CodeRemoteMissing   = "remote_missing"
	CodePublishRequired = "publish_required"
	CodeSyncNotFound    = "sync_not_found"
	CodeJobBusy         = "job_busy"
	CodeJobNotFound     = "job_not_found"

	// ── stash ──
	CodeNothingToStash = "nothing_to_stash"
	CodeStashKept      = "stash_kept"

	// ── 부분 스테이징 ──
	CodeStaleObservation = "stale_observation"
	CodePatchEmpty       = "patch_empty"

	// ── 진행 중 작업 ──
	CodeOperationMismatch = "operation_mismatch"
	CodeNoOperation       = "no_operation"

	// ── 미커밋 행 ──
	CodeNoHead         = "no_head"
	CodeNothingToClean = "nothing_to_clean"

	// ── 정책 거부 (sentinel 없이 핸들러가 직접 낸다) ──
	CodeConfirmRequired  = "confirmation_required"
	CodePreflightBlocked = "preflight_blocked"
	CodeUndoExpired      = "undo_expired"
	CodeEmptyMessage     = "empty_message"
	CodeNothingStaged    = "nothing_staged"
	CodeRecordMissing    = "record_missing"
	CodeNotText          = "not_text"
	CodeIgnorePath       = "unsafe_ignore_path"
	CodeWorktreeExists   = "worktree_exists"

	// ── 파일시스템 표면 (/api/fs/*, /api/editors/*) ──
	// CodeNotFound 를 git 표면과 **공유한다** — 같은 문자열이 두 이름을 갖지
	// 않는다 (V6).
	CodeExists      = "exists"
	CodeOutsideRoot = "outside_root"
	CodePermission  = "permission_denied"
	CodeIO          = "io_failed"
	CodeTooLarge    = "too_large"
	// CodeFSNotRepo 는 git 표면의 CodeNotRepo("not_a_git_repo") 와 **다른**
	// 문자열이다 ("not_repo"). 두 표면이 이미 다른 값을 내보내고 있으므로
	// 합치면 파괴적 변경이다.
	CodeFSNotRepo = "not_repo"
)
