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
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/git/write"
	"net/url"
)

// 묶음 N 서버측 — /api/git/{checkout,branch} + /api/git/branch/validate
// (GIT_SRS §3D.1, 검증 V53·V54·V55).
//
// **서버가 마지막 방어선이다.** force 의 확인과 이름 충돌을 클라이언트만 막으면
// API 직접 호출이 그대로 우회한다.

// gitM5Repo 는 요청에 실을 리포 경로다. fake 의 rev-parse 가 요청 dir 을 그대로
// 루트로 답하므로 존재하지 않아도 된다.
var gitM5Repo = absWorkRepo

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
	// 묶음 B 가 딛는 읽기 (GIT_ACTIONS_SRS §3.2). 기본값은 "가장 흔한 상태"다 —
	// upstream 없음 · 합쳐짐 · 원격 ref 없음.
	remoteRefs map[string]bool   // refs/remotes/<short> 의 존재
	upstreams  map[string]string // 브랜치별 upstream ("" 면 없다)
	unmerged   map[string]bool   // merge-base --is-ancestor 가 아니오로 답할 브랜치
	config     string            // config --list (원격 목록의 출처)
	revCounts  map[string]int    // rev-list --count <range>
	writes     [][]string
	writeErr   func(argv []string) (core.Output, error)
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
		gitDir:     dir,
		status:     gitWriteStatus("a.txt", "M."),
		branches:   map[string]bool{"main": true},
		remoteRefs: map[string]bool{},
		upstreams:  map[string]string{},
		unmerged:   map[string]bool{},
		revCounts:  map[string]int{},
		config:     "remote.origin.url=/tmp/remote.git\n",
	}
}

func (f *gitM5Fake) read(_ context.Context, dir string, args []string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && args[1] == "--show-toplevel":
		return core.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse" && args[1] == "--verify" && strings.HasPrefix(args[2], "refs/remotes/"):
		if f.remoteRefs[strings.TrimPrefix(args[2], "refs/remotes/")] {
			return core.Output{Stdout: strings.Repeat("b", 40) + "\n"}, nil
		}
		return core.Output{ExitCode: 128, Stderr: "fatal: Needed a single revision\n"}, nil
	case args[0] == "rev-parse" && args[1] == "--verify":
		name := strings.TrimPrefix(args[2], "refs/heads/")
		if f.branches[name] {
			return core.Output{Stdout: strings.Repeat("a", 40) + "\n"}, nil
		}
		return core.Output{ExitCode: 128, Stderr: "fatal: Needed a single revision\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case args[0] == "status":
		return core.Output{Stdout: f.status}, nil
	case args[0] == "check-ref-format":
		return fakeCheckRefFormat(args[2]), nil
	// 묶음 B: upstream 표시 · 미머지 판정 · 영향 범위 · 원격 목록 (FR-GIT-254·255·258).
	case args[0] == "for-each-ref":
		return core.Output{Stdout: f.upstreams[strings.TrimPrefix(args[len(args)-1], "refs/heads/")] + "\n"}, nil
	case args[0] == "merge-base":
		// exit 1 은 실패가 아니라 "조상이 아니다" 라는 **답**이다.
		if f.unmerged[args[2]] {
			return core.Output{ExitCode: 1}, nil
		}
		return core.Output{}, nil
	case args[0] == "rev-list":
		return core.Output{Stdout: fmt.Sprint(f.revCounts[args[len(args)-1]]) + "\n"}, nil
	case args[0] == "config":
		return core.Output{Stdout: f.config}, nil
	}
	return core.Output{}, nil
}

