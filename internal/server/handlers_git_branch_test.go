package server

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"dongminal/internal/git"
)

// 묶음 N 서버측 — /api/git/{checkout,branch} + /api/git/branch/validate
// (GIT_SRS §3D.1, 검증 V53·V54·V55).
//
// **서버가 마지막 방어선이다.** force 의 확인과 이름 충돌을 클라이언트만 막으면
// API 직접 호출이 그대로 우회한다.

// gitM5Repo 는 요청에 실을 리포 경로다. fake 의 rev-parse 가 요청 dir 을 그대로
// 루트로 답하므로 존재하지 않아도 된다.
const gitM5Repo = "/work/repo"

// gitM5Fake 은 M5 표면이 딛는 읽기·쓰기를 함께 격리한다. WithRunner 만 주면 실제
// git 이 돌아 테스트가 저장소를 바꾼다.
//
// stash 의 읽기 하위 동작(`list`·`show`)은 쓰기 실행기로 온다 — `stash` 가 쓰기
// 허용 목록에 있기 때문이며(FR-GIT-95), 그래서 여기서 함께 답한다.
type gitM5Fake struct {
	mu       sync.Mutex
	gitDir   string
	status   string
	branches map[string]bool // 로컬 브랜치 존재 여부
	stashes  string          // stash list 의 stdout
	show     string          // stash show 의 stdout
	writes   [][]string
	writeErr func(argv []string) (git.Output, error)
	// onWrite 는 쓰기 성공 직후에 불린다. 쓰기가 상태를 바꾸는 것을 흉내 낸다.
	onWrite func(f *gitM5Fake, argv []string)
}

func newGitM5Fake(t *testing.T) *gitM5Fake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &gitM5Fake{
		gitDir:   dir,
		status:   gitWriteStatus("a.txt", "M."),
		branches: map[string]bool{"main": true},
	}
}

func (f *gitM5Fake) read(_ context.Context, dir string, args []string) (git.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && args[1] == "--show-toplevel":
		return git.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse" && args[1] == "--verify":
		name := strings.TrimPrefix(args[2], "refs/heads/")
		if f.branches[name] {
			return git.Output{Stdout: strings.Repeat("a", 40) + "\n"}, nil
		}
		return git.Output{ExitCode: 128, Stderr: "fatal: Needed a single revision\n"}, nil
	case args[0] == "rev-parse":
		return git.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case args[0] == "status":
		return git.Output{Stdout: f.status}, nil
	case args[0] == "check-ref-format":
		return fakeCheckRefFormat(args[2]), nil
	}
	return git.Output{}, nil
}

// fakeCheckRefFormat 은 git 의 판정을 흉내 낸다. 규칙 전체가 아니라 **응답의 형태**가
// 검사 대상이다 — 실제 규칙은 internal/git 의 단위 테스트가 진짜 git 으로 본다.
func fakeCheckRefFormat(name string) git.Output {
	if strings.ContainsAny(name, " ~^:?*[\\") || strings.Contains(name, "..") || strings.HasSuffix(name, ".lock") {
		return git.Output{ExitCode: 128, Stderr: "fatal: '" + name + "' is not a valid branch name\n"}
	}
	return git.Output{Stdout: name + "\n"}
}

func (f *gitM5Fake) write(_ context.Context, _ string, args []string, _ string) (git.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if args[0] == "stash" && len(args) > 1 {
		switch args[1] {
		case "list":
			return git.Output{Stdout: f.stashes}, nil
		case "show":
			return git.Output{Stdout: f.show}, nil
		}
	}
	f.writes = append(f.writes, append([]string(nil), args...))
	if f.writeErr != nil {
		return f.writeErr(args)
	}
	if f.onWrite != nil {
		f.onWrite(f, args)
	}
	return git.Output{}, nil
}

func (f *gitM5Fake) wrote() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.writes...)
}

// gitM5Server 는 읽기·쓰기 둘 다 격리된 Server 를 세운다.
func gitM5Server(t *testing.T, f *gitM5Fake) *Server {
	t.Helper()
	store := git.NewStore(git.New(git.WithRunner(f.read), git.WithWriteRunner(f.write)))
	return &Server{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: store}
}

