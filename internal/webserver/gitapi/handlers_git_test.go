package gitapi

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

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
	"net/url"

	"dongminal/internal/shared/testpath"
)

// 묶음 B·C 서버측 — /api/git/* (GIT_SRS §3.8 FR-GIT-60~63, 검증 V3·V4·V13·V16·V28·V29).

var gitStatusFixture = strings.Join([]string{
	"# branch.oid 1111111111111111111111111111111111111111",
	"# branch.head main",
	"? a.txt",
}, "\x00") + "\x00"

// gitFake 은 server 계층용 core.Runner 다. **호출 argv 를 전부 기록한다** —
// "무엇을 실행하지 않았는가"를 검사해야 하기 때문이다 (FR-GIT-24).
type gitFake struct {
	mu     sync.Mutex
	argvs  [][]string
	gitDir string
	// root 가 nil 이면 요청 dir 를 그대로 루트로 답한다.
	root func(dir string) (core.Output, error)
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

func (g *gitFake) runner(_ context.Context, dir string, args []string) (core.Output, error) {
	g.mu.Lock()
	g.argvs = append(g.argvs, append([]string(nil), args...))
	g.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		if g.root != nil {
			return g.root(dir)
		}
		return core.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: g.gitDir + "\n" + g.gitDir + "\n"}, nil
	case args[0] == "status":
		if g.statusHold != nil {
			g.statusHold()
		}
		return core.Output{Stdout: gitStatusFixture}, nil
	}
	return core.Output{}, nil
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

// gitTestServer 는 주입 Runner 를 쓰는 Store 로 GitServer 를 세운다. 시계를 고정해
// TTL 이 테스트 도중 만료되지 않게 한다.
func gitTestServer(t *testing.T, g *gitFake, opts ...store.StoreOption) (*GitServer, *fakePaneHub, *fakeWorkspaceStore, *fakeCommandBroker) {
	t.Helper()
	at := time.Now()
	all := append([]store.StoreOption{store.WithClock(func() time.Time { return at })}, opts...)
	store := store.NewStore(core.New(core.WithRunner(g.runner)), all...)
	hub := newFakePaneHub()
	ws := newFakeWorkspaceStore()
	cb := &fakeCommandBroker{}
	return &GitServer{Tools: hub, Work: ws, Commands: cb, Git: store}, hub, ws, cb
}

func gitReq(t *testing.T, s *GitServer, method, path, body string) (int, map[string]any) {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, r)
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
	{http.MethodPost, "/api/git/repos/pin", `{"path":` + qR + `}`},
	{http.MethodPost, "/api/git/repos/unpin", `{"path":` + qR + `}`},
	{http.MethodGet, "/api/git/status?repo=" + url.QueryEscape(absR), ""},
	{http.MethodGet, "/api/git/signature?repo=" + url.QueryEscape(absR), ""},
}

