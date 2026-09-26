package toolhub

import (
	"os"
	"os/user"
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

// toolBrowserEnv 는 도구 셸의 BROWSER 다 (BROWSER_TAB_SRS FR-BRT-70).
// 확장자는 설치와 같은 규칙을 따른다 — Windows 에서는 open-url.exe 다.
func toolBrowserEnv(binDir string) string {
	return "BROWSER=" + filepath.Join(binDir, "open-url"+platform.Current().Paths.ExeSuffix())
}

// toolEnv 는 도구 셸의 환경이다. os.Environ 이 앞이고 도구 기본값이 그 뒤,
// 호출자의 추가 환경이 맨 뒤다 — 같은 키면 뒤가 이긴다 (`dedupEnv` 가 뒤를 남긴다).
func toolEnv(id, shell, binDir string, shellEnv, extraEnv []string) []string {
	// Ensure critical env vars are always present (os.Environ() may lack
	// these when the server runs as a daemon / LaunchAgent).
	env := []string{
		"TERM=xterm-256color", "COLORTERM=truecolor",
		// PATH 구분자는 OS 마다 다르다 — 문자를 박지 않는다.
		"PATH=" + toolPath(binDir),
		"HOME=" + toolHome(),
		// PANE_ATTENTION_NOTIFY_SRS: lets `dmctl notify` (incl. detached agent
		// hooks that have no controlling tty) identify this tool to the server.
		dmenv.EnvToolID + "=" + id,
		// BROWSER_TAB_SRS FR-BRT-70: 브라우저를 직접 찾는 라이브러리가
		// 존중하는 변수다. 셸 함수(open/xdg-open)로는 덮이지 않는 경로를 덮는다.
		toolBrowserEnv(binDir),
	}
	if u, err := user.Current(); err == nil {
		env = append(env, "USER="+u.Username, "LOGNAME="+u.Username)
	}
	env = append(env, shellEnv...)
	// TOOL_HISTORY_ISOLATION_SRS FR-THI-1·21: 이 도구만의 히스토리 파일. 심을 수
	// 없으면 비어 있고, 그때 셸은 종전대로 사용자 히스토리를 공유한다.
	env = append(env, toolHistEnv(id, shell)...)
	// FR-ARE-5: 호출자가 정한 추가 환경. **해석하지 않는다** — 무엇을 왜 넣는지는
	// 띄우는 쪽의 지식이다.
	env = append(env, extraEnv...)
	return append(os.Environ(), env...)
}

// toolStartDir 은 도구가 열릴 자리다. cwd 가 있는 디렉터리면 그것, 아니면 사용자
// 홈, 홈도 모르면 ".".
func toolStartDir(cwd string) string {
	dir := userHome()
	if cwd != "" {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			dir = cwd
		}
	}
	if dir == "" {
		dir = "."
	}
	return dir
}
