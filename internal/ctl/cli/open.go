package cli

import (
	"os/exec"

	"dongminal/internal/shared/platform"
)

// openFrameless는 frameless window 를 연다. 실패는 서버 기동의 실패가
// 아니다 (FR-OPN-3) — 호출자가 경고로 다룬다.
//
// 명령 조립은 platform.Browser 가 한다. 종전의 BrowserCommand(goos, ...) 는
// 이 저장소에 남아 있던 마지막 OS 분기였고, 그 자리를 어댑터가 대신한다
// (CROSS_PLATFORM_SRS FR-XBR-3).
func openFrameless(url string) error {
	name, args, err := platform.Current().Browser.FramelessCommand(url)
	if err != nil {
		return err
	}
	return exec.Command(name, args...).Start()
}
