package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"dongminal/internal/mcptool"
)

type WorkspaceCommand struct {
	Broadcaster mcptool.CommandBroadcaster
}

func (WorkspaceCommand) Name() string { return "workspace_command" }

func (WorkspaceCommand) Spec() map[string]any {
	return map[string]any{
		"name": "workspace_command",
		"description": "dongminal 워크스페이스를 원격 제어한다. 실행 중인 브라우저(들)에 SSE 로 명령을 브로드캐스트하고, 브라우저가 기존 UI 로직(키보드 단축키와 동일 경로)을 그대로 실행한다. delivered=0 이면 구독 중인 브라우저 없음 — 사용자가 브라우저를 새로고침해야 함.\n\n" +
			"【용어】 세션(Session)은 사이드바의 독립 작업공간. 영역(Region/Pane)은 세션 내부의 분할된 구획으로 자체 탭 바를 가진다. 탭(Tab)은 영역 안의 PTY 하나. 라벨은 S<세션>.P<영역>.T<탭> (1-base, 현재 레이아웃 기준 positional) — list_panes 로 확인 가능.\n\n" +
			"【action — 기본은 '현재 포커스한 영역/세션' 기준. location 인자로 포커스 외 위치를 직접 대상 지정 가능 (focus → action 2콜 대신 1콜로 해결).】\n" +
			"  • newSession   — 새 세션을 만들고 활성화. 새 영역/탭/PTY 자동 생성.\n" +
			"  • newTab       — 포커스(또는 location) 영역에 새 탭(+PTY) 추가하고 그 탭으로 전환. cwd 는 해당 탭의 cwd 상속.\n" +
			"  • splitH       — 영역을 '가로 분할' (좌↔우). 기본 2분할. count=N 지정 시 N 균등 분할. keepFocus=true 면 원래 포커스 유지, 기본은 마지막 새 영역으로 이동.\n" +
			"  • splitV       — 영역을 '세로 분할' (상↕하). count/keepFocus 동일.\n" +
			"  • closeTab     — 영역의 활성 탭을 닫음(PTY 종료). 영역의 마지막 탭이면 영역도 제거, 세션의 마지막 영역이면 세션도 제거. 실행 중 프로세스가 있으면 브라우저에서 확인 다이얼로그 표시.\n" +
			"  • closeSession — 활성 세션 전체를 닫음. 세션 내 모든 PTY 종료. 마지막 세션이면 자동으로 새 세션 생성.\n" +
			"  • sessionNext  — 다음 세션으로 전환 (순환). 단축키 Ctrl+Shift+] 와 동일.\n" +
			"  • sessionPrev  — 이전 세션으로 전환 (순환). Ctrl+Shift+[ 와 동일.\n" +
			"  • tabNext      — 현재 영역 안에서 다음 탭 (순환). Ctrl+Tab 과 동일.\n" +
			"  • tabPrev      — 현재 영역 안에서 이전 탭 (순환). Ctrl+Shift+Tab 과 동일.\n" +
			"  • paneUp/Down/Left/Right — 분할 레이아웃에서 인접 영역으로 포커스 이동. 해당 방향에 영역이 없으면 무시됨. Ctrl+Shift+방향키와 동일.\n" +
			"  • focus        — 임의 좌표로 포커스 이동. location **필수**. 형식 \"4.1.1\" 또는 \"S4.P1.T1\" (session.region.tab, 1-base, 대소문자 무시). 뒤에서부터 생략 가능.\n\n" +
			"【인자】\n" +
			"  • location  (모든 action 공용, 선택) — 대상 위치. 지정하면 action 실행 전에 해당 위치로 먼저 포커스 이동 후 실행. focus 액션에서는 필수.\n" +
			"  • count     (splitH/splitV 전용, 선택, 기본 2) — N 개 균등 분할. N >= 2.\n" +
			"  • keepFocus (splitH/splitV 전용, 선택, 기본 false) — true 면 분할 후 포커스를 원래 위치에 유지.\n\n" +
			"【사용 패턴】\n" +
			"  - 새 작업공간 준비: newSession → splitV(count=N)\n" +
			"  - 특정 위치 한 번에 N 분할: workspace_command(splitH, location=\"2.1\", count=4)\n" +
			"  - 정리(포커스 유지하며 원격 탭 닫기): workspace_command(closeTab, location=\"S3.P2.T1\") — 매 호출 전 list_panes 로 라벨 재확인\n" +
			"  - 팀 영역 미리 만들고 내 포커스 유지: workspace_command(splitV, count=3, keepFocus=true)",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{
					"type": "string",
					"enum": []string{
						"newSession", "newTab", "splitH", "splitV",
						"closeTab", "closeSession",
						"sessionNext", "sessionPrev",
						"tabNext", "tabPrev",
						"paneUp", "paneDown", "paneLeft", "paneRight",
						"focus",
					},
				},
				"location": map[string]any{
					"type":        "string",
					"description": "대상 위치. 모든 action 에서 선택 사항 — 지정하면 action 실행 전에 해당 위치로 먼저 포커스 이동. focus 액션에서는 필수. 예: \"4.1.1\", \"S4.P1.T1\", \"2\", \"2.1\"",
				},
				"count": map[string]any{
					"type":        "integer",
					"minimum":     2,
					"description": "splitH/splitV 전용. 한 번에 N 균등 분할 (기본 2). 예: count=4 이면 원본 + 새 영역 3 개 = 총 4 개 형제.",
				},
				"keepFocus": map[string]any{
					"type":        "boolean",
					"description": "splitH/splitV 전용. true 면 분할 후 포커스를 이동하지 않는다 (기본 false — 마지막 새 영역으로 이동).",
				},
			},
			"required": []string{"action"},
		},
	}
}

