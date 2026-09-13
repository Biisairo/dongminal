package toolhub

import (
	"os"
	"path/filepath"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
)

// toolHome 은 도구 셸이 **자기 홈으로 여길 곳**이다. dmenv.EnvToolHome 이 있으면
// 그것이 우선하고, 없으면 종전대로 사용자 홈이다.
//
// 이 갈래가 있는 이유는 셸이 로그인 셸이기 때문이다 — rc 를 읽고 히스토리를
// 쓴다. 검사가 띄운 셸까지 사용자 홈을 쓰면 검사가 주입한 명령이 사용자의
// 히스토리에 섞인다. 격리는 검사 쪽에서 이 변수를 심어 얻는다.
//
// **도구가 열리는 자리(startDir)는 이것이 아니다.** 둘을 한 값으로 묶으면 홈을
// 격리하는 순간 도구가 열리는 위치까지 따라 옮겨진다 — 상태바의 cwd 와 탭 이름이
// 달라지고, 사용자가 보는 첫 화면이 바뀐다. 격리하려는 것은 셸이 쓰는 자리이지
// 사용자가 서 있는 자리가 아니다.
func toolHome() string {
	if v := os.Getenv(dmenv.EnvToolHome); v != "" {
		return v
	}
	return userHome()
}

// userHome 은 도구가 아무 지시 없이 열릴 자리다. 언제나 사용자의 홈이다.
func userHome() string {
	home, _ := os.UserHomeDir()
	return home
}

// toolBrowserEnv 는 도구 셸의 BROWSER 다 (VIEWER_URL_OPEN_SRS FR-VUO-13).
// 확장자는 설치와 같은 규칙을 따른다 — Windows 에서는 open-url.exe 다.
func toolBrowserEnv(binDir string) string {
	return "BROWSER=" + filepath.Join(binDir, "open-url"+platform.Current().Paths.ExeSuffix())
}
