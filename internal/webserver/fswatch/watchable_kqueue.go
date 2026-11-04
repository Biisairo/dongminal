//go:build darwin || freebsd || openbsd || netbsd || dragonfly

package fswatch

import "os"

// watchable 은 kqueue 백엔드에서 감시를 걸어도 되는 디렉터리인지 판정한다 (FR-ELR-55).
//
// macOS 의 `/Volumes/` 아래는 네트워크 공유일 수 있어 감시하지 않는다 (VS Code
// `nodejsWatcherLib.ts`). 항목이 상한을 넘는 디렉터리는 fd 를 지키려고 감시하지 않는다.
func watchable(real string) bool {
	if onNetworkVolume(real) {
		return false
	}
	f, err := os.Open(real)
	if err != nil {
		return false
	}
	defer f.Close()
	names, _ := f.Readdirnames(KqueueEntriesMax + 1)
	return len(names) <= KqueueEntriesMax
}
