//go:build !windows

package platform

import "errors"

// Junction 은 Windows 에만 있다. 다른 운영체제는 심볼릭 링크를 쓴다 (CLAUDE_ACCOUNTS_SRS FR-CAC-82).
func Junction(_, _ string) error { return errors.New("junction 은 Windows 에만 있다") }
