package gitapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/{fetch,pull,push} + /api/git/job{s,/cancel,/events} — 원격 작업 표면
// (GIT_SRS §3B.1 FR-GIT-98~112).
//
// **자격증명을 받는 자리가 없다** (FR-GIT-104, 검증 V43). 요청 본문에 사용자명·
// 비밀·인증 재료를 담을 필드를 만들지 않는다 — 만들지 않는 것이 유일한 보장이다.
// 인증이 필요하면 git 이 즉시 실패하고, 우리는 터미널에서 하라고 안내한다.
//
// **서버가 마지막 방어선이다.** force 의 2단계 확인과 동시 실행 차단을 클라이언트만
// 막으면 API 직접 호출이 그대로 우회한다.

// 원격 작업 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const (
	gitErrJobBusy         = "job_busy"
	gitErrJobNotFound     = "job_not_found"
	gitErrPublishRequired = "publish_required"
	gitErrNoRemote        = "no_remote"
	// 묶음 E (FR-GIT-269·270). 상태 코드만으로는 "이미 있다"와 "없다"를 가를 수
	// 없고, 가르지 못하면 클라이언트가 무엇을 할지 정할 수 없다.
	gitErrRemoteExists  = "remote_exists"
	gitErrRemoteMissing = "remote_missing"
	gitErrSyncNotFound  = "sync_not_found"
)

// gitJobKeepAlive 는 SSE 주석 하트비트 간격이다. /api/commands/sse 와 같은 값을
// 쓴다 — 두 스트림의 유휴 동작이 갈릴 이유가 없다.
const gitJobKeepAlive = 15 * time.Second

// gitJobHolder 는 원격 작업의 수명을 쥔다. 제로값도 쓸 수 있다 — Git 이 없으면
// 만들지 않고, "작업 허브가 없어서 못 띄웠다"는 경로를 만들지 않는다.
//
// run 은 테스트가 주입한다. 주지 않으면 실제 git 이 네트워크로 나간다.
type gitJobHolder struct {
	mu   sync.Mutex
	jobs *jobs.Jobs
	run  jobs.JobRunner
}

// get 은 허브를 지연 생성한다. 완료 훅으로 status 캐시를 만료시킨다 —
// ahead/behind 가 폴링 주기를 기다리면 화면이 그만큼 거짓말을 한다 (FR-GIT-107).
func (h *gitJobHolder) get(store *store.Store) *jobs.Jobs {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.jobs == nil {
		opts := []jobs.JobsOption{jobs.WithOnDone(func(jb *jobs.Job) { store.Invalidate(jb.Repo) })}
		if h.run != nil {
			opts = append(opts, jobs.WithJobRunner(h.run))
		}
		h.jobs = jobs.NewJobs(store.Service(), opts...)
	}
	return h.jobs
}

// gitFetchReq 는 fetch 의 본문이다 (FR-GIT-109). Tags 가 nil 이면 다이얼로그를
// 열지 않은 것이며, 그때는 git 의 기본을 덮지 않는다.
type gitFetchReq struct {
	Repo  string `json:"repo"`
	Prune bool   `json:"prune"`
	Tags  *bool  `json:"tags"`
}

// gitPullReq 는 pull 의 본문이다 (FR-GIT-110).
type gitPullReq struct {
	Repo string `json:"repo"`
	Mode string `json:"mode"`
}

// gitPushReq 는 push 의 본문이다.
//
// Publish 는 upstream 설정에 대한 사전 확인이고(FR-GIT-100), Confirm 은 `--force`
// 의 2단계 확인이다(FR-GIT-106). 확인하는 대상이 다르므로 필드도 다르다.
type gitPushReq struct {
	Repo    string `json:"repo"`
	Publish bool   `json:"publish"`
	Force   string `json:"force"`
	Confirm bool   `json:"confirm"`
	// FR-GIT-271: 미리보기가 대상을 고치게 하므로 그 선택이 여기까지 와야 한다.
	// 받지 않으면 사용자가 고른 remote·branch 가 조용히 버려지고, 기본 대상으로
	// 밀린다 — 고를 수 있다고 보여 놓고 고른 것을 쓰지 않는 것이 가장 나쁘다.
	Remote string `json:"remote"`
	Branch string `json:"branch"`
}

