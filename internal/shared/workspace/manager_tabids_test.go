package workspace

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTabIDsAfterSave(t *testing.T) {
	m, err := New(newFakeLive("10", "11", "12"), &memPersister{empty: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if got := m.TabIDs(); len(got) != 0 {
		t.Errorf("initial TabIDs should be empty, got %v", got)
	}
	if _, err := m.Save([]byte(sampleWS), ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got := m.TabIDs()
	for _, want := range []string{"t1", "t2", "t3"} {
		if _, ok := got[want]; !ok {
			t.Errorf("TabIDs missing %s: %v", want, got)
		}
	}
}

func TestOnIndexUpdateFiresOnSave(t *testing.T) {
	m, err := New(newFakeLive("10", "11", "12"), &memPersister{empty: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	var calls int32
	m.OnIndexUpdate = func() { atomic.AddInt32(&calls, 1) }
	if _, err := m.Save([]byte(sampleWS), ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Errorf("OnIndexUpdate not invoked once: got %d", calls)
	}
}

// M8 `GO-34`: OnIndexUpdate 는 `m.mu` **밖에서** 불리고, 호출 순서는 rev 순서다.
// 종전에는 락 안에서 불러 재진입 데드락을 주석으로만 막았고, 훅이 느리면 다른
// Save 의 인덱스 교체까지 그 뒤에 줄을 섰다.
func TestOnIndexUpdateRunsOutsideLockInRevOrder(t *testing.T) {
	m, err := New(newFakeLive("10", "11", "12"), &memPersister{empty: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()

	var mu sync.Mutex
	var seq []string
	release := make(chan struct{})
	entered := make(chan struct{}, 2)
	var n int32
	m.OnIndexUpdate = func() {
		i := atomic.AddInt32(&n, 1)
		mu.Lock()
		seq = append(seq, fmt.Sprintf("s%d", i))
		mu.Unlock()
		entered <- struct{}{}
		if i == 1 {
			<-release
		}
		mu.Lock()
		seq = append(seq, fmt.Sprintf("e%d", i))
		mu.Unlock()
	}

	first := make(chan error, 1)
	go func() {
		_, err := m.Save([]byte(sampleWS), "")
		first <- err
	}()
	<-entered // 훅 #1 이 막혀 있다

	// 훅 #1 이 막힌 동안 두 번째 Save 의 인덱스 교체는 진행돼야 한다.
	second := make(chan error, 1)
	go func() {
		_, err := m.Save([]byte(sampleWS), "")
		second <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for m.CurrentRev() != 2 {
		if time.Now().After(deadline) {
			t.Fatalf("훅이 락을 쥐고 있어 두 번째 Save 가 막혔다 (rev=%d)", m.CurrentRev())
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	<-entered
	if err := <-first; err != nil {
		t.Fatalf("save#1: %v", err)
	}
	if err := <-second; err != nil {
		t.Fatalf("save#2: %v", err)
	}
	mu.Lock()
	got := strings.Join(seq, ",")
	mu.Unlock()
	if got != "s1,e1,s2,e2" {
		t.Fatalf("훅 순서 = %s (want s1,e1,s2,e2)", got)
	}
}
