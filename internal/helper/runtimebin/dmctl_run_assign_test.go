package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// ISSUE_TREE_OPS_SRS 묶음 A — dmctl run member 의 배정 플래그와 run assign (FR-ITA-1·4).

func TestRunMember_AssignFlags(t *testing.T) {
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write([]byte(`{"id":"m1","role":"ccr#32›33","agent":"claude","toolId":"t","state":"starting","createdAt":1}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	rc := runDmctl([]string{"run", "member", "--run", "r1", "--role", "ccr#32›33", "--agent", "claude", "--at", "tab-1",
		"--issue", "o/r#33", "--title", "피킹", "--parent", "m0", "--goal", "35 37", "--parallel", "--ctx", "40", "--no-commit"}, &out, &errs)
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	a, _ := got["assign"].(map[string]any)
	want := map[string]any{"issue": "o/r#33", "title": "피킹", "parent": "m0", "goal": "35 37", "parallel": true, "ctxPct": float64(40), "noCommit": true}
	for k, v := range want {
		if a[k] != v {
			t.Errorf("assign[%s]=%v want %v (body=%v)", k, a[k], v, got)
		}
	}
}

func TestRunMember_NoAssignWithoutIssue(t *testing.T) {
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write([]byte(`{"id":"m1","role":"x","agent":"claude","toolId":"t","state":"starting","createdAt":1}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "member", "--run", "r1", "--role", "x", "--agent", "claude", "--at", "tab-1"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if _, ok := got["assign"]; ok {
		t.Fatalf("이슈 없이 배정을 보냈다: %v", got)
	}
	if rc := runDmctl([]string{"run", "member", "--run", "r1", "--role", "x", "--agent", "claude", "--at", "tab-1", "--ctx", "40"}, &out, &errs); rc != 2 {
		t.Errorf("--issue 없는 배정 플래그 rc=%d", rc)
	}
	if rc := runDmctl([]string{"run", "member", "--run", "r1", "--role", "x", "--agent", "claude", "--at", "tab-1", "--issue", "o/r#1", "--ctx", "abc"}, &out, &errs); rc != 2 {
		t.Errorf("숫자 아닌 --ctx rc=%d", rc)
	}
}

func TestRunAssign_SendsPatch(t *testing.T) {
	var path string
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write([]byte(`{"member":{"id":"m1","assign":{"issue":"o/r#33","ctxPct":45}}}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "assign", "--member", "m1", "--ctx", "45"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if path != "/api/runs/assign" || got["memberId"] != "m1" || got["ctxPct"] != float64(45) {
		t.Fatalf("path=%s body=%v", path, got)
	}
	if _, ok := got["goal"]; ok {
		t.Errorf("주지 않은 필드를 보냈다: %v", got)
	}
	if rc := runDmctl([]string{"run", "assign", "--ctx", "45"}, &out, &errs); rc != 2 {
		t.Errorf("--member 없음 rc=%d", rc)
	}
}

// ISSUE_TREE_OPS_SRS FR-ITB-1: 자기 승계는 --member 없이 요약을 싣는다.
func TestRunSucceed_SelfSendsSummary(t *testing.T) {
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write([]byte(`{"member":{"id":"m2","role":"r","toolId":"t2","state":"starting","createdAt":1},"prevMemberId":"m1","prevState":"succeeded","hasSummary":true}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "succeed", "--self", "--at", "tab-2", "--summary", "여기까지"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if got["self"] != true || got["summary"] != "여기까지" || got["at"] != "tab-2" {
		t.Fatalf("body=%v", got)
	}
	if rc := runDmctl([]string{"run", "succeed", "--self", "--at", "tab-2"}, &out, &errs); rc != 2 {
		t.Errorf("요약 없는 자기 승계 rc=%d", rc)
	}
	if rc := runDmctl([]string{"run", "succeed", "--self", "--member", "m1", "--at", "tab-2", "--summary", "s"}, &out, &errs); rc != 2 {
		t.Errorf("--self 와 --member 함께 rc=%d", rc)
	}
}

// ISSUE_TREE_OPS_SRS FR-ITB-4: node_taken 거절이 쥔 멤버와 이어받기 안내를 보인다.
func TestRunMember_NodeTakenPrintsHolder(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"node_taken","detail":"node_taken","memberId":"m9","state":"lost","hint":"dmctl run succeed --member m9 --at <새 탭 uuid> 로 이어받는다"}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	rc := runDmctl([]string{"run", "member", "--run", "r1", "--role", "x", "--agent", "claude", "--at", "t", "--issue", "o/r#1"}, &out, &errs)
	if rc == 0 || !strings.Contains(errs.String(), "memberId=m9  state=lost") || !strings.Contains(errs.String(), "dmctl run succeed --member m9") {
		t.Fatalf("rc=%d stderr=%s", rc, errs.String())
	}
}

// ISSUE_TREE_CLOSE_SRS FR-ITX-7: run coordinate 는 --to 를 보내고 옮긴 Run 을 적는다.
func TestRunCoordinate_SendsTarget(t *testing.T) {
	var path string
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write([]byte(`{"to":"tool-c","moved":["run-1"]}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "coordinate", "--to", "tool-c"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if path != "/api/runs/coordinate" || got["to"] != "tool-c" {
		t.Fatalf("path=%s body=%v", path, got)
	}
	if !strings.Contains(out.String(), "run=run-1") {
		t.Errorf("옮긴 Run 을 적지 않았다: %s", out.String())
	}
	if rc := runDmctl([]string{"run", "coordinate"}, &out, &errs); rc != 2 {
		t.Errorf("--to 없음 rc=%d", rc)
	}
}
