package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git"
)

// 묶음 K 서버측 — /api/git/{fetch,pull,push} + /api/git/job* (GIT_SRS §3B.1,
// 검증 V40·V42·V43·V44).
//
// **서버가 마지막 방어선이다.** force 의 2단계 확인·동시 실행 차단을 클라이언트만
// 막으면 API 직접 호출이 그대로 우회한다.

const gitRemoteRepo = "/work/repo"

// gitRemoteFake 는 읽기를 격리한다. 원격 작업의 argv 는 status 와 config 로
// 결정되므로 그 둘만 답한다.
type gitRemoteFake struct {
	mu       sync.Mutex
	gitDir   string
	branch   string
	upstream string
	config   string
}

func newGitRemoteFake(t *testing.T) *gitRemoteFake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &gitRemoteFake{
		gitDir:   dir,
		branch:   "main",
		upstream: "origin/main",
		config:   "remote.origin.url=/tmp/remote.git\n",
	}
}

func (f *gitRemoteFake) read(_ context.Context, dir string, args []string) (git.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		return git.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse":
		return git.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case args[0] == "status":
		return git.Output{Stdout: f.statusOut()}, nil
	case args[0] == "config":
		return git.Output{Stdout: f.config}, nil
	}
	return git.Output{}, nil
}

func (f *gitRemoteFake) statusOut() string {
	toks := []string{"# branch.oid " + strings.Repeat("a", 40), "# branch.head " + f.branch}
	if f.upstream != "" {
		toks = append(toks, "# branch.upstream "+f.upstream, "# branch.ab +1 -0")
	}
	return strings.Join(toks, "\x00") + "\x00"
}

// gitRemoteServer 는 읽기와 **작업 실행기**를 함께 격리한다. run 을 주지 않으면
// 실제 git 이 네트워크로 나간다.
func gitRemoteServer(t *testing.T, f *gitRemoteFake, run git.JobRunner) *Server {
	t.Helper()
	store := git.NewStore(git.New(
		git.WithRunner(f.read),
		git.WithWriteRunner(func(context.Context, string, []string, string) (git.Output, error) {
			t.Error("원격 작업이 쓰기 경로로 흘렀다")
			return git.Output{}, nil
		}),
	))
	s := &Server{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: store}
	s.gitJobs.run = run
	return s
}

// gitRemoteHold 는 취소되거나 풀릴 때까지 매달리는 실행기다.
func gitRemoteHold(release <-chan struct{}) git.JobRunner {
	return func(ctx context.Context, _ string, _ []string, emit func(string, string)) (int, error) {
		emit("stderr", "remote: 세는 중")
		select {
		case <-release:
			return 0, nil
		case <-ctx.Done():
			return -1, ctx.Err()
		}
	}
}

// gitRemoteEmit 은 준 줄을 내고 곧 끝나는 실행기다.
func gitRemoteEmit(lines ...string) git.JobRunner {
	return func(_ context.Context, _ string, _ []string, emit func(string, string)) (int, error) {
		for _, l := range lines {
			emit("stderr", l)
		}
		return 0, nil
	}
}

func gitRemoteJobID(t *testing.T, out map[string]any) string {
	t.Helper()
	jb, ok := out["job"].(map[string]any)
	if !ok {
		t.Fatalf("job 이 없다: %v", out)
	}
	id, _ := jb["id"].(string)
	if id == "" {
		t.Fatalf("작업 식별자가 없다: %v", jb)
	}
	return id
}

func gitRemoteWaitDone(t *testing.T, s *Server, id string) *git.Job {
	t.Helper()
	hub := s.gitJobs.get(s.Git)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if jb, ok := hub.Get(id); ok && jb.Done {
			return jb
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("작업 %s 가 끝나지 않았다", id)
	return nil
}

// gitRemoteEndpoints 는 이번 단계가 더한 표면 전부다.
var gitRemoteEndpoints = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodPost, "/api/git/fetch", `{"repo":"/work/repo"}`},
	{http.MethodPost, "/api/git/pull", `{"repo":"/work/repo"}`},
	{http.MethodPost, "/api/git/push", `{"repo":"/work/repo"}`},
	{http.MethodPost, "/api/git/job/cancel", `{"id":"x"}`},
	{http.MethodGet, "/api/git/job/events?id=x", ""},
	{http.MethodGet, "/api/git/jobs", ""},
}

// K1: 6개 라우트가 apiRoutes 에 등록돼 있다. UI 는 이 표면 위에만 선다.
func TestGitRemoteRoutesRegistered(t *testing.T) {
	for _, ep := range gitRemoteEndpoints {
		path := strings.SplitN(ep.path, "?", 2)[0]
		found := false
		for _, rt := range apiRoutes {
			if rt.method != "" && rt.method != ep.method {
				continue
			}
			if rt.match(path) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s %s 가 apiRoutes 에 없다", ep.method, path)
		}
	}
}