func (t WorkspaceCommand) Call(_ context.Context, raw json.RawMessage) (mcptool.Result, error) {
	var a struct {
		Action    string `json:"action"`
		Location  string `json:"location"`
		Count     int    `json:"count"`
		KeepFocus bool   `json:"keepFocus"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	if a.Action == "" {
		return nil, fmt.Errorf("action 누락")
	}
	if !t.Broadcaster.AllowedAction(a.Action) {
		return nil, fmt.Errorf("unknown action: %s", a.Action)
	}
	if a.Action == "focus" && a.Location == "" {
		return nil, fmt.Errorf("focus 는 location 인자가 필요 (예: \"4.1.1\")")
	}
	if a.Count != 0 && a.Count < 2 {
		return nil, fmt.Errorf("count 는 2 이상이어야 한다 (받은 값: %d)", a.Count)
	}
	if a.Count != 0 && a.Action != "splitH" && a.Action != "splitV" {
		return nil, fmt.Errorf("count 는 splitH/splitV 에서만 의미가 있다 (action=%s)", a.Action)
	}
	if a.KeepFocus && a.Action != "splitH" && a.Action != "splitV" && a.Action != "closeTab" {
		return nil, fmt.Errorf("keepFocus 는 splitH/splitV/closeTab 에서만 의미가 있다 (action=%s)", a.Action)
	}
	type argsT struct {
		Location  string `json:"location,omitempty"`
		Count     int    `json:"count,omitempty"`
		KeepFocus bool   `json:"keepFocus,omitempty"`
	}
	payload, _ := json.Marshal(struct {
		Action string `json:"action"`
		Args   argsT  `json:"args"`
	}{a.Action, argsT{Location: a.Location, Count: a.Count, KeepFocus: a.KeepFocus}})
	n := t.Broadcaster.Broadcast(payload)
	msg := fmt.Sprintf("action=%s delivered=%d", a.Action, n)
	switch {
	case a.Action == "focus":
		msg = fmt.Sprintf("action=focus location=%s delivered=%d", a.Location, n)
	case a.Action == "splitH" || a.Action == "splitV":
		extras := ""
		if a.Location != "" {
			extras += " location=" + a.Location
		}
		if a.Count != 0 {
			extras += fmt.Sprintf(" count=%d", a.Count)
		}
		if a.KeepFocus {
			extras += " keepFocus=true"
		}
		msg = fmt.Sprintf("action=%s%s delivered=%d", a.Action, extras, n)
	}
	if n == 0 {
		msg += "  ⚠ 구독 중인 브라우저 없음 (새로고침 필요할 수 있음)"
	}
	return mcptool.TextResult(msg), nil
}
