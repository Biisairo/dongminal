package apierr

import (
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/sysstat"
	"dongminal/internal/webserver/domain/worktree"
	"dongminal/internal/webserver/domain/wsentry"
)

// Inventory는 HTTP 표면에 도달할 수 있는 domain sentinel **전부**다 (FR-DPN-7).
//
// 이 목록이 있는 이유는 하나다: **빈칸을 침묵으로 두지 않는 것.** 이전에는
// sentinel 을 하나 더해도 아무것도 알려주지 않아, 매핑 없는 11개가 조용히
// 500 으로 나가고 있었다. 이제 목록에 더하고 매핑도 사유도 적지 않으면 테스트가
// 실패한다.
//
// 새 sentinel 을 domain 에 더했다면 여기에도 더한다. 그리고 테이블에 규칙을 주거나
// Unmapped 에 사유를 적는다 — 둘 중 하나는 반드시 해야 한다.
var Inventory = []error{
	// domain/git/core
	core.ErrGitMissing, core.ErrNotRepo, core.ErrRepoMissing, core.ErrTimeout,
	core.ErrCanceled, core.ErrUnsafeArgument, core.ErrWriteCommand, core.ErrRefName,

	// domain/git/query
	query.ErrDiffAxis, query.ErrDiffPath, query.ErrDiffBothAbsent, query.ErrDiffTruncated,
	query.ErrNoRemote, query.ErrBlameTruncated, query.ErrBlameParse, query.ErrBlamePathNotFound,
	query.ErrLogOrder, query.ErrUnsafeRev, query.ErrRevNotFound, query.ErrCommitParent,

	// domain/git/write
	write.ErrBranchExists, write.ErrCheckoutTarget, write.ErrBranchRename,
	write.ErrBranchDelete, write.ErrMergeMode, write.ErrBranchUpstream,
	write.ErrOperation, write.ErrPullMode, write.ErrPushForce, write.ErrForceConfirm,
	write.ErrPublishRequired, write.ErrDetachedPush, write.ErrPushTarget,
	write.ErrRemoteName, write.ErrRemoteURL, write.ErrRemoteExists, write.ErrRemoteMissing,
	write.ErrStashEmpty, write.ErrStashNotFound, write.ErrPickVerb, write.ErrMergeParent,
	write.ErrResetMode, write.ErrReplayTarget, write.ErrIgnorePath,
	write.ErrUncommittedNoHead, write.ErrNothingToClean,
	write.ErrPatchOp, write.ErrPatchAxis, write.ErrPatchStale, write.ErrPatchRange,
	write.ErrPatchEmpty,
	write.ErrTagExists, write.ErrTagNotFound, write.ErrTagKind, write.ErrTagMessage,
	write.ErrTagPushTarget,

	// domain/git/jobs
	jobs.ErrJobBusy, jobs.ErrJobKind,

	// domain/worktree
	worktree.ErrGitMissing, worktree.ErrNotRepo,
	worktree.ErrUnsafeArgument, worktree.ErrUnsafePath,

	// domain/run
	run.ErrNotRunParticipant, run.ErrMemberAttached, run.ErrMemberNotAttached,
	run.ErrUnknownRun, run.ErrRunClosed, run.ErrRunOpen, run.ErrSenderNotMember,
	run.ErrUnknownMember, run.ErrRunMemberMismatch, run.ErrAlreadyReported,
	run.ErrToolAlreadyMember, run.ErrUnreportedMembers, run.ErrInvalidArgument,

	// domain/wsentry
	wsentry.ErrNotAbsolute, wsentry.ErrNotFound, wsentry.ErrNotDir, wsentry.ErrUnavailable,

	// domain/sysstat
	sysstat.ErrUnsupported,
}

// Exemption은 의도적으로 매핑하지 않은 sentinel 과 그 사유다.
type Exemption struct {
	Err    error
	Reason string
}

// Unmapped는 등록부에 규칙이 **없는 것이 맞는** sentinel 들이다 (FR-DPN-8).
//
// 사유가 두 갈래다. ① 오류값만으로 응답이 결정되지 않아(문맥 의존) 제자리에
// 남긴 것 ② HTTP 까지 도달하지 못하거나, 도달하면 그것이 서버 결함이라 500 이
// 옳은 것.
//
// **이 목록에 있다는 것은 "확인했다"는 뜻이고, 없다는 것은 "빠뜨렸다"는 뜻이다.**
// 이 구분이 이 패키지의 존재 이유다.
var Unmapped = []Exemption{
	// ── ① 문맥 의존 — 오류값만으로 응답이 결정되지 않는다 ──
	{write.ErrMergeParent,
		"부모 목록을 본문에 함께 실어야 한다 (FR-GIT-263). 무엇을 고를 수 있는지 " +
			"모르면 화면은 물을 수도 없으므로, 응답이 오류값 밖의 데이터를 요구한다. " +
			"gitCommitOpError 에 남는다"},

	// ── ② 핸들러가 실행 **전에** 코드를 정한다. domain sentinel 이 HTTP 까지
	//       오지 않으며, 오면 그것은 다른 사고다 ──
	{write.ErrOperation,
		"handlers_git_operation.go 가 write.OperationArgs 의 모든 실패를 실행 전에 " +
			"bad_request 로 정한다. 오류값을 보지 않는다"},
	{write.ErrIgnorePath,
		"handlers_git_ignore.go:95 가 write.IgnorePattern 의 모든 실패를 실행 전에 " +
			"unsafe_ignore_path 로 정한다. 오류값을 보지 않는다"},
	{write.ErrUncommittedNoHead,
		"gitResetBlocked 가 status.Initial 로 실행 전에 판정한다 (no_head). " +
			"domain 의 guard 는 두 번째 방어선이다"},
	{write.ErrNothingToClean,
		"gitCleanBlocked 가 status.Untracked 로 실행 전에 판정한다 " +
			"(nothing_to_clean). domain 의 guard 는 두 번째 방어선이다"},
	{write.ErrReplayTarget,
		"apiGitReplay 가 record_missing 과 저장소 일치를 실행 전에 확인한다. " +
			"여기까지 오면 서버 자신의 기록이 불일치한 것이므로 500 이 옳다"},

	// ── ② 클라이언트 입력으로 도달할 수 없다 — 오면 서버 결함이다 ──
	{query.ErrBlameParse,
		"git blame porcelain 형식이 어긋난 것이다. 사용자 입력으로 만들 수 없고, " +
			"발생하면 우리 파서가 틀린 것이므로 500 이 옳은 신호다"},
	{jobs.ErrJobKind,
		"작업의 argv 는 서버가 만든다 (FR-GIT-281 의 정신). 클라이언트가 kind 와 " +
			"argv 의 불일치를 만들 수 없으므로, 발생하면 서버 결함이다"},
	{run.ErrNotRunParticipant,
		"run.AppendMessage 전용이며 이를 호출하는 HTTP 핸들러가 없다. 표면에 " +
			"나타나면 그때 규칙을 준다"},
	{wsentry.ErrUnavailable,
		"fsEntries 의 nil 검사가 먼저 막는다 (io_failed). sentinel 이 응답 경로에 " +
			"도달하지 않는다"},
	{sysstat.ErrUnsupported,
		"/api/stats 는 실패를 오류 본문으로 내지 않고 **키를 생략**한다 " +
			"(FR-STAT-7). 이 표면에는 오류 코드라는 자리 자체가 없다"},
}