// K2: s.Git == nil 이면 전부 503 이고 다른 동작에는 영향이 없다 (FR-GIT-60).
func TestGitRemoteEndpoints_Unavailable(t *testing.T) {
	s := &Server{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitRemoteEndpoints {
		code, out := gitReq(t, s, ep.method, ep.path, ep.body)
		if code != http.StatusServiceUnavailable {
			t.Errorf("%s %s → %d, want 503", ep.method, ep.path, code)
		}
		if out["error"] != gitErrUnavailable {
			t.Errorf("%s %s error=%v", ep.method, ep.path, out["error"])
		}
	}
}

// K3 (FR-GIT-102): fetch/pull/push 는 작업 식별자를 **즉시** 준다. 끝나기를
// 기다리면 응답이 분 단위가 된다.
func TestGitRemote_StartReturnsJobImmediately(t *testing.T) {
	cases := []struct {
		path string
		body string
		kind string
		want []string
	}{
		{"/api/git/fetch", `{"repo":"/work/repo"}`, "fetch", []string{"fetch", "--progress"}},
		{"/api/git/fetch", `{"repo":"/work/repo","prune":true,"tags":false}`, "fetch",
			[]string{"fetch", "--progress", "--prune", "--no-tags"}},
		{"/api/git/pull", `{"repo":"/work/repo"}`, "pull", []string{"pull", "--progress"}},
		{"/api/git/pull", `{"repo":"/work/repo","mode":"rebase"}`, "pull",
			[]string{"pull", "--progress", "--rebase"}},
		{"/api/git/push", `{"repo":"/work/repo"}`, "push", []string{"push", "--progress"}},
	}
	for _, c := range cases {
		t.Run(c.path+" "+c.body, func(t *testing.T) {
			var got []string
			s := gitRemoteServer(t, newGitRemoteFake(t), func(_ context.Context, _ string, args []string, _ func(string, string)) (int, error) {
				got = append([]string(nil), args...)
				return 0, nil
			})
			code, out := gitReq(t, s, http.MethodPost, c.path, c.body)
			if code != http.StatusOK {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			if out["requested"] != gitRemoteRepo || out["repo"] != gitRemoteRepo {
				t.Fatalf("requested/repo = %v / %v", out["requested"], out["repo"])
			}
			id := gitRemoteJobID(t, out)
			gitRemoteWaitDone(t, s, id)
			if fmt.Sprint(got) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got, c.want)
			}
			jb, _ := s.gitJobs.get(s.Git).Get(id)
			if jb.Kind != c.kind {
				t.Fatalf("kind = %q, want %q", jb.Kind, c.kind)
			}
		})
	}
}

// K4 (V40, FR-GIT-101): 같은 리포의 두 번째 원격 작업은 409 job_busy 다.
func TestGitRemote_SecondJobIsBusy(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	s := gitRemoteServer(t, newGitRemoteFake(t), gitRemoteHold(release))

	code, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":"/work/repo"}`)
	if code != http.StatusOK {
		t.Fatalf("첫 요청 code = %d, body = %v", code, out)
	}
	code, out = gitReq(t, s, http.MethodPost, "/api/git/push", `{"repo":"/work/repo"}`)
	if code != http.StatusConflict {
		t.Fatalf("두 번째 code = %d, body = %v", code, out)
	}
	if out["error"] != gitErrJobBusy {
		t.Fatalf("error = %v, want %q", out["error"], gitErrJobBusy)
	}
}

// K5 (V44, FR-GIT-106): confirm 없는 force:"force" 는 400 이다. 클라이언트만 막으면
// API 직접 호출이 우회한다.
func TestGitPush_ForceNeedsConfirm(t *testing.T) {
	cases := []struct {
		name string
		body string
		code int
		err  string
		want []string
	}{
		{"확인 없는 force", `{"repo":"/work/repo","force":"force"}`, http.StatusBadRequest, gitErrConfirmRequired, nil},
		{"확인 있는 force", `{"repo":"/work/repo","force":"force","confirm":true}`, http.StatusOK, "",
			[]string{"push", "--progress", "--force"}},
		{"lease 는 확인 없이", `{"repo":"/work/repo","force":"lease"}`, http.StatusOK, "",
			[]string{"push", "--progress", "--force-with-lease"}},
		{"모르는 force", `{"repo":"/work/repo","force":"hard"}`, http.StatusBadRequest, gitErrBadRequest, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var got []string
			s := gitRemoteServer(t, newGitRemoteFake(t), func(_ context.Context, _ string, args []string, _ func(string, string)) (int, error) {
				got = append([]string(nil), args...)
				return 0, nil
			})
			code, out := gitReq(t, s, http.MethodPost, "/api/git/push", c.body)
			if code != c.code {
				t.Fatalf("code = %d, want %d (body=%v)", code, c.code, out)
			}
			if c.err != "" {
				if out["error"] != c.err {
					t.Fatalf("error = %v, want %q", out["error"], c.err)
				}
				return
			}
			gitRemoteWaitDone(t, s, gitRemoteJobID(t, out))
			if fmt.Sprint(got) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got, c.want)
			}
		})
	}
}

