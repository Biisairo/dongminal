package web

import (
	"io/fs"
	"testing"
)

// TestAssetsEmbedded는 아이콘 자산이 go:embed 패턴에서 누락되지 않았는지 확인한다 (FR-ICON-6).
func TestAssetsEmbedded(t *testing.T) {
	want := []string{
		"assets/favicon.svg", "assets/favicon-16.png", "assets/favicon-32.png",
		"assets/apple-touch-icon.png", "assets/icon-192.png", "assets/icon-512.png",
	}
	for _, n := range want {
		b, err := fs.ReadFile(FS(), n)
		if err != nil {
			t.Fatalf("%s 임베드 안 됨: %v", n, err)
		}
		t.Logf("%s %d bytes", n, len(b))
	}
}
