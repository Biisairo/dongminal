package gitapi

import (
	"context"
	"errors"
	"net/http"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/stash{,/push,/apply,/pop,/drop,/show} — stash 표면
// (GIT_SRS §3D.2 FR-GIT-161~170).
//
// **서버가 마지막 방어선이다.** drop 의 2단계 확인과 "담을 것이 없다" 를
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.

// stash 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const (
	gitErrNothingToStash = apierr.CodeNothingToStash
	// gitErrStashKept 는 **pop 이 끝나지 않아 stash 가 남았다**는 것이다
	// (FR-GIT-165). 500 으로 뭉개면 클라이언트가 "작업은 남아 있다"를 말할 근거를
	// 잃고, 사용자는 작업을 잃었다고 오해한다.
	gitErrStashKept = apierr.CodeStashKept
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
// Oid 는 클라이언트가 목록에서 본 stash 다 (REPO_FIX 01 §5.3 — 필수). Index 는
// 더 이상 받지 않는다: 포인터로 두어 **보냈는지**를 가르고, 보냈으면 400 이다 —
// 받는 척 무시하면 옛 클라이언트가 위치로 지목한다고 믿는다.
//
// WithIndex 는 `--index` 다 (FR-GIT-163). Confirm 은 drop 의 2단계 확인이다
// (FR-GIT-168) — 파괴적 동작이므로 확인 없이는 실행되지 않는다.
type gitStashIndexReq struct {
	Repo      string `json:"repo"`
	Oid       string `json:"oid"`
	Index     *int   `json:"index"`
	WithIndex bool   `json:"withIndex"`
	Confirm   bool   `json:"confirm"`
}

type gitStashListRequested struct {
	Repo string `json:"repo"`
}

type gitStashListResponse struct {
	Requested gitStashListRequested `json:"requested"`
	Repo      string                `json:"repo"`
	Stashes   []write.Stash         `json:"stashes"`
}

// gitStashShowRequested 의 식별자는 (리포, oid) 다 — stale 가드의 서버측 절반이며,
// oid 가 빠지면 뒤늦게 온 다른 stash 의 응답을 자기 것으로 읽는다.
type gitStashShowRequested struct {
	Repo string `json:"repo"`
	Oid  string `json:"oid"`
}

type gitStashShowResponse struct {
	Requested gitStashShowRequested `json:"requested"`
	Repo      string                `json:"repo"`
	Files     []query.CommitFile    `json:"files"`
}

// GET /api/git/stash?repo= — stash 목록 (FR-GIT-161).
func (s *GitServer) apiGitStashList(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	list, err := write.StashList(s.Git.Service(), r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitStashListResponse{
		Requested: gitStashListRequested{Repo: requested}, Repo: root, Stashes: list,
	})
}

// GET /api/git/stash/show?repo=&oid= — 선택한 stash 의 변경 파일 (FR-GIT-169).
//
// REPO_FIX 01 §5.3: oid 로 직접 연다. index 쿼리는 400, 목록에 없는 oid 는 409
// stash_moved(현재 목록을 함께 싣는다).
func (s *GitServer) apiGitStashShow(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	if q.Has("index") {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "index 는 더 이상 받지 않는다 — oid 를 보내라")
		return
	}
	oid := q.Get("oid")
	if err := write.CheckStashOid(oid); err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
		return
	}
	files, err := write.StashPreview(s.Git.Service(), r.Context(), root, oid)
	if errors.Is(err, write.ErrStashMoved) {
		body := map[string]any{
			"error":     apierr.CodeStashMoved,
			"message":   gitTail(err.Error()),
			"requested": gitStashShowRequested{Repo: requested, Oid: oid},
			"repo":      root,
		}
		if list, lerr := write.StashList(s.Git.Service(), r.Context(), root); lerr == nil {
			body["stashes"] = list
		}
		gitErrJSON(w, http.StatusConflict, apierr.CodeStashMoved, body)
		return
	}
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitStashShowResponse{
		Requested: gitStashShowRequested{Repo: requested, Oid: oid}, Repo: root, Files: files,
	})
}

// POST /api/git/stash/push — 워킹 트리의 변경을 stash 로 옮긴다 (FR-GIT-166·167).
func (s *GitServer) apiGitStashPush(w http.ResponseWriter, r *http.Request) {
	var req gitStashPushReq
	t := s.beginWrite(w, r, &req)
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	root := t.root
	before := t.snapshot()
	if t.stop() {
		return
	}
	// 담을 것이 없으면 **실행하지 않는다** (FR-GIT-167). git 은 그 실행을 exit 0 으로
	// 끝내므로 성공으로 답하면 사용자는 만들어지지 않은 stash 를 찾는다.
	if write.StashableCount(before, req.IncludeUntracked) == 0 {
		t.rejectBody(http.StatusConflict, gitErrNothingToStash,
			write.StashEmptyReason(before, req.IncludeUntracked),
			map[string]any{"status": before})
		return
	}
	opts := write.StashPushOpts{
		Message:          req.Message,
		IncludeUntracked: req.IncludeUntracked,
		KeepIndex:        req.KeepIndex,
	}
	s.gitStashApply(t, before, func(ctx context.Context) (map[string]any, error) {
		_, err := write.StashPush(s.Git.Service(), ctx, root, opts)
		return nil, err
	})
}

