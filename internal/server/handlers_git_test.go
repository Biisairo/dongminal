package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/git"
)

// 묶음 B·C 서버측 — /api/git/* (GIT_SRS §3.8 FR-GIT-60~63, 검증 V3·V4·V13·V16·V28·V29).

var gitStatusFixture = strings.Join([]string{
	"# branch.oid 1111111111111111111111111111111111111111",
	"# branch.head main",
	"? a.txt",
}, "\x00") + "\x00"

// gitFake 은 server 계층용 git.Runner 다. **호출 argv 를 전부 기록한다** —
// "무엇을 실행하지 않았는가"를 검사해야 하기 때문이다 (FR-GIT-24).
type gitFake struct {
	mu     sync.Mutex
	argvs  [][]string
	gitDir string
	// root 가 nil 이면 요청 dir 를 그대로 루트로 답한다.
	root func(dir string) (git.Output, error)
	// statusHold 는 status 진입 시 호출된다. single-flight 를 관찰할 지점이다.
	statusHold func()
}

// newGitFake 은 HEAD 만 있는 gitdir 을 만든다. Store 의 관측이 signature 도 함께
// 채우므로 읽을 HEAD 가 실제로 있어야 한다.
func newGitFake(t *testing.T) *gitFake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &gitFake{gitDir: dir}
}

func (g *gitFake) runner(_ context.Context, dir string, args []string) (git.Output, error) {
	g.mu.Lock()
	g.argvs = append(g.argvs, append([]string(nil), args...))
	g.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		if g.root != nil {
			return g.root(dir)
		}
		return git.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse":
		return git.Output{Stdout: g.gitDir + "\n" + g.gitDir + "\n"}, nil
	case args[0] == "status":
		if g.statusHold != nil {
			g.statusHold()
		}
		return git.Output{Stdout: gitStatusFixture}, nil
	}
	return git.Output{}, nil
}

func (g *gitFake) count(sub string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, a := range g.argvs {
		if len(a) > 0 && a[0] == sub {
			n++
		}
	}
	return n
}

// gitTestServer 는 주입 Runner 를 쓰는 Store 로 Server 를 세운다. 시계를 고정해
// TTL 이 테스트 도중 만료되지 않게 한다.
func gitTestServer(t *testing.T, g *gitFake, opts ...git.StoreOption) (*Server, *fakePaneHub, *fakeWorkspaceStore, *fakeCommandBroker) {
	t.Helper()
	at := time.Now()
	all := append([]git.StoreOption{git.WithClock(func() time.Time { return at })}, opts...)
	store := git.NewStore(git.New(git.WithRunner(g.runner)), all...)
	hub := newFakePaneHub()
	ws := newFakeWorkspaceStore()
	cb := &fakeCommandBroker{}
	return &Server{Tools: hub, Work: ws, Commands: cb, Git: store}, hub, ws, cb
}

func gitReq(t *testing.T, s *Server, method, path, body string) (int, map[string]any) {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

var gitEndpoints = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodGet, "/api/git/repos", ""},
	{http.MethodPost, "/api/git/repos/pin", `{"path":"/r"}`},
	{http.MethodPost, "/api/git/repos/unpin", `{"path":"/r"}`},
	{http.MethodGet, "/api/git/status?repo=/r", ""},
	{http.MethodGet, "/api/git/signature?repo=/r", ""},
}

