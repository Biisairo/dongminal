package run

import "strings"

// 컨텍스트 창 크기 (UX_BATCH6_SRS FR-CTX-5·6).
//
// 접수한 결함은 "1M 컨텍스트를 쓰는데 15% 를 70% 로 센다" 였다. 원인 둘 중 지배적인
// 것이 **한계값을 200k 로 못박은 것**이며(SRS §2.7 실측), 그 못을 여기서 뽑는다.
//
// **모델 문자열이 근거다.** 전사 기록에는 창 크기가 적히지 않지만 모델 이름에
// `[1m]` 접미어가 붙는다 — 이 기기의 기록 전량을 세어 확인했다:
//
//	97045  "model":"claude-opus-5"
//	   35  "model":"claude-opus-5[1m]"
//	 1105  "model":"claude-sonnet-5"
//
// 그 접미어가 없는 채로 1M 세션이 기록되는 경우도 그 수가 말한다. 그래서 모델이
// 답하지 못할 때를 위한 그물이 하나 더 있다 — 관측이 창을 넘으면 창이 더 크다는
// 것은 **확정**이므로(불가능한 관측), 아는 다음 단계로 넓힌다 (FR-CTX-6).

// contextWindows 는 아는 창 크기다. **오름차순이어야 한다** — 넓히기가 이 순서를
// 딛는다. 상수를 코드 여기저기 적지 않으려고 목록 하나에서 파생시킨다.
var contextWindows = []float64{200000, 1000000}

// longContextSuffix 는 Claude Code 가 긴 컨텍스트 판을 기록할 때 모델 이름에
// 붙이는 표식이다.
const longContextSuffix = "[1m]"

// WindowForModel 은 모델 문자열이 말하는 창 크기다 (FR-CTX-5).
//
// 두 번째 값이 거짓이면 **모델이 답하지 못한 것**이며, 그때는 호출자가 설정값을
// 쓰고 관측으로 넓힌다. 모르는 이름을 기본값으로 단정하지 않는 이유가 그것이다 —
// 단정하면 그 뒤의 넓히기가 "설정이 틀렸다" 와 "표에 없다" 를 구분하지 못한다.
func WindowForModel(model string) (float64, bool) {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return 0, false
	}
	if strings.HasSuffix(m, longContextSuffix) {
		return contextWindows[len(contextWindows)-1], true
	}
	return 0, false
}

// WidenWindow 는 관측이 넘어선 창을 아는 다음 단계로 넓힌다 (FR-CTX-6).
//
// 넘어서지 않았으면 그대로 돌려준다. 목록의 마지막보다도 크면 **관측값 자신**이
// 창이 된다 — 표에 없는 판을 만나도 100% 를 넘는 수를 보이지 않는다.
func WidenWindow(limit, tokens float64) float64 {
	if tokens <= limit {
		return limit
	}
	for _, w := range contextWindows {
		if w >= tokens {
			return w
		}
	}
	return tokens
}
