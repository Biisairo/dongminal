package gitapi

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/git/write"
)

// 묶음 E 서버측 — /api/git/{remotes,remote/add,remote/remove,sync,push/preview}
// (GIT_ACTIONS_SRS §3.5 FR-GIT-269·270·271, 검증 V196·V197·V198).
//
// **서버가 마지막 방어선이다** — Sync 의 "앞이 실패하면 뒤를 돌리지 않는다"를
// 클라이언트가 지키게 두면 API 직접 호출이 그대로 우회한다.

// gitActFake 는 읽기를 격리한다. 원격 동작이 딛는 것은 status·config·for-each-ref·
// log 넷뿐이므로 그 넷만 답한다.
type gitActFake struct {
	mu       sync.Mutex
	gitDir   string
	branch   string
	upstream string
	config   string
	refs     string
	log      string
	wrote    [][]string
}

func newGitActFake(t *testing.T) *gitActFake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &gitActFake{
		gitDir:   dir,
		branch:   "main",
		upstream: "origin/main",
		config:   "remote.origin.url=/tmp/remote.git\n",
		refs: strings.Join([]string{
			"refs/heads/main\x00" + strings.Repeat("a", 40) + "\x00origin/main\x00\x00*\x00머리\x001700000000",
			"refs/remotes/origin/main\x00" + strings.Repeat("b", 40) + "\x00\x00\x00\x00머리\x001700000000",
			"",
		}, "\n"),
	}
}

func (f *gitActFake) read(_ context.Context, dir string, args []string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		return core.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case args[0] == "status":
		toks := []string{"# branch.oid " + strings.Repeat("a", 40), "# branch.head " + f.branch}
		if f.upstream != "" {
			toks = append(toks, "# branch.upstream "+f.upstream, "# branch.ab +2 -0")
		}
		return core.Output{Stdout: strings.Join(toks, "\x00") + "\x00"}, nil
	case args[0] == "config":
		return core.Output{Stdout: f.config}, nil
	case args[0] == "for-each-ref":
		return core.Output{Stdout: f.refs}, nil
	case args[0] == "log":
		f.log = strings.Join(args, " ")
		return core.Output{Stdout: gitActLogOut()}, nil
	}
	return core.Output{}, nil
}

func (f *gitActFake) logArgv() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.log
}

func (f *gitActFake) wrotes() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.wrote...)
}

// gitActLogOut 은 커밋 하나짜리 log 출력이다 (9필드, NUL 로만 나뉜다).
func gitActLogOut() string {
	f := []string{
		strings.Repeat("c", 40), "cccccc", strings.Repeat("d", 40),
		"dm", "dm@example.test", "1700000000", "1700000000", "", "밀 것",
	}
	return strings.Join(f, "\x00")
}

func gitActServer(t *testing.T, f *gitActFake, run jobs.JobRunner) *GitServer {
	t.Helper()
	st := store.NewStore(core.New(
		core.WithRunner(f.read),
		core.WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.wrote = append(f.wrote, append([]string(nil), args...))
			return core.Output{}, nil
		}),
	))
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: st}
	s.gitJobs.run = run
	return s
}

var gitActEndpoints = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodGet, "/api/git/remotes?repo=/work/repo", ""},
	{http.MethodPost, "/api/git/remote/add", `{"repo":` + qWorkRepo + `,"name":"up","url":"/tmp/u.git"}`},
	{http.MethodPost, "/api/git/remote/remove", `{"repo":` + qWorkRepo + `,"name":"origin"}`},
	{http.MethodPost, "/api/git/sync", `{"repo":` + qWorkRepo + `}`},
	{http.MethodGet, "/api/git/sync?id=x", ""},
	{http.MethodGet, "/api/git/push/preview?repo=/work/repo", ""},
}

// E1: 새 표면이 전부 gitapi.routes 에 있다. UI 는 이 위에만 선다.
func TestGitRemoteActionRoutesRegistered(t *testing.T) {
	for _, ep := range gitActEndpoints {
		path := strings.SplitN(ep.path, "?", 2)[0]
		found := false
		for _, rt := range routes {
			if rt.method != "" && rt.method != ep.method {
				continue
			}
			if rt.match(path) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s %s 가 gitapi.routes 에 없다", ep.method, path)
		}
	}
}

