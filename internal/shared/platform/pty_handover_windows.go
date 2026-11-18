//go:build windows

package platform

import "errors"

// AdoptTerminal 은 Windows 에서 쓸 수 없다 — 의사 콘솔을 넘길 공식 방법이 없다
// (DAEMON_SESSION_KEEP_SRS §2.5, D-DSK-7).
func AdoptTerminal(fd uintptr, pid int) (Terminal, error) {
	return nil, errors.New("Windows 는 터미널을 넘겨받지 못한다")
}
