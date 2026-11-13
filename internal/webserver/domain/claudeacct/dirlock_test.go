package claudeacct

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// FR-CAC-30 ②: proper-lockfile 호환 디렉터리 락.

func TestDirLockExclusiveAndRelease(t *testing.T) {
	d := filepath.Join(t.TempDir(), "x.lock")
	rel, err := acquireDirLock(d, time.Minute, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(d); err != nil || !st.IsDir() {
		t.Fatal("lock is a directory")
	}
	if _, err := acquireDirLock(d, time.Minute, 300*time.Millisecond); !errors.Is(err, ErrClaudeLockTimeout) {
		t.Fatalf("want timeout, got %v", err)
	}
	rel()
	if _, err := os.Stat(d); !os.IsNotExist(err) {
		t.Fatal("release removes the directory")
	}
}

func TestDirLockTakesOverStale(t *testing.T) {
	d := filepath.Join(t.TempDir(), "x.lock")
	_ = os.Mkdir(d, 0o700)
	old := time.Now().Add(-2 * time.Minute)
	_ = os.Chtimes(d, old, old)
	rel, err := acquireDirLock(d, time.Minute, 2*time.Second)
	if err != nil {
		t.Fatalf("stale lock must be taken over: %v", err)
	}
	rel()
}

func TestDirLockDoesNotStealFresh(t *testing.T) {
	d := filepath.Join(t.TempDir(), "x.lock")
	_ = os.Mkdir(d, 0o700)
	if _, err := acquireDirLock(d, time.Minute, 400*time.Millisecond); !errors.Is(err, ErrClaudeLockTimeout) {
		t.Fatalf("fresh lock must not be stolen: %v", err)
	}
}

func TestDirLockTouches(t *testing.T) {
	orig := dirLockTouch
	dirLockTouch = 50 * time.Millisecond
	defer func() { dirLockTouch = orig }()
	d := filepath.Join(t.TempDir(), "x.lock")
	rel, err := acquireDirLock(d, time.Minute, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer rel()
	old := time.Now().Add(-time.Hour)
	_ = os.Chtimes(d, old, old)
	time.Sleep(200 * time.Millisecond)
	st, _ := os.Stat(d)
	if time.Since(st.ModTime()) > time.Minute {
		t.Fatal("holder must refresh mtime")
	}
}
