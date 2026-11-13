//go:build windows

package platform

// CommandLines 는 Windows 에서 읽지 않는다 — cswap 감지는 없음으로 본다 (CLAUDE_ACCOUNTS_SRS FR-CAC-75).
func CommandLines() ([]string, error) { return nil, nil }
