package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/uuid"
	"dongminal/internal/webserver/domain/git"
)

// /api/git/{stage,unstage,discard,commit,undo-last} — 저장소를 바꾸는 표면
// (GIT_SRS §3A.1·§3A.2 FR-GIT-64~85).
//
// **서버가 마지막 방어선이다.** 확인·preflight·undo 만료를 클라이언트만 막으면
// `dmctl git …` 과 API 직접 호출이 그대로 우회한다. 그래서 여기서 다시 검사한다.

// 쓰기 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const (
	gitErrConfirmRequired  = "confirmation_required"
	gitErrPreflightBlocked = "preflight_blocked"
	gitErrUndoExpired      = "undo_expired"
	gitErrEmptyMessage     = "empty_message"
	gitErrNothingStaged    = "nothing_staged"
)

// gitPathsReq 는 stage/unstage 의 본문이다.
type gitPathsReq struct {
	Repo  string   `json:"repo"`
	Paths []string `json:"paths"`
}

// gitDiscardReq 는 discard 의 본문이다. tracked 와 untracked 가 갈라져 오는 이유는
// 실행 명령이 다르기 때문이다 (`checkout` vs `clean`).
type gitDiscardReq struct {
	Repo      string   `json:"repo"`
	Tracked   []string `json:"tracked"`
	Untracked []string `json:"untracked"`
	Confirm   bool     `json:"confirm"`
}

// gitResolveReq 는 충돌 해결 한 번의 본문이다 (FR-GIT-224).
type gitResolveReq struct {
	Repo    string   `json:"repo"`
	Side    string   `json:"side"` // ours | theirs
	Paths   []string `json:"paths"`
	Confirm bool     `json:"confirm"`
}

// gitCommitReq 는 커밋 한 번의 본문이다. 메시지는 **본문으로만** 받는다 — 쿼리
// 파라미터는 접근 로그에 남는다 (FR-GIT-61).
type gitCommitReq struct {
	Repo     string `json:"repo"`
	Message  string `json:"message"`
	Amend    bool   `json:"amend"`
	SignOff  bool   `json:"signoff"`
	NoVerify bool   `json:"noVerify"`
	All      bool   `json:"all"`
}

type gitUndoReq struct {
	Repo      string `json:"repo"`
	UndoToken string `json:"undoToken"`
}

// POST /api/git/stage — 경로들을 index 에 올린다 (FR-GIT-64·66·68·69).
func (s *Server) apiGitStage(w http.ResponseWriter, r *http.Request) {
	s.gitStageRoute(w, r, func(ctx context.Context, root string, paths git.Paths) error {
		_, err := s.Git.Service().Stage(ctx, root, paths)
		return err
	})
}

// POST /api/git/unstage — 경로들을 index 에서 내린다 (FR-GIT-65·67).
func (s *Server) apiGitUnstage(w http.ResponseWriter, r *http.Request) {
	s.gitStageRoute(w, r, func(ctx context.Context, root string, paths git.Paths) error {
		_, err := s.Git.Service().Unstage(ctx, root, paths)
		return err
	})
}

