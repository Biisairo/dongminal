package dmenv

import "path/filepath"

// 이 파일은 **설치 배치 중 세 프로세스가 함께 아는 것**이다 — 서버(③)와
// 데몬(②)이 `$DONGMINAL_HOME/bin` 에 깔고, 헬퍼(①)가 자기 이름으로 갈라 서고,
// 제어 CLI(④)가 점검하는 이름들. 종전에는 `helper/runtimebin` 이 들고 있었고
// `shared/runtime` 이 그것을 import 했다 — ①의 코드를 ②③ 이 실행하는 축 위반이다
// (M8 `GO-4`). 이름은 어느 축의 것도 아니므로 여기 둔다.

// HelperNames 는 multi-call 로 서는 헬퍼의 이름 전부다. 설치는 이 이름으로
// 링크를 깔고(확장자는 설치 시점에 붙는다, FR-XPA-3), `runtimebin` 의 디스패치
// 표는 이 목록과 같아야 한다 — 그 일치는 `runtimebin` 의 테스트가 지킨다.
//
// `open-url`: BROWSER 는 실행 파일을 요구하므로 쉘 함수로는 대신할 수 없다.
// 헬퍼로 서야 그 변수가 가리킬 자리가 생긴다 (VIEWER_URL_OPEN_SRS FR-VUO-12).
func HelperNames() []string {
	return []string{"dmctl", "edit", "download", "detach", "open-url"}
}

// AgentHooksDirIn 은 이 bin 디렉터리의 에이전트 훅·오버레이 자산이 사는 자리다.
//
// **이 이름을 아는 자리는 여기 하나다.** 설치(`runtime.Install`)가 여기에 쓰고,
// 멤버 기동줄(`runtimebin`)이 여기서 읽는다 (OMP_AGENT_SUPPORT_SRS FR-OMP-10·21).
// 두 벌로 적으면 한쪽만 고쳐진다 — 그 결함은 이 저장소가 이미 겪었다.
func AgentHooksDirIn(binDir string) string { return filepath.Join(binDir, "agent-hooks") }
