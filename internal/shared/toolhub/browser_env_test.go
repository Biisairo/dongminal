package toolhub

import (
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/platform"
)

// FR-VUO-13: 도구 셸의 BROWSER 는 dongminal 의 open-url 을 가리킨다. xdg-open
// 을 거치지 않고 브라우저를 직접 찾는 라이브러리(python webbrowser, node open)가
// 이 변수를 존중하므로, 셸 함수만으로는 덮이지 않는 경로가 여기서 덮인다.
func TestToolBrowserEnv_PointsAtHelper(t *testing.T) {
	// 경로 구분자는 OS 마다 다르다 — 기대값을 문자로 박으면 Windows 에서
	// 어긋난다. 재는 것은 "설치된 헬퍼를 가리키는가" 이지 구분자가 아니다.
	binDir := filepath.Join("home", "u", ".dongminal", "bin")
	got := toolBrowserEnv(binDir)
	if !strings.HasPrefix(got, "BROWSER=") {
		t.Fatalf("got=%q", got)
	}
	want := "BROWSER=" + filepath.Join(binDir, "open-url"+platform.Current().Paths.ExeSuffix())
	if got != want {
		t.Fatalf("got=%q want=%q", got, want)
	}
}