// gitStageRoute 는 stage/unstage 의 공통 절차다. 둘은 본문과 응답이 같고 실행하는
// 명령만 다르다.
func (s *Server) gitStageRoute(w http.ResponseWriter, r *http.Request, run func(context.Context, string, git.Paths) error) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitPathsReq
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
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		return run(ctx, root, git.Paths(req.Paths))
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// POST /api/git/discard — 워킹 트리의 변경을 버린다. **파괴적이다** (FR-GIT-89).
//
// `confirm:true` 가 없으면 실행하지 않는다. 클라이언트만 막으면
// `dmctl git discard` 가 우회한다.
func (s *Server) apiGitDiscard(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitDiscardReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89)")
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
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := s.Git.Service().Discard(ctx, root, git.Paths(req.Tracked), git.Paths(req.Untracked))
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// POST /api/git/resolve — 충돌 파일을 한쪽으로 받고 해결됨으로 표시한다
// (FR-GIT-224). **파괴적이다** — discard 와 같은 경로를 지난다.
func (s *Server) apiGitResolve(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitResolveReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89)")
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
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := s.Git.Service().Resolve(ctx, root, req.Side, git.Paths(req.Paths))
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// POST /api/git/commit — staged 내용을 커밋한다 (FR-GIT-77·79·84).
//
// **preflight 를 서버가 다시 돌린다** (FR-GIT-86). 클라이언트만 막으면
// `dmctl git commit` 이 우회한다.
func (s *Server) apiGitCommitCreate(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitCommitReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	// 메시지 검사가 가장 앞이다 — 비어 있으면 git 은 커밋을 만들지 않고, 사용자는
	// 왜 안 됐는지를 코드로 알아야 한다 (FR-GIT-84).
	if strings.TrimSpace(req.Message) == "" {
		gitFail(w, http.StatusBadRequest, gitErrEmptyMessage, "커밋 메시지가 비었다")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	pf, err := s.Git.Service().Preflight(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	if len(pf.Blocks) > 0 {
		gitJSON(w, http.StatusConflict, map[string]any{
			"error":     gitErrPreflightBlocked,
			"message":   "커밋 전 검사가 막았다",
			"requested": req.Repo,
			"repo":      root,
			"preflight": pf,
		})
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	// `-a` 는 tracked 변경을 스스로 담으므로 staged 가 없어도 커밋할 것이 있다.
	// `--allow-empty` 는 M2 범위 밖이다 (FR-GIT-84).
	if len(before.Staged) == 0 && !req.All {
		gitFail(w, http.StatusBadRequest, gitErrNothingStaged, "staged 변경이 없다")
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := s.Git.Service().Commit(ctx, root, git.CommitOpts{
			Message:  req.Message,
			Amend:    req.Amend,
			SignOff:  req.SignOff,
			NoVerify: req.NoVerify,
			All:      req.All,
		})
		return err
	})
	if !ok {
		return
	}
	// 토큰은 커밋이 성공한 뒤에만 발급한다 — 실패한 커밋에 되돌릴 것은 없다.
	gitWriteOK(w, req.Repo, root, after, map[string]any{
		"oid":       after.Oid,
		"undoToken": s.gitUndo.issue(root),
	})
}

// POST /api/git/undo-last — 직전 커밋을 되돌린다 (FR-GIT-82·83).
//
// 토큰이 없거나·만료됐거나·다른 리포의 것이면 409 다. **만료된 undo 가 실행될 수
// 있어서는 안 된다** — 탭을 멈춰 두거나 요청을 직접 보내면 클라이언트 타이머는
// 우회된다.
func (s *Server) apiGitUndoLast(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitUndoReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	// 실행 **전에** 소비한다. 성공 후에 소비하면 동시에 온 두 요청이 커밋 두 개를
	// 되돌린다 — 한 번의 커밋에 한 번의 undo 다.
	if !s.gitUndo.consume(root, req.UndoToken) {
		gitFail(w, http.StatusConflict, gitErrUndoExpired,
			"undo 창이 지났거나 이미 사용된 토큰이다 (5초)")
		return
	}
	// 메시지는 되돌리기 **전에** 읽는다 — 되돌린 뒤에는 그 커밋이 HEAD 가 아니다.
	msg, err := s.Git.Service().LastCommitMessage(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := s.Git.Service().UndoLast(ctx, root)
		return err
	})
	if !ok {
		return
	}
	// message 로 클라이언트가 입력을 커밋 직전으로 되돌린다 (FR-GIT-82).
	gitWriteOK(w, req.Repo, root, after, map[string]any{"message": msg})
}

// gitStatusBefore 는 실행 전 상태다. 캐시된 값을 써도 된다 — 실패했을 때 무엇이
// 바뀌었는지를 재는 기준선이고, 200ms 안의 관측은 같은 기준선이다.
func (s *Server) gitStatusBefore(w http.ResponseWriter, r *http.Request, root string) (git.Status, bool) {
	obs, _, err := s.Git.Status(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return git.Status{}, false
	}
	return obs.Status, true
}

// gitApply 는 쓰기 한 번을 실행하고 상태를 다시 찍는다.
//
// **캐시를 버린 뒤 재조회한다** (FR-GIT-71) — 캐시된 값을 주면 방금 만든 변경이
// 응답에 없고, 화면은 폴링 주기만큼 거짓말을 한다.
//
// 실패하면 실행 전과 비교해 `partial` 과 **무엇이 바뀌었는지**를 응답에 담는다
// (FR-GIT-73, §7.1 I2). git 의 add/reset/checkout 은 경로별로 처리해 진짜 롤백이
// 없으므로, 요구사항은 부분 적용을 조용히 넘기지 않는 것으로 만족시킨다.
func (s *Server) gitApply(w http.ResponseWriter, r *http.Request, requested, root string, before git.Status, run func(context.Context) error) (git.Status, bool) {
	runErr := run(r.Context())
	s.Git.Invalidate(root)
	obs, _, statusErr := s.Git.Status(r.Context(), root)

	if runErr == nil && statusErr == nil {
		return obs.Status, true
	}
	if runErr == nil {
		// 실행은 됐고 재조회가 실패했다. 결과를 성공으로 보이면 화면이 낡은 목록을
		// 유지하므로 실패로 답한다.
		gitError(w, statusErr)
		return git.Status{}, false
	}

	code, name := gitWriteErrorCode(runErr)
	body := map[string]any{
		"error":     name,
		"message":   gitTail(runErr.Error()),
		"requested": requested,
		"repo":      root,
		"partial":   false,
	}
	var be *git.BatchError
	if errors.As(runErr, &be) && be.Partial() {
		body["partial"] = true
	}
	if statusErr == nil {
		if changed := gitStatusDelta(before, obs.Status); len(changed) > 0 {
			body["partial"] = true
			body["changed"] = changed
		}
		body["status"] = obs.Status
	}
	gitJSON(w, code, body)
	return git.Status{}, false
}

// gitWriteErrorCode 는 쓰기 고유의 거부를 코드로 옮긴 뒤 나머지를 공용 규약에
// 넘긴다. 잘못된 요청을 500 으로 뭉개면 클라이언트는 자기 요청이 틀렸다는 것을
// 알 수 없다.
func gitWriteErrorCode(err error) (int, string) {
	if errors.Is(err, git.ErrUnsafeArgument) || errors.Is(err, git.ErrWriteCommand) {
		return http.StatusBadRequest, gitErrBadRequest
	}
	return gitErrorCode(err)
}

// gitWriteOK 는 쓰기 성공 응답이다. **실행 후 status 를 함께 담는다** (FR-GIT-71)
// — 클라이언트가 폴링 주기를 기다리지 않는다.
func gitWriteOK(w http.ResponseWriter, requested, root string, st git.Status, extra map[string]any) {
	body := map[string]any{
		"requested": requested,
		"repo":      root,
		"ok":        true,
		"partial":   false,
		"status":    st,
	}
	for k, v := range extra {
		body[k] = v
	}
	gitJSON(w, http.StatusOK, body)
}

// gitStatusDelta 는 실행 전후로 달라진 경로들이다. 이름으로 말해야 사용자가 부분
// 적용을 확인할 수 있다 — "무언가 바뀌었다"는 안내는 확인할 수 없다.
func gitStatusDelta(before, after git.Status) []string {
	b, a := gitEntryStates(before), gitEntryStates(after)
	seen := map[string]bool{}
	out := []string{}
	for p, xy := range a {
		if b[p] != xy && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for p := range b {
		if _, ok := a[p]; !ok && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// gitEntryStates 는 경로 → XY 다. 한 파일이 staged 와 changes 에 동시에 들 수 있어
// (FR-GIT-70) 그룹을 합쳐 경로로 모은다 — XY 가 그 구분을 이미 담고 있다.
func gitEntryStates(st git.Status) map[string]string {
	out := map[string]string{}
	for _, group := range [][]git.FileEntry{st.Staged, st.Changes, st.Untracked, st.Conflicts} {
		for _, e := range group {
			out[e.Path] = e.XY
		}
	}
	return out
}

// gitDecodeBody 는 JSON 본문을 읽는다. 실패는 400 이며 사유를 그대로 준다 —
// 클라이언트가 자기 요청의 어디가 틀렸는지 알아야 한다.
func gitDecodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "본문을 읽지 못했다: "+err.Error())
		return false
	}
	if err := json.Unmarshal(body, v); err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "본문이 JSON 이 아니다: "+err.Error())
		return false
	}
	return true
}