// H1 (V28, FR-GIT-61): 5개 라우트가 apiRoutes 에 등록돼 있다. UI 는 이 표면 위에만
// 선다 (FR-GIT-60).
func TestGitRoutesRegistered(t *testing.T) {
	for _, ep := range gitEndpoints {
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

// H2: s.Git == nil 이면 전부 503 git_unavailable 이고 다른 동작에는 영향이 없다.
func TestGitEndpoints_Unavailable(t *testing.T) {
	s := &Server{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitEndpoints {
		code, out := gitReq(t, s, ep.method, ep.path, ep.body)
		if code != http.StatusServiceUnavailable {
			t.Errorf("%s %s → %d, want 503", ep.method, ep.path, code)
		}
		if out["error"] != gitErrUnavailable {
			t.Errorf("%s %s error=%v, want %q", ep.method, ep.path, out["error"], gitErrUnavailable)
		}
	}
}

// H3 (V3, FR-GIT-9/10): follow 가 저장소일 때와 아닐 때. 저장소가 아니면 path 는
// 비고 사유가 실린다 — 마지막 유효 리포를 유지하지 않는다.
func TestGitRepos_Follow(t *testing.T) {
	t.Run("저장소", func(t *testing.T) {
		g := newGitFake(t)
		s, hub, _, _ := gitTestServer(t, g)
		hub.seed("t1", "T1")
		hub.setCwd("t1", "/work/repo/sub")
		g.root = func(string) (git.Output, error) { return git.Output{Stdout: "/work/repo\n"}, nil }

		code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?tool=t1", "")
		if code != 200 {
			t.Fatalf("code=%d body=%v", code, out)
		}
		follow, _ := out["follow"].(map[string]any)
		if follow["cwd"] != "/work/repo/sub" {
			t.Fatalf("cwd=%v", follow["cwd"])
		}
		if follow["isRepo"] != true || follow["path"] != "/work/repo" || follow["name"] != "repo" {
			t.Fatalf("follow=%v", follow)
		}
		if follow["reason"] != "" {
			t.Fatalf("reason=%v", follow["reason"])
		}
		// 관측 이력이 없으면 배지는 null 이다 (FR-GIT-24).
		if follow["badge"] != nil {
			t.Fatalf("badge=%v, want null", follow["badge"])
		}
	})

	t.Run("저장소 아님", func(t *testing.T) {
		g := newGitFake(t)
		s, hub, _, _ := gitTestServer(t, g)
		hub.seed("t1", "T1")
		hub.setCwd("t1", "/tmp/plain")
		g.root = func(string) (git.Output, error) {
			return git.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
		}

		code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?tool=t1", "")
		if code != 200 {
			t.Fatalf("code=%d body=%v", code, out)
		}
		follow, _ := out["follow"].(map[string]any)
		if follow["isRepo"] != false || follow["path"] != "" {
			t.Fatalf("follow=%v", follow)
		}
		if follow["reason"] != gitErrNotRepo {
			t.Fatalf("reason=%v, want %q", follow["reason"], gitErrNotRepo)
		}
	})
}

// 배지는 Store.Observed 만 읽는다. status 를 한 번 관측한 뒤에야 값이 생긴다.
func TestGitRepos_BadgeFromObservation(t *testing.T) {
	g := newGitFake(t)
	s, hub, _, _ := gitTestServer(t, g)
	hub.seed("t1", "T1")
	hub.setCwd("t1", "/work/repo")
	g.root = func(string) (git.Output, error) { return git.Output{Stdout: "/work/repo\n"}, nil }

	if code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo=/work/repo", ""); code != 200 {
		t.Fatalf("status code=%d body=%v", code, out)
	}
	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?tool=t1", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	follow, _ := out["follow"].(map[string]any)
	badge, _ := follow["badge"].(map[string]any)
	if badge == nil {
		t.Fatalf("badge 가 없다: %v", follow)
	}
	if badge["total"] != float64(1) || badge["branch"] != "main" || badge["detached"] != false {
		t.Fatalf("badge=%v", badge)
	}
	if badge["observedAtUnixMs"] == float64(0) {
		t.Fatalf("observedAtUnixMs=%v", badge["observedAtUnixMs"])
	}
}

// H4 (V24, FR-GIT-24): /api/git/repos 는 git status 를 실행하지 않는다. 핀이
// 여러 개여도 폴링 대상은 활성 1개여야 한다.
func TestGitRepos_NeverRunsStatus(t *testing.T) {
	g := newGitFake(t)
	s, hub, ws, _ := gitTestServer(t, g)
	hub.seed("t1", "T1")
	hub.setCwd("t1", "/work/repo")
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":["/a","/b","/c"]}}`)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?tool=t1", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if n := g.count("status"); n != 0 {
		t.Fatalf("git status 를 %d회 실행했다", n)
	}
	pinned, _ := out["pinned"].([]any)
	if len(pinned) != 3 {
		t.Fatalf("pinned=%v", out["pinned"])
	}
	first, _ := pinned[0].(map[string]any)
	if first["path"] != "/a" || first["name"] != "a" || first["isRepo"] != true {
		t.Fatalf("pinned[0]=%v", first)
	}
	if first["badge"] != nil {
		t.Fatalf("배지가 관측 없이 채워졌다: %v", first["badge"])
	}
}

// 저장소가 아니게 된 핀은 목록에서 지우지 않는다 — 사용자가 지울지 정한다.
func TestGitRepos_PinnedNotRepoKept(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":["/gone"]}}`)
	g.root = func(string) (git.Output, error) {
		return git.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
	}

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	pinned, _ := out["pinned"].([]any)
	if len(pinned) != 1 {
		t.Fatalf("pinned=%v", out["pinned"])
	}
	e, _ := pinned[0].(map[string]any)
	if e["path"] != "/gone" || e["isRepo"] != false || e["reason"] != gitErrNotRepo {
		t.Fatalf("pinned[0]=%v", e)
	}
}

// H5 (V16, FR-GIT-12): 저장소가 아닌 경로의 핀은 404 로 거부하고 목록을 바꾸지
// 않는다.
func TestGitPin_RejectsNonRepo(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	g.root = func(string) (git.Output, error) {
		return git.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
	}
	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":"/tmp/plain"}`)
	if code != http.StatusNotFound {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["error"] != gitErrNotRepo {
		t.Fatalf("error=%v", out["error"])
	}
	if ws.saves != 0 {
		t.Fatalf("거부했는데 workspace 를 %d회 저장했다", ws.saves)
	}
}

func TestGitPin_RejectsRelativePath(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":"rel/path"}`)
	if code != http.StatusBadRequest || out["error"] != gitErrBadRequest {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if ws.saves != 0 {
		t.Fatalf("workspace 를 %d회 저장했다", ws.saves)
	}
}

// H6 (V16, FR-GIT-62): 보낸 하위 경로가 아니라 rev-parse 결과를 저장한다.
func TestGitPin_StoresRevParseRoot(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	g.root = func(string) (git.Output, error) { return git.Output{Stdout: "/work/repo\n"}, nil }

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":"/work/repo/sub/dir"}`)
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["root"] != "/work/repo" {
		t.Fatalf("root=%v", out["root"])
	}
	pinned, _ := out["pinned"].([]any)
	if len(pinned) != 1 || pinned[0] != "/work/repo" {
		t.Fatalf("pinned=%v", out["pinned"])
	}
	if !strings.Contains(string(ws.raw), `"/work/repo"`) {
		t.Fatalf("workspace=%s", ws.raw)
	}
}

// H7 (V16, FR-GIT-11): 핀은 멱등이고 unpin 이 지운다. workspace.json 의 다른 키는
// 지나간다.
func TestGitPin_IdempotentAndPreservesOtherKeys(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"windows":[{"id":"w1"}],"activeWindow":"w1"}`)
	g.root = func(string) (git.Output, error) { return git.Output{Stdout: "/work/repo\n"}, nil }

	for i := 0; i < 2; i++ {
		code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":"/work/repo"}`)
		if code != 200 {
			t.Fatalf("%d번째 pin code=%d body=%v", i, code, out)
		}
		pinned, _ := out["pinned"].([]any)
		if len(pinned) != 1 {
			t.Fatalf("%d번째 pin pinned=%v", i, out["pinned"])
		}
	}

	var doc map[string]any
	if err := json.Unmarshal(ws.raw, &doc); err != nil {
		t.Fatalf("workspace 파싱: %v (%s)", err, ws.raw)
	}
	if doc["schemaVersion"] != float64(2) || doc["activeWindow"] != "w1" {
		t.Fatalf("다른 키가 사라졌다: %v", doc)
	}
	if wins, _ := doc["windows"].([]any); len(wins) != 1 {
		t.Fatalf("windows=%v", doc["windows"])
	}

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/unpin", `{"path":"/work/repo"}`)
	if code != 200 {
		t.Fatalf("unpin code=%d body=%v", code, out)
	}
	if pinned, _ := out["pinned"].([]any); len(pinned) != 0 {
		t.Fatalf("unpin 후 pinned=%v", out["pinned"])
	}
	// unpin 은 rev-parse 를 하지 않는다 — 저장소가 아니게 된 핀도 지울 수 있어야 한다.
	code, out = gitReq(t, s, http.MethodPost, "/api/git/repos/unpin", `{"path":"/never/pinned"}`)
	if code != 200 {
		t.Fatalf("없는 핀 unpin code=%d body=%v", code, out)
	}
}

// H8 (V16·V21, FR-GIT-31): 핀 변경은 다른 브라우저 창에 브로드캐스트된다.
func TestGitPin_BroadcastsWorkspaceChanged(t *testing.T) {
	g := newGitFake(t)
	s, _, _, cb := gitTestServer(t, g)
	g.root = func(string) (git.Output, error) { return git.Output{Stdout: "/work/repo\n"}, nil }

	if code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":"/work/repo"}`); code != 200 {
		t.Fatalf("pin code=%d body=%v", code, out)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/unpin", `{"path":"/work/repo"}`); code != 200 {
		t.Fatalf("unpin code=%d body=%v", code, out)
	}
	cb.mu.Lock()
	defer cb.mu.Unlock()
	if len(cb.published) != 2 {
		t.Fatalf("브로드캐스트 %d건, want 2", len(cb.published))
	}
	for i, p := range cb.published {
		var msg map[string]any
		if err := json.Unmarshal(p, &msg); err != nil {
			t.Fatalf("[%d] 파싱: %v", i, err)
		}
		if msg["action"] != "workspace_changed" {
			t.Fatalf("[%d] action=%v", i, msg["action"])
		}
	}
}