// H1 (V28, FR-GIT-61): 5개 라우트가 gitapi.routes 에 등록돼 있다. UI 는 이 표면 위에만
// 선다 (FR-GIT-60).
func TestGitRoutesRegistered(t *testing.T) {
	for _, ep := range gitEndpoints {
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

// H2: s.Git == nil 이면 전부 503 git_unavailable 이고 다른 동작에는 영향이 없다.
func TestGitEndpoints_Unavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
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

// V-FLW-2 (FR-FLW-2): 목록은 **핀만** 답한다. follow 키가 남아 있으면 아무도 읽지
// 않는 값을 위해 3초마다 rev-parse 가 한 번 더 돈다.
func TestGitRepos_NoFollow(t *testing.T) {
	g := newGitFake(t)
	s, hub, _, _ := gitTestServer(t, g)
	hub.seed("t1", "T1")
	hub.setCwd("t1", absWorkRepoSub)
	roots := 0
	g.root = func(string) (core.Output, error) {
		roots++
		return core.Output{Stdout: absWorkRepo + "\n"}, nil
	}

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?tool=t1", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if _, ok := out["follow"]; ok {
		t.Fatalf("follow 가 아직 응답에 있다: %v", out)
	}
	// 핀이 없으므로 rev-parse 는 한 번도 돌지 않아야 한다 — `?tool=` 을 실어도
	// 그것을 딛는 조회가 남아 있으면 안 된다.
	if roots != 0 {
		t.Fatalf("rev-parse 가 %d 번 돌았다 — 핀이 없는데 무엇을 확정했나", roots)
	}
}

// V-FLW-2 (FR-FLW-6): `+ Add` 가 여는 순간에만 도는 전용 조회. 저장소면 루트를,
// 아니면 path 를 비우고 사유만 답한다 — 마지막 유효 리포를 유지하지 않는다.
func TestGitRepoAt(t *testing.T) {
	t.Run("저장소", func(t *testing.T) {
		g := newGitFake(t)
		s, hub, _, _ := gitTestServer(t, g)
		hub.seed("t1", "T1")
		hub.setCwd("t1", absWorkRepoSub)
		g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

		code, out := gitReq(t, s, http.MethodGet, "/api/git/repo-at?tool=t1", "")
		if code != 200 {
			t.Fatalf("code=%d body=%v", code, out)
		}
		if out["cwd"] != absWorkRepoSub {
			t.Fatalf("cwd=%v", out["cwd"])
		}
		if out["isRepo"] != true || out["path"] != absWorkRepo || out["name"] != "repo" {
			t.Fatalf("out=%v", out)
		}
		if out["reason"] != "" {
			t.Fatalf("reason=%v", out["reason"])
		}
	})

	t.Run("저장소 아님", func(t *testing.T) {
		g := newGitFake(t)
		s, hub, _, _ := gitTestServer(t, g)
		hub.seed("t1", "T1")
		hub.setCwd("t1", absTmpPlain)
		g.root = func(string) (core.Output, error) {
			return core.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
		}

		code, out := gitReq(t, s, http.MethodGet, "/api/git/repo-at?tool=t1", "")
		if code != 200 {
			t.Fatalf("code=%d body=%v", code, out)
		}
		if out["isRepo"] != false || out["path"] != "" {
			t.Fatalf("out=%v", out)
		}
		if out["reason"] != gitErrNotRepo {
			t.Fatalf("reason=%v, want %q", out["reason"], gitErrNotRepo)
		}
	})

	t.Run("라우트 등록", func(t *testing.T) {
		found := false
		for _, rt := range routes {
			if (rt.method == "" || rt.method == http.MethodGet) && rt.match("/api/git/repo-at") {
				found = true
			}
		}
		if !found {
			t.Fatal("GET /api/git/repo-at 이 gitapi.routes 에 없다")
		}
	})
}

// 배지는 Store.Observed 만 읽는다. status 를 한 번 관측한 뒤에야 값이 생긴다
// (FR-GIT-14 — follow 가 사라져도 핀 행의 배지는 그대로다).
func TestGitRepos_BadgeFromObservation(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qWorkRepo + `]}}`)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	if code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(absWorkRepo), ""); code != 200 {
		t.Fatalf("status code=%d body=%v", code, out)
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
	badge, _ := e["badge"].(map[string]any)
	if badge == nil {
		t.Fatalf("badge 가 없다: %v", e)
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
	hub.setCwd("t1", absWorkRepo)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qA + `,` + qB + `,` + qC + `]}}`)

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
	if first["path"] != absA || first["name"] != "a" || first["isRepo"] != true {
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
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qGone + `]}}`)
	g.root = func(string) (core.Output, error) {
		return core.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
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
	if e["path"] != absGone || e["isRepo"] != false || e["reason"] != gitErrNotRepo {
		t.Fatalf("pinned[0]=%v", e)
	}
}

// H5 (V16, FR-GIT-12): 저장소가 아닌 경로의 핀은 404 로 거부하고 목록을 바꾸지
// 않는다.
func TestGitPin_RejectsNonRepo(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) {
		return core.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
	}
	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":`+qTmpPlain+`}`)
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
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":`+testpath.JSONQuote(filepath.Join(absWorkRepoSub, "dir"))+`}`)
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["root"] != absWorkRepo {
		t.Fatalf("root=%v", out["root"])
	}
	pinned, _ := out["pinned"].([]any)
	if len(pinned) != 1 || pinned[0] != absWorkRepo {
		t.Fatalf("pinned=%v", out["pinned"])
	}
	if !strings.Contains(string(ws.raw), qWorkRepo) {
		t.Fatalf("workspace=%s", ws.raw)
	}
}