// POST /api/git/stash/apply — stash 를 얹고 **남긴다** (FR-GIT-163).
func (s *GitServer) apiGitStashApply(w http.ResponseWriter, r *http.Request) {
	s.gitStashIndexRoute(w, r, false, func(ctx context.Context, root string, req gitStashIndexReq) (map[string]any, error) {
		_, err := write.StashApply(s.Git.Service(), ctx, root, req.Oid, req.WithIndex)
		return nil, err
	})
}

// POST /api/git/stash/pop — stash 를 얹고 지운다 (FR-GIT-164).
//
// **충돌로 끝나면 git 이 stash 를 남긴다** (FR-GIT-165). 그 사실을 확인해 응답에
// 담는다 — 조용히 넘기면 사용자는 작업을 잃었다고 오해한다.
func (s *GitServer) apiGitStashPop(w http.ResponseWriter, r *http.Request) {
	s.gitStashIndexRoute(w, r, false, func(ctx context.Context, root string, req gitStashIndexReq) (map[string]any, error) {
		_, kept, err := write.StashPopChecked(s.Git.Service(), ctx, root, req.Oid, req.WithIndex)
		return stashKeptFields(kept), err
	})
}

// POST /api/git/stash/drop — stash 를 지운다. **파괴적이다** (FR-GIT-89·168).
//
// `confirm:true` 가 없으면 실행하지 않는다. recovery hint 는 git 패키지가 실행
// **전에** 남긴다 (FR-GIT-92).
func (s *GitServer) apiGitStashDrop(w http.ResponseWriter, r *http.Request) {
	s.gitStashIndexRoute(w, r, true, func(ctx context.Context, root string, req gitStashIndexReq) (map[string]any, error) {
		_, err := write.StashDrop(s.Git.Service(), ctx, root, req.Oid)
		return nil, err
	})
}

// stashKeptFields 는 stash 잔존 사실을 응답 필드로 옮긴다 — pop 과 branch 가 같은
// 세 필드를 쓴다 (REPO_FIX 01 §5.3).
func stashKeptFields(kept write.StashPopKept) map[string]any {
	return map[string]any{
		"stashKept":       kept.Kept,
		"stashKeptReason": kept.Reason,
		"stashKeptOid":    kept.Oid,
	}
}

// gitStashBranchReq 는 Branch from stash 의 본문이다 (FR-GIT-272). Oid·Index 의
// 규칙은 gitStashIndexReq 와 같다.
type gitStashBranchReq struct {
	Repo  string `json:"repo"`
	Oid   string `json:"oid"`
	Index *int   `json:"index"`
	Name  string `json:"name"`
}

