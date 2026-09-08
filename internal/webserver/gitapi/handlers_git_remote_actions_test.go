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

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/git/write"
	"net/url"
)

// 묶음 E 서버측 — /api/git/{remotes,remote/add,remote/remove}
//
// `sync` 와 `push/preview` 는 GIT_CHANGES_CONTROLS_SRS FR-GCC-4 로 지워졌다 —
// 클라이언트가 유일한 소비자였으므로 종단도 함께 걷혔다.
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
	{http.MethodGet, "/api/git/remotes?repo=" + url.QueryEscape(absWorkRepo), ""},
	{http.MethodPost, "/api/git/remote/add", `{"repo":` + qWorkRepo + `,"name":"up","url":"/tmp/u.git"}`},
	{http.MethodPost, "/api/git/remote/remove", `{"repo":` + qWorkRepo + `,"name":"origin"}`},
}

// E1: 새 표면이 전부 gitapi.routes 에 있다. UI 는 이 위에만 선다.
func TestGitRemoteActionRoutesRegistered(t *testing.T) {
	for _, ep := range gitActEndpoints {
		path := strings.SplitN(ep.path, "?", 2)[0]
		found := false
		for _, rt := range routes {
			if rt.Method != "" && rt.Method != ep.method {
				continue
			}
			if rt.Match(path) {
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
	code, out := gitReq(t, s, http.MethodGet, "/api/git/remotes?repo="+url.QueryEscape(absWorkRepo), "")
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
