package hub

import (
	"testing"
	"time"
)

// TC-RCR-1: BroadcastAndAwait 가 DeliverResult 로 전달된 결과를 반환.
func TestCommandHub_AwaitDelivers(t *testing.T) {
	h := NewCommandHub()
	sub := h.Add() // delivered>0 이 되도록 구독자 1
	defer h.Remove(sub)

	reqId := "req-1"
	want := CmdResult{
		NewPanes: []string{"r10"},
		NewTabs:  []TabRef{{UUID: "t10", ToolID: "410"}},
	}
	go func() {
		// 구독자 채널을 비워 broadcast 가 막히지 않게.
		<-sub.Messages()
		time.Sleep(10 * time.Millisecond)
		h.DeliverResult(reqId, want)
	}()

	res, delivered, timedOut := h.BroadcastAndAwait([]byte(`{"action":"splitH","reqId":"req-1"}`), reqId, time.Second)
	if timedOut {
		t.Fatal("unexpected timeout")
	}
	if delivered != 1 {
		t.Errorf("delivered=%d want 1", delivered)
	}
	if len(res.NewTabs) != 1 || res.NewTabs[0].UUID != "t10" || res.NewTabs[0].ToolID != "410" {
		t.Errorf("newTabs=%+v", res.NewTabs)
	}
	if len(res.NewPanes) != 1 || res.NewPanes[0] != "r10" {
		t.Errorf("newPanes=%+v", res.NewPanes)
	}
}

// TC-RCR-2: DeliverResult 없으면 timeout 후 빈 결과 + timedOut=true.
// TC-RCR-2: DeliverResult 없으면 timeout 후 빈 결과 + timedOut=true.
func TestCommandHub_AwaitTimeout(t *testing.T) {
	h := NewCommandHub()
	sub := h.Add()
	defer h.Remove(sub)
	go func() { <-sub.Messages() }() // broadcast 드레인

	res, delivered, timedOut := h.BroadcastAndAwait([]byte(`{"action":"splitH"}`), "req-2", 30*time.Millisecond)
	if !timedOut {
		t.Fatal("expected timeout")
	}
	if delivered != 1 {
		t.Errorf("delivered=%d want 1", delivered)
	}
	if len(res.NewTabs) != 0 || len(res.NewPanes) != 0 || len(res.NewWindows) != 0 {
		t.Errorf("expected empty result, got %+v", res)
	}
	// pending 누수 없음 (TC-RCR-11 일부).
	if n := h.pendingCount(); n != 0 {
		t.Errorf("pending leak: %d", n)
	}
}

// TC-RCR-3: 구독자 없음(delivered=0) 이면 대기하지 않고 즉시 반환.
// TC-RCR-3: 구독자 없음(delivered=0) 이면 대기하지 않고 즉시 반환.
func TestCommandHub_AwaitNoSubscriber(t *testing.T) {
	h := NewCommandHub()
	start := time.Now()
	res, delivered, timedOut := h.BroadcastAndAwait([]byte(`{"action":"splitH"}`), "req-3", time.Second)
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Errorf("should return immediately, took %v", elapsed)
	}
	if delivered != 0 {
		t.Errorf("delivered=%d want 0", delivered)
	}
	if timedOut {
		t.Error("timedOut should be false when no subscriber")
	}
	if len(res.NewTabs) != 0 {
		t.Errorf("expected empty result")
	}
	if n := h.pendingCount(); n != 0 {
		t.Errorf("pending leak: %d", n)
	}
}

// TC-RCR-6: 미지/만료 reqId 에 DeliverResult → no-op, 패닉 없음.
// TC-RCR-6: 미지/만료 reqId 에 DeliverResult → no-op, 패닉 없음.
func TestCommandHub_DeliverUnknownReqId(t *testing.T) {
	h := NewCommandHub()
	h.DeliverResult("nonexistent", CmdResult{NewTabs: []TabRef{{UUID: "x"}}})
	// 패닉 없이 통과하면 성공.
}

// TC-RCR-11: 다수 timeout 후 pending 맵 누수 없음.
// TC-RCR-11: 다수 timeout 후 pending 맵 누수 없음.
func TestCommandHub_NoPendingLeak(t *testing.T) {
	h := NewCommandHub()
	sub := h.Add()
	defer h.Remove(sub)
	go func() {
		for range sub.Messages() {
		}
	}()
	for i := 0; i < 20; i++ {
		h.BroadcastAndAwait([]byte(`{"action":"splitH"}`), NewReqId(), 5*time.Millisecond)
	}
	if n := h.pendingCount(); n != 0 {
		t.Errorf("pending leak after 20 timeouts: %d", n)
	}
}

// 생성 명령 판별.
// 생성 명령 판별.
func TestIsCreatingAction(t *testing.T) {
	for _, a := range []string{"splitH", "splitV", "newTab", "newWindow"} {
		if !IsCreatingAction(a) {
			t.Errorf("%s should be creating", a)
		}
	}
	for _, a := range []string{"focus", "closeTab", "renameTab", "paneUp", "windowNext"} {
		if IsCreatingAction(a) {
			t.Errorf("%s should NOT be creating", a)
		}
	}
}

// TC-RCR-4: POST /api/commands 생성명령 → 응답에 newTabs/newPanes + 기존 필드.
// newReqId 는 호출마다 유일.
func TestNewReqId_Unique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := NewReqId()
		if id == "" || seen[id] {
			t.Fatalf("non-unique or empty reqId: %q", id)
		}
		seen[id] = true
	}
}
