package gitapi

import (
	"context"
	"errors"
	"net/http"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/{checkout,branch} + /api/git/branch/validate — 브랜치 표면
// (GIT_SRS §3D.1 FR-GIT-155~160).
//
// **목록은 /api/git/refs 다** (FR-GIT-147) — 14단계가 이름·대상·upstream·
// ahead/behind 를 이미 준다. 여기에 새 조회를 만들지 않는다.
//
// **서버가 마지막 방어선이다.** force 의 확인·이름 규칙·이름 충돌을 클라이언트만
// 막으면 API 직접 호출이 그대로 우회한다.

// 브랜치 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const (
	gitErrRefName      = "ref_name_invalid"
	gitErrBranchExists = "branch_exists"
)

// gitCheckoutReq 는 checkout 의 본문이다.
//
// Confirm 은 `force` 의 2단계 확인이다 (FR-GIT-89·157) — force 는 워킹 트리의
// 변경을 버리므로 기본이 아니고(O14), 확인 없이는 실행되지 않는다.
type gitCheckoutReq struct {
	Repo    string `json:"repo"`
	Ref     string `json:"ref"`
	Create  string `json:"create"`
	Track   string `json:"track"`
	Detach  bool   `json:"detach"`
	Force   bool   `json:"force"`
	Confirm bool   `json:"confirm"`
}

// gitBranchReq 는 생성 다이얼로그의 본문이다 (FR-GIT-158).
type gitBranchReq struct {
	Repo     string `json:"repo"`
	Name     string `json:"name"`
	StartRef string `json:"startRef"`
	Checkout bool   `json:"checkout"`
}

// POST /api/git/checkout — 워킹 트리를 다른 ref 로 옮긴다 (FR-GIT-155·156·157).
func (s *GitServer) apiGitCheckout(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitCheckoutReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	// force 는 워킹 트리의 변경을 버린다 — 파괴적이며 기본이 아니다 (FR-GIT-97·157).
	if req.Force && !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"force checkout 은 워킹 트리의 변경을 버린다: confirm:true 를 요구한다 (FR-GIT-89·157)")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	opts := write.CheckoutOpts{Ref: req.Ref, Create: req.Create, Track: req.Track, Detach: req.Detach, Force: req.Force}
	// 잘못된 요청은 실행 **전에** 답한다. gitApply 를 지나면 코드가 500 이 되고,
	// 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
	if _, err := write.CheckoutArgs(opts); err != nil {
		gitBranchError(w, err)
		return
	}
	if s.gitBranchNameTaken(w, r, req.Repo, root, req.Create, req.Track) {
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := write.Checkout(s.Git.Service(), ctx, root, opts)
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// POST /api/git/branch — 브랜치를 만든다 (FR-GIT-158·159·160).
func (s *GitServer) apiGitBranchCreate(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitBranchReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	opts := write.BranchCreateOpts{Name: req.Name, StartRef: req.StartRef, Checkout: req.Checkout}
	if _, err := write.BranchCreateArgs(opts); err != nil {
		gitBranchError(w, err)
		return
	}
	if s.gitBranchNameTaken(w, r, req.Repo, root, req.Name, "") {
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := write.BranchCreate(s.Git.Service(), ctx, root, opts)
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// GET /api/git/branch/validate?repo=&name= — 이름 규칙 검사 (FR-GIT-159).
//
// **위반을 요청 실패로 답하지 않는다.** 입력 중 부르는 엔드포인트이므로 판정은
// 200 의 본문에 담긴다 — 400 이면 클라이언트가 "규칙 위반"과 "요청이 틀렸다"를
// 구분할 수 없다.
//
// exists 는 규칙 위반이 아니다 (FR-GIT-156) — 같은 이름이 이미 있다는 사실은 따로
// 알려야 클라이언트가 다른 이름을 권할 수 있다.
func (s *GitServer) apiGitBranchValidate(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	name := r.URL.Query().Get("name")
	body := map[string]any{
		"requested": map[string]any{"repo": requested, "name": name},
		"repo":      root,
		"ok":        true,
		"reason":    "",
		"exists":    false,
	}
	if err := query.ValidBranchName(s.Git.Service(), r.Context(), root, name); err != nil {
		if !errors.Is(err, core.ErrRefName) {
			// 이름의 문제가 아니라 저장소·git 의 문제다. 판정으로 뭉개면 사용자는
			// 이름을 고치며 헤맨다.
			gitError(w, err)
			return
		}
		body["ok"], body["reason"] = false, gitTail(err.Error())
		gitJSON(w, http.StatusOK, body)
		return
	}
	exists, err := query.LocalBranchExists(s.Git.Service(), r.Context(), root, name)
	if err != nil {
		gitError(w, err)
		return
	}
	body["exists"] = exists
	gitJSON(w, http.StatusOK, body)
}

// gitBranchNameTaken 은 이름 충돌을 실행 **전에** 답한다 (FR-GIT-156).
//
// **선택지를 함께 준다** — 무엇을 고를 수 있는지 모르면 사용자는 갈 곳이 없고,
// 클라이언트가 목록을 복제하면 서버가 선택지를 늘려도 그것을 보이지 못한다.
//
// 참을 돌려주면 응답이 이미 쓰였다는 뜻이다.
func (s *GitServer) gitBranchNameTaken(w http.ResponseWriter, r *http.Request, requested, root, name, track string) bool {
	if name == "" {
		return false
	}
	if err := query.ValidBranchName(s.Git.Service(), r.Context(), root, name); err != nil {
		gitBranchError(w, err)
		return true
	}
	exists, err := query.LocalBranchExists(s.Git.Service(), r.Context(), root, name)
	if err != nil {
		gitError(w, err)
		return true
	}
	if !exists {
		return false
	}
	gitJSON(w, http.StatusConflict, map[string]any{
		"error":     gitErrBranchExists,
		"message":   "로컬 브랜치 " + name + " 가 이미 있다",
		"requested": requested,
		"repo":      root,
		"branch":    name,
		"track":     track,
		"options":   write.BranchConflictOptions,
	})
	return true
}

// gitBranchError 는 브랜치 고유의 거부를 코드로 옮긴 뒤 나머지를 공용 규약에
// 넘긴다. 잘못된 요청을 500 으로 뭉개면 클라이언트는 자기 요청이 틀렸다는 것을
// 알 수 없다.
func gitBranchError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, core.ErrRefName):
		gitFail(w, http.StatusBadRequest, gitErrRefName, gitTail(err.Error()))
	case errors.Is(err, write.ErrCheckoutTarget):
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
	case errors.Is(err, write.ErrBranchExists):
		gitFail(w, http.StatusConflict, gitErrBranchExists, gitTail(err.Error()))
	default:
		gitError(w, err)
	}
}
