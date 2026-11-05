package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// ISSUE_AGENT_TREE_SRS 묶음 U·D — dmctl run start --tree/--branch · tree_open 안내 · run tree.

func TestRunStart_TreeFlags(t *testing.T) {
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write([]byte(`{"id":"r1","short":"r1","state":"open","projection":"dedicated-window","isolation":"none"}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "start", "--objective", "o", "--tree", "o/r#32", "--branch"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if got["tree"] != "o/r#32" || got["treeBranch"] != true {
		t.Fatalf("body=%v", got)
	}
	if rc := runDmctl([]string{"run", "start", "--objective", "o", "--branch"}, &out, &errs); rc != 2 {
		t.Errorf("--tree 없는 --branch rc=%d", rc)
	}
	if rc := runDmctl([]string{"run", "start", "--objective", "o", "--tree", "bad"}, &out, &errs); rc != 2 {
		t.Errorf("잘못된 --tree rc=%d", rc)
	}
}

func TestRunStart_TreeOpenRefusalTellsStale(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"tree_open","detail":"tree_open","runId":"r9","stale":true}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	rc := runDmctl([]string{"run", "start", "--objective", "o", "--tree", "o/r#32"}, &out, &errs)
	if rc == 0 || !strings.Contains(errs.String(), "r9") || !strings.Contains(errs.String(), "run close --run r9 --force") {
		t.Fatalf("rc=%d stderr=%s", rc, errs.String())
	}
}

func TestRunTree_PrintsNodes(t *testing.T) {
	var path string
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.RequestURI()
		w.Write([]byte(`{"tree":"o/r#32","runs":[{"id":"r1"}],"nodes":[
{"role":"ccr#32","state":"ready","parent":"","leaf":false,"toolId":"t1"},
{"role":"ccr#32›33","state":"working","parent":"ccr#32","leaf":true,"toolId":"t2","contextRatio":0.42}]}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "tree", "--ref", "o/r#32"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if !strings.Contains(path, "/api/runs/tree?ref=o%2Fr%2332") {
		t.Errorf("path=%s", path)
	}
	s := out.String()
	for _, want := range []string{"ccr#32  state=ready", "  ccr#32›33  state=working  leaf  ctx=42%  toolId=t2"} {
		if !strings.Contains(s, want) {
			t.Errorf("출력에 %q 가 없다:\n%s", want, s)
		}
	}
}
