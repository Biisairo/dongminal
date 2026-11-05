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

// ISSUE_AGENT_TREE_SRS FR-ORD-6 · FR-WGR-30: 이동 결과의 최종 위치와 오류, 새 그룹 id 를 돌려준다.
func TestHandleCommandPost_MoveReturnsPosition(t *testing.T) {
	fb := &fakeCommandBroker{
		awaitDelivered: 1,
		awaitResult:    hub.CmdResult{Position: &hub.CmdPosition{Container: "top", Index: 2, Count: 3}},
	}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/commands", "application/json",
		strings.NewReader(`{"action":"moveWindow","args":{"index":2}}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	var got map[string]any
	json.NewDecoder(resp.Body).Decode(&got)
	pos, _ := got["position"].(map[string]any)
	if pos == nil || pos["container"] != "top" || pos["index"] != float64(2) || pos["count"] != float64(3) {
		t.Fatalf("position=%v (전체 %v)", got["position"], got)
	}
	if _, ok := got["error"]; ok {
		t.Errorf("성공인데 error 가 실렸다: %v", got)
	}
}

func TestHandleCommandPost_MoveReturnsError(t *testing.T) {
	fb := &fakeCommandBroker{awaitDelivered: 1, awaitResult: hub.CmdResult{Error: "out_of_range"}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/commands", "application/json",
		strings.NewReader(`{"action":"moveTab","args":{"index":9}}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	var got map[string]any
	json.NewDecoder(resp.Body).Decode(&got)
	if got["error"] != "out_of_range" {
		t.Fatalf("error=%v (전체 %v)", got["error"], got)
	}
}

func TestHandleCommandPost_NewGroupReturnsID(t *testing.T) {
	fb := &fakeCommandBroker{awaitDelivered: 1, awaitResult: hub.CmdResult{NewGroups: []string{"g1"}}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/commands", "application/json",
		strings.NewReader(`{"action":"newGroup","args":{"name":"G"}}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	var got map[string]any
	json.NewDecoder(resp.Body).Decode(&got)
	g, _ := got["newGroups"].([]any)
	if len(g) != 1 || g[0] != "g1" {
		t.Fatalf("newGroups=%v", got["newGroups"])
	}
}

// 브라우저 회신이 새 필드를 서버까지 나른다.
func TestHandleCommandResult_CarriesOrderFields(t *testing.T) {
	fb := &fakeCommandBroker{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: fb})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	body := `{"reqId":"r1","newGroups":["g1"],"position":{"container":"g1","index":1,"count":1},"error":""}`
	resp, err := http.Post(ts.URL+"/api/command-result", "application/json", bytes.NewReader([]byte(body)))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("POST: %v %v", err, resp)
	}
	resp.Body.Close()
	if fb.delivered.Position == nil || fb.delivered.Position.Container != "g1" || len(fb.delivered.NewGroups) != 1 {
		t.Fatalf("delivered=%+v", fb.delivered)
	}
}
