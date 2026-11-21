package httpapi

import (
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// REFACTOR3_DEFECTS_SRS TC-RD3-20: 같은 표식을 든 저장이 동시에 오면 하나만 이긴다.
// 이전에는 표식 검사와 쓰기 사이에 잠금이 없어 여럿이 200 을 받고 뒤의 쓰기가 앞을 덮었다.
func TestFileWrite_SameStampConcurrentOnlyOneWins(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "race.txt")
	seed(t, target, "base\n")
	_, _, stamp := readStamped(t, e, target)

	const n = 8
	codes := make([]int, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i], _ = writeStamped(t, e, target, strings.Repeat(string(rune('a'+i)), 4<<20), stamp)
		}(i)
	}
	close(start)
	wg.Wait()

	ok := 0
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
		default:
			t.Fatalf("예상 밖 상태 %d", c)
		}
	}
	if ok != 1 {
		t.Fatalf("같은 표식의 저장 %d건이 이겼다 (codes=%v) — 하나여야 한다", ok, codes)
	}
}

// TC-RD3-21: 잠금 표는 쓰는 동안만 항목을 둔다.
func TestPathLocks_ReleasesEntries(t *testing.T) {
	var p pathLocks
	u1 := p.lock("/a")
	u2 := p.lock("/b")
	if got := p.size(); got != 2 {
		t.Fatalf("size=%d want 2", got)
	}
	u1()
	u2()
	if got := p.size(); got != 0 {
		t.Fatalf("다 풀었는데 항목 %d개가 남았다", got)
	}
}
