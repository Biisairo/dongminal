//go:build !(darwin || freebsd || openbsd || netbsd || dragonfly || windows)

package fswatch

// watchable 은 inotify 에서는 언제나 참이다. 디렉터리 단위로
// 감시하므로 항목 수가 비용을 늘리지 않는다 (FR-ELR-55).
func watchable(string) bool { return true }