// H9 (V4, FR-GIT-16): /status·/signature 응답의 requested 는 요청값 그대로다.
// 클라이언트가 응답만 보고 자기 요청과 짝을 맞출 수 있어야 한다.
func TestGitStatusSignature_EchoesRequested(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (git.Output, error) { return git.Output{Stdout: "/work/repo\n"}, nil }

	for _, path := range []string{"/api/git/status", "/api/git/signature"} {
		code, out := gitReq(t, s, http.MethodGet, path+"?repo=/work/repo/sub", "")
		if code != 200 {
			t.Fatalf("%s code=%d body=%v", path, code, out)
		}
		if out["requested"] != "/work/repo/sub" {
			t.Fatalf("%s requested=%v", path, out["requested"])
		}
		if out["repo"] != "/work/repo" {
			t.Fatalf("%s repo=%v", path, out["repo"])
		}
		if out["signature"] == nil {
			t.Fatalf("%s signature 가 없다: %v", path, out)
		}
	}
}

// H10 (V29, FR-GIT-62): /status 의 repo 는 rev-parse 로 재확인한 값이다. 클라이언트가
// 보낸 경로를 그대로 신뢰하지 않는다.
func TestGitStatus_ReconfirmsRepo(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (git.Output, error) { return git.Output{Stdout: "/work/repo\n"}, nil }

	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo=/work/repo/deep/sub", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["repo"] != "/work/repo" {
		t.Fatalf("repo=%v", out["repo"])
	}
	if out["cached"] != false {
		t.Fatalf("cached=%v", out["cached"])
	}
	st, _ := out["status"].(map[string]any)
	if st == nil || st["repo"] != "/work/repo" || st["total"] != float64(1) {
		t.Fatalf("status=%v", out["status"])
	}
	// status 는 정규화된 루트에서 실행돼야 한다.
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, a := range g.argvs {
		if a[0] == "status" {
			return
		}
	}
	t.Fatal("status 를 실행하지 않았다")
}

