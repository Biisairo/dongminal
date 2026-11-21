package httpapi

import (
	"testing"

	"dongminal/internal/shared/toolhub"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-1: relayOutput 에서 뗀 판정·합치기 함수.

func TestRelayJoinable(t *testing.T) {
	cases := []struct {
		name string
		c    toolhub.OutChunk
		sent int64
		want bool
	}{
		{"이어지는 출력", toolhub.OutChunk{Data: []byte("ab"), End: 12}, 10, true},
		{"옛 데몬(End=0)", toolhub.OutChunk{Data: []byte("ab")}, 10, true},
		{"구멍", toolhub.OutChunk{Data: []byte("ab"), End: 20}, 10, false},
		{"크기 조각", toolhub.OutChunk{Size: &toolhub.TermSize{}}, 10, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := relayJoinable(c.c, c.sent); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestCoalesceOutput(t *testing.T) {
	chunk := func(s string, end int64) toolhub.OutChunk { return toolhub.OutChunk{Data: []byte(s), End: end} }
	big := make([]byte, relayCoalesceMax)
	cases := []struct {
		name        string
		queued      []toolhub.OutChunk
		close       bool
		wantFrame   string
		wantSent    int64
		wantPending bool
		wantClosed  bool
	}{
		{name: "쌓인 것 없음", wantFrame: "ab", wantSent: 2},
		{name: "이어 붙인다", queued: []toolhub.OutChunk{chunk("cd", 4), chunk("ef", 6)}, wantFrame: "abcdef", wantSent: 6},
		{name: "겹친 구간은 잘라 붙인다", queued: []toolhub.OutChunk{chunk("bcd", 4)}, wantFrame: "abcd", wantSent: 4},
		{name: "구멍은 남긴다", queued: []toolhub.OutChunk{chunk("cd", 4), chunk("zz", 9)}, wantFrame: "abcd", wantSent: 4, wantPending: true},
		{name: "크기 조각은 남긴다", queued: []toolhub.OutChunk{{Size: &toolhub.TermSize{}}}, wantFrame: "ab", wantSent: 2, wantPending: true},
		{name: "상한을 넘으면 남긴다", queued: []toolhub.OutChunk{{Data: big, End: 2 + int64(len(big))}}, wantFrame: "ab", wantSent: 2, wantPending: true},
		{name: "닫힘", queued: []toolhub.OutChunk{chunk("cd", 4)}, close: true, wantFrame: "abcd", wantSent: 4, wantClosed: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ch := make(chan toolhub.OutChunk, len(c.queued))
			for _, q := range c.queued {
				ch <- q
			}
			if c.close {
				close(ch)
			}
			frame, _, sent, pending, closed := coalesceOutput(ch, []byte("ab"), nil, 2)
			if string(frame) != c.wantFrame || sent != c.wantSent || (pending != nil) != c.wantPending || closed != c.wantClosed {
				t.Fatalf("got (%q, sent=%d, pending=%v, closed=%v)", frame, sent, pending != nil, closed)
			}
		})
	}
}
