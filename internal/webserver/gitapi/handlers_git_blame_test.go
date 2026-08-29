package gitapi

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
	"net/url"
)

// FR-GIT-276 — /api/git/blame. 검증 V211.

type gitBlameFake struct {
	root      string
	gitDir    string
	out       string
	fail      string
	truncated bool
	argvs     [][]string
}

func (f *gitBlameFake) runner(_ context.Context, _ string, args []string) (core.Output, error) {
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		return core.Output{Stdout: f.root + "\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	}
	f.argvs = append(f.argvs, append([]string(nil), args...))
	if args[0] == "blame" {
		if f.fail != "" {
			return core.Output{ExitCode: 128, Stderr: f.fail}, nil
		}
		return core.Output{Stdout: f.out, StdoutTruncated: f.truncated}, nil
	}
	return core.Output{ExitCode: 128, Stderr: "fatal: 예상하지 못한 호출\n"}, nil
}

func (f *gitBlameFake) calls() []string {
	out := make([]string, 0, len(f.argvs))
	for _, a := range f.argvs {
		out = append(out, strings.Join(a, " "))
	}
	return out
}

func newGitBlameFake(t *testing.T) *gitBlameFake {
	t.Helper()
	root := t.TempDir()
	return &gitBlameFake{root: root, gitDir: filepath.Join(root, ".git"),
		out: "1111111111111111111111111111111111111111 1 1 1\n" +
			"author 김 동민\n" +
			"author-mail <dy@example.com>\n" +
			"author-time 1700000000\n" +
			"summary 첫 커밋\n" +
			"filename f.txt\n" +
			"\ta\n"}
}

func gitBlameServer(t *testing.T, f *gitBlameFake) *GitServer {
	t.Helper()
	st := store.NewStore(core.New(core.WithRunner(f.runner)))
	return &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: st}
}

func TestGitBlameRouteRegistered(t *testing.T) {
	found := false
	for _, rt := range routes {
		if (rt.method == "" || rt.method == http.MethodGet) && rt.match("/api/git/blame") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("GET /api/git/blame 이 gitapi.routes 에 없다")
	}
}

// 요청을 그대로 되돌려준다 — 되돌아오지 않으면 클라이언트는 늦게 온 응답이 어느
// 파일의 것인지 구분하지 못한다 (FR-GIT-54 의 stale 가드와 같은 규약).
func TestAPIGitBlame_EchoesRequested(t *testing.T) {
	f := newGitBlameFake(t)
	s := gitBlameServer(t, f)
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/blame?repo="+f.root+"&path=d+ir%2Ff.txt&rev=HEAD%7E1", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	req, ok := out["requested"].(map[string]any)
	if !ok {
		t.Fatalf("requested 가 없다: %v", out)
	}
	if req["repo"] != f.root || req["path"] != "d ir/f.txt" || req["rev"] != "HEAD~1" {
		t.Fatalf("requested = %#v", req)
	}
	if call := strings.Join(f.calls(), " | "); call != "blame --porcelain HEAD~1 -- d ir/f.txt" {
		t.Fatalf("argv = %q", call)
	}
	lines, ok := out["lines"].([]any)
	if !ok || len(lines) != 1 {
		t.Fatalf("lines = %#v", out["lines"])
	}
	l0, _ := lines[0].(map[string]any)
	if l0["text"] != "a" || l0["line"] != float64(1) {
		t.Fatalf("lines[0] = %#v", l0)
	}
	// 커밋 메타는 oid 로 찾는 맵이다 — 줄마다 되풀이하면 큰 파일에서 응답이
	// 본문보다 커진다.
	cs, ok := out["commits"].(map[string]any)
	if !ok || len(cs) != 1 {
		t.Fatalf("commits = %#v", out["commits"])
	}
	c := cs["1111111111111111111111111111111111111111"].(map[string]any)
	if c["authorName"] != "김 동민" || c["summary"] != "첫 커밋" {
		t.Fatalf("commit = %#v", c)
	}
}

// 잘못된 요청은 400 이고 **실행하지 않는다.**
func TestAPIGitBlame_RejectsBadParams(t *testing.T) {
	f := newGitBlameFake(t)
	s := gitBlameServer(t, f)
	for _, q := range []string{
		"&path=",
		"&path=..%2Fetc%2Fpasswd",
		"&path=%2Fetc%2Fpasswd",
		"&path=f.txt&rev=--all",
	} {
		code, out := gitReq(t, s, http.MethodGet, "/api/git/blame?repo="+f.root+q, "")
		if code != http.StatusBadRequest {
			t.Fatalf("%q → %d, want 400 (body %v)", q, code, out)
		}
		if out["error"] != gitErrBadRequest {
			t.Fatalf("%q error = %v", q, out["error"])
		}
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부했는데 실행했다: %v", f.calls())
	}
}

// git 이 없는 환경에서는 503 이다.
func TestAPIGitBlame_Unavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}}
	code, _ := gitReq(t, s, http.MethodGet, "/api/git/blame?repo="+url.QueryEscape(absX)+"&path=f.txt", "")
	if code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", code)
	}
}

// 없는 경로는 404 다 — 500 으로 뭉개면 클라이언트는 자기 요청이 틀렸는지 알 수 없다.
// **아직 커밋되지 않은 파일도 여기로 온다** (git 2.50.1 은 둘 다 같은 문구다).
func TestAPIGitBlame_UnknownPathIsNotFound(t *testing.T) {
	f := newGitBlameFake(t)
	f.fail = "fatal: no such path 'none.txt' in HEAD\n"
	s := gitBlameServer(t, f)
	code, out := gitReq(t, s, http.MethodGet, "/api/git/blame?repo="+f.root+"&path=none.txt", "")
	if code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404 (body %v)", code, out)
	}
	if out["error"] != gitErrNotFound {
		t.Fatalf("error = %v", out["error"])
	}
}

// 상한에서 잘린 blame 은 413 이다 — 400 이면 요청이 틀렸다는 뜻이 되고 500 이면
// 사용자는 고장으로 읽는다. 실제로는 "이 파일은 이 화면이 감당할 크기가 아니다" 다.
func TestAPIGitBlame_TruncatedIsTooLarge(t *testing.T) {
	f := newGitBlameFake(t)
	f.truncated = true
	s := gitBlameServer(t, f)
	code, out := gitReq(t, s, http.MethodGet, "/api/git/blame?repo="+f.root+"&path=f.txt", "")
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code = %d, want 413 (body %v)", code, out)
	}
}
