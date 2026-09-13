//go:build windows

package testpath

// PinShell 은 Windows 에서 무동작이다 — 그쪽의 셸은 `DONGMINAL_SHELL` 이고 `$SHELL`
// 을 보지 않는다 (M8 D-A-21).
func PinShell() func() { return func() {} }

// Shells 는 Windows 에서 비어 있다 — POSIX 셸의 rc 사슬을 재는 검사는 전부 Skip 된다.
func Shells() map[string]string { return map[string]string{} }
