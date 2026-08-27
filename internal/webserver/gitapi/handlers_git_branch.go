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
	case errors.Is(err, write.ErrCheckoutTarget),
		errors.Is(err, write.ErrBranchRename),
		errors.Is(err, write.ErrBranchDelete),
		errors.Is(err, write.ErrMergeMode),
		errors.Is(err, write.ErrBranchUpstream):
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
	case errors.Is(err, write.ErrBranchExists):
		gitFail(w, http.StatusConflict, gitErrBranchExists, gitTail(err.Error()))
	default:
		gitError(w, err)
	}
}

// ── 묶음 B — 브랜치 동작의 서버 표면 (GIT_ACTIONS_SRS §3.2 · §3.5) ──
//
// 규약은 위와 같다: `gitResolveRepo` → `gitStatusBefore` → `gitApply` →
// `gitWriteOK`. 원격으로 나가는 셋(push · fetch into local · 원격 ref 삭제)만
// 기존 job 경로를 탄다 (FR-GIT-101~104) — 분 단위이고 취소할 수 있어야 한다.
//
// **서버가 마지막 방어선이다.** 파괴적 동작의 confirm, 현재 브랜치 삭제 금지,
// 일괄 강제 삭제 금지를 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.

const (
	// gitErrBranchNotMerged 는 `-d` 가 거부할 상태라는 것이다. **실패가 아니라
	// 선택지다** (FR-GIT-254) — 그래서 코드도 사유도 따로 있다.
	gitErrBranchNotMerged = "branch_not_merged"
	// gitErrBranchCurrent 는 현재 브랜치를 지우려 했다는 것이다.
	gitErrBranchCurrent = "branch_is_current"
)

type gitBranchRenameReq struct {
	Repo string `json:"repo"`
	From string `json:"from"`
	To   string `json:"to"`
}

type gitBranchDeleteReq struct {
	Repo    string   `json:"repo"`
	Names   []string `json:"names"`
	Force   bool     `json:"force"`
	Confirm bool     `json:"confirm"`
}

type gitBranchMergeReq struct {
	Repo string `json:"repo"`
	Ref  string `json:"ref"`
	Mode string `json:"mode"`
}

type gitBranchRebaseReq struct {
	Repo    string `json:"repo"`
	Ref     string `json:"ref"`
	Onto    string `json:"onto"`
	Confirm bool   `json:"confirm"`
}

type gitBranchUpstreamReq struct {
	Repo     string `json:"repo"`
	Branch   string `json:"branch"`
	Upstream string `json:"upstream"`
	Unset    bool   `json:"unset"`
}

type gitBranchPushReq struct {
	Repo    string `json:"repo"`
	Branch  string `json:"branch"`
	Force   string `json:"force"`
	Confirm bool   `json:"confirm"`
	Publish bool   `json:"publish"`
}

type gitRemoteBranchReq struct {
	Repo    string `json:"repo"`
	Remote  string `json:"remote"`
	Branch  string `json:"branch"`
	Confirm bool   `json:"confirm"`
}

