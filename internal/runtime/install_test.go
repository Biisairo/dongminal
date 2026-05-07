package runtime

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"dongminal/internal/runtimebin"
)

func TestInstallShellHooks(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	want := map[string]os.FileMode{
		"bash-hook.sh":   0o755,
		"zdotdir/.zshrc": 0o644,
	}
	for rel, wantMode := range want {
		info, err := os.Stat(filepath.Join(dir, rel))
		if err != nil {
			t.Errorf("missing %s: %v", rel, err)
			continue
		}
		if got := info.Mode().Perm(); got != wantMode {
			t.Errorf("%s: mode=%o want=%o", rel, got, wantMode)
		}
	}
}

func TestInstallHelperSymlinks(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	helpers := append([]string{}, runtimebin.HelperNames()...)
	sort.Strings(helpers)
	for _, name := range helpers {
		dst := filepath.Join(dir, name)
		info, err := os.Lstat(dst)
		if err != nil {
			t.Errorf("missing helper %s: %v", name, err)
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(dst)
			if err != nil {
				t.Errorf("readlink %s: %v", name, err)
				continue
			}
			if target != self {
				t.Errorf("%s symlink target=%q want=%q", name, target, self)
			}
			continue
		}
		// fallback: regular file copy. Just ensure it's executable.
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("%s copy not executable: mode=%o", name, info.Mode().Perm())
		}
	}
}

func TestInstallIdempotent(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install #1: %v", err)
	}
	if err := Install(dir); err != nil {
		t.Fatalf("Install #2: %v", err)
	}
}
