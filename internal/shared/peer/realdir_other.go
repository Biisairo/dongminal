//go:build !windows

package peer

import "path/filepath"

// realDir 는 심볼릭 링크를 푼 실제 경로다.
func realDir(path string) (string, error) { return filepath.EvalSymlinks(path) }
