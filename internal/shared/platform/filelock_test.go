package platform

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-1: 저장소 락은 배타적이고, 기다리다 시간이 넘으면 실패한다.

func TestLockFileExclusive(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".lock")
	unlock, err := LockFile(p, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := LockFile(p, 300*time.Millisecond); !errors.Is(err, ErrLockTimeout) {
		t.Fatalf("second lock must time out, got %v", err)
	}
	if time.Since(start) < 250*time.Millisecond {
		t.Fatal("must wait before timing out")
	}
	unlock()
	unlock2, err := LockFile(p, time.Second)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	unlock2()
}

func TestLockFileWaitsForRelease(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".lock")
	unlock, err := LockFile(p, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(150 * time.Millisecond)
		unlock()
	}()
	unlock2, err := LockFile(p, 2*time.Second)
	if err != nil {
		t.Fatalf("must acquire after release: %v", err)
	}
	unlock2()
}

func TestLockFileCreatesParent(t *testing.T) {
	p := filepath.Join(t.TempDir(), "a", "b", ".lock")
	unlock, err := LockFile(p, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	unlock()
}