// POST /api/git/stash/branch — stash 를 새 브랜치에 적용하며 옮겨 간다
// (FR-GIT-272, 검증 V199).
//
// **파괴적이 아니다** — git 은 적용이 끝난 뒤에만 그 stash 를 지운다. 이름은 실행
// **전에** 검증한다 (FR-GIT-250.3): 클라이언트만 막으면 API 직접 호출이 우회한다.
func (s *GitServer) apiGitStashBranch(w http.ResponseWriter, r *http.Request) {
	var req gitStashBranchReq
	t := s.beginWrite(w, r, &req)
	if t.stop() {
		return
	}
	if msg := stashTargetInvalid(req.Oid, req.Index); msg != "" {
		t.rejectWith(http.StatusBadRequest, gitErrBadRequest, msg)
		return
	}
	// 순수 함수가 argv 를 만들 수 있는지로 판정한다 — 판정이 두 벌이면 한쪽만
	// 고쳐진다 (FR-GIT-250 ①). 위치는 실행 직전에 oid 로 찾으므로 여기서는 이름만 본다.
	if _, err := write.StashBranchArgs(req.Name, 0); err != nil {
		t.rejectWith(http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
		return
	}
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	// 이름 규칙 전체는 git 에 묻는다 — 우리가 다시 구현하지 않는다 (FR-GIT-159).
	if err := query.ValidBranchName(s.Git.Service(), t.ctx(), t.root, req.Name); err != nil {
		t.rejectWith(http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
		return
	}
	// REPO_FIX 01 §5.3: 이미 있는 이름이면 실행 전에 거절한다. 선택지(checkout·
	// rename)는 브랜치 생성의 것이라 싣지 않는다 — 그대로 실행하면 git 이 브랜치를
	// 만들기 전에 실패하는데 HEAD 가 그 이름이면 "만들어졌다" 로 읽힌다.
	exists, err := query.LocalBranchExists(s.Git.Service(), t.ctx(), t.root, req.Name)
	if err != nil {
		t.reject(err)
		return
	}
	if exists {
		t.rejectBody(http.StatusConflict, gitErrBranchExists, "로컬 브랜치 "+req.Name+" 가 이미 있다",
			map[string]any{"branch": req.Name})
		return
	}
	before := t.snapshot()
	if t.stop() {
		return
	}
	s.gitStashApply(t, before, func(ctx context.Context) (map[string]any, error) {
		_, kept, err := write.StashBranch(s.Git.Service(), ctx, t.root, req.Name, req.Oid)
		return stashKeptFields(kept), err
	})
}

// stashTargetInvalid 는 stash 지목이 잘못됐으면 사유를, 맞으면 "" 를 준다.
func stashTargetInvalid(oid string, index *int) string {
	if index != nil {
		return "index 는 더 이상 받지 않는다 — oid 를 보내라"
	}
	if err := write.CheckStashOid(oid); err != nil {
		return gitTail(err.Error())
	}
	return ""
}

// gitStashIndexRoute 는 apply/pop/drop 의 공통 절차다. 셋은 본문과 응답이 같고
// 실행하는 것과 확인을 요구하는지만 다르다.
func (s *GitServer) gitStashIndexRoute(w http.ResponseWriter, r *http.Request, confirm bool, run func(context.Context, string, gitStashIndexReq) (map[string]any, error)) {
	var req gitStashIndexReq
	t := s.beginWrite(w, r, &req)
	if t.stop() {
		return
	}
	t.requireConfirm(confirm, req.Confirm,
		"파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89·168)")
	if t.stop() {
		return
	}
	if msg := stashTargetInvalid(req.Oid, req.Index); msg != "" {
		t.rejectWith(http.StatusBadRequest, gitErrBadRequest, msg)
		return
	}
	t.resolve(req.Repo)
	before := t.snapshot()
	if t.stop() {
		return
	}
	s.gitStashApply(t, before, func(ctx context.Context) (map[string]any, error) {
		return run(ctx, t.root, req)
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
//
// REPO_FIX 01 §5.5: 실행은 쓰기 단계(루트 ctx), 재조회는 사후 단계다. 잠금(common-dir
// → toplevel)은 lease 가 응답 뒤까지 쥐므로 oid 위치 확인과 실행이 한 잠금 안이다.
func (s *GitServer) gitStashApply(t *gitWrite, before query.Status, run func(context.Context) (map[string]any, error)) {
	var extra map[string]any
	ran, runErr := t.write(func(ctx context.Context) error {
		var err error
		extra, err = run(ctx)
		return err
	})
	if !ran {
		return
	}
	ctx, cancel := t.post()
	defer cancel()
	s.Git.Invalidate(t.root)
	obs, _, statusErr := s.Git.Status(ctx, t.root)

	body := map[string]any{"requested": t.requested, "repo": t.root, "partial": false}
	for k, v := range extra {
		body[k] = v
	}
	if statusErr == nil {
		body["status"] = obs.Status
		// 목록 조회의 실패로 응답을 버리지 않는다 — 실행 결과가 더 중요하다.
		if list, err := write.StashList(s.Git.Service(), ctx, t.root); err == nil {
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
			gitError(t.w, statusErr)
			return
		}
		body["ok"] = true
		gitJSON(t.w, http.StatusOK, body)
		return
	}
	code, name := gitStashErrorCode(runErr, extra)
	s.gitRenderFail(ctx, t, code, name, gitTail(runErr.Error()), runErr, body)
}

// gitStashErrorCode 는 stash 실패를 코드로 옮긴다.
//
// **여기 남은 것은 오류값이 모르는 사실 하나뿐이다** — stash 가 남았는지는
// `extra` 가 알고 오류는 모른다. 그리고 그 사실이 가장 앞이다 (FR-GIT-165):
// 사용자가 알아야 할 것은 "무엇이 실패했는가" 보다 "내 변경이 어디 있는가" 다.
//
// 나머지 판정(빈 stash·없는 stash)은 `apierr.Git` 이 소유한다 (FR-DPN-5).
func gitStashErrorCode(err error, extra map[string]any) (int, string) {
	if kept, _ := extra["stashKept"].(bool); kept {
		return http.StatusConflict, gitErrStashKept
	}
	return gitErrorCode(err)
}
