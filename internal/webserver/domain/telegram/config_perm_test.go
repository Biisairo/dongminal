//go:build !windows

package telegram

import (
	"os"
	"testing"
)

// TC-TGB-1: 설정 파일은 권한 600 이다 (FR-TGB-2). Windows 는 권한 비트가 없다.
func TestStoreFileMode600(t *testing.T) {
	s, p := openTemp(t)
	if err := s.SetToken(testToken, "office_bot"); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("파일 권한 %v, 기대 0600", st.Mode().Perm())
	}
}
