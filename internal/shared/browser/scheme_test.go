package browser

import (
	"os"
	"path/filepath"
	"testing"
)

// TC-BRT-53: scheme 표 — 허용 넷 통과, 나머지 거절.
func TestCheckURL(t *testing.T) {
	for _, u := range []string{"http://x", "https://x.example/a?b", "file:///tmp/a.html", "about:blank", "HTTP://X"} {
		if err := CheckURL(u); err != nil {
			t.Errorf("%q 거절됨: %v", u, err)
		}
	}
	for _, u := range []string{"javascript:alert(1)", "data:text/html,x", "chrome://settings", "devtools://devtools",
		"chrome-extension://abc/x", "about:config", "ftp://x", "", "mailto:a@b"} {
		if err := CheckURL(u); err == nil {
			t.Errorf("%q 가 통과했다", u)
		}
	}
}

// TC-BRT-53: 상대 경로·Windows 경로 → file://. 없는 경로는 거절 (FR-BRT-66).
func TestResolveTarget(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "a b.html")
	os.WriteFile(f, []byte("x"), 0o600)
	got, err := ResolveTarget("a b.html", dir, stat)
	if err != nil {
		t.Fatal(err)
	}
	if got != fileURL(f) {
		t.Fatalf("got %q", got)
	}
	if _, err := ResolveTarget("nope.html", dir, stat); err == nil {
		t.Fatal("없는 경로가 통과했다")
	}
	if got, err := ResolveTarget("https://x.example", dir, stat); err != nil || got != "https://x.example" {
		t.Fatalf("URL 은 그대로: %q %v", got, err)
	}
	if _, err := ResolveTarget("javascript:1", dir, stat); err == nil {
		t.Fatal("javascript: 가 경로로 읽혔다")
	}
	// localhost:3000 처럼 스킴 없는 주소는 경로가 아니라 http 다 — 없는 경로라도.
	if got, err := ResolveTarget("localhost:3000", dir, stat); err != nil || got != "http://localhost:3000" {
		t.Fatalf("localhost:3000 → %q %v", got, err)
	}
}

func TestWindowsFileURL(t *testing.T) {
	if got := winPathURL(`C:\a\b c.html`); got != "file:///C:/a/b%20c.html" {
		t.Fatalf("got %q", got)
	}
}

func stat(p string) error { _, err := os.Stat(p); return err }
