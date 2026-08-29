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
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/store"
)

// 묶음 C 서버측 — /api/git/tag{,/validate,/delete,/push,/delete-remote}
// (GIT_ACTIONS_SRS §3.3, 검증 V187~V190).
//
// **서버가 마지막 방어선이다** (FR-GIT-250.1·250.3). 이름 규칙·중복·2단계 확인을
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다. 이 파일이 보는 것은 그
// 우회가 막히는지, 그리고 **막힌 요청이 실행되지 않았는지** 다.

var gitTagRepo = absWorkRepo

// gitTagFake 는 태그 표면이 딛는 읽기·쓰기를 함께 격리한다. WithRunner 만 주면
// 실제 git 이 돌아 테스트가 저장소를 바꾼다.
type gitTagFake struct {
	mu     sync.Mutex
	gitDir string
	status string
	tags   map[string]string // 태그 이름 → oid
	config string
	writes [][]string
}

func newGitTagFake(t *testing.T) *gitTagFake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &gitTagFake{
		gitDir: dir,
		status: gitWriteStatus("a.txt", "M."),
		tags:   map[string]string{"v1.0": strings.Repeat("b", 40)},
		config: "remote.origin.url=/tmp/remote.git\n",
	}
}

func (f *gitTagFake) read(_ context.Context, dir string, args []string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		return core.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse" && len(args) > 2 && args[1] == "--verify":
		name := strings.TrimPrefix(args[2], query.TagRefPrefix)
		if oid, ok := f.tags[name]; ok {
			return core.Output{Stdout: oid + "\n"}, nil
		}
		return core.Output{ExitCode: 128, Stderr: "fatal: Needed a single revision\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case args[0] == "status":
		return core.Output{Stdout: f.status}, nil
	case args[0] == "config":
		return core.Output{Stdout: f.config}, nil
	case args[0] == "check-ref-format":
		return fakeCheckRefFormatNormalize(args[2]), nil
	}
	return core.Output{}, nil
}

// fakeCheckRefFormatNormalize 는 `--normalize` 의 판정을 흉내 낸다. 규칙 전체가
// 아니라 **응답의 형태**가 검사 대상이다 — 실제 규칙은 write/tag_test.go 가 진짜
// git 으로 본다. 실측대로 exit 1 + 출력 없음이다 (브랜치의 128 이 아니다).
func fakeCheckRefFormatNormalize(full string) core.Output {
	if strings.ContainsAny(full, " ~^:?*[\\") || strings.Contains(full, "..") ||
		strings.HasSuffix(full, ".lock") {
		return core.Output{ExitCode: 1}
	}
	return core.Output{Stdout: strings.ReplaceAll(full, "//", "/") + "\n"}
}

func (f *gitTagFake) write(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, append([]string(nil), args...))
	return core.Output{}, nil
}

func (f *gitTagFake) wrote() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.writes...)
}

// gitTagServer 는 읽기·쓰기·작업 실행기를 모두 격리한다. run 을 주지 않으면 원격
// 라우트가 실제 git 을 네트워크로 내보낸다.
func gitTagServer(t *testing.T, f *gitTagFake, run jobs.JobRunner) *GitServer {
	t.Helper()
	st := store.NewStore(core.New(core.WithRunner(f.read), core.WithWriteRunner(f.write)))
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: st}
	s.gitJobs.run = run
	return s
}

// gitTagJobs 는 시작된 작업의 argv 를 모으는 실행기다. 원격 라우트가 무엇을
// 실행하려 했는지는 job 경로 안에서만 보인다.
func gitTagJobs(argvs *[][]string, mu *sync.Mutex) jobs.JobRunner {
	return func(_ context.Context, _ string, args []string, _ func(string, string)) (int, error) {
		mu.Lock()
		*argvs = append(*argvs, append([]string(nil), args...))
		mu.Unlock()
		return 0, nil
	}
}

// gitTagEndpoints 는 묶음 C 가 더한 라우트 전부다.
var gitTagEndpoints = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodPost, "/api/git/tag", `{"repo":` + qWorkRepo + `,"name":"v9.0"}`},
	{http.MethodGet, "/api/git/tag/validate?repo=/work/repo&name=v9.0", ""},
	{http.MethodPost, "/api/git/tag/delete", `{"repo":` + qWorkRepo + `,"name":"v1.0","confirm":true}`},
	{http.MethodPost, "/api/git/tag/push", `{"repo":` + qWorkRepo + `,"name":"v1.0"}`},
	{http.MethodPost, "/api/git/tag/delete-remote", `{"repo":` + qWorkRepo + `,"name":"v1.0","confirm":true}`},
}

