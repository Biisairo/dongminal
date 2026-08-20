package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"dongminal/internal/mcptool"
)

const WorkspaceCommandName = "workspace_command"

// workspaceCmdActions는 workspace_command 가 노출하는 action 집합이다.
// 서버의 allowedCmdActions 부분집합 — 브로드캐스트 화이트리스트에는 있으나
// MCP 로 부를 수 없는 action 이 있다. detachTab/restoreTool 은 toolId 인자를
// 요구하고 workspace_command 는 그 인자를 갖지 않으므로 여기서 제외한다.
var workspaceCmdActions = []string{
	"newWindow", "newTab", "splitH", "splitV",
	"closeTab", "closeWindow",
	"windowNext", "windowPrev",
	"tabNext", "tabPrev",
	"paneUp", "paneDown", "paneLeft", "paneRight",
	"focus", "openEditorTab",
	"renameTab", "renameWindow",
}

func isWorkspaceCmdAction(a string) bool {
	for _, x := range workspaceCmdActions {
		if x == a {
			return true
		}
	}
	return false
}

var WorkspaceCommandSpec = map[string]any{
	"name": WorkspaceCommandName,
	"description": "dongminal 워크스페이스를 원격 제어한다. 실행 중인 브라우저(들)에 SSE 로 명령을 브로드캐스트하고, 브라우저가 기존 UI 로직(키보드 단축키와 동일 경로)을 그대로 실행한다. delivered=0 이면 구독 중인 브라우저 없음 — 사용자가 브라우저를 새로고침해야 함.\n\n" +
		"【용어】 창(Window)은 사이드바의 독립 작업공간. 분할 칸(Pane)은 창 내부의 나뉜 공간으로 자체 탭 바를 가진다. 탭(Tab)은 분할 칸 안의 공간이며, 그 안에 도구(Tool — 현재는 터미널)가 탑재된다. 라벨 W<창>.P<분할칸>.T<탭> 은 사람 가독성용 positional 표시(list_workspace 의 label 컬럼). location 인자는 **uuid 만 허용** — list_workspace 의 `uuid=` 컬럼 값. 좌표/라벨/toolId 입력은 거부. 서버가 broadcast 직전 uuid→좌표로 변환.\n\n" +
		"【action — 기본은 '현재 포커스한 분할 칸/창' 기준. location 인자로 포커스 외 위치를 직접 대상 지정 가능 (focus → action 2콜 대신 1콜로 해결).】\n" +
		"  • newWindow   — 새 창 생성. 기본은 활성화(전환). name=잡이름 지정 가능, keepFocus=true 면 사용자 포커스 유지(백그라운드 생성 — 잡 컨테이너 패턴).\n" +
		"  • newTab       — 포커스(또는 location) 분할 칸에 새 탭(+터미널) 추가. 기본은 그 탭으로 전환. name 지정 가능, keepFocus=true 면 사용자 포커스·대상 분할 칸 활성 탭 모두 유지. cwd 는 해당 탭의 cwd 상속.\n" +
		"  • splitH       — 분할 칸을 '가로 분할' (좌↔우). 기본 2분할. count=N 지정 시 N 균등 분할. keepFocus=true 면 원래 포커스 유지, 기본은 마지막 새 분할 칸으로 이동.\n" +
		"  • splitV       — 분할 칸을 '세로 분할' (상↕하). count/keepFocus 동일.\n" +
		"  • closeTab     — 분할 칸의 활성 탭을 닫음(도구 종료). 분할 칸의 마지막 탭이면 분할 칸도 제거, 창의 마지막 분할 칸이면 창도 제거. 실행 중 프로세스가 있으면 브라우저에서 확인 다이얼로그 표시.\n" +
		"  • closeWindow — 활성 창 전체를 닫음. 창 안의 모든 도구 종료. 마지막 창이면 자동으로 새 창 생성.\n" +
		"  • windowNext  — 다음 창으로 전환 (순환). 단축키 Ctrl+Shift+] 와 동일.\n" +
		"  • windowPrev  — 이전 창으로 전환 (순환). Ctrl+Shift+[ 와 동일.\n" +
		"  • tabNext      — 현재 분할 칸 안에서 다음 탭 (순환). Ctrl+Tab 과 동일.\n" +
		"  • tabPrev      — 현재 분할 칸 안에서 이전 탭 (순환). Ctrl+Shift+Tab 과 동일.\n" +
		"  • paneUp/Down/Left/Right — 분할 레이아웃에서 인접 분할 칸으로 포커스 이동. 해당 방향에 분할 칸이 없으면 무시됨. Ctrl+Shift+방향키와 동일.\n" +
		"  • openEditorTab — 포커스(또는 location) 분할 칸에 편집기 탭을 추가. name과 filePath 인자 필수.\n" +
		"  • focus        — 임의 위치로 포커스 이동. location **필수**. uuid 만 허용 (list_workspace 의 `uuid=` 컬럼 값).\n" +
		"  • renameTab    — location(필수) 탭의 표시 이름을 name(필수) 으로 변경. 포커스 무영향. 팀 도구에 역할명 부여에 사용.\n" +
		"  • renameWindow — location(필수) 탭이 **속한 창**의 이름을 name(필수) 으로 변경. 포커스 무영향.\n\n" +
		"【인자】\n" +
		"  • location  (모든 action 공용, 선택) — 대상 위치. 지정하면 action 실행 전에 해당 위치로 먼저 포커스 이동 후 실행. focus 액션에서는 필수.\n" +
		"  • count     (splitH/splitV 전용, 선택, 기본 2) — N 개 균등 분할. N >= 2.\n" +
		"  • keepFocus (splitH/splitV 전용, 선택, 기본 false) — true 면 분할 후 포커스를 원래 위치에 유지.\n\n" +
		"【사용 패턴】\n" +
		"  - 새 작업공간 준비: newWindow → splitV(count=N)\n" +
		"  - 특정 위치 한 번에 N 분할: workspace_command(splitH, location=<uuid>, count=4)\n" +
		"  - 정리(포커스 유지하며 원격 탭 닫기): workspace_command(closeTab, location=<uuid>) — uuid 는 라벨 reflow 무관, list_workspace 재확인 불필요\n" +
		"  - 팀 분할 칸 미리 만들고 내 포커스 유지: workspace_command(splitV, count=3, keepFocus=true)",
	"inputSchema": map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{
				"type": "string",
				"enum": workspaceCmdActions,
			},
			"location": map[string]any{
				"type":        "string",
				"description": "대상 탭 uuid. 모든 action 에서 선택 사항 — 지정하면 action 실행 전 해당 탭으로 먼저 포커스 이동. focus 액션에서는 필수. **uuid 만 허용** — list_workspace/who_am_i 출력의 `uuid=` 컬럼 값. 좌표(`4.1.1`/`W4.P1.T1`), 라벨, toolId 입력은 거부(에러). 서버가 broadcast 직전 uuid→좌표로 변환.",
			},
			"count": map[string]any{
				"type":        "integer",
				"minimum":     2,
				"description": "splitH/splitV 전용. 한 번에 N 균등 분할 (기본 2). 예: count=4 이면 원본 + 새 분할 칸 3 개 = 총 4 개 형제.",
			},
			"keepFocus": map[string]any{
				"type":        "boolean",
				"description": "splitH/splitV/closeTab/newWindow/newTab 전용. true 면 실행 후 사용자 포커스를 호출 전 상태 그대로 유지한다 (기본 false). newWindow+keepFocus 는 창을 사이드바에만 추가, newTab+keepFocus 는 대상 분할 칸의 활성 탭도 바꾸지 않는다.",
			},
			"name": map[string]any{
				"type":        "string",
				"description": "newWindow/newTab/openEditorTab 전용. 새 창/탭에 표시할 이름. 생략 시 기본값 (Window/Shell/파일명).",
			},
			"filePath": map[string]any{
				"type":        "string",
				"description": "openEditorTab 전용 (필수). 편집할 파일의 절대경로.",
			},
		},
		"required": []string{"action"},
	},
}

