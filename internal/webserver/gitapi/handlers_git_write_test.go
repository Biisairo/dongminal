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
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/git/write"
)

// 묶음 H·I 서버측 — /api/git/{stage,unstage,discard,commit,undo-last}
// (GIT_SRS §3A.1·§3A.2, 검증 V30·V35·V36·V37).
//
// **서버가 마지막 방어선이다.** 확인·preflight·undo 만료를 클라이언트만 막으면
// API 직접 호출이 그대로 우회한다.

// gitWriteStatus 는 staged 1개인 porcelain v2 출력이다. 커밋이 "staged 가 없다"로
// 막히지 않으려면 실제로 staged 가 있어야 한다.
func gitWriteStatus(path, xy string) string {
	rec := "1 " + xy + " N... 100644 100644 100644 " +
		strings.Repeat("1", 40) + " " + strings.Repeat("2", 40) + " " + path
	return strings.Join([]string{
		"# branch.oid " + strings.Repeat("a", 40),
		"# branch.head main",
		rec,
	}, "\x00") + "\x00"
}

// gitWriteFake 은 읽기와 **쓰기를 함께** 격리한다. WithRunner 만 주면 실제 git 이
// 돌아 테스트가 저장소를 바꾼다.
type gitWriteFake struct {
	mu       sync.Mutex
	gitDir   string
	status   string
	identity bool // false 면 preflight 가 identity_missing 으로 막는다
	message  string
	writes   [][]string
	stdins   []string
	writeErr func(argv []string) (core.Output, error)
	// onWrite 는 쓰기 성공 직후에 불린다. 쓰기가 상태를 바꾸는 것을 흉내 낸다.
	onWrite func(f *gitWriteFake, argv []string)
}

func newGitWriteFake(t *testing.T) *gitWriteFake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &gitWriteFake{
		gitDir:   dir,
		status:   gitWriteStatus("a.txt", "M."),
		identity: true,
		message:  "직전 커밋 제목\n\n본문",
	}
}

func (f *gitWriteFake) read(_ context.Context, dir string, args []string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && args[1] == "--show-toplevel":
		return core.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse" && args[1] == "--verify":
		return core.Output{Stdout: strings.Repeat("a", 40) + "\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case args[0] == "status":
		return core.Output{Stdout: f.status}, nil
	case args[0] == "log":
		return core.Output{Stdout: f.message + "\n"}, nil
	case args[0] == "config":
		return core.Output{Stdout: f.configValue(args)}, nil
	}
	return core.Output{}, nil
}

// configValue 는 preflight 가 읽는 네 키만 답한다. 미설정은 빈 문자열이다.
func (f *gitWriteFake) configValue(args []string) string {
	key := args[len(args)-1]
	if !f.identity {
		return ""
	}
	switch key {
	case "user.name":
		return "tester\n"
	case "user.email":
		return "t@example.com\n"
	}
	return ""
}

func (f *gitWriteFake) write(_ context.Context, _ string, args []string, stdin string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, append([]string(nil), args...))
	f.stdins = append(f.stdins, stdin)
	if f.writeErr != nil {
		return f.writeErr(args)
	}
	if f.onWrite != nil {
		f.onWrite(f, args)
	}
	return core.Output{}, nil
}

func (f *gitWriteFake) wrote() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.writes...)
}

// gitWriteServer 는 읽기·쓰기 둘 다 격리된 GitServer 를 세운다. undo 토큰의 시계도
// 주입한다 — TTL 검증이 실제 5초 경과에 의존하면 결정론을 잃는다.
func gitWriteServer(t *testing.T, f *gitWriteFake) (*GitServer, *time.Time) {
	t.Helper()
	at := time.Now()
	store := store.NewStore(
		core.New(core.WithRunner(f.read), core.WithWriteRunner(f.write)),
		store.WithClock(func() time.Time { return at }),
	)
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: store}
	undoNow := at
	s.gitUndo.now = func() time.Time { return undoNow }
	return s, &undoNow
}

// gitWriteRepo 는 요청에 실을 리포 경로다. fake 의 rev-parse 가 요청 dir 을 그대로
// 루트로 답하므로 존재하지 않아도 된다.
const gitWriteRepo = "/work/repo"

