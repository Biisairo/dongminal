package outbuf

import (
	"sync"
	"sync/atomic"
)

// Stream 은 PTY writer 와 MCP/WS reader 를 통합한 단일 진입점 바운디드 버퍼다.
//
// Backpressure / drop 정책 (S4 SRS):
//   - Feed 는 절대 블록되지 않는다. 짧은 mutex 만 잡는다.
//   - 읽을 수 있는 것은 마지막 max 바이트다 (Snapshot·Since·Len).
//   - Stats.TotalBytesDrop 은 종전 compaction 의 계산을 그대로 따른다 — 보유량이
//     2*max 를 넘을 때 max 를 넘는 분량을 한꺼번에 센다. max~2*max 구간의
//     tail-over 는 세지 않는다.
//   - 호출자는 다른 곳에 별도 buffered channel 을 두어 silent drop 경로를
//     만들지 않아야 한다 (single drop path 원칙).
//
// 저장은 max 바이트 링이다 (FR-OPT-3-3). 처음에는 작게 시작해 max 까지 자라고,
// 찬 뒤에는 다시 할당하지도 복사로 당기지도 않는다.
type Stream struct {
	mu  sync.Mutex
	buf []byte // 차기 전: 입력 순서 그대로. 찬 뒤(full): len==max 인 링
	// head 는 링에서 가장 오래된 바이트의 자리다 (full 일 때만 뜻이 있다).
	head int
	full bool
	max  int
	// vlen 은 종전 구현의 보유량(2*max 까지 자라다 max 로 줄던 len(buf))이다.
	// TotalBytesDrop 과 Feed 의 dropped 를 종전과 같게 내는 데만 쓴다.
	vlen      int
	totalIn   atomic.Int64
	totalDrop atomic.Int64
}

// streamInitCap 은 첫 Feed 가 잡는 최소 용량이다. 그 뒤로는 두 배씩 max 까지 자란다.
const streamInitCap = 4 << 10

type Stats struct {
	TotalBytesIn   int64
	TotalBytesDrop int64
	Retained       int
}

// NewStream 은 최대 유지 바이트 max 로 Stream 을 만든다. 버퍼는 미리 잡지 않는다.
func NewStream(max int) *Stream {
	return &Stream{max: max}
}

// Feed는 readPTY에서 호출된다. 절대 블로킹하지 않으며,
// 종전 compaction 규칙으로 센 소실 바이트 수를 반환한다(없으면 0).
// end 는 이 청크를 포함한 **누적 입력 바이트**다 (FR-TRS-1). 창이 밀려도
// 되감기지 않는 절대 좌표이며, 재접속의 재개 지점이 이 좌표계에 있다.
//
// p 는 **보관하지 않는다** — 자기 버퍼에 복사한다. 호출자가 재사용하는 읽기
// 버퍼를 그대로 넘겨도 된다 (M8 `GO-37`).
func (s *Stream) Feed(p []byte) (dropped int, end int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	end = s.totalIn.Add(int64(len(p)))
	s.vlen += len(p)
	if over := s.vlen - s.max; over > 0 && s.vlen > 2*s.max {
		s.vlen = s.max
		dropped = over
		s.totalDrop.Add(int64(over))
	}
	s.write(p)
	return
}

// write 는 p 를 창에 넣는다 (mu 아래).
func (s *Stream) write(p []byte) {
	if s.max <= 0 || len(p) == 0 {
		return
	}
	if len(p) >= s.max {
		p = p[len(p)-s.max:]
	}
	if !s.full {
		if len(s.buf)+len(p) < s.max {
			s.grow(len(s.buf) + len(p))
			s.buf = append(s.buf, p...)
			return
		}
		// 이 Feed 로 창이 찬다: 링으로 바꾼다. 가장 오래된 것이 앞에 오도록
		// 남길 옛 꼬리를 먼저 놓고 p 를 잇는다.
		keep := s.max - len(p)
		ring := s.buf[:cap(s.buf)]
		if cap(s.buf) != s.max {
			ring = make([]byte, s.max)
		}
		copy(ring, s.buf[len(s.buf)-keep:])
		copy(ring[keep:], p)
		s.buf, s.head, s.full = ring, 0, true
		return
	}
	k := copy(s.buf[s.head:], p)
	copy(s.buf, p[k:])
	s.head = (s.head + len(p)) % s.max
}

// grow 는 차기 전 버퍼의 용량을 need 이상으로 늘린다 — 두 배씩, max 를 넘지 않게.
func (s *Stream) grow(need int) {
	if need <= cap(s.buf) {
		return
	}
	c := max(2*cap(s.buf), streamInitCap, need)
	c = min(c, s.max)
	nb := make([]byte, len(s.buf), c)
	copy(nb, s.buf)
	s.buf = nb
}

// Offset은 현재까지의 누적 입력 바이트를 돌려준다 (FR-TRS-1).
func (s *Stream) Offset() int64 { return s.totalIn.Load() }

// retainedLocked 는 지금 돌려줄 수 있는 tail 의 길이다. Snapshot 과 Since 가 같은
// 창을 쓴다 — 두 창이 갈리면 "스냅샷에는 있는데 재개는 안 되는" 구간이 생긴다
// (FR-TRS-2).
func (s *Stream) retainedLocked() int {
	if s.full {
		return s.max
	}
	return len(s.buf)
}

// tailLocked 는 창의 마지막 n 바이트를 새 슬라이스로 복사한다 (n <= retained).
func (s *Stream) tailLocked(n int) []byte {
	out := make([]byte, n)
	if !s.full {
		copy(out, s.buf[len(s.buf)-n:])
		return out
	}
	start := (s.head + s.max - n) % s.max
	k := copy(out, s.buf[start:])
	copy(out[k:], s.buf[:n-k])
	return out
}

// Since는 절대 오프셋 off 이후의 바이트를 사본으로 돌려준다 (FR-TRS-2).
//
// ok=false 는 "재개할 수 없다" 는 뜻이며, 호출자는 전량 재생으로 강등한다.
// off==end(완전 동기)는 빈 슬라이스에 ok=true 다 — 보낼 것이 없는 것과
// 재개할 수 없는 것은 다른 사실이다.
func (s *Stream) Since(off int64) (data []byte, end int64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	end = s.totalIn.Load()
	if off < 0 || off > end {
		return nil, end, false
	}
	ret := s.retainedLocked()
	start := end - int64(ret)
	if off < start {
		return nil, end, false
	}
	return s.tailLocked(int(end - off)), end, true
}

// Snapshot은 현재 유지된 tail을 복사해 반환한다. Stats도 함께 반환.
func (s *Stream) Snapshot() ([]byte, Stats) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.tailLocked(s.retainedLocked())
	return out, Stats{
		TotalBytesIn:   s.totalIn.Load(),
		TotalBytesDrop: s.totalDrop.Load(),
		Retained:       len(out),
	}
}

// Len은 현재 유지된 바이트 수를 반환한다.
func (s *Stream) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.retainedLocked()
}

// Close는 버퍼를 놓는다. 좌표(Offset)는 그대로다. 이후 Feed 는 빈 창에서 다시 쌓는다.
func (s *Stream) Close() {
	s.mu.Lock()
	s.buf, s.head, s.full, s.vlen = nil, 0, false, 0
	s.mu.Unlock()
}