// H11: 오류 매핑. 클라이언트가 종류를 구분할 수 있어야 한다.
func TestGitStatus_ErrorMapping(t *testing.T) {
	cases := []struct {
		name     string
		query    string
		root     func(string) (git.Output, error)
		wantCode int
		wantErr  string
	}{
		{"repo 누락", "", nil, http.StatusBadRequest, gitErrBadRequest},
		{"상대경로", "?repo=rel", nil, http.StatusBadRequest, gitErrBadRequest},
		{"저장소 아님", "?repo=/x", func(string) (git.Output, error) {
			return git.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
		}, http.StatusNotFound, gitErrNotRepo},
		{"git 없음", "?repo=/x", func(string) (git.Output, error) {
			return git.Output{ExitCode: -1}, git.ErrGitMissing
		}, http.StatusServiceUnavailable, gitErrMissing},
		{"마감 초과", "?repo=/x", func(string) (git.Output, error) {
			return git.Output{ExitCode: -1}, git.ErrTimeout
		}, http.StatusGatewayTimeout, gitErrTimeout},
		{"그 밖", "?repo=/x", func(string) (git.Output, error) {
			return git.Output{ExitCode: 1, Stderr: "fatal: boom"}, nil
		}, http.StatusInternalServerError, gitErrFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newGitFake(t)
			g.root = tc.root
			s, _, _, _ := gitTestServer(t, g)
			code, out := gitReq(t, s, http.MethodGet, "/api/git/status"+tc.query, "")
			if code != tc.wantCode {
				t.Fatalf("code=%d want %d body=%v", code, tc.wantCode, out)
			}
			if out["error"] != tc.wantErr {
				t.Fatalf("error=%v want %q", out["error"], tc.wantErr)
			}
			if _, ok := out["message"].(string); !ok {
				t.Fatalf("message 가 없다: %v", out)
			}
		})
	}
	t.Run("stderr tail 보존", func(t *testing.T) {
		g := newGitFake(t)
		g.root = func(string) (git.Output, error) {
			return git.Output{ExitCode: 1, Stderr: "fatal: something specific"}, nil
		}
		s, _, _, _ := gitTestServer(t, g)
		_, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo=/x", "")
		if msg, _ := out["message"].(string); !strings.Contains(msg, "something specific") {
			t.Fatalf("message=%q", msg)
		}
	})
}