// S15 (V30, FR-GIT-71): 쓰기 5개 라우트가 등록돼 있고, 응답에 **실행 후** status 가
// 함께 온다. 폴링 주기를 기다리면 화면이 방금 만든 변경을 보지 못한다.
func TestAPIGitWriteRoutes_ReturnFreshStatus(t *testing.T) {
	cases := []struct {
		path string
		body string
		want []string
	}{
		{"/api/git/stage", `{"repo":"/work/repo","paths":["a.txt"]}`, []string{"add", "--", "a.txt"}},
		{"/api/git/unstage", `{"repo":"/work/repo","paths":["a.txt"]}`, []string{"reset", "-q", "HEAD", "--", "a.txt"}},
		{
			"/api/git/discard",
			`{"repo":"/work/repo","tracked":["a.txt"],"untracked":["n.txt"],"confirm":true}`,
			[]string{"checkout", "-q", "--", "a.txt"},
		},
		{"/api/git/commit", `{"repo":"/work/repo","message":"m"}`, []string{"commit", "--file=-", "--cleanup=strip"}},
		{"/api/git/undo-last", `{"repo":"/work/repo","undoToken":""}`, nil},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			f := newGitWriteFake(t)
			// 쓰기가 상태를 바꾼 것으로 만든다 — 캐시된 값을 주면 이 변화가 보이지
			// 않는다 (Store 의 TTL 은 200ms 이고 테스트의 시계는 멈춰 있다).
			f.onWrite = func(f *gitWriteFake, _ []string) { f.status = gitWriteStatus("b.txt", ".M") }
			s, _ := gitWriteServer(t, f)
			if c.path == "/api/git/undo-last" {
				c.body = `{"repo":"/work/repo","undoToken":"` + gitIssueUndo(t, s, f) + `"}`
			}

			code, out := gitReq(t, s, http.MethodPost, c.path, c.body)
			if code != http.StatusOK {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			if out["requested"] != gitWriteRepo || out["repo"] != gitWriteRepo {
				t.Fatalf("requested/repo = %v / %v", out["requested"], out["repo"])
			}
			if out["ok"] != true || out["partial"] != false {
				t.Fatalf("ok/partial = %v / %v", out["ok"], out["partial"])
			}
			st, ok := out["status"].(map[string]any)
			if !ok {
				t.Fatalf("status = %v", out["status"])
			}
			changes, _ := st["changes"].([]any)
			if len(changes) != 1 {
				t.Fatalf("실행 후 status 가 아니다: %v", st)
			}
			if c.want != nil {
				if got := f.wrote(); len(got) == 0 || fmt.Sprint(got[0]) != fmt.Sprint(c.want) {
					t.Fatalf("argv = %v, want %v", got, c.want)
				}
			}
		})
	}
}

// gitIssueUndo 는 커밋 하나를 만들어 undo 토큰을 발급받는다.
func gitIssueUndo(t *testing.T, s *GitServer, f *gitWriteFake) string {
	t.Helper()
	code, out := gitReq(t, s, http.MethodPost, "/api/git/commit", `{"repo":"/work/repo","message":"m"}`)
	if code != http.StatusOK {
		t.Fatalf("commit = %d, body = %v", code, out)
	}
	tok, _ := out["undoToken"].(string)
	if tok == "" {
		t.Fatalf("undoToken 이 비었다: %v", out)
	}
	f.mu.Lock()
	f.writes, f.stdins = nil, nil
	f.mu.Unlock()
	return tok
}

// S11 (V35, FR-GIT-83): 발급된 토큰은 5초 뒤 만료된다. **만료된 undo 가 실행될 수
// 있어서는 안 된다** — 클라이언트 타이머만으로는 보장할 수 없다.
func TestAPIGitUndoLast_Expires(t *testing.T) {
	f := newGitWriteFake(t)
	s, now := gitWriteServer(t, f)
	tok := gitIssueUndo(t, s, f)

	*now = now.Add(write.UndoTTL + time.Millisecond)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/undo-last", `{"repo":"/work/repo","undoToken":"`+tok+`"}`)
	if code != http.StatusConflict || out["error"] != "undo_expired" {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("만료된 undo 가 실행됐다: %v", got)
	}
}

