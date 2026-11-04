package fswatch

import (
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"
)

type fakeTimer struct {
	at      time.Duration
	f       func()
	stopped bool
}

type fakeClock struct {
	mu     sync.Mutex
	now    time.Duration
	timers []*fakeTimer
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) func() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now + d, f: f}
	c.timers = append(c.timers, t)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

// Advance 는 시계를 d 만큼 옮기며 그 사이에 마감이 온 타이머를 차례로 부른다.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	end := c.now + d
	c.mu.Unlock()
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at < c.timers[j].at })
		var next *fakeTimer
		for _, t := range c.timers {
			if !t.stopped && t.at <= end {
				next = t
				break
			}
		}
		if next == nil {
			c.now = end
			c.mu.Unlock()
			return
		}
		next.stopped = true
		c.now = next.at
		c.mu.Unlock()
		next.f()
	}
}

type outRec struct {
	at       time.Duration
	changes  []Change
	overflow bool
}

type pipeFx struct {
	clk    *fakeClock
	exists map[string]bool
	mu     sync.Mutex
	outs   []outRec
	p      *Pipeline
}

func newPipeFx(nfc bool) *pipeFx {
	fx := &pipeFx{clk: &fakeClock{}, exists: map[string]bool{}}
	fx.p = NewPipeline(PipelineOptions{
		Clock:         fx.clk,
		Exists:        func(p string) bool { fx.mu.Lock(); defer fx.mu.Unlock(); return fx.exists[p] },
		CaseSensitive: true,
		NFC:           nfc,
		Out: func(c []Change, overflow bool) {
			fx.mu.Lock()
			defer fx.mu.Unlock()
			fx.outs = append(fx.outs, outRec{fx.clk.now, append([]Change(nil), c...), overflow})
		},
	})
	return fx
}

func (fx *pipeFx) got() []outRec {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return append([]outRec(nil), fx.outs...)
}

// V-ELR-21 (FR-ELR-56): 원시 이벤트의 해석.

func TestPipeline_CreateWriteMapToAddedUpdated(t *testing.T) {
	fx := newPipeFx(false)
	fx.p.Push(RawEvent{"/r/a", OpCreate})
	fx.p.Push(RawEvent{"/r/b", OpWrite})
	fx.clk.Advance(ChangesDelay)
	outs := fx.got()
	if len(outs) != 1 {
		t.Fatalf("outs=%v", outs)
	}
	want := map[string]Kind{"/r/a": Added, "/r/b": Updated}
	for _, c := range outs[0].changes {
		if want[c.Path] != c.Kind {
			t.Fatalf("change %v, want %v", c, want)
		}
	}
}

func TestPipeline_ChmodIgnored(t *testing.T) {
	fx := newPipeFx(false)
	fx.p.Push(RawEvent{"/r/a", OpChmod})
	fx.clk.Advance(time.Second)
	if outs := fx.got(); len(outs) != 0 {
		t.Fatalf("chmod 가 나갔다: %v", outs)
	}
}

func TestPipeline_RenameRecheckExistsIsUpdated(t *testing.T) {
	fx := newPipeFx(false)
	fx.exists["/r/a"] = true
	fx.p.Push(RawEvent{"/r/a", OpRename})
	fx.clk.Advance(DeleteRecheckDelay - time.Millisecond)
	if outs := fx.got(); len(outs) != 0 {
		t.Fatalf("100ms 전에 나갔다: %v", outs)
	}
	fx.clk.Advance(time.Second)
	outs := fx.got()
	if len(outs) != 1 || len(outs[0].changes) != 1 || outs[0].changes[0] != (Change{"/r/a", Updated}) {
		t.Fatalf("outs=%v, want updated", outs)
	}
}

func TestPipeline_RemoveRecheckMissingIsDeleted(t *testing.T) {
	fx := newPipeFx(false)
	fx.p.Push(RawEvent{"/r/a", OpRemove})
	fx.clk.Advance(time.Second)
	outs := fx.got()
	if len(outs) != 1 || outs[0].changes[0] != (Change{"/r/a", Deleted}) {
		t.Fatalf("outs=%v, want deleted", outs)
	}
}

