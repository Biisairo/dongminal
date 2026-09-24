//go:build !windows

package httpapi

import (
	"os"
	"path/filepath"
	"testing"
)

// REPO_FIX 03 §3A-4 — 권한 비트·심링크 (POSIX).

// 새 파일은 인코딩 필드와 무관하게 UTF-8·BOM 없음·0644.
func TestFileWrite_NewFileDefaults(t *testing.T) {
	e := newFileBoundaryEnv(t)
	p := filepath.Join(e.root, "new.txt")
	if code, _, _ := encWrite(t, e, map[string]any{"path": p, "content": "한", "encoding": "cp949", "bom": true}); code != 200 {
		t.Fatal("새 파일 쓰기 실패")
	}
	got, _ := os.ReadFile(p)
	if string(got) != "한" {
		t.Fatalf("새 파일 = %v", got)
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o644 {
		t.Fatalf("새 파일 권한 = %v", st.Mode().Perm())
	}
}

// 기존 파일의 권한 비트를 보존한다.
func TestFileWrite_PreservesMode(t *testing.T) {
	e := newFileBoundaryEnv(t)
	for _, mode := range []os.FileMode{0o755, 0o600} {
		p := filepath.Join(e.root, "m"+mode.String())
		put(t, p, []byte("x"), mode)
		if code, _, _ := encWrite(t, e, map[string]any{"path": p, "content": "y"}); code != 200 {
			t.Fatal("쓰기 실패")
		}
		if st, _ := os.Stat(p); st.Mode().Perm() != mode {
			t.Fatalf("권한 %v → %v", mode, st.Mode().Perm())
		}
	}
}

// 심링크는 링크를 유지하고 대상에 쓴다. 끊어진 링크는 가리키는 자리에 새로 만든다.
func TestFileWrite_FollowsSymlink(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "real.txt")
	put(t, target, []byte("old"), 0o640)
	link := filepath.Join(e.root, "link.txt")
	if err := os.Symlink("real.txt", link); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := encWrite(t, e, map[string]any{"path": link, "content": "new"}); code != 200 {
		t.Fatal("링크로 쓰기 실패")
	}
	if fi, _ := os.Lstat(link); fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("링크가 일반 파일로 바뀌었다")
	}
	if got, _ := os.ReadFile(target); string(got) != "new" {
		t.Fatalf("대상 = %q", got)
	}
	if st, _ := os.Stat(target); st.Mode().Perm() != 0o640 {
		t.Fatalf("대상 권한 = %v", st.Mode().Perm())
	}
	dangling := filepath.Join(e.root, "dangle.txt")
	if err := os.Symlink("sub-missing.txt", dangling); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := encWrite(t, e, map[string]any{"path": dangling, "content": "made"}); code != 200 {
		t.Fatal("끊어진 링크 쓰기 실패")
	}
	if got, _ := os.ReadFile(filepath.Join(e.root, "sub-missing.txt")); string(got) != "made" {
		t.Fatalf("끊어진 링크의 대상 = %q", got)
	}
	if fi, _ := os.Lstat(dangling); fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("끊어진 링크가 파일로 바뀌었다")
	}
}