// gitResolveRepo 는 요청이 보낸 repo 를 정규 루트로 옮긴다 (FR-GIT-62). 쿼리로 오든
// 본문으로 오든 규약은 같다 — 클라이언트가 보낸 경로를 그대로 신뢰해 저장소를
// 바꾸지 않는다.
func (s *Server) gitResolveRepo(w http.ResponseWriter, r *http.Request, requested string) (string, bool) {
	if requested == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "repo 인자가 없다")
		return "", false
	}
	if !filepath.IsAbs(requested) {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "repo 는 절대경로여야 한다")
		return "", false
	}
	root, err := s.Git.RepoRoot(r.Context(), requested)
	if err != nil {
		gitError(w, err)
		return "", false
	}
	return root, true
}

// undoTicket 은 방금 만든 커밋 하나에 대한 되돌리기 권한이다.
type undoTicket struct {
	token   string
	expires time.Time
}

// gitUndoStore 는 리포별로 티켓 **하나**를 쥔다 (FR-GIT-83). 새 커밋이 이전 토큰을
// 밀어내고, 소비되면 사라진다.
//
// 서버가 쥐는 이유는 클라이언트 타이머만으로는 만료를 보장할 수 없기 때문이다 —
// 탭을 멈춰 두거나 요청을 직접 보내면 토스트의 5초는 아무것도 막지 못한다.
type gitUndoStore struct {
	mu      sync.Mutex
	now     func() time.Time // nil 이면 실제 시계다. 테스트가 5초를 기다리지 않게 한다
	tickets map[string]undoTicket
}

