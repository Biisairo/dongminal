package gitapi

import (
	"context"
	"errors"
	"net/http"

	"dongminal/internal/webserver/domain/git/core"
)

// /api/git/stash{,/push,/apply,/pop,/drop,/show} — stash 표면
// (GIT_SRS §3D.2 FR-GIT-161~170).
//
// **서버가 마지막 방어선이다.** drop 의 2단계 확인과 "담을 것이 없다" 를
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.

// stash 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const (
	gitErrNothingToStash = "nothing_to_stash"
	// gitErrStashKept 는 **pop 이 끝나지 않아 stash 가 남았다**는 것이다
	// (FR-GIT-165). 500 으로 뭉개면 클라이언트가 "작업은 남아 있다"를 말할 근거를
	// 잃고, 사용자는 작업을 잃었다고 오해한다.
	gitErrStashKept = "stash_kept"
)

// gitStashPushReq 는 생성 다이얼로그의 본문이다 (FR-GIT-166).
type gitStashPushReq struct {
	Repo             string `json:"repo"`
	Message          string `json:"message"`
	IncludeUntracked bool   `json:"includeUntracked"`
	KeepIndex        bool   `json:"keepIndex"`
}

// gitStashIndexReq 는 apply/pop/drop 의 본문이다.
//
// WithIndex 는 `--index` 다 (FR-GIT-163). Confirm 은 drop 의 2단계 확인이다
// (FR-GIT-168) — 파괴적 동작이므로 확인 없이는 실행되지 않는다.
type gitStashIndexReq struct {
	Repo      string `json:"repo"`
	Index     int    `json:"index"`
	WithIndex bool   `json:"withIndex"`
	Confirm   bool   `json:"confirm"`
}

type gitStashListRequested struct {
	Repo string `json:"repo"`
}

type gitStashListResponse struct {
	Requested gitStashListRequested `json:"requested"`
	Repo      string                `json:"repo"`
	Stashes   []core.Stash          `json:"stashes"`
}

// gitStashShowRequested 의 식별자는 (리포, 인덱스) 다 — stale 가드의 서버측
// 절반이며, 인덱스가 빠지면 뒤늦게 온 다른 stash 의 응답을 자기 것으로 읽는다.
type gitStashShowRequested struct {
	Repo  string `json:"repo"`
	Index int    `json:"index"`
}

type gitStashShowResponse struct {
	Requested gitStashShowRequested `json:"requested"`
	Repo      string                `json:"repo"`
	Files     []core.CommitFile     `json:"files"`
}

// GET /api/git/stash?repo= — stash 목록 (FR-GIT-161).
func (s *GitServer) apiGitStashList(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	list, err := s.Git.Service().StashList(r.Context(), root)
	if err != nil {
		gitStashError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitStashListResponse{
		Requested: gitStashListRequested{Repo: requested}, Repo: root, Stashes: list,
	})
}

// GET /api/git/stash/show?repo=&index= — 선택한 stash 의 변경 파일 (FR-GIT-169).
func (s *GitServer) apiGitStashShow(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	index, ok := gitCountParam(w, r.URL.Query(), "index")
	if !ok {
		return
	}
	files, err := s.Git.Service().StashPreview(r.Context(), root, index)
	if err != nil {
		gitStashError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitStashShowResponse{
		Requested: gitStashShowRequested{Repo: requested, Index: index}, Repo: root, Files: files,
	})
}