// fakeCheckRefFormat 은 git 의 판정을 흉내 낸다. 규칙 전체가 아니라 **응답의 형태**가
// 검사 대상이다 — 실제 규칙은 internal/webserver/domain/git 의 단위 테스트가 진짜 git 으로 본다.
func fakeCheckRefFormat(name string) core.Output {
	if strings.ContainsAny(name, " ~^:?*[\\") || strings.Contains(name, "..") || strings.HasSuffix(name, ".lock") {
		return core.Output{ExitCode: 128, Stderr: "fatal: '" + name + "' is not a valid branch name\n"}
	}
	return core.Output{Stdout: name + "\n"}
}

func (f *gitM5Fake) write(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if args[0] == "stash" && len(args) > 1 {
		switch args[1] {
		case "list":
			return core.Output{Stdout: f.stashes}, nil
		case "show":
			return core.Output{Stdout: f.show}, nil
		}
	}
	f.writes = append(f.writes, append([]string(nil), args...))
	if f.writeErr != nil {
		return f.writeErr(args)
	}
	if f.onWrite != nil {
		f.onWrite(f, args)
	}
	return core.Output{}, nil
}

func (f *gitM5Fake) wrote() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.writes...)
}

// gitM5Server 는 읽기·쓰기 둘 다 격리된 GitServer 를 세운다.
func gitM5Server(t *testing.T, f *gitM5Fake) *GitServer {
	t.Helper()
	store := store.NewStore(core.New(core.WithRunner(f.read), core.WithWriteRunner(f.write)))
	return &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: store}
}

// gitM5Endpoints 는 18·19단계가 더한 라우트 전부다.
var gitM5Endpoints = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodPost, "/api/git/checkout", `{"repo":` + qWorkRepo + `,"ref":"main"}`},
	{http.MethodPost, "/api/git/branch", `{"repo":` + qWorkRepo + `,"name":"feat"}`},
	{http.MethodGet, "/api/git/branch/validate?repo=" + url.QueryEscape(absWorkRepo) + "&name=feat", ""},
	{http.MethodGet, "/api/git/stash?repo=" + url.QueryEscape(absWorkRepo), ""},
	{http.MethodGet, "/api/git/stash/show?repo=" + url.QueryEscape(absWorkRepo) + "&index=0", ""},
	{http.MethodPost, "/api/git/stash/push", `{"repo":` + qWorkRepo + `}`},
	{http.MethodPost, "/api/git/stash/apply", `{"repo":` + qWorkRepo + `,"index":0}`},
	{http.MethodPost, "/api/git/stash/pop", `{"repo":` + qWorkRepo + `,"index":0}`},
	{http.MethodPost, "/api/git/stash/drop", `{"repo":` + qWorkRepo + `,"index":0,"confirm":true}`},
}

