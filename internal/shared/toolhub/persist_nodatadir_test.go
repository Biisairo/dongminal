package toolhub

import (
	"os"
	"path/filepath"
	"testing"
)

// FR-OPT-1-7 (SHR-11): 빈 dataDir 은 "영속 없음" 이다. "." 으로 풀면 테스트는
// 패키지 디렉터리에, 서버는 cwd 에 tools.json 과 세대 백업을 남긴다.
func TestEmptyDataDirDoesNotPersistToCwd(t *testing.T) {
	cwd := t.TempDir()
	t.Chdir(cwd)

	m := NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	m.mutated.Store(true)
	m.SaveAll()

	if _, err := os.Stat(filepath.Join(cwd, "tools.json")); !os.IsNotExist(err) {
		t.Fatalf("빈 dataDir 인데 cwd 에 tools.json 을 썼다 (err=%v)", err)
	}
}

func TestEmptyDataDirDoesNotLoadFromCwd(t *testing.T) {
	cwd := t.TempDir()
	t.Chdir(cwd)
	if err := os.WriteFile(filepath.Join(cwd, "tools.json"), []byte(`[{"id":"t-1","name":"Shell","cwd":"/"}]`), 0o644); err != nil {
		t.Fatal(err)
	}

	m := NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	restored := 0
	m.LoadAllWith(map[string]struct{}{"t-1": {}}, func(string, string, string, uint16, uint16) error {
		restored++
		return nil
	})
	if restored != 0 {
		t.Fatalf("빈 dataDir 인데 cwd 의 tools.json 에서 %d 개를 되살렸다", restored)
	}
}
