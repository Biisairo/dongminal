package cli

import (
	"fmt"
	"os/exec"
	"runtime"
)

// linuxBrowsers는 Linux 에서 frameless window 를 열 때 찾는 순서다
// (FR-OPN-2). 기존 scripts/open_frameless_window.sh 와 같다.
var linuxBrowsers = []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"}

// BrowserCommand는 frameless window 를 여는 명령을 조립한다. look 은
// exec.LookPath 를 대신할 수 있게 주입한다 — 테스트가 무는 지점이다.
func BrowserCommand(goos, url string, look func(string) (string, error)) (string, []string, error) {
	switch goos {
	case "darwin":
		return "open", []string{"-na", "Google Chrome", "--args", "--app=" + url}, nil
	case "linux":
		for _, b := range linuxBrowsers {
			if path, err := look(b); err == nil {
				return path, []string{"--app=" + url}, nil
			}
		}
		return "", nil, fmt.Errorf("지원하는 브라우저를 찾지 못했습니다 (%v). Chrome 또는 Chromium 을 설치하세요", linuxBrowsers)
	}
	return "", nil, fmt.Errorf("지원하지 않는 OS 입니다: %s", goos)
}

// openFrameless는 frameless window 를 연다. 실패는 서버 기동의 실패가
// 아니다 (FR-OPN-3) — 호출자가 경고로 다룬다.
func openFrameless(url string) error {
	name, args, err := BrowserCommand(runtime.GOOS, url, exec.LookPath)
	if err != nil {
		return err
	}
	return exec.Command(name, args...).Start()
}
