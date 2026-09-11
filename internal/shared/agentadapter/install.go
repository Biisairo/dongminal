package agentadapter

import "strings"

/*
설치 — 이 에이전트가 붙기 위해 디스크에 놓아야 할 것 (AGENT_ADAPTER_COMPLETION_SRS
묶음 I, FR-AAC-1~6).

종전에는 설치가 에이전트마다 다른 함수에 있었고(`installAgentHooks` ·
`installOmpAssets`) `Install()` 이 그것을 **이름으로 차례로** 불렀다. 네 번째
에이전트가 오면 그 자리에 줄이 하나 더 늘고, 그 줄을 빠뜨리면 훅이 조용히 죽는다.

이제 `runtime` 은 등록된 어댑터를 순회한다 (FR-AAC-4).

**의존은 한 방향이다** (NFR-AAC-1). 이 패키지는 `runtime` 을 모른다 — 경로 규칙은
그쪽이 알고, 여기로는 `InstallSpec` 이 **자리만** 실어 온다.
*/

// InstallSpec 은 자산을 놓을 자리들이다 (FR-AAC-2).
//
// 경로를 계산하지 않는다 — `agent-hooks/` 가 어디인지, `dmctl` 의 확장자가
// 무엇인지는 `runtime` 의 지식이다. 어댑터가 아는 것은 "무엇을 놓을지" 뿐이다.
type InstallSpec struct {
	// Dir 은 이 에이전트의 훅·shim 이 사는 자리다 (`bin/agent-hooks`).
	// 호출자가 미리 만들어 둔다 — 어댑터마다 MkdirAll 을 되풀이할 이유가 없다.
	Dir string
	// PluginDir 은 세션 스코프 플러그인의 뿌리다 (`bin/agent-plugin`).
	// 그 규약을 쓰지 않는 에이전트에게는 빈 값과 같다.
	PluginDir string
	// Dmctl 은 이 인스턴스의 헬퍼 절대경로다. **절대경로인 것이 요점이다** —
	// PATH 앞쪽의 낡은 dmctl 은 `activity` 를 모른다.
	Dmctl string
}

// HookCommand 는 에이전트 훅에 적을 명령 한 줄이다 (FR-AAC-3).
//
// 인용 규칙(HOST_PARITY_SRS FR-HPR-4·5)의 임자가 여기 하나여야 한다 — 어댑터마다
// `"` 를 붙이면 한쪽만 고쳐지는 날이 온다. **실행 파일만** 인용한다.
func (s InstallSpec) HookCommand(args ...string) string {
	cmd := `"` + s.Dmctl + `"`
	if len(args) > 0 {
		cmd += " " + strings.Join(args, " ")
	}
	return cmd
}
