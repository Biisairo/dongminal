package gitapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// `git init` 종단 (REPO_TAB_UNIFY_SRS FR-RTU-27~29).
//
// **실제 git 을 쓴다.** 이 종단이 하는 일의 절반은 "정말 저장소가 됐는가" 이고,
// 가짜 러너로는 그 절반을 잴 수 없다 — 그러면 이 시험은 argv 만 확인하는 것이 된다.

func realGitServer(t *testing.T) (*GitServer, *fakeWorkspaceStore) {
	t.Helper()
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	// **실제 git 으로 갈아 끼운다.** 이 종단이 하는 일의 절반이 "정말 저장소가
	// 됐는가" 이므로 가짜 러너로는 잴 수 없다 (worktree 시험과 같은 판단).
	s.Git = store.NewStore(core.New())
	return s, ws
}

// V-RTU-27: 이미 저장소면 409 `exists`, 상대경로면 400.
func TestGitInit_RejectsExistingAndRelative(t *testing.T) {
	s, _ := realGitServer(t)
	dir := t.TempDir()

	code, out := gitReq(t, s, http.MethodPost, "/api/git/init", `{"path":"relative/path"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("상대경로 code=%d body=%v", code, out)
	}

	if code, out := gitReq(t, s, http.MethodPost, "/api/git/init",
		mustJSON(map[string]string{"path": dir})); code != http.StatusOK {
		t.Fatalf("첫 init code=%d body=%v", code, out)
	}
	code, out = gitReq(t, s, http.MethodPost, "/api/git/init",
		mustJSON(map[string]string{"path": dir}))
	if code != http.StatusConflict {
		t.Fatalf("두 번째 init code=%d body=%v (409 exists 여야 한다)", code, out)
	}
	if out["error"] != "exists" {
		t.Fatalf("error=%v, want exists", out["error"])
	}
}

// V-RTU-26: 성공하면 저장소가 서고 **핀에도 더해진다** (FR-RTU-27).
func TestGitInit_CreatesRepoAndPins(t *testing.T) {
	s, _ := realGitServer(t)
	dir := t.TempDir()

	code, out := gitReq(t, s, http.MethodPost, "/api/git/init",
		mustJSON(map[string]string{"path": dir}))
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	// 이 표면의 성공 규약 (FR-GIT-73) — 클라이언트의 `post()` 가 이 필드를 본다.
	if out["ok"] != true {
		t.Fatalf("ok=%v, want true — 없으면 화면이 실패로 읽는다", out["ok"])
	}
	// 진짜 저장소가 됐는가 — `.git` 이 있어야 한다.
	if fi, err := os.Stat(filepath.Join(dir, ".git")); err != nil || !fi.IsDir() {
		t.Fatalf(".git 이 없다: %v", err)
	}
	// 연동이 Editor 행까지 함께 만든다 (FR-EDT-31).
	pinned, _ := out["pinned"].([]any)
	editors, _ := out["editors"].([]any)
	if len(pinned) != 1 || len(editors) != 1 {
		t.Fatalf("pinned=%v editors=%v — 둘 다 한 항목이어야 한다", pinned, editors)
	}
}

// V-RTU-26 의 나머지 절반: **캐시를 무효화한다** (FR-RTU-28 / D-RTU-13).
//
// `RepoRoot` 는 실패도 2초 캐시한다. init 이 그것을 지우지 않으면 방금 만든
// 저장소가 그동안 없는 것으로 보이고, 사용자는 init 이 실패했다고 읽는다.
func TestGitInit_InvalidatesRootCache(t *testing.T) {
	s, _ := realGitServer(t)
	dir := t.TempDir()

	// 먼저 물어 **실패를 캐시에 남긴다** — 화면이 "저장소가 아닙니다" 를 그리는
	// 그 호출이다.
	if _, err := s.Git.RepoRoot(t.Context(), dir); err == nil {
		t.Fatal("아직 저장소가 아닌데 RepoRoot 가 성공했다")
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/init",
		mustJSON(map[string]string{"path": dir})); code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	// 무효화가 없으면 여기서 **캐시된 실패**가 그대로 돌아온다.
	root, err := s.Git.RepoRoot(t.Context(), dir)
	if err != nil {
		t.Fatalf("init 직후 RepoRoot 가 실패했다 (캐시 무효화 누락): %v", err)
	}
	// git 이 준 값이 진실이다 — 심볼릭 링크를 정규화하지 않는다는 것이
	// `core.RepoRoot` 의 규약이므로(그 주석), macOS 의 `/var` 는 `/private/var`
	// 로 돌아온다. 기대값도 같은 해석을 지나야 한다.
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	if root != want {
		t.Fatalf("root=%q, want %q", root, want)
	}
}

// 없는 폴더와 파일은 거부한다 — 그대로 넘기면 git 이 자리를 만들어 버린다.
func TestGitInit_RejectsMissingAndFile(t *testing.T) {
	s, _ := realGitServer(t)
	base := t.TempDir()

	missing := filepath.Join(base, "nope")
	if code, _ := gitReq(t, s, http.MethodPost, "/api/git/init",
		mustJSON(map[string]string{"path": missing})); code != http.StatusBadRequest {
		t.Fatalf("없는 폴더 code=%d", code)
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("거부했는데 자리가 만들어졌다")
	}

	file := filepath.Join(base, "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if code, _ := gitReq(t, s, http.MethodPost, "/api/git/init",
		mustJSON(map[string]string{"path": file})); code != http.StatusBadRequest {
		t.Fatalf("파일 code=%d", code)
	}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
