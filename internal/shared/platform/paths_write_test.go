package platform

import (
	"os"
	"path/filepath"
	"testing"
)

// CODE_AUDIT_FIXES_SRS 묶음 C — 부분 쓰기가 살아 있는 파일이 되면 안 된다
// (V-CAF-7~9).
//
// `os.WriteFile` 은 O_TRUNC 로 연 뒤 쓴다. 그 사이에 프로세스가 죽거나 디스크가
// 차면 잘린 파일이 **살아 있는 파일**이 된다. `workspace.json` 이 그렇게 되면
// 창 배치 전체를 잃는다.
//
// 이 파일의 검사는 전부 "실패한 뒤에 무엇이 남아 있는가" 로 판정한다.

// canDenyWriteToDir 은 이 호스트가 읽기 전용 디렉터리에서 파일 생성을 **실제로**
// 막는가를 해 보고 답한다.
//
// runtime.GOOS 로 가르지 않는 것이 이 패키지의 규약이다 (paths_atomic_test.go
// 머리말) — 능력을 직접 물으면 갈래는 언제나 하나다. Windows 의 os.Chmod 는
// 디렉터리에 그런 뜻을 갖지 않고, root 로 도는 CI 에서는 권한이 무의미하다.
func canDenyWriteToDir(t *testing.T) bool {
	t.Helper()
	sub := filepath.Join(t.TempDir(), "ro")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sub, 0o500); err != nil {
		return false
	}
	defer os.Chmod(sub, 0o755)
	f, err := os.OpenFile(filepath.Join(sub, "probe"), os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		f.Close()
		return false
	}
	return true
}

// V-CAF-9 (FR-CAF-8): 성공하면 내용과 권한이 요청대로다.
func TestWriteFileAtomicWritesContentAndPerm(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")

	if err := WriteFileAtomic(p, []byte(`{"a":1}`), 0o644); err != nil {
		t.Fatalf("쓰기: %v", err)
	}

	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"a":1}` {
		t.Fatalf("내용이 다르다: %q", got)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	// Windows 는 권한 비트를 그대로 갖지 않는다 — 쓸 수 있으면 된다.
	if st.Mode().Perm()&0o600 != 0o600 {
		t.Fatalf("권한이 %v — 읽고 쓸 수 없다", st.Mode().Perm())
	}
}

// V-CAF-9: 덮어쓰기도 같은 계약이다.
func TestWriteFileAtomicReplacesExisting(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(p, []byte("아주 긴 이전 내용입니다"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := WriteFileAtomic(p, []byte("짧다"), 0o644); err != nil {
		t.Fatalf("쓰기: %v", err)
	}

	got, _ := os.ReadFile(p)
	if string(got) != "짧다" {
		t.Fatalf("이전 내용이 남았다: %q", got)
	}
}

// V-CAF-7 (FR-CAF-10): **실패해도 목적 파일의 기존 내용은 그대로다.**
//
// 이것이 계약의 핵심이다 — 새 내용을 못 쓰는 것보다 옛 내용을 잃는 것이 나쁘다.
// `os.WriteFile` 은 정확히 그 반대로 동작한다: 열자마자 비운다.
func TestWriteFileAtomicKeepsPreviousOnFailure(t *testing.T) {
	if !canDenyWriteToDir(t) {
		t.Skip("이 호스트는 디렉터리 쓰기를 막을 수 없다 — 실패를 만들 수단이 없다")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	const before = `{"windows":[{"tabs":3}]}`
	if err := os.WriteFile(p, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0o755)

	if err := WriteFileAtomic(p, []byte(`{"windows":[]}`), 0o644); err == nil {
		t.Fatal("쓸 수 없는 디렉터리인데 성공했다고 답했다")
	}

	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("목적 파일이 사라졌다: %v", err)
	}
	if string(got) != before {
		t.Fatalf("실패한 쓰기가 기존 내용을 훼손했다: %q — FR-CAF-10 위반", got)
	}
}

// V-CAF-8 (FR-CAF-9): 실패해도 임시 파일을 남기지 않는다.
func TestWriteFileAtomicLeavesNoTempOnFailure(t *testing.T) {
	dir := t.TempDir()
	// 목적 경로가 디렉터리면 rename 이 실패한다 — 임시 파일은 만들어진 뒤이므로
	// 뒷정리가 실제로 도는 경로다.
	p := filepath.Join(dir, "state.json")
	if err := os.Mkdir(p, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := WriteFileAtomic(p, []byte("x"), 0o644); err == nil {
		t.Fatal("목적이 디렉터리인데 성공했다고 답했다")
	}

	assertNoTemps(t, dir, "state.json")
}

// V-CAF-8: 성공을 거듭해도 잔여물이 없다.
func TestWriteFileAtomicLeavesNoTempOnSuccess(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	for i := range 3 {
		if err := WriteFileAtomic(p, []byte{byte('a' + i)}, 0o644); err != nil {
			t.Fatalf("쓰기 %d: %v", i, err)
		}
	}
	assertNoTemps(t, dir, "state.json")
}

func assertNoTemps(t *testing.T, dir string, want ...string) {
	t.Helper()
	keep := map[string]bool{}
	for _, w := range want {
		keep[w] = true
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if !keep[e.Name()] {
			t.Fatalf("잔여물 %q — FR-CAF-9 위반", e.Name())
		}
	}
}
