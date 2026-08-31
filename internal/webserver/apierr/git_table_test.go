package apierr

import (
	"fmt"
	"net/http"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
	"dongminal/internal/webserver/domain/worktree"
)

// git 표면의 sentinel → (status, code) 전수. 이 표는 리팩터 **전에** 번역기
// 17개가 내던 값을 그대로 옮겨 온 것이며 (DEEPENING_REFACTOR_SRS §4.1 V1·V2),
// 표가 통과한다는 것이 곧 무동작변경의 증명이다.
//
// 표가 여기 있는 이유: **인터페이스가 테스트 표면이다.** 판정이 gitapi 의
// 번역기 13개에 흩어져 있던 동안 이 표는 그 13개를 각각 찔러야 했다. 이제
// 판정자가 하나이므로 표도 그것 하나를 찌른다.
//
// 원래 어느 번역기가 그 값을 냈는지는 주석으로 남긴다 — 값이 왜 그런지를
// 되짚을 때 그 출처가 유일한 근거다.
var gitTableCases = []struct {
	sentinel error
	status   int
	code     string
}{
	// gitPatchErrorCode
	{write.ErrPatchStale, http.StatusConflict, CodeStaleObservation},
	{write.ErrPatchEmpty, http.StatusBadRequest, CodePatchEmpty},
	{write.ErrPatchOp, http.StatusBadRequest, CodeBadRequest},
	{write.ErrPatchAxis, http.StatusBadRequest, CodeBadRequest},
	{write.ErrPatchRange, http.StatusBadRequest, CodeBadRequest},
	{query.ErrDiffTruncated, http.StatusBadRequest, CodeBadRequest},

	// gitRemoteListError
	{write.ErrRemoteExists, http.StatusConflict, CodeRemoteExists},
	{write.ErrRemoteMissing, http.StatusNotFound, CodeRemoteMissing},
	{write.ErrRemoteName, http.StatusBadRequest, CodeBadRequest},
	{write.ErrRemoteURL, http.StatusBadRequest, CodeBadRequest},
	{write.ErrPushTarget, http.StatusBadRequest, CodeBadRequest},

	// gitStashErrorCode
	{write.ErrStashEmpty, http.StatusConflict, CodeNothingToStash},
	{write.ErrStashNotFound, http.StatusNotFound, CodeNotFound},

	// gitRemoteError / gitPushError
	{write.ErrPublishRequired, http.StatusConflict, CodePublishRequired},
	{write.ErrForceConfirm, http.StatusBadRequest, CodeConfirmRequired},
	{write.ErrPullMode, http.StatusBadRequest, CodeBadRequest},
	{write.ErrPushForce, http.StatusBadRequest, CodeBadRequest},
	{write.ErrDetachedPush, http.StatusBadRequest, CodeBadRequest},
	{query.ErrNoRemote, http.StatusConflict, CodeNoRemote},

	// gitStartFail
	{jobs.ErrJobBusy, http.StatusConflict, CodeJobBusy},

	// gitBranchError
	{write.ErrBranchExists, http.StatusConflict, CodeBranchExists},
	{write.ErrCheckoutTarget, http.StatusBadRequest, CodeBadRequest},
	{write.ErrBranchRename, http.StatusBadRequest, CodeBadRequest},
	{write.ErrBranchDelete, http.StatusBadRequest, CodeBadRequest},
	{write.ErrMergeMode, http.StatusBadRequest, CodeBadRequest},
	{write.ErrBranchUpstream, http.StatusBadRequest, CodeBadRequest},

	// gitTagError
	{write.ErrTagExists, http.StatusConflict, CodeTagExists},
	{write.ErrTagNotFound, http.StatusNotFound, CodeNotFound},
	{write.ErrTagKind, http.StatusBadRequest, CodeBadRequest},
	{write.ErrTagMessage, http.StatusBadRequest, CodeBadRequest},
	{write.ErrTagPushTarget, http.StatusBadRequest, CodeBadRequest},

	// gitCommitOpError
	{write.ErrResetMode, http.StatusBadRequest, CodeResetMode},
	{write.ErrPickVerb, http.StatusBadRequest, CodeBadRequest},

	// gitBlameError
	{query.ErrBlameTruncated, http.StatusRequestEntityTooLarge, CodeFailed},
	{query.ErrBlamePathNotFound, http.StatusNotFound, CodeNotFound},

	// gitBlameError / gitDiffError / gitHistoryError — 셋이 같은 값을 냈다
	{query.ErrRevNotFound, http.StatusNotFound, CodeNotFound},
	{query.ErrUnsafeRev, http.StatusBadRequest, CodeBadRequest},
	{query.ErrDiffPath, http.StatusBadRequest, CodeBadRequest},

	// gitDiffError
	{query.ErrDiffBothAbsent, http.StatusNotFound, CodeNotFound},
	{query.ErrDiffAxis, http.StatusBadRequest, CodeBadRequest},

	// gitHistoryError
	{query.ErrLogOrder, http.StatusBadRequest, CodeBadRequest},
	{query.ErrCommitParent, http.StatusBadRequest, CodeBadRequest},

	// gitWorktreeError
	{worktree.ErrUnsafeArgument, http.StatusBadRequest, CodeRefName},
	{worktree.ErrUnsafePath, http.StatusBadRequest, CodeBadRequest},
	{worktree.ErrNotRepo, http.StatusNotFound, CodeNotRepo},
	{worktree.ErrGitMissing, http.StatusServiceUnavailable, CodeGitMissing},

	// gitWriteErrorCode
	{core.ErrUnsafeArgument, http.StatusBadRequest, CodeBadRequest},
	{core.ErrWriteCommand, http.StatusBadRequest, CodeBadRequest},

	// gitErrorCode — 모든 번역기의 default 였다
	{core.ErrNotRepo, http.StatusNotFound, CodeNotRepo},
	{core.ErrRepoMissing, http.StatusNotFound, CodeRepoMissing},
	{core.ErrGitMissing, http.StatusServiceUnavailable, CodeGitMissing},
	{core.ErrTimeout, http.StatusGatewayTimeout, CodeTimeout},
	{core.ErrCanceled, StatusClientClosed, CodeCanceled},

	// FR-DPN-10 — **유일하게 바뀐 줄.**
	//   이전 동작: gitBranchError·gitTagError 는 "ref_name_invalid",
	//             gitCommitOpError 는 "bad_request" (400 은 둘 다 같았다)
	//   새 동작:   전부 "ref_name_invalid"
	//   이유:     같은 sentinel 이 두 코드로 갈린 것은 설계가 아니라 복제의
	//             드리프트다. commit_ops 의 "bad_request" 를 고정한 테스트가 없고
	//             프론트엔드가 그 코드로 분기하는 자리도 없다
	{core.ErrRefName, http.StatusBadRequest, CodeRefName},
}