// K6 (V41, FR-GIT-100): upstream 이 없으면 Publish 임을 **실행 전에** 알린다.
// 확인 없이 온 요청은 409 이며, 무엇이 설정될지를 계획으로 준다.
func TestGitPush_PublishAnnouncedBeforeRun(t *testing.T) {
	f := newGitRemoteFake(t)
	f.branch, f.upstream = "no-upstream", ""
	var got []string
	s := gitRemoteServer(t, f, func(_ context.Context, _ string, args []string, _ func(string, string)) (int, error) {
		got = append([]string(nil), args...)
		return 0, nil
	})

	code, out := gitReq(t, s, http.MethodPost, "/api/git/push", `{"repo":"/work/repo"}`)
	if code != http.StatusConflict {
		t.Fatalf("code = %d, want 409 (body=%v)", code, out)
	}
	if out["error"] != gitErrPublishRequired {
		t.Fatalf("error = %v, want %q", out["error"], gitErrPublishRequired)
	}
	plan, _ := out["plan"].(map[string]any)
	if plan["publish"] != true || plan["remote"] != "origin" || plan["branch"] != "no-upstream" {
		t.Fatalf("plan = %v", plan)
	}
	if got != nil {
		t.Fatalf("확인 전에 실행됐다: %v", got)
	}

	code, out = gitReq(t, s, http.MethodPost, "/api/git/push", `{"repo":"/work/repo","publish":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	gitRemoteWaitDone(t, s, gitRemoteJobID(t, out))
	want := []string{"push", "--progress", "-u", "origin", "no-upstream"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
}

// 원격이 없으면 Publish 할 곳이 없다 — 사유가 코드로 구분돼야 한다.
func TestGitPush_NoRemote(t *testing.T) {
	f := newGitRemoteFake(t)
	f.branch, f.upstream, f.config = "no-upstream", "", "core.bare=false\n"
	s := gitRemoteServer(t, f, gitRemoteEmit())
	code, out := gitReq(t, s, http.MethodPost, "/api/git/push", `{"repo":"/work/repo","publish":true}`)
	if code != http.StatusConflict || out["error"] != gitErrNoRemote {
		t.Fatalf("code = %d, error = %v", code, out["error"])
	}
}

// K7 (V42, FR-GIT-103): SSE 가 줄 이벤트와 종료 이벤트를 준다. after=<seq> 는
// 재연결 지점이며 이미 본 줄을 다시 보내지 않는다.
func TestGitJobEvents_ReplayAfterSeq(t *testing.T) {
	s := gitRemoteServer(t, newGitRemoteFake(t), gitRemoteEmit("한 줄", "두 줄", "세 줄"))
	_, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":"/work/repo"}`)
	id := gitRemoteJobID(t, out)
	gitRemoteWaitDone(t, s, id)

	body := gitSSE(t, s, "/api/git/job/events?id="+id+"&after=1")
	lines, done := gitParseSSE(t, body)
	if len(lines) != 2 || lines[0]["text"] != "두 줄" || lines[1]["text"] != "세 줄" {
		t.Fatalf("line 이벤트 = %v", lines)
	}
	if lines[0]["stream"] != "stderr" {
		t.Fatalf("stream = %v — 진행은 stderr 로 온다", lines[0]["stream"])
	}
	if done == nil || done["done"] != true || done["id"] != id {
		t.Fatalf("done 이벤트 = %v", done)
	}
}

// 처음 연결은 보존된 줄 전부를 받는다.
func TestGitJobEvents_FromStart(t *testing.T) {
	s := gitRemoteServer(t, newGitRemoteFake(t), gitRemoteEmit("가", "나"))
	_, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":"/work/repo"}`)
	id := gitRemoteJobID(t, out)
	gitRemoteWaitDone(t, s, id)

	lines, done := gitParseSSE(t, gitSSE(t, s, "/api/git/job/events?id="+id))
	if len(lines) != 2 || lines[0]["seq"] != float64(1) {
		t.Fatalf("line 이벤트 = %v", lines)
	}
	if done == nil {
		t.Fatal("done 이벤트가 없다")
	}
}

