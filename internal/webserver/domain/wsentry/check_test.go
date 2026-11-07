package wsentry

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
)

// SERVER_DRIVEN_ACTIONS_SRS F-m: 편집기 루트 추가 경로의 판정은 이 함수 하나다.
func TestCheckEditorPath(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, path string
		want       error
	}{
		{"빈 경로", "  ", ErrEmptyPath},
		{"상대 경로", "rel/dir", ErrNotAbsolute},
		{"없는 경로", filepath.Join(dir, "gone"), ErrNotFound},
		{"파일", file, ErrNotDir},
		{"파일시스템 루트", testpath.Root(), ErrFilesystemRoot},
		{"디렉터리 · 앞뒤 공백", " " + dir + " ", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			norm, err := CheckEditorPath(c.path)
			if !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if c.want == nil && norm != NormalizePath(dir) {
				t.Fatalf("norm = %q, want %q", norm, NormalizePath(dir))
			}
		})
	}
}
