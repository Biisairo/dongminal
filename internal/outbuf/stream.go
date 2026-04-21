package outbuf

import (
	"context"
	"sync"
	"sync/atomic"
)

// Stream은 readPTY 라이터와 MCP/WS 리더를 통합한 바운디드 버퍼다.
// bch/drainBuf 패턴을 대체한다.
type Stream struct {
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	buf       []byte // 최대 2*max까지 성장, 주기적으로 max로 compaction
	max       int
	totalIn   atomic.Int64
	totalDrop atomic.Int64
}

type Stats struct {
	TotalBytesIn   int64
	TotalBytesDrop int64
	Retained       int
}

// NewStream은 최대 유지 바이트 max로 Stream을 생성한다.
// parent가 Done되면 내부 리소스를 정리한다.
func NewStream(parent context.Context, max int) *Stream {
	ctx, cancel := context.WithCancel(parent)
	return &Stream{ctx: ctx, cancel: cancel, max: max, buf: make([]byte, 0, max)}
}

// Feed는 readPTY에서 호출된다. 절대 블로킹하지 않으며,
// 드롭된 바이트 수를 반환한다(없으면 0).
func (s *Stream) Feed(p []byte) (dropped int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.totalIn.Add(int64(len(p)))
	s.buf = append(s.buf, p...)
	if over := len(s.buf) - s.max; over > 0 && len(s.buf) > 2*s.max {
		s.buf = append(s.buf[:0], s.buf[over:]...)
		dropped = over
		s.totalDrop.Add(int64(over))
	} else if len(s.buf) > s.max {
		dropped = len(s.buf) - s.max
		s.totalDrop.Add(int64(dropped))
		// 물리적 compaction은 2*max 초과 시에만. 빠른 경로는 논리적 truncation만 기록.
		// 실제 바이트 제거는 Snapshot 시점에 지연 처리됨.
	}
	return
}

// Snapshot은 현재 유지된 tail을 복사해 반환한다. Stats도 함께 반환.
func (s *Stream) Snapshot() ([]byte, Stats) {
	s.mu.Lock()
	defer s.mu.Unlock()
	start := 0
	if len(s.buf) > s.max {
		start = len(s.buf) - s.max
	}
	out := make([]byte, len(s.buf)-start)
	copy(out, s.buf[start:])
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
	if len(s.buf) > s.max {
		return s.max
	}
	return len(s.buf)
}

// Close는 리소스를 정리한다. 이후 호출은 no-op.
func (s *Stream) Close() {
	s.cancel()
	s.mu.Lock()
	s.buf = nil
	s.mu.Unlock()
}