// M1: 9개 라우트가 gitapi.routes 에 등록돼 있고, Git 이 없으면 전부 503 이다.
func TestGitM5Routes_RegisteredAndUnavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitM5Endpoints {
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

// M2 (V55, FR-GIT-97·157, O14): `force:true` 는 `confirm:true` 없이 400 이고
// **실행되지 않는다.** 강제 checkout 은 워킹 트리의 변경을 버린다.
func TestAPIGitCheckout_ForceRequiresConfirm(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/checkout",
		`{"repo":`+qWorkRepo+`,"ref":"main","force":true}`)
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
		`{"repo":`+qWorkRepo+`,"ref":"main","force":true,"confirm":true}`)
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
		`{"repo":`+qWorkRepo+`,"create":"feat","track":"origin/feat"}`)
	if code != http.StatusConflict || out["error"] != gitErrBranchExists {
		t.Fatalf("code = %d, error = %v, want 409 branch_exists", code, out["error"])
	}
	if out["branch"] != "feat" || out["track"] != "origin/feat" {
		t.Fatalf("branch/track = %v / %v", out["branch"], out["track"])
	}
	opts, _ := out["options"].([]any)
	if len(opts) != len(write.BranchConflictOptions) {
		t.Fatalf("options = %v, want %v", opts, write.BranchConflictOptions)
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
		`{"repo":`+qWorkRepo+`,"create":"feat","track":"origin/feat"}`)
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
		{"이름 규칙 위반 (생성)", "/api/git/branch", `{"repo":` + qWorkRepo + `,"name":"bad name"}`, gitErrRefName},
		{"이름 규칙 위반 (checkout)", "/api/git/checkout", `{"repo":` + qWorkRepo + `,"create":"a..b"}`, gitErrRefName},
		{"- 로 시작하는 ref", "/api/git/checkout", `{"repo":` + qWorkRepo + `,"ref":"-x"}`, gitErrRefName},
		{"대상 없음", "/api/git/checkout", `{"repo":` + qWorkRepo + `}`, gitErrBadRequest},
		{"track 만", "/api/git/checkout", `{"repo":` + qWorkRepo + `,"track":"origin/feat"}`, gitErrBadRequest},
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
		{`{"repo":` + qWorkRepo + `,"name":"feat"}`, []string{"branch", "feat"}},
		{`{"repo":` + qWorkRepo + `,"name":"feat","checkout":true}`, []string{"checkout", "-b", "feat"}},
		{`{"repo":` + qWorkRepo + `,"name":"feat","startRef":"abc123"}`, []string{"branch", "feat", "abc123"}},
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
				"/api/git/branch/validate?repo="+url.QueryEscape(absWorkRepo)+"&name="+strings.ReplaceAll(c.name, " ", "%20"), "")
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
	code, out := gitReq(t, s, http.MethodGet, "/api/git/branch/validate?repo="+url.QueryEscape(absWorkRepo)+"&name=taken", "")
	if code != http.StatusOK || out["ok"] != true || out["exists"] != true {
		t.Fatalf("code = %d, body = %v", code, out)
	}
}

// ── 묶음 B 서버측 — 브랜치 동작 (GIT_ACTIONS_SRS §3.2 · §3.5) ──
//
// **서버가 마지막 방어선이다.** 파괴적 동작의 confirm, 현재 브랜치 삭제 금지,
// 일괄 강제 삭제 금지, 미머지의 선택지를 클라이언트만 막으면 API 직접 호출이
// 그대로 우회한다.

// gitBranchActionEndpoints 는 묶음 B 가 더한 라우트 전부다.
var gitBranchActionEndpoints = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodPost, "/api/git/branch/rename", `{"repo":` + qWorkRepo + `,"from":"a","to":"b"}`},
	{http.MethodPost, "/api/git/branch/delete", `{"repo":` + qWorkRepo + `,"names":["a"],"confirm":true}`},
	{http.MethodPost, "/api/git/branch/merge", `{"repo":` + qWorkRepo + `,"ref":"side"}`},
	{http.MethodPost, "/api/git/branch/rebase", `{"repo":` + qWorkRepo + `,"ref":"main","confirm":true}`},
	{http.MethodPost, "/api/git/branch/upstream", `{"repo":` + qWorkRepo + `,"branch":"a","upstream":"origin/a"}`},
	{http.MethodGet, "/api/git/branch/merge-preview?repo=" + url.QueryEscape(absWorkRepo) + "&ref=side", ""},
	{http.MethodPost, "/api/git/branch/push", `{"repo":` + qWorkRepo + `,"branch":"a"}`},
	{http.MethodPost, "/api/git/branch/fetch", `{"repo":` + qWorkRepo + `,"remote":"origin","branch":"a"}`},
	{http.MethodPost, "/api/git/branch/delete-remote", `{"repo":` + qWorkRepo + `,"remote":"origin","branch":"a","confirm":true}`},
}

