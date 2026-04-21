package outbuf

import (
	"bytes"
	"context"
	"testing"
)

func TestFeedBelowMax(t *testing.T) {
	s := NewStream(context.Background(), 100)
	dropped := s.Feed(bytes.Repeat([]byte("x"), 50))
	if dropped != 0 {
		t.Errorf("dropped=%d, want 0", dropped)
	}
	if got := s.Len(); got != 50 {
		t.Errorf("Len=%d, want 50", got)
	}
}

func TestFeedAboveMax(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed(bytes.Repeat([]byte("x"), 250))
	snap, stats := s.Snapshot()
	if len(snap) != 100 {
		t.Errorf("Snapshot len=%d, want 100", len(snap))
	}
	if stats.TotalBytesDrop != 150 {
		t.Errorf("TotalBytesDrop=%d, want 150", stats.TotalBytesDrop)
	}
}

func TestMultipleFeeds(t *testing.T) {
	s := NewStream(context.Background(), 100)
	// 3회 Feed, 합계 150바이트 → tail 100바이트만 유지
	s.Feed(bytes.Repeat([]byte("A"), 50))
	s.Feed(bytes.Repeat([]byte("B"), 50))
	s.Feed(bytes.Repeat([]byte("C"), 50))
	snap, _ := s.Snapshot()
	if len(snap) != 100 {
		t.Errorf("Snapshot len=%d, want 100", len(snap))
	}
	// tail이므로 마지막 50바이트는 'C'여야 함
	for i, b := range snap[50:] {
		if b != 'C' {
			t.Errorf("snap[%d]=%q, want 'C'", 50+i, b)
			break
		}
	}
}

func TestNoPhantomDrops(t *testing.T) {
	// max=100, Feed(50) × 5 = 250바이트.
	// 과거 else-if 분기에선 3·4회째에 중복 누적되어 수백 바이트로 부풀었음.
	// 수정 후엔 5회째(250 > 2*100) compaction 1회분인 150바이트만 카운트되어야 한다.
	s := NewStream(context.Background(), 100)
	for i := 0; i < 5; i++ {
		s.Feed(bytes.Repeat([]byte("x"), 50))
	}
	_, stats := s.Snapshot()
	if stats.TotalBytesDrop != 150 {
		t.Errorf("TotalBytesDrop=%d, want 150 (compaction 1회분)", stats.TotalBytesDrop)
	}
	if stats.TotalBytesIn != 250 {
		t.Errorf("TotalBytesIn=%d, want 250", stats.TotalBytesIn)
	}
}

func TestSnapshotIsolation(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed([]byte("hello"))
	snap, _ := s.Snapshot()
	// Snapshot 이후 추가 Feed
	s.Feed([]byte("world"))
	if string(snap) != "hello" {
		t.Errorf("snap=%q after mutation, want %q", snap, "hello")
	}
}