// H12 (V13, FR-GIT-63): 동시 N 요청이 status 를 1회만 실행한다. 브라우저 창 수에
// git 실행 횟수가 비례하면 안 된다.
func TestGitStatus_ConcurrentSingleFlight(t *testing.T) {
	g := newGitFake(t)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	g.statusHold = func() {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	}
	s, _, _, _ := gitTestServer(t, g)

	const n = 8
	codes := make([]int, n)
	ready := make(chan struct{}, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ready <- struct{}{}
			codes[i], _ = gitReq(t, s, http.MethodGet, "/api/git/status?repo=/work/repo", "")
		}(i)
	}
	for i := 0; i < n; i++ {
		<-ready
	}
	<-entered
	close(release)
	wg.Wait()

	for i, c := range codes {
		if c != 200 {
			t.Fatalf("요청 %d code=%d", i, c)
		}
	}
	if got := g.count("status"); got != 1 {
		t.Fatalf("status 실행 %d회, want 1", got)
	}
}

// FR-GIT-217 (V94): 브라우저가 언로드하며 취소한 요청은 서버의 실패가 아니다.
// 500 으로 적으면 진짜 장애와 로그에서 구분되지 않는다.
func TestGitErrorCode_CanceledIsClientClosed(t *testing.T) {
	code, name := gitErrorCode(fmt.Errorf("wrapped: %w", git.ErrCanceled))
	if code != statusClientClosed {
		t.Fatalf("code = %d, want %d", code, statusClientClosed)
	}
	if name != gitErrCanceled {
		t.Fatalf("name = %q, want %q", name, gitErrCanceled)
	}
	// 마감 초과는 그대로 504 다 — 둘을 한 코드로 뭉치지 않는다.
	if c, _ := gitErrorCode(git.ErrTimeout); c != http.StatusGatewayTimeout {
		t.Fatalf("timeout code = %d, want 504", c)
	}
	// 그 밖의 실패는 여전히 500 이다.
	if c, _ := gitErrorCode(errors.New("boom")); c != http.StatusInternalServerError {
		t.Fatalf("generic code = %d, want 500", c)
	}
}
