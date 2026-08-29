package runtime

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/platform"
)

// 두 훅 트리가 모두 임베드되어 있고, 각자 기대하는 파일을 정확히 그 이름으로
// 푸는지 확인한다. Windows 훅이 빠지면 PowerShell 이 없는 -File 을 받아
// 즉시 죽는다 — 터미널이 조용히 비는 증상이 된다.
func TestBothHookRootsUnpack(t *testing.T) {
	cases := []struct {
		root string
		want []string
	}{
		{platform.PosixHookRoot, []string{"bash-hook.sh", filepath.Join("zdotdir", ".zshrc")}},
		{platform.WindowsHookRoot, []string{platform.PowerShellHookFile}},
	}
	for _, tc := range cases {
		t.Run(tc.root, func(t *testing.T) {
			dir := t.TempDir()
			if err := unpackEmbedded(shellhookFS, "shellhooks/"+tc.root, dir); err != nil {
				t.Fatalf("unpack: %v", err)
			}
			for _, w := range tc.want {
				p := filepath.Join(dir, w)
				fi, err := os.Stat(p)
				if err != nil {
					t.Fatalf("%s 가 없다: %v", w, err)
				}
				if fi.Size() == 0 {
					t.Fatalf("%s 가 비었다", w)
				}
			}
			// 다른 OS 의 훅이 섞여 나오면 안 된다.
			other := "bash-hook.sh"
			if tc.root == platform.PosixHookRoot {
				other = platform.PowerShellHookFile
			}
			if _, err := os.Stat(filepath.Join(dir, other)); err == nil {
				t.Fatalf("%s 에 다른 OS 의 훅(%s)이 섞였다", tc.root, other)
			}
		})
	}
}

// PowerShell 5.1 은 BOM 이 없는 .ps1 을 **현재 ANSI 코드페이지**로 읽는다.
// 이 훅에는 한국어 주석과 문자열이 있어, BOM 이 빠지면 한글 바이트가 CP949 로
// 잘못 해석되고 그중 하나가 따옴표로 보이면 그 자리에서 구문 오류가 난다.
// PowerShell 7 은 UTF-8 을 기본으로 읽으므로 BOM 이 있어도 무해하다.
func TestPowerShellHookHasUTF8BOM(t *testing.T) {
	dir := t.TempDir()
	if err := unpackEmbedded(shellhookFS, "shellhooks/"+platform.WindowsHookRoot, dir); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	blob, err := os.ReadFile(filepath.Join(dir, platform.PowerShellHookFile))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(blob, []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatal("UTF-8 BOM 이 없다 — PowerShell 5.1 이 한글을 ANSI 로 오독한다")
	}
}
