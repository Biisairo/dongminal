package agentadapter

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// FR-OPT-5-5 (SHR-12): 에이전트 설치물을 되풀이해 써도 같은 파일은 교체되지 않는다.
func TestInstallAssetsKeepsUnchangedFiles(t *testing.T) {
	root := t.TempDir()
	spec := InstallSpec{Dir: filepath.Join(root, "hooks"), PluginDir: filepath.Join(root, "plugin"), Dmctl: "/x/dmctl"}
	if err := os.MkdirAll(spec.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	install := func() {
		t.Helper()
		if err := installClaudeAssets(spec); err != nil {
			t.Fatal(err)
		}
		if err := installOmpAssets(spec); err != nil {
			t.Fatal(err)
		}
	}
	install()
	stamp := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	before := map[string]os.FileInfo{}
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			// 옛 시각으로 되돌려 두면 다시 쓴 파일은 mtime 이 앞으로 온다.
			// os.WriteFile 은 inode 를 유지하므로 SameFile 로는 잴 수 없다.
			os.Chtimes(p, stamp, stamp)
			before[p], _ = os.Stat(p)
		}
		return nil
	})
	if len(before) < 4 {
		t.Fatalf("설치물 %d개 — claude 둘·omp 둘이어야 한다", len(before))
	}
	install()
	for p, st := range before {
		now, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if !os.SameFile(st, now) || !now.ModTime().Equal(stamp) {
			t.Errorf("%s: 같은 내용인데 다시 썼다", filepath.Base(p))
		}
	}
}
