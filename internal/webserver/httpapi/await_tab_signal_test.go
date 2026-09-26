package httpapi

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/webserver/seam/toolaccess"
)

// countingIndex 는 색인 조회 수를 센다.
type countingIndex struct {
	*syncWorkIndex
	reads atomic.Int64
}

func (c *countingIndex) Entries() []toolaccess.WorkspaceEntry {
	c.reads.Add(1)
	return c.syncWorkIndex.Entries()
}

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-4 (HTTP-31) — 부착 대기는 워크스페이스 색인이 바뀔 때만
// 다시 본다. 종전에는 50 ms 마다 색인 전체를 복사했다.
func TestAwaitTab_ReadsIndexOnChangeOnly(t *testing.T) {
	wi := &countingIndex{syncWorkIndex: newSyncWorkIndex()}
	s := &Server{Deps: Deps{WorkIndex: wi}}
	got := make(chan string, 1)
	go func() { got <- s.awaitTab(context.Background(), "tool-x", true) }()
	time.Sleep(600 * time.Millisecond)
	wi.bind("tool-x", "tab-x")
	select {
	case tab := <-got:
		if tab != "tab-x" {
			t.Fatalf("tab = %q", tab)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("색인이 바뀌었는데 깨어나지 않았다")
	}
	// 첫 조회 + 바뀐 뒤 한 번. 600 ms 를 50 ms 로 폴링했다면 12번 이상이다.
	if n := wi.reads.Load(); n > 2 {
		t.Fatalf("색인을 %d 번 읽었다", n)
	}
}