// POST /api/git/stash/push — 워킹 트리의 변경을 stash 로 옮긴다 (FR-GIT-166·167).
func (s *GitServer) apiGitStashPush(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitStashPushReq
	if !gitDecodeBody(w, r, &req) {
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
	// 담을 것이 없으면 **실행하지 않는다** (FR-GIT-167). git 은 그 실행을 exit 0 으로
	// 끝내므로 성공으로 답하면 사용자는 만들어지지 않은 stash 를 찾는다.
	if core.StashableCount(before, req.IncludeUntracked) == 0 {
		gitJSON(w, http.StatusConflict, map[string]any{
			"error":     gitErrNothingToStash,
			"message":   core.StashEmptyReason(before, req.IncludeUntracked),
			"requested": req.Repo,
			"repo":      root,
			"status":    before,
		})
		return
	}
	opts := core.StashPushOpts{
		Message:          req.Message,
		IncludeUntracked: req.IncludeUntracked,
		KeepIndex:        req.KeepIndex,
	}
	s.gitStashApply(w, r, req.Repo, root, before, func(ctx context.Context) (map[string]any, error) {
		_, err := s.Git.Service().StashPush(ctx, root, opts)
		return nil, err
	})
}

// POST /api/git/stash/apply — stash 를 얹고 **남긴다** (FR-GIT-163).
func (s *GitServer) apiGitStashApply(w http.ResponseWriter, r *http.Request) {
	s.gitStashIndexRoute(w, r, false, func(ctx context.Context, root string, req gitStashIndexReq) (map[string]any, error) {
		_, err := s.Git.Service().StashApply(ctx, root, req.Index, req.WithIndex)
		return nil, err
	})
}

// POST /api/git/stash/pop — stash 를 얹고 지운다 (FR-GIT-164).
//
// **충돌로 끝나면 git 이 stash 를 남긴다** (FR-GIT-165). 그 사실을 확인해 응답에
// 담는다 — 조용히 넘기면 사용자는 작업을 잃었다고 오해한다.
func (s *GitServer) apiGitStashPop(w http.ResponseWriter, r *http.Request) {
	s.gitStashIndexRoute(w, r, false, func(ctx context.Context, root string, req gitStashIndexReq) (map[string]any, error) {
		_, kept, err := s.Git.Service().StashPopChecked(ctx, root, req.Index, req.WithIndex)
		return map[string]any{
			"stashKept":       kept.Kept,
			"stashKeptReason": kept.Reason,
			"stashKeptOid":    kept.Oid,
		}, err
	})
}

// POST /api/git/stash/drop — stash 를 지운다. **파괴적이다** (FR-GIT-89·168).
//
// `confirm:true` 가 없으면 실행하지 않는다. recovery hint 는 git 패키지가 실행
// **전에** 남긴다 (FR-GIT-92).
func (s *GitServer) apiGitStashDrop(w http.ResponseWriter, r *http.Request) {
	s.gitStashIndexRoute(w, r, true, func(ctx context.Context, root string, req gitStashIndexReq) (map[string]any, error) {
		_, err := s.Git.Service().StashDrop(ctx, root, req.Index)
		return nil, err
	})
}

// gitStashIndexRoute 는 apply/pop/drop 의 공통 절차다. 셋은 본문과 응답이 같고
// 실행하는 것과 확인을 요구하는지만 다르다.
func (s *GitServer) gitStashIndexRoute(w http.ResponseWriter, r *http.Request, confirm bool, run func(context.Context, string, gitStashIndexReq) (map[string]any, error)) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitStashIndexReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if confirm && !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89·168)")
		return
	}
	// 인덱스는 인자로 넘기기 전에 본다 — `stash@{-1}` 은 git 에서 다른 뜻이 된다.
	if _, err := core.StashRef(req.Index); err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
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
	s.gitStashApply(w, r, req.Repo, root, before, func(ctx context.Context) (map[string]any, error) {
		return run(ctx, root, req)
	})
}

// gitStashApply 는 stash 쓰기 한 번을 실행하고 **목록과 상태를 다시 찍는다**
// (FR-GIT-170) — 폴링 주기를 기다리면 화면이 그만큼 거짓말을 한다.
//
// gitApply 를 쓰지 않는 이유는 실패 응답에 담을 것이 다르기 때문이다. pop 이
// 충돌로 끝나면 stash 가 남고(FR-GIT-165), 그 사실과 남은 목록이 **실패 응답에**
// 있어야 한다.
//
// extra 는 실행이 알아낸 사실이며 성공·실패 양쪽에 실린다.
func (s *GitServer) gitStashApply(w http.ResponseWriter, r *http.Request, requested, root string, before core.Status, run func(context.Context) (map[string]any, error)) {
	extra, runErr := run(r.Context())
	s.Git.Invalidate(root)
	obs, _, statusErr := s.Git.Status(r.Context(), root)

	body := map[string]any{"requested": requested, "repo": root, "partial": false}
	for k, v := range extra {
		body[k] = v
	}
	if statusErr == nil {
		body["status"] = obs.Status
		// 목록 조회의 실패로 응답을 버리지 않는다 — 실행 결과가 더 중요하다.
		if list, err := s.Git.Service().StashList(r.Context(), root); err == nil {
			body["stashes"] = list
		}
		if changed := gitStatusDelta(before, obs.Status); len(changed) > 0 && runErr != nil {
			body["partial"], body["changed"] = true, changed
		}
	}
	if runErr == nil {
		if statusErr != nil {
			// 실행은 됐고 재조회가 실패했다. 성공으로 보이면 화면이 낡은 목록을
			// 유지하므로 실패로 답한다.
			gitError(w, statusErr)
			return
		}
		body["ok"] = true
		gitJSON(w, http.StatusOK, body)
		return
	}
	code, name := gitStashErrorCode(runErr, extra)
	body["error"], body["message"] = name, gitTail(runErr.Error())
	gitJSON(w, code, body)
}

// gitStashErrorCode 는 stash 고유의 거부를 코드로 옮긴 뒤 나머지를 공용 규약에
// 넘긴다.
//
// **stash 가 남은 실패가 가장 앞이다** (FR-GIT-165) — 그것이 사용자가 알아야 할
// 사실이고, 종료 코드로 갈리는 다른 사유보다 앞선다.
func gitStashErrorCode(err error, extra map[string]any) (int, string) {
	if kept, _ := extra["stashKept"].(bool); kept {
		return http.StatusConflict, gitErrStashKept
	}
	switch {
	case errors.Is(err, core.ErrStashEmpty):
		return http.StatusConflict, gitErrNothingToStash
	case errors.Is(err, core.ErrStashNotFound):
		return http.StatusNotFound, gitErrNotFound
	}
	return gitWriteErrorCode(err)
}

// gitStashError 는 읽기 경로(목록·미리보기)의 거부를 코드로 옮긴다.
func gitStashError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, core.ErrStashNotFound):
		gitFail(w, http.StatusNotFound, gitErrNotFound, gitTail(err.Error()))
	case errors.Is(err, core.ErrUnsafeArgument):
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
	default:
		gitError(w, err)
	}
}
