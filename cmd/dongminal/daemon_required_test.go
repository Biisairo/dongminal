package main

import (
	"errors"
	"os"
	"testing"
)

// DIRECT_MODE_REMOVAL_SRS FR-DMR-2 (TC-DMR-1): 데몬을 띄우지 못하면 연결 함수는 errDaemonUnavailable 을
// 낸다. 이 시험은 그 반환만 본다 — serve 는 buildApp 의 어떤 오류에서든 리스너를 열기 전에 1 을 돌려준다.
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
