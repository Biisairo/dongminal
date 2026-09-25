package hub

import (
	"bytes"
	"strconv"
	"sync/atomic"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-3-4 (HTTP-5) — 데몬 모드의 모든 출력 push 가 지나는
// FeedOutput 한 번의 비용. 병렬 벤치는 스위퍼·조회와 같은 락을 다투는 모양이다.
func BenchmarkAttnFeedOutput(b *testing.B) {
	tr := NewAttnTracker(nil, 0)
	data := bytes.Repeat([]byte("plain output line\r\n"), 1024/19)
	var seq atomic.Int64
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		id := "t" + strconv.FormatInt(seq.Add(1), 10) // 도구 하나는 읽기 고루틴 하나가 먹인다
		for pb.Next() {
			tr.FeedOutput(id, data)
		}
	})
}
