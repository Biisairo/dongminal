package gitapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
	"net/url"
)

// 묶음 F 서버측 — /api/git/diff-content (GIT_SRS §3.6 FR-GIT-44~48·54·62, 검증 V10).

// gitDiffFake 은 blob 을 rev 로 들고 있는 Runner 다. 리포 루트는 requested 와 다른
// 값으로 답한다 — 응답의 repo 와 requested.repo 가 섞이지 않는지 봐야 한다.
type gitDiffFake struct {
	root   string
	gitDir string
	blobs  map[string]string
}

func newGitDiffFake(t *testing.T) *gitDiffFake {
	t.Helper()
	gitDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(gitDir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &gitDiffFake{root: root, gitDir: gitDir, blobs: map[string]string{}}
}

func (f *gitDiffFake) runner(_ context.Context, _ string, args []string) (core.Output, error) {
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		return core.Output{Stdout: f.root + "\n"}, nil
	case args[0] == "rev-parse":
		return core.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	}
	rev := args[len(args)-1]
	body, ok := f.blobs[rev]
	if !ok {
		return core.Output{ExitCode: 128, Stderr: "fatal: path 'x' does not exist in 'HEAD'\n"}, nil
	}
	if args[0] == "cat-file" {
		return core.Output{Stdout: strconv.Itoa(len(body)) + "\n"}, nil
	}
	return core.Output{Stdout: body}, nil
}

func gitDiffServer(t *testing.T, f *gitDiffFake) *GitServer {
	t.Helper()
	store := store.NewStore(core.New(core.WithRunner(f.runner)))
	return &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: store}
}

// G10 (FR-GIT-54): requested 는 클라이언트가 보낸 값 그대로다 — stale 가드의 서버측
// 절반이며, 해석된 루트가 그 자리를 대신하면 클라이언트는 짝을 맞출 수 없다.
func TestAPIGitDiffContent_EchoesRequested(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["HEAD:old.txt"] = "old\n"
	f.blobs[":new.txt"] = "new\n"
	s := gitDiffServer(t, f)

	sub := filepath.Join(f.root, "sub")
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/diff-content?repo="+sub+"&axis=index-head&path=new.txt&origPath=old.txt", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	req, ok := out["requested"].(map[string]any)
	if !ok {
		t.Fatalf("requested 가 없다: %v", out)
	}
	want := map[string]any{"repo": sub, "axis": "index-head", "path": "new.txt", "origPath": "old.txt"}
	for k, v := range want {
		if req[k] != v {
			t.Fatalf("requested[%q] = %v, want %v", k, req[k], v)
		}
	}
	// 해석된 루트는 별도 필드다.
	if out["repo"] != f.root {
		t.Fatalf("repo = %v, want %v", out["repo"], f.root)
	}
	orig, _ := out["original"].(map[string]any)
	mod, _ := out["modified"].(map[string]any)
	if orig["kind"] != "text" || orig["content"] != "old\n" {
		t.Fatalf("original = %v", orig)
	}
	if mod["kind"] != "text" || mod["content"] != "new\n" {
		t.Fatalf("modified = %v", mod)
	}
}

// origPath 를 보내지 않으면 requested.origPath 는 비고, 해석된 origPath 는 path 다.
func TestAPIGitDiffContent_OrigPathDefaultsToPath(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["HEAD:a.txt"] = "head\n"
	f.blobs[":a.txt"] = "index\n"
	s := gitDiffServer(t, f)

	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/diff-content?repo="+f.root+"&axis=index-head&path=a.txt", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	req := out["requested"].(map[string]any)
	if req["origPath"] != "" {
		t.Fatalf("requested.origPath = %v, want \"\"", req["origPath"])
	}
	if out["origPath"] != "a.txt" {
		t.Fatalf("origPath = %v, want a.txt", out["origPath"])
	}
}

// 워킹 트리 쪽은 파일시스템이 진실이다. 추가된 파일은 note 까지 실린다 (FR-GIT-45).
func TestAPIGitDiffContent_WorktreeSideAndNote(t *testing.T) {
	f := newGitDiffFake(t)
	if err := os.WriteFile(filepath.Join(f.root, "added.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := gitDiffServer(t, f)

	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/diff-content?repo="+f.root+"&axis=worktree-index&path=added.txt", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	orig := out["original"].(map[string]any)
	mod := out["modified"].(map[string]any)
	if orig["kind"] != "absent" || mod["kind"] != "text" || mod["content"] != "hi\n" {
		t.Fatalf("original = %v, modified = %v", orig, mod)
	}
	if note, _ := out["note"].(string); note == "" {
		t.Fatalf("추가된 파일인데 note 가 없다: %v", out)
	}
}

// 잘못된 요청은 400 이고 종류를 구분할 수 있다 (2단계 §5.1). 500 으로 뭉개면
// 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
func TestAPIGitDiffContent_Rejects(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs[":a.txt"] = "x\n"
	s := gitDiffServer(t, f)
	base := "/api/git/diff-content?repo=" + f.root
	for _, tc := range []struct {
		name  string
		query string
		code  int
		err   string
	}{
		{"repo 누락", "/api/git/diff-content?axis=index-head&path=a.txt", http.StatusBadRequest, "bad_request"},
		{"축 누락", base + "&path=a.txt", http.StatusBadRequest, "bad_request"},
		{"모르는 축", base + "&axis=bogus-axis&path=a.txt", http.StatusBadRequest, "bad_request"},
		// 커밋 축은 리비전이 필수다 — 빈 oid 는 `:<path>` 가 되어 index 를 가리킨다.
		{"커밋 축 oid 누락", base + "&axis=commit-parent&path=a.txt", http.StatusBadRequest, "bad_request"},
		{"경로 누락", base + "&axis=index-head", http.StatusBadRequest, "bad_request"},
		{"부모 참조", base + "&axis=index-head&path=../secret", http.StatusBadRequest, "bad_request"},
		{"절대경로", base + "&axis=index-head&path=/etc/passwd", http.StatusBadRequest, "bad_request"},
		{"origPath 부모 참조", base + "&axis=index-head&path=a.txt&origPath=../secret", http.StatusBadRequest, "bad_request"},
		{"양쪽 없음", base + "&axis=index-head&path=nowhere.txt", http.StatusNotFound, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, out := gitReq(t, s, http.MethodGet, tc.query, "")
			if code != tc.code || out["error"] != tc.err {
				t.Fatalf("code = %d, error = %v; want %d, %q", code, out["error"], tc.code, tc.err)
			}
		})
	}
}

// git 표면이 구성되지 않으면 503 이고 다른 동작에는 영향이 없다.
func TestAPIGitDiffContent_Unavailable(t *testing.T) {
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}}
	code, out := gitReq(t, s, http.MethodGet, "/api/git/diff-content?repo="+url.QueryEscape(absR)+"&axis=index-head&path=a.txt", "")
	if code != http.StatusServiceUnavailable || out["error"] != "git_unavailable" {
		t.Fatalf("code = %d, body = %v", code, out)
	}
}

// 라우트가 표에 등록돼 있어야 한다 — UI 는 이 표면 위에만 선다 (FR-GIT-61).
func TestAPIGitDiffContent_RouteRegistered(t *testing.T) {
	found := false
	for _, rt := range routes {
		if rt.method == http.MethodGet && rt.match("/api/git/diff-content") {
			found = true
		}
	}
	if !found {
		t.Fatal("GET /api/git/diff-content 라우트가 없다")
	}
}
