package gitapi

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// FR-GIT-218 (V95) — Console 탭이 읽는 실행 기록. 기록은 이미 Recorder 에 있고,
// 여기서 확인하는 것은 **무엇을 내보내느냐** 다: 그 리포의 것만, 자격증명 없이.

type gitRecFake struct{ root string }

func newGitRecFake(t *testing.T) *gitRecFake {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &gitRecFake{root: root}
}

func (f *gitRecFake) runner(_ context.Context, _ string, args []string) (core.Output, error) {
	if args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel" {
		return core.Output{Stdout: f.root + "\n"}, nil
	}
	if args[0] == "boom" {
		return core.Output{ExitCode: 1, Stderr: "fatal: https://u:tok@host/x 로 붙지 못했다\n"}, nil
	}
	return core.Output{}, nil
}

func gitRecServer(t *testing.T, f *gitRecFake) (*GitServer, *core.Service) {
	t.Helper()
	svc := core.New(core.WithRunner(f.runner))
	return &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: store.NewStore(svc)}, svc
}

func TestGitRecordsRoute_Registered(t *testing.T) {
	found := false
	for _, rt := range routes {
		if rt.method == http.MethodGet && rt.match("/api/git/records") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("GET /api/git/records 가 gitapi.routes 에 없다")
	}
}

func TestGitRecords_Unavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	code, out := gitReq(t, s, http.MethodGet, "/api/git/records?repo=/r", "")
	if code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", code)
	}
	if out["error"] != gitErrUnavailable {
		t.Fatalf("error = %v", out["error"])
	}
}