// BA1: 9개 라우트가 등록돼 있고, Git 이 없으면 전부 503 이다 (다른 표면과 같은 규약).
func TestGitBranchActionRoutes_RegisteredAndUnavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitBranchActionEndpoints {
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

// BA2 (FR-GIT-89·254): 삭제는 `confirm:true` 없이 400 이고 **실행되지 않는다.**
// `-D` 가 확인 없이 지나가는 자리를 만들지 않는다.
func TestAPIGitBranchDelete_RequiresConfirm(t *testing.T) {
	for _, body := range []string{
		`{"repo":` + qWorkRepo + `,"names":["feat"]}`,
		`{"repo":` + qWorkRepo + `,"names":["feat"],"force":true}`,
	} {
		f := newGitM5Fake(t)
		f.branches["feat"] = true
		s := gitM5Server(t, f)
		code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/delete", body)
		if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
			t.Fatalf("%s → %d %v, want 400 %s", body, code, out["error"], gitErrConfirmRequired)
		}
		if w := f.wrote(); len(w) != 0 {
			t.Fatalf("%s: 확인 없이 실행됐다: %v", body, w)
		}
	}
}

// BA3 (FR-GIT-254): 현재 브랜치는 지울 수 없다. git 도 거부하지만 exit 128 의
// 문구로만 답하므로 실행 **전에** 사유가 있는 409 로 답한다.
func TestAPIGitBranchDelete_RefusesCurrentBranch(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/delete",
		`{"repo":`+qWorkRepo+`,"names":["main"],"confirm":true}`)
	if code != http.StatusConflict || out["error"] != gitErrBranchCurrent {
		t.Fatalf("→ %d %v, want 409 %s", code, out["error"], gitErrBranchCurrent)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("현재 브랜치인데 실행됐다: %v", w)
	}
}

