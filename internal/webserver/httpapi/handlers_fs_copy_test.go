package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/wsentry"
)

// WORKBENCH_REVIEW_SRS 묶음 P — POST /api/fs/copy (FR-WBR-60~68).
// 검증 V-WBR-60~68.
//
// 이 종단이 기존 조작과 다른 것이 **둘**이다. 루트를 두 개 받고(FR-WBR-61),
// 충돌하면 거부가 아니라 개명한다(FR-WBR-63). 나머지 규약 — 루트 밖 금지 ·
// 덮어쓰기 금지 · 항목 수 상한 — 은 그대로다.

// seedRoots 는 여러 root 를 editors.list 에 심는다. 루트 교차를 시험하려면
// 하나로는 부족하다 (`seedRoot` 는 하나만 심는다).
func seedRoots(t *testing.T, ws *fakeWorkspaceStore, roots ...string) {
	t.Helper()
	q := make([]string, 0, len(roots))
	for _, r := range roots {
		q = append(q, testpath.JSONQuote(r))
	}
	ws.raw = []byte(fmt.Sprintf(`{"schemaVersion":2,"editors":{"list":[%s]}}`, strings.Join(q, ",")))
}

func copyReq(t *testing.T, s *Server, srcRoot, src, dstRoot, dstDir string) (int, map[string]any) {
	t.Helper()
	body := fmt.Sprintf(`{"srcRoot":%s,"src":%s,"dstRoot":%s,"dstDir":%s}`,
		testpath.JSONQuote(srcRoot), testpath.JSONQuote(src),
		testpath.JSONQuote(dstRoot), testpath.JSONQuote(dstDir))
	return fsReq(t, s, http.MethodPost, "/api/fs/copy", body)
}

// copyOK 는 성공을 확인하고 **만들어진 경로**를 돌려준다 (FR-WBR-62) — 이름을
// 서버가 정하므로 응답이 그것을 말하지 않으면 호출자가 알 길이 없다.
func copyOK(t *testing.T, s *Server, srcRoot, src, dstRoot, dstDir string) string {
	t.Helper()
	code, out := copyReq(t, s, srcRoot, src, dstRoot, dstDir)
	if code != http.StatusOK {
		t.Fatalf("copy = %d %v, want 200", code, out)
	}
	p, _ := out["path"].(string)
	if p == "" {
		t.Fatalf("응답에 path 가 없다: %v", out)
	}
	return p
}

