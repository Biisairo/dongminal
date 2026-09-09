package platform

import (
	"os"
	"path/filepath"
	"testing"
)

// Windows 는 symlink 를 쓸 수 없지만 **하드링크는 권한을 요구하지 않는다**
// (HOST_PARITY_SRS 묶음 D-1, FR-HPR-11).
//
// 종전에는 곧바로 복사했다. 헬퍼 5개 × 16MB 를 매 기동마다 쓰고 있었다 (§2.4).
//
// 이 검사는 build tag 가 없다 — `windowsPaths` 는 어느 호스트에서도 컴파일되고
// (platform 패키지 머리말 §4.2), `os.Link` 는 POSIX 에서도 하드링크다.

func TestWindowsPathsLinkOrCopyPrefersHardLink(t *testing.T) {
	// V-HPR-7
	dir := t.TempDir()
	src := filepath.Join(dir, "dongminal.exe")
	if err := os.WriteFile(src, []byte("payload"), 0o755); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "dmctl.exe")
	if err := (windowsPaths{}).LinkOrCopy(src, dst); err != nil {
		t.Fatal(err)
	}
	if !sameFile(t, src, dst) {
		t.Fatal("복사가 일어났다 — 하드링크를 먼저 시도해야 한다")
	}
}

// 이미 같은 실체를 가리키면 아무것도 하지 않는다 (FR-HPR-11).
func TestWindowsPathsLinkOrCopyIdempotent(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "dongminal.exe")
	if err := os.WriteFile(src, []byte("payload"), 0o755); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "dmctl.exe")
	p := windowsPaths{}
	if err := p.LinkOrCopy(src, dst); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.LinkOrCopy(src, dst); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("두 번째 설치가 파일을 갈아치웠다")
	}
}

// 대상이 이미 **다른** 실체면 갱신되어야 한다 — 바이너리가 바뀐 재기동이 이 경로다.
func TestWindowsPathsLinkOrCopyReplacesStale(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "dongminal.exe")
	if err := os.WriteFile(src, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "dmctl.exe")
	if err := os.WriteFile(dst, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := (windowsPaths{}).LinkOrCopy(src, dst); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(blob) != "new" {
		t.Fatalf("dst = %q, want %q", blob, "new")
	}
}

func sameFile(t *testing.T, a, b string) bool {
	t.Helper()
	fa, err := os.Stat(a)
	if err != nil {
		t.Fatal(err)
	}
	fb, err := os.Stat(b)
	if err != nil {
		t.Fatal(err)
	}
	return os.SameFile(fa, fb)
}
