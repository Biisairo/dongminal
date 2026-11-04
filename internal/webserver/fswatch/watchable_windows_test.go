//go:build windows

package fswatch

import "testing"

// EDITOR_LIVE_RELOAD_SRS FR-ELR-55 (D-8): Windows 는 감시하지 않는다 — 감시 핸들이 디렉터리의
// 이름 변경·이동을 막는다.
func TestWatchable_WindowsNever(t *testing.T) {
	if watchable(t.TempDir()) {
		t.Fatal("Windows 에서 디렉터리를 감시한다고 답했다")
	}
}