type gitJobIDReq struct {
	ID string `json:"id"`
}

// POST /api/git/fetch — 기본은 `fetch --progress` 다 (FR-GIT-99).
func (s *GitServer) apiGitFetch(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitFetchReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	s.gitStartJob(w, req.Repo, root, "fetch", write.FetchSpec(write.FetchOpts{Prune: req.Prune, Tags: req.Tags}), nil)
}

// POST /api/git/pull — 기본은 `pull --progress` 다 (FR-GIT-99).
func (s *GitServer) apiGitPull(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitPullReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	spec, err := write.PullSpec(write.PullOpts{Mode: req.Mode})
	if err != nil {
		gitRemoteError(w, err)
		return
	}
	s.gitStartJob(w, req.Repo, root, "pull", spec, nil)
}

// POST /api/git/push — upstream 이 없으면 Publish 이고, 그 사실을 **실행 전에**
// 알린다 (FR-GIT-100). force 는 lease 가 기본이다 (FR-GIT-106).
func (s *GitServer) apiGitPush(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitPushReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	spec, plan, err := write.PushSpec(s.Git.Service(), r.Context(), root, write.PushOpts{
		Force: req.Force, Confirm: req.Confirm, Publish: req.Publish,
		Remote: req.Remote, Branch: req.Branch,
	})
	if err != nil {
		gitPushError(w, req.Repo, root, plan, err)
		return
	}
	s.gitStartJob(w, req.Repo, root, "push", spec, map[string]any{"plan": plan})
}

// gitStartJob 은 작업을 띄우고 식별자를 **즉시** 돌려준다 (FR-GIT-102). 끝나기를
// 기다리면 응답이 분 단위가 되고, 그동안 UI 는 막힌다.
func (s *GitServer) gitStartJob(w http.ResponseWriter, requested, root, kind string, spec core.WriteSpec, extra map[string]any) {
	jb, err := s.gitJobs.get(s.Git).Start(root, kind, spec)
	if err != nil {
		if errors.Is(err, jobs.ErrJobBusy) {
			gitFail(w, http.StatusConflict, gitErrJobBusy, gitTail(err.Error()))
			return
		}
		code, name := gitWriteErrorCode(err)
		gitFail(w, code, name, gitTail(err.Error()))
		return
	}
	body := map[string]any{"requested": requested, "repo": root, "job": jb}
	for k, v := range extra {
		body[k] = v
	}
	gitJSON(w, http.StatusOK, body)
}

// gitRemoteError 는 원격 고유의 거부를 코드로 옮긴 뒤 나머지를 공용 규약에
// 넘긴다. 잘못된 요청을 500 으로 뭉개면 클라이언트는 자기 요청이 틀렸다는 것을
// 알 수 없다.
func gitRemoteError(w http.ResponseWriter, err error) {
	// 묶음 E 의 거부는 한 자리에서 판정한다 — 두 벌이면 한쪽만 고쳐진다.
	if code, name, ok := gitRemoteListError(err); ok {
		gitFail(w, code, name, gitTail(err.Error()))
		return
	}
	switch {
	case errors.Is(err, write.ErrForceConfirm):
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired, gitTail(err.Error()))
	case errors.Is(err, write.ErrPullMode), errors.Is(err, write.ErrPushForce), errors.Is(err, write.ErrDetachedPush):
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
	case errors.Is(err, query.ErrNoRemote):
		gitFail(w, http.StatusConflict, gitErrNoRemote, gitTail(err.Error()))
	default:
		gitError(w, err)
	}
}

// gitPushError 는 Publish 확인 요구만 따로 다룬다. **계획을 함께 보낸다** —
// 무엇이 설정되는지 모르면 사용자가 확인할 수 없다 (FR-GIT-100).
func gitPushError(w http.ResponseWriter, requested, root string, plan write.PushPlan, err error) {
	if errors.Is(err, write.ErrPublishRequired) {
		gitJSON(w, http.StatusConflict, map[string]any{
			"error":     gitErrPublishRequired,
			"message":   gitTail(err.Error()),
			"requested": requested,
			"repo":      root,
			"plan":      plan,
		})
		return
	}
	gitRemoteError(w, err)
}

