package wsentry

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-63: 홈 기본값·"없으면 만든다" 는 헬퍼 둘이다.

func TestHome_DefaultAndInjected(t *testing.T) {
	var s Store
	want, werr := os.UserHomeDir()
	got, err := s.home()
	if got != want || (err == nil) != (werr == nil) {
		t.Fatalf("기본 home()=%q,%v want %q,%v", got, err, want, werr)
	}

	// 주입한 값은 정규화하지 않고 그대로 준다 — 정규화는 부르는 쪽(Home·Roots)의 몫이다.
	raw := filepath.Join(t.TempDir(), "x", "..", "h")
	s.HomeFn = func() (string, error) { return raw, nil }
	if got, err := s.home(); got != raw || err != nil {
		t.Fatalf("주입 home()=%q,%v want %q", got, err, raw)
	}

	errHome := errors.New("홈 없음")
	s.HomeFn = func() (string, error) { return "", errHome }
	if _, err := s.home(); !errors.Is(err, errHome) {
		t.Fatalf("오류가 전달되지 않았다: %v", err)
	}
}

func TestEnsureRoot(t *testing.T) {
	if _, err := ensureRoot(""); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("빈 자리 = %v, want ErrUnavailable", err)
	}

	dir := filepath.Join(t.TempDir(), "a", "b")
	got, err := ensureRoot(dir)
	if err != nil || got != NormalizePath(dir) {
		t.Fatalf("ensureRoot=%q,%v want %q", got, err, NormalizePath(dir))
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		t.Fatalf("만들지 않았다: %v", err)
	}

	file := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := ensureRoot(filepath.Join(file, "x")); err == nil || got != "" {
		t.Fatalf("만들 수 없는 자리 = %q,%v", got, err)
	}
}
