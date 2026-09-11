package agentadapter

import "encoding/json"

// codexAdapter 는 codex 선언이며 **best-effort 다** (FR-ADP-4 / D-D).
//
// 활동 해상도가 근본적으로 다르다. codex 의 표준 notify 는 `agent-turn-complete`
// **하나뿐**이라 pre-tool 이벤트도, 세션 시작 이벤트도 없다. 그래서:
//
//   - tool/detail 은 언제나 비어 있다
//   - 준비완료를 훅으로 알 수 없다 (Readiness.Hooks=false). 갓 띄운 codex 는
//     활동 상태가 unknown 이고, FR-STA-4 3단계(출력 3초 정적)로 판정된다
//
// 아래 값 중 **확인된 것은 정책 주입뿐이다** — internal/shared/runtime 의 셸 래퍼가
// 실제로 `-c notify=[...]` 로 띄우고 있다. 모델 플래그·종료 지시·프롬프트를
// 위치 인자로 받는지는 이 환경에서 확인하지 못했으므로 비우거나 보수적인 쪽을
// 택했다. 추측한 플래그는 없는 것보다 나쁘다 — 기동 자체를 깨뜨린다.
var codexAdapter = Adapter{
	ID:        "codex",
	DetectCmd: "codex",
	Launch:    []string{"codex"},
	ModelFlag: "", // 미확인 — 지정되면 조용히 생략된다
	// 위치 인자 프롬프트를 확인하지 못했다. argv 로 단정하면 기동이 깨질 수
	// 있으므로, 띄운 뒤 붙여넣는 보수적인 경로를 택한다.
	PromptInjection: PromptStdinAfterStart,
	PolicyInjection: PolicyInjection{
		Flags:         []string{"-c"}, // -c notify=[".../dmctl","notify","codex"]
		SessionScoped: true,
	},
	HookParse: parseCodexHook,
	// FR-AEV-2·3: codex 가 내는 것은 **`done` 하나뿐**이다. 표준 notify 가
	// `agent-turn-complete` 하나이므로 시작도, 도구도, 턴의 출처도 오지 않는다.
	//
	// `UserTurn=false` 가 이 선언에서 가장 중요한 한 줄이다 (FR-AEV-12) — 이것이
	// 없으면 알람 규칙이 "사용자 턴이 아니었다" 로 읽어 codex 를 영원히 침묵시킨다.
	Signals:     Signals{Done: true},
	Readiness:   Readiness{Hooks: false},
	ExitCommand: "", // 미확인
}

// parseCodexHook maps a Codex notify event to an activity report. Codex's
// standard notify emits only agent-turn-complete → done; it has no pre-tool
// event, so tool/detail stay empty (FR-AAP-9 / AAP-2).
//
// dmctl_activity.go 에서 무동작 이동했다 (FR-ADP-2).
func parseCodexHook(data []byte) (Report, bool) {
	var ev struct {
		Type string `json:"type"`
		// FR-AEV-15: **알람에도 내용이 실린다.** codex 가 내는 이벤트는 이 하나뿐이고
		// (Signals{Done:true}), 그 페이로드가 싣는 유일한 내용이 이것이다. 없으면
		// 빈 값이므로 종전 동작 그대로다.
		LastMessage string `json:"last-assistant-message"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return Report{}, false
	}
	if ev.Type == "agent-turn-complete" {
		return Report{State: "done", Detail: ev.LastMessage}, true
	}
	return Report{}, false
}