// POST /api/git/job/cancel — 프로세스 그룹을 끝낸다 (FR-GIT-102).
//
// **부분 적용 가능성은 사라지지 않는다** — 원격에 절반이 올라간 뒤 끊길 수 있고,
// 클라이언트의 확인 문구가 그것을 미리 알린다.
func (s *GitServer) apiGitJobCancel(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitJobIDReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if req.ID == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "id 가 없다")
		return
	}
	hub := s.gitJobs.get(s.Git)
	if _, ok := hub.Get(req.ID); !ok {
		gitFail(w, http.StatusNotFound, gitErrJobNotFound, "그 작업이 없다")
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"ok": true, "id": req.ID, "canceled": hub.Cancel(req.ID)})
}

// GET /api/git/jobs — 진행 중 작업 전부 (FR-GIT-112). 상태바가 폴링에 얹는다.
func (s *GitServer) apiGitJobs(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"jobs": s.gitJobs.get(s.Git).Active()})
}

// GET /api/git/job/events?id=&after=<seq> — 작업 출력 스트림 (FR-GIT-103).
//
// after 는 재연결 지점이다. 보존된 줄을 먼저 흘려보내므로 끊긴 구간이 비지 않는다.
// 구현 규약은 /api/commands/sse 를 따른다 — 두 스트림의 형태가 갈릴 이유가 없다.
func (s *GitServer) apiGitJobEvents(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		gitFail(w, http.StatusInternalServerError, gitErrFailed, "스트리밍을 지원하지 않는다")
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "id 가 없다")
		return
	}
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	hub := s.gitJobs.get(s.Git)
	ch, unsub, ok := hub.Subscribe(id, after)
	if !ok {
		// 조용히 빈 스트림을 주면 클라이언트가 영원히 기다린다.
		gitFail(w, http.StatusNotFound, gitErrJobNotFound, "그 작업이 없다")
		return
	}
	defer unsub()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	keep := time.NewTicker(gitJobKeepAlive)
	defer keep.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ln, more := <-ch:
			if !more {
				// 채널이 닫혔다 = 작업이 끝났다. 마지막으로 작업 자체를 보낸다 —
				// 종료 사유·인증 안내·후속 선택지가 여기서 클라이언트에 닿는다.
				gitJobEvent(w, flusher, "done", s.gitJobFinal(hub, id))
				return
			}
			gitJobEvent(w, flusher, "line", ln)
		case <-keep.C:
			fmt.Fprint(w, ": keep\n\n")
			flusher.Flush()
		}
	}
}

// gitJobFinal 은 done 이벤트에 실을 값이다. 보존 기간이 지나 사라졌으면 끝났다는
// 사실만 남는다 — 클라이언트가 완료를 못 보고 기다리는 것이 더 나쁘다.
func (s *GitServer) gitJobFinal(hub *jobs.Jobs, id string) any {
	if jb, ok := hub.Get(id); ok {
		return jb
	}
	return map[string]any{"id": id, "done": true}
}

func gitJobEvent(w io.Writer, flusher http.Flusher, name string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
	flusher.Flush()
}

// ── 묶음 E — 원격 목록 · Sync · Push preview (FR-GIT-269·270·271) ──

