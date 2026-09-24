package httpapi

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// REPO_FIX 04 §3A-4 — 대소문자만 다른 이름변경.

func caseInsensitive(t *testing.T, dir string) bool {
	t.Helper()
	p := filepath.Join(dir, "probe-case")
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(p)
	_, err := os.Lstat(filepath.Join(dir, "PROBE-CASE"))
	return err == nil
}

// 대소문자 비구분 FS 에서 readme.md → README.md 가 성공한다(파일·디렉터리).
func TestFSRename_CaseOnly(t *testing.T) {
	dir := t.TempDir()
	if !caseInsensitive(t, dir) {
		t.Skip("대소문자 구분 FS")
	}
	s := &Server{}
	from := filepath.Join(dir, "readme.md")
	if err := os.WriteFile(from, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	to := filepath.Join(dir, "README.md")
	if err := s.fsRenameNoReplace(from, to); err != nil {
		t.Fatalf("파일 대소문자 변경 = %v", err)
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 || ents[0].Name() != "README.md" {
		t.Fatalf("디렉터리 = %v", ents)
	}
	d := filepath.Join(dir, "sub")
	if err := os.Mkdir(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := s.fsRenameNoReplace(d, filepath.Join(dir, "SUB")); err != nil {
		t.Fatalf("디렉터리 대소문자 변경 = %v", err)
	}
}

// 하드링크 두 이름은 자기 자신으로 오판하지 않는다 — 충돌이다(모든 FS).
func TestFSRename_HardlinkIsConflict(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(a, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := filepath.Join(dir, "b.txt")
	if err := os.Link(a, b); err != nil {
		t.Skip("하드링크를 만들 수 없다:", err)
	}
	s := &Server{}
	var fe fsError
	if err := s.fsRenameNoReplace(a, b); !errors.As(err, &fe) || fe.code != fsErrExists {
		t.Fatalf("하드링크 대상 = %v, want 충돌", err)
	}
	other := filepath.Join(dir, "o")
	if err := os.Mkdir(other, 0o755); err != nil {
		t.Fatal(err)
	}
	c := filepath.Join(other, "A.TXT")
	if err := os.Link(a, c); err != nil {
		t.Skip(err)
	}
	if err := s.fsRenameNoReplace(a, c); !errors.As(err, &fe) || fe.code != fsErrExists {
		t.Fatalf("다른 디렉터리 하드링크 = %v, want 충돌", err)
	}
}
