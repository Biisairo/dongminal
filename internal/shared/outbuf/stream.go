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
// end 는 이 청크를 포함한 **누적 입력 바이트**다 (FR-TRS-1). compaction 이
// 일어나도 되감기지 않는 절대 좌표이며, 재접속의 재개 지점이 이 좌표계에 있다.
func (s *Stream) Feed(p []byte) (dropped int, end int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	end = s.totalIn.Add(int64(len(p)))
	s.buf = append(s.buf, p...)
	if over := len(s.buf) - s.max; over > 0 && len(s.buf) > 2*s.max {
		s.buf = append(s.buf[:0], s.buf[over:]...)
		dropped = over
		s.totalDrop.Add(int64(over))
	}
	return
}

// Offset은 현재까지의 누적 입력 바이트를 돌려준다 (FR-TRS-1).
func (s *Stream) Offset() int64 { return s.totalIn.Load() }

// retainedLocked 는 지금 돌려줄 수 있는 tail 의 길이다. Snapshot 이 자르는
// 길이와 **같아야 한다** — 두 창이 갈리면 "스냅샷에는 있는데 재개는 안 되는"
// 구간이 생긴다 (FR-TRS-2).
func (s *Stream) retainedLocked() int {
	if len(s.buf) > s.max {
		return s.max
	}
	return len(s.buf)
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
	tail := s.buf[len(s.buf)-ret:]
	out := make([]byte, int64(ret)-(off-start))
	copy(out, tail[off-start:])
	return out, end, true
}

// Snapshot은 현재 유지된 tail을 복사해 반환한다. Stats도 함께 반환.
func (s *Stream) Snapshot() ([]byte, Stats) {
	s.mu.Lock()
	defer s.mu.Unlock()
	start := len(s.buf) - s.retainedLocked()
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
	return s.retainedLocked()
}

// Close는 리소스를 정리한다. 이후 호출은 no-op.
func (s *Stream) Close() {
	s.cancel()
	s.mu.Lock()
	s.buf = nil
	s.mu.Unlock()
}