// 없는 작업의 스트림은 404 다. 조용히 빈 스트림을 주면 클라이언트가 영원히 기다린다.
func TestGitJobEvents_UnknownJob(t *testing.T) {
	s := gitRemoteServer(t, newGitRemoteFake(t), gitRemoteEmit())
	code, out := gitReq(t, s, http.MethodGet, "/api/git/job/events?id=없는것", "")
	if code != http.StatusNotFound || out["error"] != gitErrJobNotFound {
		t.Fatalf("code = %d, error = %v", code, out["error"])
	}
	code, out = gitReq(t, s, http.MethodGet, "/api/git/job/events", "")
	if code != http.StatusBadRequest {
		t.Fatalf("id 없는 요청 code = %d, body = %v", code, out)
	}
}

// K8 (FR-GIT-102): 취소는 작업을 끝내고 부분 적용 가능성을 남긴다.
func TestGitJobCancel(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	s := gitRemoteServer(t, newGitRemoteFake(t), gitRemoteHold(release))
	_, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":"/work/repo"}`)
	id := gitRemoteJobID(t, out)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/job/cancel", `{"id":"`+id+`"}`)
	if code != http.StatusOK || out["ok"] != true || out["canceled"] != true {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	jb := gitRemoteWaitDone(t, s, id)
	if !jb.Canceled || jb.Err == "" {
		t.Fatalf("작업 = %+v", jb)
	}

	code, out = gitReq(t, s, http.MethodPost, "/api/git/job/cancel", `{"id":"없는것"}`)
	if code != http.StatusNotFound || out["error"] != gitErrJobNotFound {
		t.Fatalf("없는 작업 code = %d, error = %v", code, out["error"])
	}
}

// K9 (V63, FR-GIT-112): 진행 중 작업은 /api/git/jobs 에 보인다. 끝나면 빠진다.
func TestGitJobs_ActiveList(t *testing.T) {
	release := make(chan struct{})
	s := gitRemoteServer(t, newGitRemoteFake(t), gitRemoteHold(release))
	_, out := gitReq(t, s, http.MethodPost, "/api/git/push", `{"repo":"/work/repo"}`)
	id := gitRemoteJobID(t, out)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/jobs", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	jobs, _ := out["jobs"].([]any)
	if len(jobs) != 1 {
		t.Fatalf("jobs = %v", out["jobs"])
	}
	first, _ := jobs[0].(map[string]any)
	if first["id"] != id || first["kind"] != "push" || first["repo"] != gitRemoteRepo {
		t.Fatalf("작업 = %v", first)
	}

	close(release)
	gitRemoteWaitDone(t, s, id)
	_, out = gitReq(t, s, http.MethodGet, "/api/git/jobs", "")
	if jobs, _ := out["jobs"].([]any); len(jobs) != 0 {
		t.Fatalf("끝난 작업이 목록에 남았다: %v", out["jobs"])
	}
}

// K10 (FR-GIT-107): 작업이 끝나면 status 캐시가 만료된다 — ahead/behind 가
// 폴링 주기를 기다리지 않는다.
func TestGitRemote_InvalidatesStatusCacheOnDone(t *testing.T) {
	f := newGitRemoteFake(t)
	s := gitRemoteServer(t, f, gitRemoteEmit("끝"))

	// 캐시를 채운다.
	if code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo=/work/repo", ""); code != http.StatusOK {
		t.Fatalf("status code = %d, body = %v", code, out)
	}
	_, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":"/work/repo"}`)
	gitRemoteWaitDone(t, s, gitRemoteJobID(t, out))

	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo=/work/repo", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if out["cached"] != false {
		t.Fatal("작업이 끝났는데 캐시가 그대로다 (FR-GIT-107)")
	}
}

// gitSSE 는 SSE 응답 본문을 통째로 읽는다. 끝난 작업의 스트림은 done 이벤트 뒤에
// 닫히므로 동기적으로 읽을 수 있다.
func gitSSE(t *testing.T, s *Server, path string) string {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, body = %q", ct, rec.Body.String())
	}
	return rec.Body.String()
}

// gitParseSSE 는 line 이벤트 목록과 done 이벤트를 뽑는다.
func gitParseSSE(t *testing.T, body string) ([]map[string]any, map[string]any) {
	t.Helper()
	var lines []map[string]any
	var done map[string]any
	for _, block := range strings.Split(body, "\n\n") {
		name, payload := "", ""
		for _, l := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(l, "event: "):
				name = strings.TrimPrefix(l, "event: ")
			case strings.HasPrefix(l, "data: "):
				payload = strings.TrimPrefix(l, "data: ")
			}
		}
		if name == "" || payload == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(payload), &m); err != nil {
			t.Fatalf("%s 이벤트가 JSON 이 아니다: %q", name, payload)
		}
		switch name {
		case "line":
			lines = append(lines, m)
		case "done":
			done = m
		}
	}
	return lines, done
}
