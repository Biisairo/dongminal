//go:build !windows

package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// POSIX 셸 표본이다 — Windows 의 셸 실행은 TC-SLP-6 이 따로 확인한다.

// TC-SLP-1·3: 하위 명령은 받은 바이트를 그대로 받고, 그 출력이 그대로 나간다. 설정은 그대로다.
func TestStatuslineProxy_PassThrough(t *testing.T) {
	home := t.TempDir()
	proj := t.TempDir()
	got := filepath.Join(t.TempDir(), "got.txt")
	cmd := "cat > " + got + "; printf 'LINE-OUT'"
	settings := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settings), 0o755)
	orig := []byte(`{"statusLine":{"type":"command","command":` + strconvQuote(cmd) + `}}`)
	os.WriteFile(settings, orig, 0o644)

	var posted map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &posted)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	in := strings.ReplaceAll(slSample, "PROJ", proj)
	var stdout, stderr bytes.Buffer
	rc := runStatusline(strings.NewReader(in), &stdout, &stderr, map[string]string{"HOME": home, "DONGMINAL_TOOL_ID": "tool-1"})
	if rc != 0 || stdout.String() != "LINE-OUT" {
		t.Fatalf("rc=%d stdout=%q stderr=%s", rc, stdout.String(), stderr.String())
	}
	b, _ := os.ReadFile(got)
	if string(b) != in {
		t.Errorf("하위 명령이 받은 stdin 이 원본과 다르다 (NFR-SLP-2)")
	}
	after, _ := os.ReadFile(settings)
	if !bytes.Equal(after, orig) {
		t.Errorf("하위 설정 파일이 바뀌었다 (FR-SLP-7)")
	}
	if posted["toolId"] != "tool-1" || posted["usage"] == nil {
		t.Errorf("보고가 없다: %v", posted)
	}
}

// TC-SLP-2: 서버가 답하지 않아도 표시는 막히지 않는다.
func TestStatuslineProxy_ServerHangDoesNotBlock(t *testing.T) {
	release := make(chan struct{})
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { <-release })
	defer func() { close(release); cleanup() }()
	home := t.TempDir()
	settings := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settings), 0o755)
	os.WriteFile(settings, []byte(`{"statusLine":{"type":"command","command":"printf OK"}}`), 0o644)
	start := time.Now()
	var stdout, stderr bytes.Buffer
	rc := runStatusline(strings.NewReader(slSample), &stdout, &stderr, map[string]string{"HOME": home, "DONGMINAL_TOOL_ID": "t"})
	if rc != 0 || stdout.String() != "OK" {
		t.Fatalf("rc=%d out=%q", rc, stdout.String())
	}
	if el := time.Since(start); el > 600*time.Millisecond {
		t.Errorf("서버 지연이 표시를 막았다: %v", el)
	}
}
