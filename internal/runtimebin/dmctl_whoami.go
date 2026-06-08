package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"dongminal/internal/paneline"
)

// dmctlWhoAmI implements `dmctl who-am-i` (DMCTL_WHO_AM_I_SRS FR-DMC-WAI-1~3).
// `/api/whoami` JSON → paneline.Line 단일 행 또는 --json 시 그대로 stdout.
func dmctlWhoAmI(args []string, stdout, stderr io.Writer) int {
	jsonOut := false
	for _, a := range args {
		switch a {
		case "-h", "--help":
			fmt.Fprint(stdout, dmctlWhoAmIHelp)
			return 0
		case "--json":
			jsonOut = true
		default:
			fmt.Fprintf(stderr, "who-am-i: unknown argument: %s\n", a)
			return 2
		}
	}

	status, body, err := httpGet(baseURL() + "/api/whoami")
	if err != nil {
		fmt.Fprintf(stderr, "dmctl: %v\n", err)
		return 1
	}
	if status < 200 || status >= 300 {
		// 서버 오류 JSON 의 error 필드만 깨끗하게 출력. 실패 시 raw body.
		var e struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(body, &e); err == nil && e.Error != "" {
			fmt.Fprintf(stderr, "dmctl: %s\n", e.Error)
		} else {
			fmt.Fprintf(stderr, "dmctl: /api/whoami returned status %d: %s\n", status, body)
		}
		return 1
	}

	if jsonOut {
		// compact 한 줄: 끝의 trailing newline 만 제거.
		out := body
		for len(out) > 0 && (out[len(out)-1] == '\n' || out[len(out)-1] == '\r') {
			out = out[:len(out)-1]
		}
		stdout.Write(out)
		fmt.Fprintln(stdout)
		return 0
	}

	var rec whoAmIResp
	if err := json.Unmarshal(body, &rec); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid /api/whoami response: %v\n", err)
		return 1
	}
	line := paneline.Line{
		FocusMarker: rec.Focused,
		Label:       rec.Label,
		UUID:        rec.UUID,
		Short:       rec.Short,
		PaneID:      rec.PaneID,
		ShellPID:    rec.ShellPID,
		SizeCols:    rec.SizeCols,
		SizeRows:    rec.SizeRows,
		Session:     rec.Session,
		Tab:         rec.Tab,
		SessionUUID: rec.SessionUUID,
		RegionUUID:  rec.RegionUUID,
	}
	out := line.Render()
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	stdout.Write([]byte(out))
	return 0
}

const dmctlWhoAmIHelp = `dmctl who-am-i — 현재 쉘이 속한 pane 의 식별 정보

사용법:
  dmctl who-am-i          # 표준 KEY=VALUE 한 줄 (label/uuid/short/...)
  dmctl who-am-i --json   # /api/whoami 의 JSON 그대로 (compact 한 줄)

같은 워크스페이스 내 다른 Claude/dmctl 호출에 자신을 식별할 때 uuid 컬럼을 사용한다.
`

type whoAmIResp struct {
	PaneID      string `json:"paneId"`
	ShellPID    int    `json:"shellPid"`
	Label       string `json:"label"`
	UUID        string `json:"uuid"`
	Short       string `json:"short"`
	SizeCols    int    `json:"sizeCols"`
	SizeRows    int    `json:"sizeRows"`
	Session     string `json:"session"`
	Tab         string `json:"tab"`
	SessionUUID string `json:"sessionUuid"`
	RegionUUID  string `json:"regionUuid"`
	Focused     bool   `json:"focused"`
}
