package gitapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// 묶음 D 서버측 — /api/git/{cherry-pick,revert,reset,drop} + /api/git/commit-range
// (GIT_ACTIONS_SRS §3.4 FR-GIT-263~267, 검증 V191·V192·V193·V194).
//
// **서버가 마지막 방어선이다.** 머지 부모 선택과 `--hard` 의 확인을 클라이언트만
// 막으면 API 직접 호출이 그대로 우회한다 (FR-GIT-250.1·250.3).

// gitCoFake 는 묶음 D 가 딛는 읽기·쓰기를 함께 격리한다. 머지 여부 판정이
// `log --format=%P` 를 보므로 **부모를 심을 수 있어야** 한다 — 그것이 이 fake 가
// 따로 있는 이유다.
type gitCoFake struct {
	mu      sync.Mutex
	gitDir  string
	parents string // log --format=%P 의 stdout (공백으로 나뉜 부모 oid)
	count   string // rev-list --count 의 stdout
	writes  [][]string
}

func newGitCoFake(t *testing.T) *gitCoFake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 기본은 부모 하나인 보통 커밋이다 — 머지 여부를 보는 테스트가 그것을 덮는다.
	return &gitCoFake{gitDir: dir, parents: "p1", count: "3\n"}
}

func (f *gitCoFake) read(_ context.Context, dir string, args []string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		return core.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse" && len(args) > 1 && strings.Contains(args[len(args)-1], "..."):
		// git rev-parse A...B → A, B, ^merge-base
		return core.Output{Stdout: "aaa\nbbb\n^base0\n"}, nil
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--verify":
		return core.Output{Stdout: strings.Repeat("c", 40) + "\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case args[0] == "status":
		return core.Output{Stdout: gitWriteStatus("a.txt", "M.")}, nil
	case args[0] == "log":
		return core.Output{Stdout: f.parents + "\n"}, nil
	case args[0] == "rev-list":
		return core.Output{Stdout: f.count}, nil
	}
	return core.Output{}, nil
}

func (f *gitCoFake) write(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, append([]string(nil), args...))
	return core.Output{}, nil
}

func (f *gitCoFake) wrote() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.writes...)
}

func gitCoServer(t *testing.T, f *gitCoFake) *GitServer {
	t.Helper()
	st := store.NewStore(core.New(core.WithRunner(f.read), core.WithWriteRunner(f.write)))
	return &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: st}
}

// gitCoEndpoints 는 묶음 D 가 더한 라우트 전부다.
var gitCoEndpoints = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodPost, "/api/git/cherry-pick", `{"repo":"/work/repo","oid":"abc123"}`},
	{http.MethodPost, "/api/git/revert", `{"repo":"/work/repo","oid":"abc123"}`},
	{http.MethodPost, "/api/git/reset", `{"repo":"/work/repo","oid":"abc123"}`},
	{http.MethodPost, "/api/git/drop", `{"repo":"/work/repo","oid":"abc123","confirm":true}`},
	{http.MethodGet, "/api/git/commit-range?repo=/work/repo&from=abc123&to=HEAD", ""},
}

// D-API1: 5개 라우트가 gitapi.routes 에 등록돼 있고, Git 이 없으면 전부 503 이다.
func TestGitCommitOpsRoutes_RegisteredAndUnavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitCoEndpoints {
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
			continue
		}
		code, out := gitReq(t, s, ep.method, ep.path, ep.body)
		if code != http.StatusServiceUnavailable || out["error"] != gitErrUnavailable {
			t.Errorf("%s %s → %d %v, want 503 git_unavailable", ep.method, ep.path, code, out["error"])
		}
	}
}