// 창은 리포 하나에 매인다 — 다른 리포의 실행이 섞이면 이력이 아니라 잡음이다.
// 거르는 기준은 요청값이 아니라 rev-parse 로 확정한 루트다 (FR-GIT-62).
func TestGitRecords_FiltersByResolvedRoot(t *testing.T) {
	f := newGitRecFake(t)
	s, svc := gitRecServer(t, f)
	other := t.TempDir()

	svc.Exec(context.Background(), f.root, "status")
	svc.Exec(context.Background(), other, "status")

	sub := filepath.Join(f.root, "sub")
	code, out := gitReq(t, s, http.MethodGet, "/api/git/records?repo="+sub, "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	recs, _ := out["records"].([]any)
	for _, r := range recs {
		m := r.(map[string]any)
		if m["cwd"] != f.root {
			t.Fatalf("다른 리포의 기록이 섞였다: %v", m["cwd"])
		}
	}
	if len(recs) == 0 {
		t.Fatal("그 리포의 기록이 하나도 오지 않았다")
	}
	// 해석된 루트를 되돌려 클라이언트가 짝을 맞출 수 있어야 한다.
	if out["repo"] != f.root {
		t.Fatalf("repo = %v, want %v", out["repo"], f.root)
	}
	req, _ := out["requested"].(map[string]any)
	if req == nil || req["repo"] != sub {
		t.Fatalf("requested = %v, want repo=%v", req, sub)
	}
}

// 최신이 위다 — 이력을 볼 때 사람이 먼저 찾는 것은 방금 한 일이다.
func TestGitRecords_NewestFirst(t *testing.T) {
	f := newGitRecFake(t)
	s, svc := gitRecServer(t, f)
	svc.Exec(context.Background(), f.root, "status")
	svc.Exec(context.Background(), f.root, "diff")

	_, out := gitReq(t, s, http.MethodGet, "/api/git/records?repo="+f.root, "")
	recs, _ := out["records"].([]any)
	if len(recs) < 2 {
		t.Fatalf("기록이 %d 개다", len(recs))
	}
	// 루트 해석(rev-parse)도 기록에 남는다 — Console 자신의 조회다. 순서만 본다.
	var seen []string
	for _, r := range recs {
		argv := r.(map[string]any)["argv"].([]any)
		switch argv[0] {
		case "status", "diff":
			seen = append(seen, argv[0].(string))
		}
	}
	if len(seen) != 2 || seen[0] != "diff" || seen[1] != "status" {
		t.Fatalf("최신이 위가 아니다: %v", seen)
	}
}

// 쓰기 여부가 응답까지 실려야 한다 — 클라이언트는 writeCommands 를 모른다
// (FR-GIT-218).
func TestGitRecords_CarriesWriteFlag(t *testing.T) {
	f := newGitRecFake(t)
	s, svc := gitRecServer(t, f)
	svc.Exec(context.Background(), f.root, "status")
	svc.ExecWrite(context.Background(), f.root, core.WriteSpec{Argv: []string{"add", "a.txt"}})

	_, out := gitReq(t, s, http.MethodGet, "/api/git/records?repo="+f.root, "")
	recs, _ := out["records"].([]any)
	got := map[string]bool{}
	for _, r := range recs {
		m := r.(map[string]any)
		argv := m["argv"].([]any)
		got[argv[0].(string)], _ = m["write"].(bool)
	}
	if !got["add"] {
		t.Fatalf("add 가 쓰기로 실리지 않았다: %v", got)
	}
	if got["status"] {
		t.Fatalf("status 가 쓰기로 실렸다: %v", got)
	}
}

// FR-GIT-104 · 보안 기준 S.1·S.2 — 응답 본문에 자격증명이 없다.
func TestGitRecords_RedactsCredentials(t *testing.T) {
	f := newGitRecFake(t)
	s, svc := gitRecServer(t, f)
	svc.Exec(context.Background(), f.root, "boom", "https://u:tok@host/x")

	code, out := gitReq(t, s, http.MethodGet, "/api/git/records?repo="+f.root, "")
	if code != http.StatusOK {
		t.Fatalf("code = %d", code)
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if strings.Contains(body, "tok@host") {
		t.Fatalf("자격증명이 응답에 남았다: %s", body)
	}
	if !strings.Contains(body, "***@host") {
		t.Fatalf("가린 자리가 보이지 않는다: %s", body)
	}
}

// n 은 상한을 새로 발명하지 않는다 — 링 버퍼(FR-GIT-6)가 이미 정한다.
func TestGitRecords_LimitParam(t *testing.T) {
	f := newGitRecFake(t)
	s, svc := gitRecServer(t, f)
	for i := 0; i < 5; i++ {
		svc.Exec(context.Background(), f.root, "status")
	}
	_, out := gitReq(t, s, http.MethodGet, "/api/git/records?repo="+f.root+"&n=2", "")
	if recs, _ := out["records"].([]any); len(recs) != 2 {
		t.Fatalf("records = %d, want 2", len(recs))
	}
	code, _ := gitReq(t, s, http.MethodGet, "/api/git/records?repo="+f.root+"&n=-1", "")
	if code != http.StatusBadRequest {
		t.Fatalf("음수 n → %d, want 400", code)
	}
}

// FR-GIT-223 (V100) — 핀 순서 재배치. 핀 목록은 서버가 권위로 쓰므로(O1) 재배치도
// 서버를 지난다.

func TestGitReorderRoute_Registered(t *testing.T) {
	found := false
	for _, rt := range routes {
		if rt.method == http.MethodPost && rt.match("/api/git/repos/reorder") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("POST /api/git/repos/reorder 가 gitapi.routes 에 없다")
	}
}

func gitPinServer(t *testing.T) *GitServer {
	t.Helper()
	f := newGitRecFake(t)
	s, _ := gitRecServer(t, f)
	return s
}

func seedPins(t *testing.T, s *GitServer, pins ...string) {
	t.Helper()
	if _, err := s.gitPinsMutate(func([]string) []string { return pins }); err != nil {
		t.Fatal(err)
	}
}

func pinsOf(t *testing.T, out map[string]any) []string {
	t.Helper()
	raw, _ := out["pinned"].([]any)
	got := make([]string, 0, len(raw))
	for _, x := range raw {
		got = append(got, x.(string))
	}
	return got
}

func TestGitReorder_MovesBeforeAndAfter(t *testing.T) {
	s := gitPinServer(t)
	seedPins(t, s, absA, absB, absC)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/reorder",
		`{"src":`+qC+`,"target":`+qA+`,"before":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if got := strings.Join(pinsOf(t, out), ","); got != "/c,/a,/b" {
		t.Fatalf("pinned = %q", got)
	}

	_, out = gitReq(t, s, http.MethodPost, "/api/git/repos/reorder",
		`{"src":`+qC+`,"target":`+qB+`,"before":false}`)
	if got := strings.Join(pinsOf(t, out), ","); got != "/a,/b,/c" {
		t.Fatalf("pinned = %q", got)
	}
}

// 끌어다 놓은 곳이 사라졌다고 조작을 통째로 잃지 않는다.
func TestGitReorder_MissingTargetGoesLast(t *testing.T) {
	s := gitPinServer(t)
	seedPins(t, s, absA, absB, absC)
	_, out := gitReq(t, s, http.MethodPost, "/api/git/repos/reorder",
		`{"src":`+qA+`,"target":`+qGone+`,"before":true}`)
	if got := strings.Join(pinsOf(t, out), ","); got != "/b,/c,/a" {
		t.Fatalf("pinned = %q", got)
	}
}

func TestGitReorder_UnknownSrcIsNoop(t *testing.T) {
	s := gitPinServer(t)
	seedPins(t, s, absA, absB)
	_, out := gitReq(t, s, http.MethodPost, "/api/git/repos/reorder",
		`{"src":"/nope","target":`+qA+`,"before":true}`)
	if got := strings.Join(pinsOf(t, out), ","); got != "/a,/b" {
		t.Fatalf("pinned = %q", got)
	}
	code, _ := gitReq(t, s, http.MethodPost, "/api/git/repos/reorder", `{"src":"","target":`+qA+`}`)
	if code != http.StatusBadRequest {
		t.Fatalf("빈 src → %d, want 400", code)
	}
}

// git 하위의 다른 키를 건드리지 않는다 — 순서 하나 바꾸다 draft 를 잃으면 안 된다.
func TestGitReorder_PreservesOtherGitKeys(t *testing.T) {
	s := gitPinServer(t)
	if _, err := s.Work.Save([]byte(`{"git":{"pinned":[`+qA+`,`+qB+`],"drafts":{`+qA+`:"keep"}}}`), ""); err != nil {
		t.Fatal(err)
	}
	gitReq(t, s, http.MethodPost, "/api/git/repos/reorder", `{"src":`+qB+`,"target":`+qA+`,"before":true}`)
	raw, _ := s.Work.Snapshot()
	if !strings.Contains(string(raw), `"keep"`) {
		t.Fatalf("drafts 가 사라졌다: %s", raw)
	}
}