// BA4 (FR-GIT-254 / V180): 미머지 브랜치의 `-d` 는 **실패가 아니라 선택지**다 —
// 사유·지우기 전 oid·`-D` 로 올릴 선택지를 함께 준다. 실행하지는 않는다.
func TestAPIGitBranchDelete_UnmergedOffersForce(t *testing.T) {
	f := newGitM5Fake(t)
	f.branches["feat"] = true
	f.unmerged["feat"] = true
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/delete",
		`{"repo":`+qWorkRepo+`,"names":["feat"],"confirm":true}`)
	if code != http.StatusConflict || out["error"] != gitErrBranchNotMerged {
		t.Fatalf("→ %d %v, want 409 %s", code, out["error"], gitErrBranchNotMerged)
	}
	if out["branch"] != "feat" || out["oid"] != strings.Repeat("a", 40) {
		t.Fatalf("branch/oid = %v / %v", out["branch"], out["oid"])
	}
	opts, _ := out["options"].([]any)
	if len(opts) != len(write.BranchDeleteOptions) || opts[0] != write.BranchDeleteForce {
		t.Fatalf("options = %v, want %v", opts, write.BranchDeleteOptions)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("선택지를 줘야 하는데 실행됐다: %v", w)
	}

	// `-D` 로 올리면 실행된다 — 그것이 선택지의 뜻이다.
	f2 := newGitM5Fake(t)
	f2.branches["feat"] = true
	f2.unmerged["feat"] = true
	s2 := gitM5Server(t, f2)
	code, out = gitReq(t, s2, http.MethodPost, "/api/git/branch/delete",
		`{"repo":`+qWorkRepo+`,"names":["feat"],"force":true,"confirm":true}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("→ %d %v", code, out)
	}
	want := []string{"branch", "-D", "feat"}
	if w := f2.wrote(); len(w) != 1 || fmt.Sprint(w[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f2.wrote(), want)
	}
}

// BA5 (FR-GIT-254 / V181): **다중 삭제는 `-D` 를 제공하지 않는다.** 확인 하나가
// 여러 개의 미머지 브랜치를 지우는 자리를 만들지 않는다.
func TestAPIGitBranchDelete_BulkIsSoftOnly(t *testing.T) {
	f := newGitM5Fake(t)
	f.branches["a"], f.branches["b"] = true, true
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/delete",
		`{"repo":`+qWorkRepo+`,"names":["a","b"],"force":true,"confirm":true}`)
	if code != http.StatusBadRequest || out["error"] != gitErrBadRequest {
		t.Fatalf("→ %d %v, want 400", code, out["error"])
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("일괄 강제 삭제가 실행됐다: %v", w)
	}

	// 미머지가 섞인 일괄 삭제의 선택지에도 `-D` 가 없다.
	f2 := newGitM5Fake(t)
	f2.branches["a"], f2.branches["b"] = true, true
	f2.unmerged["b"] = true
	s2 := gitM5Server(t, f2)
	code, out = gitReq(t, s2, http.MethodPost, "/api/git/branch/delete",
		`{"repo":`+qWorkRepo+`,"names":["a","b"],"confirm":true}`)
	if code != http.StatusConflict || out["error"] != gitErrBranchNotMerged {
		t.Fatalf("→ %d %v, want 409 %s", code, out["error"], gitErrBranchNotMerged)
	}
	opts, _ := out["options"].([]any)
	for _, o := range opts {
		if o == write.BranchDeleteForce {
			t.Fatalf("다중 삭제에 -D 선택지가 있다: %v", opts)
		}
	}
}

// BA6 (FR-GIT-250.2 / V179): 성공한 삭제는 **지우기 전 oid** 를 응답에 싣는다 —
// 그 값이 hint 의 `git branch <name> <oid>` 를 만든다.
func TestAPIGitBranchDelete_ReturnsPreDeleteOids(t *testing.T) {
	f := newGitM5Fake(t)
	f.branches["feat"] = true
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/delete",
		`{"repo":`+qWorkRepo+`,"names":["feat"],"confirm":true}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("→ %d %v", code, out)
	}
	want := []string{"branch", "-d", "feat"}
	if w := f.wrote(); len(w) != 1 || fmt.Sprint(w[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f.wrote(), want)
	}
	del, _ := out["deleted"].(map[string]any)
	oids, _ := del["oids"].([]any)
	if len(oids) != 1 || oids[0] != strings.Repeat("a", 40) {
		t.Fatalf("deleted = %v — 지우기 전 oid 가 없으면 되살릴 수 없다", del)
	}
	// hint 도 같은 값으로 남는다 (FR-GIT-92·93).
	hints := s.Git.Service().Hints(0)
	if len(hints) != 1 || hints[0].Command != "git branch feat "+strings.Repeat("a", 40) {
		t.Fatalf("hints = %+v", hints)
	}
}