// C1 (FR-GIT-250): 5개 라우트가 gitapi.routes 에 등록돼 있고, Git 이 없으면 전부
// 503 이다. 화면 항목은 이 표면 위에만 선다.
func TestGitTagRoutes_RegisteredAndUnavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitTagEndpoints {
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

// C2 (V189, FR-GIT-89·250.1): **`confirm` 없는 파괴적 요청은 실행되지 않는다.**
// 로컬 삭제와 원격 삭제 둘 다다 — 하나만 막으면 다른 하나가 우회로가 된다.
func TestAPIGitTagDelete_RequiresConfirm(t *testing.T) {
	var mu sync.Mutex
	jobArgvs := [][]string{}
	cases := []struct{ name, path, body string }{
		{"로컬 삭제", "/api/git/tag/delete", `{"repo":` + qWorkRepo + `,"name":"v1.0"}`},
		{"원격 삭제", "/api/git/tag/delete-remote", `{"repo":` + qWorkRepo + `,"name":"v1.0"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitTagFake(t)
			s := gitTagServer(t, f, gitTagJobs(&jobArgvs, &mu))

			code, out := gitReq(t, s, http.MethodPost, c.path, c.body)
			if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
				t.Fatalf("code = %d, error = %v, want 400 confirmation_required", code, out["error"])
			}
			if got := f.wrote(); len(got) != 0 {
				t.Fatalf("거부됐는데 쓰기가 실행됐다: %v", got)
			}
			mu.Lock()
			n := len(jobArgvs)
			mu.Unlock()
			if n != 0 {
				t.Fatalf("거부됐는데 작업이 떴다: %v", jobArgvs)
			}
			// hint 도 남지 않는다 — 지우지 않은 것의 복구 안내는 거짓이다.
			if h := s.Git.Service().Hints(0); len(h) != 0 {
				t.Fatalf("거부됐는데 hint 가 %d개다", len(h))
			}
		})
	}
}

// C3 (V189, FR-GIT-261): confirm 이 있으면 로컬 삭제가 `tag -d` **하나만** 실행한다.
// 원격으로 새는 인자가 있으면 "하나가 다른 하나를 자동으로 하지 않는다" 가 깨진다.
func TestAPIGitTagDelete_LocalOnly(t *testing.T) {
	f := newGitTagFake(t)
	var mu sync.Mutex
	jobArgvs := [][]string{}
	s := gitTagServer(t, f, gitTagJobs(&jobArgvs, &mu))

	code, out := gitReq(t, s, http.MethodPost, "/api/git/tag/delete",
		`{"repo":`+qWorkRepo+`,"name":"v1.0","confirm":true}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	want := []string{"tag", "-d", "v1.0"}
	if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v 하나뿐", got, want)
	}
	mu.Lock()
	n := len(jobArgvs)
	mu.Unlock()
	if n != 0 {
		t.Fatalf("로컬 삭제가 원격 작업을 함께 띄웠다: %v", jobArgvs)
	}
	// recovery hint 가 **지우기 전 oid** 를 싣는다 (FR-GIT-92·250.2).
	hints := s.Git.Service().Hints(0)
	if len(hints) != 1 || hints[0].Action != core.ActionTagDelete {
		t.Fatalf("hint = %+v, want tag_delete 하나", hints)
	}
	if oid := strings.Repeat("b", 40); !strings.Contains(hints[0].Command, oid) {
		t.Fatalf("hint 명령에 지우기 전 oid 가 없다: %q", hints[0].Command)
	}
}

// C4 (V189, FR-GIT-261): 원격 삭제는 **job 경로**로 `push --delete` 를 실행하고
// 로컬은 건드리지 않는다. 원격 이름은 서버가 정한다 (query.DefaultRemote).
func TestAPIGitTagDeleteRemote_JobPathOnly(t *testing.T) {
	f := newGitTagFake(t)
	var mu sync.Mutex
	jobArgvs := [][]string{}
	s := gitTagServer(t, f, gitTagJobs(&jobArgvs, &mu))

	code, out := gitReq(t, s, http.MethodPost, "/api/git/tag/delete-remote",
		`{"repo":`+qWorkRepo+`,"name":"v1.0","confirm":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	id := gitRemoteJobID(t, out)
	if out["remote"] != "origin" {
		t.Fatalf("remote = %v, want origin", out["remote"])
	}
	jb := gitRemoteWaitDone(t, s, id)
	want := []string{"push", "--progress", "origin", "--delete", "v1.0"}
	if fmt.Sprint(jb.Argv) != fmt.Sprint(want) {
		t.Fatalf("job argv = %v, want %v", jb.Argv, want)
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("원격 삭제가 로컬 쓰기 경로로 흘렀다: %v", got)
	}
	hints := s.Git.Service().Hints(0)
	if len(hints) != 1 || hints[0].Action != core.ActionRemoteRefDelete {
		t.Fatalf("hint = %+v, want remote_ref_delete 하나", hints)
	}
}

// C5 (V190, FR-GIT-262): 태그 push 는 job 경로를 탄다 — 즉시 응답이 작업 식별자다.
// 하나와 전부(`--tags`)가 서로 다른 argv 로 간다.
func TestAPIGitTagPush_JobPath(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{"태그 하나", `{"repo":` + qWorkRepo + `,"name":"v1.0"}`,
			[]string{"push", "--progress", "origin", "refs/tags/v1.0"}},
		{"전부", `{"repo":` + qWorkRepo + `,"all":true}`,
			[]string{"push", "--progress", "origin", "--tags"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitTagFake(t)
			var mu sync.Mutex
			jobArgvs := [][]string{}
			s := gitTagServer(t, f, gitTagJobs(&jobArgvs, &mu))

			code, out := gitReq(t, s, http.MethodPost, "/api/git/tag/push", c.body)
			if code != http.StatusOK {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			jb := gitRemoteWaitDone(t, s, gitRemoteJobID(t, out))
			if fmt.Sprint(jb.Argv) != fmt.Sprint(c.want) {
				t.Fatalf("job argv = %v, want %v", jb.Argv, c.want)
			}
			// push 는 파괴적이 아니므로 confirm 을 요구하지 않고 hint 도 남기지
			// 않는다 — 잃는 것이 없다.
			if h := s.Git.Service().Hints(0); len(h) != 0 {
				t.Fatalf("push 가 hint 를 남겼다: %+v", h)
			}
		})
	}
}

// C6 (V188, FR-GIT-260·250.3): 이름 규칙 위반과 중복은 **실행 전에** 거부된다.
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.
func TestAPIGitTagCreate_RejectsBeforeExecuting(t *testing.T) {
	cases := []struct {
		name string
		body string
		code int
		err  string
	}{
		{"이름 규칙 위반", `{"repo":` + qWorkRepo + `,"name":"bad name"}`,
			http.StatusBadRequest, gitErrRefName},
		{"- 로 시작하는 이름", `{"repo":` + qWorkRepo + `,"name":"-x"}`,
			http.StatusBadRequest, gitErrRefName},
		{"이미 있는 이름", `{"repo":` + qWorkRepo + `,"name":"v1.0"}`,
			http.StatusConflict, gitErrTagExists},
		{"모르는 종류", `{"repo":` + qWorkRepo + `,"name":"v9.0","kind":"gpg"}`,
			http.StatusBadRequest, gitErrBadRequest},
		{"annotated 인데 메시지 없음", `{"repo":` + qWorkRepo + `,"name":"v9.0","kind":"annotated"}`,
			http.StatusBadRequest, gitErrBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitTagFake(t)
			s := gitTagServer(t, f, nil)
			code, out := gitReq(t, s, http.MethodPost, "/api/git/tag", c.body)
			if code != c.code || out["error"] != c.err {
				t.Fatalf("code = %d, error = %v, want %d %s", code, out["error"], c.code, c.err)
			}
			if got := f.wrote(); len(got) != 0 {
				t.Fatalf("거부됐는데 실행됐다: %v", got)
			}
		})
	}
}

// C7 (V187, FR-GIT-260): 종류마다 argv 가 다르고 메시지는 annotated·signed 에만
// 붙는다 — 라우트를 지나서도 그렇다.
func TestAPIGitTagCreate_KindArgv(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{"lightweight", `{"repo":` + qWorkRepo + `,"name":"v9.0","message":"뜻이 없다"}`,
			[]string{"tag", "v9.0"}},
		{"annotated", `{"repo":` + qWorkRepo + `,"name":"v9.0","kind":"annotated","message":"릴리스"}`,
			[]string{"tag", "-a", "-m", "릴리스", "v9.0"}},
		{"signed + 대상", `{"repo":` + qWorkRepo + `,"name":"v9.0","kind":"signed","message":"서명","ref":"abc123"}`,
			[]string{"tag", "-s", "-m", "서명", "v9.0", "abc123"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitTagFake(t)
			s := gitTagServer(t, f, nil)
			code, out := gitReq(t, s, http.MethodPost, "/api/git/tag", c.body)
			if code != http.StatusOK || out["ok"] != true {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got, c.want)
			}
		})
	}
}

// C8 (V188, FR-GIT-260): 이름 검사는 **200 의 본문**으로 판정을 준다 — 400 이면
// 클라이언트가 "규칙 위반" 과 "요청이 틀렸다" 를 구분할 수 없다. `exists` 는 규칙
// 위반이 아니므로 따로 온다.
func TestAPIGitTagValidate_JudgesInBody(t *testing.T) {
	f := newGitTagFake(t)
	s := gitTagServer(t, f, nil)
	cases := []struct {
		name   string
		q      string
		ok     bool
		exists bool
	}{
		{"쓸 수 있는 이름", "v9.0", true, false},
		{"이미 있는 이름", "v1.0", true, true},
		{"규칙 위반", "bad name", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, out := gitReq(t, s, http.MethodGet,
				"/api/git/tag/validate?repo=/work/repo&name="+strings.ReplaceAll(c.q, " ", "%20"), "")
			if code != http.StatusOK {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			if out["ok"] != c.ok || out["exists"] != c.exists {
				t.Fatalf("ok/exists = %v/%v, want %v/%v", out["ok"], out["exists"], c.ok, c.exists)
			}
			if !c.ok && out["reason"] == "" {
				t.Fatalf("위반인데 사유가 없다: %v", out)
			}
		})
	}
}