type WorkspaceCommandArgs struct {
	Action    string `json:"action"`
	Location  string `json:"location"`
	Count     int    `json:"count"`
	KeepFocus bool   `json:"keepFocus"`
	Name      string `json:"name"`
	FilePath  string `json:"filePath"`
}

type WorkspaceCommandDeps struct {
	Broadcaster mcptool.CommandBroadcaster
	WS          mcptool.WorkspaceReader
}

func WorkspaceCommandHandler(d WorkspaceCommandDeps) func(context.Context, WorkspaceCommandArgs) (mcptool.Result, error) {
	return func(_ context.Context, a WorkspaceCommandArgs) (mcptool.Result, error) {
		if a.Action == "" {
			return nil, fmt.Errorf("action 누락")
		}
		if !isWorkspaceCmdAction(a.Action) || !d.Broadcaster.AllowedAction(a.Action) {
			return nil, fmt.Errorf("unknown action: %s", a.Action)
		}
		if a.Action == "focus" && a.Location == "" {
			return nil, fmt.Errorf("focus 는 location 인자가 필요 (list_workspace 의 uuid 컬럼 값)")
		}
		if a.Action == "openEditorTab" && a.FilePath == "" {
			return nil, fmt.Errorf("openEditorTab 은 filePath 인자가 필수")
		}
		if a.Action == "renameTab" || a.Action == "renameWindow" {
			if a.Location == "" {
				return nil, fmt.Errorf("%s 은 location 인자가 필요 (list_workspace 의 uuid 컬럼 값)", a.Action)
			}
			if a.Name == "" {
				return nil, fmt.Errorf("%s 은 name 인자가 필수", a.Action)
			}
		}
		if a.Count != 0 && a.Count < 2 {
			return nil, fmt.Errorf("count 는 2 이상이어야 한다 (받은 값: %d)", a.Count)
		}
		if a.Count != 0 && a.Action != "splitH" && a.Action != "splitV" {
			return nil, fmt.Errorf("count 는 splitH/splitV 에서만 의미가 있다 (action=%s)", a.Action)
		}
		if a.KeepFocus && a.Action != "splitH" && a.Action != "splitV" && a.Action != "closeTab" &&
			a.Action != "newWindow" && a.Action != "newTab" {
			return nil, fmt.Errorf("keepFocus 는 splitH/splitV/closeTab/newWindow/newTab 에서만 의미가 있다 (action=%s)", a.Action)
		}
		if a.Name != "" && a.Action != "openEditorTab" && a.Action != "newWindow" && a.Action != "newTab" &&
			a.Action != "renameTab" && a.Action != "renameWindow" {
			return nil, fmt.Errorf("name 은 newWindow/newTab/openEditorTab/renameTab/renameWindow 에서만 의미가 있다 (action=%s)", a.Action)
		}
		loc := a.Location
		if d.WS != nil && loc != "" {
			// FR-DMC-9: location 은 list_workspace 의 uuid 만 허용.
			if !d.WS.IsKnownTabID(loc) {
				return nil, fmt.Errorf("location 은 list_workspace 의 uuid 만 허용 (좌표/라벨/toolId 거부): %q", loc)
			}
			coord, err := d.WS.CoordinateOf(loc)
			if err != nil {
				return nil, err
			}
			loc = coord
		}
		type argsT struct {
			Location  string `json:"location,omitempty"`
			Count     int    `json:"count,omitempty"`
			KeepFocus bool   `json:"keepFocus,omitempty"`
			Name      string `json:"name,omitempty"`
			FilePath  string `json:"filePath,omitempty"`
		}
		av := argsT{Location: loc, Count: a.Count, KeepFocus: a.KeepFocus, Name: a.Name, FilePath: a.FilePath}
		var n int
		var res mcptool.CmdResult
		var timedOut bool
		creating := d.Broadcaster.IsCreatingAction(a.Action)
		if creating {
			// FR-RCR-8: reqId 발급 → await → 새 id 를 결과 텍스트에 부착.
			reqId := d.Broadcaster.NewReqId()
			payload, _ := json.Marshal(struct {
				Action string `json:"action"`
				Args   argsT  `json:"args"`
				ReqId  string `json:"reqId"`
			}{a.Action, av, reqId})
			res, n, timedOut = d.Broadcaster.BroadcastAndAwait(payload, reqId)
		} else {
			payload, _ := json.Marshal(struct {
				Action string `json:"action"`
				Args   argsT  `json:"args"`
			}{a.Action, av})
			n = d.Broadcaster.Broadcast(payload)
		}
		// 결과 메시지의 location 은 변환 후 좌표 (loc) 우선. 입력이 uuid 였으면
		// 원본도 괄호로 부기해 사용자가 추적 가능하게.
		locDisplay := loc
		if a.Location != "" && a.Location != loc {
			locDisplay = fmt.Sprintf("%s (uuid=%s)", loc, a.Location)
		}
		msg := fmt.Sprintf("action=%s delivered=%d", a.Action, n)
		switch {
		case a.Action == "focus":
			msg = fmt.Sprintf("action=focus location=%s delivered=%d", locDisplay, n)
		case a.Action == "openEditorTab":
			msg = fmt.Sprintf("action=openEditorTab filePath=%s delivered=%d", a.FilePath, n)
		case a.Action == "splitH" || a.Action == "splitV":
			extras := ""
			if a.Location != "" {
				extras += " location=" + locDisplay
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
		} else if creating {
			msg += formatNewEntities(res, timedOut)
		}
		return mcptool.TextResult(msg), nil
	}
}

// formatNewEntities 는 생성 명령의 결과(새 엔터티 id)를 사람 가독성 텍스트로
// 부착한다. timedOut 이면 미수신을 표시 (FR-RCR-8).
func formatNewEntities(res mcptool.CmdResult, timedOut bool) string {
	if timedOut {
		return "  (timedOut: 새 id 미수신 — list_workspace 로 확인)"
	}
	var sb strings.Builder
	if len(res.NewWindows) > 0 {
		fmt.Fprintf(&sb, "  newWindows=%v", res.NewWindows)
	}
	if len(res.NewPanes) > 0 {
		fmt.Fprintf(&sb, "  newPanes=%v", res.NewPanes)
	}
	if len(res.NewTabs) > 0 {
		sb.WriteString("  newTabs=[")
		for i, t := range res.NewTabs {
			if i > 0 {
				sb.WriteByte(' ')
			}
			fmt.Fprintf(&sb, "%s(%s)", t.UUID, t.ToolID)
		}
		sb.WriteByte(']')
	}
	return sb.String()
}
