package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"

	"dongminal/internal/helper/toolline"
	"dongminal/internal/shared/apipath"
)

// dmctlListWorkspace implements `dmctl list-workspace`. /api/state 호출 후 workspace
// 트리를 순회해 toolline.Line 으로 렌더링한다 — MCP `list_workspace` 와 byte-level
// 동일 포맷 (DMCTL_WHO_AM_I_SRS FR-DMC-LP-1).
// listWorkspaceFlags 는 list-workspace 의 인자다.
type listWorkspaceFlags struct {
	jsonOut      bool
	windowFilter string
	tabFilter    string
}

// parseListWorkspaceFlags 는 인자를 읽는다. proceed 가 거짓이면 이미 답했다
// (헬프 또는 오류) — 그 종료 코드가 code 다.
func parseListWorkspaceFlags(args []string, stdout, stderr io.Writer) (f listWorkspaceFlags, code int, proceed bool) {
	spec := argSpec{
		help:  dmctlListWorkspaceHelp,
		vals:  map[string]func(string) error{"--window": setStr(&f.windowFilter), "--tab": setStr(&f.tabFilter)},
		bools: map[string]*bool{"--json": &f.jsonOut},
	}
	code, proceed = spec.run("list-workspace", args, stdout, stderr)
	return f, code, proceed
}

// fetchState 는 `/api/state` 한 번을 v 로 읽는다 — 이 읽기의 유일한 자리다 (FR-RDG-22).
// 실패는 stderr 에 한 벌의 문구로 내고 1 이다. 조용해야 하는 자리는 io.Discard 를 준다.
func fetchState(v any, stderr io.Writer) int {
	status, body, err := httpGet(baseURL() + apipath.State)
	body, code, ok := httpExit(status, body, err, stderr, exitRule{prefix: "dmctl", refuse: refuseWith(func(w io.Writer, st int, b []byte) {
		fmt.Fprintf(w, "dmctl: %s returned status %d: %s\n", apipath.State, st, b)
	})})
	if !ok {
		return code
	}
	if err := json.Unmarshal(body, v); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid %s response: %v\n", apipath.State, err)
		return 1
	}
	return 0
}

// fetchWorkspaceTree 는 /api/state 의 워크스페이스 트리만 읽는다 (list-groups).
func fetchWorkspaceTree(stderr io.Writer) (*wsTree, int) {
	var state struct {
		Workspace *wsTree `json:"workspace"`
	}
	if code := fetchState(&state, stderr); code != 0 {
		return nil, code
	}
	return state.Workspace, 0
}

// fetchListWorkspaceRows 는 `/api/state` 를 읽어 행으로 만든다.
func fetchListWorkspaceRows(stderr io.Writer) ([]listWorkspaceRow, int) {
	var state struct {
		Tools     []toolEntry `json:"tools"`
		Workspace *wsTree     `json:"workspace"`
		// FgTabNames 는 서버가 설정에서 읽어 실어 준 FR-TAN-19 의 값이다
		// (OPTIMIZE_REFACTOR_SRS FR-OPT-8-5 · SHR-31). 없으면 옛 서버다 — 종전대로
		// `/api/settings` 를 묻는다.
		FgTabNames *bool `json:"fgTabNames"`
	}
	if code := fetchState(&state, stderr); code != 0 {
		return nil, code
	}

	shellPids := make(map[string]int, len(state.Tools))
	sizes := make(map[string][2]int, len(state.Tools))
	fg := make(map[string]string, len(state.Tools))
	for _, p := range state.Tools {
		shellPids[p.ID] = p.PID
		sizes[p.ID] = [2]int{p.SizeCols, p.SizeRows}
		if p.FgName != "" {
			fg[p.ID] = p.FgName
		}
	}

	// FR-TAN-18: `tab="..."` 는 **화면에 보이는 이름**이다. 설정을 함께 읽는
	// 이유가 그것이다 — 사용자가 파생을 껐으면 에이전트도 껐을 때의 이름을
	// 봐야 한다.
	enabled := onceBool(fgTabNamesEnabled)
	if v := state.FgTabNames; v != nil {
		enabled = func() bool { return *v }
	}
	return buildListWorkspaceRows(state.Workspace, shellPids, sizes, fg, enabled), 0
}

func dmctlListWorkspace(args []string, stdout, stderr io.Writer) int {
	f, code, proceed := parseListWorkspaceFlags(args, stdout, stderr)
	if !proceed {
		return code
	}
	rows, code := fetchListWorkspaceRows(stderr)
	if code != 0 {
		return code
	}

	// LIST_PANES_NAME_FILTER_SRS FR-LPF-1/2: 이름 필터 (부분 일치, 대소문자 무시, AND).
	filtered := f.windowFilter != "" || f.tabFilter != ""
	if filtered {
		var keep []listWorkspaceRow
		for _, r := range rows {
			if MatchFold(r.Window, f.windowFilter) && MatchFold(r.Tab, f.tabFilter) {
				keep = append(keep, r)
			}
		}
		rows = keep
		if len(rows) == 0 {
			if f.jsonOut {
				stdout.Write([]byte("[]\n"))
			} else {
				fmt.Fprintln(stderr, "(no match)")
			}
			return 1
		}
	}

	if f.jsonOut {
		if len(rows) == 0 {
			stdout.Write([]byte("[]\n"))
			return 0
		}
		_ = json.NewEncoder(stdout).Encode(rows)
		return 0
	}

	if len(rows) == 0 {
		fmt.Fprintln(stdout, "(no tools)")
		return 0
	}
	for _, r := range rows {
		fmt.Fprintln(stdout, listWorkspaceLine(r).Render())
	}
	return 0
}

// listWorkspaceLine 은 행 하나를 사람용 한 줄로 옮긴다 (toolline 의 형식).
func listWorkspaceLine(r listWorkspaceRow) toolline.Line {
	return toolline.Line{
		FocusMarker: r.Focused,
		Label:       r.Label,
		UUID:        r.UUID,
		Short:       r.Short,
		ToolID:      r.ToolID,
		ShellPID:    r.ShellPID,
		SizeCols:    r.SizeCols,
		SizeRows:    r.SizeRows,
		Window:      r.Window,
		Tab:         r.Tab,
		WindowUUID:  r.WindowUUID,
		PaneUUID:    r.PaneUUID,
		Group:       r.Group,
		WinIndex:    r.WindowIndex,
		WinCount:    r.WindowCount,
		TabIndex:    r.TabIndex,
		TabCount:    r.TabCount,
	}
}

const dmctlListWorkspaceHelp = `dmctl list-workspace — 열린 도구 목록 조회

사용법:
  dmctl list-workspace                     # 사람 가독성 텍스트 (▶ = 사용자 포커스)
  dmctl list-workspace --json              # JSON 배열 (스크립트 친화)
  dmctl list-workspace --window <substr>   # 창 이름 필터 (부분 일치·대소문자 무시)
  dmctl list-workspace --tab <substr>      # 탭 이름 필터. --window 과 AND
                                           # 매칭 0건이면 rc=1 (grep 컨벤션)

각 행: ▶|  label=...  uuid=...  short=...  toolId=...  shellPid=...  size=WxH  window="..."  tab="..."  window_uuid=...  pane_uuid=...
빈 값(uuid/short/size/window_uuid/pane_uuid)은 해당 컬럼이 생략된다.
`
