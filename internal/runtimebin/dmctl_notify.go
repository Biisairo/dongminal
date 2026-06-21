package runtimebin

import (
	"fmt"
	"io"
	"os"
	"strings"
)

const dmctlNotifyHelp = `dmctl notify [label]
  현재 pane 이 주의가 필요함을 알린다(작업 완료/입력 대기 등).
  DONGMINAL_PANE_ID 로 자신을 식별해 서버에 알림을 POST 하므로, 제어 터미널이
  없는 detached 환경(에이전트 hook 등)에서도 동작한다. 에이전트 hook 에서 호출.
  예: claude Stop hook -> "dmctl notify done", Notification hook -> "dmctl notify waiting"
`

// runDmctlNotify flags the calling pane as needing attention by POSTing to the
// dongminal server, identifying the pane via DONGMINAL_PANE_ID. This works from
// detached agent hooks that have no controlling terminal (writing to /dev/tty
// would fail there with ENXIO).
func runDmctlNotify(args []string, stdout, stderr io.Writer) int {
	label := "attention"
	for _, a := range args {
		if a == "-h" || a == "--help" {
			fmt.Fprint(stdout, dmctlNotifyHelp)
			return 0
		}
		if a != "" && a[0] != '-' {
			label = a
			break
		}
	}
	paneID := os.Getenv("DONGMINAL_PANE_ID")
	if paneID == "" {
		fmt.Fprintln(stderr, "dmctl notify: DONGMINAL_PANE_ID 미설정 (dongminal pane 안에서 실행해야 함)")
		return 1
	}
	url := baseURL() + "/api/panes/attention/set"
	body := map[string]any{"paneId": paneID, "reason": sanitizeNotifyLabel(label)}
	status, resp, err := httpPostJSON(url, body)
	if err != nil {
		fmt.Fprintf(stderr, "dmctl notify: %v\n", err)
		return 1
	}
	if status >= 400 {
		stderr.Write(resp)
		if len(resp) == 0 || resp[len(resp)-1] != '\n' {
			fmt.Fprintln(stderr)
		}
		return 1
	}
	return 0
}

// sanitizeNotifyLabel strips control chars and bounds the length of the reason.
func sanitizeNotifyLabel(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > 64 {
		s = s[:64]
	}
	if s == "" {
		return "attention"
	}
	return s
}
