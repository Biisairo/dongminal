package outbuf

import (
	"bytes"
	"math/rand"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-3-3 (SHR-M2) — 링 구조가 종전 계약을 그대로 지킨다.
//
// refStream 은 종전 구현(2*max 까지 키우고 넘치면 max 로 compaction)이다. 링은
// Feed 의 반환값(dropped·end), Since·Snapshot·Len·Stats 전부에서 이것과 같아야 한다 —
// 특히 End 좌표계(누적 입력 바이트)와 재개 창(FR-TRS-1·2)이다.
type refStream struct {
	buf       []byte
	max       int
	totalIn   int64
	totalDrop int64
}

func (s *refStream) Feed(p []byte) (dropped int, end int64) {
	s.totalIn += int64(len(p))
	end = s.totalIn
	s.buf = append(s.buf, p...)
	if over := len(s.buf) - s.max; over > 0 && len(s.buf) > 2*s.max {
		s.buf = append(s.buf[:0], s.buf[over:]...)
		dropped = over
		s.totalDrop += int64(over)
	}
	return
}

func (s *refStream) retained() int {
	if len(s.buf) > s.max {
		return s.max
	}
	return len(s.buf)
}

func (s *refStream) Since(off int64) ([]byte, int64, bool) {
	end := s.totalIn
	if off < 0 || off > end {
		return nil, end, false
	}
	ret := s.retained()
	start := end - int64(ret)
	if off < start {
		return nil, end, false
	}
	tail := s.buf[len(s.buf)-ret:]
	return append([]byte{}, tail[off-start:]...), end, true
}

func (s *refStream) Snapshot() ([]byte, Stats) {
	out := append([]byte{}, s.buf[len(s.buf)-s.retained():]...)
	return out, Stats{TotalBytesIn: s.totalIn, TotalBytesDrop: s.totalDrop, Retained: len(out)}
}

func (s *refStream) Close() { s.buf = nil }

func TestRing_MatchesReference(t *testing.T) {
	for _, max := range []int{0, 1, 7, 100, 4096} {
		for seed := int64(1); seed <= 40; seed++ {
			rng := rand.New(rand.NewSource(seed*1000 + int64(max)))
			s := NewStream(max)
			ref := &refStream{max: max}
			var fed byte
			for step := 0; step < 300; step++ {
				switch op := rng.Intn(40); {
				case op == 0:
					s.Close()
					ref.Close()
				default:
					n := rng.Intn(3*max + 3)
					if rng.Intn(4) == 0 {
						n = rng.Intn(8)
					}
					p := make([]byte, n)
					for i := range p {
						fed++
						p[i] = fed
					}
					gd, ge := s.Feed(p)
					wd, we := ref.Feed(p)
					if gd != wd || ge != we {
						t.Fatalf("max=%d seed=%d step=%d Feed(%d)=(%d,%d) want (%d,%d)", max, seed, step, n, gd, ge, wd, we)
					}
				}
				gs, gst := s.Snapshot()
				ws, wst := ref.Snapshot()
				if !bytes.Equal(gs, ws) || gst != wst {
					t.Fatalf("max=%d seed=%d step=%d Snapshot len=%d %+v want len=%d %+v", max, seed, step, len(gs), gst, len(ws), wst)
				}
				if s.Len() != ref.retained() {
					t.Fatalf("max=%d seed=%d step=%d Len=%d want %d", max, seed, step, s.Len(), ref.retained())
				}
				end := ref.totalIn
				for _, off := range []int64{-1, 0, end, end + 1, end - int64(max), end - int64(max) - 1, end - rng.Int63n(int64(max)+2)} {
					gd, ge, gok := s.Since(off)
					wd, we, wok := ref.Since(off)
					if gok != wok || ge != we || !bytes.Equal(gd, wd) {
						t.Fatalf("max=%d seed=%d step=%d Since(%d)=(len %d,%d,%v) want (len %d,%d,%v)", max, seed, step, off, len(gd), ge, gok, len(wd), we, wok)
					}
				}
			}
		}
	}
}

// 1 MB 를 미리 잡지 않는다 — 거의 출력하지 않는 도구가 max 를 차지하지 않는다.
func TestRing_NoPreallocation(t *testing.T) {
	const max = 1 << 20
	s := NewStream(max)
	s.Feed([]byte("hi"))
	if c := cap(s.buf); c >= max {
		t.Fatalf("cap=%d — 출력 2 바이트에 max(%d) 를 잡았다", c, max)
	}
}

// 창이 찬 뒤에는 다시 할당하지 않는다 — 넘칠 때 2*max 로 키우고 복사하던 자리다.
func TestRing_NoReallocationWhenFull(t *testing.T) {
	const max = 1 << 16
	s := NewStream(max)
	chunk := bytes.Repeat([]byte("x"), 8<<10)
	for i := 0; i < 2*max/len(chunk); i++ {
		s.Feed(chunk)
	}
	base := &s.buf[:1][0]
	if c := cap(s.buf); c != max {
		t.Fatalf("cap=%d want %d — 창 밖의 바이트를 들고 있다", c, max)
	}
	allocs := testing.AllocsPerRun(100, func() { s.Feed(chunk) })
	if allocs != 0 {
		t.Fatalf("찬 뒤 Feed allocs=%v want 0", allocs)
	}
	if &s.buf[:1][0] != base {
		t.Fatal("찬 뒤 Feed 가 버퍼를 바꿨다")
	}
}

func BenchmarkStreamFeed8K(b *testing.B) {
	s := NewStream(1 << 20)
	chunk := bytes.Repeat([]byte("x"), 8<<10)
	b.ReportAllocs()
	b.SetBytes(int64(len(chunk)))
	for i := 0; i < b.N; i++ {
		s.Feed(chunk)
	}
}

func BenchmarkNewStreamSmallTool(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s := NewStream(1 << 20)
		s.Feed([]byte("prompt$ "))
	}
}