// BA7 (FR-GIT-253 / V178): rename 은 `-m` 하나이고, 이미 있는 이름은 생성과 **같은
// 자리**에서 409 로 막힌다 — 실행되지 않는다.
func TestAPIGitBranchRename(t *testing.T) {
	f := newGitM5Fake(t)
	f.branches["feat"] = true
	f.onWrite = func(f *gitM5Fake, _ []string) { f.status = gitWriteStatus("b.txt", ".M") }
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/rename",
		`{"repo":`+qWorkRepo+`,"from":"feat","to":"feature"}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("→ %d %v", code, out)
	}
	want := []string{"branch", "-m", "feat", "feature"}
	if w := f.wrote(); len(w) != 1 || fmt.Sprint(w[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f.wrote(), want)
	}

	f2 := newGitM5Fake(t)
	f2.branches["feat"] = true
	s2 := gitM5Server(t, f2)
	code, out = gitReq(t, s2, http.MethodPost, "/api/git/branch/rename",
		`{"repo":`+qWorkRepo+`,"from":"feat","to":"main"}`)
	if code != http.StatusConflict || out["error"] != gitErrBranchExists {
		t.Fatalf("→ %d %v, want 409 %s", code, out["error"], gitErrBranchExists)
	}
	if w := f2.wrote(); len(w) != 0 {
		t.Fatalf("중복 이름인데 실행됐다: %v", w)
	}

	// 이름 규칙 위반과 같은 이름으로의 변경은 400 이며 실행되지 않는다.
	for _, body := range []string{
		`{"repo":` + qWorkRepo + `,"from":"feat","to":"bad name"}`,
		`{"repo":` + qWorkRepo + `,"from":"feat","to":"feat"}`,
		`{"repo":` + qWorkRepo + `,"from":"","to":"x"}`,
	} {
		f3 := newGitM5Fake(t)
		f3.branches["feat"] = true
		s3 := gitM5Server(t, f3)
		code, out := gitReq(t, s3, http.MethodPost, "/api/git/branch/rename", body)
		if code != http.StatusBadRequest {
			t.Fatalf("%s → %d %v, want 400", body, code, out["error"])
		}
		if w := f3.wrote(); len(w) != 0 {
			t.Fatalf("%s: 거부해야 하는데 실행됐다: %v", body, w)
		}
	}
}

// BA8 (FR-GIT-255): merge 의 방식이 argv 를 가른다. 모르는 방식은 실행 전에 400 이다.
func TestAPIGitBranchMerge(t *testing.T) {
	for _, tc := range []struct {
		body string
		want []string
	}{
		{`{"repo":` + qWorkRepo + `,"ref":"side"}`, []string{"merge", "side"}},
		{`{"repo":` + qWorkRepo + `,"ref":"side","mode":"ff-only"}`, []string{"merge", "--ff-only", "side"}},
		{`{"repo":` + qWorkRepo + `,"ref":"side","mode":"no-ff"}`, []string{"merge", "--no-ff", "side"}},
		{`{"repo":` + qWorkRepo + `,"ref":"side","mode":"squash"}`, []string{"merge", "--squash", "side"}},
	} {
		f := newGitM5Fake(t)
		s := gitM5Server(t, f)
		code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/merge", tc.body)
		if code != http.StatusOK || out["ok"] != true {
			t.Fatalf("%s → %d %v", tc.body, code, out)
		}
		if w := f.wrote(); len(w) != 1 || fmt.Sprint(w[0]) != fmt.Sprint(tc.want) {
			t.Fatalf("argv = %v, want %v", f.wrote(), tc.want)
		}
	}
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	code, _ := gitReq(t, s, http.MethodPost, "/api/git/branch/merge",
		`{"repo":`+qWorkRepo+`,"ref":"side","mode":"octopus"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("→ %d, want 400", code)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("모르는 방식인데 실행됐다: %v", w)
	}
}

// BA9 (FR-GIT-89·256 / V184): rebase 는 파괴적이므로 confirm 없이 실행되지 않는다.
func TestAPIGitBranchRebase_RequiresConfirm(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/rebase",
		`{"repo":`+qWorkRepo+`,"ref":"main"}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("→ %d %v, want 400 %s", code, out["error"], gitErrConfirmRequired)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("확인 없이 실행됐다: %v", w)
	}

	f2 := newGitM5Fake(t)
	s2 := gitM5Server(t, f2)
	code, out = gitReq(t, s2, http.MethodPost, "/api/git/branch/rebase",
		`{"repo":`+qWorkRepo+`,"ref":"main","onto":"v1","confirm":true}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("→ %d %v", code, out)
	}
	want := []string{"rebase", "--onto", "v1", "main"}
	if w := f2.wrote(); len(w) != 1 || fmt.Sprint(w[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f2.wrote(), want)
	}
	// hint 는 rebase 전 HEAD 로 되돌리는 명령이다 (FR-GIT-250.2).
	hints := s2.Git.Service().Hints(0)
	if len(hints) != 1 || hints[0].Command != "git reset --hard "+strings.Repeat("a", 40) {
		t.Fatalf("hints = %+v", hints)
	}
}

