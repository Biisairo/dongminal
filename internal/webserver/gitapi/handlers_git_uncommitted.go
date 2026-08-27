package gitapi

import (
	"context"
	"net/http"

	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/uncommitted/{reset,clean} — History 의 미커밋 행 메뉴
// (GIT_ACTIONS_SRS §3.6 FR-GIT-277, 검증 V203).
//
// 세 항목 중 Stash 는 이미 있는 `/api/git/stash/push` 를 그대로 쓴다 — 생성
// 다이얼로그를 다시 만들지 않는다. 여기 오는 것은 나머지 둘이다.
//
// **서버가 마지막 방어선이다.** Clean 의 2단계 확인을 클라이언트만 막으면 API
// 직접 호출이 그대로 우회한다.

// 이 표면 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const (
	gitErrNoHead         = "no_head"
	gitErrNothingToClean = "nothing_to_clean"
)

// gitUncommittedReq 는 두 동작의 공통 본문이다. Confirm 은 clean 의 2단계 확인이다
// (FR-GIT-89·277).
type gitUncommittedReq struct {
	Repo    string `json:"repo"`
	Confirm bool   `json:"confirm"`
}

// POST /api/git/uncommitted/reset — index 를 HEAD 로 되돌린다 (mixed, FR-GIT-277).
//
// **파괴적이 아니다** — 워킹 트리의 내용은 그대로 남는다. 그래서 확인을 요구하지
// 않는다: 안전한 것에 확인을 붙이면 확인이 뜻을 잃는다 (FR-GIT-97).
func (s *GitServer) apiGitUncommittedReset(w http.ResponseWriter, r *http.Request) {
	s.gitUncommittedRoute(w, r, false, gitResetBlocked, func(ctx context.Context, root string) error {
		_, err := write.UncommittedReset(s.Git.Service(), ctx, root)
		return err
	})
}

// POST /api/git/uncommitted/clean — 추적되지 않는 파일을 지운다. **파괴적이다**
// (FR-GIT-89·277).
//
// `confirm:true` 가 없으면 실행하지 않는다. recovery hint 는 git 패키지가 실행
// **전에** 남긴다 (FR-GIT-92) — 되살릴 수 없으므로 hint 는 되돌리는 명령이 아니라
// 먼저 담아 두는 명령(`git stash push -u`)이다.
func (s *GitServer) apiGitUncommittedClean(w http.ResponseWriter, r *http.Request) {
	s.gitUncommittedRoute(w, r, true, gitCleanBlocked, func(ctx context.Context, root string) error {
		_, err := write.CleanUntracked(s.Git.Service(), ctx, root)
		return err
	})
}

// gitResetBlocked 는 커밋이 없어 HEAD 로 되돌릴 수 없다는 것이다. `Initial` 은
// status 가 이미 아는 사실이므로 따로 묻지 않는다.
func gitResetBlocked(st query.Status) (string, string) {
	if st.Initial {
		return gitErrNoHead, "커밋이 없어 HEAD 로 되돌릴 수 없다"
	}
	return "", ""
}

// gitCleanBlocked 는 지울 것이 없다는 것이다 (StashPush 의 `nothing_to_stash` 와
// 같은 규약) — git 은 그 실행을 exit 0 으로 끝내므로 성공으로 답하면 사용자는
// 지워진 것이 있다고 읽는다.
func gitCleanBlocked(st query.Status) (string, string) {
	if len(st.Untracked) == 0 {
		return gitErrNothingToClean, "추적되지 않는 파일이 없다"
	}
	return "", ""
}

// gitUncommittedRoute 는 두 동작의 공통 절차다. 둘은 본문과 응답이 같고 실행하는
// 것·확인을 요구하는지·실행 전 거부 사유만 다르다 — 나머지는 기존 쓰기 규약
// 그대로다 (FR-GIT-250 ③).
func (s *GitServer) gitUncommittedRoute(w http.ResponseWriter, r *http.Request, confirm bool, blocked func(query.Status) (string, string), run func(context.Context, string) error) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitUncommittedReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if confirm && !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89·277)")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	// 실행 전 거부는 **실행 전 상태로** 판정한다 (StashPush 의 선례). write 패키지도
	// 같은 것을 다시 막지만, 여기서 걸러야 사유가 코드로 온다.
	if name, msg := blocked(before); name != "" {
		gitJSON(w, http.StatusConflict, map[string]any{
			"error": name, "message": msg,
			"requested": req.Repo, "repo": root, "status": before,
		})
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		return run(ctx, root)
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}
