package gitapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// 묶음 G 서버측 — /api/git/{hunks,patch} (GIT_ACTIONS_SRS §3.7, 검증 V204·V205·V206).
//
// **서버가 마지막 방어선이다.** 클라이언트가 만든 패치를 받는 경로가 없다는 것을
// 여기서 못박는다 — 요청 구조체에 그런 필드가 없고, 본문에 실려 와도 실행되지
// 않는다 (D6).

// gitPatchDiff 는 hunk 두 개짜리 unified diff 다. 실제 git 의 출력 형태 그대로다.
const gitPatchDiff = "diff --git a/f.txt b/f.txt\n" +
	"index 1111111..2222222 100644\n" +
	"--- a/f.txt\n" +
	"+++ b/f.txt\n" +
	"@@ -2,7 +2,7 @@ ctx\n" +
	" line2\n line3\n line4\n-line5\n+FIVE\n line6\n line7\n line8\n" +
	"@@ -12,7 +12,7 @@ ctx\n" +
	" line12\n line13\n line14\n-line15\n+FIFTEEN\n line16\n line17\n line18\n"

// gitPatchFake 은 읽기·쓰기를 함께 격리하고 diff 출력을 고정한다. 실제 git 이
// 돌면 테스트가 저장소를 바꾼다.
type gitPatchFake struct {
	mu     sync.Mutex
	gitDir string
	diff   string
	writes [][]string
	stdins []string
}

func newGitPatchFake(t *testing.T) *gitPatchFake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &gitPatchFake{gitDir: dir, diff: gitPatchDiff}
}

func (f *gitPatchFake) read(_ context.Context, dir string, args []string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		return core.Output{Stdout: dir + "\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case args[0] == "status":
		return core.Output{Stdout: gitWriteStatus("f.txt", "M.")}, nil
	case args[0] == "diff":
		return core.Output{Stdout: f.diff}, nil
	}
	return core.Output{}, nil
}

func (f *gitPatchFake) write(_ context.Context, _ string, args []string, stdin string) (core.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, append([]string(nil), args...))
	f.stdins = append(f.stdins, stdin)
	return core.Output{}, nil
}

func gitPatchServer(t *testing.T, f *gitPatchFake) *GitServer {
	t.Helper()
	at := time.Now()
	st := store.NewStore(
		core.New(core.WithRunner(f.read), core.WithWriteRunner(f.write)),
		store.WithClock(func() time.Time { return at }),
	)
	return &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: st}
}

// gitPatchDiffID 는 fake 가 주는 diff 의 관측 식별자다. /api/git/hunks 로 받는다 —
// 값을 테스트가 계산하면 서버와 두 벌이 된다.
func gitPatchDiffID(t *testing.T, s *GitServer) string {
	t.Helper()
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/hunks?repo=/work/repo&axis=worktree-index&path=f.txt", "")
	if code != http.StatusOK {
		t.Fatalf("GET /api/git/hunks = %d: %v", code, out)
	}
	id, _ := out["diffId"].(string)
	if id == "" {
		t.Fatalf("diffId 가 없다: %v", out)
	}
	return id
}

// P1 (V204): 요청 구조체에 패치·본문 필드가 없다. 문자열 필드는 열거된 것뿐이며
// 그 어느 것도 패치를 담을 수 없다.
func TestGitPatchReq_HasNoPatchField(t *testing.T) {
	allowed := map[string]bool{"Repo": true, "Axis": true, "Path": true, "Op": true, "DiffID": true}
	rt := reflect.TypeOf(gitPatchReq{})
	for i := range rt.NumField() {
		f := rt.Field(i)
		switch f.Type.Kind() {
		case reflect.String:
			if !allowed[f.Name] {
				t.Fatalf("gitPatchReq.%s 는 허용되지 않은 문자열 필드다 — 패치를 담을 수 있다 (D6)", f.Name)
			}
		case reflect.Int, reflect.Bool:
			// hunk 번호·줄 범위·confirm. 패치를 담을 수 없다.
		default:
			t.Fatalf("gitPatchReq.%s 의 종류(%v)는 받지 않는다", f.Name, f.Type.Kind())
		}
	}
}

// P2 (V204): 본문에 패치를 실어 보내도 실행되지 않는다. 서버는 자기가 만든 diff 로
// 패치를 짓는다 — 클라이언트가 보낸 문자열은 stdin 에 닿지 않는다.
func TestGitPatch_IgnoresClientSuppliedPatch(t *testing.T) {
	f := newGitPatchFake(t)
	s := gitPatchServer(t, f)
	id := gitPatchDiffID(t, s)

	hostile := "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-x\n+pwned\n"
	body := `{"repo":` + qWorkRepo + `,"axis":"worktree-index","path":"f.txt","op":"stage",` +
		`"hunk":0,"diffId":"` + id + `","patch":` + quoteJSON(hostile) +
		`,"body":` + quoteJSON(hostile) + `,"content":` + quoteJSON(hostile) + `}`
	code, out := gitReq(t, s, http.MethodPost, "/api/git/patch", body)
	if code != http.StatusOK {
		t.Fatalf("POST /api/git/patch = %d: %v", code, out)
	}
	if len(f.stdins) != 1 {
		t.Fatalf("쓰기 횟수 = %d, 기대 1: %v", len(f.stdins), f.writes)
	}
	if strings.Contains(f.stdins[0], "pwned") || strings.Contains(f.stdins[0], "passwd") {
		t.Fatalf("클라이언트가 보낸 패치가 실행됐다:\n%s", f.stdins[0])
	}
	// 서버가 만든 패치다 — 자기 diff 의 첫 hunk 만 담는다.
	if !strings.Contains(f.stdins[0], "+FIVE") {
		t.Fatalf("서버가 만든 패치가 아니다:\n%s", f.stdins[0])
	}
	if strings.Contains(f.stdins[0], "+FIFTEEN") {
		t.Fatalf("고르지 않은 hunk 가 패치에 들었다:\n%s", f.stdins[0])
	}
	if got := f.writes[0]; got[0] != "apply" {
		t.Fatalf("argv = %v, 기대 apply", got)
	}
}

