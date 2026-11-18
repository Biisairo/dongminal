package claudeacct

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// RUN_RECOVERY_SRS FR-RRC-5: Claude Code 설정 폴더 목록 — 기본 프로필과 계정 프로필 폴더 전부.
// 세션 등록부를 찾는 쪽이 프로필 배치를 다시 알지 않게 여기서 낸다.
func TestConfigDirs(t *testing.T) {
	dir := t.TempDir()
	s := &Service{Dir: dir, Claude: ClaudePaths{ConfigHome: "/home/u/.claude"}}
	if got := s.ConfigDirs(); !reflect.DeepEqual(got, []string{"/home/u/.claude"}) {
		t.Fatalf("프로필 없음: %v", got)
	}
	for _, id := range []string{"b", "a"} {
		if err := os.MkdirAll(s.ProfileDir(id), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// 폴더가 아닌 것은 프로필이 아니다.
	if err := os.WriteFile(filepath.Join(dir, profilesDir, "x.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	want := []string{"/home/u/.claude", s.ProfileDir("a"), s.ProfileDir("b")}
	if got := s.ConfigDirs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}
