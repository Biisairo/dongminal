package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"
)

// EDITOR_LIVE_RELOAD_SRS FR-ELR-51 (V-ELR-24) — 감시 등록 종단.

func watchReq(t *testing.T, s *Server, body any) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return fsReq(t, s, http.MethodPut, "/api/fs/watch", string(b))
}

func watchingOf(t *testing.T, out map[string]any) []string {
	t.Helper()
	raw, ok := out["watching"].([]any)
	if !ok {
		t.Fatalf("watching 이 없다: %v", out)
	}
	got := make([]string, 0, len(raw))
	for _, v := range raw {
		got = append(got, v.(string))
	}
	sort.Strings(got)
	return got
}

func TestFSWatch_RegistersValidDirsAndDropsOthers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 는 파일 감시를 하지 않는다 (EDITOR_LIVE_RELOAD_SRS FR-ELR-55, D-8)")
	}
	srv, _, _ := fsTestServer(t)
	defer srv.fsWatch.Close()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(root, "sub")
	file := filepath.Join(root, "a.txt")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv.fsWatch.Attach("c1")
	code, out := watchReq(t, srv, map[string]any{
		"clientId": "c1",
		"dirs":     []string{root, sub, file, filepath.Join(root, "missing"), "relative/dir"},
	})
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	got := watchingOf(t, out)
	want := []string{root, sub}
	sort.Strings(want)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("watching=%v, want %v", got, want)
	}
}

func TestFSWatch_SymlinkKeepsClientSpelling(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 는 파일 감시를 하지 않는다 (EDITOR_LIVE_RELOAD_SRS FR-ELR-55, D-8)")
	}
	srv, _, _ := fsTestServer(t)
	defer srv.fsWatch.Close()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(base, "real")
	link := filepath.Join(base, "link")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symlink 불가:", err)
	}
	srv.fsWatch.Attach("c1")
	code, out := watchReq(t, srv, map[string]any{"clientId": "c1", "dirs": []string{link}})
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	if got := watchingOf(t, out); len(got) != 1 || got[0] != link {
		t.Fatalf("watching=%v, want [%s]", got, link)
	}
}

func TestFSWatch_TooManyDirsIs400(t *testing.T) {
	srv, _, _ := fsTestServer(t)
	defer srv.fsWatch.Close()
	srv.fsWatch.Attach("c1")
	dirs := make([]string, fsWatchDirsMax+1)
	for i := range dirs {
		dirs[i] = fmt.Sprintf("/d%d", i)
	}
	code, _ := watchReq(t, srv, map[string]any{"clientId": "c1", "dirs": dirs})
	if code != http.StatusBadRequest {
		t.Fatalf("code=%d, want 400", code)
	}
}

func TestFSWatch_UnattachedClientIs400(t *testing.T) {
	srv, _, _ := fsTestServer(t)
	defer srv.fsWatch.Close()
	root := t.TempDir()
	for _, cid := range []string{"", "nobody"} {
		code, _ := watchReq(t, srv, map[string]any{"clientId": cid, "dirs": []string{root}})
		if code != http.StatusBadRequest {
			t.Fatalf("clientId=%q code=%d, want 400", cid, code)
		}
	}
}

// V-ELR-35 (FR-ELR-76): 설정값을 회차 수로 바꾼다. 범위 밖은 기본값이다.
func TestGitWorktreeRounds(t *testing.T) {
	cases := []struct {
		blob string
		want uint64
	}{
		{`{}`, 4},
		{``, 4},
		{`not json`, 4},
		{`{"gitWorktreeInterval":4000}`, 4},
		{`{"gitWorktreeInterval":1000}`, 1},
		{`{"gitWorktreeInterval":2500}`, 3},
		{`{"gitWorktreeInterval":30000}`, 30},
		{`{"gitWorktreeInterval":500}`, 4},
		{`{"gitWorktreeInterval":60000}`, 4},
		{`{"gitWorktreeInterval":"x"}`, 4},
	}
	for _, c := range cases {
		if got := gitWorktreeRounds([]byte(c.blob)); got != c.want {
			t.Fatalf("%s → %d, want %d", c.blob, got, c.want)
		}
	}
}