// issue 는 리포의 티켓을 새것으로 바꾸고 토큰을 준다. 이전 토큰은 이 순간 무효다.
func (u *gitUndoStore) issue(repo string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.tickets == nil {
		u.tickets = map[string]undoTicket{}
	}
	u.pruneLocked()
	t := undoTicket{token: uuid.NewString(), expires: u.clock().Add(git.UndoTTL)}
	u.tickets[repo] = t
	return t.token
}

// consume 은 토큰이 그 리포의 살아 있는 티켓일 때만 참이며, 그때 티켓을 없앤다.
// 빈 토큰은 언제나 거짓이다 — 토큰 없이 부른 요청이 통과하면 만료가 뜻을 잃는다.
func (u *gitUndoStore) consume(repo, token string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	t, ok := u.tickets[repo]
	if !ok || token == "" || t.token != token || !u.clock().Before(t.expires) {
		return false
	}
	delete(u.tickets, repo)
	return true
}

// pruneLocked 는 만료된 티켓을 버린다. 티켓 수명이 5초이므로 LRU 를 둘 값이 없다.
func (u *gitUndoStore) pruneLocked() {
	now := u.clock()
	for repo, t := range u.tickets {
		if !now.Before(t.expires) {
			delete(u.tickets, repo)
		}
	}
}

func (u *gitUndoStore) clock() time.Time {
	if u.now != nil {
		return u.now()
	}
	return time.Now()
}
