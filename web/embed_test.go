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

// TestVendorDirsEmbedded 는 바이너리에 실리는 디렉터리 자산이 지금 쓰는 편집기 엔진 하나뿐인지 확인한다
// (CODEMIRROR_MIGRATION_SRS FR-CMR-130). 옛 엔진의 트리가 남으면 쓰지 않는 수 MB 가 바이너리에 실린다.
func TestVendorDirsEmbedded(t *testing.T) {
	ents, err := fs.ReadDir(FS(), "vendor")
	if err != nil {
		t.Fatalf("vendor 읽기 실패: %v", err)
	}
	var dirs []string
	for _, e := range ents {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	if len(dirs) != 1 || dirs[0] != "codemirror" {
		t.Fatalf("vendor 의 디렉터리 자산 = %v, want [codemirror]", dirs)
	}
}
