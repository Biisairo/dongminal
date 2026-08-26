package httpapi

import (
	"dongminal/internal/webserver/hub"

	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TC-RCR-4: POST /api/commands 생성명령 → 응답에 newTabs/newPanes + 기존 필드.
func TestHandleCommandPost_CreatingReturnsNewIds(t *testing.T) {
	fb := &fakeCommandBroker{
		awaitDelivered: 1,
		awaitResult: hub.CmdResult{
			NewPanes: []string{"r10"},
			NewTabs:  []hub.TabRef{{UUID: "t10", ToolID: "410"}},
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
	if tab0["uuid"] != "t10" || tab0["toolId"] != "410" {
		t.Errorf("newTabs[0]=%v", tab0)
	}
	newPanes, _ := got["newPanes"].([]interface{})
	if len(newPanes) != 1 || newPanes[0] != "r10" {
		t.Errorf("newPanes=%v", got["newPanes"])
	}
}

// TC-RCR-5: 비생성 명령은 기존 응답 (새 필드 없음).
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
// TC-RCR-6: POST /api/command-result → DeliverResult 라우팅, 미지 reqId 도 200.
func TestHandleCommandResult_RoutesToDeliver(t *testing.T) {
	fb := &fakeCommandBroker{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/command-result", "application/json",
		bytes.NewReader([]byte(`{"reqId":"abc","newTabs":[{"uuid":"t1","toolId":"401"}]}`)))
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
