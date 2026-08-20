package tools

// 공통 id 스키마 (pane 식별자: 라벨, 숫자 toolId, 또는 tab UUID).
var idSchema = map[string]any{
	"type":        "string",
	"description": "탭 식별자: 'W1.P2.T3' 라벨(창.분할칸.탭, 1-base, 현재 레이아웃 기준 positional), 숫자 toolId, 또는 tab UUID (36자 hex-dash, list_workspace/who_am_i 의 uuid 필드). UUID 는 레이아웃 변경에 무관하게 같은 탭을 가리킨다. list_workspace 로 먼저 목록 확인 권장.",
}
