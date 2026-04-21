package tools

// 공통 id 스키마 (pane 식별자: 라벨 또는 숫자 paneId).
var idSchema = map[string]any{
	"type":        "string",
	"description": "pane 식별자: 'S1.P2.T3' 라벨(세션.영역.탭, 1-base) 또는 숫자 paneId. list_panes 로 먼저 목록 확인 권장.",
}