// E2: Git 이 없으면 전부 503 이다 (FR-GIT-60).
func TestGitRemoteActions_Unavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitActEndpoints {
		code, out := gitReq(t, s, ep.method, ep.path, ep.body)
		if code != http.StatusServiceUnavailable || out["error"] != gitErrUnavailable {
			t.Errorf("%s %s → %d %v", ep.method, ep.path, code, out["error"])
		}
	}
}

// ── FR-GIT-269 (V196) ──

func TestGitRemotes_List(t *testing.T) {
	f := newGitActFake(t)
	f.config = "remote.origin.url=/tmp/a.git\nremote.up.url=https://u:pw@example.test/b.git\n"
	s := gitActServer(t, f, nil)
	code, out := gitReq(t, s, http.MethodGet, "/api/git/remotes?repo=/work/repo", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	list, _ := out["remotes"].([]any)
	if len(list) != 2 {
		t.Fatalf("remotes = %v", out["remotes"])
	}
	// FR-GIT-104: URL 에 박힌 자격증명은 응답에 나오지 않는다.
	if strings.Contains(fmt.Sprint(out["remotes"]), "pw") {
		t.Fatalf("자격증명이 응답에 나왔다: %v", out["remotes"])
	}
}

func TestGitRemoteAdd_RunsAndReturnsList(t *testing.T) {
	f := newGitActFake(t)
	s := gitActServer(t, f, nil)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/remote/add",
		`{"repo":`+qWorkRepo+`,"name":"up","url":"/tmp/u.git"}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	want := []string{"remote", "add", "up", "/tmp/u.git"}
	if got := f.wrotes(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	if _, ok := out["remotes"].([]any); !ok {
		t.Fatalf("목록이 응답에 없다: %v", out)
	}
}

// FR-GIT-269: remove 는 되살릴 `git remote add <name> <url>` 을 hint 로 남긴다.
func TestGitRemoteRemove_LeavesRecoveryHint(t *testing.T) {
	f := newGitActFake(t)
	s := gitActServer(t, f, nil)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/remote/remove",
		`{"repo":`+qWorkRepo+`,"name":"origin"}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	want := []string{"remote", "remove", "origin"}
	if got := f.wrotes(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	_, rec := gitReq(t, s, http.MethodGet, "/api/git/recovery", "")
	hints, _ := rec["hints"].([]any)
	if len(hints) != 1 {
		t.Fatalf("hints = %v", rec["hints"])
	}
	h, _ := hints[0].(map[string]any)
	if h["action"] != write.RemoteRemoveAction {
		t.Fatalf("action = %v", h["action"])
	}
	cmd, _ := h["command"].(string)
	if !strings.Contains(cmd, "git remote add origin /tmp/remote.git") {
		t.Fatalf("command = %q", cmd)
	}
}

// FR-GIT-250.3: 잘못된 이름·URL 은 **실행 전에** 400 이다.
func TestGitRemoteAdd_Rejects(t *testing.T) {
	cases := []struct {
		name, body, want string
	}{
		{"빈 이름", `{"repo":` + qWorkRepo + `,"name":"","url":"/tmp/a.git"}`, gitErrBadRequest},
		{"슬래시 이름", `{"repo":` + qWorkRepo + `,"name":"a/b","url":"/tmp/a.git"}`, gitErrBadRequest},
		{"옵션 URL", `{"repo":` + qWorkRepo + `,"name":"up","url":"--upload-pack=x"}`, gitErrBadRequest},
		{"이미 있음", `{"repo":` + qWorkRepo + `,"name":"origin","url":"/tmp/a.git"}`, gitErrRemoteExists},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitActFake(t)
			s := gitActServer(t, f, nil)
			code, out := gitReq(t, s, http.MethodPost, "/api/git/remote/add", c.body)
			if code == http.StatusOK || out["error"] != c.want {
				t.Fatalf("code = %d, error = %v, want %q", code, out["error"], c.want)
			}
			if got := f.wrotes(); len(got) != 0 {
				t.Fatalf("거부했는데 실행됐다: %v", got)
			}
		})
	}
}

