package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TC-RCR-1: BroadcastAndAwait 가 DeliverResult 로 전달된 결과를 반환.
func TestCommandHub_AwaitDelivers(t *testing.T) {
	h := NewCommandHub()
	sub := h.add() // delivered>0 이 되도록 구독자 1
	defer h.remove(sub)

	reqId := "req-1"
	want := CmdResult{
		NewRegions: []string{"r10"},
		NewTabs:    []TabRef{{UUID: "t10", PaneID: "410"}},
	}
	go func() {
		// 구독자 채널을 비워 broadcast 가 막히지 않게.
		<-sub.ch
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
	if len(res.NewTabs) != 1 || res.NewTabs[0].UUID != "t10" || res.NewTabs[0].PaneID != "410" {
		t.Errorf("newTabs=%+v", res.NewTabs)
	}
	if len(res.NewRegions) != 1 || res.NewRegions[0] != "r10" {
		t.Errorf("newRegions=%+v", res.NewRegions)
	}
}

// TC-RCR-2: DeliverResult 없으면 timeout 후 빈 결과 + timedOut=true.
func TestCommandHub_AwaitTimeout(t *testing.T) {
	h := NewCommandHub()
	sub := h.add()
	defer h.remove(sub)
	go func() { <-sub.ch }() // broadcast 드레인

	res, delivered, timedOut := h.BroadcastAndAwait([]byte(`{"action":"splitH"}`), "req-2", 30*time.Millisecond)
	if !timedOut {
		t.Fatal("expected timeout")
	}
	if delivered != 1 {
		t.Errorf("delivered=%d want 1", delivered)
	}
	if len(res.NewTabs) != 0 || len(res.NewRegions) != 0 || len(res.NewSessions) != 0 {
		t.Errorf("expected empty result, got %+v", res)
	}
	// pending 누수 없음 (TC-RCR-11 일부).
	if n := h.pendingCount(); n != 0 {
		t.Errorf("pending leak: %d", n)
	}
}

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
func TestCommandHub_DeliverUnknownReqId(t *testing.T) {
	h := NewCommandHub()
	h.DeliverResult("nonexistent", CmdResult{NewTabs: []TabRef{{UUID: "x"}}})
	// 패닉 없이 통과하면 성공.
}

// TC-RCR-11: 다수 timeout 후 pending 맵 누수 없음.
func TestCommandHub_NoPendingLeak(t *testing.T) {
	h := NewCommandHub()
	sub := h.add()
	defer h.remove(sub)
	go func() {
		for range sub.ch {
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
func TestIsCreatingAction(t *testing.T) {
	for _, a := range []string{"splitH", "splitV", "newTab", "newSession"} {
		if !IsCreatingAction(a) {
			t.Errorf("%s should be creating", a)
		}
	}
	for _, a := range []string{"focus", "closeTab", "renameTab", "paneUp", "sessionNext"} {
		if IsCreatingAction(a) {
			t.Errorf("%s should NOT be creating", a)
		}
	}
}

// TC-RCR-4: POST /api/commands 생성명령 → 응답에 newTabs/newRegions + 기존 필드.
func TestHandleCommandPost_CreatingReturnsNewIds(t *testing.T) {
	fb := &fakeCommandBroker{
		awaitDelivered: 1,
		awaitResult: CmdResult{
			NewRegions: []string{"r10"},
			NewTabs:    []TabRef{{UUID: "t10", PaneID: "410"}},
		},
	}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/commands", "application/json",
		strings.NewReader(`{"action":"splitH"}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	var got map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&got)

	if got["ok"] != true || got["action"] != "splitH" {
		t.Errorf("base fields wrong: %+v", got)
	}
	tabs, _ := got["newTabs"].([]interface{})
	if len(tabs) != 1 {
		t.Fatalf("newTabs=%v", got["newTabs"])
	}
	tab0 := tabs[0].(map[string]interface{})
	if tab0["uuid"] != "t10" || tab0["paneId"] != "410" {
		t.Errorf("newTabs[0]=%v", tab0)
	}
	regions, _ := got["newRegions"].([]interface{})
	if len(regions) != 1 || regions[0] != "r10" {
		t.Errorf("newRegions=%v", got["newRegions"])
	}
}

// TC-RCR-5: 비생성 명령은 기존 응답 (새 필드 없음).
func TestHandleCommandPost_NonCreatingUnchanged(t *testing.T) {
	fb := &fakeCommandBroker{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/commands", "application/json",
		strings.NewReader(`{"action":"tabNext"}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	var got map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&got)

	if _, ok := got["newTabs"]; ok {
		t.Errorf("non-creating should not have newTabs: %+v", got)
	}
	if _, ok := got["timedOut"]; ok {
		t.Errorf("non-creating should not have timedOut: %+v", got)
	}
	if got["ok"] != true || got["delivered"] == nil {
		t.Errorf("base fields missing: %+v", got)
	}
	// 비생성은 Broadcast 경로 (BroadcastAndAwait 아님) — published 1건.
	if len(fb.published) != 1 {
		t.Errorf("published=%d", len(fb.published))
	}
}

// TC-RCR-6: POST /api/command-result → DeliverResult 라우팅, 미지 reqId 도 200.
func TestHandleCommandResult_RoutesToDeliver(t *testing.T) {
	fb := &fakeCommandBroker{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/command-result", "application/json",
		bytes.NewReader([]byte(`{"reqId":"abc","newTabs":[{"uuid":"t1","paneId":"401"}]}`)))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if len(fb.deliverCalls) != 1 || fb.deliverCalls[0] != "abc" {
		t.Errorf("deliverCalls=%v", fb.deliverCalls)
	}
}

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
