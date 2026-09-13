package runfile

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestHeadlessToolIDs_OpenHeadlessOnly(t *testing.T) {
	dir := write(t, `{"schemaVersion":1,"runs":[
	  {"id":"r1","state":"open","members":[
	    {"id":"m1","toolId":"t-open-headless","headless":true},
	    {"id":"m2","toolId":"t-open-tabbed","tabId":"tab","headless":true},
	    {"id":"m3","toolId":"t-open-tui"}
	  ]},
	  {"id":"r2","state":"closed","members":[{"id":"m4","toolId":"t-closed","headless":true}]},
	  {"id":"r3","state":"aborted","members":[{"id":"m5","toolId":"t-aborted","headless":true}]}
	]}`)
	got := HeadlessToolIDs(dir)
	if len(got) != 1 {
		t.Fatalf("want 1, got %v", got)
	}
	if _, ok := got["t-open-headless"]; !ok {
		t.Fatalf("t-open-headless 가 빠졌다: %v", got)
	}
}

func TestHeadlessToolIDs_FailuresAreEmpty(t *testing.T) {
	if got := HeadlessToolIDs(t.TempDir()); len(got) != 0 {
		t.Fatalf("파일 없음 → 빈 집합이어야 한다: %v", got)
	}
	if got := HeadlessToolIDs(write(t, `{not json`)); len(got) != 0 {
		t.Fatalf("깨진 JSON → 빈 집합이어야 한다: %v", got)
	}
}

func TestHeadlessToolIDs_IgnoresUnknownFields(t *testing.T) {
	dir := write(t, `{"schemaVersion":9,"extra":1,"runs":[{"state":"open","future":{"x":1},"members":[{"toolId":"t","headless":true,"worktree":{"path":"/w"}}]}]}`)
	if got := HeadlessToolIDs(dir); len(got) != 1 {
		t.Fatalf("모르는 필드는 무시해야 한다: %v", got)
	}
}
