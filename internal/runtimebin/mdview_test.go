package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestRunMdviewMissing(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runMdview([]string{"/no/such/file.md"}, &stdout, &stderr)
	if rc != 1 {
		t.Errorf("rc=%d", rc)
	}
}

func TestRunMdviewSendsAction(t *testing.T) {
	dir := t.TempDir()
	// 따옴표·한글·역슬래시 포함 파일명으로 JSON escape 검증
	name := `weird "name" 한글.md`
	target := filepath.Join(dir, name)
	if err := os.WriteFile(target, []byte("# t"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	cleanup := withServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte("{}"))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runMdview([]string{target}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "openMdTab" {
		t.Errorf("action=%v", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["name"] != name {
		t.Errorf("name=%v want %v", args["name"], name)
	}
	if args["filePath"] != target {
		t.Errorf("filePath=%v want %v", args["filePath"], target)
	}
}
