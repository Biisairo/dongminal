package httpapi

import (
	"encoding/json"
	"strconv"
	"sync"

	"dongminal/internal/shared/settingsschema"
)

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

// scrollSpeedKey 는 스크롤 속도의 설정 키다 (FR-ARE-8, Settings ▸ Terminal).
const scrollSpeedKey = "claudeScrollSpeed"

// claudeScrollSpeedEnv 는 휠 한 틱이 넘기는 줄 수를 정하는 변수다.
//
// 계약은 Claude Code 의 것이고 바이너리에서 확인했다 (SRS §2.1): `parseFloat` 로
// 읽고, 0 이하나 숫자가 아니면 **조용히 자기 기본값**으로 가며, 상한은 20 이다.
//
// **`CLAUDE_CODE_NO_FLICKER` 와 얽지 않는다** — 그 코드가 스크롤 속도를 정할 때
// fullscreen 여부를 보지 않기 때문이다. 없는 규칙을 발명하면 저쪽이 규칙을 바꿀 때
// 이쪽이 먼저 틀린다.
const claudeScrollSpeedEnv = "CLAUDE_CODE_SCROLL_SPEED"

// scrollSpeedSpec 은 서술자 표의 `claudeScrollSpeed` 다 (FR-CFG-1).
//
// **기본값과 범위를 여기 적지 않는다.** 표가 단일 원천이고 Go 는 embed 된 같은
// 바이트를 읽는다 (FR-CFG-10) — 여기에 `3` 을 적으면 값이 두 벌이 되고, 그 중
// 하나만 고쳐지는 날이 온다.
//
// 표를 읽지 못하면 영(zero) 서술자다. 그때 `scrollSpeed` 는 주입을 건너뛴다 —
// 도구를 못 띄우게 만드는 것보다 변수 하나가 없는 편이 낫다.
var scrollSpeedSpec = sync.OnceValue(func() settingsschema.Spec {
	specs, err := settingsschema.Load()
	if err != nil {
		return settingsschema.Spec{}
	}
	return settingsschema.ByKey(specs)[scrollSpeedKey]
})

// scrollSpeed 는 blob 에서 스크롤 속도를 읽는다 (FR-ARE-9).
//
// **`claudeFullscreen` 과 달리 언제나 값을 낸다.** 읽을 것이 없거나 범위를
// 벗어나면 표의 기본값이다 (사용자 결정 2026-09-20). 브라우저가 이미 자르지만
// (FR-FSS-19 와 같은 손) 손으로 고친 설정 파일이 이 자리에 오므로, 서버는
// 브라우저를 믿지 않는다.
func scrollSpeed(m map[string]any) (int, bool) {
	spec := scrollSpeedSpec()
	if spec.Key == "" {
		return 0, false
	}
	def, ok := spec.Def.(float64)
	if !ok {
		return 0, false
	}
	n := int(def)
	if v, ok := m[scrollSpeedKey].(float64); ok {
		// 정수만 받는다 — 표가 `int` 로 선언하고, 실수는 그 선언 밖이다.
		if i := int(v); float64(i) == v &&
			(spec.Min == nil || i >= *spec.Min) &&
			(spec.Max == nil || i <= *spec.Max) {
			n = i
		}
	}
	return n, true
}

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
	var m map[string]any
	if len(blob) > 0 {
		if json.Unmarshal(blob, &m) != nil {
			m = nil
		} else if v, ok := m[agentRenderEnvKey].(bool); ok {
			on = v
		}
	}
	var env []string
	if on {
		env = append(env, claudeNoFlickerEnv)
	}
	// FR-ARE-8·9: 스크롤 속도는 **항상** 간다. 위의 갈래와 독립이다.
	if n, ok := scrollSpeed(m); ok {
		env = append(env, claudeScrollSpeedEnv+"="+strconv.Itoa(n))
	}
	return env
}