// POST /api/git/branch/rename — `git branch -m` (FR-GIT-253).
//
// 새 이름의 검사는 생성과 **같은 자리**다 (`gitBranchNameTaken`) — 중복은 409 이며
// 실행되지 않는다.
func (s *GitServer) apiGitBranchRename(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitBranchRenameReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	opts := write.BranchRenameOpts{From: req.From, To: req.To}
	if _, err := write.BranchRenameArgs(opts); err != nil {
		gitBranchError(w, err)
		return
	}
	if s.gitBranchNameTaken(w, r, req.Repo, root, req.To, "") {
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := write.BranchRename(s.Git.Service(), ctx, root, opts)
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// POST /api/git/branch/delete — `git branch -d|-D` (FR-GIT-254).
//
// **파괴적이다.** `confirm:true` 없이는 실행하지 않는다 (FR-GIT-89). `-D` 는
// 사용자가 명시할 때만이며 여러 개를 한 번에 강제로 지우지 않는다.
//
// 현재 브랜치와 미머지 브랜치는 **실행 전에** 답한다 — 미머지는 실패가 아니라
// `-D` 로 올릴 선택지이며, 그 선택지 목록도 서버가 준다 (FR-GIT-254).
func (s *GitServer) apiGitBranchDelete(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitBranchDeleteReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"브랜치 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89·254)")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	opts := write.BranchDeleteOpts{Names: req.Names, Force: req.Force}
	if _, err := write.BranchDeleteArgs(opts); err != nil {
		gitBranchError(w, err)
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	if s.gitBranchDeleteBlocked(w, r, req.Repo, root, before, opts) {
		return
	}
	plan := write.BranchDeletePlan{}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		var err error
		_, plan, err = write.BranchDelete(s.Git.Service(), ctx, root, opts)
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, map[string]any{"deleted": plan})
}

// gitBranchDeleteBlocked 는 실행 **전에** 막아야 하는 둘을 본다. 참이면 응답이
// 이미 쓰였다는 뜻이다.
//
// ① 현재 브랜치 — git 도 거부하지만 exit 128 의 문구로만 답한다.
// ② 미머지 브랜치(`-d` 일 때만) — **실패가 아니라 선택지다.** 무엇을 고를 수
//
//	있는지 모르면 사용자는 갈 곳이 없다.
func (s *GitServer) gitBranchDeleteBlocked(w http.ResponseWriter, r *http.Request,
	requested, root string, before query.Status, opts write.BranchDeleteOpts) bool {
	for _, n := range opts.Names {
		if !before.Detached && n == before.Branch {
			gitJSON(w, http.StatusConflict, map[string]any{
				"error": gitErrBranchCurrent, "requested": requested, "repo": root,
				"branch": n, "message": "현재 브랜치 " + n + " 는 지울 수 없다",
			})
			return true
		}
	}
	if opts.Force {
		return false
	}
	for _, n := range opts.Names {
		merged, err := query.BranchMerged(s.Git.Service(), r.Context(), root, n)
		if err != nil {
			gitError(w, err)
			return true
		}
		if merged {
			continue
		}
		oid, err := query.BranchOid(s.Git.Service(), r.Context(), root, n)
		if err != nil {
			gitError(w, err)
			return true
		}
		gitJSON(w, http.StatusConflict, map[string]any{
			"error": gitErrBranchNotMerged, "requested": requested, "repo": root,
			"branch": n, "oid": oid,
			"message": n + " 는 아직 합쳐지지 않았다 — 지우면 그 커밋들은 reflog 에만 남는다",
			// 여러 개를 한 번에 강제 삭제하는 자리를 만들지 않는다 (FR-GIT-254).
			"options": gitBranchDeleteOptions(len(opts.Names)),
		})
		return true
	}
	return false
}

// gitBranchDeleteOptions 는 미머지 거부 뒤의 선택지다. 대상이 여럿이면 `-D` 로
// 올리는 선택지를 **주지 않는다** — 확인 하나가 여러 개를 강제 삭제하게 된다.
func gitBranchDeleteOptions(n int) []string {
	if n > 1 {
		return []string{write.BranchDeleteCancel}
	}
	return write.BranchDeleteOptions
}

// POST /api/git/branch/merge — 대상 ref 를 현재 브랜치에 합친다 (FR-GIT-255).
//
// **충돌은 실패가 아니라 진행 중 상태다** (FR-GIT-251). 여기서는 git 의 종료를
// 그대로 올리고, 응답에 실린 실행 후 status 의 `operation` 이 그 사실을 말한다 —
// 우리가 충돌을 미리 판정하지 않는다.
func (s *GitServer) apiGitBranchMerge(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitBranchMergeReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	opts := write.MergeOpts{Ref: req.Ref, Mode: req.Mode}
	if _, err := write.MergeArgs(opts); err != nil {
		gitBranchError(w, err)
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := write.Merge(s.Git.Service(), ctx, root, opts)
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// POST /api/git/branch/rebase — 대상 ref 위로 현재 브랜치를 다시 얹는다
// (FR-GIT-256). **파괴적이다** — 커밋 해시가 바뀐다.
func (s *GitServer) apiGitBranchRebase(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitBranchRebaseReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"rebase 는 커밋 해시를 바꾼다: confirm:true 를 요구한다 (FR-GIT-89·256)")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	opts := write.RebaseOpts{Ref: req.Ref, Onto: req.Onto}
	if _, err := write.RebaseArgs(opts); err != nil {
		gitBranchError(w, err)
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := write.Rebase(s.Git.Service(), ctx, root, opts)
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// POST /api/git/branch/upstream — set / unset (FR-GIT-257). 파괴적이 아니다 —
// 되돌리는 것이 set 하나다.
func (s *GitServer) apiGitBranchUpstream(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitBranchUpstreamReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	opts := write.UpstreamOpts{Branch: req.Branch, Upstream: req.Upstream, Unset: req.Unset}
	if _, err := write.UpstreamArgs(opts); err != nil {
		gitBranchError(w, err)
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := write.SetUpstream(s.Git.Service(), ctx, root, opts)
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// GET /api/git/branch/merge-preview?repo=&ref= — 머지 한 번의 영향 범위
// (FR-GIT-255, G11).
//
// **판정을 200 의 본문에 담는다** — 다이얼로그를 열기 전에 부르는 조회이고,
// "합칠 것이 없다"는 요청 실패가 아니다.
func (s *GitServer) apiGitBranchMergePreview(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	ref := r.URL.Query().Get("ref")
	if err := core.CheckRefArg("ref", ref); err != nil {
		gitBranchError(w, err)
		return
	}
	im, err := query.MergePreview(s.Git.Service(), r.Context(), root, ref)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"requested": map[string]any{"repo": requested, "ref": ref},
		"repo":      root,
		"preview":   im,
	})
}

// POST /api/git/branch/push — 대상 브랜치 하나를 민다 (FR-GIT-258).
//
// 원격으로 나가므로 기존 job 경로를 그대로 탄다 (FR-GIT-101~104). upstream 이
// 없으면 publish 이며 그 사실을 **실행 전에** 되묻는다 — 대상이 현재 브랜치가
// 아니어도 같다.
func (s *GitServer) apiGitBranchPush(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitBranchPushReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	spec, plan, err := write.BranchPushSpec(s.Git.Service(), r.Context(), root, write.BranchPushOpts{
		Branch: req.Branch, Force: req.Force, Confirm: req.Confirm, Publish: req.Publish,
	})
	if err != nil {
		gitPushError(w, req.Repo, root, plan, err)
		return
	}
	s.gitStartJob(w, req.Repo, root, "push", spec, map[string]any{"plan": plan})
}

// POST /api/git/branch/fetch — 원격 ref 를 같은 이름의 로컬 ref 로 가져온다
// (FR-GIT-268). 원격으로 나가므로 job 경로다.
func (s *GitServer) apiGitBranchFetchInto(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitRemoteBranchReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	spec, err := write.RemoteFetchSpec(write.RemoteBranchOpts{Remote: req.Remote, Branch: req.Branch})
	if err != nil {
		gitBranchError(w, err)
		return
	}
	s.gitStartJob(w, req.Repo, root, "fetch", spec, nil)
}

// POST /api/git/branch/delete-remote — 원격의 ref 를 지운다 (FR-GIT-268).
//
// **파괴적이다** (`remote_ref_delete`). `confirm:true` 없이는 실행하지 않으며,
// 되살리는 push 는 spec 을 만들 때 hint 로 남는다.
func (s *GitServer) apiGitBranchDeleteRemote(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitRemoteBranchReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"원격 ref 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89·268)")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	spec, err := write.RemoteBranchDeleteSpec(s.Git.Service(), r.Context(), root,
		write.RemoteBranchOpts{Remote: req.Remote, Branch: req.Branch})
	if err != nil {
		gitBranchError(w, err)
		return
	}
	s.gitStartJob(w, req.Repo, root, "push", spec, nil)
}
