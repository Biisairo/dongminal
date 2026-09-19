package httpapi

import (
	"slices"
	"testing"
)

// AGENT_RENDER_ENV_SRS — 에이전트가 화면을 망가뜨리지 않게 띄운다 (V-ARE-1~3).
//
// 재는 것은 **설정 하나가 환경 하나로 옮는가** 다. 값의 뜻(fullscreen 이 무엇인가)은
// Claude Code 의 것이고 우리가 잴 것이 아니다.

const flickerEnv = "CLAUDE_CODE_NO_FLICKER=1"

func TestAgentRenderEnv(t *testing.T) {
	cases := []struct {
		name string
		blob string
		want bool
	}{
		// V-ARE-3: 읽을 것이 없으면 **기본값 켬**이다. 설정을 한 번도 저장하지
		// 않은 사용자가 가장 많고, 그들이 이 결함을 겪지 않아야 한다.
		{"blob 이 없다", "", true},
		{"빈 객체", `{}`, true},
		{"키가 없다", `{"fgTabNames":true}`, true},
		{"깨진 JSON", `{nope`, true},

		// V-ARE-1·2: 값이 있으면 그것을 따른다.
		{"켬", `{"claudeFullscreen":true}`, true},
		{"끔", `{"claudeFullscreen":false}`, false},

		// 타입이 어긋난 값은 **모르는 것**이므로 기본값으로 간다 — 손으로 고친
		// 설정 파일이 도구를 못 띄우게 만들면 안 된다.
		{"문자열", `{"claudeFullscreen":"no"}`, true},
		{"숫자", `{"claudeFullscreen":0}`, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := agentRenderEnv([]byte(c.blob))
			has := slices.Contains(got, flickerEnv)
			if has != c.want {
				t.Fatalf("env=%v — %q 가 %v 여야 한다", got, flickerEnv, c.want)
			}
			// 끈 경우에는 **아무것도 넣지 않는다.** 빈 값을 넣어 두면 그것이
			// 다시 해석의 여지를 만든다.
			if !c.want && len(got) != 0 {
				t.Fatalf("끈 상태인데 env=%v", got)
			}
		})
	}
}