// D-API2 (V191, FR-GIT-263·264): 머지 커밋의 cherry-pick·revert 는 부모 번호 없이
// **실행되지 않는다.** 묻지 않고 고르면 틀린 부모를 집는다.
func TestAPIGitPick_MergeRequiresMainline(t *testing.T) {
	for _, path := range []string{"/api/git/cherry-pick", "/api/git/revert"} {
		f := newGitCoFake(t)
		f.parents = "p1 p2" // 머지 커밋이다
		s := gitCoServer(t, f)

		code, out := gitReq(t, s, http.MethodPost, path, `{"repo":"/work/repo","oid":"abc123"}`)
		if code != http.StatusBadRequest || out["error"] != gitErrMergeParent {
			t.Fatalf("%s → %d %v, want 400 %s", path, code, out["error"], gitErrMergeParent)
		}
		if w := f.wrote(); len(w) != 0 {
			t.Fatalf("%s: 부모 없이 실행됐다: %v", path, w)
		}
		// 400 은 **부모를 고를 수 있게** 부모 목록을 함께 준다 — 없으면 화면이
		// 무엇을 물어야 하는지 알 수 없다.
		ps, _ := out["parents"].([]any)
		if len(ps) != 2 {
			t.Fatalf("%s: 부모 목록이 응답에 없다: %v", path, out["parents"])
		}
	}
}

// D-API3 (V191): 부모 번호를 주면 그대로 argv 에 실려 실행된다.
func TestAPIGitPick_MainlineReachesArgv(t *testing.T) {
	f := newGitCoFake(t)
	f.parents = "p1 p2"
	s := gitCoServer(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/cherry-pick",
		`{"repo":"/work/repo","oid":"abc123","mainline":2}`)
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out["error"])
	}
	w := f.wrote()
	if len(w) != 1 || strings.Join(w[0], " ") != "cherry-pick -m 2 abc123" {
		t.Fatalf("argv = %v, want [cherry-pick -m 2 abc123]", w)
	}
}

// D-API4 (FR-GIT-264): `--no-commit` 은 revert 의 옵션이고 cherry-pick 에는 없다.
func TestAPIGitRevert_NoCommitOption(t *testing.T) {
	f := newGitCoFake(t)
	s := gitCoServer(t, f)
	code, _ := gitReq(t, s, http.MethodPost, "/api/git/revert",
		`{"repo":"/work/repo","oid":"abc123","noCommit":true}`)
	if code != http.StatusOK {
		t.Fatalf("→ %d", code)
	}
	w := f.wrote()
	if len(w) != 1 || strings.Join(w[0], " ") != "revert --no-commit abc123" {
		t.Fatalf("argv = %v, want [revert --no-commit abc123]", w)
	}

	f2 := newGitCoFake(t)
	s2 := gitCoServer(t, f2)
	code, _ = gitReq(t, s2, http.MethodPost, "/api/git/cherry-pick",
		`{"repo":"/work/repo","oid":"abc123","noCommit":true}`)
	if code != http.StatusBadRequest {
		t.Fatalf("cherry-pick 의 --no-commit → %d, want 400", code)
	}
	if w := f2.wrote(); len(w) != 0 {
		t.Fatalf("거부해야 하는데 실행됐다: %v", w)
	}
}

