//go:build windows

package platform

import "testing"

// 닫힌 의사 콘솔을 만지지 않는다 (HOST_PARITY_SRS 묶음 G, FR-HPR-18).
//
// `Close`(또는 `reap`)가 `ClosePseudoConsole` 을 지난 뒤에도 브라우저의
// 리사이즈가 도착할 수 있다. 종전에는 그 핸들을 검사 없이 넘겼다 —
// CROSS_PLATFORM_HANDOFF §7.3 이 미해결로 남겨 둔 자리다 (§2.7).
func TestWindowsTerminalResizeAfterCloseErrors(t *testing.T) {
	// V-HPR-11
	term := &windowsTerminal{exited: make(chan struct{}), cols: 80, rows: 24}
	close(term.exited)
	term.markPseudoConsoleClosed()

	if err := term.Resize(100, 40); err == nil {
		t.Fatal("닫힌 의사 콘솔에 Resize 가 성공했다고 답했다")
	}
	// 마지막으로 정한 크기는 흔들리지 않아야 한다.
	c, r, _ := term.Size()
	if c != 80 || r != 24 {
		t.Fatalf("Size = %dx%d — 실패한 Resize 가 값을 바꿨다", c, r)
	}
}
