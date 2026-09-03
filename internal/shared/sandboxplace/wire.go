package sandboxplace

import (
	"log"
	"os"
	"path/filepath"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/sandbox"
)

// Wire 는 실제 환경에서 배치기를 만든다 (FR-SBX-10).
//
// 컨테이너 런타임이 없으면 **nil 을 낸다.** 그 상태에서 샌드박스 창의 도구를
// 만들면 ToolManager 가 명확한 오류로 실패시킨다 — 호스트 셸로 조용히 내려가지
// 않는 것이 이 기능의 안전 요구다 (FR-SBX-21). 런타임이 없어도 나머지 기능은
// 영향받지 않는다 (NFR-SBX-3).
//
// 배선이 한 자리인 것은 direct 모드(웹서버)와 데몬 모드(dongminald)가 같은
// 배치를 써야 하기 때문이다. 두 벌이면 한쪽만 고쳐도 컴파일이 통과한다.
func Wire(home, version, port string) *Placer {
	dockerPath, err := sandbox.FindRuntime(sandbox.LookPath)
	if err != nil {
		return nil
	}

	profiles, err := sandbox.LoadProfiles(filepath.Join(home, sandbox.ProfilesFileName), os.ReadFile)
	if err != nil {
		// 정의가 깨졌어도 scratch 는 살린다 — 그것은 파일이 아니라 코드가 갖는
		// 프로파일이다. 사용자가 적은 dev·agent 는 요청 시 "정의되지 않았습니다"
		// 로 걸리므로, 설정이 무시된 사실이 조용히 묻히지는 않는다.
		log.Printf("[sandbox] %s: %v", sandbox.ProfilesFileName, err)
		profiles = map[string]sandbox.Profile{sandbox.ProfileScratch: sandbox.Scratch()}
	}

	helper := sandbox.DefaultHelperDeps(home, version)
	// 지금 판이 아닌 헬퍼는 기동 때 치운다 (FR-SBX-29).
	sandbox.PruneHelperCache(helper)

	if port == "" {
		port = envOr(dmenv.EnvPort, dmenv.DefaultPort)
	}
	return New(sandbox.New(sandbox.CLIRunner(dockerPath), home), dockerPath, profiles, helper, port)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