// gitRemoteNameReq 는 remote add/remove 의 본문이다.
//
// **URL 은 더할 때만 온다.** 지울 때 받으면 무엇을 지우는지가 두 값이 되고, 둘이
// 어긋나면 어느 쪽을 믿을지 정할 수 없다.
type gitRemoteNameReq struct {
	Repo string `json:"repo"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

// gitSyncReq 는 Sync 의 본문이다 (FR-GIT-270). pull 과 push 의 선택을 함께 받는다 —
// 두 단계를 한 진입점으로 묶는 것이 이 요구사항이므로 선택도 한 번에 온다.
type gitSyncReq struct {
	Repo    string `json:"repo"`
	Mode    string `json:"mode"`
	Force   string `json:"force"`
	Confirm bool   `json:"confirm"`
	Publish bool   `json:"publish"`
	Remote  string `json:"remote"`
	Branch  string `json:"branch"`
}

// GET /api/git/remotes?repo= — 원격 목록 (FR-GIT-269).
//
// **조회를 새로 만들지 않았다** — query.Remotes 가 DefaultRemote 와 같은
// `config --list` 를 읽는다. URL 은 자격증명이 지워진 값이다 (FR-GIT-104).
func (s *GitServer) apiGitRemotes(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	list, err := query.Remotes(s.Git.Service(), r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"requested": map[string]any{"repo": requested},
		"repo":      root,
		"remotes":   list,
	})
}

// POST /api/git/remote/add — 원격을 더한다 (FR-GIT-269). 파괴적이 아니다.
func (s *GitServer) apiGitRemoteAdd(w http.ResponseWriter, r *http.Request) {
	s.gitRemoteWrite(w, r, func(ctx context.Context, root string, req gitRemoteNameReq) error {
		_, err := write.RemoteAdd(s.Git.Service(), ctx, root, req.Name, req.URL)
		return err
	})
}

// POST /api/git/remote/remove — 원격을 지운다 (FR-GIT-269).
//
// **파괴적이 아니다** — 저장소의 객체는 그대로이고 설정만 사라지므로 2단계 확인을
// 요구하지 않는다. 되살릴 `git remote add <name> <url>` 은 write 가 실행 전에
// hint 로 남긴다 (FR-GIT-92) — `/api/git/recovery` 가 그것을 준다.
func (s *GitServer) apiGitRemoteRemove(w http.ResponseWriter, r *http.Request) {
	s.gitRemoteWrite(w, r, func(ctx context.Context, root string, req gitRemoteNameReq) error {
		_, err := write.RemoteRemove(s.Git.Service(), ctx, root, req.Name)
		return err
	})
}

// gitRemoteWrite 는 add/remove 가 공유하는 쓰기 규약이다 (FR-GIT-250 ③):
// 루트 재확인 → 실행 전 status → 실행 → 실행 후 status. **바뀐 목록을 함께
// 돌려준다** — 폴링 주기를 기다리면 화면이 그만큼 거짓말을 한다 (FR-GIT-71).
func (s *GitServer) gitRemoteWrite(w http.ResponseWriter, r *http.Request,
	run func(context.Context, string, gitRemoteNameReq) error) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitRemoteNameReq
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
		return run(ctx, root, req)
	})
	if !ok {
		return
	}
	list, err := query.Remotes(s.Git.Service(), r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	gitWriteOK(w, req.Repo, root, after, map[string]any{"remotes": list})
}

// gitRemoteListError 는 목록 고유의 거부를 코드로 옮긴다. gitApply 가 쓰는
// gitWriteErrorCode 는 이것을 모르므로 여기서 먼저 갈라 준다.
func gitRemoteListError(err error) (int, string, bool) {
	switch {
	case errors.Is(err, write.ErrRemoteExists):
		return http.StatusConflict, gitErrRemoteExists, true
	case errors.Is(err, write.ErrRemoteMissing):
		return http.StatusNotFound, gitErrRemoteMissing, true
	case errors.Is(err, write.ErrRemoteName), errors.Is(err, write.ErrRemoteURL),
		errors.Is(err, write.ErrPushTarget):
		return http.StatusBadRequest, gitErrBadRequest, true
	}
	return 0, "", false
}

// POST /api/git/sync — pull 후 push 를 한 진입점으로 묶는다 (FR-GIT-270).
//
// **두 argv 를 전부 실행 전에 만든다.** push 가 Publish 확인이나 force 확인을
// 요구하면 pull 도 돌리지 않는다 — pull 만 돌고 push 가 막히면 저장소가 사용자가
// 요청하지 않은 중간 상태로 남는다.
//
// 응답은 첫 단계의 작업 식별자다 (FR-GIT-102). 두 번째 단계는 첫 단계가 **성공으로
// 끝난 뒤에만** 시작하며, 그 판정은 서버가 한다 (V197).
func (s *GitServer) apiGitSync(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitSyncReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	pull, err := write.PullSpec(write.PullOpts{Mode: req.Mode})
	if err != nil {
		gitRemoteError(w, err)
		return
	}
	push, plan, err := write.PushSpec(s.Git.Service(), r.Context(), root, write.PushOpts{
		Force: req.Force, Confirm: req.Confirm, Publish: req.Publish,
		Remote: req.Remote, Branch: req.Branch,
	})
	if err != nil {
		gitPushError(w, req.Repo, root, plan, err)
		return
	}
	hub := s.gitJobs.get(s.Git)
	jb, err := hub.Start(root, write.SyncStepPull, pull)
	if err != nil {
		gitStartFail(w, err)
		return
	}
	run := s.gitSyncs.begin(root, req.Repo, jb.ID, push)
	go s.runSyncChain(hub, run)
	gitJSON(w, http.StatusOK, map[string]any{
		"requested": req.Repo,
		"repo":      root,
		"job":       jb,
		"plan":      plan,
		"sync":      run.snapshot(),
	})
}

// GET /api/git/sync?id= — sync 하나의 진행 (FR-GIT-270).
//
// 두 번째 단계의 작업 식별자가 여기서 나온다 — 클라이언트는 그것으로 기존 SSE 에
// 붙는다. 새 스트리밍 경로를 만들지 않는다.
func (s *GitServer) apiGitSyncState(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "id 가 없다")
		return
	}
	snap, ok := s.gitSyncs.get(id)
	if !ok {
		gitFail(w, http.StatusNotFound, gitErrSyncNotFound, "그 sync 가 없다")
		return
	}
	gitJSON(w, http.StatusOK, snap)
}

// runSyncChain 은 sync 한 번의 수명이다.
//
// 첫 단계가 끝나기를 기다리는 수단은 **이미 있는 구독**이다 (jobs.Subscribe) —
// 작업이 끝나면 채널이 닫힌다. 폴링을 새로 만들면 끝난 시점이 두 벌이 된다.
// afterSeq 를 최대로 주는 이유는 보존된 줄을 되받을 이유가 없기 때문이다.
func (s *GitServer) runSyncChain(hub *jobs.Jobs, run *gitSyncRun) {
	if ch, unsub, ok := hub.Subscribe(run.PullJob, ^uint64(0)); ok {
		for range ch {
		}
		unsub()
	}
	next, do, reason := write.SyncNext(write.SyncStepPull, gitStepOutcome(hub, run.PullJob))
	if !do || next != write.SyncStepPush {
		s.gitSyncs.stop(run.ID, reason)
		return
	}
	jb, err := hub.Start(run.Repo, write.SyncStepPush, run.push)
	if err != nil {
		s.gitSyncs.stop(run.ID, gitTail(err.Error()))
		return
	}
	s.gitSyncs.advance(run.ID, jb)
	if ch, unsub, ok := hub.Subscribe(jb.ID, ^uint64(0)); ok {
		for range ch {
		}
		unsub()
	}
	s.gitSyncs.finish(run.ID)
}

// gitStepOutcome 은 끝난 작업 하나를 순수한 판정 입력으로 옮긴다.
//
// 보존 기간이 지나 사라졌으면 **성공으로 보지 않는다** — 확인하지 못한 것을
// "성공했다"로 다루면 실패한 pull 뒤에 push 가 돈다 (V197).
func gitStepOutcome(hub *jobs.Jobs, id string) write.StepOutcome {
	jb, ok := hub.Get(id)
	if !ok {
		return write.StepOutcome{ExitCode: -1, Err: "앞 단계의 결과를 확인하지 못했다"}
	}
	return write.StepOutcome{ExitCode: jb.ExitCode, Err: jb.Err, Canceled: jb.Canceled}
}

// GET /api/git/push/preview?repo=&remote=&branch= — 밀기 전의 미리보기
// (FR-GIT-271).
//
// 목록은 `log <upstream>..<branch>` 이며 **새 조회를 만들지 않는다** — query.Log 의
// Ref 에 그 범위를 넣는 것이 전부다. 원격에 그 브랜치가 아직 없으면 범위가 없고,
// 그 사실(`publish`)을 함께 준다: 브랜치의 커밋 전부가 올라간다.
func (s *GitServer) apiGitPushPreview(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	svc := s.Git.Service()
	st, err := query.StatusOf(svc, r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	if st.Detached {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "detached HEAD 에는 밀 브랜치가 없다")
		return
	}
	remote, branch, err := s.gitPushTarget(r, root, st)
	if err != nil {
		gitRemoteError(w, err)
		return
	}
	remotes, err := query.Remotes(svc, r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	upstream, err := gitTrackingRef(svc, r.Context(), root, remote, branch)
	if err != nil {
		gitError(w, err)
		return
	}
	commits, err := query.Log(svc, r.Context(), query.LogQuery{
		Repo: root, Ref: write.PushRange(upstream, branch), Limit: query.LogPageLimit,
	})
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"requested": map[string]any{"repo": requested, "remote": remote, "branch": branch},
		"repo":      root,
		"remote":    remote,
		"branch":    branch,
		"upstream":  upstream,
		// 원격에 그 브랜치가 없다 = 미는 순간 만들어진다. 사용자가 알아야 한다.
		"publish": upstream == "",
		"commits": commits,
		"remotes": remotes,
	})
}

// gitPushTarget 은 미리보기의 대상이다. 인자가 없으면 저장소가 정한다 — upstream 이
// 있으면 그것, 없으면 DefaultRemote 와 현재 브랜치다 (FR-GIT-100 과 같은 규칙).
func (s *GitServer) gitPushTarget(r *http.Request, root string, st query.Status) (remote, branch string, err error) {
	q := r.URL.Query()
	remote, branch = q.Get("remote"), q.Get("branch")
	if branch == "" {
		branch = st.Branch
	}
	if remote == "" {
		if up := st.Upstream; up != "" {
			if head, _, cut := strings.Cut(up, "/"); cut {
				remote = head
			}
		}
	}
	if remote == "" {
		remote, err = query.DefaultRemote(s.Git.Service(), r.Context(), root)
		if err != nil {
			return "", "", err
		}
	}
	if terr := write.CheckRemoteName(remote); terr != nil {
		return "", "", fmt.Errorf("%w: %v", write.ErrPushTarget, terr)
	}
	if terr := core.CheckRefArg("branch", branch); terr != nil {
		return "", "", fmt.Errorf("%w: %v", write.ErrPushTarget, terr)
	}
	return remote, branch, nil
}

// gitTrackingRef 는 `<remote>/<branch>` 가 실제로 있으면 그 이름이고, 없으면 빈
// 문자열이다. **없는 ref 로 범위를 만들면 log 가 실패한다** — 그 실패를 "커밋이
// 없다"로 뭉개면 사용자는 밀 것이 없다고 믿는다.
//
// 목록은 이미 있는 query.Refs 를 쓴다 (FR-GIT-122) — 새 조회를 만들지 않는다.
func gitTrackingRef(svc *core.Service, ctx context.Context, root, remote, branch string) (string, error) {
	refs, err := query.Refs(svc, ctx, root)
	if err != nil {
		return "", err
	}
	want := remote + "/" + branch
	for _, ref := range refs {
		if ref.Kind == query.RefKindRemote && ref.Short == want {
			return want, nil
		}
	}
	return "", nil
}

// gitStartFail 은 작업 시작 실패를 코드로 옮긴다. gitStartJob 과 같은 판정이며
// 응답 본문만 다르다 — sync 는 자기 상태를 함께 실어야 한다.
func gitStartFail(w http.ResponseWriter, err error) {
	if errors.Is(err, jobs.ErrJobBusy) {
		gitFail(w, http.StatusConflict, gitErrJobBusy, gitTail(err.Error()))
		return
	}
	code, name := gitWriteErrorCode(err)
	gitFail(w, code, name, gitTail(err.Error()))
}

// gitSyncRun 은 sync 한 번의 전부다. push 의 argv 는 시작할 때 이미 만들어져 있다 —
// pull 이 끝난 뒤에 만들면 그 사이에 바뀐 저장소 상태가 판정을 갈라 놓는다.
type gitSyncRun struct {
	ID        string   `json:"id"`
	Repo      string   `json:"repo"`
	Requested string   `json:"requested"`
	Step      string   `json:"step"`
	PullJob   string   `json:"pullJob"`
	PushJob   string   `json:"pushJob,omitempty"`
	PushArgv  []string `json:"pushArgv,omitempty"`
	Done      bool     `json:"done"`
	Stopped   bool     `json:"stopped"`
	Reason    string   `json:"reason,omitempty"`

	push core.WriteSpec
}

func (r *gitSyncRun) snapshot() map[string]any {
	return map[string]any{
		"id": r.ID, "repo": r.Repo, "requested": r.Requested,
		"steps": write.SyncSteps, "step": r.Step,
		"pullJob": r.PullJob, "pushJob": r.PushJob, "pushArgv": r.PushArgv,
		"done": r.Done, "stopped": r.Stopped, "reason": r.Reason,
	}
}

// gitSyncHolder 는 진행 중인 sync 를 쥔다. 제로값도 쓸 수 있다 — 만들지 못해
// 실패하는 경로를 두지 않는다.
type gitSyncHolder struct {
	mu   sync.Mutex
	byID map[string]*gitSyncRun
	seq  uint64
}

func (h *gitSyncHolder) begin(root, requested, pullJob string, push core.WriteSpec) *gitSyncRun {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.byID == nil {
		h.byID = map[string]*gitSyncRun{}
	}
	h.sweepLocked()
	h.seq++
	run := &gitSyncRun{
		ID: fmt.Sprintf("sync-%d", h.seq), Repo: root, Requested: requested,
		Step: write.SyncStepPull, PullJob: pullJob, push: push,
	}
	h.byID[run.ID] = run
	return run
}

// advance 는 두 번째 단계를 기록한다. **argv 를 함께 남긴다** — 클라이언트가
// 그것으로 화면을 채운다: 무엇이 실행됐는지 모르면 미리보기의 선택이 반영됐는지
// 사용자가 확인할 수 없다 (FR-GIT-109·110 과 같은 규약). 자격증명은 job 이
// 이미 지운 값이다 (FR-GIT-104).
func (h *gitSyncHolder) advance(id string, jb *jobs.Job) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if run, ok := h.byID[id]; ok {
		run.Step, run.PushJob, run.PushArgv = write.SyncStepPush, jb.ID, jb.Argv
	}
}

// stop 은 **뒤를 돌리지 않았다**는 사실과 그 사유를 남긴다 (V197). 사유 없이
// 끝내면 사용자는 push 가 돈 줄 안다.
func (h *gitSyncHolder) stop(id, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if run, ok := h.byID[id]; ok {
		run.Done, run.Stopped, run.Reason = true, true, reason
	}
}

func (h *gitSyncHolder) finish(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if run, ok := h.byID[id]; ok {
		run.Done = true
	}
}

func (h *gitSyncHolder) get(id string) (map[string]any, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	run, ok := h.byID[id]
	if !ok {
		return nil, false
	}
	return run.snapshot(), true
}

// sweepLocked 는 상한을 넘은 오래된 것을 버린다. 끝난 sync 를 영원히 들고 있으면
// 세션이 길수록 자란다 — 끝난 것의 뜻은 클라이언트가 한 번 읽으면 다한다.
func (h *gitSyncHolder) sweepLocked() {
	if len(h.byID) <= gitSyncCap {
		return
	}
	for id, run := range h.byID {
		if run.Done {
			delete(h.byID, id)
		}
	}
}

// gitSyncCap 은 들고 있을 sync 수다. 상한은 상수로 못박는다.
const gitSyncCap = 32
