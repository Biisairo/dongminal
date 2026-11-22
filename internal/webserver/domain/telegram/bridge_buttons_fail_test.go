package telegram

import (
	"slices"
	"testing"
)

// ATTIC_FIX_SRS TC-ATF-41: 걷기에 실패한 메시지는 추적에 남아 다음 해제 때 다시 걷는다 (AT-TG-4).
func TestBridgeClearKeepsFailedButtons(t *testing.T) {
	r := newRig(t)
	r.attn(tabA, "done")
	r.attn(tabA, "done")
	r.attn(tabA, "done")
	r.tg.mu.Lock()
	r.tg.failEdits = map[float64]bool{2: true}
	r.tg.mu.Unlock()
	r.clear(tabA)
	r.b.mu.Lock()
	left := slices.Clone(r.b.buttons[tabA])
	r.b.mu.Unlock()
	if !slices.Equal(left, []int64{2}) {
		t.Fatalf("남은 버튼 %v, want [2]", left)
	}
	r.tg.mu.Lock()
	r.tg.failEdits = nil
	r.tg.mu.Unlock()
	r.clear(tabA)
	if got := r.tg.edited(); len(got) != 4 || got[3] != 2 {
		t.Fatalf("실패한 버튼을 다시 걷지 않았다: %v", got)
	}
	r.b.mu.Lock()
	_, ok := r.b.buttons[tabA]
	r.b.mu.Unlock()
	if ok {
		t.Fatal("걷은 탭의 목록이 남았다")
	}
}

// TC-ATF-41: [읽음] 을 눌러 걷다가 실패해도 그 메시지는 추적에 남는다.
func TestBridgeReadPressKeepsFailedButton(t *testing.T) {
	r := newRig(t)
	r.attn(tabA, "done")
	r.tg.mu.Lock()
	r.tg.failEdits = map[float64]bool{1: true}
	r.tg.mu.Unlock()
	r.pressOn(me, "r:"+tabA, 1)
	r.b.mu.Lock()
	left := slices.Clone(r.b.buttons[tabA])
	r.b.mu.Unlock()
	if !slices.Equal(left, []int64{1}) {
		t.Fatalf("남은 버튼 %v, want [1]", left)
	}
}
