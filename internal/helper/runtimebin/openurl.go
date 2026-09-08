package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"

	"dongminal/internal/shared/platform"
)

// VIEWER_URL_OPEN_SRS — 쉘이 띄우려는 URL 을 보고 있는 기기에서 연다.
//
// 이 명령은 서버에게 **어디서 열지만** 묻는다. 서버가 "local" 이라 답하면 이
// 셸이 직접 연다 (FR-VUO-2) — 서버가 대신 열지 않는 이유는 그쪽이 데몬일 수
// 있어서다. 데몬에는 GUI 세션이 없고 그러면 `open` 이 조용히 실패한다. 부른
// 셸은 이미 그 세션 안에 있다.

const openURLHelp = `open-url — URL 을 보고 있는 기기의 브라우저로 연다

사용법:
  open-url <url>          http/https URL 하나
  dmctl open-url <url>    같은 동작

워크스페이스를 원격 기기에서 보고 있으면 그 기기에 확인 팝업이 뜨고, 확인하면
그쪽 브라우저에서 열린다. 서버와 같은 컴퓨터에서 보고 있으면 바로 열린다.
DONGMINAL_URL_OPEN=local|viewer 로 그 판정을 강제할 수 있다.
`

func runOpenURL(args []string, stdout, stderr io.Writer) int {
	return openURLWith(args, stdout, stderr, systemOpenURL)
}

// openURLWith 는 로컬 실행을 주입받는다 — 검증이 브라우저를 띄우지 않기 위한
// 자리다.
func openURLWith(args []string, stdout, stderr io.Writer, openLocal func(string) error) int {
	if len(args) == 1 {
		switch args[0] {
		case "-h", "--help":
			fmt.Fprint(stdout, openURLHelp)
			return 0
		}
	}
	if len(args) != 1 || args[0] == "" {
		fmt.Fprint(stderr, openURLHelp)
		return 2
	}
	target := args[0]

	status, body, err := httpPostJSON(baseURL()+"/api/commands", map[string]any{
		"action": "openUrl",
		"args":   map[string]any{"url": target},
	})
	switch {
	case err != nil:
		// FR-VUO-4: 서버에 닿지 못해도 열기 요청은 소실되지 않는다.
		return openHere(target, stderr, openLocal)
	case status == 400:
		// 서버가 거절한 URL 은 열어서는 안 되는 것이다 (FR-VUO-18).
		fmt.Fprintf(stderr, "open-url: %s\n", strings.TrimSpace(string(body)))
		return 1
	case status != 200:
		return openHere(target, stderr, openLocal)
	}

	var resp struct {
		Where string `json:"where"`
	}
	if json.Unmarshal(body, &resp) != nil || resp.Where == "" {
		return openHere(target, stderr, openLocal)
	}
	if resp.Where == "local" {
		return openHere(target, stderr, openLocal)
	}
	// 뷰어가 연다. 여기서는 아무 것도 하지 않는다 — 열면 두 곳에서 열린다.
	return 0
}

func openHere(target string, stderr io.Writer, openLocal func(string) error) int {
	if err := openLocal(target); err != nil {
		fmt.Fprintf(stderr, "open-url: %v\n", err)
		return 1
	}
	return 0
}

// systemOpenURL 은 이 컴퓨터의 기본 브라우저를 평범한 창으로 연다.
func systemOpenURL(target string) error {
	name, args, err := platform.Current().Opener.OpenCommand(target)
	if err != nil {
		return err
	}
	return exec.Command(name, args...).Start()
}
