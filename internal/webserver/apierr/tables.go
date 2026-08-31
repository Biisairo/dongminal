package apierr

import (
	"io/fs"
	"net/http"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"
	"dongminal/internal/webserver/domain/wsentry"
)

// Git은 /api/git/* 의 매핑 정책이다 (FR-DPN-4). 번역기 13개의 순수 sentinel 분기가
// 여기로 들어왔다.
//
// **순서는 구체 → 일반이다.** 원본에서 `core.*` 판정은 언제나 각 번역기의
// `default` 였다 — 그 자리를 테이블 맨 아래가 대신한다.
var Git = Table{
	// ── 부분 스테이징. 원본에서 gitWriteErrorCode 가 가장 먼저 물었다 ──
	{write.ErrPatchStale, http.StatusConflict, CodeStaleObservation},
	{write.ErrPatchEmpty, http.StatusBadRequest, CodePatchEmpty},
	{write.ErrPatchOp, http.StatusBadRequest, CodeBadRequest},
	{write.ErrPatchAxis, http.StatusBadRequest, CodeBadRequest},
	{write.ErrPatchRange, http.StatusBadRequest, CodeBadRequest},
	{query.ErrDiffTruncated, http.StatusBadRequest, CodeBadRequest},

	// ── 원격 목록. 원본에서 두 번째였다 ──
	{write.ErrRemoteExists, http.StatusConflict, CodeRemoteExists},
	{write.ErrRemoteMissing, http.StatusNotFound, CodeRemoteMissing},
	{write.ErrRemoteName, http.StatusBadRequest, CodeBadRequest},
	{write.ErrRemoteURL, http.StatusBadRequest, CodeBadRequest},
	{write.ErrPushTarget, http.StatusBadRequest, CodeBadRequest},

	// ── stash. errors.Join 으로 두 sentinel 이 함께 올 수 있어 상대 순서를
	//    원본 switch 그대로 둔다 (write/stash.go:226) ──
	{write.ErrStashEmpty, http.StatusConflict, CodeNothingToStash},
	{write.ErrStashNotFound, http.StatusNotFound, CodeNotFound},

	// ── 원격 동작 ──
	{write.ErrPublishRequired, http.StatusConflict, CodePublishRequired},
	{write.ErrForceConfirm, http.StatusBadRequest, CodeConfirmRequired},
	{write.ErrPullMode, http.StatusBadRequest, CodeBadRequest},
	{write.ErrPushForce, http.StatusBadRequest, CodeBadRequest},
	{write.ErrDetachedPush, http.StatusBadRequest, CodeBadRequest},
	{query.ErrNoRemote, http.StatusConflict, CodeNoRemote},

	// ── 작업 큐 ──
	{jobs.ErrJobBusy, http.StatusConflict, CodeJobBusy},

	// ── 브랜치 ──
	{write.ErrBranchExists, http.StatusConflict, CodeBranchExists},
	{write.ErrCheckoutTarget, http.StatusBadRequest, CodeBadRequest},
	{write.ErrBranchRename, http.StatusBadRequest, CodeBadRequest},
	{write.ErrBranchDelete, http.StatusBadRequest, CodeBadRequest},
	{write.ErrMergeMode, http.StatusBadRequest, CodeBadRequest},
	{write.ErrBranchUpstream, http.StatusBadRequest, CodeBadRequest},

	// ── 태그 ──
	{write.ErrTagExists, http.StatusConflict, CodeTagExists},
	{write.ErrTagNotFound, http.StatusNotFound, CodeNotFound},
	{write.ErrTagKind, http.StatusBadRequest, CodeBadRequest},
	{write.ErrTagMessage, http.StatusBadRequest, CodeBadRequest},
	{write.ErrTagPushTarget, http.StatusBadRequest, CodeBadRequest},

	// ── 커밋 동작 ──
	{write.ErrResetMode, http.StatusBadRequest, CodeResetMode},
	{write.ErrPickVerb, http.StatusBadRequest, CodeBadRequest},
	// write.ErrMergeParent 는 여기 없다 — 부모 목록을 본문에 함께 실어야 하므로
	// 오류값만으로 응답이 결정되지 않는다 (A3, FR-DPN-5).

	// ── 조회 (blame·diff·log) ──
	{query.ErrBlameTruncated, http.StatusRequestEntityTooLarge, CodeFailed},
	{query.ErrBlamePathNotFound, http.StatusNotFound, CodeNotFound},
	{query.ErrRevNotFound, http.StatusNotFound, CodeNotFound},
	{query.ErrDiffBothAbsent, http.StatusNotFound, CodeNotFound},
	{query.ErrDiffAxis, http.StatusBadRequest, CodeBadRequest},
	{query.ErrDiffPath, http.StatusBadRequest, CodeBadRequest},
	{query.ErrUnsafeRev, http.StatusBadRequest, CodeBadRequest},
	{query.ErrLogOrder, http.StatusBadRequest, CodeBadRequest},
	{query.ErrCommitParent, http.StatusBadRequest, CodeBadRequest},

	// ── 사용자 worktree 영역 (/api/git/worktrees). /api/runs 의 격리와 상태
	//    코드가 다르다 — Runs 테이블 참조 ──
	{worktree.ErrUnsafeArgument, http.StatusBadRequest, CodeRefName},
	{worktree.ErrUnsafePath, http.StatusBadRequest, CodeBadRequest},
	{worktree.ErrNotRepo, http.StatusNotFound, CodeNotRepo},
	{worktree.ErrGitMissing, http.StatusServiceUnavailable, CodeGitMissing},

	// ── 일반. 원본 번역기들의 default 자리 ──
	// FR-DPN-10: core.ErrRefName 은 이제 표면 전체에서 하나다.
	//   이전 동작 — branch·tag 는 "ref_name_invalid", commit_ops 는 "bad_request"
	//   새 동작   — 전부 "ref_name_invalid" (400 은 그대로)
	//   이유     — 같은 sentinel 이 두 코드로 갈린 것은 복제의 드리프트다
	{core.ErrRefName, http.StatusBadRequest, CodeRefName},
	{core.ErrUnsafeArgument, http.StatusBadRequest, CodeBadRequest},
	{core.ErrWriteCommand, http.StatusBadRequest, CodeBadRequest},
	{core.ErrNotRepo, http.StatusNotFound, CodeNotRepo},
	{core.ErrRepoMissing, http.StatusNotFound, CodeRepoMissing},
	{core.ErrGitMissing, http.StatusServiceUnavailable, CodeGitMissing},
	{core.ErrTimeout, http.StatusGatewayTimeout, CodeTimeout},
	// 서버가 실패한 것이 아니라 요청이 사라진 것이다 (FR-GIT-217). 500 으로
	// 적으면 진짜 장애와 로그에서 구분되지 않는다.
	{core.ErrCanceled, StatusClientClosed, CodeCanceled},
}

