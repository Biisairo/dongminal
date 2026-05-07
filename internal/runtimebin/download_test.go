package runtimebin

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunDownloadAbsolutizes(t *testing.T) {
	dir := t.TempDir()
	rel := filepath.Join(dir, "x.txt")
	os.WriteFile(rel, []byte("hi"), 0o644)
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	os.Chdir(dir)

	var stdout, stderr bytes.Buffer
	rc := runDownload([]string{"x.txt"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	out := stdout.String()
	if !strings.HasPrefix(out, "\033]777;Download;") || !strings.HasSuffix(out, "\007") {
		t.Errorf("OSC envelope mismatch: %q", out)
	}
	if !strings.Contains(out, dir) {
		t.Errorf("expected absolute path containing %s, got %q", dir, out)
	}
}

func TestRunDownloadEmpty(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDownload(nil, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	if stdout.String() != "\033]777;Download;\007" {
		t.Errorf("got=%q", stdout.String())
	}
}