func TestGitTableMatchesPreRefactorBehavior(t *testing.T) {
	for _, c := range gitTableCases {
		t.Run(c.sentinel.Error(), func(t *testing.T) {
			// 실제 코드는 언제나 감싸서 돌려준다 — 감싸지 않고 재면
			// errors.Is 가 도는지를 재지 못한다.
			status, code, ok := Git.Lookup(fmt.Errorf("%w: 세부 사유", c.sentinel))
			if !ok {
				t.Fatalf("%v 에 규칙이 없다", c.sentinel)
			}
			if status != c.status || code != c.code {
				t.Fatalf("Git.Lookup(%v) = %d %q, want %d %q",
					c.sentinel, status, code, c.status, c.code)
			}
		})
	}
}

// 표가 테이블 전체를 덮어야 한다. 규칙을 더하고 표를 안 고치면 그 규칙은 아무도
// 검사하지 않는다.
func TestGitTableCasesCoverEveryRule(t *testing.T) {
	covered := map[error]bool{}
	for _, c := range gitTableCases {
		covered[c.sentinel] = true
	}
	for _, r := range Git {
		if !covered[r.Err] {
			t.Errorf("Git 테이블의 %q 가 gitTableCases 에 없다 — 검사되지 않는 규칙이다", r.Err)
		}
	}
}

// 묶음 A 의 귀결 하나: 테이블이 하나이므로 **sentinel 은 어느 핸들러에서 나오든
// 같은 코드를 얻는다** (FR-DPN-12).
//
// 이전에는 번역기가 모르는 sentinel 을 500 으로 흘려보냈다 — 예컨대
// gitCommitOpError 에 write.ErrTagExists 가 오면 500 이었다. 그 폴백이 사라지는
// 것은 **500 을 옳은 4xx 로 좁히는 방향뿐**이며, 이미 있던 4xx 를 다른 값으로
// 바꾸지 않는다. 위 표가 그것을 보장한다 — 표의 모든 줄이 리팩터 전 값이다.
//
// 이 테스트는 그 좁힘이 실제로 일어남을 못 박는다.
func TestGitTableIsSurfaceIndependent(t *testing.T) {
	// 태그의 sentinel 이지만 브랜치 핸들러에서 나와도 같은 답을 받는다.
	status, code, ok := Git.Lookup(fmt.Errorf("브랜치 경로에서: %w", write.ErrTagExists))
	if !ok || status != http.StatusConflict || code != CodeTagExists {
		t.Fatalf("표면 독립이 깨졌다: %d %q %v", status, code, ok)
	}
}
