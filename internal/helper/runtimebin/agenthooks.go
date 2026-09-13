package runtimebin

import (
	"os"
	"path/filepath"

	"dongminal/internal/shared/dmenv"
)

// AgentHooksDir 는 **이 프로세스가 속한 인스턴스**의 에이전트 훅 자리다
// (`dmenv.AgentHooksDirIn`). 홈을 모르면 빈 문자열이며, 그때 토큰을 쓰는 기동줄은
// 오류가 된다 (FR-OMP-22) — 조용히 빈 경로를 싣지 않는다.
func AgentHooksDir() string {
	home := os.Getenv(dmenv.EnvHome)
	if home == "" {
		return ""
	}
	return dmenv.AgentHooksDirIn(filepath.Join(home, "bin"))
}