// D-API5 (V192, FR-GIT-89·265): `--hard` 는 `confirm:true` 없이 400 이고 **실행되지
// 않는다.** soft·mixed 는 잃는 것이 없으므로 확인을 요구하지 않는다.
func TestAPIGitReset_HardRequiresConfirm(t *testing.T) {
	f := newGitCoFake(t)
	s := gitCoServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/reset",
		`{"repo":"/work/repo","oid":"abc123","mode":"hard"}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("→ %d %v, want 400 %s", code, out["error"], gitErrConfirmRequired)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("확인 없이 실행됐다: %v", w)
	}

	for _, mode := range []string{"", "mixed", "soft"} {
		f2 := newGitCoFake(t)
		s2 := gitCoServer(t, f2)
		code, out := gitReq(t, s2, http.MethodPost, "/api/git/reset",
			`{"repo":"/work/repo","oid":"abc123","mode":"`+mode+`"}`)
		if code != http.StatusOK {
			t.Fatalf("mode=%q → %d %v, want 200", mode, code, out["error"])
		}
		if w := f2.wrote(); len(w) != 1 {
			t.Fatalf("mode=%q: 실행되지 않았다: %v", mode, w)
		}
	}
}

// D-API6 (V192): 확인을 거친 `--hard` 는 argv 에 그대로 실린다.
func TestAPIGitReset_HardArgv(t *testing.T) {
	f := newGitCoFake(t)
	s := gitCoServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/reset",
		`{"repo":"/work/repo","oid":"abc123","mode":"hard","confirm":true}`)
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out["error"])
	}
	w := f.wrote()
	if len(w) != 1 || strings.Join(w[0], " ") != "reset --hard abc123" {
		t.Fatalf("argv = %v, want [reset --hard abc123]", w)
	}
}

// D-API7 (FR-GIT-265): 모르는 모드는 실행 **전에** 400 이다. gitApply 를 지나면
// 500 이 되어 클라이언트가 자기 요청이 틀렸음을 알 수 없다.
func TestAPIGitReset_UnknownModeRejected(t *testing.T) {
	f := newGitCoFake(t)
	s := gitCoServer(t, f)
	code, _ := gitReq(t, s, http.MethodPost, "/api/git/reset",
		`{"repo":"/work/repo","oid":"abc123","mode":"keep","confirm":true}`)
	if code != http.StatusBadRequest {
		t.Fatalf("→ %d, want 400", code)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("거부해야 하는데 실행됐다: %v", w)
	}
}

// D-API8 (V193, FR-GIT-266): drop 은 파괴적이므로 `confirm:true` 없이 실행되지
// 않고, argv 는 `rebase --onto <oid>^ <oid>` 다.
func TestAPIGitDrop_ConfirmAndArgv(t *testing.T) {
	f := newGitCoFake(t)
	s := gitCoServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/drop",
		`{"repo":"/work/repo","oid":"abc123"}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("→ %d %v, want 400 %s", code, out["error"], gitErrConfirmRequired)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("확인 없이 실행됐다: %v", w)
	}

	f2 := newGitCoFake(t)
	s2 := gitCoServer(t, f2)
	code, out = gitReq(t, s2, http.MethodPost, "/api/git/drop",
		`{"repo":"/work/repo","oid":"abc123","confirm":true}`)
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out["error"])
	}
	w := f2.wrote()
	if len(w) != 1 || strings.Join(w[0], " ") != "rebase --onto abc123^ abc123" {
		t.Fatalf("argv = %v, want [rebase --onto abc123^ abc123]", w)
	}
}

// D-API9 (FR-GIT-266): 머지 커밋은 `<oid>^` 로 뺄 수 없다 — 첫 부모만 남고 나머지
// 갈래가 조용히 사라진다. 실행 전에 거부한다.
func TestAPIGitDrop_MergeRefused(t *testing.T) {
	f := newGitCoFake(t)
	f.parents = "p1 p2"
	s := gitCoServer(t, f)
	code, _ := gitReq(t, s, http.MethodPost, "/api/git/drop",
		`{"repo":"/work/repo","oid":"abc123","confirm":true}`)
	if code != http.StatusBadRequest {
		t.Fatalf("→ %d, want 400", code)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("거부해야 하는데 실행됐다: %v", w)
	}
}

// D-API10 (V192, FR-GIT-265): 다이얼로그가 보일 **영향 커밋 수**를 준다.
func TestAPIGitCommitRange_Count(t *testing.T) {
	f := newGitCoFake(t)
	f.count = "7\n"
	s := gitCoServer(t, f)
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/commit-range?repo=/work/repo&from=abc123&to=HEAD", "")
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out["error"])
	}
	if n, _ := out["count"].(float64); n != 7 {
		t.Fatalf("count = %v, want 7", out["count"])
	}
}

// D-API11 (V194, FR-GIT-267): `A...B` 는 **merge-base** 를 왼쪽으로 잡는다. 그것을
// `A..B` 와 같게 다루면 사용자가 고른 것과 다른 비교를 보게 된다.
func TestAPIGitCommitRange_SymmetricUsesMergeBase(t *testing.T) {
	f := newGitCoFake(t)
	s := gitCoServer(t, f)
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/commit-range?repo=/work/repo&from=aaa&to=bbb&symmetric=1", "")
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out["error"])
	}
	if out["from"] != "base0" {
		t.Fatalf("from = %v, want base0 (merge-base)", out["from"])
	}
}

// D-API12 (FR-GIT-250.3): 옵션처럼 생긴 리비전은 실행 전에 거부된다.
func TestAPIGitCommitRange_RejectsUnsafeRev(t *testing.T) {
	f := newGitCoFake(t)
	s := gitCoServer(t, f)
	code, _ := gitReq(t, s, http.MethodGet,
		"/api/git/commit-range?repo=/work/repo&from=--all&to=HEAD", "")
	if code != http.StatusBadRequest {
		t.Fatalf("→ %d, want 400", code)
	}
}
