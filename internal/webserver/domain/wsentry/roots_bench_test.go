package wsentry

import (
	"os"
	"path/filepath"
	"testing"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-20 (GD-6): Roots 한 번과 그 안의 자리 보장(MkdirAll
// 두 번) 몫을 따로 잰다. 디렉터리는 미리 만들어 두므로 측정 중에는 디스크에 쓰지 않는다.
func benchRootsStore(b *testing.B) *Store {
	b.Helper()
	dir := b.TempDir()
	home := filepath.Join(dir, "home")
	notes := filepath.Join(dir, "notes")
	plugins := filepath.Join(dir, "plugins")
	for _, d := range []string{home, notes, plugins} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			b.Fatal(err)
		}
	}
	w := &fakeWork{raw: []byte(`{"schemaVersion":2,"editors":{"list":[]}}`), rev: 1}
	return &Store{Work: w, HomeFn: func() (string, error) { return home, nil }, NotesDir: notes, PluginsDir: plugins}
}

func BenchmarkRoots(b *testing.B) {
	s := benchRootsStore(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := s.Roots(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRoots_MkdirAllOnly(b *testing.B) {
	s := benchRootsStore(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = os.MkdirAll(s.NotesDir, 0o755)
		_ = os.MkdirAll(s.PluginsDir, 0o755)
	}
}
