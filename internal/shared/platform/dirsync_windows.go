//go:build windows

package platform

// syncDir 은 Windows 에서 할 일이 없다 — 디렉터리 핸들의 fsync 를 지원하지 않는다 (FR-ATF-58).
func syncDir(string) error { return nil }
