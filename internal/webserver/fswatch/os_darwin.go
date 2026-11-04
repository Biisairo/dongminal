//go:build darwin

package fswatch

import "strings"

// macOS 는 대소문자를 가리지 않고, 디스크의 파일 이름이 NFD 다 (FR-ELR-56·57).
const (
	fsCaseSensitive = false
	fsNFC           = true
)

// onNetworkVolume 은 `/Volumes/` 아래인지 본다. 네트워크 공유일 수 있어 감시하지 않는다
// (FR-ELR-55, VS Code `nodejsWatcherLib.ts`).
func onNetworkVolume(p string) bool { return strings.HasPrefix(p, "/Volumes/") }
