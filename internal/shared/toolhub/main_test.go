package toolhub

import (
	"os"
	"testing"

	"dongminal/internal/shared/testpath"
)

// 이 패키지의 검사는 진짜 셸을 띄운다. 격리하지 않으면 그 셸이 사용자의 홈을
// 자기 홈으로 삼아 rc 를 읽고 히스토리를 쓴다 — 검사가 주입한 명령이 사용자의
// 히스토리에 남는다.
func TestMain(m *testing.M) {
	restore := testpath.IsolateToolHome()
	code := m.Run()
	restore()
	os.Exit(code)
}