func TestPipeline_AtomicSaveIsOneUpdate(t *testing.T) {
	// 임시 파일에 쓰고 rename 한다 — 원본 자리는 Remove/Rename 뒤 Create 로 온다.
	fx := newPipeFx(false)
	fx.exists["/r/a"] = true
	fx.p.Push(RawEvent{"/r/a.tmp", OpCreate})
	fx.p.Push(RawEvent{"/r/a.tmp", OpRename})
	fx.p.Push(RawEvent{"/r/a", OpRename})
	fx.p.Push(RawEvent{"/r/a", OpCreate})
	fx.clk.Advance(time.Second)
	var forA []Kind
	for _, o := range fx.got() {
		for _, c := range o.changes {
			if c.Path == "/r/a" {
				forA = append(forA, c.Kind)
			}
		}
	}
	for _, k := range forA {
		if k == Deleted {
			t.Fatalf("원자적 저장이 삭제로 보였다: %v", forA)
		}
	}
	if len(forA) == 0 {
		t.Fatal("원본 자리의 변화가 없다")
	}
}

func TestPipeline_NFCNormalizesBaseName(t *testing.T) {
	fx := newPipeFx(true)
	nfd := "/r/한.md" // "한" NFD
	fx.p.Push(RawEvent{nfd, OpWrite})
	fx.clk.Advance(time.Second)
	outs := fx.got()
	if len(outs) != 1 || outs[0].changes[0].Path != "/r/한.md" {
		t.Fatalf("outs=%+v, want NFC", outs)
	}
}

// V-ELR-22 (FR-ELR-57·58): 모으기와 양 조절.

func TestPipeline_BatchesWithin75ms(t *testing.T) {
	fx := newPipeFx(false)
	fx.p.Push(RawEvent{"/r/a", OpWrite})
	fx.clk.Advance(50 * time.Millisecond)
	fx.p.Push(RawEvent{"/r/b", OpWrite})
	fx.clk.Advance(24 * time.Millisecond)
	if outs := fx.got(); len(outs) != 0 {
		t.Fatalf("75ms 전에 나갔다: %v", outs)
	}
	fx.clk.Advance(time.Millisecond)
	outs := fx.got()
	if len(outs) != 1 || len(outs[0].changes) != 2 {
		t.Fatalf("outs=%v, want one batch of two", outs)
	}
}

func TestPipeline_ChunksOf100With200msPause(t *testing.T) {
	fx := newPipeFx(false)
	for i := 0; i < ChunkSize+1; i++ {
		fx.p.Push(RawEvent{fmt.Sprintf("/r/f%03d", i), OpWrite})
	}
	fx.clk.Advance(time.Second)
	outs := fx.got()
	if len(outs) != 2 {
		t.Fatalf("묶음 %d개, want 2", len(outs))
	}
	if len(outs[0].changes) != ChunkSize || len(outs[1].changes) != 1 {
		t.Fatalf("크기 %d·%d", len(outs[0].changes), len(outs[1].changes))
	}
	if gap := outs[1].at - outs[0].at; gap < ChunkPause {
		t.Fatalf("묶음 사이 %v, want ≥ %v", gap, ChunkPause)
	}
}

func TestPipeline_OverflowSignalsOnce(t *testing.T) {
	fx := newPipeFx(false)
	for i := 0; i < MaxBuffered+50; i++ {
		fx.p.Push(RawEvent{fmt.Sprintf("/r/f%05d", i), OpWrite})
	}
	fx.clk.Advance(time.Hour)
	over, total := 0, 0
	for _, o := range fx.got() {
		if o.overflow {
			over++
		}
		total += len(o.changes)
	}
	if over != 1 {
		t.Fatalf("overflow %d번, want 1", over)
	}
	if total > MaxBuffered {
		t.Fatalf("변화 %d건이 나갔다, want ≤ %d", total, MaxBuffered)
	}
}