// S12 (V35, FR-GIT-83): 새 커밋이 이전 토큰을 밀어낸다. 리포별로 하나만 유지한다.
func TestAPIGitUndoLast_NewCommitInvalidates(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := gitWriteServer(t, f)
	first := gitIssueUndo(t, s, f)
	second := gitIssueUndo(t, s, f)
	if first == second {
		t.Fatal("두 커밋이 같은 토큰을 받았다")
	}

	code, out := gitReq(t, s, http.MethodPost, "/api/git/undo-last", `{"repo":"/work/repo","undoToken":"`+first+`"}`)
	if code != http.StatusConflict || out["error"] != "undo_expired" {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	// 새 토큰은 살아 있다.
	code, out = gitReq(t, s, http.MethodPost, "/api/git/undo-last", `{"repo":"/work/repo","undoToken":"`+second+`"}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
}

// S13 (V35): 소비된 토큰은 재사용할 수 없다. 한 번의 커밋에 한 번의 undo 다.
func TestAPIGitUndoLast_ConsumedOnce(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := gitWriteServer(t, f)
	tok := gitIssueUndo(t, s, f)
	body := `{"repo":"/work/repo","undoToken":"` + tok + `"}`

	code, out := gitReq(t, s, http.MethodPost, "/api/git/undo-last", body)
	if code != http.StatusOK {
		t.Fatalf("첫 undo = %d, body = %v", code, out)
	}
	// 응답의 message 로 클라이언트가 입력을 커밋 직전으로 되돌린다 (FR-GIT-82).
	if out["message"] != f.message {
		t.Fatalf("message = %q, want %q", out["message"], f.message)
	}
	want := []string{"reset", "--soft", "HEAD@{1}"}
	if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}

	code, out = gitReq(t, s, http.MethodPost, "/api/git/undo-last", body)
	if code != http.StatusConflict || out["error"] != "undo_expired" {
		t.Fatalf("재사용 = %d, body = %v", code, out)
	}
	if got := f.wrote(); len(got) != 1 {
		t.Fatalf("undo 가 두 번 실행됐다: %v", got)
	}
}

// S14 (V36, FR-GIT-86·88): preflight 가 막으면 409 이고 **커밋이 만들어지지 않는다.**
// 클라이언트만 막으면 `dmctl git commit` 이 우회한다.
func TestAPIGitCommit_PreflightBlocked(t *testing.T) {
	f := newGitWriteFake(t)
	f.identity = false
	s, _ := gitWriteServer(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/commit", `{"repo":"/work/repo","message":"m"}`)
	if code != http.StatusConflict || out["error"] != "preflight_blocked" {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("차단됐는데 커밋이 실행됐다: %v", got)
	}
	pf, ok := out["preflight"].(map[string]any)
	if !ok {
		t.Fatalf("preflight = %v", out["preflight"])
	}
	blocks, _ := pf["blocks"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("blocks = %v", pf["blocks"])
	}
	// 무엇이 왜 막혔고 어떻게 푸는지가 함께 와야 한다 (FR-GIT-88).
	b := blocks[0].(map[string]any)
	if b["code"] != "identity_missing" || b["reason"] == "" || b["fix"] == "" {
		t.Fatalf("block = %v", b)
	}
}

// S16 (V37, FR-GIT-89): `/discard` 는 confirm 없이는 400 이다. 클라이언트만 막으면
// `dmctl git discard` 가 우회한다.
func TestAPIGitDiscard_RequiresConfirm(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := gitWriteServer(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/discard", `{"repo":"/work/repo","tracked":["a.txt"]}`)
	if code != http.StatusBadRequest || out["error"] != "confirmation_required" {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("확인 없이 실행됐다: %v", got)
	}
	if hints := s.Git.Service().Hints(0); len(hints) != 0 {
		t.Fatalf("실행하지 않았는데 hint 가 남았다: %+v", hints)
	}
}

// S16 (V37, FR-GIT-92): confirm 이 있으면 실행하고, recovery hint 가 남는다.
func TestAPIGitDiscard_LeavesHint(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := gitWriteServer(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/discard",
		`{"repo":"/work/repo","tracked":["a.txt"],"untracked":["n.txt"],"confirm":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	hints := s.Git.Service().Hints(0)
	if len(hints) != 1 || hints[0].Action != "discard" {
		t.Fatalf("hints = %+v", hints)
	}
	if fmt.Sprint(hints[0].Targets) != fmt.Sprint([]string{"a.txt", "n.txt"}) {
		t.Fatalf("targets = %v", hints[0].Targets)
	}
}

// S17 (FR-GIT-84): 빈 메시지와 staged 없음은 400 이며 사유가 코드로 구분된다.
// `--allow-empty` 는 M2 범위 밖이다.
func TestAPIGitCommit_RejectsEmptyMessageAndNothingStaged(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		staged  bool
		wantErr string
	}{
		{"빈 메시지", `{"repo":"/work/repo","message":""}`, true, "empty_message"},
		{"공백뿐인 메시지", `{"repo":"/work/repo","message":"  \n "}`, true, "empty_message"},
		{"staged 없음", `{"repo":"/work/repo","message":"m"}`, false, "nothing_staged"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitWriteFake(t)
			if !c.staged {
				f.status = gitWriteStatus("a.txt", ".M")
			}
			s, _ := gitWriteServer(t, f)

			code, out := gitReq(t, s, http.MethodPost, "/api/git/commit", c.body)
			if code != http.StatusBadRequest || out["error"] != c.wantErr {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			if got := f.wrote(); len(got) != 0 {
				t.Fatalf("거부됐는데 실행됐다: %v", got)
			}
		})
	}
}

// S17 (FR-GIT-84): `all:true` 는 staged 가 없어도 통과한다 — `-a` 가 tracked 변경을
// 스스로 담는다.
func TestAPIGitCommit_AllWithoutStaged(t *testing.T) {
	f := newGitWriteFake(t)
	f.status = gitWriteStatus("a.txt", ".M")
	s, _ := gitWriteServer(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/commit", `{"repo":"/work/repo","message":"m","all":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	want := []string{"commit", "--file=-", "--cleanup=strip", "-a"}
	if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
}

// S6 의 서버측 절반 (FR-GIT-77): 메시지는 stdin 으로만 간다. 라우트를 지나는 동안
// argv 로 옮겨지지 않아야 한다.
func TestAPIGitCommit_MessageStaysInStdin(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := gitWriteServer(t, f)
	const msg = "제목\n\n본문 줄"

	code, out := gitReq(t, s, http.MethodPost, "/api/git/commit",
		`{"repo":"/work/repo","message":"제목\n\n본문 줄","signoff":true,"noVerify":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.stdins) != 1 || f.stdins[0] != msg {
		t.Fatalf("stdin = %q", f.stdins)
	}
	for _, a := range f.writes[0] {
		if strings.Contains(a, "제목") || strings.Contains(a, "본문") {
			t.Fatalf("argv 에 메시지가 실렸다: %v", f.writes[0])
		}
	}
	want := []string{"commit", "--file=-", "--cleanup=strip", "--signoff", "--no-verify"}
	if fmt.Sprint(f.writes[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f.writes[0], want)
	}
}

// S4 의 서버측 절반 (FR-GIT-73, §7.1 I2): 실패는 실행 전후 status 를 비교해
// `partial` 과 **무엇이 바뀌었는지**로 보고된다. 조용히 넘기지 않는다.
func TestAPIGitStage_ReportsPartial(t *testing.T) {
	f := newGitWriteFake(t)
	f.writeErr = func(argv []string) (core.Output, error) {
		// 실행은 됐고 실패했다 — git 은 경로별로 처리하므로 앞쪽은 이미 적용됐다.
		f.status = gitWriteStatus("a.txt", "M.") + gitWriteStatus("b.txt", ".M")
		return core.Output{ExitCode: 1, Stderr: "error: pathspec 'b.txt' did not match"}, nil
	}
	f.status = gitWriteStatus("a.txt", ".M")
	s, _ := gitWriteServer(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", `{"repo":"/work/repo","paths":["a.txt","b.txt"]}`)
	if code != http.StatusInternalServerError || out["error"] != "git_failed" {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if out["partial"] != true {
		t.Fatalf("partial = %v, body = %v", out["partial"], out)
	}
	changed, _ := out["changed"].([]any)
	if len(changed) == 0 {
		t.Fatalf("무엇이 바뀌었는지가 없다: %v", out)
	}
}

// FR-GIT-62: 경로 규약을 서버가 지킨다. 절대경로·부모 참조는 400 이며 실행되지 않는다.
func TestAPIGitStage_RejectsUnsafePaths(t *testing.T) {
	for _, body := range []string{
		`{"repo":"/work/repo","paths":[]}`,
		`{"repo":"/work/repo","paths":["/etc/passwd"]}`,
		`{"repo":"/work/repo","paths":["../outside"]}`,
		`{"repo":"relative","paths":["a.txt"]}`,
		`{"paths":["a.txt"]}`,
	} {
		f := newGitWriteFake(t)
		s, _ := gitWriteServer(t, f)
		code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", body)
		if code != http.StatusBadRequest || out["error"] != "bad_request" {
			t.Fatalf("%s → %d, body = %v", body, code, out)
		}
		if got := f.wrote(); len(got) != 0 {
			t.Fatalf("%s 가 실행됐다: %v", body, got)
		}
	}
}

// FR-GIT-60: git 표면이 구성되지 않았으면 503 이고, 다른 동작에는 영향이 없다.
func TestAPIGitWrite_Unavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}}
	for _, path := range []string{
		"/api/git/stage", "/api/git/unstage", "/api/git/discard",
		"/api/git/commit", "/api/git/undo-last",
	} {
		code, out := gitReq(t, s, http.MethodPost, path, `{"repo":"/work/repo"}`)
		if code != http.StatusServiceUnavailable || out["error"] != "git_unavailable" {
			t.Fatalf("%s → %d, body = %v", path, code, out)
		}
	}
}

// 쓰기 라우트는 POST 만 받는다 — GET 으로 저장소가 바뀌면 프리페치가 커밋을 만든다.
func TestAPIGitWrite_PostOnly(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := gitWriteServer(t, f)
	for _, path := range []string{
		"/api/git/stage", "/api/git/unstage", "/api/git/discard", "/api/git/undo-last",
	} {
		code, _ := gitReq(t, s, http.MethodGet, path, "")
		if code == http.StatusOK {
			t.Fatalf("GET %s 가 200 이다", path)
		}
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("GET 이 쓰기를 실행했다: %v", got)
	}
}
