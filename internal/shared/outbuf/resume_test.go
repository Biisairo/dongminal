package outbuf

import (
	"bytes"
	"context"
	"testing"
)

// V-TRS-1: Feed 가 돌려주는 end 는 누적 입력 바이트와 같다.
func TestFeed_ReturnsEndOffset(t *testing.T) {
	s := NewStream(context.Background(), 100)
	if _, end := s.Feed([]byte("abc")); end != 3 {
		t.Errorf("end=%d want 3", end)
	}
	if _, end := s.Feed([]byte("de")); end != 5 {
		t.Errorf("end=%d want 5", end)
	}
	if got := s.Offset(); got != 5 {
		t.Errorf("Offset=%d want 5", got)
	}
}

// V-TRS-1: compaction 이 일어나도 end 는 되감기지 않는다 — 절대 좌표다.
func TestFeed_EndSurvivesCompaction(t *testing.T) {
	s := NewStream(context.Background(), 100)
	var end int64
	for i := 0; i < 5; i++ {
		_, end = s.Feed(bytes.Repeat([]byte("x"), 50))
	}
	if end != 250 {
		t.Errorf("end=%d want 250", end)
	}
}

// V-TRS-2: 보유 창 안의 off 로 정확히 그 뒤만 받는다.
func TestSince_InsideWindow(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed([]byte("hello"))
	s.Feed([]byte("world"))
	data, end, ok := s.Since(5)
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if string(data) != "world" {
		t.Errorf("data=%q want %q", data, "world")
	}
	if end != 10 {
		t.Errorf("end=%d want 10", end)
	}
}

// V-TRS-2: 0 부터 요청하면 보유분 전체다.
func TestSince_FromZero(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed([]byte("abcde"))
	data, _, ok := s.Since(0)
	if !ok || string(data) != "abcde" {
		t.Errorf("data=%q ok=%v want %q true", data, ok, "abcde")
	}
}

// V-TRS-3: off==end 는 완전 동기다 — 빈 데이터에 ok=true.
func TestSince_AtEnd(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed([]byte("abc"))
	data, end, ok := s.Since(3)
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if len(data) != 0 {
		t.Errorf("data=%q want empty", data)
	}
	if end != 3 {
		t.Errorf("end=%d want 3", end)
	}
}

// V-TRS-3: 아무것도 흘리지 않은 스트림에 off=0 은 완전 동기다.
func TestSince_EmptyStream(t *testing.T) {
	s := NewStream(context.Background(), 100)
	data, end, ok := s.Since(0)
	if !ok || len(data) != 0 || end != 0 {
		t.Errorf("data=%q end=%d ok=%v want empty 0 true", data, end, ok)
	}
}

// V-TRS-4: 음수 off 는 거절한다.
func TestSince_Negative(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed([]byte("abc"))
	if _, _, ok := s.Since(-1); ok {
		t.Error("ok=true, want false")
	}
}

// V-TRS-4: off>end 는 좌표계가 바뀐 것이다 (데몬 재시작). 거절한다.
func TestSince_BeyondEnd(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed([]byte("abc"))
	if _, _, ok := s.Since(4); ok {
		t.Error("ok=true, want false")
	}
}

// V-TRS-5: compaction 으로 창 밖으로 밀린 off 는 거절한다.
func TestSince_OutsideWindowAfterCompaction(t *testing.T) {
	s := NewStream(context.Background(), 100)
	// 250 바이트를 흘리면 앞 150 이 잘린다 (TestFeed_Above2Max_Compaction 과 같은 조건).
	s.Feed(bytes.Repeat([]byte("x"), 250))
	if _, _, ok := s.Since(0); ok {
		t.Error("off=0 ok=true, want false (창 밖)")
	}
	// 보유 창은 [150, 250) 이다.
	data, end, ok := s.Since(150)
	if !ok {
		t.Fatal("off=150 ok=false, want true")
	}
	if len(data) != 100 || end != 250 {
		t.Errorf("len=%d end=%d want 100 250", len(data), end)
	}
	if _, _, ok := s.Since(149); ok {
		t.Error("off=149 ok=true, want false")
	}
}

// V-TRS-2: 보유 창은 Snapshot 이 돌려주는 구간과 **같다**.
// 두 창이 갈리면 "스냅샷에는 있는데 재개는 안 되는" 구간이 생긴다.
func TestSince_WindowMatchesSnapshot(t *testing.T) {
	s := NewStream(context.Background(), 100)
	// max~2*max 구간: buf 는 150 인데 Snapshot 은 tail 100 만 준다.
	_, end := s.Feed(bytes.Repeat([]byte("x"), 150))
	snap, _ := s.Snapshot()
	data, _, ok := s.Since(end - int64(len(snap)))
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if !bytes.Equal(data, snap) {
		t.Errorf("Since 의 창이 Snapshot 과 다르다: len %d vs %d", len(data), len(snap))
	}
	if _, _, ok := s.Since(end - int64(len(snap)) - 1); ok {
		t.Error("Snapshot 창 밖인데 ok=true")
	}
}

// V-TRS-2: Since 는 사본을 준다 — 돌려준 뒤의 Feed 가 그것을 고치면 안 된다.
func TestSince_Isolation(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed([]byte("hello"))
	data, _, _ := s.Since(0)
	s.Feed([]byte("world"))
	if string(data) != "hello" {
		t.Errorf("data=%q want %q", data, "hello")
	}
}

// Close 뒤의 Since 는 창이 비었으므로 off=0 만 동기로 본다.
func TestSince_AfterClose(t *testing.T) {
	s := NewStream(context.Background(), 100)
	s.Feed([]byte("abc"))
	s.Close()
	if _, _, ok := s.Since(3); !ok {
		t.Error("off==end 인데 ok=false")
	}
}
