package runtime

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// FR-OPT-5-5 (SHR-12): 셸 훅 전개를 되풀이해도 같은 파일은 교체되지 않는다.
func TestInstallShellHooksKeepsUnchangedFiles(t *testing.T) {
	bin := t.TempDir()
	if err := installShellHooks(bin); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	before := map[string]os.FileInfo{}
	filepath.WalkDir(bin, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			// 옛 시각으로 되돌려 두면 다시 쓴 파일은 mtime 이 앞으로 온다.
			// os.WriteFile 은 inode 를 유지하므로 SameFile 로는 잴 수 없다.
			os.Chtimes(p, stamp, stamp)
			before[p], _ = os.Stat(p)
		}
		return nil
	})
	if len(before) == 0 {
		t.Fatal("전개된 파일이 없다")
	}
	if err := installShellHooks(bin); err != nil {
		t.Fatal(err)
	}
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
