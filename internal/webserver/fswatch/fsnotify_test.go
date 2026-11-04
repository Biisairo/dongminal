package fswatch

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// 실제 백엔드(fsnotify)로 일반 쓰기·원자적 쓰기·추가·삭제가 이벤트로 나오는지 잰다.
func TestManager_RealBackendReportsChanges(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	seen := map[string][]Kind{}
	m := NewManager(DefaultOptions(func(c []Change, _ bool) {
		mu.Lock()
		defer mu.Unlock()
		for _, x := range c {
			seen[x.Path] = append(seen[x.Path], x.Kind)
		}
	}))
	defer m.Close()
	m.Attach("c1")
	got, err := m.Set("c1", []Dir{{Path: dir, Real: dir}})
	if err != nil || len(got) != 1 {
		t.Fatalf("watching=%v err=%v", got, err)
	}
	has := func(p string, k Kind) func() bool {
		return func() bool {
			mu.Lock()
			defer mu.Unlock()
			for _, x := range seen[p] {
				if x == k {
					return true
				}
			}
			return false
		}
	}
	reset := func() { mu.Lock(); seen = map[string][]Kind{}; mu.Unlock() }

	if err := os.WriteFile(file, []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForLong(t, has(file, Updated))

	reset()
	tmp := filepath.Join(dir, ".a.txt.tmp")
	if err := os.WriteFile(tmp, []byte("three\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, file); err != nil {
		t.Fatal(err)
	}
	waitForLong(t, func() bool { return has(file, Updated)() || has(file, Added)() })
	if has(file, Deleted)() {
		t.Fatal("원자적 저장이 삭제로 보였다")
	}

	reset()
	nf := filepath.Join(dir, "b.txt")
	if err := os.WriteFile(nf, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForLong(t, has(nf, Added))

	reset()
	if err := os.Remove(nf); err != nil {
		t.Fatal(err)
	}
	waitForLong(t, has(nf, Deleted))
}

func waitForLong(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("이벤트가 오지 않았다")
}
