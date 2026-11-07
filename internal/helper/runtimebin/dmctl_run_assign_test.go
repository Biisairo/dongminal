package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
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
