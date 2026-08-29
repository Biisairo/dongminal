package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

// Install 이 사용자 홈에 아무것도 쓰지 않는다는 것을 실제 파일시스템으로 확인한다.
// 위 문자열 대조는 셸 래퍼만 보므로, 설치 경로 자체가 새는 경우를 놓친다.
func TestInstallWritesNothingOutsideItsBinDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(claudeDir, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"hooks":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Install(t.TempDir()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	got, err := os.ReadFile(settings)
	if err != nil {
		t.Fatalf("사용자 설정이 사라졌다: %v", err)
	}
	if string(got) != `{"hooks":{}}` {
		t.Fatalf("사용자의 영구 설정이 수정됐다 (FR-ADP-5): %s", got)
	}
	entries, err := os.ReadDir(claudeDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("~/.claude 에 파일이 생겼다: %d개", len(entries))
	}
}
