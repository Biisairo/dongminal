package gitapi

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/editorlimit"
	"dongminal/internal/shared/gittest"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-15-1: diff 본문은 편집기 파일 상한(32 MiB)까지 나온다.
//
// **진짜 git 으로 돈다.** 주입 Runner 는 출력 상한을 모르므로, 공용 Service 의 출력
// 상한(1 MiB, FR-GIT-6)이 `git show` 를 잘라 상한 안의 파일이 `too_large` 가 되던
// 결함은 진짜 실행에서만 보인다.
func limitGitServer(t *testing.T) (*GitServer, string) {
	t.Helper()
	s, _ := realGitServer(t)
	return s, gittest.Repo(t)
}

func commitFile(t *testing.T, repo, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	gittest.Run(t, repo, "add", name)
	gittest.Run(t, repo, "commit", "-qm", name)
}

// 두 쪽 모두 상한과 같은 크기면 본문이 온전히 온다.
func TestAPIGitDiffContent_AtEditorLimit(t *testing.T) {
	s, repo := limitGitServer(t)
	commitFile(t, repo, "big.txt", strings.Repeat("a", editorlimit.FileMaxBytes))
	if err := os.WriteFile(filepath.Join(repo, "big.txt"), []byte(strings.Repeat("b", editorlimit.FileMaxBytes)), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/diff-content?repo="+url.QueryEscape(repo)+"&axis=worktree-head&path=big.txt", "")
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	for _, side := range []string{"original", "modified"} {
		m, _ := out[side].(map[string]any)
		content, _ := m["content"].(string)
		if m["kind"] != query.DiffKindText || len(content) != editorlimit.FileMaxBytes {
			t.Fatalf("%s kind=%v len=%d want text %d", side, m["kind"], len(content), editorlimit.FileMaxBytes)
		}
	}
}

// 한 바이트 넘으면 `too_large` 이고 본문이 없다.
func TestAPIGitDiffContent_OverEditorLimit(t *testing.T) {
	s, repo := limitGitServer(t)
	commitFile(t, repo, "big.txt", strings.Repeat("a", editorlimit.FileMaxBytes+1))
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/diff-content?repo="+url.QueryEscape(repo)+"&axis=worktree-head&path=big.txt", "")
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	m, _ := out["original"].(map[string]any)
	if m["kind"] != query.DiffKindTooLarge || m["content"] != nil && m["content"] != "" {
		t.Fatalf("original=%v want too_large", m["kind"])
	}
}

// HEAD 판을 편집기로 여는 경로(FR-GIT-274)도 같은 상한이다. 1 MiB 를 넘는 파일로
// 공용 Service 의 출력 상한에서 벗어났는지를 본다.
func TestAPIGitFileHead_OverGitOutputCap(t *testing.T) {
	s, repo := limitGitServer(t)
	size := core.DefaultMaxOutput + 1
	commitFile(t, repo, "mid.txt", strings.Repeat("m", size))
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/file-head?repo="+url.QueryEscape(repo)+"&path=mid.txt", "")
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	p, _ := out["openPath"].(string)
	st, err := os.Stat(p)
	if err != nil || st.Size() != int64(size) {
		t.Fatalf("열 사본=%q err=%v want %d 바이트", p, err, size)
	}
}