// H7 (V16, FR-GIT-11): 핀은 멱등이고 unpin 이 지운다. workspace.json 의 다른 키는
// 지나간다.
func TestGitPin_IdempotentAndPreservesOtherKeys(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"windows":[{"id":"w1"}],"activeWindow":"w1"}`)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	for i := 0; i < 2; i++ {
		code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":`+qWorkRepo+`}`)
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

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/unpin", `{"path":`+qWorkRepo+`}`)
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
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	if code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":`+qWorkRepo+`}`); code != 200 {
		t.Fatalf("pin code=%d body=%v", code, out)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/unpin", `{"path":`+qWorkRepo+`}`); code != 200 {
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
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	for _, path := range []string{"/api/git/status", "/api/git/signature"} {
		code, out := gitReq(t, s, http.MethodGet, path+"?repo="+url.QueryEscape(absWorkRepoSub), "")
		if code != 200 {
			t.Fatalf("%s code=%d body=%v", path, code, out)
		}
		if out["requested"] != absWorkRepoSub {
			t.Fatalf("%s requested=%v", path, out["requested"])
		}
		if out["repo"] != absWorkRepo {
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
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(absWorkRepo+"/deep/sub"), "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["repo"] != absWorkRepo {
		t.Fatalf("repo=%v", out["repo"])
	}
	if out["cached"] != false {
		t.Fatalf("cached=%v", out["cached"])
	}
	st, _ := out["status"].(map[string]any)
	if st == nil || st["repo"] != absWorkRepo || st["total"] != float64(1) {
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
		root     func(string) (core.Output, error)
		wantCode int
		wantErr  string
	}{
		{"repo 누락", "", nil, http.StatusBadRequest, gitErrBadRequest},
		{"상대경로", "?repo=rel", nil, http.StatusBadRequest, gitErrBadRequest},
		{"저장소 아님", "?repo=" + url.QueryEscape(absX), func(string) (core.Output, error) {
			return core.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
		}, http.StatusNotFound, gitErrNotRepo},
		{"git 없음", "?repo=" + url.QueryEscape(absX), func(string) (core.Output, error) {
			return core.Output{ExitCode: -1}, core.ErrGitMissing
		}, http.StatusServiceUnavailable, gitErrMissing},
		{"마감 초과", "?repo=" + url.QueryEscape(absX), func(string) (core.Output, error) {
			return core.Output{ExitCode: -1}, core.ErrTimeout
		}, http.StatusGatewayTimeout, gitErrTimeout},
		{"그 밖", "?repo=" + url.QueryEscape(absX), func(string) (core.Output, error) {
			return core.Output{ExitCode: 1, Stderr: "fatal: boom"}, nil
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
		g.root = func(string) (core.Output, error) {
			return core.Output{ExitCode: 1, Stderr: "fatal: something specific"}, nil
		}
		s, _, _, _ := gitTestServer(t, g)
		_, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(absX), "")
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
			codes[i], _ = gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(absWorkRepo), "")
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
	code, name := gitErrorCode(fmt.Errorf("wrapped: %w", core.ErrCanceled))
	if code != apierr.StatusClientClosed {
		t.Fatalf("code = %d, want %d", code, apierr.StatusClientClosed)
	}
	if name != gitErrCanceled {
		t.Fatalf("name = %q, want %q", name, gitErrCanceled)
	}
	// 마감 초과는 그대로 504 다 — 둘을 한 코드로 뭉치지 않는다.
	if c, _ := gitErrorCode(core.ErrTimeout); c != http.StatusGatewayTimeout {
		t.Fatalf("timeout code = %d, want 504", c)
	}
	// 그 밖의 실패는 여전히 500 이다.
	if c, _ := gitErrorCode(errors.New("boom")); c != http.StatusInternalServerError {
		t.Fatalf("generic code = %d, want 500", c)
	}
}

// FR-RMS-4 (V-RMS-1·2·3): 소실은 자기 코드로 나간다. `not_a_git_repo` 와 같은 404 인
// 이유는 둘 다 "네가 지목한 것이 거기 없다" 이기 때문이고, 클라이언트는 상태 코드가
// 아니라 `error` 필드로 분기한다.
func TestGitErrorCode_RepoMissing(t *testing.T) {
	code, name := gitErrorCode(fmt.Errorf("wrapped: %w", core.ErrRepoMissing))
	if code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", code)
	}
	if name != gitErrRepoMissing {
		t.Fatalf("name = %q, want %q", name, gitErrRepoMissing)
	}
	// 저장소 아님과 뭉개지지 않는다 — 사유가 갈려 있어야 오탐을 오탐으로 읽는다.
	if _, n := gitErrorCode(core.ErrNotRepo); n != gitErrNotRepo {
		t.Fatalf("not_a_git_repo name = %q", n)
	}
	// 분류되지 않은 실패는 여전히 500/git_failed 다 (FR-RMS-5).
	if c, n := gitErrorCode(errors.New("boom")); c != http.StatusInternalServerError || n != gitErrFailed {
		t.Fatalf("generic = (%d, %q), want (500, %q)", c, n, gitErrFailed)
	}
}
