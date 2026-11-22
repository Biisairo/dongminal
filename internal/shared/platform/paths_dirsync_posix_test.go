//go:build !windows

package platform

import (
	"os"
	"path/filepath"
	"testing"
)

// TC-ATF-58 (FR-ATF-58): POSIX 의 원자 쓰기는 rename 뒤 목적 파일의 디렉터리를 fsync 한다.
func TestWriteFileAtomicSyncsDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.json")
	var synced []string
	orig := dirSync
	dirSync = func(d string) error {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("rename 전에 디렉터리를 fsync 했다: %v", err)
		}
		synced = append(synced, d)
		return orig(d)
	}
	t.Cleanup(func() { dirSync = orig })
	if err := WriteFileAtomic(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if len(synced) != 1 || synced[0] != dir {
		t.Fatalf("fsync 한 디렉터리 = %v", synced)
	}
	if err := syncDir(filepath.Join(dir, "없음")); err == nil {
		t.Fatal("없는 디렉터리의 fsync 가 성공했다")
	}
}