// BA10 (FR-GIT-257 / V185): set 과 unset 은 다른 argv 이며 대상 브랜치를 반드시 받는다.
func TestAPIGitBranchUpstream(t *testing.T) {
	for _, tc := range []struct {
		body string
		want []string
	}{
		{`{"repo":` + qWorkRepo + `,"branch":"feat","upstream":"origin/feat"}`,
			[]string{"branch", "--set-upstream-to=origin/feat", "feat"}},
		{`{"repo":` + qWorkRepo + `,"branch":"feat","unset":true}`,
			[]string{"branch", "--unset-upstream", "feat"}},
	} {
		f := newGitM5Fake(t)
		s := gitM5Server(t, f)
		code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/upstream", tc.body)
		if code != http.StatusOK || out["ok"] != true {
			t.Fatalf("%s → %d %v", tc.body, code, out)
		}
		if w := f.wrote(); len(w) != 1 || fmt.Sprint(w[0]) != fmt.Sprint(tc.want) {
			t.Fatalf("argv = %v, want %v", f.wrote(), tc.want)
		}
	}
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	code, _ := gitReq(t, s, http.MethodPost, "/api/git/branch/upstream",
		`{"repo":`+qWorkRepo+`,"branch":"feat"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("→ %d, want 400 — set 인지 unset 인지 가릴 수 없다", code)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("가릴 수 없는데 실행됐다: %v", w)
	}
}

// BA11 (FR-GIT-255 / V182): 영향 범위는 **실행 전에** 200 으로 답한다 — ff 여부와
// 들어올 커밋 수. 쓰기 경로로 새지 않는다.
func TestAPIGitBranchMergePreview(t *testing.T) {
	f := newGitM5Fake(t)
	f.revCounts["HEAD..side"] = 3
	f.revCounts["side..HEAD"] = 0
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/branch/merge-preview?repo="+url.QueryEscape(absWorkRepo)+"&ref=side", "")
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out)
	}
	pv, _ := out["preview"].(map[string]any)
	if pv["ff"] != true || pv["incoming"] != float64(3) || pv["diverged"] != float64(0) {
		t.Fatalf("preview = %v", pv)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("조회가 쓰기 경로로 흘렀다: %v", w)
	}

	// 갈라져 있으면 ff 가 아니다.
	f2 := newGitM5Fake(t)
	f2.revCounts["HEAD..side"] = 2
	f2.revCounts["side..HEAD"] = 1
	f2.unmerged["HEAD"] = true
	s2 := gitM5Server(t, f2)
	code, out = gitReq(t, s2, http.MethodGet, "/api/git/branch/merge-preview?repo="+url.QueryEscape(absWorkRepo)+"&ref=side", "")
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out)
	}
	pv, _ = out["preview"].(map[string]any)
	if pv["ff"] != false || pv["diverged"] != float64(1) {
		t.Fatalf("preview = %v", pv)
	}

	// 옵션처럼 생긴 ref 는 400 이다.
	code, _ = gitReq(t, s, http.MethodGet, "/api/git/branch/merge-preview?repo="+url.QueryEscape(absWorkRepo)+"&ref=-x", "")
	if code != http.StatusBadRequest {
		t.Fatalf("→ %d, want 400", code)
	}
}

// BA12 (FR-GIT-258 / V186): 대상이 **현재 브랜치가 아니어도** upstream 이 없으면
// publish 임을 실행 전에 알린다 — 계획을 함께 준다.
func TestAPIGitBranchPush_PublishRequired(t *testing.T) {
	f := newGitM5Fake(t)
	f.branches["feat"] = true
	s := gitBranchJobServer(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/push",
		`{"repo":`+qWorkRepo+`,"branch":"feat"}`)
	if code != http.StatusConflict || out["error"] != gitErrPublishRequired {
		t.Fatalf("→ %d %v, want 409 %s", code, out["error"], gitErrPublishRequired)
	}
	plan, _ := out["plan"].(map[string]any)
	if plan["publish"] != true || plan["remote"] != "origin" || plan["branch"] != "feat" {
		t.Fatalf("plan = %v", plan)
	}

	// 확인이 오면 job 이 뜬다 — 원격 작업이므로 기존 job 경로를 탄다.
	code, out = gitReq(t, s, http.MethodPost, "/api/git/branch/push",
		`{"repo":`+qWorkRepo+`,"branch":"feat","publish":true}`)
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out)
	}
	if gitBranchJobArgv(t, out) != "push --progress -u origin feat" {
		t.Fatalf("argv = %q", gitBranchJobArgv(t, out))
	}
}

// BA13 (FR-GIT-268 / V195): 원격 브랜치의 세 항목 중 서버로 오는 둘. 삭제는
// `confirm:true` 없이 실행되지 않고, hint 는 되살리는 push 다.
func TestAPIGitRemoteBranch_FetchAndDelete(t *testing.T) {
	f := newGitM5Fake(t)
	f.remoteRefs["origin/feat"] = true
	s := gitBranchJobServer(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/branch/fetch",
		`{"repo":`+qWorkRepo+`,"remote":"origin","branch":"feat"}`)
	if code != http.StatusOK {
		t.Fatalf("fetch → %d %v", code, out)
	}
	if got := gitBranchJobArgv(t, out); got != "fetch --progress origin feat:feat" {
		t.Fatalf("argv = %q", got)
	}

	// 확인 없는 원격 ref 삭제는 400 이고 hint 도 남지 않는다.
	f2 := newGitM5Fake(t)
	f2.remoteRefs["origin/feat"] = true
	s2 := gitBranchJobServer(t, f2)
	code, out = gitReq(t, s2, http.MethodPost, "/api/git/branch/delete-remote",
		`{"repo":`+qWorkRepo+`,"remote":"origin","branch":"feat"}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("→ %d %v, want 400 %s", code, out["error"], gitErrConfirmRequired)
	}
	if h := s2.Git.Service().Hints(0); len(h) != 0 {
		t.Fatalf("실행하지 않았는데 hint 가 남았다: %+v", h)
	}

	code, out = gitReq(t, s2, http.MethodPost, "/api/git/branch/delete-remote",
		`{"repo":`+qWorkRepo+`,"remote":"origin","branch":"feat","confirm":true}`)
	if code != http.StatusOK {
		t.Fatalf("→ %d %v", code, out)
	}
	if got := gitBranchJobArgv(t, out); got != "push --progress origin --delete feat" {
		t.Fatalf("argv = %q", got)
	}
	hints := s2.Git.Service().Hints(0)
	oid := strings.Repeat("b", 40)
	if len(hints) != 1 || hints[0].Command != "git push origin "+oid+":refs/heads/feat" {
		t.Fatalf("hints = %+v — 되살리는 push 가 없으면 지운 ref 를 돌려놓을 수 없다", hints)
	}
}

// gitBranchJobServer 는 job 경로가 **네트워크로 나가지 않게** 실행기를 격리한 서버다.
func gitBranchJobServer(t *testing.T, f *gitM5Fake) *GitServer {
	t.Helper()
	s := gitM5Server(t, f)
	s.gitJobs.run = func(context.Context, string, []string, func(string, string)) (int, error) {
		return 0, nil
	}
	return s
}

// gitBranchJobArgv 는 즉시 응답에 실린 작업의 argv 다 — 다이얼로그의 선택이 실제
// 명령에 반영됐는지는 이것으로만 확인된다.
func gitBranchJobArgv(t *testing.T, out map[string]any) string {
	t.Helper()
	jb, ok := out["job"].(map[string]any)
	if !ok {
		t.Fatalf("job 이 없다: %v", out)
	}
	argv, _ := jb["argv"].([]any)
	parts := make([]string, 0, len(argv))
	for _, a := range argv {
		parts = append(parts, fmt.Sprint(a))
	}
	return strings.Join(parts, " ")
}
