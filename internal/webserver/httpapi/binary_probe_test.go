package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-9: 이진 판정은 한 함수다 — UTF-16 BOM 이면 NUL 이 있어도 텍스트,
// NUL 은 앞 binaryProbeLen 바이트에서만 본다.
func TestIsBinary_Rule(t *testing.T) {
	late := make([]byte, binaryProbeLen+1)
	for i := range late {
		late[i] = 'a'
	}
	late[binaryProbeLen] = 0
	cases := map[string]struct {
		blob []byte
		want bool
	}{
		"텍스트":       {[]byte("hello"), false},
		"NUL":       {[]byte("a\x00b"), true},
		"UTF-16 LE": {[]byte{0xFF, 0xFE, 'a', 0, 'b', 0}, false},
		"UTF-16 BE": {[]byte{0xFE, 0xFF, 0, 'a', 0, 'b'}, false},
		"UTF-32 LE": {[]byte{0xFF, 0xFE, 0, 0, 'a', 0, 0, 0}, true},
		"폭 밖의 NUL":  {late, false},
	}
	for name, c := range cases {
		if got := isBinary(c.blob); got != c.want {
			t.Errorf("%s: isBinary=%v want %v", name, got, c.want)
		}
	}
}

// TC-RDG-4: 검색이 UTF-16 BOM 파일을 건너뛰지 않는다 (이전: 건너뛰었다). 비교는 바이트다.
func TestGrepWithGo_SearchesUTF16BOM(t *testing.T) {
	dir := t.TempDir()
	blob := append([]byte{0xFF, 0xFE}, []byte("x NEEDLE\n\x00\x00")...)
	if err := os.WriteFile(filepath.Join(dir, "u16.txt"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
	got, _, err := grepWithGo(context.Background(), dir, "needle", 10)
	if err != nil || len(got) != 1 || got[0].Path != "u16.txt" || got[0].Line != 1 {
		t.Fatalf("got %+v err=%v", got, err)
	}
}
