//go:build !windows

package privhelper

import (
	"os"
	"path/filepath"
	"testing"
)

// TC-ATF-61 (FR-ATF-61): 비밀 파일은 원자 쓰기로 0600 이 된다. 옛 파일·남은 고정 이름의 임시
// 파일이 느슨한 권한이어도 결과는 0600 이고, 폴더는 0700 이며, 임시 파일이 남지 않는다.
func TestSaveSecretAtomic0600(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "helper")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "secret.json")
	for _, p := range []string{path, path + ".tmp"} {
		if err := os.WriteFile(p, []byte("old"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s, _, err := newSecret(501)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveSecret(path, s); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("비밀 파일 권한 = %o", fi.Mode().Perm())
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("폴더 권한 = %o", di.Mode().Perm())
	}
	got, err := loadSecret(path)
	if err != nil || got.TOTP != s.TOTP || got.Key != s.Key {
		t.Fatalf("읽은 비밀 = %+v (%v)", got, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "secret.json" && e.Name() != "secret.json.tmp" {
			t.Errorf("임시 파일이 남았다: %s", e.Name())
		}
	}
}
