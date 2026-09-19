package httpapi

import (
	"slices"
	"strings"
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
			// 끈 경우에는 이 변수를 **아예 넣지 않는다.** 빈 값을 넣어 두면
			// 그것이 다시 해석의 여지를 만든다.
			//
			// 종전에는 `len(got) != 0` 으로 쟀다. FR-ARE-8 이 스크롤 속도를
			// **항상** 넣으므로 그 단정은 더 이상 성립하지 않는다 — 재려던 것은
			// 배열의 길이가 아니라 **이 변수가 빈 값으로 남는가** 였다.
			for _, e := range got {
				if !c.want && strings.HasPrefix(e, "CLAUDE_CODE_NO_FLICKER") {
					t.Fatalf("끈 상태인데 %q 가 있다 (env=%v)", e, got)
				}
			}
		})
	}
}

// V-ARE-6·7·8 — 스크롤 속도 (FR-ARE-8·9).
//
// 계약은 Claude Code 의 것이고 바이너리에서 확인했다 (SRS §2.1): `parseFloat` ·
// 0 초과 · 상한 20 · 무효값은 조용히 기본값. **우리가 재는 것은 그 계약이 아니라
// 설정 하나가 환경 하나로 옮는가** 다 — 앞의 검사와 같은 경계다.
func TestAgentRenderEnvScrollSpeed(t *testing.T) {
	const key = "CLAUDE_CODE_SCROLL_SPEED="

	speedOf := func(t *testing.T, blob string) string {
		t.Helper()
		for _, e := range agentRenderEnv([]byte(blob)) {
			if v, ok := strings.CutPrefix(e, key); ok {
				return v
			}
		}
		t.Fatalf("%s 가 env 에 없다 (blob=%q) — FR-ARE-9 는 **항상** 넣는다", key, blob)
		return ""
	}

	cases := []struct {
		name string
		blob string
		want string
	}{
		// V-ARE-7: 읽을 것이 없으면 기본 3 이다. **없는 채로 두지 않는다** —
		// 그것이 `claudeFullscreen` 과 다른 점이고, 사용자 결정이다 (FR-ARE-9).
		{"blob 이 없다", "", "3"},
		{"빈 객체", `{}`, "3"},
		{"키가 없다", `{"fgTabNames":true}`, "3"},
		{"깨진 JSON", `{nope`, "3"},

		// V-ARE-6: 값이 있으면 그것이 그대로 간다.
		{"1", `{"claudeScrollSpeed":1}`, "1"},
		{"7", `{"claudeScrollSpeed":7}`, "7"},
		{"20", `{"claudeScrollSpeed":20}`, "20"},

		// 범위 밖·타입 밖은 기본값이다. 브라우저가 이미 자르지만(FR-FSS-19 와
		// 같은 손), 손으로 고친 설정 파일이 이 자리에 온다 — 서버는 브라우저를
		// 믿지 않는다.
		{"0", `{"claudeScrollSpeed":0}`, "3"},
		{"음수", `{"claudeScrollSpeed":-5}`, "3"},
		{"상한 초과", `{"claudeScrollSpeed":99}`, "3"},
		{"실수", `{"claudeScrollSpeed":1.5}`, "3"},
		{"문자열", `{"claudeScrollSpeed":"7"}`, "3"},
		{"null", `{"claudeScrollSpeed":null}`, "3"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := speedOf(t, c.blob); got != c.want {
				t.Fatalf("%s%s, 기대 %s (blob=%q)", key, got, c.want, c.blob)
			}
		})
	}

	// V-ARE-8: 두 변수는 **서로 독립**이다. 바이너리가 둘을 얽지 않으므로
	// 우리도 얽지 않는다 (SRS §2.1).
	t.Run("fullscreen 을 꺼도 스크롤 속도는 간다", func(t *testing.T) {
		blob := `{"claudeFullscreen":false,"claudeScrollSpeed":9}`
		got := agentRenderEnv([]byte(blob))
		if slices.Contains(got, flickerEnv) {
			t.Errorf("fullscreen 을 껐는데 %q 가 있다: %v", flickerEnv, got)
		}
		if speed := speedOf(t, blob); speed != "9" {
			t.Errorf("%s%s, 기대 9: %v", key, speed, got)
		}
	})
}
