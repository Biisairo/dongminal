package gitapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
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