func TestGitRemoteRemove_MissingIsRejected(t *testing.T) {
	f := newGitActFake(t)
	s := gitActServer(t, f, nil)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/remote/remove",
		`{"repo":`+qWorkRepo+`,"name":"nope"}`)
	if code != http.StatusNotFound || out["error"] != gitErrRemoteMissing {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if got := f.wrotes(); len(got) != 0 {
		t.Fatalf("거부했는데 실행됐다: %v", got)
	}
}

// ── FR-GIT-270 (V197) ──

// gitActSteps 는 돈 작업의 하위 명령을 순서대로 모으는 실행기다. exit 는 kind 별로
// 정한다 — pull 을 실패시켜 "뒤를 돌리지 않는다"를 볼 수 있어야 한다.
func gitActSteps(seen *[]string, mu *sync.Mutex, exit map[string]int) jobs.JobRunner {
	return func(_ context.Context, _ string, args []string, emit func(string, string)) (int, error) {
		mu.Lock()
		*seen = append(*seen, args[0])
		mu.Unlock()
		emit("stderr", "remote: "+args[0])
		return exit[args[0]], nil
	}
}

func gitActWaitSync(t *testing.T, s *GitServer, id string) map[string]any {
	t.Helper()
	for i := 0; i < 600; i++ {
		_, out := gitReq(t, s, http.MethodGet, "/api/git/sync?id="+id, "")
		if out["done"] == true {
			return out
		}
		time.Sleep(3 * time.Millisecond)
	}
	t.Fatalf("sync %s 가 끝나지 않았다", id)
	return nil
}

// V197 의 본체: **pull 이 실패하면 push 를 돌리지 않는다.**
func TestGitSync_StopsWhenPullFails(t *testing.T) {
	var seen []string
	var mu sync.Mutex
	f := newGitActFake(t)
	s := gitActServer(t, f, gitActSteps(&seen, &mu, map[string]int{"pull": 1}))

	code, out := gitReq(t, s, http.MethodPost, "/api/git/sync", `{"repo":`+qWorkRepo+`}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	sync, _ := out["sync"].(map[string]any)
	id, _ := sync["id"].(string)
	if id == "" {
		t.Fatalf("sync 식별자가 없다: %v", out)
	}
	final := gitActWaitSync(t, s, id)
	if final["stopped"] != true {
		t.Fatalf("멈추지 않았다: %v", final)
	}
	if r, _ := final["reason"].(string); r == "" {
		t.Fatal("멈춘 사유가 비었다 — 사용자는 push 가 돈 줄 안다")
	}
	mu.Lock()
	got := append([]string(nil), seen...)
	mu.Unlock()
	if fmt.Sprint(got) != fmt.Sprint([]string{"pull"}) {
		t.Fatalf("돈 작업 = %v — push 가 돌았다 (V197 위반)", got)
	}
}

// pull 이 성공하면 push 가 **그 뒤에** 돈다. 순서가 곧 규약이다.
func TestGitSync_RunsPullThenPush(t *testing.T) {
	var seen []string
	var mu sync.Mutex
	f := newGitActFake(t)
	s := gitActServer(t, f, gitActSteps(&seen, &mu, map[string]int{}))

	code, out := gitReq(t, s, http.MethodPost, "/api/git/sync", `{"repo":`+qWorkRepo+`}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	sync, _ := out["sync"].(map[string]any)
	id, _ := sync["id"].(string)
	final := gitActWaitSync(t, s, id)
	if final["stopped"] == true {
		t.Fatalf("멈췄다: %v", final)
	}
	if final["pushJob"] == nil || final["pushJob"] == "" {
		t.Fatalf("push 작업이 없다: %v", final)
	}
	mu.Lock()
	got := append([]string(nil), seen...)
	mu.Unlock()
	if fmt.Sprint(got) != fmt.Sprint([]string{"pull", "push"}) {
		t.Fatalf("돈 작업 = %v, want [pull push]", got)
	}
}

// 잘못된 요청은 **아무것도 돌리기 전에** 400 이다 — pull 만 돌고 push 가 막히면
// 저장소가 사용자가 요청하지 않은 중간 상태로 남는다.
func TestGitSync_RejectsBeforeRunning(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"모르는 pull 모드", `{"repo":` + qWorkRepo + `,"mode":"squash"}`, gitErrBadRequest},
		{"확인 없는 force", `{"repo":` + qWorkRepo + `,"force":"force"}`, gitErrConfirmRequired},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var seen []string
			var mu sync.Mutex
			f := newGitActFake(t)
			s := gitActServer(t, f, gitActSteps(&seen, &mu, map[string]int{}))
			code, out := gitReq(t, s, http.MethodPost, "/api/git/sync", c.body)
			if code != http.StatusBadRequest || out["error"] != c.want {
				t.Fatalf("code = %d, error = %v, want %q", code, out["error"], c.want)
			}
			mu.Lock()
			n := len(seen)
			mu.Unlock()
			if n != 0 {
				t.Fatalf("거부했는데 %v 가 돌았다", seen)
			}
		})
	}
}