func mkRootFS(t *testing.T, dir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("A\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// V-WBR-60 (FR-WBR-63): 충돌하지 않으면 이름을 바꾸지 않는다. 다른 폴더로
// 복사하는 흔한 길에서 이름이 달라지면 그것이 놀라움이다.
func TestFSCopyKeepsNameWhenFree(t *testing.T) {
	s, ws, home := fsTestServer(t)
	seedRoot(t, ws, home)
	mkRootFS(t, home)

	got := copyOK(t, s, home, filepath.Join(home, "a.txt"), home, filepath.Join(home, "sub"))
	want := filepath.Join(home, "sub", "a.txt")
	if got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
	if b, err := os.ReadFile(want); err != nil || string(b) != "A\n" {
		t.Fatalf("복사된 내용 = %q %v", b, err)
	}
	// 원본은 그대로다 — 이동이 아니다.
	if _, err := os.Stat(filepath.Join(home, "a.txt")); err != nil {
		t.Fatalf("원본이 사라졌다: %v", err)
	}
}

// V-WBR-61 (FR-WBR-62·63): 충돌하면 개명하고 올라간다. "복제" 는 언제나 이 길이다.
func TestFSCopyRenamesOnConflict(t *testing.T) {
	s, ws, home := fsTestServer(t)
	seedRoot(t, ws, home)
	mkRootFS(t, home)

	src := filepath.Join(home, "a.txt")
	for i, want := range []string{"a copy.txt", "a copy 2.txt", "a copy 3.txt"} {
		got := copyOK(t, s, home, src, home, home)
		if got != filepath.Join(home, want) {
			t.Fatalf("%d 번째 = %q, want %q", i+1, filepath.Base(got), want)
		}
	}
	// 폴더도 같은 규칙이다.
	got := copyOK(t, s, home, filepath.Join(home, "sub"), home, home)
	if filepath.Base(got) != "sub copy" {
		t.Fatalf("폴더 = %q, want %q", filepath.Base(got), "sub copy")
	}
	if st, err := os.Stat(got); err != nil || !st.IsDir() {
		t.Fatalf("폴더로 복사되지 않았다: %v", err)
	}
}

// V-WBR-62 (FR-WBR-63): 점으로 시작하는 이름은 **확장자가 없는 것**이다.
// `filepath.Ext(".gitignore")` 가 `".gitignore"` 를 돌려주므로(실측) 순진하게
// 자르면 공백으로 시작하는 이름이 된다.
func TestFSCopyDotfileName(t *testing.T) {
	s, ws, home := fsTestServer(t)
	seedRoot(t, ws, home)
	for _, n := range []string{".gitignore", "a.tar.gz", "noext"} {
		if err := os.WriteFile(filepath.Join(home, n), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct{ src, want string }{
		{".gitignore", ".gitignore copy"},
		// 확장자는 **마지막 점** 뒤다 — `a.tar` 가 이름이다.
		{"a.tar.gz", "a.tar copy.gz"},
		{"noext", "noext copy"},
	} {
		got := copyOK(t, s, home, filepath.Join(home, tc.src), home, home)
		if filepath.Base(got) != tc.want {
			t.Fatalf("%s → %q, want %q", tc.src, filepath.Base(got), tc.want)
		}
	}
}

// V-WBR-63 (FR-WBR-63): 개명이 생겨도 **덮어쓰기는 어디에도 없다.**
// FR-EDT-86 이 금하는 둘 중 그쪽은 그대로다.
func TestFSCopyNeverOverwrites(t *testing.T) {
	s, ws, home := fsTestServer(t)
	seedRoot(t, ws, home)
	mkRootFS(t, home)
	dst := filepath.Join(home, "sub", "a.txt")
	if err := os.WriteFile(dst, []byte("KEEP\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := copyOK(t, s, home, filepath.Join(home, "a.txt"), home, filepath.Join(home, "sub"))
	if filepath.Base(got) != "a copy.txt" {
		t.Fatalf("path = %q, want %q", filepath.Base(got), "a copy.txt")
	}
	if b, _ := os.ReadFile(dst); string(b) != "KEEP\n" {
		t.Fatalf("있던 파일이 덮였다: %q", b)
	}
}

// V-WBR-64 (FR-WBR-61): 루트 **둘**을 받고 둘 다 Editor 목록에 있어야 한다.
func TestFSCopyCrossRoot(t *testing.T) {
	s, ws, home := fsTestServer(t)
	// macOS 의 `/var` 는 `/private/var` 의 링크다 — 서버가 푼 경로를 돌려주므로
	// 시험도 같은 자리에서 재야 한다 (`fsTestServer` 의 home 이 그렇게 온다).
	other := wsentry.NormalizePath(t.TempDir())
	seedRoots(t, ws, home, other)
	mkRootFS(t, home)

	got := copyOK(t, s, home, filepath.Join(home, "a.txt"), other, other)
	if got != filepath.Join(other, "a.txt") {
		t.Fatalf("path = %q", got)
	}

	// 목록에 없는 루트는 거부다 — 경계는 그대로 단단하다.
	stray := t.TempDir()
	code, out := copyReq(t, s, home, filepath.Join(home, "a.txt"), stray, stray)
	if code == http.StatusOK {
		t.Fatalf("목록에 없는 dstRoot 가 통과했다: %v", out)
	}
	if out["code"] != fsErrOutsideRoot {
		t.Fatalf("code = %v, want %s", out["code"], fsErrOutsideRoot)
	}
	if _, err := os.Stat(filepath.Join(stray, "a.txt")); err == nil {
		t.Fatal("거부됐는데 파일이 만들어졌다")
	}
}

// V-WBR-65 (FR-WBR-64): 자기 자신·자기 하위로는 복사할 수 없다. **서버가**
// 막는다 — 막지 않으면 무한 재귀로 디스크를 채운다.
func TestFSCopyIntoSelfRejected(t *testing.T) {
	s, ws, home := fsTestServer(t)
	seedRoot(t, ws, home)
	d := filepath.Join(home, "d")
	if err := os.MkdirAll(filepath.Join(d, "inner"), 0o755); err != nil {
		t.Fatal(err)
	}

	for _, dst := range []string{d, filepath.Join(d, "inner")} {
		code, out := copyReq(t, s, home, d, home, dst)
		if code == http.StatusOK {
			t.Fatalf("%s 로의 복사가 통과했다: %v", dst, out)
		}
	}
	// 부모로의 복사(= 복제)는 막지 않는다 — 그것이 이 기능의 본령이다.
	if got := copyOK(t, s, home, d, home, home); filepath.Base(got) != "d copy" {
		t.Fatalf("복제 = %q", filepath.Base(got))
	}
}

// V-WBR-66 (FR-WBR-65): 심볼릭 링크는 따라가지 않고 **링크 자체**를 복사한다.
// 순환과 뿌리 이탈을 한 규칙으로 막는 기존 판단을 잇는다 (FR-EDT-85).
func TestFSCopySymlinkNotFollowed(t *testing.T) {
	s, ws, home := fsTestServer(t)
	seedRoot(t, ws, home)
	mkRootFS(t, home)
	link := filepath.Join(home, "l")
	if err := os.Symlink(filepath.Join(home, "a.txt"), link); err != nil {
		t.Skipf("심볼릭 링크를 만들 수 없다: %v", err)
	}

	got := copyOK(t, s, home, link, home, filepath.Join(home, "sub"))
	st, err := os.Lstat(got)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("링크가 아니라 그 대상이 복사됐다: %v", st.Mode())
	}
	tgt, err := os.Readlink(got)
	if err != nil || tgt != filepath.Join(home, "a.txt") {
		t.Fatalf("링크 대상 = %q %v", tgt, err)
	}
}

// V-WBR-67 (FR-WBR-66): 상한을 넘으면 **시작하지 않는다.** 먼저 세는 이유가
// 그것이다 — 세다 멈추면 절반만 복사된 트리가 남는다 (FR-EDT-118 과 같은 규약).
func TestFSCopyOverMaxDoesNotStart(t *testing.T) {
	s, ws, home := fsTestServer(t)
	seedRoot(t, ws, home)
	old := fsCopyMax
	fsCopyMax = 3
	t.Cleanup(func() { fsCopyMax = old })

	d := filepath.Join(home, "big")
	if err := os.Mkdir(d, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		if err := os.WriteFile(filepath.Join(d, fmt.Sprintf("f%d", i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	code, out := copyReq(t, s, home, d, home, home)
	if code == http.StatusOK {
		t.Fatalf("상한을 넘었는데 통과했다: %v", out)
	}
	if _, err := os.Stat(filepath.Join(home, "big copy")); err == nil {
		t.Fatal("거부됐는데 대상이 만들어졌다")
	}
}

// V-WBR-68 (FR-WBR-68): 파일 모드를 보존한다. 실행 비트가 사라지면 복사한
// 스크립트가 돌지 않는다.
//
// **재는 것은 "원본과 같은가" 다.** Windows 에는 실행 비트가 없어 `os.Chmod` 가
// 읽기전용 비트만 만지고 `Perm()` 은 `0666` 을 돌려준다(CI 실측) — "0755 인가" 로
// 재면 코드가 아니라 시험의 전제가 플랫폼을 탄다. 같은지를 재면 어느 쪽에서도
// 요구를 그대로 재고, POSIX 의 실행 비트는 아래에서 한 번 더 못박는다.
func TestFSCopyPreservesMode(t *testing.T) {
	s, ws, home := fsTestServer(t)
	seedRoot(t, ws, home)
	if err := os.Mkdir(filepath.Join(home, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(home, "run.sh")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	src, err := os.Stat(exe)
	if err != nil {
		t.Fatal(err)
	}
	got := copyOK(t, s, home, exe, home, filepath.Join(home, "sub"))
	st, err := os.Stat(got)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != src.Mode().Perm() {
		t.Fatalf("모드 = %v, want %v", st.Mode().Perm(), src.Mode().Perm())
	}
	// POSIX 에서는 그 값이 곧 실행 비트다 — 위의 비교가 무엇을 지키는지 못박는다.
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o111 == 0 {
		t.Fatalf("실행 비트가 사라졌다: %v", st.Mode())
	}
}