// Runs는 /api/runs/* 의 매핑 정책이다.
//
// **코드가 sentinel 의 메시지 그 자체다.** 이 표면의 계약이 원래 그렇다
// (`writeRunError` 가 `err.Error()` 를 실었다) — 문자열을 상수로 다시 선언하면
// 두 벌이 되므로 `.Error()` 를 그대로 참조한다.
//
// **worktree 격리 실패의 상태 코드가 Git 테이블과 다르다.** 여기서는 조정자가
// 인자로 준 경로가 틀린 것이므로 400 이고, `/api/git/worktrees` 에서는 지목한
// 것이 거기 없는 것이므로 404 다. 둘 다 옳아서 테이블이 둘이다.
var Runs = Table{
	{run.ErrUnknownRun, http.StatusNotFound, run.ErrUnknownRun.Error()},
	{run.ErrSenderNotMember, http.StatusForbidden, run.ErrSenderNotMember.Error()},
	{run.ErrUnknownMember, http.StatusNotFound, run.ErrUnknownMember.Error()},
	{run.ErrRunMemberMismatch, http.StatusForbidden, run.ErrRunMemberMismatch.Error()},
	{run.ErrRunClosed, http.StatusConflict, run.ErrRunClosed.Error()},
	{run.ErrRunOpen, http.StatusConflict, run.ErrRunOpen.Error()},
	{run.ErrAlreadyReported, http.StatusConflict, run.ErrAlreadyReported.Error()},
	{run.ErrToolAlreadyMember, http.StatusConflict, run.ErrToolAlreadyMember.Error()},
	// 묶음 H — 부착·분리의 거부 (FR-HLM-6/7). 409 인 이유는 요청이 잘못된 것이
	// 아니라 멤버가 이미 그 상태이기 때문이다.
	{run.ErrMemberAttached, http.StatusConflict, run.ErrMemberAttached.Error()},
	{run.ErrMemberNotAttached, http.StatusConflict, run.ErrMemberNotAttached.Error()},
	{run.ErrUnreportedMembers, http.StatusConflict, run.ErrUnreportedMembers.Error()},
	{run.ErrInvalidArgument, http.StatusBadRequest, run.ErrInvalidArgument.Error()},
	// 격리 실패는 사유를 뭉뚱그리지 않는다 (FR-WKT-11) — 조정자가 "저장소가
	// 아니다"와 "인자가 위험하다"에 다르게 대응해야 한다.
	{worktree.ErrNotRepo, http.StatusBadRequest, worktree.ErrNotRepo.Error()},
	{worktree.ErrGitMissing, http.StatusBadRequest, worktree.ErrGitMissing.Error()},
	{worktree.ErrUnsafeArgument, http.StatusBadRequest, worktree.ErrUnsafeArgument.Error()},
	{worktree.ErrUnsafePath, http.StatusBadRequest, worktree.ErrUnsafePath.Error()},
}

// FS는 /api/fs/* · /api/editors/* 의 매핑 정책이다.
//
// 이 표면은 **코드를 먼저 정하고 상태를 코드에서 끌어낸다** (`fsFail(w, code, …)`
// 가 리터럴 코드로도 불린다). 그래서 테이블과 FSStatus 가 함께 있다.
var FS = Table{
	{fs.ErrNotExist, http.StatusNotFound, CodeNotFound},
	{fs.ErrExist, http.StatusConflict, CodeExists},
	{fs.ErrPermission, http.StatusForbidden, CodePermission},
	{wsentry.ErrNotAbsolute, http.StatusBadRequest, CodeBadRequest},
	{wsentry.ErrNotDir, http.StatusBadRequest, CodeBadRequest},
	{wsentry.ErrNotFound, http.StatusNotFound, CodeNotFound},
}

// FSStatus는 fs 표면의 코드를 상태 코드로 옮긴다. 표에 없는 코드는 500 이다.
func FSStatus(code string) int {
	switch code {
	case CodeBadRequest:
		return http.StatusBadRequest
	case CodeNotFound:
		return http.StatusNotFound
	case CodeExists:
		return http.StatusConflict
	case CodeOutsideRoot, CodePermission:
		return http.StatusForbidden
	case CodeFSNotRepo:
		// "이 경로로는 무시 여부를 물을 수 없다" 는 답이다 (FR-ETR-4).
		// 클라이언트는 4xx 를 판정으로 굳히므로(`_gitOff` 와 같은 관례) 5xx 로
		// 새어 나가면 3초마다 영영 다시 묻는다.
		return http.StatusNotFound
	}
	return http.StatusInternalServerError
}