// gitM5Endpoints 는 18·19단계가 더한 라우트 전부다.
var gitM5Endpoints = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodPost, "/api/git/checkout", `{"repo":"/work/repo","ref":"main"}`},
	{http.MethodPost, "/api/git/branch", `{"repo":"/work/repo","name":"feat"}`},
	{http.MethodGet, "/api/git/branch/validate?repo=/work/repo&name=feat", ""},
	{http.MethodGet, "/api/git/stash?repo=/work/repo", ""},
	{http.MethodGet, "/api/git/stash/show?repo=/work/repo&index=0", ""},
	{http.MethodPost, "/api/git/stash/push", `{"repo":"/work/repo"}`},
	{http.MethodPost, "/api/git/stash/apply", `{"repo":"/work/repo","index":0}`},
	{http.MethodPost, "/api/git/stash/pop", `{"repo":"/work/repo","index":0}`},
	{http.MethodPost, "/api/git/stash/drop", `{"repo":"/work/repo","index":0,"confirm":true}`},
}

// M1: 9개 라우트가 apiRoutes 에 등록돼 있고, Git 이 없으면 전부 503 이다.
func TestGitM5Routes_RegisteredAndUnavailable(t *testing.T) {
	s := &Server{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitM5Endpoints {
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
			continue
		}
		code, out := gitReq(t, s, ep.method, ep.path, ep.body)
		if code != http.StatusServiceUnavailable || out["error"] != gitErrUnavailable {
			t.Errorf("%s %s → %d %v, want 503 git_unavailable", ep.method, ep.path, code, out["error"])
		}
	}
}

// M2 (V55, FR-GIT-97·157, O14): `force:true` 는 `confirm:true` 없이 400 이고
// **실행되지 않는다.** 강제 checkout 은 워킹 트리의 변경을 버린다.
func TestAPIGitCheckout_ForceRequiresConfirm(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/checkout",
		`{"repo":"/work/repo","ref":"main","force":true}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("code = %d, error = %v, want 400 confirmation_required", code, out["error"])
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("거부됐는데 실행됐다: %v", got)
	}
}

// M3 (V55, FR-GIT-157): confirm 이 있으면 `--force` 가 붙는다. 붙지 않으면 확인의
// 뜻이 없다.
func TestAPIGitCheckout_ForceWithConfirm(t *testing.T) {
	f := newGitM5Fake(t)
	f.onWrite = func(f *gitM5Fake, _ []string) { f.status = gitWriteStatus("b.txt", ".M") }
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/checkout",
		`{"repo":"/work/repo","ref":"main","force":true,"confirm":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	want := []string{"checkout", "--force", "main"}
	if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	// 조작 후 상태가 응답에 있어야 한다 (FR-GIT-160).
	st, _ := out["status"].(map[string]any)
	if changes, _ := st["changes"].([]any); len(changes) != 1 {
		t.Fatalf("실행 후 status 가 아니다: %v", st)
	}
}

// M4 (V54, FR-GIT-156): 원격 브랜치 checkout 이 같은 이름의 로컬과 부딪히면
// **실행하지 않고** 409 + 선택지를 준다. 클라이언트만 막으면 API 직접 호출이 우회한다.
func TestAPIGitCheckout_RemoteBranchNameConflict(t *testing.T) {
	f := newGitM5Fake(t)
	f.branches["feat"] = true
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/checkout",
		`{"repo":"/work/repo","create":"feat","track":"origin/feat"}`)
	if code != http.StatusConflict || out["error"] != gitErrBranchExists {
		t.Fatalf("code = %d, error = %v, want 409 branch_exists", code, out["error"])
	}
	if out["branch"] != "feat" || out["track"] != "origin/feat" {
		t.Fatalf("branch/track = %v / %v", out["branch"], out["track"])
	}
	opts, _ := out["options"].([]any)
	if len(opts) != len(git.BranchConflictOptions) {
		t.Fatalf("options = %v, want %v", opts, git.BranchConflictOptions)
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("거부됐는데 실행됐다: %v", got)
	}
}

