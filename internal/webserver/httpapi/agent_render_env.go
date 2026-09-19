package httpapi

import "encoding/json"

// 에이전트가 화면을 망가뜨리지 않게 띄운다 (AGENT_RENDER_ENV_SRS).
//
// Claude Code 는 터미널 폭이 바뀌면 **옛 프레임을 스크롤백에 남긴다**
// (anthropics/claude-code#49086 외). 기기와 분할을 오가는 것이 이 제품의 사용
// 방식이라 그 잔재가 계속 쌓이고, 터미널 쪽에서 되살릴 길은 없다는 것이 조사로
// 확정됐다 (M11_SRS §2.4e·2.4f) — 스크롤백에 남은 것은 이미 배치가 끝난 글자이고
// 원본을 가진 것은 앱뿐이다.
//
// 앱에 해결책이 있다. fullscreen 렌더링은 대화를 alt screen 에 두므로 스크롤백을
// 아예 건드리지 않는다. 여기서 하는 일은 **그것을 켜 주는 것** 하나다.
//
// **Codex·oh-my-pi 는 대상이 아니다** (SRS §1.3). 둘 다 리사이즈 때 스크롤백을
// 스스로 다시 만들고, Codex 는 TUI 설정이 TOML 전용이라 켜려면 사용자의 설정
// 파일을 고쳐야 한다 — 이미 알맞게 도는 것을 그렇게까지 건드릴 이유가 없다.

// agentRenderEnvKey 는 이 스위치의 설정 키다 (Settings ▸ Terminal).
const agentRenderEnvKey = "claudeFullscreen"

// claudeNoFlickerEnv 는 Claude Code 를 fullscreen 렌더링으로 띄우는 변수다.
//
// **강제가 아니다** (FR-ARE-2). 사용자가 `/tui default` 를 치면 Claude Code 가
// 재시작하면서 이 변수를 지우므로, 주입은 기본값 제안에 그친다. 그 성질이 있기에
// 기본값을 켬으로 둘 수 있다.
const claudeNoFlickerEnv = "CLAUDE_CODE_NO_FLICKER=1"

// agentRenderEnv 는 설정 blob 을 보고 **새 도구에 얹을 환경**을 낸다 (FR-ARE-7).
//
// 서버가 설정 blob 을 해석하는 자리는 여기 하나뿐이다. `handlers_settings.go` 가
// *"서버가 해석하지 않는 JSON blob"* 이라 적어 둔 규약에 내는 예외이며, 까닭은
// 값을 **쓰는 주체가 서버**(도구를 띄우는 쪽)인데 값을 **정하는 자리가 브라우저**
// (설정 화면)이기 때문이다. 해석은 불리언 하나에서 멎는다.
//
// 읽을 것이 없거나 값이 이상하면 **켬**이다 (FR-ARE-3). 설정을 한 번도 저장하지
// 않은 사용자가 가장 많고, 손으로 고친 설정이 도구를 못 띄우게 만들어서도 안 된다.
func agentRenderEnv(blob []byte) []string {
	on := true
	if len(blob) > 0 {
		var m map[string]any
		if json.Unmarshal(blob, &m) == nil {
			if v, ok := m[agentRenderEnvKey].(bool); ok {
				on = v
			}
		}
	}
	if !on {
		return nil
	}
	return []string{claudeNoFlickerEnv}
}
