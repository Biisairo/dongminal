package outbuf

import (
	"context"
	"sync"
	"sync/atomic"
)

// Stream 은 PTY writer 와 MCP/WS reader 를 통합한 단일 진입점 바운디드 버퍼다.
//
// Backpressure / drop 정책 (S4 SRS):
//   - Feed 는 절대 블록되지 않는다. 짧은 mutex 만 잡는다.
//   - 보유량이 max 이상 ~ 2*max 미만 구간이면 tail 은 그대로 보존되고,
//     Snapshot 시점에 max 만큼만 잘려 반환된다 (loss 가 아니라 retention).
//   - 보유량이 2*max 를 초과하면 compaction 이 일어나 head 가 잘린다.
//     이 분량만 Stats.TotalBytesDrop 에 누적된다.
//   - 호출자는 다른 곳에 별도 buffered channel 을 두어 silent drop 경로를
//     만들지 않아야 한다 (single drop path 원칙).
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
// 실제 compaction 으로 소실된 바이트 수를 반환한다(없으면 0).
// totalDrop 은 실제 compaction 으로 소실된 누적 바이트이며, max~2*max 구간의
// tail-over 바이트는 Snapshot 시점에 잘려 나올 뿐 손실은 아니므로 카운트하지 않는다.
func (s *Stream) Feed(p []byte) (dropped int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.totalIn.Add(int64(len(p)))
	s.buf = append(s.buf, p...)
	if over := len(s.buf) - s.max; over > 0 && len(s.buf) > 2*s.max {
		s.buf = append(s.buf[:0], s.buf[over:]...)
		dropped = over
		s.totalDrop.Add(int64(over))
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
