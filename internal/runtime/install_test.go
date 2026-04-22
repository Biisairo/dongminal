package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstallCopiesAllScripts(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	want := map[string]os.FileMode{
		"dmctl":           0o755,
		"download":        0o755,
		"edit":            0o755,
		"bash-hook.sh":    0o755,
		"zdotdir/.zshrc":  0o644,
	}
	for rel, wantMode := range want {
		info, err := os.Stat(filepath.Join(dir, rel))
		if err != nil {
			t.Errorf("missing %s: %v", rel, err)
			continue
		}
		if gotMode := info.Mode().Perm(); gotMode != wantMode {
			t.Errorf("%s: mode=%o want=%o", rel, gotMode, wantMode)
		}
	}
}