// P3 (V205): 관측이 바뀌었으면 409 로 거부하고 git 을 돌리지 않는다.
func TestGitPatch_RejectsStaleObservation(t *testing.T) {
	f := newGitPatchFake(t)
	s := gitPatchServer(t, f)
	body := `{"repo":` + qWorkRepo + `,"axis":"worktree-index","path":"f.txt","op":"stage",` +
		`"hunk":0,"diffId":"낡은값"}`
	code, out := gitReq(t, s, http.MethodPost, "/api/git/patch", body)
	if code != http.StatusConflict {
		t.Fatalf("POST /api/git/patch = %d, 기대 409: %v", code, out)
	}
	if out["error"] != gitErrStaleObservation {
		t.Fatalf("error = %v, 기대 %q", out["error"], gitErrStaleObservation)
	}
	if len(f.writes) != 0 {
		t.Fatalf("거부된 요청이 git 을 돌렸다: %v", f.writes)
	}
}

// P4 (V206): revert 는 파괴적이다 — confirm:true 없이 실행되지 않는다.
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.
func TestGitPatch_RevertRequiresConfirm(t *testing.T) {
	f := newGitPatchFake(t)
	s := gitPatchServer(t, f)
	id := gitPatchDiffID(t, s)
	body := `{"repo":` + qWorkRepo + `,"axis":"worktree-index","path":"f.txt","op":"revert",` +
		`"hunk":0,"diffId":"` + id + `"}`
	code, out := gitReq(t, s, http.MethodPost, "/api/git/patch", body)
	if code != http.StatusBadRequest {
		t.Fatalf("confirm 없는 revert = %d, 기대 400: %v", code, out)
	}
	if out["error"] != gitErrConfirmRequired {
		t.Fatalf("error = %v, 기대 %q", out["error"], gitErrConfirmRequired)
	}
	if len(f.writes) != 0 {
		t.Fatalf("확인 없는 요청이 git 을 돌렸다: %v", f.writes)
	}
	// confirm 을 주면 실행된다. 방향은 -R 이고 --cached 가 아니다 — 워킹 트리다.
	code, out = gitReq(t, s, http.MethodPost, "/api/git/patch", strings.TrimSuffix(body, "}")+`,"confirm":true}`)
	if code != http.StatusOK {
		t.Fatalf("confirm 있는 revert = %d: %v", code, out)
	}
	if len(f.writes) != 1 {
		t.Fatalf("쓰기 횟수 = %d, 기대 1", len(f.writes))
	}
	argv := strings.Join(f.writes[0], " ")
	if !strings.Contains(argv, "-R") || strings.Contains(argv, "--cached") {
		t.Fatalf("revert argv = %q — 워킹 트리를 되돌리는 형태가 아니다", argv)
	}
}

// P5 (V204): hunks 는 읽기다. 서버가 만든 경계와 관측 식별자를 함께 준다.
func TestGitHunks_ReturnsBoundariesAndID(t *testing.T) {
	f := newGitPatchFake(t)
	s := gitPatchServer(t, f)
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/hunks?repo=/work/repo&axis=worktree-index&path=f.txt", "")
	if code != http.StatusOK {
		t.Fatalf("GET /api/git/hunks = %d: %v", code, out)
	}
	hs, _ := out["hunks"].([]any)
	if len(hs) != 2 {
		t.Fatalf("hunk 수 = %d, 기대 2: %v", len(hs), out)
	}
	h0, _ := hs[0].(map[string]any)
	if h0["oldStart"] != float64(2) {
		t.Fatalf("hunk[0].oldStart = %v, 기대 2", h0["oldStart"])
	}
	lines, _ := h0["lines"].([]any)
	if len(lines) != 8 {
		t.Fatalf("hunk[0].lines 수 = %d, 기대 8", len(lines))
	}
	// requested 는 요청값 그대로다 (FR-GIT-16·54) — 응답이 뒤바뀌어도 알아챈다.
	req, _ := out["requested"].(map[string]any)
	if req["axis"] != "worktree-index" || req["path"] != "f.txt" {
		t.Fatalf("requested = %v", req)
	}
}

// P6 (V204): 모르는 축·op 는 400 이고 git 을 돌리지 않는다.
func TestGitPatch_RejectsBadAxisAndOp(t *testing.T) {
	f := newGitPatchFake(t)
	s := gitPatchServer(t, f)
	id := gitPatchDiffID(t, s)
	bodies := []string{
		`{"repo":` + qWorkRepo + `,"axis":"index-head","path":"f.txt","op":"stage","hunk":0,"diffId":"` + id + `"}`,
		`{"repo":` + qWorkRepo + `,"axis":"worktree-index","path":"f.txt","op":"nuke","hunk":0,"diffId":"` + id + `"}`,
		`{"repo":` + qWorkRepo + `,"axis":"worktree-index","path":"../x","op":"stage","hunk":0,"diffId":"` + id + `"}`,
	}
	for _, b := range bodies {
		code, out := gitReq(t, s, http.MethodPost, "/api/git/patch", b)
		if code != http.StatusBadRequest {
			t.Fatalf("%s = %d, 기대 400: %v", b, code, out)
		}
	}
	if len(f.writes) != 0 {
		t.Fatalf("거부된 요청이 git 을 돌렸다: %v", f.writes)
	}
}

// quoteJSON 은 문자열 하나를 JSON 리터럴로 만든다.
func quoteJSON(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
