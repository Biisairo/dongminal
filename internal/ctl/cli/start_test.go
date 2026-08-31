package cli

import (
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
)

// 격리 기동은 검사가 쓰는 경로다 — verify 가 도구 셸에 명령을 주입한다. 그
// 셸이 사용자 홈을 자기 홈으로 삼으면 주입한 명령이 사용자의 히스토리에 남는다.
func TestIsolatedToolHome(t *testing.T) {
	iso := testpath.Abs("tmp", isolatedHomePrefix+"abc123")
	// 인스턴스 홈 **아래**여야 한다. 홈을 그대로 주면 셸의 히스토리가
	// workspace·tools 와 같은 디렉터리에 쌓여 인스턴스의 저장과 겹친다.
	want := filepath.Join(iso, toolHomeDir)
	if got := isolatedToolHome(iso); got != want {
		t.Fatalf("isolatedToolHome(%q)=%q want %q", iso, got, want)
	}
}

// 사용자 인스턴스의 탭은 종전대로 사용자 홈을 쓴다 — 평소 히스토리와 rc 가
// 그대로 보여야 한다.
func TestIsolatedToolHome_UserInstanceUntouched(t *testing.T) {
	user := testpath.Abs("Users", "someone", ".dongminal")
	if got := isolatedToolHome(user); got != "" {
		t.Fatalf("isolatedToolHome(%q)=%q want \"\"", user, got)
	}
}
