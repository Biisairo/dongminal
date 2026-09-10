package hub

import "testing"

// 04-secops P1-4 — 구독 수에 상한이 없었다.
//
// 구독 하나가 goroutine 하나이고 채널 버퍼를 든다. 상한이 없으면 연결을 여는
// 것만으로 서버 메모리를 정할 수 있었다.
func TestCommandHub_SubCap(t *testing.T) {
	h := NewCommandHub()
	for i := 0; i < SubCap; i++ {
		if h.Add() == nil {
			t.Fatalf("상한 안(%d/%d)인데 거절됐다", i, SubCap)
		}
	}
	if h.Add() != nil {
		t.Fatalf("상한을 넘겨 등록됐다 (cap=%d)", SubCap)
	}
}

// 하나가 나가면 그 자리가 다시 열린다 — 상한이 영구 잠금이 되면 안 된다.
func TestCommandHub_SubCapFreesOnRemove(t *testing.T) {
	h := NewCommandHub()
	var first *CmdSub
	for i := 0; i < SubCap; i++ {
		s := h.Add()
		if i == 0 {
			first = s
		}
	}
	if h.Add() != nil {
		t.Fatalf("상한을 넘겨 등록됐다")
	}
	h.Remove(first)
	if h.Add() == nil {
		t.Fatalf("자리가 났는데 여전히 거절한다")
	}
}

// nil 구독을 Remove 해도 터지지 않는다 — 거절된 구독의 정리 경로가 그것이다.
func TestCommandHub_RemoveNilIsSafe(t *testing.T) {
	NewCommandHub().Remove(nil)
}