// M5 (V54, FR-GIT-156): 부딪히지 않으면 로컬을 만들며 추적을 설정한다.
func TestAPIGitCheckout_RemoteBranchTracks(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/checkout",
		`{"repo":"/work/repo","create":"feat","track":"origin/feat"}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	want := []string{"checkout", "-b", "feat", "--track", "origin/feat"}
	if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
}

// M6 (FR-GIT-159): 이름 규칙 위반과 잘못된 조합은 400 이며 **실행되지 않는다.**
// 500 으로 뭉개면 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
func TestAPIGitBranchRoutes_RejectBadRequests(t *testing.T) {
	cases := []struct {
		name string
		path string
		body string
		want string
	}{
		{"이름 규칙 위반 (생성)", "/api/git/branch", `{"repo":"/work/repo","name":"bad name"}`, gitErrRefName},
		{"이름 규칙 위반 (checkout)", "/api/git/checkout", `{"repo":"/work/repo","create":"a..b"}`, gitErrRefName},
		{"- 로 시작하는 ref", "/api/git/checkout", `{"repo":"/work/repo","ref":"-x"}`, gitErrRefName},
		{"대상 없음", "/api/git/checkout", `{"repo":"/work/repo"}`, gitErrBadRequest},
		{"track 만", "/api/git/checkout", `{"repo":"/work/repo","track":"origin/feat"}`, gitErrBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitM5Fake(t)
			s := gitM5Server(t, f)
			code, out := gitReq(t, s, http.MethodPost, c.path, c.body)
			if code != http.StatusBadRequest || out["error"] != c.want {
				t.Fatalf("code = %d, error = %v, want 400 %s", code, out["error"], c.want)
			}
			if got := f.wrote(); len(got) != 0 {
				t.Fatalf("거부됐는데 실행됐다: %v", got)
			}
		})
	}
}

// M7 (V68, FR-GIT-158·160): 생성은 checkout 여부로 명령이 갈리고, 응답에 조작 후
// 상태가 함께 온다.
func TestAPIGitBranchCreate(t *testing.T) {
	cases := []struct {
		body string
		want []string
	}{
		{`{"repo":"/work/repo","name":"feat"}`, []string{"branch", "feat"}},
		{`{"repo":"/work/repo","name":"feat","checkout":true}`, []string{"checkout", "-b", "feat"}},
		{`{"repo":"/work/repo","name":"feat","startRef":"abc123"}`, []string{"branch", "feat", "abc123"}},
	}
	for _, c := range cases {
		t.Run(fmt.Sprint(c.want), func(t *testing.T) {
			f := newGitM5Fake(t)
			f.onWrite = func(f *gitM5Fake, _ []string) { f.status = gitWriteStatus("b.txt", ".M") }
			s := gitM5Server(t, f)

			code, out := gitReq(t, s, http.MethodPost, "/api/git/branch", c.body)
			if code != http.StatusOK {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got, c.want)
			}
			st, _ := out["status"].(map[string]any)
			if changes, _ := st["changes"].([]any); len(changes) != 1 {
				t.Fatalf("실행 후 status 가 아니다: %v", st)
			}
		})
	}
}

// M8 (V68, FR-GIT-159): 이름 검사는 200 으로 판정만 돌려준다 — 입력 중 부르는
// 엔드포인트이므로 위반을 요청 실패로 답하면 클라이언트가 오류를 구분할 수 없다.
func TestAPIGitBranchValidate(t *testing.T) {
	f := newGitM5Fake(t)
	f.branches["taken"] = true
	s := gitM5Server(t, f)

	cases := []struct {
		name string
		ok   bool
	}{
		{"feat/a", true},
		{"bad name", false},
		{"x..y", false},
		{"-lead", false},
		{"", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, out := gitReq(t, s, http.MethodGet,
				"/api/git/branch/validate?repo=/work/repo&name="+strings.ReplaceAll(c.name, " ", "%20"), "")
			if code != http.StatusOK {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			if out["ok"] != c.ok {
				t.Fatalf("ok = %v, want %v (body=%v)", out["ok"], c.ok, out)
			}
			if !c.ok && out["reason"] == "" {
				t.Fatal("사유가 비었다 — 사용자가 무엇을 고쳐야 하는지 알 수 없다")
			}
		})
	}

	// 이름이 이미 있는 것은 규칙 위반이 아니다. 그 사실은 따로 알린다 —
	// 클라이언트가 생성을 막을지 다른 이름을 권할지 갈라야 한다 (FR-GIT-156).
	code, out := gitReq(t, s, http.MethodGet, "/api/git/branch/validate?repo=/work/repo&name=taken", "")
	if code != http.StatusOK || out["ok"] != true || out["exists"] != true {
		t.Fatalf("code = %d, body = %v", code, out)
	}
}
