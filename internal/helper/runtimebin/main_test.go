package runtimebin

import (
	"os"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// TestMain 은 시험이 실제 인스턴스에 닿지 않게 한다. dongminal 안에서 시험을 돌리면
// DONGMINAL_HOME 이 실제 홈이고, 보고는 그 홈의 데몬 보고 소켓으로 먼저 간다
// (AGENT_RECORD_DAEMON_SRS FR-ARD-23). 홈이 필요한 시험은 스스로 심는다.
func TestMain(m *testing.M) {
	os.Unsetenv(dmenv.EnvHome)
	os.Exit(m.Run())
}
