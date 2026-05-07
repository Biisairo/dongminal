package workspace

import (
	"sync/atomic"
	"testing"
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