// upstream 이 없으면 Sync 도 Publish 를 **실행 전에** 되묻는다 (FR-GIT-100).
func TestGitSync_PublishAskedBeforePull(t *testing.T) {
	var seen []string
	var mu sync.Mutex
	f := newGitActFake(t)
	f.upstream = ""
	f.branch = "feat"
	s := gitActServer(t, f, gitActSteps(&seen, &mu, map[string]int{}))
	code, out := gitReq(t, s, http.MethodPost, "/api/git/sync", `{"repo":`+qWorkRepo+`}`)
	if code != http.StatusConflict || out["error"] != gitErrPublishRequired {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	mu.Lock()
	n := len(seen)
	mu.Unlock()
	if n != 0 {
		t.Fatalf("되물었는데 %v 가 돌았다", seen)
	}
}

// ── FR-GIT-271 (V198) ──

// 목록은 `log <upstream>..<branch>` 다. **새 조회를 만들지 않는다.**
func TestGitPushPreview_OutgoingRange(t *testing.T) {
	f := newGitActFake(t)
	s := gitActServer(t, f, nil)
	code, out := gitReq(t, s, http.MethodGet, "/api/git/push/preview?repo=/work/repo", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if out["remote"] != "origin" || out["branch"] != "main" {
		t.Fatalf("대상 = %v/%v", out["remote"], out["branch"])
	}
	if out["publish"] != false {
		t.Fatalf("publish = %v — 원격에 브랜치가 있다", out["publish"])
	}
	if !strings.Contains(f.logArgv(), "origin/main..main") {
		t.Fatalf("log argv = %q", f.logArgv())
	}
	commits, _ := out["commits"].([]any)
	if len(commits) != 1 {
		t.Fatalf("commits = %v", out["commits"])
	}
	// 대상을 고치려면 고를 원격 목록이 필요하다.
	if _, ok := out["remotes"].([]any); !ok {
		t.Fatalf("원격 목록이 없다: %v", out)
	}
}

// 원격에 그 브랜치가 없으면 범위가 없다 — publish 이며 브랜치 전부가 올라간다.
func TestGitPushPreview_PublishHasNoRange(t *testing.T) {
	f := newGitActFake(t)
	s := gitActServer(t, f, nil)
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/push/preview?repo=/work/repo&remote=origin&branch=feat", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if out["publish"] != true {
		t.Fatalf("publish = %v", out["publish"])
	}
	if strings.Contains(f.logArgv(), "..") {
		t.Fatalf("없는 원격 ref 로 범위를 만들었다: %q", f.logArgv())
	}
}

// 대상 이름은 실행 전에 검증한다 (FR-GIT-250.3).
func TestGitPushPreview_RejectsUnsafeTarget(t *testing.T) {
	f := newGitActFake(t)
	s := gitActServer(t, f, nil)
	for _, q := range []string{"&remote=-x&branch=main", "&remote=origin&branch=a..b"} {
		code, out := gitReq(t, s, http.MethodGet, "/api/git/push/preview?repo=/work/repo"+q, "")
		if code != http.StatusBadRequest || out["error"] != gitErrBadRequest {
			t.Errorf("%s → %d %v", q, code, out["error"])
		}
	}
}
