package runtimebin

import (
	"os"
	"path/filepath"

	"dongminal/internal/shared/dmenv"
)

// AgentHooksDirIn 은 이 bin 디렉터리의 에이전트 훅·오버레이 자산이 사는 자리다.
//
// **이 이름을 아는 자리는 여기 하나다.** 설치(`runtime.Install`)가 여기에 쓰고,
// 멤버 기동줄이 여기서 읽는다 (OMP_AGENT_SUPPORT_SRS FR-OMP-10·21). 두 벌로
// 적으면 한쪽만 고쳐진다 — 그 결함은 이 저장소가 이미 겪었다.
func AgentHooksDirIn(binDir string) string { return filepath.Join(binDir, "agent-hooks") }

// AgentHooksDir 는 **이 프로세스가 속한 인스턴스**의 그 자리다. 홈을 모르면
// 빈 문자열이며, 그때 토큰을 쓰는 기동줄은 오류가 된다 (FR-OMP-22) — 조용히
// 빈 경로를 싣지 않는다.
func AgentHooksDir() string {
	home := os.Getenv(dmenv.EnvHome)
	if home == "" {
		return ""
	}
	return AgentHooksDirIn(filepath.Join(home, "bin"))
}
