//go:build windows

package platform

import "errors"

// Windows 는 데몬 교체를 하지 않는다 (DAEMON_SESSION_KEEP_SRS D-DSK-7). 되찾을 것이 없다.

// ChildTTY 는 직계 자식 하나와 그 제어 단말이다.
type ChildTTY struct {
	PID int
	TTY string
}

// PTYMasters 는 Windows 에서 늘 비었다.
func PTYMasters(map[uintptr]bool) (map[string]uintptr, error) { return map[string]uintptr{}, nil }

// ChildTTYs 는 Windows 에서 늘 비었다.
func ChildTTYs(int) ([]ChildTTY, error) { return nil, nil }

// CommandName 은 Windows 에서 쓰지 않는다.
func CommandName(int) string { return "shell" }

// CloseSocketsBoundTo 는 Windows 에서 아무것도 하지 않는다.
func CloseSocketsBoundTo(...string) int { return 0 }

// SetCloseOnExec 는 Windows 에 없다.
func SetCloseOnExec(uintptr, bool) error { return errors.New("지원하지 않는다") }
