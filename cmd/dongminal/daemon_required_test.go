package main

import (
	"errors"
	"os"
	"testing"
)

// DIRECT_MODE_REMOVAL_SRS FR-DMR-2 (TC-DMR-1): 데몬을 띄우지 못하면 서버는 직접 모드로
// 내려가지 않고 오류를 낸다. serve 는 그 오류로 리스너를 열지 않고 1 로 끝난다.
func TestDialOrStartDaemon_SpawnFailureIsError(t *testing.T) {
	home, err := os.MkdirTemp("", "dmr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	pc, err := dialOrStartDaemonWith(home, func() error { return errors.New("spawn 실패") })
	if pc != nil || !errors.Is(err, errDaemonUnavailable) {
		t.Fatalf("pc=%v err=%v, want nil·errDaemonUnavailable", pc, err)
	}
}

// FR-DMR-2: 띄웠는데 준비되지 않으면(소켓이 끝내 서지 않으면) 역시 오류다.
func TestDialOrStartDaemon_NotReadyIsError(t *testing.T) {
	home, err := os.MkdirTemp("", "dmr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	pc, err := dialOrStartDaemonWith(home, func() error { return nil })
	if pc != nil || !errors.Is(err, errDaemonUnavailable) {
		t.Fatalf("pc=%v err=%v, want nil·errDaemonUnavailable", pc, err)
	}
}
